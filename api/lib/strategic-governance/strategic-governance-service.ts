// ─── R8-F Strategic Intelligence Governance — service authority ───
//
// Orchestrates one governed evaluation end to end: re-validate the proposal,
// resolve the versioned policy, fetch server-side authority (business
// ownership, per-evidence canonical resolutions, trusted-source registry)
// through the provider seam (re-validated at the boundary), evaluate with the
// pure engine, persist exactly once under the durable convergence anchor, and
// emit exactly one audit event per inserted decision. Replays re-read the
// committed row and converge (zero extra events). The caller supplies the
// executor: one client/transaction spans the decision insert and the audit
// persistence.
//
// Also owns the read-only operations projection, the narrow audited recovery
// surface (F8), the downstream revalidation seam, and the OTP-bound human
// review resolution surface (F5). Recovery NEVER mutates an immutable
// decision; the only recovery writes are closed-vocabulary audit-appended
// operator actions. This stream never executes strategic recommendations,
// never touches campaigns, strategy, budgets, Business DNA, billing,
// payments, providers or CRM, and never becomes the strategic-reasoning
// engine (charter F7).

import {
  deriveGovernanceDecisionId,
  GOVERNANCE_DECISION_ID_PATTERN,
  isIsoUtc,
  StrategicGovernanceError,
  STRATEGIC_GOVERNANCE_CONTRACT_VERSION,
  type StrategicRecoveryAction,
} from "./strategic-governance-contract";
import {
  buildStrategicProposal,
  evaluateStrategicGovernance,
  type StrategicGovernanceDecision,
} from "./strategic-decision-engine";
import { getStrategicGovernancePolicy } from "./strategic-policy";
import {
  getStrategicGovernanceDecision,
  insertStrategicGovernanceDecision,
  listStrategicGovernanceDecisions,
  type StrategicGovernanceDecisionRow,
  type StrategicGovernanceStoreExecutor,
} from "./strategic-governance-store";
import {
  buildStrategicGovernanceOperationsProjection,
  type StrategicGovernanceOperationsProjection,
} from "./strategic-operations-projection";
import type { StrategicReviewChallengeGateway } from "./strategic-review-authority";
import { createAuditEvent } from "../audit/audit-event";
import { persistAuditEvent, type AuditDbExecutor } from "../audit/audit-store";

// ─── Provider seam (untrusted until re-validated at the boundary) ───

/**
 * Raw upstream authority. Every payload arrives as `unknown` — the service
 * re-validates before anything consumes it. Implementations throw
 * ProviderBusinessNotFound for absent businesses so cross-tenant/forged
 * references fail closed and indistinguishable.
 */
