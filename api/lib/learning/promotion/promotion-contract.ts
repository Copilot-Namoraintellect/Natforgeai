/**
 * Learning promotion contract (WBS15.6) — pure, side-effect free.
 *
 * A Learning promotion proposes one EXACT recommended adjustment from one
 * EXACT learning record for approval, so a future BI/Strategy generation
 * cycle may consume it as governed input. Nothing here mutates Strategy,
 * Business DNA, Creative, Distribution or historical campaign/learning state.
 *
 * Identity model:
 * - Coordinates bind the exact learning record, campaign, evaluation version,
 *   learning authority fingerprint, recommendation id, target engine, and the
 *   proposed adjustment content (summary/rationale/adjustmentType/evidenceRefs).
 * - The proposal fingerprint is a deterministic SHA-256 over the canonical
 *   (key-sorted) coordinates. Identical material input always yields the same
 *   fingerprint; any coordinate drift invalidates it.
 * - The idempotency key is derived from the fingerprint, so repeated
 *   proposals of the same exact recommendation collapse onto one durable
 *   proposal instead of creating duplicate promotion authority.
 *
 * Storage model (existing infrastructure, no schema change):
 * - approval_requests row (pending → approved/rejected via the guarded
 *   Approval Centre decision flow) carries the immutable proposal in its
 *   context JSON under the LEARNING_PROMOTION_CONTEXT_SOURCE discriminator.
 *   The approvalType column uses a carrier enum value because the enum has no
 *   learning-specific member; the discriminator is the authority and every
 *   promotion code path checks it.
 */

import { createHash } from "crypto";
import type { AdjustmentTargetEngine } from "../contracts/learning-derivation";

/**
 * Carrier approval type. The approval_requests.approvalType enum has no
 * learning-specific value (adding one is a schema migration, out of scope for
 * this stream). high_value_proposal has no backend creators, no backend
 * readers and no onApprovalResolved side-effect branch, making it the
 * lowest-collision carrier. The context discriminator below — not this
 * label — is the promotion authority.
 */
export const LEARNING_PROMOTION_CARRIER_APPROVAL_TYPE = "high_value_proposal";

/** Mandatory discriminator inside approval_requests.context. */
export const LEARNING_PROMOTION_CONTEXT_SOURCE = "learning_promotion";

export const LEARNING_PROMOTION_CONTRACT_VERSION = 1;

export const LEARNING_PROMOTION_IDEMPOTENCY_PREFIX = "lp:";

/**
 * Semantic provenance classes. A promoted recommendation is NEVER re-labelled
 * as fact: observed analytics rows stay observed evidence, rule/assumption
 * derivations stay derived findings, and only the human-approved adjustment
 * carries the approved_recommendation class.
 */
export const LEARNING_PROMOTION_PROVENANCE_CLASSES = [
  "observed_evidence",
  "derived_finding",
  "stated_assumption",
  "approved_recommendation",
] as const;

export type LearningPromotionProvenanceClass =
  (typeof LEARNING_PROMOTION_PROVENANCE_CLASSES)[number];

/** Exact binding coordinates for one promotion proposal. */
export interface LearningPromotionCoordinates {
  learningRecordId: number;
  campaignId: number;
  evaluationVersion: string;
  /** Learning engine name (authority identity). */
  learningEngine: string;
  /** Learning engine/evaluation version (authority version). */
  learningEngineVersion: string;
  /** Learning input digest (learning authority fingerprint, when present). */
  learningInputDigest: string;
  recommendationId: string;
  targetEngine: AdjustmentTargetEngine;
  adjustmentType: string;
  summary: string;
  rationale: string;
  evidenceRefs: string[];
}

