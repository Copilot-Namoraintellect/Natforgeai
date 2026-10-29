// ─── R7-E Budget & Portfolio Optimisation — R7-F governance seam (E6) ───
//
// FROZEN consumption surface for the R7-F Optimisation Governance authority
// (docs/contracts/business-optimisation-governance-contract.md @ 5e4ab95).
// This module contains:
//
//   1. Frozen shape types + validators for the R7-F decision record, proposal
//      material and approval view. R7-E re-validates every governance payload
//      at this boundary — untrusted until accepted.
//   2. `OptimisationGovernancePort` — the narrow seam the service calls.
//      Production default on this branch: UNAVAILABLE (fail closed) — R7-F is
//      a sibling stream consumed at R7-X convergence, never merged here.
//   3. `FakeDefaultPolicyGovernancePort` — TEST-ONLY double implementing the
//      published default-policy behaviour (contract §2/§5-§7 formulas). It
//      exists so R7-E acceptance can prove correct handling of
//      ALLOW / REVIEW_REQUIRED / BLOCK, forged approvals and modified
//      proposals. Canonical authority is R7-F's real engine at R7-X.
//
// R7-E never modifies a governance decision, never self-approves, and never
// exposes an endpoint that marks a proposal allowed.

import { createHash } from "crypto";
import {
  BudgetPortfolioError,
  BudgetPortfolioValidationError,
  canonicalJson,
  sha256Hex,
} from "./budget-portfolio-contract";

// ─── Frozen R7-F constants (contract §1, §3, §7 @ 5e4ab95) ───

export const R7F_CONTRACT_VERSION = "optimisation-governance/v1" as const;
export const R7F_ENGINE_VERSION = "optimisation-governance-engine/v1" as const;
export const R7F_DEFAULT_POLICY_VERSION = "optimisation-governance-policy/v1" as const;
export const GOVERNANCE_DECISION_ID_PATTERN = /^ogd1:[a-f0-9]{64}$/;
export const PROPOSAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
export const R7F_ALLOCATION_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_|-]{0,95}$/;
export const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export const R7F_DECISIONS = ["ALLOW", "REVIEW_REQUIRED", "BLOCK"] as const;
export type R7FGovernanceDecision = (typeof R7F_DECISIONS)[number];

/** Default-policy financial/portfolio knobs (R7-F optimisation-policy.ts @ 5e4ab95). */
export const R7F_DEFAULT_POLICY = Object.freeze({
  policyVersion: R7F_DEFAULT_POLICY_VERSION,
  riskDispositions: Object.freeze({ low: "ALLOW", medium: "REVIEW_REQUIRED", high: "REVIEW_REQUIRED", critical: "BLOCK" }),
  maxDecisionValidityMs: 24 * 60 * 60 * 1000,
  financial: Object.freeze({
    autonomousReallocationCapMinor: 50_000,
    maxAutonomousReallocationFraction: 0.05,
    allowAutonomousTotalIncrease: false,
    maxAutonomousIncreasePerActionMinor: 0,
    allowNewFinancialCommitments: false,
    allowIrreversibleExternalSpend: false,
    staleBudgetStateMs: 15 * 60 * 1000,
  }),
  portfolio: Object.freeze({
    maxConcentrationFraction: 0.5,
    maxSingleShiftFraction: 0.2,
    minReallocationIntervalMs: 24 * 60 * 60 * 1000,
    maxLearningAgeMs: 7 * 24 * 60 * 60 * 1000,
  }),
});

// ─── Frozen shape: R7-F decision record (contract §1) ───

export interface GovernanceApprovalBindingView {
  readonly governanceDecisionId: string;
  readonly proposalId: string;
  readonly businessId: number;
  readonly policyVersion: string;
  readonly proposalFingerprint: string;
  readonly approvalBindingHash: string;
  readonly expiresAt: string;
}

export interface GovernanceDecisionView {
  readonly governanceDecisionId: string;
  readonly contractVersion: string;
  readonly engineVersion: string;
  readonly userId: number;
  readonly businessId: number;
  readonly proposalId: string;
  readonly proposalType: string;
  readonly campaignId: number | null;
  readonly policyVersion: string | null;
  readonly decision: R7FGovernanceDecision;
  readonly reasonCodes: readonly string[];
  readonly riskClass: string;
  readonly financialImpactClass: string;
  readonly financialDeltaMinor: number;
  readonly approvalRequired: boolean;
  readonly approvalBinding: GovernanceApprovalBindingView | null;
  readonly evidenceHash: string;
  readonly proposalFingerprint: string;
  readonly validUntil: string | null;
  readonly evaluatedAt: string;
  readonly evaluationFingerprint: string;
  readonly thresholds: Readonly<Record<string, number>>;
}

function isIsoUtc(value: unknown): value is string {
  return typeof value === "string" && ISO_UTC_PATTERN.test(value);
}

