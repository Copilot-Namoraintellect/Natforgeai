// ─── R7-F Optimisation Governance — pure decision engine ───
//
//   optimisation proposal
//   + business policy (versioned, server-side)
//   + budget authority snapshot (server-resolved)
//   + portfolio authority snapshot (server-resolved)
//   + experiment authority snapshot (server-resolved)
//   + risk classification (server-derived)
//   -> immutable governance decision (ALLOW / REVIEW_REQUIRED / BLOCK)
//
// Guarantees:
// - fail closed on unknown action types, missing/stale policy, ownership
//   mismatch, cross-tenant proposals, stale budget state, prohibited
//   experiment dimensions, protected traits, locked/reserved funds,
//   unsupported providers and stale learning;
// - authority only ever narrows: each dimension may reduce the disposition,
//   none may widen it (F7);
// - social/model/agent content is inert proposal material — injection
//   suspicion only ever raises risk, never widens authority;
// - deterministic decision identity: one proposal material + one policy
//   version -> one stable governanceDecisionId; retries converge;
// - no clock access (caller supplies `now`), no side effects: nothing is
//   charged, sent, reserved, executed or persisted here.

import {
  deriveApprovalBindingHash,
  deriveEvaluationFingerprint,
  deriveGovernanceDecisionId,
  deriveProposalFingerprint,
  GOVERNANCE_DECISION_AUTONOMY_RANK,
  isIsoUtc,
  isOptimisationFinancialImpactClass,
  MAX_GOVERNANCE_REASON_CODES,
  OPTIMISATION_GOVERNANCE_CONTRACT_VERSION,
  OPTIMISATION_GOVERNANCE_ENGINE_VERSION,
  OptimisationGovernanceInputError,
  OptimisationGovernanceValidationError,
  type OptimisationGovernanceErrorCode,
  type OptimisationFinancialImpactClass,
  type OptimisationGovernanceDecision as GovernanceDecisionOutcome,
  type OptimisationGovernanceReasonCode,
  type OptimisationRiskTier,
  CURRENCY_PATTERN,
  PROPOSAL_ID_PATTERN,
  ALLOCATION_KEY_PATTERN,
} from "./optimisation-governance-contract";
import {
  isOptimisationActionType,
  type OptimisationActionType,
} from "./optimisation-action-taxonomy";
import type { OptimisationGovernancePolicy } from "./optimisation-policy";
import {
  deriveFinancialImpactClass,
  evaluateOptimisationFinancialGovernance,
  FINANCIAL_IMPACT_SEVERITY,
  type OptimisationAllocationDelta,
  type OptimisationBudgetAuthoritySnapshot,
  type OptimisationProposalFinancial,
} from "./optimisation-financial-governance";
import {
  evaluateOptimisationExperimentGovernance,
  validateOptimisationProposalExperiment,
  type OptimisationExperimentAuthoritySnapshot,
  type OptimisationProposalExperiment,
} from "./optimisation-experiment-governance";
import {
  evaluateOptimisationPortfolioGovernance,
  type OptimisationPortfolioAuthoritySnapshot,
} from "./optimisation-portfolio-governance";

// ─── Proposal contract (validated evaluation input) ───

/** Independent human-reviewable reference to learning evidence (optional). */
export interface OptimisationLearningReference {
  readonly learningVersion: string;
  readonly computedAt: string;
}

/**
 * The canonical optimisation proposal. Clients (R7 agents) supply material
 * only: NO decision, risk class, financial impact class, reason codes,
 * approval state or policy content. Any such field fails closed at build.
 */
export interface OptimisationProposal {
  readonly proposalId: string;
  readonly businessId: number;
  /** Closed taxonomy type; unknown values flow through and are BLOCKED. */
  readonly proposalType: string;
  readonly campaignId: number | null;
  readonly financial: OptimisationProposalFinancial | null;
  readonly experiment: OptimisationProposalExperiment | null;
  readonly portfolio: { readonly resultingAllocations?: Readonly<Record<string, number>> } | null;
  readonly learningReference: OptimisationLearningReference | null;
  /** Opaque fingerprint of the upstream evidence bundle this proposal cites. */
  readonly evidenceHash: string;
  readonly requestedAt: string;
}

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

