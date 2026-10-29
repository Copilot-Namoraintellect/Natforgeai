// ─── R7-F Optimisation Governance — service authority ───
//
// Orchestrates one governed evaluation end to end: re-validate the proposal,
// resolve the versioned policy, fetch server-side authority snapshots
// through the provider seam (re-validated at the boundary), evaluate with
// the pure engine, persist exactly once under the durable convergence
// anchor, and emit exactly one audit event per inserted decision. Replays
// re-read the committed row and converge (zero extra events). The caller
// supplies the executor: one client/transaction spans the decision insert
// and the audit persistence.
//
// Also owns the read-only operations projection and the narrow, audited
// recovery surface (F8). Recovery NEVER mutates an immutable decision; the
// only recovery writes are closed-vocabulary audit-appended operator actions.
// This stream never executes optimisation actions, never touches billing,
// payments, providers or CRM, and never becomes the optimisation engine.

import {
  deriveGovernanceDecisionId,
  GOVERNANCE_DECISION_ID_PATTERN,
  isIsoUtc,
  OptimisationGovernanceError,
  OPTIMISATION_GOVERNANCE_CONTRACT_VERSION,
  type OptimisationRecoveryAction,
} from "./optimisation-governance-contract";
import {
  buildOptimisationProposal,
  evaluateOptimisationGovernance,
  type OptimisationGovernanceDecision,
} from "./optimisation-decision-engine";
import { getOptimisationGovernancePolicy } from "./optimisation-policy";
import {
  validateOptimisationBudgetAuthoritySnapshot,
  type OptimisationBudgetAuthoritySnapshot,
} from "./optimisation-financial-governance";
import {
  validateOptimisationPortfolioAuthoritySnapshot,
  type OptimisationPortfolioAuthoritySnapshot,
} from "./optimisation-portfolio-governance";
import {
  validateOptimisationExperimentAuthoritySnapshot,
  type OptimisationExperimentAuthoritySnapshot,
} from "./optimisation-experiment-governance";
import {
  getOptimisationGovernanceDecision,
  insertOptimisationGovernanceDecision,
  listOptimisationGovernanceDecisions,
  type OptimisationGovernanceDecisionRow,
  type OptimisationGovernanceStoreExecutor,
} from "./optimisation-governance-store";
import {
  buildOptimisationGovernanceOperationsProjection,
  type OptimisationGovernanceOperationsProjection,
} from "./optimisation-operations-projection";
import { createAuditEvent } from "../audit/audit-event";
import { persistAuditEvent, type AuditDbExecutor } from "../audit/audit-store";

// ─── Provider seam (untrusted until re-validated at the boundary) ───

/**
 * Raw upstream authority. Every payload arrives as `unknown` — the service
 * re-validates before anything consumes it. Implementations throw
 * ProviderAuthorityNotFound for absent businesses so cross-tenant/forged
 * references fail closed and indistinguishable.
 */
export interface OptimisationGovernanceAuthorityProvider {
  getBusinessAuthority(businessId: number): Promise<unknown>;
  getBudgetAuthority(businessId: number): Promise<unknown>;
  getPortfolioAuthority(businessId: number): Promise<unknown>;
  getExperimentAuthority(businessId: number): Promise<unknown>;
  /**
   * Approval-ledger lookup for the operations projection. Returns a map from
   * governanceDecisionId to the approval row status (null = no row). The
   * ledger remains the approval authority; this is a read view only.
   */
  getApprovalStatusByDecisionId?(
    userId: number,
    governanceDecisionIds: readonly string[]
  ): Promise<Readonly<Map<string, { status: "pending" | "approved" | "rejected" } | null>>>;
}

export class ProviderBusinessNotFound extends Error {
  readonly kind = "business_not_found" as const;
  constructor(businessId: number) {
    super(`business not found: ${businessId}`);
    this.name = "ProviderBusinessNotFound";
  }
}

export class ProviderAuthorityUnavailable extends Error {
  readonly kind = "authority_unavailable" as const;
  constructor(authority: string, message: string) {
    super(`${authority} authority unavailable: ${message}`);
    this.name = "ProviderAuthorityUnavailable";
  }
}

export interface OptimisationGovernanceAuthorityDeps {
  readonly provider: OptimisationGovernanceAuthorityProvider;
  /** Injected clock for determinism; defaults to wall time. */
  readonly now?: () => Date;
}

function resolveNow(deps: OptimisationGovernanceAuthorityDeps): Date {
  return deps.now ? deps.now() : new Date();
}

