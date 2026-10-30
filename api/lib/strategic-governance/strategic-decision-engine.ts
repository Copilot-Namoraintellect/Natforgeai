// ─── R8-F Strategic Intelligence Governance — pure decision engine ───
//
//   strategic recommendation proposal (material only)
//   + business policy (versioned, server-side)
//   + SERVER-RESOLVED evidence records + trusted-source registry (provider seam)
//   + derived evidence trust (F3) / bounded confidence / strategic risk (F4)
//   + current business state (tenant-anchored ownership)
//   -> immutable governance decision
//      (ALLOW_RECOMMENDATION / REVIEW_REQUIRED / BLOCK — never EXECUTE)
//
// Guarantees:
// - fail closed on unknown recommendation types, missing/stale policy,
//   ownership mismatch, cross-tenant proposals/evidence, zero or absent
//   evidence, malformed evidence descriptors, and stale evidence on
//   high-impact claims;
// - authority only ever narrows: each dimension may reduce the disposition,
//   none may widen it (charter F7);
// - external/model/agent content is inert proposal material — injection
//   suspicion only ever raises risk, never widens authority (F6);
// - evidence trust, confidence and risk are SERVER-DERIVED: the client can
//   never supply them, and nothing in this module can be used to lower its
//   own risk, raise its own trust, or raise its own confidence (AC29/30);
// - deterministic decision identity: one proposal material + one evidence
//   fingerprint + one policy version -> one stable governanceDecisionId;
//   retries converge;
// - no clock access beyond the caller-supplied `now`, no side effects:
//   nothing is executed, sent, launched, mutated, charged or persisted here.

import {
  deriveApprovalBindingHash,
  deriveEvaluationFingerprint,
  deriveGovernanceDecisionId,
  deriveEvidenceFingerprint,
  deriveProposalFingerprint,
  STRATEGIC_DECISION_AUTONOMY_RANK,
  isIsoUtc,
  isStrategicConfidenceClass,
  MAX_STRATEGIC_REASON_CODES,
  STRATEGIC_GOVERNANCE_CONTRACT_VERSION,
  STRATEGIC_GOVERNANCE_ENGINE_VERSION,
  StrategicGovernanceInputError,
  StrategicGovernanceValidationError,
  type StrategicGovernanceErrorCode,
  type StrategicGovernanceDecision as GovernanceDecisionOutcome,
  type StrategicGovernanceReasonCode,
  type StrategicConfidenceClass,
  type StrategicEvidenceTrustClass,
  type StrategicRiskClass,
  PROPOSAL_ID_PATTERN,
  EVIDENCE_REF_PATTERN,
} from "./strategic-governance-contract";
import {
  isStrategicRecommendationType,
  type StrategicRecommendationType,
} from "./strategic-recommendation-taxonomy";
import {
  aggregateEvidence,
  boundConfidence,
  deriveEvidenceTrust,
  type DerivedEvidence,
} from "./strategic-evidence-governance";
import {
  deriveStrategicRisk,
  EMPTY_DECLARED_IMPACT,
  STRATEGIC_IMPACT_DECLARATIONS,
  type StrategicDeclaredImpact,
} from "./strategic-risk-classification";
import type { StrategicGovernancePolicy } from "./strategic-policy";

// ─── Proposal contract (validated evaluation input) ───

/**
 * The canonical strategic recommendation proposal. Clients (R8 reasoning
 * agents) supply MATERIAL only: NO decision, risk class, confidence class,
 * source trust class, reason codes, approval state or policy content. Any
 * such field fails closed at build. The only confidence admitted is a CLAIM
 * that the server bounds by evidence quality; the only risk signals admitted
 * are impact DECLARATIONS that can only raise server-derived risk.
 */
export interface StrategicProposal {
  readonly proposalId: string;
  readonly businessId: number;
  /** Closed taxonomy type; unknown values flow through and are BLOCKED. */
  readonly recommendationType: string;
  /** Recommendation narrative (bounded; inert external content — F6). */
  readonly summary: string;
  /** Opaque evidence references resolved server-side against canonical stores. */
  readonly evidenceRefs: readonly string[];
  /** Agent-claimed confidence; bounded by the evidence ceiling. */
  readonly claimedConfidence: StrategicConfidenceClass;
  /** Impact declarations; each can only raise derived risk. */
  readonly declaredImpact: StrategicDeclaredImpact;
  readonly requestedAt: string;
}

