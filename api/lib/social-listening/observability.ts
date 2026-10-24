/**
 * Listening observability (WBS-R5-A A6).
 *
 * Durable operational visibility over the listening layer, without creating
 * another state machine: per-binding status is DERIVED from
 * social_listening_states + social_integrations + social_signals counts.
 *
 * Surfaced: provider/account, capability (webhook/polling supported?),
 * mechanism + status, checkpoint/cursor, last success, failure class/code/
 * reason, recent signal + duplicate/replay counters, configuration blocker,
 * unsupported status, and a stale-listening warning.
 *
 * Never surfaced: provider tokens/secrets, raw payloads, or other tenants'
 * rows. All queries are server-side user-scoped unless explicitly admin.
 */

import { eq, and, inArray, sql, desc } from "drizzle-orm";
import {
  socialIntegrations,
  socialListeningStates,
  socialSignals,
  type SocialIntegration,
  type SocialListeningState,
} from "@db/schema";
import { getDb } from "../../queries/connection";
import { resolveListeningMechanism } from "./adapters";
import type { ListeningFailureClass } from "./failure-classes";

type OverviewDb = ReturnType<typeof getDb>;

export interface ObservabilityExecutor {
  select: OverviewDb["select"];
}

export const LISTENING_STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

export interface ListeningBindingStatus {
  integrationId: number;
  provider: string;
  platform: string;
  providerAccountId: string | null;
  accountName: string | null;
  capability: { webhook: string; polling: string };
  mechanism: string;
  status: string;
  cursor: string | null;
  cursorUpdatedAt: Date | null;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  lastFailureClass: ListeningFailureClass | null;
  lastFailureCode: string | null;
  lastFailureReason: string | null;
  acceptedCount: number;
  duplicateCount: number;
  rejectedCount: number;
  recentSignalCount: number;
  stale: boolean;
  configurationBlocker: string | null;
  unsupported: boolean;
}

function deriveStatus(
  integration: SocialIntegration,
  state: SocialListeningState | null,
  recentSignalCount: number,
  nowMs: number
): ListeningBindingStatus {
  const mechanism = resolveListeningMechanism(
    state?.provider ?? providerGuess(integration.platform),
    integration.platform
  );
  const capability =
    mechanism.kind === "supported"
      ? { webhook: mechanism.capability.webhook, polling: mechanism.capability.polling }
      : { webhook: "unsupported", polling: "unsupported" };

  const mechanismName = state?.mechanism ?? "unsupported";
  const status = state?.status ?? "unsupported";
  const unsupported = capability.webhook === "unsupported" && capability.polling === "unsupported";

  const lastSuccessMs = state?.lastSuccessAt ? new Date(state.lastSuccessAt).getTime() : null;
  const stale =
    !unsupported &&
    (lastSuccessMs === null
      ? nowMs - new Date(integration.createdAt).getTime() > LISTENING_STALE_THRESHOLD_MS
      : nowMs - lastSuccessMs > LISTENING_STALE_THRESHOLD_MS);

  let configurationBlocker: string | null = null;
  if (unsupported) configurationBlocker = "listening unsupported for this platform";
  else if (status === "blocked") {
    configurationBlocker =
      state?.lastFailureCode === "LISTENING_NOT_CONFIGURED"
        ? "provider listening setup missing (fetch seam not configured)"
        : (state?.lastFailureReason ?? "blocked by operator-action failure");
  } else if (state?.lastFailureClass === "OPERATOR_ACTION") {
    configurationBlocker = state.lastFailureReason ?? "operator action required";
  }

  return {
    integrationId: integration.id,
    provider: state?.provider ?? providerGuess(integration.platform),
    platform: integration.platform,
    providerAccountId: state?.providerAccountId ?? integration.pageId ?? integration.instagramBusinessAccountId,
    accountName: integration.accountName,
    capability,
    mechanism: mechanismName,
    status,
    cursor: state?.cursor ?? null,
    cursorUpdatedAt: state?.cursorUpdatedAt ?? null,
    lastSuccessAt: state?.lastSuccessAt ?? null,
    lastFailureAt: state?.lastFailureAt ?? null,
    lastFailureClass: state?.lastFailureClass ?? null,
    lastFailureCode: state?.lastFailureCode ?? null,
    lastFailureReason: state?.lastFailureReason ?? null,
    acceptedCount: state?.acceptedCount ?? 0,
    duplicateCount: state?.duplicateCount ?? 0,
    rejectedCount: state?.rejectedCount ?? 0,
    recentSignalCount,
    stale,
    configurationBlocker,
    unsupported,
  };
}

function providerGuess(platform: string): string {
  if (platform === "facebook" || platform === "instagram" || platform === "whatsapp") return "meta";
  return platform;
}

export async function getListeningOverview(
  input: {
    userId?: number;
    executor?: ObservabilityExecutor;
    now?: Date;
  } = {}
): Promise<ListeningBindingStatus[]> {
  const db = input.executor ?? getDb();
  const nowMs = (input.now ?? new Date()).getTime();

  const integrations = (await db
    .select()
    .from(socialIntegrations)
    .limit(500)) as SocialIntegration[];
  const scoped = input.userId
    ? integrations.filter((i) => i.userId === input.userId)
    : integrations;
  const ids = scoped.map((i) => i.id);

  const states = ids.length
    ? ((await db
        .select()
        .from(socialListeningStates)
        .where(inArray(socialListeningStates.integrationId, ids))
        .limit(1000)) as SocialListeningState[])
    : [];
  const stateByIntegration = new Map(states.map((s) => [s.integrationId, s]));

  const since = new Date(nowMs - LISTENING_STALE_THRESHOLD_MS);
  const signalCounts = ids.length
    ? await db
        .select({
          integrationId: socialSignals.integrationId,
          count: sql<number>`COUNT(*)`,
        })
        .from(socialSignals)
        .where(
          sql`${inArray(socialSignals.integrationId, ids)} AND ${socialSignals.observedAt} >= ${since}`
        )
        .groupBy(socialSignals.integrationId)
    : [];
  const countByIntegration = new Map(signalCounts.map((r) => [r.integrationId, Number(r.count)]));

  return scoped.map((integration) =>
    deriveStatus(
      integration,
      stateByIntegration.get(integration.id) ?? null,
      countByIntegration.get(integration.id) ?? 0,
      nowMs
    )
  );
}

/** Read-only canonical signal view, strictly tenant-scoped. */
export async function listSignalsForUser(
  input: {
    userId: number;
    integrationId?: number;
    attributionType?: string;
    limit?: number;
    executor?: ObservabilityExecutor;
  }
): Promise<Array<typeof socialSignals.$inferSelect>> {
  const db = input.executor ?? getDb();
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);

  const conditions = [eq(socialSignals.userId, input.userId)];
  if (input.integrationId) conditions.push(eq(socialSignals.integrationId, input.integrationId));
  if (input.attributionType) conditions.push(eq(socialSignals.attributionType, input.attributionType as never));

  const rows = await db
    .select()
    .from(socialSignals)
    .where(and(...conditions))
    .orderBy(desc(socialSignals.observedAt))
    .limit(limit);
  return rows as Array<typeof socialSignals.$inferSelect>;
}
