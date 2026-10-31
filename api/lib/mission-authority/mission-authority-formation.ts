// ─── R9-A Mission Authority — deterministic formation (A3/A4) ───
//
// Rule-first objective formation: every authority dimension (mission type,
// objective type, scope subject, derived constraints, risk/confidence
// ceilings, validity window, governance requirements) is a DETERMINISTIC
// function of the governed R8 candidate. Model assistance may reword the
// objective statement ONLY — advisory, bounded, injection-labelled, never
// authority. No model in the decision path; no client scope material; no
// budget/risk/constraint mutation path exists by construction.

import {
  CONFIDENCE_CLASSES,
  GOVERNANCE_REQUIREMENT_LABELS,
  MAX_ASSUMPTIONS,
  MAX_CLIENT_CONSTRAINTS,
  MAX_SUCCESS_CRITERIA,
  MISSION_DEFAULT_VALIDITY_MS,
  STRATEGIC_RISK_CLASSES,
  assertBoundedText,
  fail,
  type ConfidenceClass,
  type MissionConstraintInput,
  type MissionSuccessCriterionInput,
  type MissionAssumptionInput,
  type MissionType,
  type ObjectiveType,
  type ScopeSubjectType,
  type StrategicRiskClass,
} from "./mission-authority-contract";

// ─── Candidate-type derivation table (contract §5.3) ───

interface CandidateDerivation {
  readonly missionType: MissionType;
  readonly objectiveType: ObjectiveType;
  readonly scopeSubjectType: ScopeSubjectType;
}

const CANDIDATE_TYPE_DERIVATION: Readonly<Record<string, CandidateDerivation>> = Object.freeze({
  MARKET_EXPANSION: { missionType: "MARKET_EXPANSION", objectiveType: "MARKET_EXPANSION", scopeSubjectType: "MARKET" },
  DEMAND_GROWTH: { missionType: "OPPORTUNITY_PURSUIT", objectiveType: "GROWTH", scopeSubjectType: "MARKET" },
  POSITIONING_CHANGE: { missionType: "POSITIONING_ACTION", objectiveType: "POSITIONING", scopeSubjectType: "MARKET" },
  COMPETITIVE_RESPONSE: { missionType: "DEFENSIVE_RESPONSE", objectiveType: "RESILIENCE", scopeSubjectType: "MARKET" },
  PRODUCT_MARKETING: { missionType: "OPPORTUNITY_PURSUIT", objectiveType: "GROWTH", scopeSubjectType: "PRODUCT_SET" },
  CHANNEL_SHIFT: { missionType: "CHANNEL_SHIFT", objectiveType: "CHANNEL_OPTIMISATION", scopeSubjectType: "CHANNEL" },
  CAPABILITY_INVESTMENT: { missionType: "CAPABILITY_ACTION", objectiveType: "CAPABILITY_BUILD", scopeSubjectType: "CAPABILITY" },
  RESOURCE_REALLOCATION: { missionType: "PORTFOLIO_REBALANCE", objectiveType: "PORTFOLIO_HEALTH", scopeSubjectType: "PORTFOLIO" },
  REGULATORY_RESPONSE: { missionType: "DEFENSIVE_RESPONSE", objectiveType: "RESILIENCE", scopeSubjectType: "BUSINESS" },
  TECHNOLOGY_ADOPTION: { missionType: "CAPABILITY_ACTION", objectiveType: "CAPABILITY_BUILD", scopeSubjectType: "CAPABILITY" },
  REPUTATION_RESPONSE: { missionType: "DEFENSIVE_RESPONSE", objectiveType: "RESILIENCE", scopeSubjectType: "BUSINESS" },
  MARKET_DECLINE: { missionType: "RISK_RESPONSE", objectiveType: "RISK_REDUCTION", scopeSubjectType: "MARKET" },
  CAPABILITY_RISK: { missionType: "RISK_RESPONSE", objectiveType: "RISK_REDUCTION", scopeSubjectType: "CAPABILITY" },
  PORTFOLIO_RISK: { missionType: "PORTFOLIO_REBALANCE", objectiveType: "PORTFOLIO_HEALTH", scopeSubjectType: "PORTFOLIO" },
  STRATEGIC_MISALIGNMENT: { missionType: "RISK_RESPONSE", objectiveType: "RISK_REDUCTION", scopeSubjectType: "BUSINESS" },
});

/** Deterministic mission/objective/scope derivation from the source candidate type. */
export function deriveFromCandidateType(candidateType: string): CandidateDerivation {
  const derivation = CANDIDATE_TYPE_DERIVATION[candidateType];
  if (!derivation) {
    fail(
      "SOURCE_PROJECTION_MALFORMED",
      `source candidate type "${candidateType}" has no mission derivation — refusing to invent one`
    );
  }
  return derivation;
}

// ─── Ceilings carried verbatim (never promoted, never lowered) ───

