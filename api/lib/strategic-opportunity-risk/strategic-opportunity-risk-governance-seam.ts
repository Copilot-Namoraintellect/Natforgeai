// ─── R8-E Strategic Opportunity & Risk — R8-F governance seam (E7) ───
//
// R8-F (strategic-governance/v1, frozen 44118e3) is MANDATORY for every
// candidate (contract §7). This seam:
//
//   1. Mirrors the frozen R8-F decision shape + validates every engine
//      payload at the boundary (untrusted until accepted).
//   2. `StrategicGovernanceEnginePort` — the narrow propose surface. A
//      registration port binds the authority; absence fails closed
//      (GOVERNANCE_AUTHORITY_UNAVAILABLE) — candidates are never voiced on
//      guessed governance.
//   3. `assertCandidateConsumable` — the single fail-closed gate turning a
//      stored decision (+ approval where required) into consumption
//      eligibility with authorityScope RECOMMENDATION_ONLY. This stream never
//      re-derives governance logic and never writes approvals.
//   4. `FakeDefaultPolicyGovernancePort` — TEST-ONLY double implementing the
//      published default-policy semantics (risk dispositions, confidence
//      floor, injection suspicion, approval binding) for isolated acceptance
//      runs. NOT canonical authority.
//
// There is deliberately NO second governance engine here and NO EXECUTE
// outcome anywhere.

import { sql } from "drizzle-orm";
import { getDb } from "../../queries/connection";
import {
  fail,
  GOVERNANCE_DECISION_ID_PATTERN,
  HEX_64_PATTERN,
  STRATEGIC_GOVERNANCE_DECISIONS,
  STRATEGIC_RISK_CLASSES,
  canonicalJson,
  sha256Hex,
  type StrategicGovernanceDecisionLabel,
  type StrategicRiskClass,
} from "./strategic-opportunity-risk-contract";
import {
  deriveApprovalBindingHash,
  parseStrategicApprovalBinding,
  STRATEGIC_RECOMMENDATION_APPROVAL_TYPE,
  type StrategicApprovalBindingRecord,
} from "./strategic-opportunity-risk-reasoning-seam";

// ─── Frozen R8-F constants (strategic-governance/v1 @ 44118e3) ───

export const STRATEGIC_GOVERNANCE_CONTRACT_VERSION = "strategic-governance/v1" as const;
export const STRATEGIC_GOVERNANCE_ENGINE_VERSION = "strategic-governance-engine/v1" as const;
export const STRATEGIC_GOVERNANCE_POLICY_VERSION = "strategic-governance-policy/v1" as const;
export const STRATEGIC_GOVERNANCE_APPROVAL_CONTRACT = "strategic-governance/approval@v1" as const;

export const STRATEGIC_GOVERNANCE_DECISION_ID_PREFIX = "sgd1:" as const;
export const PROPOSAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

function isIsoUtc(value: unknown): value is string {
  return typeof value === "string" && ISO_UTC_PATTERN.test(value);
}

export const STRATEGIC_RISK_DISPOSITIONS = Object.freeze({
  LOW: "ALLOW_RECOMMENDATION",
  MEDIUM: "REVIEW_REQUIRED",
  HIGH: "REVIEW_REQUIRED",
  CRITICAL: "BLOCK",
} as const);

export const MIN_CONFIDENCE_FOR_AUTONOMOUS_RECOMMENDATION = "MEDIUM" as const;
export const STRATEGIC_GOVERNANCE_MAX_DECISION_VALIDITY_MS = 24 * 60 * 60 * 1000;

/** Closed R8-F recommendation taxonomy (mirror of F's taxonomy). */
export const STRATEGIC_RECOMMENDATION_TYPES = [
  "STRATEGIC_OBSERVATION",
  "STRATEGIC_HYPOTHESIS",
  "MARKET_RESPONSE_RECOMMENDATION",
  "RESOURCE_PRIORITY_RECOMMENDATION",
  "CHANNEL_STRATEGY_RECOMMENDATION",
  "PRODUCT_MARKETING_RECOMMENDATION",
] as const;

// ─── Frozen decision view ───