/** Re-validate a raw governance decision payload at the boundary (fail closed). */
export function validateGovernanceDecisionView(raw: unknown): GovernanceDecisionView {
  function fail(message: string): never {
    throw new BudgetPortfolioValidationError(
      "GOVERNANCE_UNAVAILABLE",
      `governance decision failed frozen-shape validation: ${message} (fail closed)`
    );
  }
  if (typeof raw !== "object" || raw === null) fail("decision must be an object");
  const r = raw as Record<string, unknown>;
  if (typeof r.governanceDecisionId !== "string" || !GOVERNANCE_DECISION_ID_PATTERN.test(r.governanceDecisionId)) {
    fail("governanceDecisionId must match ogd1:<sha256>");
  }
  if (r.contractVersion !== R7F_CONTRACT_VERSION) fail("contractVersion mismatch");
  if (typeof r.userId !== "number" || !Number.isInteger(r.userId) || r.userId <= 0) fail("userId invalid");
  if (typeof r.businessId !== "number" || !Number.isInteger(r.businessId) || r.businessId <= 0) fail("businessId invalid");
  if (typeof r.proposalId !== "string" || !PROPOSAL_ID_PATTERN.test(r.proposalId)) fail("proposalId invalid");
  if (typeof r.proposalType !== "string") fail("proposalType invalid");
  if (!(R7F_DECISIONS as readonly string[]).includes(r.decision as string)) fail("decision outside closed vocabulary");
  if (!Array.isArray(r.reasonCodes)) fail("reasonCodes must be an array");
  if (typeof r.financialDeltaMinor !== "number" || !Number.isInteger(r.financialDeltaMinor)) {
    fail("financialDeltaMinor must be an integer");
  }
  if (typeof r.approvalRequired !== "boolean") fail("approvalRequired must be boolean");
  if (typeof r.evidenceHash !== "string" || r.evidenceHash.trim().length === 0) fail("evidenceHash invalid");
  if (typeof r.proposalFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(r.proposalFingerprint)) {
    fail("proposalFingerprint must be a 64-hex sha256");
  }
  if (r.validUntil !== null && !isIsoUtc(r.validUntil)) fail("validUntil must be ISO or null");
  if (!isIsoUtc(r.evaluatedAt)) fail("evaluatedAt must be ISO");
  if (typeof r.evaluationFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(r.evaluationFingerprint)) {
    fail("evaluationFingerprint must be a 64-hex sha256");
  }
  if (r.policyVersion !== null && typeof r.policyVersion !== "string") fail("policyVersion invalid");
  const binding = r.approvalBinding;
  if (r.decision === "REVIEW_REQUIRED") {
    if (binding === null || typeof binding !== "object") fail("REVIEW_REQUIRED decision carries no approval binding");
    const b = binding as Record<string, unknown>;
    if (b.governanceDecisionId !== r.governanceDecisionId) fail("approval binding decision mismatch");
    if (typeof b.approvalBindingHash !== "string" || !/^[a-f0-9]{64}$/.test(b.approvalBindingHash)) {
      fail("approvalBindingHash invalid");
    }
    if (!isIsoUtc(b.expiresAt)) fail("binding expiresAt must be ISO");
  }
  return raw as unknown as GovernanceDecisionView;
}

// ─── Frozen shape: approval ledger row view (R7-F contract §7) ───

export interface OptimisationApprovalView {
  readonly id: number;
  readonly userId: number;
  readonly status: "pending" | "approved" | "rejected" | "edited";
  readonly context: unknown;
}

export type OptimisationActionExecutionVerdict =
  | {
      readonly executable: true;
      readonly authorization: {
        readonly governanceDecisionId: string;
        readonly proposalId: string;
        readonly decision: "ALLOW" | "REVIEW_REQUIRED";
        readonly approvalRequestId: number | null;
        readonly policyVersion: string;
        readonly authorizedAt: string;
        readonly expiresAt: string;
      };
    }
  | { readonly executable: false; readonly reason: string; readonly permanent: boolean };

// ─── The narrow governance port (R7-E calls; R7-X binds the real R7-F) ───

export interface OptimisationGovernancePort {
  /** Current governance policy version (staleness gate at execution time). */
  getCurrentPolicyVersion(): string;
  /** One governed evaluation of proposal material (R7-F `evaluate`). */
  evaluateProposal(input: {
    userId: number;
    proposal: unknown;
    policyVersion?: string;
  }): Promise<{ decision: unknown; duplicateClassification: "none" | "idempotent_replay" }>;
  /** Approval-ledger lookup for a decision (read view; ledger stays authoritative). */
  getApprovalForDecision(input: {
    userId: number;
    governanceDecisionId: string;
  }): Promise<OptimisationApprovalView | null>;
  /**
   * The single execution gate (R7-F `assertOptimisationActionExecutable`).
   * R7-E calls it before any AUTHORIZED state transition and never re-derives
   * its logic.
   */
  assertActionExecutable(input: {
    decision: GovernanceDecisionView;
    approval: OptimisationApprovalView | null;
    currentPolicyVersion: string | null;
    now: string;
  }): OptimisationActionExecutionVerdict;
}