async function fetchBusinessAuthority(
  deps: OptimisationGovernanceAuthorityDeps,
  businessId: number
): Promise<{ businessId: number; owningUserId: number; businessActive: boolean }> {
  let raw: unknown;
  try {
    raw = await deps.provider.getBusinessAuthority(businessId);
  } catch (err) {
    if (err instanceof ProviderBusinessNotFound) {
      // Indistinguishable from absent for cross-tenant references.
      throw new OptimisationGovernanceError(
        "OWNERSHIP_MISMATCH",
        `business ${businessId} not found for this tenant`
      );
    }
    throw err;
  }
  if (typeof raw !== "object" || raw === null) {
    throw new OptimisationGovernanceError(
      "OWNERSHIP_MISMATCH",
      `business ${businessId} not found for this tenant`
    );
  }
  const r = raw as Record<string, unknown>;
  if (
    r.businessId !== businessId ||
    !Number.isInteger(r.owningUserId) ||
    typeof r.businessActive !== "boolean"
  ) {
    throw new OptimisationGovernanceError(
      "OWNERSHIP_MISMATCH",
      `business ${businessId} not found for this tenant`
    );
  }
  return {
    businessId,
    owningUserId: r.owningUserId as number,
    businessActive: r.businessActive,
  };
}

async function fetchBudgetAuthority(
  deps: OptimisationGovernanceAuthorityDeps,
  businessId: number
): Promise<OptimisationBudgetAuthoritySnapshot> {
  try {
    return validateOptimisationBudgetAuthoritySnapshot(
      await deps.provider.getBudgetAuthority(businessId)
    );
  } catch (err) {
    if (err instanceof OptimisationGovernanceError) throw err;
    throw new ProviderAuthorityUnavailable("budget", err instanceof Error ? err.message : String(err));
  }
}

async function fetchPortfolioAuthority(
  deps: OptimisationGovernanceAuthorityDeps,
  businessId: number
): Promise<OptimisationPortfolioAuthoritySnapshot> {
  try {
    return validateOptimisationPortfolioAuthoritySnapshot(
      await deps.provider.getPortfolioAuthority(businessId)
    );
  } catch (err) {
    if (err instanceof OptimisationGovernanceError) throw err;
    throw new ProviderAuthorityUnavailable(
      "portfolio",
      err instanceof Error ? err.message : String(err)
    );
  }
}

async function fetchExperimentAuthority(
  deps: OptimisationGovernanceAuthorityDeps,
  businessId: number
): Promise<OptimisationExperimentAuthoritySnapshot> {
  try {
    return validateOptimisationExperimentAuthoritySnapshot(
      await deps.provider.getExperimentAuthority(businessId)
    );
  } catch (err) {
    if (err instanceof OptimisationGovernanceError) throw err;
    throw new ProviderAuthorityUnavailable(
      "experiment",
      err instanceof Error ? err.message : String(err)
    );
  }
}

/** The service executor spans the R7-F table and the audit ledger. */
function asAuditExecutor(executor: OptimisationGovernanceStoreExecutor): AuditDbExecutor {
  return executor as unknown as AuditDbExecutor;
}

function deepFreeze<T extends object>(value: T): T {
  if (!Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) {
      if (nested !== null && typeof nested === "object") {
        deepFreeze(nested);
      }
    }
  }
  return value;
}

// ─── Evaluation ───

export interface EvaluateOptimisationGovernanceForProposalInput {
  readonly userId: number;
  readonly proposal: unknown;
  readonly policyVersion?: string;
}

export interface EvaluateOptimisationGovernanceForProposalResult {
  readonly decision: OptimisationGovernanceDecision;
  readonly duplicateClassification: "none" | "idempotent_replay";
}

/**
 * One governed evaluation. Every authority payload is untrusted until its
 * seam accepts it; every binding is recomputed, never taken from the wire.
 * Same authoritative inputs ⇒ same governanceDecisionId ⇒ durable
 * convergence (replay re-reads the stored row and emits zero events).
 */