export interface StrategicGovernanceDecisionView {
  readonly governanceDecisionId: string;
  readonly proposalId: string;
  readonly businessId: number;
  readonly recommendationType: string;
  readonly decision: StrategicGovernanceDecisionLabel;
  readonly policyVersion: string;
  readonly evidenceFingerprint: string;
  readonly proposalFingerprint: string;
  readonly strategicRiskClass: StrategicRiskClass;
  readonly confidenceClass: string;
  readonly sourceTrustClass: string;
  readonly approvalRequired: boolean;
  readonly reasonCodes: readonly string[];
  readonly validUntil: string | null;
}

/** Validate an untrusted engine payload; fail closed on any deviation. */
export function validateStrategicGovernanceDecisionView(raw: unknown): StrategicGovernanceDecisionView {
  if (typeof raw !== "object" || raw === null) {
    fail("GOVERNANCE_DECISION_MALFORMED", "governance engine returned a non-object decision");
  }
  const r = raw as Record<string, unknown>;
  const id = r.governanceDecisionId;
  if (typeof id !== "string" || !GOVERNANCE_DECISION_ID_PATTERN.test(id)) {
    fail("GOVERNANCE_DECISION_MALFORMED", "governance decision has malformed governanceDecisionId");
  }
  if (typeof r.proposalId !== "string" || !PROPOSAL_ID_PATTERN.test(r.proposalId)) {
    fail("GOVERNANCE_DECISION_MALFORMED", "governance decision has malformed proposalId");
  }
  if (typeof r.businessId !== "number" || !Number.isInteger(r.businessId) || r.businessId <= 0) {
    fail("GOVERNANCE_DECISION_MALFORMED", "governance decision has malformed businessId");
  }
  if (typeof r.recommendationType !== "string") {
    fail("GOVERNANCE_DECISION_MALFORMED", "governance decision has malformed recommendationType");
  }
  const decision = r.decision;
  if (typeof decision !== "string" || !(STRATEGIC_GOVERNANCE_DECISIONS as readonly string[]).includes(decision)) {
    fail("GOVERNANCE_DECISION_MALFORMED", `governance decision has unknown decision ${String(decision)}`);
  }
  if (r.policyVersion !== STRATEGIC_GOVERNANCE_POLICY_VERSION) {
    fail("GOVERNANCE_DECISION_MALFORMED", "governance decision binds an unknown policy version");
  }
  if (typeof r.evidenceFingerprint !== "string" || !HEX_64_PATTERN.test(r.evidenceFingerprint)) {
    fail("GOVERNANCE_DECISION_MALFORMED", "governance decision has malformed evidenceFingerprint");
  }
  if (typeof r.proposalFingerprint !== "string" || !HEX_64_PATTERN.test(r.proposalFingerprint)) {
    fail("GOVERNANCE_DECISION_MALFORMED", "governance decision has malformed proposalFingerprint");
  }
  if (typeof r.strategicRiskClass !== "string" || !(STRATEGIC_RISK_CLASSES as readonly string[]).includes(r.strategicRiskClass)) {
    fail("GOVERNANCE_DECISION_MALFORMED", "governance decision has malformed strategicRiskClass");
  }
  if (typeof r.confidenceClass !== "string") {
    fail("GOVERNANCE_DECISION_MALFORMED", "governance decision has malformed confidenceClass");
  }
  if (typeof r.sourceTrustClass !== "string") {
    fail("GOVERNANCE_DECISION_MALFORMED", "governance decision has malformed sourceTrustClass");
  }
  if (typeof r.approvalRequired !== "boolean") {
    fail("GOVERNANCE_DECISION_MALFORMED", "governance decision has malformed approvalRequired");
  }
  if (!Array.isArray(r.reasonCodes) || r.reasonCodes.length > 8 || !r.reasonCodes.every((c) => typeof c === "string")) {
    fail("GOVERNANCE_DECISION_MALFORMED", "governance decision has malformed reasonCodes");
  }
  const validUntil = r.validUntil;
  if (validUntil !== null && !isIsoUtc(validUntil)) {
    fail("GOVERNANCE_DECISION_MALFORMED", "governance decision has malformed validUntil");
  }
  return {
    governanceDecisionId: id,
    proposalId: r.proposalId,
    businessId: r.businessId,
    recommendationType: r.recommendationType,
    decision: decision as StrategicGovernanceDecisionLabel,
    policyVersion: r.policyVersion as string,
    evidenceFingerprint: r.evidenceFingerprint,
    proposalFingerprint: r.proposalFingerprint,
    strategicRiskClass: r.strategicRiskClass as StrategicRiskClass,
    confidenceClass: r.confidenceClass as string,
    sourceTrustClass: r.sourceTrustClass as string,
    approvalRequired: r.approvalRequired as boolean,
    reasonCodes: (r.reasonCodes as unknown[]).map(String),
    validUntil: validUntil as string | null,
  };
}