export interface StrategicGovernanceAuthorityProvider {
  getBusinessAuthority(businessId: number): Promise<unknown>;
  /**
   * Resolve one evidence reference to its canonical, tenant-scoped record.
   * Returns null when the reference does not resolve for this tenant (absent,
   * forged, or cross-tenant — indistinguishable by design).
   */
  resolveEvidence(evidenceRef: string, businessId: number): Promise<unknown>;
  /** Server-side registered/trusted external source keys for this tenant. */
  getTrustedSourceKeys(): Promise<readonly string[]>;
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

export interface StrategicGovernanceAuthorityDeps {
  readonly provider: StrategicGovernanceAuthorityProvider;
  /** Injected clock for determinism; defaults to wall time. */
  readonly now?: () => Date;
  /**
   * Human-presence challenge gateway for review resolution (F5). Production
   * wires the OTP gateway; tests bind a fake. When absent, the OTP-bound
   * resolution surface fails closed.
   */
  readonly reviewGateway?: StrategicReviewChallengeGateway;
}

function resolveNow(deps: StrategicGovernanceAuthorityDeps): Date {
  return deps.now ? deps.now() : new Date();
}

async function fetchBusinessAuthority(
  deps: StrategicGovernanceAuthorityDeps,
  businessId: number
): Promise<{ businessId: number; owningUserId: number; businessActive: boolean }> {
  let raw: unknown;
  try {
    raw = await deps.provider.getBusinessAuthority(businessId);
  } catch (err) {
    if (err instanceof ProviderBusinessNotFound) {
      // Indistinguishable from absent for cross-tenant references.
      throw new StrategicGovernanceError(
        "OWNERSHIP_MISMATCH",
        `business ${businessId} not found for this tenant`
      );
    }
    throw err;
  }
  if (typeof raw !== "object" || raw === null) {
    throw new StrategicGovernanceError(
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
    throw new StrategicGovernanceError(
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

/** The service executor spans the R8-F table and the audit ledger. */
function asAuditExecutor(executor: StrategicGovernanceStoreExecutor): AuditDbExecutor {
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

export interface EvaluateStrategicGovernanceForProposalInput {
  readonly userId: number;
  readonly proposal: unknown;
  readonly policyVersion?: string;
}

export interface EvaluateStrategicGovernanceForProposalResult {
  readonly decision: StrategicGovernanceDecision;
  readonly duplicateClassification: "none" | "idempotent_replay";
}

/**
 * One governed evaluation. Every authority payload is untrusted until its
 * seam accepts it; every binding is recomputed, never taken from the wire.
 * Same authoritative inputs ⇒ same governanceDecisionId ⇒ durable
 * convergence (replay re-reads the stored row and emits zero events).
 */
export async function evaluateStrategicGovernanceForProposal(
  input: EvaluateStrategicGovernanceForProposalInput,
  deps: StrategicGovernanceAuthorityDeps,
  executor: StrategicGovernanceStoreExecutor
): Promise<EvaluateStrategicGovernanceForProposalResult> {
  const now = resolveNow(deps);
  const proposal = buildStrategicProposal(input.proposal);
  const policy = getStrategicGovernancePolicy(input.policyVersion);

  const businessAuthority = await fetchBusinessAuthority(deps, proposal.businessId);
  const trustedSourceKeys = new Set(await deps.provider.getTrustedSourceKeys());

  // Resolve every evidence reference server-side. A resolution that throws
  // authority-unavailable fails the whole evaluation closed — evidence truth
  // is never guessed.
  const resolvedEvidenceByRef = new Map<string, unknown>();
  for (const ref of proposal.evidenceRefs) {
    let resolved: unknown;
    try {
      resolved = await deps.provider.resolveEvidence(ref, proposal.businessId);
    } catch (err) {
      if (err instanceof StrategicGovernanceError) throw err;
      throw new ProviderAuthorityUnavailable(
        "strategic evidence",
        err instanceof Error ? err.message : String(err)
      );
    }
    resolvedEvidenceByRef.set(ref, resolved);
  }

  const decision = evaluateStrategicGovernance({
    proposal,
    userId: input.userId,
    policy,
    currentPolicyVersion: policy.policyVersion,
    businessAuthority,
    resolvedEvidenceByRef,
    trustedSourceKeys,
    now: now.toISOString(),
  });

  const evaluatedAt = now.toISOString();
  const row: StrategicGovernanceDecisionRow = deepFreeze({
    governanceDecisionId: decision.governanceDecisionId,
    contractVersion: decision.contractVersion,
    engineVersion: decision.engineVersion,
    userId: decision.userId,
    businessId: decision.businessId,
    proposalId: decision.proposalId,
    recommendationType: decision.recommendationType,
    evidenceRefs: [...decision.evidenceRefs],
    sourceTrustClass: decision.sourceTrustClass,
    confidenceClass: decision.confidenceClass,
    strategicRiskClass: decision.strategicRiskClass,
    policyVersion: decision.policyVersion,
    decision: decision.decision,
    reasonCodes: [...decision.reasonCodes],
    approvalRequired: decision.approvalRequired,
    approvalBinding: decision.approvalBinding,
    evidenceFingerprint: decision.evidenceFingerprint,
    proposalFingerprint: decision.proposalFingerprint,
    validUntil: decision.validUntil,
    evaluatedAt: decision.evaluatedAt,
    evaluationFingerprint: decision.evaluationFingerprint,
    thresholds: { ...decision.thresholds },
    createdAt: evaluatedAt,
  });

  const write = await insertStrategicGovernanceDecision(row, executor);
  if (write.inserted) {
    // Exactly one audit event per inserted decision; replays/convergence
    // emit zero events.
    const event = createAuditEvent({
      eventType: "strategic_governance_decision",
      source: "system",
      outcome: decision.decision === "BLOCK" ? "failed" : "succeeded",
      occurredAt: evaluatedAt,
      userId: input.userId,
      businessId: decision.businessId,
      metadata: {
        governanceDecisionId: decision.governanceDecisionId,
        proposalId: decision.proposalId,
        businessId: decision.businessId,
        recommendationType: decision.recommendationType,
        decision: decision.decision,
        reasonCodes: [...decision.reasonCodes],
        strategicRiskClass: decision.strategicRiskClass,
        confidenceClass: decision.confidenceClass,
        sourceTrustClass: decision.sourceTrustClass,
        approvalRequired: decision.approvalRequired,
        policyVersion: decision.policyVersion,
        evidenceFingerprint: decision.evidenceFingerprint,
        proposalFingerprint: decision.proposalFingerprint,
        contractVersion: STRATEGIC_GOVERNANCE_CONTRACT_VERSION,
      },
    });
    await persistAuditEvent(event, asAuditExecutor(executor));
  }

  return { decision, duplicateClassification: write.duplicateClassification };
}

// ─── Reads ───

export async function getStrategicGovernanceDecisionForUser(
  input: { userId: number; governanceDecisionId: string },
  executor: StrategicGovernanceStoreExecutor
): Promise<StrategicGovernanceDecisionRow> {
  return getStrategicGovernanceDecision(input.userId, input.governanceDecisionId, executor);
}

export async function listStrategicGovernanceDecisionsForUser(
  input: {
    userId: number;
    businessId?: number;
    proposalId?: string;
    decision?: string;
  },
  executor: StrategicGovernanceStoreExecutor
): Promise<StrategicGovernanceDecisionRow[]> {
  return listStrategicGovernanceDecisions(
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
export async function getStrategicGovernanceOperationsProjectionForUser(
  input: { userId: number; businessId?: number },
  deps: StrategicGovernanceAuthorityDeps,
  executor: StrategicGovernanceStoreExecutor
): Promise<StrategicGovernanceOperationsProjection> {
  const now = resolveNow(deps);
  const rows = await listStrategicGovernanceDecisions(
    input.userId,
    { businessId: input.businessId },
    executor
  );
  const policy = getStrategicGovernancePolicy();
  const approvalMap = deps.provider.getApprovalStatusByDecisionId
    ? await deps.provider.getApprovalStatusByDecisionId(
        input.userId,
        rows.map((r) => r.governanceDecisionId)
      )
    : new Map<string, null>();
  return buildStrategicGovernanceOperationsProjection({
    rows,
    approvalStatusByDecisionId: approvalMap,
    currentPolicyVersion: policy.policyVersion,
    now: now.toISOString(),
  });
}

// ─── Revalidation (downstream contract) ───

export interface RevalidateStrategicGovernanceDecisionResult {
  readonly previous: StrategicGovernanceDecisionRow;
  readonly current: StrategicGovernanceDecision;
  readonly unchanged: boolean;
}

/**
 * Downstream contract seam: re-evaluate one previously recorded decision
 * under the CURRENT policy + authority state using fresh proposal material.
 * The stored decision is never mutated; if anything material changed, the
 * caller receives a fresh decision (which the caller may persist via a new
 * evaluation). R8-D/E and R9 must revalidate governance immediately before
 * any material effect.
 */
export async function revalidateStrategicGovernanceDecision(
  input: { userId: number; governanceDecisionId: string; proposal?: unknown },
  deps: StrategicGovernanceAuthorityDeps,
  executor: StrategicGovernanceStoreExecutor
): Promise<RevalidateStrategicGovernanceDecisionResult> {
  const now = resolveNow(deps);
  const previous = await getStrategicGovernanceDecision(
    input.userId,
    input.governanceDecisionId,
    executor
  );
  if (input.proposal === undefined) {
    throw new StrategicGovernanceError(
      "MALFORMED_PROPOSAL",
      "revalidation requires the proposal material the caller intends to act on; governance is revalidated against fresh material, not against stale stored coordinates"
    );
  }
  const proposal = buildStrategicProposal(input.proposal);
  if (
    proposal.proposalId !== previous.proposalId ||
    proposal.businessId !== previous.businessId ||
    proposal.recommendationType !== previous.recommendationType
  ) {
    throw new StrategicGovernanceError(
      "OWNERSHIP_MISMATCH",
      "revalidation proposal coordinates do not match the stored decision identity"
    );
  }
  const policy = getStrategicGovernancePolicy();

  const businessAuthority = await fetchBusinessAuthority(deps, previous.businessId);
  const trustedSourceKeys = new Set(await deps.provider.getTrustedSourceKeys());
  const resolvedEvidenceByRef = new Map<string, unknown>();
  for (const ref of proposal.evidenceRefs) {
    let resolved: unknown;
    try {
      resolved = await deps.provider.resolveEvidence(ref, previous.businessId);
    } catch (err) {
      if (err instanceof StrategicGovernanceError) throw err;
      throw new ProviderAuthorityUnavailable(
        "strategic evidence",
        err instanceof Error ? err.message : String(err)
      );
    }
    resolvedEvidenceByRef.set(ref, resolved);
  }

  const current = evaluateStrategicGovernance({
    proposal,
    userId: input.userId,
    policy,
    currentPolicyVersion: policy.policyVersion,
    businessAuthority,
    resolvedEvidenceByRef,
    trustedSourceKeys,
    now: now.toISOString(),
  });

  const unchanged =
    current.governanceDecisionId === previous.governanceDecisionId &&
    current.evaluationFingerprint === previous.evaluationFingerprint;

  return { previous, current, unchanged };
}

// ─── F5 — OTP-bound human review resolution ───

export interface RequestStrategicApprovalChallengeResult {
  readonly governanceDecisionId: string;
  readonly challengeToken: string;
  readonly expiresAt: string;
}

/**
 * Issue an out-of-band human-presence challenge bound to an existing
 * REVIEW_REQUIRED decision. The decision is re-read for this tenant first;
 * a challenge is never issued for an ALLOW/BLOCK/absent decision. An
 * autonomous agent holding the tenant session cannot observe the emailed
 * code, so it cannot self-authorize (AC22).
 */
export async function requestStrategicApprovalChallenge(
  input: { userId: number; governanceDecisionId: string; req: Request },
  deps: StrategicGovernanceAuthorityDeps,
  executor: StrategicGovernanceStoreExecutor
): Promise<RequestStrategicApprovalChallengeResult> {
  if (!deps.reviewGateway) {
    throw new StrategicGovernanceError(
      "REVIEW_CHALLENGE_UNAVAILABLE",
      "no strategic review challenge gateway bound; refusing to issue a challenge"
    );
  }
  const row = await getStrategicGovernanceDecision(
    input.userId,
    input.governanceDecisionId,
    executor
  );
  if (row.decision !== "REVIEW_REQUIRED") {
    throw new StrategicGovernanceError(
      "INVALID_APPROVAL_MODE",
      `Only REVIEW_REQUIRED decisions accept review challenges; got ${row.decision}`
    );
  }
  const challenge = await deps.reviewGateway.createAndSend({
    userId: input.userId,
    governanceDecisionId: row.governanceDecisionId,
    req: input.req,
  });
  return {
    governanceDecisionId: row.governanceDecisionId,
    challengeToken: challenge.challengeToken,
    expiresAt: challenge.expiresAt,
  };
}

export interface ResolveStrategicApprovalChallengeResult {
  readonly governanceDecisionId: string;
  readonly verifiedUserId: number;
  readonly verifiedAt: string;
}

/**
 * Verify the out-of-band challenge for a REVIEW_REQUIRED decision. Fails
 * closed (REVIEW_CHALLENGE_INVALID) when verification is absent, invalid,
 * expired, consumed, or was issued to a different actor. The verified human
 * actor must be the decision's own tenant user — an approval verified for a
 * different identity is never authority (AC20/AC22).
 */
export async function resolveStrategicApprovalChallenge(
  input: { userId: number; governanceDecisionId: string; challengeToken: string; code: string },
  deps: StrategicGovernanceAuthorityDeps,
  executor: StrategicGovernanceStoreExecutor
): Promise<ResolveStrategicApprovalChallengeResult> {
  if (!deps.reviewGateway) {
    throw new StrategicGovernanceError(
      "REVIEW_CHALLENGE_UNAVAILABLE",
      "no strategic review challenge gateway bound; refusing to verify"
    );
  }
  const row = await getStrategicGovernanceDecision(
    input.userId,
    input.governanceDecisionId,
    executor
  );
  if (row.decision !== "REVIEW_REQUIRED") {
    throw new StrategicGovernanceError(
      "INVALID_APPROVAL_MODE",
      `Only REVIEW_REQUIRED decisions accept review challenges; got ${row.decision}`
    );
  }
  let verified: { userId: number; consumedAt: string };
  try {
    verified = await deps.reviewGateway.verify({
      challengeToken: input.challengeToken,
      code: input.code,
    });
  } catch (err) {
    throw new StrategicGovernanceError(
      "REVIEW_CHALLENGE_INVALID",
      err instanceof Error ? err.message : "strategic review challenge verification failed"
    );
  }
  if (verified.userId !== input.userId) {
    throw new StrategicGovernanceError(
      "REVIEW_CHALLENGE_INVALID",
      "strategic review challenge was verified for a different actor"
    );
  }
  return {
    governanceDecisionId: row.governanceDecisionId,
    verifiedUserId: verified.userId,
    verifiedAt: verified.consumedAt,
  };
}

// ─── Narrow recovery (F8) ───

export interface RecordStrategicGovernanceRecoveryResult {
  readonly governanceDecisionId: string;
  readonly action: StrategicRecoveryAction;
  readonly recordedAt: string;
}

/**
 * Narrow recovery: record a closed-vocabulary operator action against an
 * existing decision. AUDIT-ONLY — the immutable decision row is never
 * mutated and no execution state changes. There is deliberately no
 * forceAllow/forceApprove/setApproved/overridePolicy anywhere in this stream:
 * the only "recovery" is truthful operator acknowledgement (AC34).
 */
export async function recordStrategicGovernanceRecovery(
  input: {
    userId: number;
    governanceDecisionId: string;
    action: StrategicRecoveryAction;
    note: string;
  },
  deps: StrategicGovernanceAuthorityDeps,
  executor: StrategicGovernanceStoreExecutor
): Promise<RecordStrategicGovernanceRecoveryResult> {
  if (!GOVERNANCE_DECISION_ID_PATTERN.test(input.governanceDecisionId)) {
    throw new StrategicGovernanceError(
      "GOVERNANCE_DECISION_NOT_FOUND",
      `governance decision ${input.governanceDecisionId} not found`
    );
  }
  const row = await getStrategicGovernanceDecision(
    input.userId,
    input.governanceDecisionId,
    executor
  );
  const now = resolveNow(deps);
  const recordedAt = now.toISOString();
  if (!isIsoUtc(recordedAt)) {
    throw new StrategicGovernanceError("INVALID_EVALUATION_CLOCK", "clock produced a non-ISO timestamp");
  }
  const event = createAuditEvent({
    eventType: "strategic_governance_recovery",
    source: "admin",
    outcome: "succeeded",
    occurredAt: recordedAt,
    userId: input.userId,
    businessId: row.businessId,
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