export function assertStrategicRiskClass(raw: string): StrategicRiskClass {
  if (!(STRATEGIC_RISK_CLASSES as readonly string[]).includes(raw)) {
    fail("SOURCE_PROJECTION_MALFORMED", `source carries unknown strategicRiskClass "${raw}"`);
  }
  return raw as StrategicRiskClass;
}

export function assertConfidenceClass(raw: string): ConfidenceClass {
  if (!(CONFIDENCE_CLASSES as readonly string[]).includes(raw)) {
    fail("SOURCE_PROJECTION_MALFORMED", `source carries unknown confidenceClass "${raw}"`);
  }
  return raw as ConfidenceClass;
}

// ─── Model assistance — wording only (A3.2) ───

const WORDING_INJECTION_PATTERNS: readonly RegExp[] = [
  /ignore (all |previous |the )?instructions/i,
  /system prompt/i,
  /you are now/i,
  /approved\s*[:=]\s*true/i,
  /override\s*[:=]\s*true/i,
  /admin\s*[:=]\s*true/i,
  /ignorebudget/i,
  /jailbreak/i,
  /bypass (policy|governance|approval)/i,
  /raise (the )?budget/i,
  /increase (the )?budget/i,
  /remove (the )?(constraint|limitations?)/i,
  /lower (the )?risk/i,
];

/** Injection suspicion label for advisory wording; advisory never blocks. */
export function flagAdvisoryWording(text: string): boolean {
  return WORDING_INJECTION_PATTERNS.some((p) => p.test(text));
}

export interface ResolvedObjectiveWording {
  /** Statement of record: model draft when supplied, else client statement. */
  readonly statement: string;
  /** Client-authored wording (always preserved). */
  readonly clientStatement: string;
  /** Advisory model draft (null when none supplied). */
  readonly modelDraft: string | null;
  /** Injection suspicion on the advisory draft (label only, never authority). */
  readonly modelAssistanceFlagged: boolean;
}

/**
 * Resolve the objective statement of record. The model draft may reword the
 * statement — that is its ONLY effect. Both wordings are bounded printable
 * text; neither carries authority of any kind.
 */
export function resolveObjectiveWording(input: {
  clientStatement: string;
  modelDraft?: string | undefined;
}): ResolvedObjectiveWording {
  const clientStatement = assertBoundedText(
    input.clientStatement,
    500,
    "INVALID_OBJECTIVE_STATEMENT",
    "objectiveStatement"
  );
  let modelDraft: string | null = null;
  let modelAssistanceFlagged = false;
  if (typeof input.modelDraft === "string") {
    modelDraft = assertBoundedText(
      input.modelDraft,
      500,
      "INVALID_OBJECTIVE_STATEMENT",
      "modelAssistance.draftWording"
    );
    modelAssistanceFlagged = flagAdvisoryWording(modelDraft);
  }
  return {
    statement: modelDraft ?? clientStatement,
    clientStatement,
    modelDraft,
    modelAssistanceFlagged,
  };
}

// ─── Bounded input validation (client inputs, preserved verbatim) ───

export interface ValidatedSuccessCriterion {
  readonly criterionType: string;
  readonly statement: string;
  readonly metricRef: string | null;
}

export function validateSuccessCriteria(
  raw: readonly MissionSuccessCriterionInput[]
): ValidatedSuccessCriterion[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    fail("INVALID_SUCCESS_CRITERION", "at least one success criterion is required");
  }
  if (raw.length > MAX_SUCCESS_CRITERIA) {
    fail("INVALID_SUCCESS_CRITERION", `at most ${MAX_SUCCESS_CRITERIA} success criteria are permitted`);
  }
  return raw.map((c) => ({
    criterionType: c.criterionType,
    statement: assertBoundedText(c.statement, 280, "INVALID_SUCCESS_CRITERION", "successCriteria.statement"),
    metricRef:
      typeof c.metricRef === "string"
        ? assertBoundedText(c.metricRef, 120, "INVALID_SUCCESS_CRITERION", "successCriteria.metricRef")
        : null,
  }));
}

export interface ValidatedAssumption {
  readonly statement: string;
}

export function validateAssumptions(raw: readonly MissionAssumptionInput[]): ValidatedAssumption[] {
  if (raw.length > MAX_ASSUMPTIONS) {
    fail("INVALID_ASSUMPTION", `at most ${MAX_ASSUMPTIONS} assumptions are permitted`);
  }
  return raw.map((a) => ({
    statement: assertBoundedText(a.statement, 280, "INVALID_ASSUMPTION", "assumptions.statement"),
  }));
}

export interface ValidatedConstraint {
  readonly constraintType: string;
  readonly statement: string;
  readonly referenceValue: string | null;
  readonly amountMinorUnits: number | null;
  readonly currency: string | null;
}

