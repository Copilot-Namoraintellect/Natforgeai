// ─── R9-F Mission Governance & Approval — service authority ───
//
// Orchestrates one governed evaluation end to end: re-validate the proposal,
// resolve the versioned policy, fetch server-side authority (business
// ownership) through the provider seam (re-validated at the boundary),
// evaluate with the pure engine, persist exactly once under the durable
// convergence anchor, and emit exactly one audit event per inserted receipt.
// Replays re-read the committed row and converge (zero extra events). The
// caller supplies the executor: one client/transaction spans the receipt
// insert and the audit persistence.
//
// Also owns the read-only operations projection, the narrow audited recovery
// surface (F8), the downstream revalidation seam, and the OTP-bound human
// review resolution surface (F4/F5). Recovery NEVER mutates an immutable
// receipt; the only recovery writes are closed-vocabulary audit-appended
// operator actions. This stream never executes mission actions, never plans
// missions/tasks, never touches campaigns, strategy, budgets, Business DNA,
// billing, payments, providers, CRM or the workflow engine, and never
// becomes the mission/execution engine (charter).

import {
  MISSION_DECISION_ID_PATTERN,
  isIsoUtc,
  MissionGovernanceError,
  MISSION_GOVERNANCE_CONTRACT_VERSION,
  type MissionRecoveryAction,
} from "./mission-governance-contract";
import {
  buildMissionActionProposal,
  evaluateMissionGovernance,
  type MissionGovernanceDecision,
} from "./mission-decision-engine";
import { getMissionGovernancePolicy } from "./mission-policy";
import {
  getMissionGovernanceDecision,
  insertMissionGovernanceDecision,
  listMissionGovernanceDecisions,
  type MissionGovernanceDecisionRow,
  type MissionGovernanceStoreExecutor,
} from "./mission-governance-store";
import {
  buildMissionGovernanceOperationsProjection,
  type MissionGovernanceOperationsProjection,
} from "./mission-operations-projection";
import type { MissionReviewChallengeGateway } from "./mission-review-authority";
import { createAuditEvent } from "../audit/audit-event";
import { persistAuditEvent, type AuditDbExecutor } from "../audit/audit-store";

// ─── Provider seam (untrusted until re-validated at the boundary) ───

/**
 * Raw upstream authority. Every payload arrives as `unknown` — the service
 * re-validates before anything consumes it. Implementations throw
 * ProviderBusinessNotFound for absent businesses so cross-tenant/forged
 * references fail closed and indistinguishable.
 */
