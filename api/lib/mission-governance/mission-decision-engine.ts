// ─── R9-F Mission Governance & Approval — pure decision engine ───
//
//   mission action proposal (material only)
//   + business policy (versioned, server-side)
//   + SERVER-DERIVED mission risk (F3: semantic floors + raise-only signals)
//   + phase autonomy ceilings (F2: no phase escalation by default)
//   + retry/recovery governance (F7)
//   + current business state (tenant-anchored ownership)
//   -> immutable governance receipt (ALLOW / REVIEW_REQUIRED / BLOCK)
//
// Guarantees:
// - fail closed on unknown subject classes, unknown/prohibited action types,
//   missing/stale policy, ownership mismatch and cross-tenant missions;
// - authority only ever narrows: each dimension may reduce the disposition,
//   none may widen it (charter; contract §3);
// - risk is SERVER-DERIVED and raise-only: declarations, semantic floors and
//   injection suspicion can only raise it — nothing here can lower its own
//   risk (AC15/16/17);
// - phase separation: a subject whose phase is outside the policy's
//   autonomous set floors at REVIEW_REQUIRED — mission approval never
//   authorizes execution, task approval never authorizes provider calls
//   (F2; AC4/5);
// - retry is not automatically safe: non-idempotent retries and retries
//   whose params differ from the failed attempt are floored at
//   REVIEW_REQUIRED with raised risk (F7; AC18/19);
// - deterministic receipt identity: one authoritative coordinate set + one
//   policy version -> one stable governanceDecisionId; retries converge;
// - no clock access beyond the caller-supplied `now`, no side effects:
//   nothing is executed, sent, launched, mutated, charged or persisted here.

import {
  canonicalJson,
  deriveEvaluationFingerprint,
  deriveMissionApprovalBindingHash,
  deriveMissionGovernanceDecisionId,
  deriveActionParamsFingerprint,
  MISSION_DECISION_AUTONOMY_RANK,
  isIsoUtc,
  MAX_MISSION_REASON_CODES,
  MISSION_GOVERNANCE_CONTRACT_VERSION,
  MISSION_GOVERNANCE_ENGINE_VERSION,
  MissionGovernanceInputError,
  MissionGovernanceValidationError,
  isMissionActionType,
  isMissionSubjectClass,
  phaseOfMissionSubjectClass,
  type MissionGovernanceErrorCode,
  type MissionActionType,
  type MissionGovernanceDecision as GovernanceDecisionOutcome,
  type MissionGovernanceReasonCode,
  type MissionRiskClass,
  type MissionSubjectClass,
  MISSION_REF_PATTERN,
} from "./mission-governance-contract";
import {
  deriveMissionRisk,
  validateDeclaredMissionRisk,
  type DeclaredMissionRisk,
} from "./mission-risk-classification";
import type { MissionGovernancePolicy } from "./mission-policy";

// ─── Proposal contract (validated evaluation input) ───

/**
 * The canonical mission action proposal. Clients (R9 mission/execution
 * agents) supply MATERIAL only: NO decision, risk class, reason codes,
 * approval state, authorization, fingerprints or policy content. Any such
 * field fails closed at build. The only risk signals admitted are declared
 * impact dimensions that can only RAISE server-derived risk.
 */
export interface MissionActionProposal {
  readonly missionRef: string;
  readonly businessId: number;
  /** Closed taxonomy value; unknown values flow through and are BLOCKED. */
  readonly subjectClass: string;
  /** Closed taxonomy value; unknown values flow through and are BLOCKED. */
  readonly actionType: string;
  readonly planRef: string | null;
  readonly taskRef: string | null;
  /** Bounded narrative (inert external content — F8 injection hygiene). */
  readonly summary: string;
  /** Exact action parameters; hashed, never persisted raw. */
  readonly actionParams: unknown;
  readonly actionParamsFingerprint: string;
  /** Impact declarations; each can only raise derived risk. */
  readonly declaredRisk: DeclaredMissionRisk;
  /** Required for RETRY subjects (F7). */
  readonly retryContext: MissionRetryContext | null;
  readonly requestedAt: string;
}