/** Immutable proposal persisted in approval_requests.context. */
export interface LearningPromotionContext {
  source: typeof LEARNING_PROMOTION_CONTEXT_SOURCE;
  contractVersion: typeof LEARNING_PROMOTION_CONTRACT_VERSION;
  coordinates: LearningPromotionCoordinates;
  proposalFingerprint: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number": {
      if (!Number.isFinite(value)) {
        throw new Error("learning promotion coordinates contain a non-finite number");
      }
      return JSON.stringify(value);
    }
    case "boolean":
      return value ? "true" : "false";
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (!isPlainObject(value)) {
    throw new Error("learning promotion coordinates must be JSON-like");
  }
  const keys = Object.keys(value).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

/**
 * Deterministic SHA-256 proposal fingerprint over the canonical coordinates.
 * No timestamps: identity is material-only, so the same exact recommendation
 * always produces the same fingerprint regardless of when it is proposed.
 */
export function buildLearningPromotionProposalFingerprint(
  coordinates: LearningPromotionCoordinates
): string {
  return createHash("sha256")
    .update(canonicalJson(coordinates), "utf8")
    .digest("hex");
}

/** Durable replay authority for idempotent proposal creation. */
export function buildLearningPromotionIdempotencyKey(proposalFingerprint: string): string {
  return `${LEARNING_PROMOTION_IDEMPOTENCY_PREFIX}${proposalFingerprint}`;
}

export function buildLearningPromotionContext(input: {
  coordinates: LearningPromotionCoordinates;
  proposalFingerprint: string;
}): LearningPromotionContext {
  return {
    source: LEARNING_PROMOTION_CONTEXT_SOURCE,
    contractVersion: LEARNING_PROMOTION_CONTRACT_VERSION,
    coordinates: input.coordinates,
    proposalFingerprint: input.proposalFingerprint,
  };
}

/**
 * Strictly validate an unknown context payload. Returns null unless the
 * payload is a complete learning promotion context — consumers fail closed
 * on null rather than guessing.
 */
export function extractLearningPromotionContext(
  context: unknown
): LearningPromotionContext | null {
  if (!isPlainObject(context)) return null;
  if (context.source !== LEARNING_PROMOTION_CONTEXT_SOURCE) return null;
  if (context.contractVersion !== LEARNING_PROMOTION_CONTRACT_VERSION) return null;
  if (typeof context.proposalFingerprint !== "string" || context.proposalFingerprint.length === 0) {
    return null;
  }
  const coordinates = context.coordinates;
  if (!isPlainObject(coordinates)) return null;

  const stringFields = [
    "evaluationVersion",
    "learningEngine",
    "learningEngineVersion",
    "learningInputDigest",
    "recommendationId",
    "adjustmentType",
    "summary",
    "rationale",
  ] as const;
  for (const field of stringFields) {
    if (typeof coordinates[field] !== "string") return null;
  }
  if (
    !Number.isInteger(coordinates.learningRecordId) ||
    (coordinates.learningRecordId as number) <= 0
  ) {
    return null;
  }
  if (!Number.isInteger(coordinates.campaignId) || (coordinates.campaignId as number) <= 0) {
    return null;
  }
  const targetEngine = coordinates.targetEngine;
  if (
    targetEngine !== "strategy" &&
    targetEngine !== "creative" &&
    targetEngine !== "distribution"
  ) {
    return null;
  }
  if (!Array.isArray(coordinates.evidenceRefs)) return null;
  if (!coordinates.evidenceRefs.every((ref) => typeof ref === "string")) return null;

  const typedCoordinates = coordinates as unknown as LearningPromotionCoordinates;
  // The stored fingerprint must match the material it claims to bind.
  if (buildLearningPromotionProposalFingerprint(typedCoordinates) !== context.proposalFingerprint) {
    return null;
  }
  return {
    source: LEARNING_PROMOTION_CONTEXT_SOURCE,
    contractVersion: LEARNING_PROMOTION_CONTRACT_VERSION,
    coordinates: typedCoordinates,
    proposalFingerprint: context.proposalFingerprint,
  };
}