export interface MissionGovernanceAuthorityProvider {
  getBusinessAuthority(businessId: number): Promise<unknown>;
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

export interface MissionGovernanceAuthorityDeps {
  readonly provider: MissionGovernanceAuthorityProvider;
  /** Injected clock for determinism; defaults to wall time. */
  readonly now?: () => Date;
  /**
   * Human-presence challenge gateway for review resolution (F4/F5).
   * Production wires the OTP gateway; tests bind a fake. When absent, the
   * OTP-bound resolution surface fails closed.
   */
  readonly reviewGateway?: MissionReviewChallengeGateway;
}

function resolveNow(deps: MissionGovernanceAuthorityDeps): Date {
  return deps.now ? deps.now() : new Date();
}

async function fetchBusinessAuthority(
  deps: MissionGovernanceAuthorityDeps,
  businessId: number
): Promise<{ businessId: number; owningUserId: number; businessActive: boolean }> {
  let raw: unknown;
  try {
    raw = await deps.provider.getBusinessAuthority(businessId);
  } catch (err) {
    if (err instanceof ProviderBusinessNotFound) {
      // Indistinguishable from absent for cross-tenant references.
      throw new MissionGovernanceError(
        "OWNERSHIP_MISMATCH",
        `business ${businessId} not found for this tenant`
      );
    }
    throw err;
  }
  if (typeof raw !== "object" || raw === null) {
    throw new MissionGovernanceError(
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
    throw new MissionGovernanceError(
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

/** The service executor spans the R9-F table and the audit ledger. */
function asAuditExecutor(executor: MissionGovernanceStoreExecutor): AuditDbExecutor {
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

export interface EvaluateMissionGovernanceForProposalInput {
  readonly userId: number;
  readonly proposal: unknown;
  readonly policyVersion?: string;
}

export interface EvaluateMissionGovernanceForProposalResult {
  readonly decision: MissionGovernanceDecision;
  readonly duplicateClassification: "none" | "idempotent_replay";
}

/**
 * One governed evaluation. Authority payloads are untrusted until their seam
 * accepts them; every binding is recomputed, never taken from the wire. Same
 * authoritative inputs ⇒ same governanceDecisionId ⇒ durable convergence
 * (replay re-reads the stored row and emits zero events).
 */
export async function evaluateMissionGovernanceForProposal(
  input: EvaluateMissionGovernanceForProposalInput,
  deps: MissionGovernanceAuthorityDeps,
  executor: MissionGovernanceStoreExecutor
): Promise<EvaluateMissionGovernanceForProposalResult> {
  const now = resolveNow(deps);
  const proposal = buildMissionActionProposal(input.proposal);
  const policy = getMissionGovernancePolicy(input.policyVersion);

  const businessAuthority = await fetchBusinessAuthority(deps, proposal.businessId);

  const decision = evaluateMissionGovernance({
    proposal,
    userId: input.userId,
    policy,
    currentPolicyVersion: policy.policyVersion,
    businessAuthority,
    now: now.toISOString(),
  });

  const evaluatedAt = now.toISOString();
  const row: MissionGovernanceDecisionRow = deepFreeze({
    governanceDecisionId: decision.governanceDecisionId,
    contractVersion: decision.contractVersion,
    engineVersion: decision.engineVersion,
    userId: decision.userId,
    businessId: decision.businessId,
    missionRef: decision.missionRef,
    planRef: decision.planRef,
    taskRef: decision.taskRef,
    subjectClass: decision.subjectClass,
    actionType: decision.actionType,
    actionParamsFingerprint: decision.actionParamsFingerprint,
    missionRiskClass: decision.missionRiskClass,
    riskFactors: { ...decision.riskFactors },
    policyVersion: decision.policyVersion,
    decision: decision.decision,
    reasonCodes: [...decision.reasonCodes],
    approvalRequired: decision.approvalRequired,
    approvalBinding: decision.approvalBinding,
    evaluationFingerprint: decision.evaluationFingerprint,
    validUntil: decision.validUntil,
    evaluatedAt: decision.evaluatedAt,
    thresholds: { ...decision.thresholds },
    createdAt: evaluatedAt,
  });

  const write = await insertMissionGovernanceDecision(row, executor);
  if (write.inserted) {
    // Exactly one audit event per inserted receipt; replays/convergence
    // emit zero events.
    const event = createAuditEvent({
      eventType: "mission_governance_decision",
      source: "system",
      outcome: decision.decision === "BLOCK" ? "failed" : "succeeded",
      occurredAt: evaluatedAt,
      userId: input.userId,
      businessId: decision.businessId,
      metadata: {
        governanceDecisionId: decision.governanceDecisionId,
        businessId: decision.businessId,
        missionRef: decision.missionRef,
        planRef: decision.planRef,
        taskRef: decision.taskRef,
        subjectClass: decision.subjectClass,
        actionType: decision.actionType,
        decision: decision.decision,
        reasonCodes: [...decision.reasonCodes],
        missionRiskClass: decision.missionRiskClass,
        policyVersion: decision.policyVersion,
        actionParamsFingerprint: decision.actionParamsFingerprint,
        evaluationFingerprint: decision.evaluationFingerprint,
        contractVersion: MISSION_GOVERNANCE_CONTRACT_VERSION,
      },
    });
    await persistAuditEvent(event, asAuditExecutor(executor));
  }

  return { decision, duplicateClassification: write.duplicateClassification };
}

// ─── Reads ───

export async function getMissionGovernanceDecisionForUser(
  input: { userId: number; governanceDecisionId: string },
  executor: MissionGovernanceStoreExecutor
): Promise<MissionGovernanceDecisionRow> {
  return getMissionGovernanceDecision(input.userId, input.governanceDecisionId, executor);
}

export async function listMissionGovernanceDecisionsForUser(
  input: {
    userId: number;
    businessId?: number;
    missionRef?: string;
    decision?: string;
  },
  executor: MissionGovernanceStoreExecutor
): Promise<MissionGovernanceDecisionRow[]> {
  return listMissionGovernanceDecisions(
    input.userId,
    { businessId: input.businessId, missionRef: input.missionRef, decision: input.decision },
    executor
  );
}

/**
 * Read-only operations projection (F8). Truthful by construction: every item
 * derives from an immutable receipt row; stale/expired status is computed,
 * never stored, so the view can never drift from the receipts it projects.
 */
export async function getMissionGovernanceOperationsProjectionForUser(
  input: { userId: number; businessId?: number },
  deps: MissionGovernanceAuthorityDeps,
  executor: MissionGovernanceStoreExecutor
): Promise<MissionGovernanceOperationsProjection> {
  const now = resolveNow(deps);
  const rows = await listMissionGovernanceDecisions(
    input.userId,
    { businessId: input.businessId },
    executor
  );
  const policy = getMissionGovernancePolicy();
  const approvalMap = deps.provider.getApprovalStatusByDecisionId
    ? await deps.provider.getApprovalStatusByDecisionId(
        input.userId,
        rows.map((r) => r.governanceDecisionId)
      )
    : new Map<string, null>();
  return buildMissionGovernanceOperationsProjection({
    rows,
    approvalStatusByDecisionId: approvalMap,
    currentPolicyVersion: policy.policyVersion,
    now: now.toISOString(),
  });
}

// ─── Revalidation (downstream contract) ───

export interface RevalidateMissionGovernanceDecisionResult {
  readonly previous: MissionGovernanceDecisionRow;
  readonly current: MissionGovernanceDecision;
  readonly unchanged: boolean;
}

/**
 * Downstream contract seam: re-evaluate one previously recorded receipt under
 * the CURRENT policy + authority state using fresh proposal material. The
 * stored receipt is never mutated; if anything material changed, the caller
 * receives a fresh decision (which the caller may persist via a new
 * evaluation). Downstream R9-D/E must revalidate governance immediately
 * before any material effect.
 */
export async function revalidateMissionGovernanceDecision(
  input: { userId: number; governanceDecisionId: string; proposal?: unknown },
  deps: MissionGovernanceAuthorityDeps,
  executor: MissionGovernanceStoreExecutor
): Promise<RevalidateMissionGovernanceDecisionResult> {
  const now = resolveNow(deps);
  const previous = await getMissionGovernanceDecision(
    input.userId,
    input.governanceDecisionId,
    executor
  );
  if (input.proposal === undefined) {
    throw new MissionGovernanceError(
      "MALFORMED_PROPOSAL",
      "revalidation requires the proposal material the caller intends to act on; governance is revalidated against fresh material, not against stale stored coordinates"
    );
  }
  const proposal = buildMissionActionProposal(input.proposal);
  if (
    proposal.missionRef !== previous.missionRef ||
    proposal.businessId !== previous.businessId ||
    proposal.subjectClass !== previous.subjectClass ||
    proposal.actionType !== previous.actionType
  ) {
    throw new MissionGovernanceError(
      "OWNERSHIP_MISMATCH",
      "revalidation proposal coordinates do not match the stored receipt identity"
    );
  }
  const policy = getMissionGovernancePolicy();

  const businessAuthority = await fetchBusinessAuthority(deps, previous.businessId);

  const current = evaluateMissionGovernance({
    proposal,
    userId: input.userId,
    policy,
    currentPolicyVersion: policy.policyVersion,
    businessAuthority,
    now: now.toISOString(),
  });

  const unchanged =
    current.governanceDecisionId === previous.governanceDecisionId &&
    current.evaluationFingerprint === previous.evaluationFingerprint;

  return { previous, current, unchanged };
}

// ─── F4/F5 — OTP-bound human review resolution ───

export interface RequestMissionApprovalChallengeResult {
  readonly governanceDecisionId: string;
  readonly challengeToken: string;
  readonly expiresAt: string;
}

/**
 * Issue an out-of-band human-presence challenge bound to an existing
 * REVIEW_REQUIRED decision. The decision is re-read for this tenant first;
 * a challenge is never issued for an ALLOW/BLOCK/absent decision. An
 * autonomous agent holding the tenant session cannot observe the emailed
 * code, so it cannot self-authorize (F8).
 */
export async function requestMissionApprovalChallenge(
  input: { userId: number; governanceDecisionId: string; req: Request },
  deps: MissionGovernanceAuthorityDeps,
  executor: MissionGovernanceStoreExecutor
): Promise<RequestMissionApprovalChallengeResult> {
  if (!deps.reviewGateway) {
    throw new MissionGovernanceError(
      "REVIEW_CHALLENGE_UNAVAILABLE",
      "no mission review challenge gateway bound; refusing to issue a challenge"
    );
  }
  const row = await getMissionGovernanceDecision(
    input.userId,
    input.governanceDecisionId,
    executor
  );
  if (row.decision !== "REVIEW_REQUIRED") {
    throw new MissionGovernanceError(
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

export interface ResolveMissionApprovalChallengeResult {
  readonly governanceDecisionId: string;
  readonly verifiedUserId: number;
  readonly verifiedAt: string;
}

/**
 * Verify the out-of-band challenge for a REVIEW_REQUIRED decision. Fails
 * closed (REVIEW_CHALLENGE_INVALID) when verification is absent, invalid,
 * expired, consumed, or was issued to a different actor. The verified human
 * actor must be the decision's own tenant user — an approval verified for a
 * different identity is never authority.
 */
export async function resolveMissionApprovalChallenge(
  input: { userId: number; governanceDecisionId: string; challengeToken: string; code: string },
  deps: MissionGovernanceAuthorityDeps,
  executor: MissionGovernanceStoreExecutor
): Promise<ResolveMissionApprovalChallengeResult> {
  if (!deps.reviewGateway) {
    throw new MissionGovernanceError(
      "REVIEW_CHALLENGE_UNAVAILABLE",
      "no mission review challenge gateway bound; refusing to verify"
    );
  }
  const row = await getMissionGovernanceDecision(
    input.userId,
    input.governanceDecisionId,
    executor
  );
  if (row.decision !== "REVIEW_REQUIRED") {
    throw new MissionGovernanceError(
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
    throw new MissionGovernanceError(
      "REVIEW_CHALLENGE_INVALID",
      err instanceof Error ? err.message : "mission review challenge verification failed"
    );
  }
  if (verified.userId !== input.userId) {
    throw new MissionGovernanceError(
      "REVIEW_CHALLENGE_INVALID",
      "mission review challenge was verified for a different actor"
    );
  }
  return {
    governanceDecisionId: row.governanceDecisionId,
    verifiedUserId: verified.userId,
    verifiedAt: verified.consumedAt,
  };
}

// ─── Narrow recovery (F8) ───

export interface RecordMissionGovernanceRecoveryResult {
  readonly governanceDecisionId: string;
  readonly action: MissionRecoveryAction;
  readonly recordedAt: string;
}

/**
 * Narrow recovery: record a closed-vocabulary operator action against an
 * existing decision. AUDIT-ONLY — the immutable receipt row is never mutated
 * and no execution state changes. There is deliberately no
 * forceAllow/forceApprove/setApproved/overridePolicy anywhere in this
 * stream: the only "recovery" is truthful operator acknowledgement.
 */
export async function recordMissionGovernanceRecovery(
  input: {
    userId: number;
    governanceDecisionId: string;
    action: MissionRecoveryAction;
    note: string;
  },
  deps: MissionGovernanceAuthorityDeps,
  executor: MissionGovernanceStoreExecutor
): Promise<RecordMissionGovernanceRecoveryResult> {
  if (!MISSION_DECISION_ID_PATTERN.test(input.governanceDecisionId)) {
    throw new MissionGovernanceError(
      "GOVERNANCE_DECISION_NOT_FOUND",
      `governance decision ${input.governanceDecisionId} not found`
    );
  }
  const row = await getMissionGovernanceDecision(
    input.userId,
    input.governanceDecisionId,
    executor
  );
  const now = resolveNow(deps);
  const recordedAt = now.toISOString();
  if (!isIsoUtc(recordedAt)) {
    throw new MissionGovernanceError("INVALID_EVALUATION_CLOCK", "clock produced a non-ISO timestamp");
  }
  const event = createAuditEvent({
    eventType: "mission_governance_recovery",
    source: "admin",
    outcome: "succeeded",
    occurredAt: recordedAt,
    userId: input.userId,
    businessId: row.businessId,
    metadata: {
      governanceDecisionId: row.governanceDecisionId,
      missionRef: row.missionRef,
      businessId: row.businessId,
      subjectClass: row.subjectClass,
      actionType: row.actionType,
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
export { deriveMissionGovernanceDecisionId } from "./mission-governance-contract";