export interface MissionRetryContext {
  readonly retryOf: string;
  readonly declaredIdempotent: boolean;
  readonly priorActionParams: unknown;
  readonly priorActionParamsFingerprint: string;
}

const MAX_SUMMARY_LENGTH = 4000;
/** Bounded canonical JSON for action params (matches the default policy cap). */
export const MAX_ACTION_PARAMS_CANONICAL_CHARS = 16384;

const FORBIDDEN_CLIENT_AUTHORITY_FIELDS = [
  "decision",
  "riskClass",
  "missionRiskClass",
  "risk",
  "riskLevel",
  "reasonCodes",
  "approvalRequired",
  "approvalStatus",
  "approved",
  "authorized",
  "authorization",
  "executable",
  "consumable",
  "execution",
  "policyVersion",
  "governanceDecisionId",
  "actionParamsFingerprint",
  "approvalBindingHash",
  "evaluationFingerprint",
  "authority",
  "override",
  "ignorePolicy",
  "admin",
  "forceAllow",
  "forceApprove",
  "forceComplete",
  "setApproved",
  "overrideRisk",
  "overridePolicy",
  "lowerRisk",
  "selfApprove",
  "selfApproval",
] as const;

function fail(code: MissionGovernanceErrorCode, message: string): never {
  throw new MissionGovernanceInputError(code, message);
}

function assertNoClientAuthorityFields(input: Record<string, unknown>): void {
  for (const key of FORBIDDEN_CLIENT_AUTHORITY_FIELDS) {
    if (key in input) {
      throw new MissionGovernanceValidationError(
        "CLIENT_AUTHORITY_FIELD_REJECTED",
        `Field "${key}" is server-side authority and must never be client-supplied.`
      );
    }
  }
}

function assertIso(value: unknown, field: string): string {
  if (typeof value !== "string" || !isIsoUtc(value)) {
    fail("MALFORMED_PROPOSAL", `${field} must be an explicit ISO 8601 UTC timestamp`);
  }
  return value;
}

function assertRef(value: unknown, field: string): string {
  if (typeof value !== "string" || !MISSION_REF_PATTERN.test(value)) {
    fail("MALFORMED_PROPOSAL", `${field} must match ${MISSION_REF_PATTERN}`);
  }
  return value;
}

function assertBoundedJson(value: unknown, field: string): void {
  // Action params travel as JSON; reject clearly non-JSON shapes defensively.
  if (value === undefined) return;
  const seen = new WeakSet<object>();
  const walk = (v: unknown, depth: number): void => {
    if (v === null || typeof v === "number" || typeof v === "boolean") return;
    if (typeof v === "string") return;
    if (typeof v !== "object") {
      throw new MissionGovernanceValidationError(
        "MALFORMED_PROPOSAL",
        `${field} must be JSON-serializable material`
      );
    }
    if (depth > 32) {
      throw new MissionGovernanceValidationError(
        "MALFORMED_PROPOSAL",
        `${field} exceeds the maximum nesting depth`
      );
    }
    if (seen.has(v as object)) {
      throw new MissionGovernanceValidationError(
        "MALFORMED_PROPOSAL",
        `${field} must be acyclic JSON material`
      );
    }
    seen.add(v as object);
    if (Array.isArray(v)) {
      for (const item of v) walk(item, depth + 1);
      return;
    }
    for (const item of Object.values(v as Record<string, unknown>)) walk(item, depth + 1);
  };
  walk(value, 0);
}

