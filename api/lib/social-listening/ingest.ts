/**
 * Canonical signal ingestion pipeline (WBS-R5-A A2–A4 composed).
 *
 *   validated raw provider event
 *     → contract validation (fail closed)
 *     → authoritative binding resolution (fail closed on unknown tenant)
 *     → evidence-based attribution
 *     → canonical minting (deterministic signalKey + evidence hash)
 *     → exact-once durable acceptance
 *     → listening-state bookkeeping
 *     → disposition
 *
 * Used by both webhook delivery (per event) and polling (per fetched page).
 * Every rejected event is classified for observability; ownership and
 * authenticity failures fail closed and are never retried blindly.
 */

import type { SocialIntegration } from "@db/schema";
import {
  deriveSignalKey,
  buildProviderEvidenceHash,
  sanitizeContentText,
  sanitizeBoundedText,
  normalizeExternalIdentity,
  isSocialSignalPlatform,
  SignalContractError,
  SOCIAL_SIGNAL_INGESTION_VERSION,
  type CanonicalSocialSignal,
  type SocialSignalProvider,
} from "./signal-contract";
import type { RawSocialSignalEvent } from "./adapters/types";
import {
  resolveBindingForProviderAccount,
  resolveSignalAttribution,
  type AttributionExecutor,
} from "./attribution";
import { acceptSocialSignal, type SignalStoreExecutor } from "./signal-store";
import {
  ensureListeningState,
  incrementSignalCounter,
  recordListeningFailure,
  type ListeningStateExecutor,
} from "./listening-state-store";
import { classifyListeningFailure } from "./failure-classes";

export interface IngestDeps {
  attribution?: AttributionExecutor;
  store?: SignalStoreExecutor;
  state?: ListeningStateExecutor;
  /** Deterministic clock seam for tests. */
  now?: () => Date;
}

export type IngestionDisposition =
  | { kind: "accepted"; signalKey: string; signalId: number | null; attributionType: CanonicalSocialSignal["attributionType"] }
  | { kind: "duplicate"; signalKey: string; reason: "idempotent_replay" }
  | { kind: "rejected"; reason: string; failureClass: "AUTO_RECOVER" | "OPERATOR_ACTION" | "FAIL_CLOSED" };

export interface IngestionOutcome {
  disposition: IngestionDisposition;
  /** The canonical signal when accepted (also returned on replay). */
  signal?: CanonicalSocialSignal;
}

function providerForPlatform(platform: string): SocialSignalProvider {
  if (platform === "facebook" || platform === "instagram" || platform === "whatsapp") return "meta";
  if (platform === "linkedin") return "linkedin";
  if (platform === "twitter") return "twitter";
  if (platform === "tiktok") return "tiktok";
  throw new SignalContractError("UNKNOWN_PLATFORM", `Unknown platform: ${platform}`);
}

/**
 * Ingest one validated raw provider event under one platform surface.
 * Idempotent: replaying the same event returns the durable result.
 */
