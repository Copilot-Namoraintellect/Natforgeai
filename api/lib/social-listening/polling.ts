/**
 * Listening polling orchestration (WBS-R5-A A5).
 *
 * Provider-neutral scheduled polling pass over connected bindings whose
 * platform supports polling:
 *
 *   for each polling-capable connected binding:
 *     → durable checkpoint from social_listening_states (restart-safe)
 *     → one bounded page fetch through the adapter's injected fetch seam
 *     → ingest each event (exact-once canonical acceptance)
 *     → advance the durable checkpoint (never re-scan full history)
 *     → classify + record failures (rate-limit → AUTO_RECOVER keeps the
 *        binding active; revoked/missing setup → OPERATOR_ACTION blocks)
 *
 * No live provider is ever called by default: adapters without a configured
 * fetch seam fail closed (OPERATOR_ACTION). The scheduler is env-gated and
 * default OFF; operators enable it only after configuring provider seams.
 */

import { eq, and, inArray } from "drizzle-orm";
import { socialIntegrations, type SocialIntegration } from "@db/schema";
import { getDb } from "../../queries/connection";
import { getListeningAdapter } from "./adapters";
import type {
  PollingFetchResult,
  SocialListeningAdapter,
} from "./adapters/types";
import { ingestRawSignalEvent, type IngestDeps } from "./ingest";
import {
  ensureListeningState,
  advanceCheckpoint,
  recordListeningFailure,
  type ListeningStateExecutor,
} from "./listening-state-store";
import { classifyListeningFailure } from "./failure-classes";

export type PollingFetcherOverride = (
  input: {
    platform: string;
    providerAccountId: string;
    accessToken: string;
    cursor: string | null;
    limit: number;
  }
) => Promise<PollingFetchResult>;

export interface PollingPassDeps extends IngestDeps {
  state?: ListeningStateExecutor;
  /** Test/operator seam: per-provider page fetch. Absent → adapter default
   *  (fail closed LISTENING_NOT_CONFIGURED). */
  fetcherOverrides?: Record<string, PollingFetcherOverride>;
  limit?: number;
}

export interface PollingPassSummary {
  bindingsScanned: number;
  bindingsPolled: number;
  eventsFetched: number;
  accepted: number;
  duplicates: number;
  rejected: number;
  failures: Array<{ integrationId: number; class: string; code: string }>;
}

type PollingDb = ReturnType<typeof getDb>;

interface PollingExecutor {
  select: PollingDb["select"];
}

async function listPollingCandidates(
  db: PollingExecutor
): Promise<SocialIntegration[]> {
  const rows = await db
    .select()
    .from(socialIntegrations)
    .where(
      and(
        eq(socialIntegrations.status, "connected"),
        inArray(socialIntegrations.platform, ["facebook", "instagram", "linkedin"])
      )
    )
    .limit(100);
  return rows as SocialIntegration[];
}

function providerForPlatform(platform: string): string {
  if (platform === "facebook" || platform === "instagram") return "meta";
  if (platform === "linkedin") return "linkedin";
  return platform;
}

async function pollOneBinding(
  binding: SocialIntegration,
  deps: PollingPassDeps,
  adapter: SocialListeningAdapter,
  summary: PollingPassSummary
): Promise<void> {
  const provider = providerForPlatform(binding.platform);
  const state = await ensureListeningState(
    {
      integrationId: binding.id,
      userId: binding.userId,
      businessId: binding.businessId ?? null,
      provider,
      platform: binding.platform,
      providerAccountId: binding.pageId ?? binding.instagramBusinessAccountId ?? "",
      mechanism: "polling",
    },
    deps.state
  );

  const override = deps.fetcherOverrides?.[provider];
  try {
    const accountId = state.state.providerAccountId;
    if (!binding.accessTokenEncrypted || (!override && !accountId)) {
      // A missing token can never fetch. A missing stored account id only
      // blocks the raw adapter path — an injected override may resolve the
      // account itself (e.g. LinkedIn org discovery).
      throw new Error(
        "LISTENING_NOT_CONFIGURED: binding has no provider account id or token"
      );
    }
    const page = override
      ? await override({
          platform: binding.platform,
          providerAccountId: accountId,
          accessToken: binding.accessTokenEncrypted,
          cursor: state.state.cursor ?? null,
          limit: deps.limit ?? 25,
        })
      : await adapter.fetchEvents({
          platform: binding.platform as never,
          providerAccountId: accountId,
          accessToken: binding.accessTokenEncrypted,
          cursor: state.state.cursor ?? null,
          limit: deps.limit ?? 25,
        });

    summary.eventsFetched += page.events.length;
    for (const event of page.events) {
      const outcome = await ingestRawSignalEvent(binding.platform, event, deps);
      const kind = outcome.disposition.kind;
      if (kind === "accepted") summary.accepted += 1;
      else if (kind === "duplicate") summary.duplicates += 1;
      else summary.rejected += 1;
    }

    if (page.nextCursor !== null && page.nextCursor !== undefined) {
      await advanceCheckpoint(binding.id, String(page.nextCursor), deps.state);
    } else if (page.events.length > 0) {
      await advanceCheckpoint(
        binding.id,
        `until:${page.events[page.events.length - 1].occurredAt.toISOString()}`,
        deps.state
      );
    }
    summary.bindingsPolled += 1;
  } catch (err) {
    const failure = classifyListeningFailure(err);
    await recordListeningFailure(binding.id, failure, deps.state).catch(() => {});
    summary.failures.push({
      integrationId: binding.id,
      class: failure.class,
      code: failure.code,
    });
  }
}

export async function runListeningPollingPass(
  deps: PollingPassDeps = {}
): Promise<PollingPassSummary> {
  const db = (deps.state as PollingExecutor | undefined) ?? getDb();
  const summary: PollingPassSummary = {
    bindingsScanned: 0,
    bindingsPolled: 0,
    eventsFetched: 0,
    accepted: 0,
    duplicates: 0,
    rejected: 0,
    failures: [],
  };

  const candidates = await listPollingCandidates(db);
  summary.bindingsScanned = candidates.length;

  for (const binding of candidates) {
    const provider = providerForPlatform(binding.platform);
    let adapter: SocialListeningAdapter;
    try {
      adapter = getListeningAdapter(provider);
    } catch {
      // Unknown provider for a connected binding — fail closed for this binding.
      continue;
    }
    const capability = adapter.capabilityFor(binding.platform);
    if (!capability || capability.polling !== "supported") continue;
    await pollOneBinding(binding, deps, adapter, summary);
  }

  return summary;
}
