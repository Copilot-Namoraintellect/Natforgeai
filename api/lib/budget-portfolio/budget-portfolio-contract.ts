// ─── R7-E Budget & Portfolio Optimisation — canonical contract ───
//
// PURE contract module: closed vocabularies, version identities, deterministic
// id/hash derivations, typed error taxonomy, zod router-input schemas and
// canonical hashing helpers for the budget/portfolio optimisation authority
// (docs/contracts/budget-portfolio-optimisation-contract.md). It performs no
// I/O of any kind and moves no money.
//
// An optimisation proposal is EXPLAINABLE MATERIAL derived from governed
// evidence + a deterministic portfolio snapshot + a bounded solver only. No
// model sits in the allocation path; no client may supply allocations, totals,
// confidence, reason codes, governance verdicts or approval state. Governance
// (R7-F) authorizes; R4 settles; this stream proposes.

import { createHash } from "crypto";
import { z } from "zod";

export const BUDGET_PORTFOLIO_CONTRACT_VERSION = "budget-portfolio/v1" as const;
export const BUDGET_PORTFOLIO_ALGORITHM_VERSION = "budget-portfolio-algorithm/v1" as const;
export const BUDGET_PORTFOLIO_CONSTRAINT_VERSION = "budget-portfolio-constraints/v1" as const;

export const PORTFOLIO_SNAPSHOT_ID_PREFIX = "psn1:" as const;
export const PORTFOLIO_SNAPSHOT_ID_PATTERN = /^psn1:[a-f0-9]{64}$/;
export const OPTIMISATION_ID_PREFIX = "opt1:" as const;
export const OPTIMISATION_ID_PATTERN = /^opt1:[a-f0-9]{64}$/;
export const ALLOCATION_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_|-]{0,95}$/;
export const CAMPAIGN_ALLOCATION_KEY_PREFIX = "camp:" as const;
export const CURRENCY_PATTERN = /^[A-Z]{3}$/;
export const BUDGET_PERIOD_PATTERN = /^\d{4}-\d{2}$/;
export const HEX_64 = /^[a-f0-9]{64}$/;
export const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export function isIsoUtc(value: string): boolean {
  return ISO_UTC_PATTERN.test(value);
}

// ─── Closed vocabularies (contract §2 — closed) ───

export const OPTIMISATION_OBJECTIVES = [
  "MAXIMISE_EVIDENCE_WEIGHTED_VALUE",
  "REBALANCE_TO_POLICY_TARGET",
] as const;
export type OptimisationObjective = (typeof OPTIMISATION_OBJECTIVES)[number];

export const OPTIMISATION_CONFIDENCE_CLASSES = [
  "STRONG",
  "MODERATE",
  "WEAK",
  "INSUFFICIENT",
] as const;
export type OptimisationConfidenceClass =
  (typeof OPTIMISATION_CONFIDENCE_CLASSES)[number];

export const OPTIMISATION_PROPOSAL_STATUSES = [
  "PROPOSED",
  "ALLOWED",
  "REVIEW_REQUIRED",
  "BLOCKED",
  "AUTHORIZED",
  "REJECTED",
  "EXPIRED",
  "NO_CHANGE",
] as const;
export type OptimisationProposalStatus = (typeof OPTIMISATION_PROPOSAL_STATUSES)[number];

const OPTIMISATION_PROPOSAL_STATUS_SET: ReadonlySet<string> = new Set(
  OPTIMISATION_PROPOSAL_STATUSES
);

export function isOptimisationProposalStatus(
  value: unknown
): value is OptimisationProposalStatus {
  return typeof value === "string" && OPTIMISATION_PROPOSAL_STATUS_SET.has(value);
}

/**
 * Closed R7-E reason-code vocabulary (contract §2). Bounded: a proposal
 * carries at most MAX_OPTIMISATION_REASON_CODES codes in deterministic order.
 */