export async function evaluateOptimisationGovernanceForProposal(
  input: EvaluateOptimisationGovernanceForProposalInput,
  deps: OptimisationGovernanceAuthorityDeps,
  executor: OptimisationGovernanceStoreExecutor
): Promise<EvaluateOptimisationGovernanceForProposalResult> {
  const now = resolveNow(deps);
  const proposal = buildOptimisationProposal(input.proposal);
  const policy = getOptimisationGovernancePolicy(input.policyVersion);

  const businessAuthority = await fetchBusinessAuthority(deps, proposal.businessId);
  const budget = await fetchBudgetAuthority(deps, proposal.businessId);
  const portfolio = await fetchPortfolioAuthority(deps, proposal.businessId);
  const experiment = await fetchExperimentAuthority(deps, proposal.businessId);

  const decision = evaluateOptimisationGovernance({
    proposal,
    userId: input.userId,
    policy,
    currentPolicyVersion: policy.policyVersion,
    businessAuthority,
    budget,
    portfolio,
    experiment,
    now: now.toISOString(),
  });

  const evaluatedAt = now.toISOString();
  const row: OptimisationGovernanceDecisionRow = deepFreeze({
    governanceDecisionId: decision.governanceDecisionId,
    contractVersion: decision.contractVersion,
    engineVersion: decision.engineVersion,
    userId: decision.userId,
    businessId: decision.businessId,
    proposalId: decision.proposalId,
    proposalType: decision.proposalType,
    campaignId: decision.campaignId,
    policyVersion: decision.policyVersion,
    decision: decision.decision,
    reasonCodes: [...decision.reasonCodes],
    riskClass: decision.riskClass,
    financialImpactClass: decision.financialImpactClass,
    financialDeltaMinor: decision.financialDeltaMinor,
    approvalRequired: decision.approvalRequired,
    approvalBinding: decision.approvalBinding,
    evidenceHash: decision.evidenceHash,
    proposalFingerprint: decision.proposalFingerprint,
    validUntil: decision.validUntil,
    evaluatedAt: decision.evaluatedAt,
    evaluationFingerprint: decision.evaluationFingerprint,
    thresholds: { ...decision.thresholds },
    createdAt: evaluatedAt,
  });

  const write = await insertOptimisationGovernanceDecision(row, executor);
  if (write.inserted) {
    // Exactly one audit event per inserted decision; replays/convergence
    // emit zero events.
    const event = createAuditEvent({
      eventType: "optimisation_governance_decision",
      source: "system",
      outcome: decision.decision === "BLOCK" ? "failed" : "succeeded",
      occurredAt: evaluatedAt,
      userId: input.userId,
      businessId: decision.businessId,
      campaignId: decision.campaignId,
      metadata: {
        governanceDecisionId: decision.governanceDecisionId,
        proposalId: decision.proposalId,
        businessId: decision.businessId,
        proposalType: decision.proposalType,
        decision: decision.decision,
        reasonCodes: [...decision.reasonCodes],
        riskClass: decision.riskClass,
        financialImpactClass: decision.financialImpactClass,
        financialDeltaMinor: decision.financialDeltaMinor,
        approvalRequired: decision.approvalRequired,
        policyVersion: decision.policyVersion,
        evidenceHash: decision.evidenceHash,
        proposalFingerprint: decision.proposalFingerprint,
        contractVersion: OPTIMISATION_GOVERNANCE_CONTRACT_VERSION,
      },
    });
    await persistAuditEvent(event, asAuditExecutor(executor));
  }

  return { decision, duplicateClassification: write.duplicateClassification };
}

// ─── Reads ───

export async function getOptimisationGovernanceDecisionForUser(
  input: { userId: number; governanceDecisionId: string },
  executor: OptimisationGovernanceStoreExecutor
): Promise<OptimisationGovernanceDecisionRow> {
  return getOptimisationGovernanceDecision(input.userId, input.governanceDecisionId, executor);
}

export async function listOptimisationGovernanceDecisionsForUser(
  input: {
    userId: number;
    businessId?: number;
    proposalId?: string;
    decision?: string;
  },
  executor: OptimisationGovernanceStoreExecutor
): Promise<OptimisationGovernanceDecisionRow[]> {
  return listOptimisationGovernanceDecisions(
    input.userId,
    { businessId: input.businessId, proposalId: input.proposalId, decision: input.decision },
    executor
  );
}

/**
 * Read-only operations projection (F8). Truthful by construction: every item
 * derives from an immutable decision row; stale/expired status is computed,
 * never stored, so the view can never drift from the decisions it projects.
 */
export async function getOptimisationGovernanceOperationsProjectionForUser(
  input: { userId: number; businessId?: number },
  deps: OptimisationGovernanceAuthorityDeps,
  executor: OptimisationGovernanceStoreExecutor
): Promise<OptimisationGovernanceOperationsProjection> {
  const now = resolveNow(deps);
  const rows = await listOptimisationGovernanceDecisions(
    input.userId,
    { businessId: input.businessId },
    executor
  );
  const policy = getOptimisationGovernancePolicy();
  const approvalMap = deps.provider.getApprovalStatusByDecisionId
    ? await deps.provider.getApprovalStatusByDecisionId(
        input.userId,
        rows.map((r) => r.governanceDecisionId)
      )
    : new Map<string, null>();
  return buildOptimisationGovernanceOperationsProjection({
    rows,
    approvalStatusByDecisionId: approvalMap,
    currentPolicyVersion: policy.policyVersion,
    now: now.toISOString(),
  });
}

// ─── Revalidation (downstream contract) ───

export interface RevalidateOptimisationGovernanceDecisionResult {
  readonly previous: OptimisationGovernanceDecisionRow;
  readonly current: OptimisationGovernanceDecision;
  readonly unchanged: boolean;
}