export function validateClientConstraints(
  raw: readonly MissionConstraintInput[]
): ValidatedConstraint[] {
  if (raw.length > MAX_CLIENT_CONSTRAINTS) {
    fail("INVALID_CONSTRAINT", `at most ${MAX_CLIENT_CONSTRAINTS} client constraints are permitted`);
  }
  const seenTypes = new Set<string>();
  return raw.map((c) => {
    if (seenTypes.has(c.constraintType)) {
      fail("INVALID_CONSTRAINT", `duplicate client constraint type "${c.constraintType}"`);
    }
    seenTypes.add(c.constraintType);
    const hasAmount = typeof c.amountMinorUnits === "number";
    const hasCurrency = typeof c.currency === "string";
    if (hasAmount !== hasCurrency) {
      fail(
        "INVALID_BUDGET_CEILING",
        "BUDGET_CEILING constraints require amountMinorUnits and currency together, or neither"
      );
    }
    if (hasAmount && c.constraintType !== "BUDGET_CEILING") {
      fail("INVALID_CONSTRAINT", "monetary amounts are only permitted on BUDGET_CEILING constraints");
    }
    return {
      constraintType: c.constraintType,
      statement: assertBoundedText(c.statement, 280, "INVALID_CONSTRAINT", "constraints.statement"),
      referenceValue:
        typeof c.referenceValue === "string"
          ? assertBoundedText(c.referenceValue, 120, "INVALID_CONSTRAINT", "constraints.referenceValue")
          : null,
      amountMinorUnits: hasAmount ? (c.amountMinorUnits as number) : null,
      currency: hasCurrency ? (c.currency as string) : null,
    };
  });
}

// ─── Derived constraint set (A4 — always present, immutable) ───

export interface MissionScope {
  readonly subjectType: ScopeSubjectType;
  readonly businessScope: number;
  readonly channelScope: null;
  readonly campaignScope: null;
  readonly geography: null;
}

export function buildScope(input: {
  subjectType: ScopeSubjectType;
  businessId: number;
}): MissionScope {
  return {
    subjectType: input.subjectType,
    businessScope: input.businessId,
    channelScope: null,
    campaignScope: null,
    geography: null,
  };
}

export function buildDerivedConstraints(input: {
  scope: MissionScope;
  strategicRiskClass: StrategicRiskClass;
  confidenceClass: ConfidenceClass;
  validFrom: string;
  validUntil: string;
}): ValidatedConstraint[] {
  return [
    {
      constraintType: "RECOMMENDATION_ONLY",
      statement:
        "Source R8 approval authorizes recommendation consumption only; it is never execution authorization.",
      referenceValue: null,
      amountMinorUnits: null,
      currency: null,
    },
    {
      constraintType: "RISK_CEILING",
      statement: `Mission strategic risk may never exceed the source risk class ${input.strategicRiskClass}.`,
      referenceValue: input.strategicRiskClass,
      amountMinorUnits: null,
      currency: null,
    },
    {
      constraintType: "CONFIDENCE_CEILING",
      statement: `Evidence confidence may never be promoted beyond the source class ${input.confidenceClass}.`,
      referenceValue: input.confidenceClass,
      amountMinorUnits: null,
      currency: null,
    },
    {
      constraintType: "SCOPE_BOUND",
      statement: `Mission scope is bounded to ${input.scope.subjectType} of business ${input.scope.businessScope}; no channel, campaign or geography expansion is authorized.`,
      referenceValue: `${input.scope.subjectType}:business:${input.scope.businessScope}`,
      amountMinorUnits: null,
      currency: null,
    },
    {
      constraintType: "VALIDITY_WINDOW",
      statement: `Mission authority is valid from ${input.validFrom} until ${input.validUntil}; it never silently extends.`,
      referenceValue: null,
      amountMinorUnits: null,
      currency: null,
    },
  ];
}

// ─── Validity window (contract §7) ───

export function deriveValidityWindow(input: {
  validFromMs: number;
  candidateValidUntil: string | null;
}): { validFrom: string; validUntil: string } {
  const validFrom = new Date(input.validFromMs).toISOString();
  const capMs = input.validFromMs + MISSION_DEFAULT_VALIDITY_MS;
  let validUntilMs = capMs;
  if (input.candidateValidUntil !== null) {
    const candidateMs = Date.parse(input.candidateValidUntil);
    if (!Number.isNaN(candidateMs)) validUntilMs = Math.min(capMs, candidateMs);
  }
  return { validFrom, validUntil: new Date(validUntilMs).toISOString() };
}

// ─── Governance requirements (derived, read-only labels) ───

export function deriveGovernanceRequirements(input: {
  governanceDecision: string | null;
}): string[] {
  const requirements: string[] = [
    GOVERNANCE_REQUIREMENT_LABELS[0],
    GOVERNANCE_REQUIREMENT_LABELS[1],
  ];
  if (input.governanceDecision === "REVIEW_REQUIRED") {
    requirements.push(GOVERNANCE_REQUIREMENT_LABELS[2]);
  }
  return requirements;
}