function fail(code: OptimisationGovernanceErrorCode, message: string): never {
  throw new OptimisationGovernanceInputError(code, message);
}

function assertNoClientAuthorityFields(input: Record<string, unknown>): void {
  for (const key of FORBIDDEN_CLIENT_AUTHORITY_FIELDS) {
    if (key in input) {
      throw new OptimisationGovernanceValidationError(
        "CLIENT_AUTHORITY_FIELD_REJECTED",
        `Field "${key}" is server-side authority and must never be client-supplied.`
      );
    }
  }
}

function assertNullablePositiveInt(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    fail("MALFORMED_PROPOSAL", `${field} must be a positive integer or null`);
  }
  return value;
}

function assertIso(value: unknown, field: string): string {
  if (typeof value !== "string" || !isIsoUtc(value)) {
    fail("MALFORMED_PROPOSAL", `${field} must be an explicit ISO 8601 UTC timestamp`);
  }
  return value;
}

function validateFinancial(raw: unknown): OptimisationProposalFinancial | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    fail("MALFORMED_PROPOSAL", "financial must be an object or null");
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.currency !== "string" || !CURRENCY_PATTERN.test(r.currency)) {
    fail("MALFORMED_PROPOSAL", "financial.currency must be a 3-letter uppercase code");
  }
  if (!Array.isArray(r.allocationDeltas)) {
    fail("MALFORMED_PROPOSAL", "financial.allocationDeltas must be an array");
  }
  const deltas: OptimisationAllocationDelta[] = [];
  for (const d of r.allocationDeltas) {
    if (typeof d !== "object" || d === null) fail("MALFORMED_PROPOSAL", "allocation delta must be an object");
    const delta = d as Record<string, unknown>;
    if (typeof delta.allocationKey !== "string" || !ALLOCATION_KEY_PATTERN.test(delta.allocationKey)) {
      fail("MALFORMED_PROPOSAL", `allocationKey must match ${ALLOCATION_KEY_PATTERN}`);
    }
    const campaignId = assertNullablePositiveInt(delta.campaignId, "allocationDelta.campaignId");
    if (delta.provider !== null && delta.provider !== undefined) {
      if (typeof delta.provider !== "string" || delta.provider.trim().length === 0 || delta.provider.length > 32) {
        fail("MALFORMED_PROPOSAL", "allocationDelta.provider must be a non-blank string <= 32 chars or null");
      }
    }
    if (typeof delta.deltaMinor !== "number" || !Number.isInteger(delta.deltaMinor)) {
      fail("MALFORMED_PROPOSAL", "allocationDelta.deltaMinor must be an integer number of minor units");
    }
    if (
      delta.newCommitment !== undefined &&
      delta.newCommitment !== null &&
      typeof delta.newCommitment !== "boolean"
    ) {
      fail("MALFORMED_PROPOSAL", "allocationDelta.newCommitment must be a boolean when present");
    }
    if (
      delta.irreversibleExternalSpend !== undefined &&
      delta.irreversibleExternalSpend !== null &&
      typeof delta.irreversibleExternalSpend !== "boolean"
    ) {
      fail("MALFORMED_PROPOSAL", "allocationDelta.irreversibleExternalSpend must be a boolean when present");
    }
    deltas.push({
      allocationKey: delta.allocationKey,
      campaignId,
      provider: (delta.provider as string | null | undefined) ?? null,
      deltaMinor: delta.deltaMinor,
      newCommitment: delta.newCommitment === true,
      irreversibleExternalSpend: delta.irreversibleExternalSpend === true,
    });
  }
  let advisoryFinancialClass: OptimisationFinancialImpactClass | null = null;
  if (r.advisoryFinancialClass !== null && r.advisoryFinancialClass !== undefined) {
    if (!isOptimisationFinancialImpactClass(r.advisoryFinancialClass)) {
      fail("MALFORMED_PROPOSAL", "financial.advisoryFinancialClass is not a known financial impact class");
    }
    advisoryFinancialClass = r.advisoryFinancialClass;
  }
  return {
    currency: r.currency,
    allocationDeltas: Object.freeze(deltas),
    advisoryFinancialClass,
  };
}