// ─── Deterministic derivations (mirrors frozen R8-F formulas) ───

export function deriveGovernanceProposalFingerprint(proposal: {
  proposalId: string;
  businessId: number;
  recommendationType: string;
  summary: string;
  evidenceRefs: readonly string[];
  claimedConfidence: string;
  declaredImpact: unknown;
}): string {
  return sha256Hex(
    canonicalJson({
      v: 1,
      proposalId: proposal.proposalId,
      businessId: proposal.businessId,
      recommendationType: proposal.recommendationType,
      summary: proposal.summary,
      evidenceRefs: [...proposal.evidenceRefs].sort(),
      claimedConfidence: proposal.claimedConfidence,
      declaredImpact: proposal.declaredImpact,
    })
  );
}

export function deriveGovernanceEvidenceFingerprint(
  resolvedEvidence: ReadonlyArray<{ evidenceRef: string; trustClass: string }>
): string {
  return sha256Hex(
    canonicalJson({
      v: 1,
      evidence: resolvedEvidence.map((e) => ({ evidenceRef: e.evidenceRef, trustClass: e.trustClass })),
    })
  );
}

export function deriveGovernanceDecisionId(input: {
  userId: number;
  businessId: number;
  proposalId: string;
  recommendationType: string;
  policyVersion: string;
  proposalFingerprint: string;
  evidenceFingerprint: string;
}): string {
  return (
    STRATEGIC_GOVERNANCE_DECISION_ID_PREFIX +
    sha256Hex(
      canonicalJson({
        v: 1,
        userId: input.userId,
        businessId: input.businessId,
        proposalId: input.proposalId,
        recommendationType: input.recommendationType,
        policyVersion: input.policyVersion,
        proposalFingerprint: input.proposalFingerprint,
        evidenceFingerprint: input.evidenceFingerprint,
      })
    )
  );
}

// ─── Engine port + registry (absence fails closed) ───

export interface StrategicGovernanceEnginePort {
  /** Current governance policy version (staleness gate at consumption time). */
  getCurrentPolicyVersion(): string;
  /**
   * Submit proposal material to the R8-F authority. Returns the raw
   * immutable decision payload; the seam validates it at the boundary.
   */
  evaluateProposal(input: {
    userId: number;
    businessId: number;
    proposal: unknown;
    policyVersion?: string;
  }): Promise<unknown>;
}

let registeredEngine: StrategicGovernanceEnginePort | null = null;

/** R8-X integration registers the canonical R8-F engine exactly once. */
export function registerStrategicOpportunityRiskGovernanceEngine(port: StrategicGovernanceEnginePort): void {
  registeredEngine = port;
}

export function clearStrategicOpportunityRiskGovernanceEngine(): void {
  registeredEngine = null;
}

export function getStrategicOpportunityRiskGovernanceEngine(): StrategicGovernanceEnginePort {
  if (!registeredEngine) {
    fail(
      "GOVERNANCE_AUTHORITY_UNAVAILABLE",
      "the R8-F strategic-governance authority is not bound; no strategic candidate may be voiced on guessed governance"
    );
  }
  return registeredEngine;
}

// ─── Approval ledger view (read-only; shared ledger, F5 validated) ───

export interface StrategicOpportunityRiskApprovalView {
  readonly id: number;
  readonly status: "pending" | "approved" | "rejected" | "edited";
  readonly binding: StrategicApprovalBindingRecord | null;
}