/** Production default while R7-F is unconverged: governance is never guessed. */
export function createUnavailableGovernancePort(): OptimisationGovernancePort {
  const unavailable = (): never => {
    throw new BudgetPortfolioError(
      "GOVERNANCE_UNAVAILABLE",
      "R7-F optimisation governance authority is not bound on this branch (consumed at R7-X convergence); optimisation proposals cannot become execution-eligible here"
    );
  };
  return {
    getCurrentPolicyVersion: () => R7F_DEFAULT_POLICY_VERSION,
    evaluateProposal: async () => unavailable(),
    getApprovalForDecision: async () => unavailable(),
    assertActionExecutable: () => unavailable(),
  };
}

// ─── Deterministic published derivations (contract §1/§7 formulas) ───

export function deriveR7FProposalFingerprint(proposal: {
  proposalId: string;
  businessId: number;
  proposalType: string;
  financial: unknown;
  experiment: unknown;
  portfolio: unknown;
  learningReference: unknown;
  campaignId: number | null;
  evidenceHash: string;
}): string {
  return sha256Hex(
    canonicalJson({
      v: 1,
      proposalId: proposal.proposalId,
      businessId: proposal.businessId,
      proposalType: proposal.proposalType,
      financial: proposal.financial,
      experiment: proposal.experiment,
      portfolio: proposal.portfolio,
      learningReference: proposal.learningReference,
      campaignId: proposal.campaignId,
      evidenceHash: proposal.evidenceHash,
    })
  );
}

export function deriveR7FGovernanceDecisionId(input: {
  userId: number;
  businessId: number;
  proposalId: string;
  proposalType: string;
  policyVersion: string;
  proposalFingerprint: string;
  evidenceHash: string;
}): string {
  return `ogd1:${sha256Hex(
    canonicalJson({
      v: 1,
      userId: input.userId,
      businessId: input.businessId,
      proposalId: input.proposalId,
      proposalType: input.proposalType,
      policyVersion: input.policyVersion,
      proposalFingerprint: input.proposalFingerprint,
      evidenceHash: input.evidenceHash,
    })
  )}`;
}

export function deriveR7FApprovalBindingHash(input: {
  governanceDecisionId: string;
  policyVersion: string;
  proposalFingerprint: string;
}): string {
  return sha256Hex(
    canonicalJson({
      v: 1,
      governanceDecisionId: input.governanceDecisionId,
      policyVersion: input.policyVersion,
      proposalFingerprint: input.proposalFingerprint,
    })
  );
}

export function deriveR7FEvaluationFingerprint(input: {
  governanceDecisionId: string;
  decision: string;
  reasonCodes: readonly string[];
  riskClass: string;
  financialImpactClass: string;
  policyVersion: string | null;
  proposalFingerprint: string;
  approvalRequired: boolean;
}): string {
  return sha256Hex(
    canonicalJson({
      v: 1,
      governanceDecisionId: input.governanceDecisionId,
      decision: input.decision,
      reasonCodes: [...input.reasonCodes],
      riskClass: input.riskClass,
      financialImpactClass: input.financialImpactClass,
      policyVersion: input.policyVersion,
      proposalFingerprint: input.proposalFingerprint,
      approvalRequired: input.approvalRequired,
    })
  );
}

function r7fCanonicalHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
void r7fCanonicalHash;

// ─── Shared financial normalisation for fingerprinting ───
//
// The R7-F fingerprint is computed over the VALIDATED proposal shape
// (allocation deltas carry explicit newCommitment/irreversibleExternalSpend
// flags and financial carries an explicit advisoryFinancialClass). Both the
// test double's evaluation and R7-E's binding re-verification must fingerprint
// the identical normalised form.

export function normaliseGovernanceFinancialForFingerprint(financial: {
  currency: string;
  allocationDeltas: readonly {
    allocationKey: string;
    campaignId: number | null;
    provider: string | null;
    deltaMinor: number;
  }[];
}): {
  currency: string;
  allocationDeltas: {
    allocationKey: string;
    campaignId: number | null;
    provider: string | null;
    deltaMinor: number;
    newCommitment: boolean;
    irreversibleExternalSpend: boolean;
  }[];
  advisoryFinancialClass: null;
} {
  return {
    currency: financial.currency,
    allocationDeltas: financial.allocationDeltas.map((d) => ({
      allocationKey: d.allocationKey,
      campaignId: d.campaignId,
      provider: d.provider ?? null,
      deltaMinor: d.deltaMinor,
      newCommitment: false,
      irreversibleExternalSpend: false,
    })),
    advisoryFinancialClass: null,
  };
}

// ─── TEST-ONLY double: faithful default-policy R7-F behaviour ───
//
// Implements the published contract semantics (decision vocabulary, authority
// narrowing, financial/portfolio guardrails, approval binding, execution
// gate) over the frozen shapes. NOT canonical authority — R7-F's engine is
// the only canonical governance at R7-X.