/**
 * Validate and normalise raw proposal input. Throws
 * OptimisationGovernanceValidationError / OptimisationGovernanceInputError on
 * any malformed or authority-smuggling input (fail closed). An unknown
 * proposalType string is NOT rejected here — the engine BLOCKs it as a
 * governed decision so the attempt is durably auditable.
 */
export function buildOptimisationProposal(raw: unknown): OptimisationProposal {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail("MALFORMED_PROPOSAL", "proposal must be a structured object");
  }
  const r = raw as Record<string, unknown>;
  assertNoClientAuthorityFields(r);

  if (typeof r.proposalId !== "string" || !PROPOSAL_ID_PATTERN.test(r.proposalId)) {
    fail("MALFORMED_PROPOSAL", `proposalId must match ${PROPOSAL_ID_PATTERN}`);
  }
  if (typeof r.businessId !== "number" || !Number.isInteger(r.businessId) || r.businessId <= 0) {
    fail("MALFORMED_PROPOSAL", "businessId must be a positive integer");
  }
  if (typeof r.proposalType !== "string" || r.proposalType.trim().length === 0 || r.proposalType.length > 32) {
    fail("MALFORMED_PROPOSAL", "proposalType must be a non-blank string <= 32 chars");
  }
  if (typeof r.evidenceHash !== "string" || r.evidenceHash.trim().length === 0 || r.evidenceHash.length > 128) {
    fail("MALFORMED_PROPOSAL", "evidenceHash must be a non-blank string <= 128 chars");
  }
  const campaignId = assertNullablePositiveInt(r.campaignId, "campaignId");
  const learningReference =
    r.learningReference === null || r.learningReference === undefined
      ? null
      : (() => {
          if (typeof r.learningReference !== "object") {
            fail("MALFORMED_PROPOSAL", "learningReference must be an object or null");
          }
          const lr = r.learningReference as Record<string, unknown>;
          if (typeof lr.learningVersion !== "string" || lr.learningVersion.trim().length === 0 || lr.learningVersion.length > 64) {
            fail("MALFORMED_PROPOSAL", "learningReference.learningVersion must be a non-blank string <= 64 chars");
          }
          return {
            learningVersion: lr.learningVersion.trim(),
            computedAt: assertIso(lr.computedAt, "learningReference.computedAt"),
          };
        })();

  return Object.freeze({
    proposalId: r.proposalId,
    businessId: r.businessId,
    proposalType: r.proposalType,
    campaignId,
    financial: validateFinancial(r.financial),
    experiment:
      r.experiment === null || r.experiment === undefined
        ? null
        : validateOptimisationProposalExperiment(r.experiment),
    portfolio:
      r.portfolio === null || r.portfolio === undefined
        ? null
        : (() => {
            if (typeof r.portfolio !== "object") {
              fail("MALFORMED_PROPOSAL", "portfolio must be an object or null");
            }
            const pr = r.portfolio as Record<string, unknown>;
            if (pr.resultingAllocations !== undefined && pr.resultingAllocations !== null) {
              if (typeof pr.resultingAllocations !== "object" || Array.isArray(pr.resultingAllocations)) {
                fail("MALFORMED_PROPOSAL", "portfolio.resultingAllocations must be an object or null");
              }
              for (const [key, value] of Object.entries(pr.resultingAllocations as Record<string, unknown>)) {
                if (key.trim().length === 0 || !Number.isInteger(value) || (value as number) < 0) {
                  fail("MALFORMED_PROPOSAL", "portfolio.resultingAllocations values must be non-negative integers");
                }
              }
            }
            return { resultingAllocations: pr.resultingAllocations as Record<string, number> | undefined };
          })(),
    learningReference,
    evidenceHash: r.evidenceHash,
    requestedAt: assertIso(r.requestedAt, "requestedAt"),
  });
}

