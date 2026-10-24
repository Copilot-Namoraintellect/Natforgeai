// ─── R5-D Opportunity Detection — deterministic identity (contract §1, §5) ───
//
// PURE module: thread coordinates → opportunityKey → opportunityId, plus
// evidence-fragment hashing. Identity is server-derived only; coordinates
// bind the tenant anchor so cross-tenant collision/correlation is impossible.
// No wall-clock, no randomness — replaying the same authoritative inputs
// reproduces the same identity. No I/O.

import type { CanonicalInterpretation } from "./canonical-intelligence";
import {
  canonicalJson,
  sha256Hex,
} from "./opportunity-contract";

/** Prefixes make identities self-describing in logs and handoff envelopes. */
export const OPPORTUNITY_ID_PREFIX = "opp1:" as const;
export const HANDOFF_ID_PREFIX = "oph1:" as const;

export const NO_ACTOR = "no-actor" as const;
export const NO_THREAD = "no-thread" as const;
export const NO_TOPIC = "no-topic" as const;

/**
 * actorKey: opaque hash binding provider + platform + actorReference. The raw
 * actor reference is NEVER persisted by R5-D (privacy minimization); the same
 * external actor under a different provider/platform is a different actorKey.
 */
export function deriveActorKey(interpretation: CanonicalInterpretation): string {
  if (!interpretation.actorReference) return NO_ACTOR;
  return sha256Hex(
    canonicalJson({
      provider: interpretation.provider,
      platform: interpretation.platform,
      actorReference: interpretation.actorReference,
    })
  );
}

/**
 * threadKey: authoritative thread linkage from R5-A threading references —
 * parentExternalObjectId when present, else externalObjectId. No thread
 * reference → NO_THREAD (identity still tenant-scoped and deterministic).
 */
export function deriveThreadKey(interpretation: CanonicalInterpretation): string {
  const threadRef =
    interpretation.parentExternalObjectId ?? interpretation.externalObjectId;
  if (!threadRef) return NO_THREAD;
  return sha256Hex(canonicalJson({ threadRef }));
}

/** topicKey: binds R5-B topics (sorted, joined). Same actor + unrelated topic
 *  → distinct candidate (D4 case 6). */
export function deriveTopicKey(interpretation: CanonicalInterpretation): string {
  const topics = [...interpretation.topics].sort();
  if (topics.length === 0) return NO_TOPIC;
  return sha256Hex(canonicalJson({ topics }));
}

/** Display topic (first topic, ≤48 chars): navigation hint, never authority. */
export function deriveDisplayTopic(interpretation: CanonicalInterpretation): string | null {
  return interpretation.topics[0] ?? null;
}

/** Thread coordinates are the full durable identity input (contract §1). */
export interface OpportunityThreadCoordinates {
  readonly tenantUserId: number;
  readonly businessId: number | null;
  readonly opportunityType: string;
  readonly actorKey: string;
  readonly threadKey: string;
  readonly topicKey: string;
}

export function buildThreadCoordinates(input: {
  userId: number;
  businessId: number | null;
  opportunityType: string;
  actorKey: string;
  threadKey: string;
  topicKey: string;
}): OpportunityThreadCoordinates {
  return Object.freeze({
    tenantUserId: input.userId,
    businessId: input.businessId,
    opportunityType: input.opportunityType,
    actorKey: input.actorKey,
    threadKey: input.threadKey,
    topicKey: input.topicKey,
  });
}

/** 64-hex thread identity. tenantUserId inside coordinates anchors the hash:
 *  identical upstream evidence under a different tenant can never collide. */
export function deriveOpportunityKey(coordinates: OpportunityThreadCoordinates): string {
  return sha256Hex(canonicalJson(coordinates));
}

export function deriveOpportunityId(opportunityKey: string): string {
  return `${OPPORTUNITY_ID_PREFIX}${opportunityKey}`;
}

/**
 * Evidence-fragment hash (contract §5): binds the immutable evidence fields.
 * Drift between retained evidence and this hash is tampering evidence and
 * fails closed. No social text participates.
 */
export function deriveEvidenceHash(input: {
  candidateId: number;
  interpretationId: string;
  signalId: string;
  signalVersion: number;
  kind: string;
  engagementReceiptId: string | null;
  opportunityTypeAtEvaluation: string;
  intent: string;
  overallConfidence: string;
  relevance: string;
  sentiment: string;
  urgency: string;
  sourceCampaignId: number | null;
  occurredAt: string;
}): string {
  // Rebuilt field-by-field: the hashed fragment is exactly the immutable
  // evidence material — callers cannot smuggle extra keys into the hash.
  return sha256Hex(
    canonicalJson({
      candidateId: input.candidateId,
      interpretationId: input.interpretationId,
      signalId: input.signalId,
      signalVersion: input.signalVersion,
      kind: input.kind,
      engagementReceiptId: input.engagementReceiptId,
      opportunityTypeAtEvaluation: input.opportunityTypeAtEvaluation,
      intent: input.intent,
      overallConfidence: input.overallConfidence,
      relevance: input.relevance,
      sentiment: input.sentiment,
      urgency: input.urgency,
      sourceCampaignId: input.sourceCampaignId,
      occurredAt: input.occurredAt,
    })
  );
}