export const OPTIMISATION_REASON_CODES = [
  "NO_VIABLE_IMPROVEMENT",
  "CHANGE_BELOW_MINIMUM_THRESHOLD",
  "EVIDENCE_INSUFFICIENT",
  "EVIDENCE_STALE",
  "EVIDENCE_CONTRADICTED",
  "LEARNING_CONTRADICTED",
  "SNAPSHOT_STALE",
  "LOCKED_FUNDS_PRESERVED",
  "RESERVED_FUNDS_PRESERVED",
  "UNSUPPORTED_PROVIDER_EXCLUDED",
  "DISABLED_CAMPAIGN_EXCLUDED",
  "MIN_ALLOCATION_FLOOR_APPLIED",
  "CONCENTRATION_CEILING_APPLIED",
  "PER_CYCLE_SHIFT_CAP_APPLIED",
  "COOLDOWN_ACTIVE",
  "REVERSAL_STABILITY_HOLD",
  "GOVERNANCE_ALLOWED",
  "GOVERNANCE_REVIEW_REQUIRED",
  "GOVERNANCE_BLOCKED",
  "GOVERNANCE_UNAVAILABLE",
  "TOTAL_BUDGET_INCREASE_FORBIDDEN",
] as const;
export type OptimisationReasonCode = (typeof OPTIMISATION_REASON_CODES)[number];

const OPTIMISATION_REASON_CODE_SET: ReadonlySet<string> = new Set(OPTIMISATION_REASON_CODES);

export function isOptimisationReasonCode(value: unknown): value is OptimisationReasonCode {
  return typeof value === "string" && OPTIMISATION_REASON_CODE_SET.has(value);
}

export const MAX_OPTIMISATION_REASON_CODES = 8;

// ─── Canonical JSON + hashing (same discipline as upstream authorities) ───

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    if (typeof value === "string") return value.trim().replace(/\s+/g, " ");
    return value;
  }
  if (Array.isArray(value)) return value.map(sortKeys);
  const sorted: Record<string, unknown> = {};
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = sortKeys(obj[key]);
  }
  return sorted;
}

/** Canonical JSON (key-sorted, whitespace-normalised) for stable hashing. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

// ─── Deterministic id/hash derivations (contract §4, §5) ───

/**
 * Deterministic portfolio snapshot identity. Same authoritative state ⇒ same
 * id; no wall-clock field participates. `capturedAt` is deliberately excluded.
 */
export function derivePortfolioSnapshotId(input: {
  userId: number;
  businessId: number;
  budgetPeriod: string;
  currency: string;
  approvedTotalBudgetMinor: number;
  committedMinor: number;
  reservedMinor: number;
  currentAllocations: Readonly<Record<string, number>>;
  supportedProviders: readonly string[];
  lockedAllocationKeys: readonly string[];
  disabledAllocationKeys: readonly string[];
}): string {
  return `${PORTFOLIO_SNAPSHOT_ID_PREFIX}${sha256Hex(
    canonicalJson({
      v: 1,
      userId: input.userId,
      businessId: input.businessId,
      budgetPeriod: input.budgetPeriod,
      currency: input.currency,
      approvedTotalBudgetMinor: input.approvedTotalBudgetMinor,
      committedMinor: input.committedMinor,
      reservedMinor: input.reservedMinor,
      currentAllocations: input.currentAllocations,
      supportedProviders: [...input.supportedProviders].sort(),
      lockedAllocationKeys: [...input.lockedAllocationKeys].sort(),
      disabledAllocationKeys: [...input.disabledAllocationKeys].sort(),
    })
  )}`;
}

/**
 * Deterministic optimisation proposal identity: one snapshot + one objective +
 * one evidence bundle + one algorithm/constraint version ⇒ one id. Retries and
 * concurrent evaluations converge through the durable unique anchor.
 */