// ─── Business authority (server-resolved ownership) ───

export interface OptimisationBusinessAuthority {
  readonly businessId: number;
  readonly owningUserId: number;
  readonly businessActive: boolean;
}

// ─── The durable, immutable governance decision (F1) ───

export interface OptimisationGovernanceApprovalBinding {
  readonly governanceDecisionId: string;
  readonly proposalId: string;
  readonly businessId: number;
  readonly policyVersion: string;
  readonly proposalFingerprint: string;
  readonly approvalBindingHash: string;
  readonly expiresAt: string;
}

export interface OptimisationGovernanceDecision {
  readonly governanceDecisionId: string;
  readonly contractVersion: string;
  readonly engineVersion: string;
  readonly userId: number;
  readonly businessId: number;
  readonly proposalId: string;
  readonly proposalType: string;
  readonly campaignId: number | null;
  readonly policyVersion: string | null;
  readonly decision: GovernanceDecisionOutcome;
  readonly reasonCodes: readonly OptimisationGovernanceReasonCode[];
  readonly riskClass: OptimisationRiskTier;
  readonly financialImpactClass: OptimisationFinancialImpactClass;
  readonly financialDeltaMinor: number;
  readonly approvalRequired: boolean;
  readonly approvalBinding: OptimisationGovernanceApprovalBinding | null;
  readonly evidenceHash: string;
  readonly proposalFingerprint: string;
  readonly validUntil: string | null;
  readonly evaluatedAt: string;
  readonly evaluationFingerprint: string;
  readonly thresholds: Readonly<Record<string, number>>;
}

export interface OptimisationGovernanceEvaluationInput {
  readonly proposal: OptimisationProposal;
  readonly userId: number;
  /** Server-resolved policy; null = missing -> fail closed. */
  readonly policy: OptimisationGovernancePolicy | null;
  /** The policy version the caller asserts is current (staleness gate). */
  readonly currentPolicyVersion: string;
  readonly businessAuthority: OptimisationBusinessAuthority;
  readonly budget: OptimisationBudgetAuthoritySnapshot;
  readonly portfolio: OptimisationPortfolioAuthoritySnapshot;
  readonly experiment: OptimisationExperimentAuthoritySnapshot;
  readonly now: string;
}

// ─── Prompt-injection hygiene (model/agent output is inert material) ───

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

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const v of Object.values(value)) collectStrings(v, out);
  }
}

function detectInjectionSuspect(proposal: OptimisationProposal): boolean {
  const strings: string[] = [];
  collectStrings(
    {
      proposalId: proposal.proposalId,
      financial: proposal.financial,
      experiment: proposal.experiment,
      portfolio: proposal.portfolio,
      learningReference: proposal.learningReference,
      evidenceHash: proposal.evidenceHash,
    },
    strings
  );
  return strings.some((s) => INJECTION_PATTERNS.some((pattern) => pattern.test(s)));
}

// ─── Risk classification ───

const RISK_TIER_BY_ORDINAL: readonly OptimisationRiskTier[] = ["low", "medium", "high", "critical"];

function severityFloorTier(financialClass: OptimisationFinancialImpactClass): number {
  switch (financialClass) {
    case "RECOMMENDATION_ONLY":
      return 0;
    case "REALLOCATION_WITHIN_APPROVED_TOTAL":
      return 1;
    case "TOTAL_BUDGET_INCREASE":
      return 2;
    case "NEW_FINANCIAL_COMMITMENT":
      return 3;
    case "IRREVERSIBLE_EXTERNAL_SPEND":
      return 3;
  }
}