/**
 * Downstream contract seam: re-evaluate one previously recorded decision
 * under the CURRENT policy + authority state. The stored decision is never
 * mutated; if anything material changed, the caller receives a fresh
 * decision (which the caller may persist via a new evaluation). R7-B/C/D/E
 * must revalidate governance immediately before any material state change.
 */
export async function revalidateOptimisationGovernanceDecision(
  input: { userId: number; governanceDecisionId: string; proposal?: unknown },
  deps: OptimisationGovernanceAuthorityDeps,
  executor: OptimisationGovernanceStoreExecutor
): Promise<RevalidateOptimisationGovernanceDecisionResult> {
  const now = resolveNow(deps);
  const previous = await getOptimisationGovernanceDecision(
    input.userId,
    input.governanceDecisionId,
    executor
  );
  if (input.proposal === undefined) {
    throw new OptimisationGovernanceError(
      "MALFORMED_PROPOSAL",
      "revalidation requires the proposal material the caller intends to act on; governance is revalidated against fresh material, not against stale stored coordinates"
    );
  }
  const proposal = buildOptimisationProposal(input.proposal);
  if (
    proposal.proposalId !== previous.proposalId ||
    proposal.businessId !== previous.businessId ||
    proposal.proposalType !== previous.proposalType
  ) {
    throw new OptimisationGovernanceError(
      "OWNERSHIP_MISMATCH",
      "revalidation proposal coordinates do not match the stored decision identity"
    );
  }
  const policy = getOptimisationGovernancePolicy();

  const businessAuthority = await fetchBusinessAuthority(deps, previous.businessId);
  const budget = await fetchBudgetAuthority(deps, previous.businessId);
  const portfolio = await fetchPortfolioAuthority(deps, previous.businessId);
  const experiment = await fetchExperimentAuthority(deps, previous.businessId);

  const current = evaluateOptimisationGovernance({
    proposal,
    userId: input.userId,
    policy,
    currentPolicyVersion: policy.policyVersion,
    businessAuthority,
    budget,
    portfolio,
    experiment,
    now: now.toISOString(),
  });

  const unchanged =
    current.governanceDecisionId === previous.governanceDecisionId &&
    current.evaluationFingerprint === previous.evaluationFingerprint;

  return { previous, current, unchanged };
}

// ─── Narrow recovery (F8) ───

export interface RecordOptimisationGovernanceRecoveryResult {
  readonly governanceDecisionId: string;
  readonly action: OptimisationRecoveryAction;
  readonly recordedAt: string;
}

/**
 * Narrow recovery: record a closed-vocabulary operator action against an
 * existing decision. AUDIT-ONLY — the immutable decision row is never
 * mutated and no execution state changes. There is deliberately no
 * forceAllow/forceComplete/setApproved/overridePolicy anywhere in this
 * stream: the only "recovery" is truthful operator acknowledgement.
 */
export async function recordOptimisationGovernanceRecovery(
  input: {
    userId: number;
    governanceDecisionId: string;
    action: OptimisationRecoveryAction;
    note: string;
  },
  deps: OptimisationGovernanceAuthorityDeps,
  executor: OptimisationGovernanceStoreExecutor
): Promise<RecordOptimisationGovernanceRecoveryResult> {
  if (!GOVERNANCE_DECISION_ID_PATTERN.test(input.governanceDecisionId)) {
    throw new OptimisationGovernanceError(
      "GOVERNANCE_DECISION_NOT_FOUND",
      `governance decision ${input.governanceDecisionId} not found`
    );
  }
  const row = await getOptimisationGovernanceDecision(
    input.userId,
    input.governanceDecisionId,
    executor
  );
  const now = resolveNow(deps);
  const recordedAt = now.toISOString();
  if (!isIsoUtc(recordedAt)) {
    throw new OptimisationGovernanceError("INVALID_EVALUATION_CLOCK", "clock produced a non-ISO timestamp");
  }
  const event = createAuditEvent({
    eventType: "optimisation_governance_recovery",
    source: "admin",
    outcome: "succeeded",
    occurredAt: recordedAt,
    userId: input.userId,
    businessId: row.businessId,
    campaignId: row.campaignId,
    metadata: {
      governanceDecisionId: row.governanceDecisionId,
      proposalId: row.proposalId,
      businessId: row.businessId,
      decision: row.decision,
      action: input.action,
      note: input.note.slice(0, 500),
    },
  });
  await persistAuditEvent(event, asAuditExecutor(executor));
  return {
    governanceDecisionId: row.governanceDecisionId,
    action: input.action,
    recordedAt,
  };
}

// ─── Deterministic decision id re-export for consumers ───
export { deriveGovernanceDecisionId };