export function deriveOptimisationId(input: {
  userId: number;
  businessId: number;
  portfolioSnapshotId: string;
  objective: OptimisationObjective;
  algorithmVersion: string;
  constraintVersion: string;
  evidenceBundleHash: string;
}): string {
  return `${OPTIMISATION_ID_PREFIX}${sha256Hex(
    canonicalJson({
      v: 1,
      userId: input.userId,
      businessId: input.businessId,
      portfolioSnapshotId: input.portfolioSnapshotId,
      objective: input.objective,
      algorithmVersion: input.algorithmVersion,
      constraintVersion: input.constraintVersion,
      evidenceBundleHash: input.evidenceBundleHash,
    })
  )}`;
}

/** Opaque fingerprint of an evidence bundle: the sorted reference sets only. */
export function deriveEvidenceBundleHash(input: {
  outcomeRefs: readonly string[];
  attributionRefs: readonly string[];
  learningRefs: readonly string[];
}): string {
  return sha256Hex(
    canonicalJson({
      v: 1,
      outcomeRefs: [...input.outcomeRefs].sort(),
      attributionRefs: [...input.attributionRefs].sort(),
      learningRefs: [...input.learningRefs].sort(),
    })
  );
}

/**
 * Content integrity hash over the material proposal output. Re-verified on
 * every read; drift is tampering and fails closed (OPTIMISATION_EVIDENCE_CONFLICT).
 */
export function deriveProposalContentHash(input: {
  optimisationId: string;
  currentAllocations: readonly unknown[];
  proposedAllocations: readonly unknown[];
  deltaAllocations: readonly unknown[];
  confidenceClass: string;
  reasonCodes: readonly string[];
}): string {
  return sha256Hex(
    canonicalJson({
      v: 1,
      optimisationId: input.optimisationId,
      currentAllocations: input.currentAllocations,
      proposedAllocations: input.proposedAllocations,
      deltaAllocations: input.deltaAllocations,
      confidenceClass: input.confidenceClass,
      reasonCodes: [...input.reasonCodes],
    })
  );
}

// ─── Typed error taxonomy (fail closed, mirrors R6/R7 discipline) ───

export type BudgetPortfolioErrorCode =
  | "MALFORMED_INPUT"
  | "OWNERSHIP_MISMATCH"
  | "SNAPSHOT_NOT_FOUND"
  | "SNAPSHOT_STALE"
  | "SNAPSHOT_REPLAY_CONFLICT"
  | "SNAPSHOT_EVIDENCE_CONFLICT"
  | "OPTIMISATION_NOT_FOUND"
  | "OPTIMISATION_REPLAY_CONFLICT"
  | "OPTIMISATION_EVIDENCE_CONFLICT"
  | "EVIDENCE_UNAVAILABLE"
  | "EVIDENCE_VALIDATION_FAILED"
  | "GOVERNANCE_UNAVAILABLE"
  | "GOVERNANCE_DECISION_BINDING_MISMATCH"
  | "GOVERNANCE_REPLAY_CONFLICT"
  | "NOT_EXECUTABLE"
  | "CLIENT_AUTHORITY_FIELD_REJECTED"
  | "INVALID_CLOCK"
  | "BUDGET_INVARIANT_VIOLATION"
  | "PROVIDER_AUTHORITY_UNAVAILABLE";

export class BudgetPortfolioError extends Error {
  readonly code: BudgetPortfolioErrorCode;
  constructor(code: BudgetPortfolioErrorCode, message: string) {
    super(message);
    this.name = "BudgetPortfolioError";
    this.code = code;
  }
}

export class BudgetPortfolioInputError extends BudgetPortfolioError {
  constructor(code: BudgetPortfolioErrorCode, message: string) {
    super(code, message);
    this.name = "BudgetPortfolioInputError";
  }
}

export class BudgetPortfolioOwnershipError extends BudgetPortfolioError {
  constructor(code: BudgetPortfolioErrorCode, message: string) {
    super(code, message);
    this.name = "BudgetPortfolioOwnershipError";
  }
}

export class BudgetPortfolioValidationError extends BudgetPortfolioError {
  constructor(code: BudgetPortfolioErrorCode, message: string) {
    super(code, message);
    this.name = "BudgetPortfolioValidationError";
  }
}