export interface StrategicOpportunityRiskApprovalReadPort {
  listApprovalsForDecision(input: {
    userId: number;
    governanceDecisionId: string;
  }): Promise<StrategicOpportunityRiskApprovalView[]>;
}

// ─── Production read-view over the canonical approval ledger (read-only) ───

type ApprovalDb = ReturnType<typeof getDb>;

/** Production read-view over the shared approval ledger (raw SQL; read-only). */
export function createRawSqlStrategicOpportunityRiskApprovalReadPort(
  db: ApprovalDb
): StrategicOpportunityRiskApprovalReadPort {
  return {
    async listApprovalsForDecision(input) {
      const result: unknown = await db.execute(sql`
        SELECT id, status, context FROM approval_requests
        WHERE userId = ${input.userId} AND approvalType = ${STRATEGIC_RECOMMENDATION_APPROVAL_TYPE}
        ORDER BY id ASC
      `);
      let rawRows: Array<Record<string, unknown>> = [];
      if (Array.isArray(result)) {
        const first: unknown = result[0];
        rawRows = Array.isArray(first)
          ? (first as Array<Record<string, unknown>>)
          : first && typeof first === "object"
            ? [first as Record<string, unknown>]
            : [];
      } else if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown[] }).rows)) {
        rawRows = (result as { rows: Array<Record<string, unknown>> }).rows;
      }
      const out: StrategicOpportunityRiskApprovalView[] = [];
      for (const row of rawRows) {
        let context: unknown = row.context;
        if (typeof context === "string") {
          try {
            context = JSON.parse(context);
          } catch {
            context = null;
          }
        }
        const binding = parseStrategicApprovalBinding(context);
        if (binding && binding.governanceDecisionId !== input.governanceDecisionId) continue;
        const status = String(row.status ?? "");
        out.push({
          id: Number(row.id),
          status:
            status === "approved" || status === "rejected" || status === "edited" || status === "pending"
              ? status
              : "pending",
          binding,
        });
      }
      return out;
    },
  };
}

// ─── Consumption gate (the ONLY eligibility path; RECOMMENDATION_ONLY) ───

export type CandidateConsumptionVerdict =
  | {
      readonly consumable: true;
      readonly authorityScope: "RECOMMENDATION_ONLY";
      readonly governanceDecisionId: string;
      readonly approvalRequestId: number | null;
      readonly policyVersion: string;
    }
  | { readonly consumable: false; readonly reason: string; readonly permanent: boolean };

/**
 * Convert a stored decision (+ approval where required) into consumption
 * eligibility. Mirrors the frozen R8-F gate semantics: BLOCK is terminal;
  * ALLOW requires current policy version + unexpired decision; REVIEW_REQUIRED
 * requires a valid bound human approval (forged/expired/edited bindings fail
 * closed). The verdict scope is RECOMMENDATION_ONLY — never execution.
 */