// ─── Evaluation ───

function weakest(
  a: GovernanceDecisionOutcome,
  b: GovernanceDecisionOutcome
): GovernanceDecisionOutcome {
  return GOVERNANCE_DECISION_AUTONOMY_RANK[a] <= GOVERNANCE_DECISION_AUTONOMY_RANK[b] ? a : b;
}

/**
 * Evaluate one optimisation proposal. Pure and deterministic: identical
 * inputs produce a byte-identical decision (same id, same reasons, same
 * fingerprint). No dimension may widen authority; every gate only narrows.
 */
export function evaluateOptimisationGovernance(
  input: OptimisationGovernanceEvaluationInput
): OptimisationGovernanceDecision {
  const nowMs = Date.parse(input.now);
  if (Number.isNaN(nowMs)) {
    throw new OptimisationGovernanceValidationError(
      "INVALID_EVALUATION_CLOCK",
      `now must be a valid ISO timestamp, got ${String(input.now)}`
    );
  }
  if (!Number.isInteger(input.userId) || input.userId <= 0) {
    fail("MALFORMED_PROPOSAL", `userId must be a positive integer, got ${String(input.userId)}`);
  }
  const proposal = input.proposal;
  const proposalFingerprint = deriveProposalFingerprint(proposal);
  const policyVersion = input.policy?.policyVersion ?? null;

  const baseIdentity = {
    userId: input.userId,
    businessId: proposal.businessId,
    proposalId: proposal.proposalId,
    proposalType: proposal.proposalType,
    policyVersion: policyVersion ?? "NO_POLICY",
    proposalFingerprint,
    evidenceHash: proposal.evidenceHash,
  };

  const finalize = (args: {
    decision: GovernanceDecisionOutcome;
    reasonCodes: readonly OptimisationGovernanceReasonCode[];
    riskClass: OptimisationRiskTier;
    financialImpactClass: OptimisationFinancialImpactClass;
    financialDeltaMinor: number;
    thresholds: Readonly<Record<string, number>>;
  }): OptimisationGovernanceDecision => {
    const governanceDecisionId = deriveGovernanceDecisionId(baseIdentity);
    const approvalBinding: OptimisationGovernanceApprovalBinding | null =
      args.decision === "REVIEW_REQUIRED"
        ? Object.freeze({
            governanceDecisionId,
            proposalId: proposal.proposalId,
            businessId: proposal.businessId,
            policyVersion: policyVersion ?? fail("POLICY_MISSING", "approval requires a policy version"),
            proposalFingerprint,
            approvalBindingHash: deriveApprovalBindingHash({
              governanceDecisionId,
              policyVersion: policyVersion!,
              proposalFingerprint,
            }),
            expiresAt: new Date(
              nowMs + (input.policy?.maxDecisionValidityMs ?? 24 * 60 * 60 * 1000)
            ).toISOString(),
          })
        : null;
    const reasonCodes = Object.freeze(
      [...new Set(args.reasonCodes)].slice(0, MAX_GOVERNANCE_REASON_CODES)
    );
    const evaluationFingerprint = deriveEvaluationFingerprint({
      governanceDecisionId,
      decision: args.decision,
      reasonCodes,
      riskClass: args.riskClass,
      financialImpactClass: args.financialImpactClass,
      policyVersion,
      proposalFingerprint,
      approvalRequired: args.decision === "REVIEW_REQUIRED",
    });
    return Object.freeze({
      governanceDecisionId,
      contractVersion: OPTIMISATION_GOVERNANCE_CONTRACT_VERSION,
      engineVersion: OPTIMISATION_GOVERNANCE_ENGINE_VERSION,
      userId: input.userId,
      businessId: proposal.businessId,
      proposalId: proposal.proposalId,
      proposalType: proposal.proposalType,
      campaignId: proposal.campaignId,
      policyVersion,
      decision: args.decision,
      reasonCodes,
      riskClass: args.riskClass,
      financialImpactClass: args.financialImpactClass,
      financialDeltaMinor: args.financialDeltaMinor,
      approvalRequired: args.decision === "REVIEW_REQUIRED",
      approvalBinding,
      evidenceHash: proposal.evidenceHash,
      proposalFingerprint,
      validUntil:
        args.decision === "ALLOW" || args.decision === "REVIEW_REQUIRED"
          ? new Date(nowMs + (input.policy?.maxDecisionValidityMs ?? 24 * 60 * 60 * 1000)).toISOString()
          : null,
      evaluatedAt: input.now,
      evaluationFingerprint,
      thresholds: args.thresholds,
    });
  };

  // --- Fail-closed pre-checks -------------------------------------------------
  if (!isOptimisationActionType(proposal.proposalType)) {
    return finalize({
      decision: "BLOCK",
      reasonCodes: ["UNKNOWN_OPTIMISATION_ACTION_TYPE"],
      riskClass: "high",
      financialImpactClass: "RECOMMENDATION_ONLY",
      financialDeltaMinor: 0,
      thresholds: {},
    });
  }
  const actionType = proposal.proposalType as OptimisationActionType;

  if (input.policy === null) {
    return finalize({
      decision: "BLOCK",
      reasonCodes: ["POLICY_MISSING"],
      riskClass: "high",
      financialImpactClass: "RECOMMENDATION_ONLY",
      financialDeltaMinor: 0,
      thresholds: {},
    });
  }

  if (input.currentPolicyVersion !== input.policy.policyVersion) {
    return finalize({
      decision: "BLOCK",
      reasonCodes: ["STALE_POLICY_VERSION"],
      riskClass: "high",
      financialImpactClass: "RECOMMENDATION_ONLY",
      financialDeltaMinor: 0,
      thresholds: {},
    });
  }

  // --- Tenant / business ownership (cross-tenant proposals fail closed) -------
  if (input.businessAuthority.owningUserId !== input.userId) {
    return finalize({
      decision: "BLOCK",
      reasonCodes: ["CROSS_TENANT_PROPOSAL"],
      riskClass: "high",
      financialImpactClass: "RECOMMENDATION_ONLY",
      financialDeltaMinor: 0,
      thresholds: {},
    });
  }
  if (input.businessAuthority.businessId !== proposal.businessId) {
    return finalize({
      decision: "BLOCK",
      reasonCodes: ["OWNERSHIP_MISMATCH"],
      riskClass: "high",
      financialImpactClass: "RECOMMENDATION_ONLY",
      financialDeltaMinor: 0,
      thresholds: {},
    });
  }
  if (!input.businessAuthority.businessActive) {
    return finalize({
      decision: "BLOCK",
      reasonCodes: ["ACTION_PROHIBITED_BY_POLICY"],
      riskClass: "high",
      financialImpactClass: "RECOMMENDATION_ONLY",
      financialDeltaMinor: 0,
      thresholds: {},
    });
  }

  // --- Dimension evaluations ---------------------------------------------------
  const financial = evaluateOptimisationFinancialGovernance({
    actionType,
    financial: proposal.financial,
    policy: input.policy,
    budget: input.budget,
    now: input.now,
  });
  const experiment = evaluateOptimisationExperimentGovernance({
    actionType,
    experiment: proposal.experiment,
    policy: input.policy,
    authority: input.experiment,
    now: input.now,
  });
  const portfolio = evaluateOptimisationPortfolioGovernance({
    actionType,
    deltas: proposal.financial?.allocationDeltas ?? [],
    policy: input.policy,
    authority: input.portfolio,
    now: input.now,
  });

  // --- Stale learning cannot authorize change (AC24) ---------------------------
  const blockReasons: OptimisationGovernanceReasonCode[] = [
    ...financial.blockReasonCodes,
    ...experiment.blockReasonCodes,
    ...portfolio.blockReasonCodes,
  ];
  const reviewReasons: OptimisationGovernanceReasonCode[] = [
    ...financial.reviewReasonCodes,
    ...experiment.reviewReasonCodes,
    ...portfolio.reviewReasonCodes,
  ];
  const infoReasons: OptimisationGovernanceReasonCode[] = [...financial.infoReasonCodes];

  if (proposal.learningReference !== null) {
    if (
      nowMs - Date.parse(proposal.learningReference.computedAt) >
      input.policy.portfolio.maxLearningAgeMs
    ) {
      blockReasons.push("STALE_LEARNING");
    }
  }

  // --- Risk classification (server-side only) ----------------------------------
  let riskOrdinal = 0; // base: low
  switch (actionType) {
    case "LEARNING_PROMOTION":
    case "STRATEGY_RECOMMENDATION":
    case "EXPERIMENT_STOP":
      riskOrdinal = 0;
      break;
    case "BUDGET_REALLOCATE":
    case "BUDGET_DECREASE":
    case "CHANNEL_REALLOCATE":
    case "AUDIENCE_REALLOCATE":
    case "CAMPAIGN_PRIORITY_CHANGE":
    case "EXPERIMENT_CREATE":
    case "EXPERIMENT_ACTIVATE":
      riskOrdinal = 1;
      break;
    case "BUDGET_INCREASE":
      riskOrdinal = 2;
      break;
  }
  if (detectInjectionSuspect(proposal)) {
    riskOrdinal = Math.min(3, riskOrdinal + 2);
    infoReasons.push("PROMPT_INJECTION_SUSPECTED");
  }
  riskOrdinal = Math.max(riskOrdinal, severityFloorTier(financial.financialImpactClass));
  const riskClass: OptimisationRiskTier = RISK_TIER_BY_ORDINAL[riskOrdinal];

  // --- Compose disposition: start from risk mapping, then narrow ---------------
  let decision: GovernanceDecisionOutcome = input.policy.riskDispositions[riskClass];
  if (decision === "ALLOW" && riskClass !== "low") {
    // Defensive: policy validation should prevent this; never allow above low.
    decision = "REVIEW_REQUIRED";
  }
  if (reviewReasons.length > 0) {
    decision = weakest(decision, "REVIEW_REQUIRED");
  }
  if (blockReasons.length > 0) {
    decision = "BLOCK";
  }

  const reasonCodes: OptimisationGovernanceReasonCode[] = [];
  if (decision === "ALLOW") {
    reasonCodes.push("PROPOSAL_ALLOWED_BY_POLICY");
  } else if (decision === "REVIEW_REQUIRED") {
    reasonCodes.push(
      blockReasons.length === 0 &&
        reviewReasons.length === 0 &&
        input.policy.riskDispositions[riskClass] === "REVIEW_REQUIRED"
        ? "APPROVAL_REQUIRED_BY_RISK"
        : "FINANCIAL_IMPACT_CLASS_REQUIRES_APPROVAL"
    );
    if (riskClass === "high") reasonCodes.push("HIGH_RISK_REVIEW_REQUIRED");
  } else {
    reasonCodes.push(blockReasons[0] ?? "ACTION_PROHIBITED_BY_POLICY");
    if (riskClass === "critical") reasonCodes.push("CRITICAL_RISK_BLOCKED");
  }
  reasonCodes.push(...blockReasons, ...reviewReasons, ...infoReasons);

  const thresholds: Record<string, number> = {
    ...financial.thresholds,
  };

  return finalize({
    decision,
    reasonCodes,
    riskClass,
    financialImpactClass: financial.financialImpactClass,
    financialDeltaMinor: financial.totalDeltaMinor,
    thresholds: Object.freeze(thresholds),
  });
}

/** Severity re-export for downstream tests/consumers. */
export { FINANCIAL_IMPACT_SEVERITY, deriveFinancialImpactClass };