export class BudgetPortfolioStateConflictError extends BudgetPortfolioError {
  constructor(code: BudgetPortfolioErrorCode, message: string) {
    super(code, message);
    this.name = "BudgetPortfolioStateConflictError";
  }
}

// ─── zod router-input schemas ───
//
// z.strictObject rejects unknown keys: no client-supplied authority of any
// kind (allocations, totals, confidence, reason codes, governance verdicts,
// approval state). Clients reference ids and choose an objective only.

export const CreatePortfolioSnapshotInputSchema = z.strictObject({
  businessId: z.number().int().positive(),
});
export type CreatePortfolioSnapshotInput = z.infer<typeof CreatePortfolioSnapshotInputSchema>;

export const GetPortfolioSnapshotInputSchema = z.strictObject({
  portfolioSnapshotId: z.string().regex(PORTFOLIO_SNAPSHOT_ID_PATTERN),
});
export type GetPortfolioSnapshotInput = z.infer<typeof GetPortfolioSnapshotInputSchema>;

export const ListPortfolioSnapshotsInputSchema = z.strictObject({
  businessId: z.number().int().positive(),
  limit: z.number().int().positive().max(100).optional(),
});
export type ListPortfolioSnapshotsInput = z.infer<typeof ListPortfolioSnapshotsInputSchema>;

export const ProposeOptimisationInputSchema = z.strictObject({
  businessId: z.number().int().positive(),
  portfolioSnapshotId: z.string().regex(PORTFOLIO_SNAPSHOT_ID_PATTERN).optional(),
  objective: z.enum(OPTIMISATION_OBJECTIVES).optional(),
  evidenceRefs: z.strictObject({
    outcomeRefs: z.array(z.string().min(1).max(128)).max(200).optional(),
    attributionRefs: z.array(z.string().min(1).max(128)).max(200).optional(),
    learningRefs: z.array(z.string().min(1).max(128)).max(200).optional(),
  }).optional(),
});
export type ProposeOptimisationInput = z.infer<typeof ProposeOptimisationInputSchema>;

export const GetOptimisationProposalInputSchema = z.strictObject({
  optimisationId: z.string().regex(OPTIMISATION_ID_PATTERN),
});
export type GetOptimisationProposalInput = z.infer<typeof GetOptimisationProposalInputSchema>;

export const ListOptimisationProposalsInputSchema = z.strictObject({
  businessId: z.number().int().positive(),
  status: z.enum(OPTIMISATION_PROPOSAL_STATUSES).optional(),
  limit: z.number().int().positive().max(100).optional(),
});
export type ListOptimisationProposalsInput = z.infer<typeof ListOptimisationProposalsInputSchema>;

export const GetAuthorisedInstructionInputSchema = z.strictObject({
  optimisationId: z.string().regex(OPTIMISATION_ID_PATTERN),
});
export type GetAuthorisedInstructionInput = z.infer<typeof GetAuthorisedInstructionInputSchema>;

export const GetStrategyHandoffInputSchema = z.strictObject({
  optimisationId: z.string().regex(OPTIMISATION_ID_PATTERN),
});
export type GetStrategyHandoffInput = z.infer<typeof GetStrategyHandoffInputSchema>;

// ─── Allocation key helpers ───

export function campaignAllocationKey(campaignId: number): string {
  if (!Number.isInteger(campaignId) || campaignId <= 0) {
    throw new BudgetPortfolioInputError(
      "MALFORMED_INPUT",
      `campaignId must be a positive integer, got ${String(campaignId)}`
    );
  }
  return `${CAMPAIGN_ALLOCATION_KEY_PREFIX}${campaignId}`;
}

export function campaignIdFromAllocationKey(key: string): number | null {
  if (!key.startsWith(CAMPAIGN_ALLOCATION_KEY_PREFIX)) return null;
  const id = Number(key.slice(CAMPAIGN_ALLOCATION_KEY_PREFIX.length));
  return Number.isInteger(id) && id > 0 ? id : null;
}