function buildRetryContext(raw: unknown): MissionRetryContext | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new MissionGovernanceValidationError(
      "INVALID_RETRY_CONTEXT",
      "retryContext must be an object"
    );
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.declaredIdempotent !== "boolean") {
    throw new MissionGovernanceValidationError(
      "INVALID_RETRY_CONTEXT",
      "retryContext.declaredIdempotent must be a boolean"
    );
  }
  const retryOf = assertRef(r.retryOf, "retryContext.retryOf");
  const priorActionParams = r.priorActionParams ?? null;
  assertBoundedJson(priorActionParams, "retryContext.priorActionParams");
  // A retry whose parameters differ from the failed attempt has silently
  // broadened authority — detected at evaluation (RETRY_SCOPE_BROADENED);
  // here we only validate structure.
  return Object.freeze({
    retryOf,
    declaredIdempotent: r.declaredIdempotent,
    priorActionParams,
    priorActionParamsFingerprint: deriveActionParamsFingerprint(priorActionParams),
  });
}

/**
 * Validate and normalise raw proposal input. Throws
 * MissionGovernanceValidationError / MissionGovernanceInputError on any
 * malformed or authority-smuggling input (fail closed). Unknown
 * subjectClass / actionType strings are NOT rejected here — the engine
 * BLOCKs them as governed decisions so the attempt is durably auditable.
 */
export function buildMissionActionProposal(raw: unknown): MissionActionProposal {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail("MALFORMED_PROPOSAL", "proposal must be a structured object");
  }
  const r = raw as Record<string, unknown>;
  assertNoClientAuthorityFields(r);

  const missionRef = assertRef(r.missionRef, "missionRef");
  const businessId = r.businessId;
  if (typeof businessId !== "number" || !Number.isInteger(businessId) || businessId <= 0) {
    fail("MALFORMED_PROPOSAL", "businessId must be a positive integer");
  }
  if (typeof r.subjectClass !== "string" || r.subjectClass.trim().length === 0 || r.subjectClass.length > 48) {
    fail("MALFORMED_PROPOSAL", "subjectClass must be a non-blank string <= 48 chars");
  }
  if (typeof r.actionType !== "string" || r.actionType.trim().length === 0 || r.actionType.length > 48) {
    fail("MALFORMED_PROPOSAL", "actionType must be a non-blank string <= 48 chars");
  }
  const planRef = r.planRef === undefined || r.planRef === null ? null : assertRef(r.planRef, "planRef");
  const taskRef = r.taskRef === undefined || r.taskRef === null ? null : assertRef(r.taskRef, "taskRef");
  if (typeof r.summary !== "string" || r.summary.trim().length === 0) {
    fail("MALFORMED_PROPOSAL", "summary must be a non-blank string");
  }
  if (r.summary.length > MAX_SUMMARY_LENGTH) {
    fail("MALFORMED_PROPOSAL", `summary must be <= ${MAX_SUMMARY_LENGTH} chars`);
  }
  const actionParams = r.actionParams ?? null;
  assertBoundedJson(actionParams, "actionParams");
  const canonical = canonicalJson(actionParams);
  if (canonical.length > MAX_ACTION_PARAMS_CANONICAL_CHARS) {
    fail(
      "MALFORMED_PROPOSAL",
      `actionParams canonical form must be <= ${MAX_ACTION_PARAMS_CANONICAL_CHARS} chars`
    );
  }
  const declaredRisk = validateDeclaredMissionRisk(r.declaredRisk);
  const retryContext = buildRetryContext(r.retryContext);

  return Object.freeze({
    missionRef,
    businessId,
    subjectClass: r.subjectClass,
    actionType: r.actionType,
    planRef,
    taskRef,
    summary: r.summary,
    actionParams,
    actionParamsFingerprint: deriveActionParamsFingerprint(actionParams),
    declaredRisk,
    retryContext,
    requestedAt: assertIso(r.requestedAt, "requestedAt"),
  });
}

// ─── Business authority (server-resolved ownership) ───

export interface MissionBusinessAuthority {
  readonly businessId: number;
  readonly owningUserId: number;
  readonly businessActive: boolean;
}

// ─── The durable, immutable governance receipt (F5) ───

