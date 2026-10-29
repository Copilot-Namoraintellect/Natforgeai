// ─── R7-C Business Learning Engine — learning identity & record integrity ───
//
// PURE module (no I/O, no clock). Deterministic learning identity over the
// full derived authority: tenant, business, classification, subject,
// context, evidence bundle, derivation version and the upstream state
// fingerprint. The record hash binds the immutable core of a persisted row;
// drift is tampering and fails closed on every read. No wall-clock and no
// randomness participates in any identity.

import {
  canonicalJson,
  sha256Hex,
  LEARNING_DERIVATION_VERSION,
  LEARNING_ID_PATTERN,
} from "./business-learning-contract";
import type { LearningContextScope } from "./business-learning-context";

export const LEARNING_ID_PREFIX = "lrn1:" as const;
export const LEARNING_LIFECYCLE_EVENT_ID_PREFIX = "lbf1:" as const;

/** Canonical learning identity inputs (contract §3). */
export interface LearningIdentityInput {
  readonly userId: number;
  readonly businessId: number;
  readonly learningType: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly outcomeTypeFamily: string;
  readonly contextScope: LearningContextScope;
  readonly evidenceBundleId: string;
  readonly upstreamStateFingerprint: string;
}

/**
 * Deterministic learning identity. Same tenant + same business + same
 * derived candidate + same evidence bundle + same upstream state → same
 * learningId. Retries and concurrent derivations converge on one row.
 */
export function deriveLearningId(input: LearningIdentityInput): string {
  const key = sha256Hex(
    canonicalJson({
      v: 1,
      tenantUserId: input.userId,
      businessId: input.businessId,
      learningType: input.learningType,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      outcomeTypeFamily: input.outcomeTypeFamily,
      contextScope: input.contextScope,
      evidenceBundleId: input.evidenceBundleId,
      derivationVersion: LEARNING_DERIVATION_VERSION,
      upstreamStateFingerprint: input.upstreamStateFingerprint,
    })
  );
  return LEARNING_ID_PREFIX + key;
}

/** Upstream state binding: every contributing outcome's current status. */
export function deriveUpstreamStateFingerprint(
  outcomeStates: readonly { outcomeId: string; outcomeStatus: string }[]
): string {
  const sorted = [...outcomeStates].sort((a, b) =>
    a.outcomeId < b.outcomeId ? -1 : a.outcomeId > b.outcomeId ? 1 : 0
  );
  return sha256Hex(canonicalJson({ v: 1, outcomeStates: sorted }));
}

/** Immutable-core material of a persisted learning record (hash input). */
export interface LearningRecordHashInput {
  readonly learningId: string;
  readonly evidenceBundleId: string;
  readonly userId: number;
  readonly businessId: number;
  readonly learningType: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly outcomeTypeFamily: string;
  readonly contextScope: LearningContextScope;
  readonly statement: unknown;
  readonly outcomeIds: readonly string[];
  readonly attributionIds: readonly string[];
  readonly upstreamStateFingerprint: string;
  readonly supportCount: number;
  readonly contradictionCount: number;
  readonly confidenceClass: string;
  readonly evidenceClass: string;
  readonly noveltyClass: string;
  readonly limitations: readonly string[];
  readonly sourceVersions: Readonly<Record<string, string>>;
  readonly narrativeDraft: string | null;
  readonly validUntil: string | null;
  readonly supersedesLearningId: string | null;
  readonly derivedAt: string;
}

/** Deterministic record hash over the immutable core (contract §12). */
export function deriveRecordHash(input: LearningRecordHashInput): string {
  return sha256Hex(
    canonicalJson({
      v: 1,
      learningId: input.learningId,
      evidenceBundleId: input.evidenceBundleId,
      userId: input.userId,
      businessId: input.businessId,
      learningType: input.learningType,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      outcomeTypeFamily: input.outcomeTypeFamily,
      contextScope: input.contextScope,
      statement: input.statement,
      outcomeIds: [...input.outcomeIds].sort(),
      attributionIds: [...input.attributionIds].sort(),
      upstreamStateFingerprint: input.upstreamStateFingerprint,
      supportCount: input.supportCount,
      contradictionCount: input.contradictionCount,
      confidenceClass: input.confidenceClass,
      evidenceClass: input.evidenceClass,
      noveltyClass: input.noveltyClass,
      limitations: [...input.limitations].sort(),
      sourceVersions: input.sourceVersions,
      narrativeDraft: input.narrativeDraft,
      validUntil: input.validUntil,
      supersedesLearningId: input.supersedesLearningId,
      derivedAt: input.derivedAt,
    })
  );
}

/** Deterministic lifecycle-fact identity ("lbf1:" + sha256 of fact material). */
export function deriveLearningLifecycleEventId(input: {
  learningId: string;
  lifecycleType: string;
  status: string;
  reasonCode: string | null;
  occurredAt: string;
}): string {
  const key = sha256Hex(
    canonicalJson({
      v: 1,
      learningId: input.learningId,
      lifecycleType: input.lifecycleType,
      status: input.status,
      reasonCode: input.reasonCode,
      occurredAt: input.occurredAt,
    })
  );
  return LEARNING_LIFECYCLE_EVENT_ID_PREFIX + key;
}

export function isLearningId(value: string): boolean {
  return LEARNING_ID_PATTERN.test(value);
}