const MAX_SUMMARY_LENGTH = 4000;
const MAX_EVIDENCE_REFS = 64;

const FORBIDDEN_CLIENT_AUTHORITY_FIELDS = [
  "decision",
  "riskClass",
  "strategicRiskClass",
  "risk",
  "riskLevel",
  "confidenceClass",
  "derivedConfidence",
  "sourceTrustClass",
  "trustClass",
  "trust",
  "evidenceTrust",
  "reasonCodes",
  "approvalRequired",
  "approvalStatus",
  "approved",
  "authorized",
  "executable",
  "execution",
  "policyVersion",
  "governanceDecisionId",
  "evidenceFingerprint",
  "evaluationFingerprint",
  "authority",
  "override",
  "ignorePolicy",
  "admin",
  "forceAllow",
  "forceApprove",
  "forceComplete",
  "setApproved",
  "setTrusted",
  "overrideRisk",
  "overridePolicy",
  "overrideConfidence",
  "promoteTrust",
  "lowerRisk",
  "raiseConfidence",
] as const;

function fail(code: StrategicGovernanceErrorCode, message: string): never {
  throw new StrategicGovernanceInputError(code, message);
}

function assertNoClientAuthorityFields(input: Record<string, unknown>): void {
  for (const key of FORBIDDEN_CLIENT_AUTHORITY_FIELDS) {
    if (key in input) {
      throw new StrategicGovernanceValidationError(
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

function validateDeclaredImpact(raw: unknown): StrategicDeclaredImpact {
  if (raw === null || raw === undefined) return EMPTY_DECLARED_IMPACT;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    fail("MALFORMED_PROPOSAL", "declaredImpact must be an object");
  }
  const r = raw as Record<string, unknown>;
  const out: Record<string, boolean> = {};
  for (const key of STRATEGIC_IMPACT_DECLARATIONS) {
    const v = r[key];
    if (v === undefined) {
      out[key] = false;
      continue;
    }
    if (typeof v !== "boolean") {
      fail("MALFORMED_PROPOSAL", `declaredImpact.${key} must be a boolean`);
    }
    out[key] = v;
  }
  // Unknown keys in declaredImpact are ignored: declarations are material,
  // not authority, and the closed list above is the only thing that can
  // raise risk. (z.strictObject at the router layer still rejects
  // authority-shaped top-level keys.)
  return out as unknown as StrategicDeclaredImpact;
}

/**
 * Validate and normalise raw proposal input. Throws
 * StrategicGovernanceValidationError / StrategicGovernanceInputError on any
 * malformed or authority-smuggling input (fail closed). An unknown
 * recommendationType string is NOT rejected here — the engine BLOCKs it as a
 * governed decision so the attempt is durably auditable.
 */
export function buildStrategicProposal(raw: unknown): StrategicProposal {
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
  if (
    typeof r.recommendationType !== "string" ||
    r.recommendationType.trim().length === 0 ||
    r.recommendationType.length > 48
  ) {
    fail("MALFORMED_PROPOSAL", "recommendationType must be a non-blank string <= 48 chars");
  }
  if (typeof r.summary !== "string" || r.summary.trim().length === 0) {
    fail("MALFORMED_PROPOSAL", "summary must be a non-blank string");
  }
  if (r.summary.length > MAX_SUMMARY_LENGTH) {
    fail("MALFORMED_PROPOSAL", `summary must be <= ${MAX_SUMMARY_LENGTH} chars`);
  }
  if (!Array.isArray(r.evidenceRefs) || r.evidenceRefs.length === 0) {
    fail("INSUFFICIENT_EVIDENCE", "evidenceRefs must be a non-empty array");
  }
  if (r.evidenceRefs.length > MAX_EVIDENCE_REFS) {
    fail("MALFORMED_PROPOSAL", `evidenceRefs must be <= ${MAX_EVIDENCE_REFS} refs`);
  }
  const evidenceRefs: string[] = [];
  for (const ref of r.evidenceRefs) {
    if (typeof ref !== "string" || !EVIDENCE_REF_PATTERN.test(ref)) {
      fail("MALFORMED_PROPOSAL", `each evidence ref must match ${EVIDENCE_REF_PATTERN}`);
    }
    evidenceRefs.push(ref);
  }
  if (!isStrategicConfidenceClass(r.claimedConfidence)) {
    fail("MALFORMED_PROPOSAL", "claimedConfidence must be a closed confidence class");
  }

  return Object.freeze({
    proposalId: r.proposalId,
    businessId: r.businessId,
    recommendationType: r.recommendationType,
    summary: r.summary,
    evidenceRefs: Object.freeze(evidenceRefs),
    claimedConfidence: r.claimedConfidence,
    declaredImpact: validateDeclaredImpact(r.declaredImpact),
    requestedAt: assertIso(r.requestedAt, "requestedAt"),
  });
}

// ─── Business authority (server-resolved ownership) ───

export interface StrategicBusinessAuthority {
  readonly businessId: number;
  readonly owningUserId: number;
  readonly businessActive: boolean;
}

// ─── The durable, immutable governance decision (F1) ───

export interface StrategicGovernanceApprovalBinding {
  readonly governanceDecisionId: string;
  readonly proposalId: string;
  readonly businessId: number;
  readonly policyVersion: string;
  readonly proposalFingerprint: string;
  readonly evidenceFingerprint: string;
  readonly approvalBindingHash: string;
  readonly expiresAt: string;
}

export interface StrategicGovernanceDecision {
  readonly governanceDecisionId: string;
  readonly contractVersion: string;
  readonly engineVersion: string;
  readonly userId: number;
  readonly businessId: number;
  readonly proposalId: string;
  /** The closed recommendation type (proposalType in the durable record). */
  readonly recommendationType: string;
  readonly evidenceRefs: readonly string[];
  readonly sourceTrustClass: StrategicEvidenceTrustClass;
  readonly confidenceClass: StrategicConfidenceClass;
  readonly strategicRiskClass: StrategicRiskClass;
  readonly policyVersion: string | null;
  readonly decision: GovernanceDecisionOutcome;
  readonly reasonCodes: readonly StrategicGovernanceReasonCode[];
  readonly approvalRequired: boolean;
  readonly approvalBinding: StrategicGovernanceApprovalBinding | null;
  readonly evidenceFingerprint: string;
  readonly proposalFingerprint: string;
  readonly validUntil: string | null;
  readonly evaluatedAt: string;
  readonly evaluationFingerprint: string;
  /** Bounded snapshot of the policy thresholds used at evaluation time. */
  readonly thresholds: Readonly<Record<string, number>>;
}

export interface StrategicGovernanceEvaluationInput {
  readonly proposal: StrategicProposal;
  readonly userId: number;
  /** Server-resolved policy; null = missing -> fail closed. */
  readonly policy: StrategicGovernancePolicy | null;
  /** The policy version the caller asserts is current (staleness gate). */
  readonly currentPolicyVersion: string;
  readonly businessAuthority: StrategicBusinessAuthority;
  /** Raw provider resolutions keyed by evidenceRef (null = absent/forged). */
  readonly resolvedEvidenceByRef: ReadonlyMap<string, unknown>;
  /** Server-side registered/trusted external source keys for this tenant. */
  readonly trustedSourceKeys: ReadonlySet<string>;
  readonly now: string;
}

// ─── Prompt-injection / misinformation hygiene (F6) ───
//
// External and model-generated content is INERT evidence: it can inform a
// recommendation, but it can never alter system/developer instructions,
// invoke tools, change governance rules, expose secrets, change business
// authority, mark itself trustworthy, or create recommendations directly.
// Detection never widens authority — it only raises risk and annotates the
// decision, so manipulated signals are contained by construction.

const INJECTION_PATTERNS: readonly RegExp[] = [
  /ignore (all |previous |the )?instructions/i,
  /system prompt/i,
  /you are now/i,
  /approved\s*[:=]\s*true/i,
  /override\s*[:=]\s*true/i,
  /admin\s*[:=]\s*true/i,
  /jailbreak/i,
  /bypass (policy|governance|approval)/i,
  // Self-trust marking: "trust: VERIFIED", "mark this source as trusted"...
  /trust\s*(class|level)?\s*[:=]\s*(verified|authoritative|high)/i,
  /mark (this|itself|me|the source).*trust/i,
  // Tool/shell/SQL invocation attempts inside content.
  /(invoke|call|run|execute)\s+(the\s+)?(tool|function|shell|sql|command)/i,
  // Secret exposure/exfiltration attempts.
  /(api[-_]?key|password|passwd|secret|token)\s*[:=]/i,
  /exfiltrate/i,
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

function detectInjectionSuspect(proposal: StrategicProposal): boolean {
  const strings: string[] = [];
  collectStrings(
    {
      proposalId: proposal.proposalId,
      recommendationType: proposal.recommendationType,
      summary: proposal.summary,
      evidenceRefs: proposal.evidenceRefs,
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
  return STRATEGIC_DECISION_AUTONOMY_RANK[a] <= STRATEGIC_DECISION_AUTONOMY_RANK[b] ? a : b;
}

function confidenceMeets(
  confidence: StrategicConfidenceClass,
  floor: StrategicConfidenceClass
): boolean {
  const RANK: Record<StrategicConfidenceClass, number> = { NONE: 0, LOW: 1, MEDIUM: 2, HIGH: 3 };
  return RANK[confidence] >= RANK[floor];
}

/**
 * Evaluate one strategic recommendation proposal. Pure and deterministic:
 * identical inputs produce a byte-identical decision (same id, same reasons,
 * same fingerprint). No dimension may widen authority; every gate only narrows.
 * The outcome is advisory authority only — never execution authority.
 */
export function evaluateStrategicGovernance(
  input: StrategicGovernanceEvaluationInput
): StrategicGovernanceDecision {
  const nowMs = Date.parse(input.now);
  if (Number.isNaN(nowMs)) {
    throw new StrategicGovernanceValidationError(
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

  // --- Resolve + derive evidence trust (server-side only, F3) ---------------
  const derivedEvidence: DerivedEvidence[] = proposal.evidenceRefs.map((ref) =>
    deriveEvidenceTrust({
      evidenceRef: ref,
      resolved: input.resolvedEvidenceByRef.get(ref),
      userId: input.userId,
      businessId: proposal.businessId,
      trustedSourceKeys: input.trustedSourceKeys,
      nowMs,
      maxEvidenceAgeMs: input.policy?.maxEvidenceAgeMs ?? 30 * 24 * 60 * 60 * 1000,
    })
  );
  const aggregate = aggregateEvidence({ derived: derivedEvidence });
  const evidenceFingerprint = deriveEvidenceFingerprint(derivedEvidence);

  const baseIdentity = {
    userId: input.userId,
    businessId: proposal.businessId,
    proposalId: proposal.proposalId,
    recommendationType: proposal.recommendationType,
    policyVersion: policyVersion ?? "NO_POLICY",
    proposalFingerprint,
    evidenceFingerprint,
  };

  const finalize = (args: {
    decision: GovernanceDecisionOutcome;
    reasonCodes: readonly StrategicGovernanceReasonCode[];
    strategicRiskClass: StrategicRiskClass;
    confidenceClass: StrategicConfidenceClass;
    thresholds: Readonly<Record<string, number>>;
  }): StrategicGovernanceDecision => {
    const governanceDecisionId = deriveGovernanceDecisionId(baseIdentity);
    const approvalBinding: StrategicGovernanceApprovalBinding | null =
      args.decision === "REVIEW_REQUIRED"
        ? Object.freeze({
            governanceDecisionId,
            proposalId: proposal.proposalId,
            businessId: proposal.businessId,
            policyVersion: policyVersion ?? fail("POLICY_MISSING", "approval requires a policy version"),
            proposalFingerprint,
            evidenceFingerprint,
            approvalBindingHash: deriveApprovalBindingHash({
              governanceDecisionId,
              policyVersion: policyVersion!,
              proposalFingerprint,
              evidenceFingerprint,
            }),
            expiresAt: new Date(
              nowMs + (input.policy?.maxDecisionValidityMs ?? 24 * 60 * 60 * 1000)
            ).toISOString(),
          })
        : null;
    const reasonCodes = Object.freeze(
      [...new Set(args.reasonCodes)].slice(0, MAX_STRATEGIC_REASON_CODES)
    );
    const evaluationFingerprint = deriveEvaluationFingerprint({
      governanceDecisionId,
      decision: args.decision,
      reasonCodes,
      strategicRiskClass: args.strategicRiskClass,
      confidenceClass: args.confidenceClass,
      sourceTrustClass: aggregate.sourceTrustClass,
      policyVersion,
      proposalFingerprint,
      approvalRequired: args.decision === "REVIEW_REQUIRED",
    });
    return Object.freeze({
      governanceDecisionId,
      contractVersion: STRATEGIC_GOVERNANCE_CONTRACT_VERSION,
      engineVersion: STRATEGIC_GOVERNANCE_ENGINE_VERSION,
      userId: input.userId,
      businessId: proposal.businessId,
      proposalId: proposal.proposalId,
      recommendationType: proposal.recommendationType,
      evidenceRefs: proposal.evidenceRefs,
      sourceTrustClass: aggregate.sourceTrustClass,
      confidenceClass: args.confidenceClass,
      strategicRiskClass: args.strategicRiskClass,
      policyVersion,
      decision: args.decision,
      reasonCodes,
      approvalRequired: args.decision === "REVIEW_REQUIRED",
      approvalBinding,
      evidenceFingerprint,
      proposalFingerprint,
      validUntil:
        args.decision === "ALLOW_RECOMMENDATION" || args.decision === "REVIEW_REQUIRED"
          ? new Date(nowMs + (input.policy?.maxDecisionValidityMs ?? 24 * 60 * 60 * 1000)).toISOString()
          : null,
      evaluatedAt: input.now,
      evaluationFingerprint,
      thresholds: args.thresholds,
    });
  };

  const blockFinalize = (
    reasonCodes: readonly StrategicGovernanceReasonCode[],
    strategicRiskClass: StrategicRiskClass,
    confidenceClass: StrategicConfidenceClass
  ): StrategicGovernanceDecision =>
    finalize({
      decision: "BLOCK",
      reasonCodes,
      strategicRiskClass,
      confidenceClass,
      thresholds: {},
    });

  // --- Fail-closed pre-checks ------------------------------------------------
  if (!isStrategicRecommendationType(proposal.recommendationType)) {
    return blockFinalize(["UNKNOWN_RECOMMENDATION_TYPE"], "HIGH", "NONE");
  }
  const recommendationType = proposal.recommendationType as StrategicRecommendationType;

  if (input.policy === null) {
    return blockFinalize(["POLICY_MISSING"], "HIGH", "NONE");
  }

  if (input.currentPolicyVersion !== input.policy.policyVersion) {
    return blockFinalize(["STALE_POLICY_VERSION"], "HIGH", "NONE");
  }

  // --- Tenant / business ownership (cross-tenant proposals fail closed) ------
  if (input.businessAuthority.owningUserId !== input.userId) {
    return blockFinalize(["CROSS_TENANT_PROPOSAL"], "HIGH", "NONE");
  }
  if (input.businessAuthority.businessId !== proposal.businessId) {
    return blockFinalize(["OWNERSHIP_MISMATCH"], "HIGH", "NONE");
  }
  if (!input.businessAuthority.businessActive) {
    return blockFinalize(["RECOMMENDATION_BLOCKED_BY_POLICY"], "HIGH", "NONE");
  }

  // --- Evidence gates ---------------------------------------------------------
  const crossTenantEvidence = derivedEvidence.filter((d) =>
    d.notes.includes("CROSS_TENANT_EVIDENCE")
  );
  if (crossTenantEvidence.length > 0) {
    return blockFinalize(["CROSS_TENANT_EVIDENCE"], "HIGH", "NONE");
  }
  const usableEvidence = derivedEvidence.filter((d) => d.trustClass !== "MALFORMED");
  if (usableEvidence.length === 0) {
    return blockFinalize(
      derivedEvidence.some((d) => d.trustClass === "MALFORMED")
        ? ["MALFORMED_EVIDENCE"]
        : ["INSUFFICIENT_EVIDENCE"],
      "HIGH",
      "NONE"
    );
  }

  // --- Confidence derivation (bounded by evidence quality — AC8/AC9/AC10) ----
  const confidenceCeiling = aggregate.confidenceCeiling;
  const derivedConfidence = boundConfidence(proposal.claimedConfidence, confidenceCeiling);
  const infoReasons: StrategicGovernanceReasonCode[] = [];
  if (
    derivedConfidence !== proposal.claimedConfidence ||
    (confidenceCeiling !== "HIGH" && proposal.claimedConfidence === "HIGH")
  ) {
    infoReasons.push("CONFIDENCE_BOUNDED_BY_EVIDENCE");
  }
  for (const d of derivedEvidence) {
    for (const note of d.notes) {
      if (
        note === "CONTRADICTED_EVIDENCE_PRESENT" ||
        note === "MODEL_GENERATED_NOT_SOURCE_TRUTH"
      ) {
        infoReasons.push(note);
      }
    }
  }

  // --- Risk classification (server-side only — AC29) --------------------------
  const weakExternalEvidenceReliance =
    aggregate.sourceTrustClass === "SINGLE_EXTERNAL_SOURCE" ||
    aggregate.sourceTrustClass === "UNVERIFIED";
  const injectionSuspected = detectInjectionSuspect(proposal);
  const derivedRisk = deriveStrategicRisk({
    recommendationType,
    declaredImpact: proposal.declaredImpact,
    weakExternalEvidenceReliance,
    injectionSuspected,
  });
  if (derivedRisk.raisedByDeclaration) {
    infoReasons.push("DECLARED_IMPACT_RAISES_RISK");
  }
  if (injectionSuspected) {
    // Containment, never widening (F6): injection suspicion can only raise
    // risk so the proposal can never flow autonomously.
    infoReasons.push("PROMPT_INJECTION_SUSPECTED");
  }

  // --- Staleness (stale evidence cannot justify current claims — AC11) --------
  const blockReasons: StrategicGovernanceReasonCode[] = [];
  const reviewReasons: StrategicGovernanceReasonCode[] = [];
  const highImpact =
    derivedRisk.riskClass === "HIGH" || derivedRisk.riskClass === "CRITICAL";
  if (aggregate.anyStale) {
    if (highImpact) {
      blockReasons.push("STALE_EVIDENCE");
    } else {
      reviewReasons.push("STALE_EVIDENCE");
    }
  }

  // --- Compose disposition: start from risk mapping, then narrow -------------
  let decision: GovernanceDecisionOutcome = input.policy.riskDispositions[derivedRisk.riskClass];
  if (decision === "ALLOW_RECOMMENDATION" && derivedRisk.riskClass !== "LOW") {
    // Defensive: policy validation should prevent this; never allow above LOW.
    decision = "REVIEW_REQUIRED";
  }
  if (!confidenceMeets(derivedConfidence, input.policy.minConfidenceForAutonomousRecommendation)) {
    decision = weakest(decision, "REVIEW_REQUIRED");
    reviewReasons.push("INSUFFICIENT_CONFIDENCE");
  }
  if (
    highImpact &&
    !confidenceMeets(derivedConfidence, input.policy.minConfidenceForHighImpact)
  ) {
    decision = weakest(decision, "REVIEW_REQUIRED");
    reviewReasons.push("HIGH_IMPACT_REQUIRES_STRONG_EVIDENCE");
  }
  if (reviewReasons.length > 0) {
    decision = weakest(decision, "REVIEW_REQUIRED");
  }
  if (blockReasons.length > 0) {
    decision = "BLOCK";
  }

  const reasonCodes: StrategicGovernanceReasonCode[] = [];
  if (decision === "ALLOW_RECOMMENDATION") {
    reasonCodes.push("RECOMMENDATION_ALLOWED_BY_POLICY");
  } else if (decision === "REVIEW_REQUIRED") {
    // Pure risk-driven review (no confidence/staleness driver): name it as such.
    // Otherwise the specific review reasons appended below carry the explanation.
    if (
      blockReasons.length === 0 &&
      reviewReasons.length === 0 &&
      input.policy.riskDispositions[derivedRisk.riskClass] === "REVIEW_REQUIRED"
    ) {
      reasonCodes.push("APPROVAL_REQUIRED_BY_RISK");
    }
    if (derivedRisk.riskClass === "HIGH") reasonCodes.push("HIGH_RISK_REVIEW_REQUIRED");
  } else {
    reasonCodes.push(blockReasons[0] ?? "RECOMMENDATION_BLOCKED_BY_POLICY");
    if (derivedRisk.riskClass === "CRITICAL") reasonCodes.push("CRITICAL_RISK_BLOCKED");
  }
  reasonCodes.push(...blockReasons, ...reviewReasons, ...infoReasons);

  const thresholds: Record<string, number> = {
    minConfidenceForAutonomousRecommendation: confidenceRank(
      input.policy.minConfidenceForAutonomousRecommendation
    ),
    minConfidenceForHighImpact: confidenceRank(input.policy.minConfidenceForHighImpact),
    maxEvidenceAgeMs: input.policy.maxEvidenceAgeMs,
  };

  return finalize({
    decision,
    reasonCodes,
    strategicRiskClass: derivedRisk.riskClass,
    confidenceClass: derivedConfidence,
    thresholds: Object.freeze(thresholds),
  });
}

function confidenceRank(c: StrategicConfidenceClass): number {
  const RANK: Record<StrategicConfidenceClass, number> = { NONE: 0, LOW: 1, MEDIUM: 2, HIGH: 3 };
  return RANK[c];
}