export async function ingestRawSignalEvent(
  platform: string,
  event: RawSocialSignalEvent,
  deps: IngestDeps = {}
): Promise<IngestionOutcome> {
  const now = deps.now ?? (() => new Date());

  try {
    if (!isSocialSignalPlatform(platform)) {
      throw new SignalContractError("UNKNOWN_PLATFORM", `Unknown platform: ${platform}`);
    }
    const provider = providerForPlatform(platform);

    // 1. Authoritative binding — never client-supplied ownership.
    const binding = await resolveBindingForProviderAccount({
      platform,
      providerAccountId: event.providerAccountId,
      executor: deps.attribution,
    });
    if (!binding) {
      throw new SignalContractError(
        "OWNERSHIP_MISMATCH",
        `no connected binding owns provider account ${event.providerAccountId}`
      );
    }

    // 2. Validate identity-bearing fields (fail closed on malformed).
    const providerAccountId = normalizeExternalIdentity(event.providerAccountId, "providerAccountId");
    const externalEventId = normalizeExternalIdentity(event.externalEventId, "externalEventId");
    const externalObjectId = event.externalObjectId
      ? normalizeExternalIdentity(event.externalObjectId, "externalObjectId")
      : null;
    const parentExternalObjectId = event.parentExternalObjectId
      ? normalizeExternalIdentity(event.parentExternalObjectId, "parentExternalObjectId")
      : null;
    const actorReference = event.actorReference
      ? normalizeExternalIdentity(event.actorReference, "actorReference")
      : null;

    // 3. Evidence-based attribution.
    const attribution = await resolveSignalAttribution({
      integration: binding,
      platform,
      externalObjectId,
      executor: deps.attribution,
    });

    // 4. Canonical minting — deterministic, server-derived.
    const observedAt = now();
    const signal: CanonicalSocialSignal = {
      signalKey: deriveSignalKey({ provider, providerAccountId, externalEventId }),
      userId: binding.userId,
      businessId: attribution.businessId,
      provider,
      platform: platform as CanonicalSocialSignal["platform"],
      integrationId: binding.id,
      providerAccountId,
      externalEventId,
      externalObjectId,
      parentExternalObjectId,
      signalType: event.signalType,
      occurredAt: event.occurredAt,
      observedAt,
      sourceCampaignId: attribution.sourceCampaignId,
      sourcePublicationId: attribution.sourcePublicationId,
      sourcePublicationReceiptId: attribution.sourcePublicationReceiptId,
      actorReference,
      actorDisplayName: sanitizeBoundedText(event.actorDisplayName, 255, "actorDisplayName"),
      contentReference: sanitizeBoundedText(event.contentReference, 255, "contentReference"),
      contentText: sanitizeContentText(event.contentText),
      providerEvidenceHash: buildProviderEvidenceHash(event.evidence),
      attributionType: attribution.attributionType,
      status: "accepted",
      ingestionVersion: SOCIAL_SIGNAL_INGESTION_VERSION,
      createdAt: observedAt,
    };

    // 5. Exactly-once durable acceptance.
    const accepted = await acceptSocialSignal(signal, deps.store);

    // 6. Listening-state bookkeeping.
    await ensureListeningState(
      {
        integrationId: binding.id,
        userId: binding.userId,
        businessId: binding.businessId ?? null,
        provider,
        platform,
        providerAccountId,
        mechanism: provider === "meta" ? "webhook" : "polling",
      },
      deps.state
    );
    await incrementSignalCounter(
      binding.id,
      accepted.inserted ? "accepted" : "duplicate",
      deps.state
    );

    return {
      disposition: accepted.inserted
        ? { kind: "accepted", signalKey: signal.signalKey, signalId: Number(accepted.row.id), attributionType: signal.attributionType }
        : { kind: "duplicate", signalKey: signal.signalKey, reason: "idempotent_replay" },
      signal,
    };
  } catch (err) {
    const failure = classifyListeningFailure(err);
    // Best-effort bookkeeping on the binding when we know it; never let
    // bookkeeping break the acknowledgement path.
    try {
      const binding = await resolveBindingForProviderAccount({
        platform,
        providerAccountId: event.providerAccountId,
        executor: deps.attribution,
      }).catch(() => null);
      if (binding) {
        await ensureListeningState(
          {
            integrationId: binding.id,
            userId: binding.userId,
            businessId: binding.businessId ?? null,
            provider: providerForPlatform(platform),
            platform,
            providerAccountId: event.providerAccountId,
            mechanism: providerForPlatform(platform) === "meta" ? "webhook" : "polling",
          },
          deps.state
        );
        await recordListeningFailure(binding.id, failure, deps.state);
        if (failure.class === "FAIL_CLOSED") {
          await incrementSignalCounter(binding.id, "rejected", deps.state);
        }
      }
    } catch {
      // State bookkeeping must never break ingestion acknowledgement.
    }

    return {
      disposition: {
        kind: "rejected",
        reason: failure.reason,
        failureClass: failure.class,
      },
    };
  }
}

export type { SocialIntegration };