const INJECTION_PATTERNS: readonly RegExp[] = [
  /ignore (all |previous |the )?instructions/i,
  /system prompt/i,
  /you are now/i,
  /approved\s*[:=]\s*true/i,
  /override\s*[:=]\s*true/i,
  /admin\s*[:=]\s*true/i,
  /ignorebudget/i,
  /jailbreak/i,
  /bypass (policy|governance|approval)/i,
];

const FORBIDDEN_CLIENT_AUTHORITY_FIELDS = [
  "decision",
  "riskClass",
  "risk",
  "riskLevel",
  "approvalRequired",
  "approvalStatus",
  "approved",
  "authorized",
  "policyVersion",
  "governanceDecisionId",
  "financialImpactClass",
  "reasonCodes",
  "override",
  "ignoreBudget",
  "admin",
  "forceAllow",
  "forceComplete",
  "setApproved",
] as const;

interface FakeFinancialDelta {
  allocationKey: string;
  campaignId: number | null;
  provider: string | null;
  deltaMinor: number;
  newCommitment: boolean;
  irreversibleExternalSpend: boolean;
}

export interface FakeGovernanceAuthorityState {
  budgetPeriod: string;
  currency: string;
  approvedTotalBudgetMinor: number;
  committedMinor: number;
  reservedMinor: number;
  supportedProviders: readonly string[];
  lockedAllocationKeys: readonly string[];
  currentAllocations: Readonly<Record<string, number>>;
  lastReallocationAtByKey: Readonly<Record<string, string>>;
  stateCapturedAt: string;
}

export class FakeDefaultPolicyGovernancePort implements OptimisationGovernancePort {
  private readonly decisions = new Map<string, GovernanceDecisionView>();
  private readonly approvals = new Map<string, OptimisationApprovalView>();
  private approvalSeq = 0;
  private readonly authority: FakeGovernanceAuthorityState;

  constructor(authority: FakeGovernanceAuthorityState) {
    this.authority = authority;
  }

  getCurrentPolicyVersion(): string {
    return R7F_DEFAULT_POLICY_VERSION;
  }

  /** Test helper: mint an approval row for a REVIEW_REQUIRED decision. */
  mintApproval(governanceDecisionId: string, status: "pending" | "approved" | "rejected"): number {
    const decision = this.decisions.get(governanceDecisionId);
    if (!decision) throw new Error(`fake governance: unknown decision ${governanceDecisionId}`);
    const id = ++this.approvalSeq;
    this.approvals.set(governanceDecisionId, {
      id,
      userId: decision.userId,
      status,
      context: {
        optimisationGovernanceBinding: {
          contractVersion: "optimisation-governance/approval@v1",
          governanceDecisionId: decision.governanceDecisionId,
          proposalId: decision.proposalId,
          businessId: decision.businessId,
          policyVersion: decision.policyVersion,
          proposalFingerprint: decision.proposalFingerprint,
          approvalBindingHash: decision.approvalBinding!.approvalBindingHash,
          financialDeltaMinor: decision.financialDeltaMinor,
          financialImpactClass: decision.financialImpactClass,
          expiresAt: decision.approvalBinding!.expiresAt,
        },
      },
    });
    return id;
  }

  /** Test helper: tamper an approval context (forged-binding tests). */
  tamperApprovalContext(governanceDecisionId: string, context: unknown): void {
    const approval = this.approvals.get(governanceDecisionId);
    if (!approval) throw new Error("fake governance: no approval to tamper");
    this.approvals.set(governanceDecisionId, { ...approval, context });
  }

  async getApprovalForDecision(input: {
    userId: number;
    governanceDecisionId: string;
  }): Promise<OptimisationApprovalView | null> {
    const approval = this.approvals.get(input.governanceDecisionId) ?? null;
    if (approval && approval.userId !== input.userId) return null;
    return approval;
  }

  async evaluateProposal(input: {
    userId: number;
    proposal: unknown;
    policyVersion?: string;
  }): Promise<{ decision: unknown; duplicateClassification: "none" | "idempotent_replay" }> {
    const proposal = this.validateProposalMaterial(input.proposal);
    const fingerprint = deriveR7FProposalFingerprint({
      proposalId: proposal.proposalId,
      businessId: proposal.businessId,
      proposalType: proposal.proposalType,
      financial: proposal.financial ? normaliseGovernanceFinancialForFingerprint(proposal.financial) : null,
      experiment: null,
      portfolio: proposal.portfolio,
      learningReference: proposal.learningReference,
      campaignId: proposal.campaignId,
      evidenceHash: proposal.evidenceHash,
    });
    const decisionId = deriveR7FGovernanceDecisionId({
      userId: input.userId,
      businessId: proposal.businessId,
      proposalId: proposal.proposalId,
      proposalType: proposal.proposalType,
      policyVersion: R7F_DEFAULT_POLICY_VERSION,
      proposalFingerprint: fingerprint,
      evidenceHash: proposal.evidenceHash,
    });
    const existing = this.decisions.get(decisionId);
    if (existing) {
      if (existing.proposalFingerprint !== fingerprint) {
        throw new BudgetPortfolioValidationError("GOVERNANCE_REPLAY_CONFLICT", "conflicting replay (tampered proposal)");
      }
      return { decision: existing, duplicateClassification: "idempotent_replay" };
    }

    const evaluated = this.evaluateDefaultPolicy({
      userId: input.userId,
      proposal,
      fingerprint,
      decisionId,
      now: new Date().toISOString(),
    });
    this.decisions.set(decisionId, evaluated);
    return { decision: evaluated, duplicateClassification: "none" };
  }