export interface MissionGovernanceApprovalBinding {
  readonly governanceDecisionId: string;
  readonly businessId: number;
  readonly missionRef: string;
  readonly planRef: string | null;
  readonly taskRef: string | null;
  readonly subjectClass: string;
  readonly actionType: string;
  readonly actionParamsFingerprint: string;
  readonly missionRiskClass: MissionRiskClass;
  readonly policyVersion: string;
  readonly approvalBindingHash: string;
  readonly expiresAt: string;
}

export interface MissionGovernanceDecision {
  readonly governanceDecisionId: string;
  readonly contractVersion: string;
  readonly engineVersion: string;
  readonly userId: number;
  readonly businessId: number;
  readonly missionRef: string;
  readonly planRef: string | null;
  readonly taskRef: string | null;
  readonly subjectClass: string;
  readonly actionType: string;
  readonly actionParamsFingerprint: string;
  readonly missionRiskClass: MissionRiskClass;
  readonly riskFactors: Readonly<Record<string, string | boolean>>;
  readonly policyVersion: string | null;
  readonly decision: GovernanceDecisionOutcome;
  readonly reasonCodes: readonly MissionGovernanceReasonCode[];
  readonly approvalRequired: boolean;
  readonly approvalBinding: MissionGovernanceApprovalBinding | null;
  readonly evaluationFingerprint: string;
  readonly validUntil: string | null;
  readonly evaluatedAt: string;
  /** Bounded snapshot of the policy thresholds used at evaluation time. */
  readonly thresholds: Readonly<Record<string, number>>;
}

export interface MissionGovernanceEvaluationInput {
  readonly proposal: MissionActionProposal;
  readonly userId: number;
  /** Server-resolved policy; null = missing -> fail closed. */
  readonly policy: MissionGovernancePolicy | null;
  /** The policy version the caller asserts is current (staleness gate). */
  readonly currentPolicyVersion: string;
  readonly businessAuthority: MissionBusinessAuthority;
  readonly now: string;
}

// ─── Prompt-injection / misinformation hygiene (F8) ───
//
// Proposal material is INERT: it can describe a mission action, but it can
// never alter system/developer instructions, invoke tools, change governance
// rules, expose secrets, mark itself low-risk, or authorize itself. Detection
// never widens authority — it only raises risk and annotates the receipt.