export function assertCandidateConsumable(input: {
  decision: Pick<
    StrategicGovernanceDecisionView,
    "governanceDecisionId" | "decision" | "policyVersion" | "validUntil" | "evidenceFingerprint" | "proposalFingerprint"
  >;
  approvals: readonly StrategicOpportunityRiskApprovalView[];
  currentPolicyVersion: string | null;
  now: string;
}): CandidateConsumptionVerdict {
  const { decision, approvals, currentPolicyVersion, now } = input;
  const nowMs = Date.parse(now);
  if (Number.isNaN(nowMs)) {
    return { consumable: false, reason: "MALFORMED_CLOCK", permanent: false };
  }
  if (decision.decision === "BLOCK") {
    return { consumable: false, reason: "RECOMMENDATION_BLOCKED_BY_POLICY", permanent: true };
  }
  if (currentPolicyVersion !== decision.policyVersion) {
    return { consumable: false, reason: "STALE_POLICY_VERSION", permanent: false };
  }
  if (decision.validUntil !== null && Date.parse(decision.validUntil) <= nowMs) {
    return { consumable: false, reason: "EXPIRED_DECISION", permanent: false };
  }
  if (decision.decision === "ALLOW_RECOMMENDATION") {
    return {
      consumable: true,
      authorityScope: "RECOMMENDATION_ONLY",
      governanceDecisionId: decision.governanceDecisionId,
      approvalRequestId: null,
      policyVersion: decision.policyVersion,
    };
  }
  // REVIEW_REQUIRED: a valid bound human approval is mandatory.
  if (approvals.length === 0) return { consumable: false, reason: "APPROVAL_NOT_FOUND", permanent: false };
  for (const approval of approvals) {
    if (approval.status === "rejected") {
      return { consumable: false, reason: "APPROVAL_REJECTED_BY_HUMAN", permanent: true };
    }
  }
  const approved = approvals.find((a) => a.status === "approved");
  if (!approved) return { consumable: false, reason: "APPROVAL_PENDING", permanent: false };
  const binding = approved.binding;
  if (!binding) return { consumable: false, reason: "APPROVAL_BINDING_MISMATCH", permanent: false };
  if (binding.governanceDecisionId !== decision.governanceDecisionId) {
    return { consumable: false, reason: "APPROVAL_BINDING_MISMATCH", permanent: false };
  }
  const expected = deriveApprovalBindingHash({
    governanceDecisionId: decision.governanceDecisionId,
    policyVersion: decision.policyVersion,
    proposalFingerprint: decision.proposalFingerprint,
    evidenceFingerprint: decision.evidenceFingerprint,
  });
  if (binding.approvalBindingHash !== expected) {
    return { consumable: false, reason: "APPROVAL_BINDING_MISMATCH", permanent: false };
  }
  if (binding.policyVersion !== decision.policyVersion) {
    return { consumable: false, reason: "APPROVAL_BINDING_MISMATCH", permanent: false };
  }
  if (binding.proposalFingerprint !== decision.proposalFingerprint) {
    return { consumable: false, reason: "APPROVAL_BINDING_MISMATCH", permanent: false };
  }
  if (binding.evidenceFingerprint !== decision.evidenceFingerprint) {
    return { consumable: false, reason: "APPROVAL_BINDING_MISMATCH", permanent: false };
  }
  return {
    consumable: true,
    authorityScope: "RECOMMENDATION_ONLY",
    governanceDecisionId: decision.governanceDecisionId,
    approvalRequestId: approved.id,
    policyVersion: decision.policyVersion,
  };
}

void STRATEGIC_RECOMMENDATION_APPROVAL_TYPE;

// ─── TEST-ONLY double: faithful default-policy R8-F behaviour ───

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
  "reasonCodes",
  "strategicRiskClass",
  "confidenceClass",
  "sourceTrustClass",
  "override",
  "admin",
  "forceAllow",
  "forceApprove",
  "setApproved",
] as const;

export type FakeTrustResolver = (evidenceRef: string) => string;

/** Deterministic trust resolver mirroring the F3 evidence-trust vocabulary. */
export const defaultFakeTrustResolver: FakeTrustResolver = (ref) => {
  if (ref.startsWith("mem1:")) return "AUTHORITATIVE_INTERNAL";
  if (ref.startsWith("chg1:")) return "AUTHORITATIVE_INTERNAL";
  if (ref.startsWith("xsig1:")) return "SINGLE_EXTERNAL_SOURCE";
  return "UNVERIFIED";
};

const TRUST_RANK: Record<string, number> = {
  MALFORMED: 0,
  CONTRADICTED: 1,
  UNVERIFIED: 2,
  SINGLE_EXTERNAL_SOURCE: 3,
  CORROBORATED_EXTERNAL: 4,
  VERIFIED_EXTERNAL: 5,
  AUTHORITATIVE_INTERNAL: 6,
};

const CONFIDENCE_RANK: Record<string, number> = { NONE: 0, LOW: 1, MEDIUM: 2, HIGH: 3 };

const CONFIDENCE_CEILINGS: Record<string, string> = {
  AUTHORITATIVE_INTERNAL: "HIGH",
  VERIFIED_EXTERNAL: "HIGH",
  CORROBORATED_EXTERNAL: "MEDIUM",
  SINGLE_EXTERNAL_SOURCE: "LOW",
  UNVERIFIED: "LOW",
  CONTRADICTED: "NONE",
  MALFORMED: "NONE",
};

interface FakeProposal {
  proposalId: string;
  businessId: number;
  recommendationType: string;
  summary: string;
  evidenceRefs: string[];
  claimedConfidence: string;
  declaredImpact: unknown;
}