  assertActionExecutable(input: {
    decision: GovernanceDecisionView;
    approval: OptimisationApprovalView | null;
    currentPolicyVersion: string | null;
    now: string;
  }): OptimisationActionExecutionVerdict {
    const { decision, approval, currentPolicyVersion, now } = input;
    const nowMs = Date.parse(now);
    if (Number.isNaN(nowMs)) {
      return { executable: false, reason: "MALFORMED_PROPOSAL", permanent: false };
    }
    if (decision.decision === "ALLOW") {
      if (currentPolicyVersion !== decision.policyVersion) {
        return { executable: false, reason: "STALE_POLICY_VERSION", permanent: false };
      }
      if (decision.validUntil !== null && Date.parse(decision.validUntil) <= nowMs) {
        return { executable: false, reason: "EXPIRED_DECISION", permanent: false };
      }
      return {
        executable: true,
        authorization: {
          governanceDecisionId: decision.governanceDecisionId,
          proposalId: decision.proposalId,
          decision: "ALLOW",
          approvalRequestId: null,
          policyVersion: decision.policyVersion ?? "",
          authorizedAt: now,
          expiresAt: decision.validUntil ?? "",
        },
      };
    }
    if (decision.decision === "BLOCK") {
      return {
        executable: false,
        reason: decision.reasonCodes[0] ?? "ACTION_PROHIBITED_BY_POLICY",
        permanent: false,
      };
    }
    if (approval === null) return { executable: false, reason: "APPROVAL_NOT_FOUND", permanent: false };
    if (approval.status === "pending") return { executable: false, reason: "APPROVAL_PENDING", permanent: false };
    if (approval.status === "rejected") {
      return { executable: false, reason: "APPROVAL_REJECTED_BY_HUMAN", permanent: true };
    }
    if (approval.status === "edited") {
      return { executable: false, reason: "APPROVAL_BINDING_MISMATCH", permanent: false };
    }
    if (approval.userId !== decision.userId) {
      return { executable: false, reason: "APPROVAL_BINDING_MISMATCH", permanent: false };
    }
    const binding = (approval.context as Record<string, unknown> | null)?.optimisationGovernanceBinding as
      | Record<string, unknown>
      | undefined;
    if (
      !binding ||
      binding.governanceDecisionId !== decision.governanceDecisionId ||
      binding.policyVersion !== decision.policyVersion
    ) {
      return { executable: false, reason: "APPROVAL_BINDING_MISMATCH", permanent: false };
    }
    const expectedHash = deriveR7FApprovalBindingHash({
      governanceDecisionId: decision.governanceDecisionId,
      policyVersion: decision.policyVersion ?? "",
      proposalFingerprint: decision.proposalFingerprint,
    });
    if (binding.approvalBindingHash !== expectedHash) {
      return { executable: false, reason: "APPROVAL_BINDING_MISMATCH", permanent: false };
    }
    if (binding.proposalFingerprint !== decision.proposalFingerprint) {
      return { executable: false, reason: "APPROVAL_BINDING_MISMATCH", permanent: false };
    }
    if (currentPolicyVersion !== decision.policyVersion) {
      return { executable: false, reason: "STALE_POLICY_VERSION", permanent: false };
    }
    if (Date.parse(binding.expiresAt as string) <= nowMs) {
      return { executable: false, reason: "EXPIRED_APPROVAL", permanent: false };
    }
    return {
      executable: true,
      authorization: {
        governanceDecisionId: decision.governanceDecisionId,
        proposalId: decision.proposalId,
        decision: "REVIEW_REQUIRED",
        approvalRequestId: approval.id,
        policyVersion: decision.policyVersion ?? "",
        authorizedAt: now,
        expiresAt: binding.expiresAt as string,
      },
    };
  }

  // ── internals ──