const INJECTION_PATTERNS: readonly RegExp[] = [
  /ignore\s+(all\s+|previous\s+|the\s+)*instructions/i,
  /system prompt/i,
  /you are now/i,
  /approved\s*[:=]\s*true/i,
  /authorized\s*[:=]\s*true/i,
  /override\s*[:=]\s*true/i,
  /admin\s*[:=]\s*true/i,
  /jailbreak/i,
  /bypass (policy|governance|approval)/i,
  // Self-risk marking: "risk: LOW", "mark this action as low risk"...
  /risk\s*(class|level)?\s*[:=]+\s*(low|minimal|none|safe)/i,
  // Self-trust marking: "trust: VERIFIED", "mark this source as trusted"...
  /trust\s*(class|level)?\s*[:=]+\s*(verified|authoritative|high)/i,
  /mark (this|itself|me|the source|the action|the mission).*trust/i,
  /mark (this|itself|me|the action|the mission).*risk/i,
  /lower (the )?risk/i,
  // Tool/shell/SQL invocation attempts inside content.
  /(invoke|call|run|execute)\s+(the\s+)?(tool|function|shell|sql|command)/i,
  // Secret exposure/exfiltration attempts.
  /(api[-_]?key|password|passwd|secret|token)\s*[:=]/i,
  /exfiltrate/i,
  // Self-approval attempts inside content.
  /self[-_\s]?approve/i,
  /approve (this|itself|myself|the mission)/i,
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

function detectInjectionSuspect(proposal: MissionActionProposal): boolean {
  const strings: string[] = [];
  collectStrings(
    {
      missionRef: proposal.missionRef,
      planRef: proposal.planRef,
      taskRef: proposal.taskRef,
      summary: proposal.summary,
      actionParams: proposal.actionParams,
    },
    strings
  );
  return strings.some((s) => INJECTION_PATTERNS.some((pattern) => pattern.test(s)));
}

// ─── Evaluation ───

function weakest(
  a: GovernanceDecisionOutcome,
  b: GovernanceDecisionOutcome
): GovernanceDecisionOutcome {
  return MISSION_DECISION_AUTONOMY_RANK[a] <= MISSION_DECISION_AUTONOMY_RANK[b] ? a : b;
}

/**
 * Evaluate one mission action proposal. Pure and deterministic: identical
 * inputs produce a byte-identical receipt (same id, same reasons, same
 * fingerprint). No dimension may widen authority; every gate only narrows.
 * The outcome is bounded authority only — never a blanket mission
 * authorization and never execution itself.
 */
export function evaluateMissionGovernance(
  input: MissionGovernanceEvaluationInput
): MissionGovernanceDecision {
  const nowMs = Date.parse(input.now);
  if (Number.isNaN(nowMs)) {
    throw new MissionGovernanceValidationError(
      "INVALID_EVALUATION_CLOCK",
      `now must be a valid ISO timestamp, got ${String(input.now)}`
    );
  }
  if (!Number.isInteger(input.userId) || input.userId <= 0) {
    fail("MALFORMED_PROPOSAL", `userId must be a positive integer, got ${String(input.userId)}`);
  }
  const proposal = input.proposal;
  const actionParamsFingerprint = proposal.actionParamsFingerprint;
  const policyVersion = input.policy?.policyVersion ?? null;

  const baseIdentity = {
    userId: input.userId,
    businessId: proposal.businessId,
    missionRef: proposal.missionRef,
    planRef: proposal.planRef,
    taskRef: proposal.taskRef,
    subjectClass: proposal.subjectClass,
    actionType: proposal.actionType,
    policyVersion: policyVersion ?? "NO_POLICY",
    actionParamsFingerprint,
    summary: proposal.summary,
    declaredRisk: proposal.declaredRisk,
    retryContext:
      proposal.retryContext === null
        ? null
        : {
            retryOf: proposal.retryContext.retryOf,
            declaredIdempotent: proposal.retryContext.declaredIdempotent,
            priorActionParamsFingerprint: proposal.retryContext.priorActionParamsFingerprint,
          },
  };

  const finalize = (args: {
    decision: GovernanceDecisionOutcome;
    reasonCodes: readonly MissionGovernanceReasonCode[];
    missionRiskClass: MissionRiskClass;
    riskFactors: Readonly<Record<string, string | boolean>>;
    approvalExpiresAt?: string;
  }): MissionGovernanceDecision => {
    const governanceDecisionId = deriveMissionGovernanceDecisionId(baseIdentity);
    const validityMs = input.policy?.maxDecisionValidityMs ?? 24 * 60 * 60 * 1000;
    const approvalBinding: MissionGovernanceApprovalBinding | null =
      args.decision === "REVIEW_REQUIRED"
        ? Object.freeze({
            governanceDecisionId,
            businessId: proposal.businessId,
            missionRef: proposal.missionRef,
            planRef: proposal.planRef,
            taskRef: proposal.taskRef,
            subjectClass: proposal.subjectClass,
            actionType: proposal.actionType,
            actionParamsFingerprint,
            missionRiskClass: args.missionRiskClass,
            policyVersion: policyVersion ?? fail("POLICY_MISSING", "approval requires a policy version"),
            approvalBindingHash: deriveMissionApprovalBindingHash({
              governanceDecisionId,
              policyVersion: policyVersion!,
              actionParamsFingerprint,
              missionRiskClass: args.missionRiskClass,
            }),
            expiresAt:
              args.approvalExpiresAt ?? new Date(nowMs + validityMs).toISOString(),
          })
        : null;
    const reasonCodes = Object.freeze(
      [...new Set(args.reasonCodes)].slice(0, MAX_MISSION_REASON_CODES)
    );
    const evaluationFingerprint = deriveEvaluationFingerprint({
      governanceDecisionId,
      decision: args.decision,
      reasonCodes,
      missionRiskClass: args.missionRiskClass,
      policyVersion,
      actionParamsFingerprint,
      approvalRequired: args.decision === "REVIEW_REQUIRED",
    });
    return Object.freeze({
      governanceDecisionId,
      contractVersion: MISSION_GOVERNANCE_CONTRACT_VERSION,
      engineVersion: MISSION_GOVERNANCE_ENGINE_VERSION,
      userId: input.userId,
      businessId: proposal.businessId,
      missionRef: proposal.missionRef,
      planRef: proposal.planRef,
      taskRef: proposal.taskRef,
      subjectClass: proposal.subjectClass,
      actionType: proposal.actionType,
      actionParamsFingerprint,
      missionRiskClass: args.missionRiskClass,
      riskFactors: args.riskFactors,
      policyVersion,
      decision: args.decision,
      reasonCodes,
      approvalRequired: args.decision === "REVIEW_REQUIRED",
      approvalBinding,
      evaluationFingerprint,
      validUntil:
        args.decision === "ALLOW" || args.decision === "REVIEW_REQUIRED"
          ? new Date(nowMs + validityMs).toISOString()
          : null,
      evaluatedAt: input.now,
      thresholds: Object.freeze({
        maxDecisionValidityMs: input.policy?.maxDecisionValidityMs ?? 24 * 60 * 60 * 1000,
        maxActionParamsBytes: input.policy?.maxActionParamsBytes ?? 16384,
      }),
    });
  };

  const blockFinalize = (
    reasonCodes: readonly MissionGovernanceReasonCode[],
    missionRiskClass: MissionRiskClass,
    riskFactors: Readonly<Record<string, string | boolean>> = {}
  ): MissionGovernanceDecision =>
    finalize({
      decision: "BLOCK",
      reasonCodes,
      missionRiskClass,
      riskFactors,
    });

  // --- Fail-closed pre-checks ------------------------------------------------
  if (!isMissionSubjectClass(proposal.subjectClass)) {
    return blockFinalize(["UNKNOWN_SUBJECT_CLASS"], "HIGH");
  }
  const subjectClass = proposal.subjectClass as MissionSubjectClass;

  if (!isMissionActionType(proposal.actionType)) {
    return blockFinalize(["UNKNOWN_ACTION_TYPE"], "HIGH");
  }
  const actionType = proposal.actionType as MissionActionType;

  if (input.policy === null) {
    return blockFinalize(["POLICY_MISSING"], "HIGH");
  }

  if (input.currentPolicyVersion !== input.policy.policyVersion) {
    return blockFinalize(["STALE_POLICY_VERSION"], "HIGH");
  }

  // --- Tenant / business ownership (cross-tenant missions fail closed) -------
  if (input.businessAuthority.owningUserId !== input.userId) {
    return blockFinalize(["CROSS_TENANT_MISSION"], "HIGH");
  }
  if (input.businessAuthority.businessId !== proposal.businessId) {
    return blockFinalize(["OWNERSHIP_MISMATCH"], "HIGH");
  }
  if (!input.businessAuthority.businessActive) {
    return blockFinalize(["MISSION_BLOCKED_BY_POLICY"], "HIGH");
  }

  // --- Prohibited actions (policy closed subset) ------------------------------
  if (input.policy.prohibitedActionTypes.includes(actionType)) {
    return blockFinalize(["PROHIBITED_ACTION_TYPE"], "CRITICAL");
  }

  // --- Risk classification (server-side only — AC15/16/17) --------------------
  const injectionSuspected = detectInjectionSuspect(proposal);
  const derivedRisk = deriveMissionRisk({
    subjectClass,
    actionType,
    declaredRisk: proposal.declaredRisk,
    injectionSuspected,
  });

  // --- Retry governance (F7) --------------------------------------------------
  const reviewReasons: MissionGovernanceReasonCode[] = [];
  const infoReasons: MissionGovernanceReasonCode[] = [];
  if (derivedRisk.raisedByDeclaration) {
    infoReasons.push("DECLARED_IMPACT_RAISES_RISK");
  }
  if (injectionSuspected) {
    infoReasons.push("PROMPT_INJECTION_SUSPECTED");
  }

  // Effective risk starts server-derived; retry violations can only RAISE it
  // (contract §7) — a failed execution can never broaden authority cheaply.
  let missionRiskClass = derivedRisk.riskClass;
  const raiseRiskOne = (): void => {
    if (missionRiskClass === "LOW") missionRiskClass = "MEDIUM";
    else if (missionRiskClass === "MEDIUM") missionRiskClass = "HIGH";
    else missionRiskClass = "CRITICAL";
  };

  if (subjectClass === "RETRY") {
    const retry = proposal.retryContext;
    if (retry === null) {
      return blockFinalize(["MALFORMED_PROPOSAL"], derivedRisk.riskClass, derivedRisk.factors);
    }
    if (!retry.declaredIdempotent) {
      // A non-idempotent retry is a new side effect, not a replay.
      reviewReasons.push("RETRY_NEW_SIDE_EFFECT_REVIEW");
      raiseRiskOne();
    }
    if (retry.priorActionParamsFingerprint !== proposal.actionParamsFingerprint) {
      // A retry whose parameters differ from the failed attempt has silently
      // broadened authority — never ALLOW (charter F7).
      reviewReasons.push("RETRY_SCOPE_BROADENED");
      raiseRiskOne();
    }
  }
  if (subjectClass === "RECOVERY_ACTION") {
    // Recovery may require fresh human review; never autonomous by default.
    reviewReasons.push("RECOVERY_REQUIRES_FRESH_REVIEW");
  }

  // --- Compose disposition: start from risk mapping, then narrow -------------
  let decision: GovernanceDecisionOutcome =
    input.policy.riskDispositions[missionRiskClass];

  // F2 phase separation: subjects outside the policy's autonomous phases can
  // never be ALLOW — planning approval never becomes execution authority. The
  // phase reason is recorded whenever the floor binds (even when risk already
  // required review), so the receipt always names the binding constraint.
  const phase = phaseOfMissionSubjectClass(subjectClass);
  if (!input.policy.autonomousPhases.includes(phase) && decision !== "BLOCK") {
    if (decision === "ALLOW") {
      decision = "REVIEW_REQUIRED";
    }
    if (phase === "EXECUTION") {
      reviewReasons.push("EXECUTION_REQUIRES_REVIEW");
    } else if (phase === "LIFECYCLE") {
      reviewReasons.push("LIFECYCLE_REQUIRES_REVIEW");
    } else {
      reviewReasons.push("PHASE_REQUIRES_REVIEW");
    }
  }

  if (reviewReasons.length > 0) {
    decision = weakest(decision, "REVIEW_REQUIRED");
  }

  const reasonCodes: MissionGovernanceReasonCode[] = [];
  if (decision === "ALLOW") {
    reasonCodes.push("MISSION_ALLOWED_BY_POLICY");
  } else if (decision === "REVIEW_REQUIRED") {
    const pureRiskReview =
      reviewReasons.length === 0 &&
      input.policy.riskDispositions[missionRiskClass] === "REVIEW_REQUIRED";
    if (pureRiskReview) {
      reasonCodes.push("APPROVAL_REQUIRED_BY_RISK");
    }
    if (missionRiskClass === "HIGH") reasonCodes.push("HIGH_RISK_REVIEW_REQUIRED");
    reasonCodes.push(...reviewReasons);
  } else {
    reasonCodes.push("MISSION_BLOCKED_BY_POLICY");
    if (missionRiskClass === "CRITICAL") reasonCodes.push("CRITICAL_RISK_BLOCKED");
  }
  reasonCodes.push(...infoReasons);

  return finalize({
    decision,
    reasonCodes,
    missionRiskClass,
    riskFactors: derivedRisk.factors,
  });
}