export class FakeDefaultPolicyGovernancePort implements StrategicGovernanceEnginePort {
  private readonly decisions = new Map<string, StrategicGovernanceDecisionView>();
  private readonly now: () => Date;
  private readonly trustResolver: FakeTrustResolver;
  private approvalSeq = 0;
  private readonly approvals = new Map<string, StrategicOpportunityRiskApprovalView[]>();

  constructor(options?: { now?: () => Date; trustResolver?: FakeTrustResolver }) {
    this.now = options?.now ?? (() => new Date());
    this.trustResolver = options?.trustResolver ?? defaultFakeTrustResolver;
  }

  getCurrentPolicyVersion(): string {
    return STRATEGIC_GOVERNANCE_POLICY_VERSION;
  }

  /** Test helper: mint an approval row for a REVIEW_REQUIRED decision. */
  mintApproval(
    governanceDecisionId: string,
    status: "pending" | "approved" | "rejected",
    over: { proposalFingerprint?: string; policyVersion?: string; evidenceFingerprint?: string; expiresAt?: string } = {}
  ): number {
    const decision = this.decisions.get(governanceDecisionId);
    if (!decision) throw new Error(`fake governance: unknown decision ${governanceDecisionId}`);
    const id = ++this.approvalSeq;
    const binding = {
      governanceDecisionId: decision.governanceDecisionId,
      policyVersion: over.policyVersion ?? decision.policyVersion,
      proposalFingerprint: over.proposalFingerprint ?? decision.proposalFingerprint,
      evidenceFingerprint: over.evidenceFingerprint ?? decision.evidenceFingerprint,
      approvalBindingHash: deriveApprovalBindingHash({
        governanceDecisionId: decision.governanceDecisionId,
        policyVersion: over.policyVersion ?? decision.policyVersion,
        proposalFingerprint: over.proposalFingerprint ?? decision.proposalFingerprint,
        evidenceFingerprint: over.evidenceFingerprint ?? decision.evidenceFingerprint,
      }),
    };
    const existing = this.approvals.get(governanceDecisionId) ?? [];
    this.approvals.set(governanceDecisionId, [...existing, { id, status, binding }]);
    return id;
  }

  listApprovals(governanceDecisionId: string): StrategicOpportunityRiskApprovalView[] {
    return this.approvals.get(governanceDecisionId) ?? [];
  }

  async evaluateProposal(input: {
    userId: number;
    businessId: number;
    proposal: unknown;
    policyVersion?: string;
  }): Promise<unknown> {
    const proposal = this.validateProposalMaterial(input.proposal);
    const resolvedEvidence = [...new Set(proposal.evidenceRefs)].map((evidenceRef) => ({
      evidenceRef,
      trustClass: this.trustResolver(evidenceRef),
    }));
    const evidenceFingerprint = deriveGovernanceEvidenceFingerprint(resolvedEvidence);
    const proposalFingerprint = deriveGovernanceProposalFingerprint({
      proposalId: proposal.proposalId,
      businessId: proposal.businessId,
      recommendationType: proposal.recommendationType,
      summary: proposal.summary,
      evidenceRefs: proposal.evidenceRefs,
      claimedConfidence: proposal.claimedConfidence,
      declaredImpact: proposal.declaredImpact,
    });
    const decisionId = deriveGovernanceDecisionId({
      userId: input.userId,
      businessId: proposal.businessId,
      proposalId: proposal.proposalId,
      recommendationType: proposal.recommendationType,
      policyVersion: STRATEGIC_GOVERNANCE_POLICY_VERSION,
      proposalFingerprint,
      evidenceFingerprint,
    });
    const existing = this.decisions.get(decisionId);
    if (existing) {
      if (existing.proposalFingerprint !== proposalFingerprint) {
        fail("CANDIDATE_REPLAY_CONFLICT", "conflicting replay (tampered proposal material)");
      }
      return existing;
    }
    const evaluated = this.evaluateDefaultPolicy({
      userId: input.userId,
      proposal,
      resolvedEvidence,
      proposalFingerprint,
      evidenceFingerprint,
      decisionId,
      now: this.now().toISOString(),
    });
    this.decisions.set(decisionId, evaluated);
    return evaluated;
  }