  private validateProposalMaterial(raw: unknown): {
    proposalId: string;
    businessId: number;
    proposalType: string;
    campaignId: number | null;
    financial: {
      currency: string;
      allocationDeltas: FakeFinancialDelta[];
      advisoryFinancialClass: string | null;
    } | null;
    portfolio: { resultingAllocations?: Record<string, number> } | null;
    learningReference: { learningVersion: string; computedAt: string } | null;
    evidenceHash: string;
    requestedAt: string;
  } {
    function fail(message: string): never {
      throw new BudgetPortfolioValidationError("MALFORMED_INPUT", `governance rejected proposal material: ${message}`);
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail("proposal must be an object");
    const r = raw as Record<string, unknown>;
    for (const key of FORBIDDEN_CLIENT_AUTHORITY_FIELDS) {
      if (key in r) {
        throw new BudgetPortfolioValidationError(
          "CLIENT_AUTHORITY_FIELD_REJECTED",
          `Field "${key}" is server-side authority and must never be client-supplied.`
        );
      }
    }
    if (typeof r.proposalId !== "string" || !PROPOSAL_ID_PATTERN.test(r.proposalId)) fail("proposalId invalid");
    if (typeof r.businessId !== "number" || !Number.isInteger(r.businessId) || r.businessId <= 0) fail("businessId invalid");
    if (typeof r.proposalType !== "string" || r.proposalType.trim().length === 0 || r.proposalType.length > 32) {
      fail("proposalType invalid");
    }
    if (typeof r.evidenceHash !== "string" || r.evidenceHash.trim().length === 0 || r.evidenceHash.length > 128) {
      fail("evidenceHash invalid");
    }
    if (!isIsoUtc(r.requestedAt)) fail("requestedAt must be explicit ISO 8601 UTC");
    const campaignId =
      r.campaignId === null || r.campaignId === undefined
        ? null
        : typeof r.campaignId === "number" && Number.isInteger(r.campaignId) && r.campaignId > 0
          ? r.campaignId
          : fail("campaignId must be a positive integer or null");
    let financial: {
      currency: string;
      allocationDeltas: FakeFinancialDelta[];
      advisoryFinancialClass: string | null;
    } | null = null;
    if (r.financial !== null && r.financial !== undefined) {
      const f = r.financial as Record<string, unknown>;
      if (typeof f.currency !== "string" || !/^[A-Z]{3}$/.test(f.currency)) fail("financial.currency invalid");
      if (!Array.isArray(f.allocationDeltas)) fail("financial.allocationDeltas must be an array");
      const deltas: FakeFinancialDelta[] = [];
      for (const d of f.allocationDeltas) {
        const delta = d as Record<string, unknown>;
        if (typeof delta.allocationKey !== "string" || !R7F_ALLOCATION_KEY_PATTERN.test(delta.allocationKey)) {
          fail("allocationKey invalid");
        }
        if (typeof delta.deltaMinor !== "number" || !Number.isInteger(delta.deltaMinor)) {
          fail("deltaMinor must be an integer");
        }
        deltas.push({
          allocationKey: delta.allocationKey,
          campaignId:
            typeof delta.campaignId === "number" && Number.isInteger(delta.campaignId) && delta.campaignId > 0
              ? delta.campaignId
              : null,
          provider: typeof delta.provider === "string" ? delta.provider : null,
          deltaMinor: delta.deltaMinor,
          newCommitment: delta.newCommitment === true,
          irreversibleExternalSpend: delta.irreversibleExternalSpend === true,
        });
      }
      financial = { currency: f.currency, allocationDeltas: deltas, advisoryFinancialClass: null };
    }
    let portfolio: { resultingAllocations?: Record<string, number> } | null = null;
    if (r.portfolio !== null && r.portfolio !== undefined) {
      const p = r.portfolio as Record<string, unknown>;
      portfolio = { resultingAllocations: p.resultingAllocations as Record<string, number> | undefined };
    }
    let learningReference: { learningVersion: string; computedAt: string } | null = null;
    if (r.learningReference !== null && r.learningReference !== undefined) {
      const lr = r.learningReference as Record<string, unknown>;
      if (typeof lr.learningVersion !== "string" || lr.learningVersion.trim().length === 0) fail("learningReference.learningVersion invalid");
      if (!isIsoUtc(lr.computedAt)) fail("learningReference.computedAt must be ISO");
      learningReference = { learningVersion: lr.learningVersion, computedAt: lr.computedAt };
    }
    return {
      proposalId: r.proposalId,
      businessId: r.businessId,
      proposalType: r.proposalType,
      campaignId,
      financial,
      portfolio,
      learningReference,
      evidenceHash: r.evidenceHash,
      requestedAt: r.requestedAt,
    };
  }

  private evaluateDefaultPolicy(input: {
    userId: number;
    proposal: ReturnType<FakeDefaultPolicyGovernancePort["validateProposalMaterial"]>;
    fingerprint: string;
    decisionId: string;
    now: string;
  }): GovernanceDecisionView {
    const { proposal, fingerprint, decisionId } = input;
    const now = input.now;
    const policy = R7F_DEFAULT_POLICY;
    const reasons: string[] = [];
    const authority = this.authority;

    const actionType = proposal.proposalType;
    const KNOWN_TYPES = new Set([
      "LEARNING_PROMOTION",
      "EXPERIMENT_CREATE",
      "EXPERIMENT_ACTIVATE",
      "EXPERIMENT_STOP",
      "BUDGET_REALLOCATE",
      "BUDGET_INCREASE",
      "BUDGET_DECREASE",
      "CHANNEL_REALLOCATE",
      "AUDIENCE_REALLOCATE",
      "CAMPAIGN_PRIORITY_CHANGE",
      "STRATEGY_RECOMMENDATION",
    ]);

    // Risk: base by action, raised (never lowered) by injection suspicion.
    const baseRisk: Record<string, number> = {
      LEARNING_PROMOTION: 0,
      STRATEGY_RECOMMENDATION: 0,
      EXPERIMENT_STOP: 0,
      BUDGET_REALLOCATE: 1,
      BUDGET_DECREASE: 1,
      CHANNEL_REALLOCATE: 1,
      AUDIENCE_REALLOCATE: 1,
      CAMPAIGN_PRIORITY_CHANGE: 1,
      EXPERIMENT_CREATE: 1,
      EXPERIMENT_ACTIVATE: 1,
      BUDGET_INCREASE: 2,
    };
    let riskOrdinal = KNOWN_TYPES.has(actionType) ? (baseRisk[actionType] ?? 1) : 3;
    const strings: string[] = [];
    const collect = (v: unknown): void => {
      if (typeof v === "string") strings.push(v);
      else if (Array.isArray(v)) v.forEach(collect);
      else if (typeof v === "object" && v !== null) Object.values(v).forEach(collect);
    };
    collect({
      proposalId: proposal.proposalId,
      financial: proposal.financial,
      portfolio: proposal.portfolio,
      learningReference: proposal.learningReference,
      evidenceHash: proposal.evidenceHash,
    });
    const injectionSuspect = strings.some((s) => INJECTION_PATTERNS.some((p) => p.test(s)));
    if (injectionSuspect) riskOrdinal = Math.max(riskOrdinal, 2);
    const riskTier = (["low", "medium", "high", "critical"] as const)[Math.min(riskOrdinal, 3)];

    const nowMs = Date.parse(now);
    const deltas = proposal.financial?.allocationDeltas ?? [];
    const totalDeltaMinor = deltas.reduce((s, d) => s + d.deltaMinor, 0);
    const grossMovementMinor = deltas.reduce((s, d) => s + Math.abs(d.deltaMinor), 0);

    let decision: R7FGovernanceDecision;
    if (!KNOWN_TYPES.has(actionType)) {
      decision = "BLOCK";
      reasons.push("UNKNOWN_OPTIMISATION_ACTION_TYPE");
    } else if (nowMs - Date.parse(authority.stateCapturedAt) > policy.financial.staleBudgetStateMs) {
      decision = "BLOCK";
      reasons.push("STALE_BUDGET_STATE");
    } else if (
      deltas.some((d) => d.deltaMinor < 0 && authority.lockedAllocationKeys.includes(d.allocationKey))
    ) {
      decision = "BLOCK";
      reasons.push("REALLOCATION_SOURCE_LOCKED");
    } else if (deltas.some((d) => d.provider !== null && !authority.supportedProviders.includes(d.provider))) {
      decision = "BLOCK";
      reasons.push("UNSUPPORTED_PROVIDER");
    } else if (authority.committedMinor + totalDeltaMinor < 0) {
      decision = "BLOCK";
      reasons.push("MALFORMED_PROPOSAL");
    } else {
      // Financial dimension (REALLOCATION_WITHIN_APPROVED_TOTAL for moves).
      if (totalDeltaMinor > 0) {
        reasons.push("TOTAL_BUDGET_INCREASE_REQUIRES_APPROVAL");
        reasons.push("AUTONOMOUS_TOTAL_BUDGET_INCREASE_FORBIDDEN");
      }
      if (grossMovementMinor > policy.financial.autonomousReallocationCapMinor) {
        reasons.push("REALLOCATION_EXCEEDS_AUTONOMOUS_CAP");
      }
      if (
        authority.approvedTotalBudgetMinor > 0 &&
        grossMovementMinor / authority.approvedTotalBudgetMinor > policy.financial.maxAutonomousReallocationFraction
      ) {
        reasons.push("REALLOCATION_EXCEEDS_FRACTION_LIMIT");
      }
      // Portfolio dimension.
      const resulting: Record<string, number> = { ...authority.currentAllocations };
      for (const d of deltas) {
        resulting[d.allocationKey] = (resulting[d.allocationKey] ?? 0) + d.deltaMinor;
      }
      const totalAllocated = Object.values(resulting).reduce((s, v) => s + v, 0);
      if (totalAllocated > 0) {
        for (const value of Object.values(resulting)) {
          if (value / totalAllocated > policy.portfolio.maxConcentrationFraction) {
            reasons.push("CONCENTRATION_LIMIT_EXCEEDED");
            break;
          }
        }
        for (const d of deltas) {
          if (Math.abs(d.deltaMinor) / totalAllocated > policy.portfolio.maxSingleShiftFraction) {
            reasons.push("SUDDEN_REALLOCATION_SHIFT_LIMIT");
            break;
          }
        }
      }
      for (const d of deltas) {
        const lastAt = authority.lastReallocationAtByKey[d.allocationKey];
        if (lastAt !== undefined && nowMs - Date.parse(lastAt) < policy.portfolio.minReallocationIntervalMs) {
          reasons.push("REALLOCATION_OSCILLATION_DETECTED");
          break;
        }
      }
      if (
        proposal.learningReference &&
        nowMs - Date.parse(proposal.learningReference.computedAt) > policy.portfolio.maxLearningAgeMs
      ) {
        reasons.push("STALE_LEARNING");
      }
      if (injectionSuspect) reasons.push("PROMPT_INJECTION_SUSPECTED");

      const riskDisposition =
        policy.riskDispositions[riskTier as keyof typeof policy.riskDispositions];
      const reviewWins = reasons.some((code) =>
        [
          "TOTAL_BUDGET_INCREASE_REQUIRES_APPROVAL",
          "REALLOCATION_EXCEEDS_AUTONOMOUS_CAP",
          "REALLOCATION_EXCEEDS_FRACTION_LIMIT",
          "CONCENTRATION_LIMIT_EXCEEDED",
          "SUDDEN_REALLOCATION_SHIFT_LIMIT",
          "REALLOCATION_OSCILLATION_DETECTED",
          "STALE_LEARNING",
          "APPROVAL_REQUIRED_BY_RISK",
          "HIGH_RISK_REVIEW_REQUIRED",
          "PROMPT_INJECTION_SUSPECTED",
        ].includes(code)
      );
      if (riskDisposition === "BLOCK") decision = "BLOCK";
      else if (riskDisposition === "REVIEW_REQUIRED" || reviewWins) decision = "REVIEW_REQUIRED";
      else decision = "ALLOW";
      if (decision === "BLOCK" && reasons.length === 0) reasons.push("ACTION_PROHIBITED_BY_POLICY");
    }

    const approvalRequired = decision === "REVIEW_REQUIRED";
    const validUntil =
      decision === "BLOCK" ? null : new Date(nowMs + policy.maxDecisionValidityMs).toISOString();
    const approvalBinding = approvalRequired
      ? {
          governanceDecisionId: decisionId,
          proposalId: proposal.proposalId,
          businessId: proposal.businessId,
          policyVersion: policy.policyVersion,
          proposalFingerprint: fingerprint,
          approvalBindingHash: deriveR7FApprovalBindingHash({
            governanceDecisionId: decisionId,
            policyVersion: policy.policyVersion,
            proposalFingerprint: fingerprint,
          }),
          expiresAt: validUntil!,
        }
      : null;
    if (approvalRequired && reasons.length === 0) reasons.push("APPROVAL_REQUIRED_BY_RISK");
    if (decision === "ALLOW" && reasons.length === 0) reasons.push("PROPOSAL_ALLOWED_BY_POLICY");

    const evaluationFingerprint = deriveR7FEvaluationFingerprint({
      governanceDecisionId: decisionId,
      decision,
      reasonCodes: reasons,
      riskClass: riskTier,
      financialImpactClass: "REALLOCATION_WITHIN_APPROVED_TOTAL",
      policyVersion: policy.policyVersion,
      proposalFingerprint: fingerprint,
      approvalRequired,
    });

    return Object.freeze({
      governanceDecisionId: decisionId,
      contractVersion: R7F_CONTRACT_VERSION,
      engineVersion: R7F_ENGINE_VERSION,
      userId: input.userId,
      businessId: proposal.businessId,
      proposalId: proposal.proposalId,
      proposalType: proposal.proposalType,
      campaignId: proposal.campaignId,
      policyVersion: policy.policyVersion,
      decision,
      reasonCodes: Object.freeze([...new Set(reasons)].slice(0, 8)),
      riskClass: riskTier,
      financialImpactClass:
        totalDeltaMinor > 0 ? "TOTAL_BUDGET_INCREASE" : "REALLOCATION_WITHIN_APPROVED_TOTAL",
      financialDeltaMinor: totalDeltaMinor,
      approvalRequired,
      approvalBinding,
      evidenceHash: proposal.evidenceHash,
      proposalFingerprint: fingerprint,
      validUntil,
      evaluatedAt: now,
      evaluationFingerprint,
      thresholds: Object.freeze({
        autonomousReallocationCapMinor: policy.financial.autonomousReallocationCapMinor,
        maxAutonomousReallocationFraction: policy.financial.maxAutonomousReallocationFraction,
        maxConcentrationFraction: policy.portfolio.maxConcentrationFraction,
        maxSingleShiftFraction: policy.portfolio.maxSingleShiftFraction,
        minReallocationIntervalMs: policy.portfolio.minReallocationIntervalMs,
        staleBudgetStateMs: policy.financial.staleBudgetStateMs,
      }),
    });
  }
}