  private evaluateDefaultPolicy(input: {
    userId: number;
    proposal: FakeProposal;
    resolvedEvidence: ReadonlyArray<{ evidenceRef: string; trustClass: string }>;
    proposalFingerprint: string;
    evidenceFingerprint: string;
    decisionId: string;
    now: string;
  }): StrategicGovernanceDecisionView {
    const { proposal, resolvedEvidence, proposalFingerprint, evidenceFingerprint, decisionId } = input;
    const now = input.now;
    const reasons: string[] = [];
    const knownType = (STRATEGIC_RECOMMENDATION_TYPES as readonly string[]).includes(
      proposal.recommendationType
    );

    // Server-derived confidence ceiling (F3) over the resolved evidence trust.
    let minTrustRank = Number.POSITIVE_INFINITY;
    for (const e of resolvedEvidence) {
      const rank = TRUST_RANK[e.trustClass] ?? 0;
      if (rank < minTrustRank) minTrustRank = rank;
    }
    const worstTrust =
      resolvedEvidence.length === 0
        ? "MALFORMED"
        : (Object.keys(TRUST_RANK).find((k) => TRUST_RANK[k] === minTrustRank) ?? "MALFORMED");
    const derivedCeiling = CONFIDENCE_CEILINGS[worstTrust] ?? "NONE";
    const claimedRank = CONFIDENCE_RANK[proposal.claimedConfidence] ?? 0;
    const ceilingRank = CONFIDENCE_RANK[derivedCeiling] ?? 0;
    const derivedConfidence: string =
      claimedRank <= ceilingRank
        ? proposal.claimedConfidence
        : (Object.keys(CONFIDENCE_RANK).find((k) => CONFIDENCE_RANK[k] === ceilingRank) ?? "NONE");
    if (derivedConfidence !== proposal.claimedConfidence) {
      reasons.push("CONFIDENCE_BOUNDED_BY_EVIDENCE");
    }

    // Risk: CRITICAL if injection-suspect or unknown type; HIGH when declared
    // impact is severe/immediate or confidence floor fails on high impact.
    const strings: string[] = [];
    const collect = (v: unknown): void => {
      if (typeof v === "string") strings.push(v);
      else if (Array.isArray(v)) v.forEach(collect);
      else if (typeof v === "object" && v !== null) Object.values(v).forEach(collect);
    };
    collect({ summary: proposal.summary, declaredImpact: proposal.declaredImpact });
    const injectionSuspect = strings.some((s) => INJECTION_PATTERNS.some((p) => p.test(s)));

    const declared = (proposal.declaredImpact ?? {}) as Record<string, unknown>;
    const impactClass = typeof declared.impactClass === "string" ? declared.impactClass : "";
    const urgencyClass = typeof declared.urgencyClass === "string" ? declared.urgencyClass : "";
    const highImpact = impactClass === "MAJOR" || impactClass === "SEVERE";
    const criticalUrgency = urgencyClass === "IMMEDIATE";

    let riskClass: StrategicRiskClass;
    if (!knownType) {
      riskClass = "CRITICAL";
      reasons.push("UNKNOWN_RECOMMENDATION_TYPE");
    } else if (injectionSuspect) {
      riskClass = "CRITICAL";
      reasons.push("PROMPT_INJECTION_SUSPECTED");
    } else if (highImpact && criticalUrgency) {
      riskClass = "HIGH";
      reasons.push("HIGH_IMPACT_REQUIRES_STRONG_EVIDENCE");
    } else if (highImpact) {
      riskClass = "MEDIUM";
    } else {
      riskClass = "LOW";
    }

    if (highImpact && ceilingRank < CONFIDENCE_RANK.HIGH) {
      reasons.push("HIGH_IMPACT_REQUIRES_STRONG_EVIDENCE");
    }
    if (derivedConfidence === "NONE" || derivedConfidence === "LOW") {
      reasons.push("INSUFFICIENT_CONFIDENCE");
    }

    const disposition = STRATEGIC_RISK_DISPOSITIONS[riskClass];
    const confidenceBlocksAutonomy =
      CONFIDENCE_RANK[derivedConfidence] < CONFIDENCE_RANK[MIN_CONFIDENCE_FOR_AUTONOMOUS_RECOMMENDATION];

    let decision: StrategicGovernanceDecisionLabel;
    if (disposition === "BLOCK") decision = "BLOCK";
    else if (disposition === "REVIEW_REQUIRED") decision = "REVIEW_REQUIRED";
    else if (confidenceBlocksAutonomy) decision = "REVIEW_REQUIRED";
    else decision = "ALLOW_RECOMMENDATION";

    if (decision === "REVIEW_REQUIRED" && reasons.length === 0) reasons.push("APPROVAL_REQUIRED_BY_RISK");
    if (decision === "ALLOW_RECOMMENDATION" && reasons.length === 0) {
      reasons.push("RECOMMENDATION_ALLOWED_BY_POLICY");
    }
    if (decision === "BLOCK" && reasons.length === 0) reasons.push("RECOMMENDATION_BLOCKED_BY_POLICY");

    const nowMs = Date.parse(now);
    const validUntil =
      decision === "BLOCK"
        ? null
        : new Date(nowMs + STRATEGIC_GOVERNANCE_MAX_DECISION_VALIDITY_MS).toISOString();

    return Object.freeze({
      governanceDecisionId: decisionId,
      proposalId: proposal.proposalId,
      businessId: proposal.businessId,
      recommendationType: proposal.recommendationType,
      decision,
      policyVersion: STRATEGIC_GOVERNANCE_POLICY_VERSION,
      evidenceFingerprint,
      proposalFingerprint,
      strategicRiskClass: riskClass,
      confidenceClass: derivedConfidence,
      sourceTrustClass: worstTrust,
      approvalRequired: decision === "REVIEW_REQUIRED",
      reasonCodes: Object.freeze([...new Set(reasons)].slice(0, 8)),
      validUntil,
    });
  }

  private validateProposalMaterial(raw: unknown): FakeProposal {
    function malformed(message: string): never {
      fail("GOVERNANCE_DECISION_MALFORMED", `governance rejected proposal material: ${message}`);
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      malformed("proposal must be an object");
    }
    const r = raw as Record<string, unknown>;
    for (const key of FORBIDDEN_CLIENT_AUTHORITY_FIELDS) {
      if (key in r) {
        fail(
          "CLIENT_AUTHORITY_FIELD_FORBIDDEN",
          `Field "${key}" is server-side governance authority and must never be client-supplied.`
        );
      }
    }
    if (typeof r.proposalId !== "string" || !PROPOSAL_ID_PATTERN.test(r.proposalId)) {
      malformed("proposalId invalid");
    }
    if (typeof r.businessId !== "number" || !Number.isInteger(r.businessId) || r.businessId <= 0) {
      malformed("businessId invalid");
    }
    if (
      typeof r.recommendationType !== "string" ||
      r.recommendationType.trim().length === 0 ||
      r.recommendationType.length > 64
    ) {
      malformed("recommendationType invalid");
    }
    if (typeof r.summary !== "string" || r.summary.length === 0 || r.summary.length > 280) {
      malformed("summary invalid");
    }
    if (!Array.isArray(r.evidenceRefs) || r.evidenceRefs.length === 0) {
      malformed("evidenceRefs must be a non-empty array");
    }
    const evidenceRefs = r.evidenceRefs.map((e) => {
      if (typeof e !== "string" || e.length === 0 || e.length > 128) malformed("evidenceRef invalid");
      return e as string;
    });
    if (typeof r.claimedConfidence !== "string") malformed("claimedConfidence invalid");
    if (r.declaredImpact === null || typeof r.declaredImpact !== "object") {
      malformed("declaredImpact must be an object");
    }
    if (!isIsoUtc(r.requestedAt)) malformed("requestedAt must be explicit ISO 8601 UTC");
    return {
      proposalId: r.proposalId,
      businessId: r.businessId,
      recommendationType: r.recommendationType,
      summary: r.summary,
      evidenceRefs,
      claimedConfidence: r.claimedConfidence,
      declaredImpact: r.declaredImpact,
    };
  }
}
