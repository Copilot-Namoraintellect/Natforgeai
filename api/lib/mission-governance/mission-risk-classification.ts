// ─── R9-F Mission Governance & Approval — deterministic risk classification (F3) ───
//
// Server-derived mission risk over the closed scale LOW < MEDIUM < HIGH <
// CRITICAL. The client/agent may supply DECLARED signals (proposal material);
// each declaration can only RAISE risk. Semantic floors derived from the
// action type cannot be lowered by omission — a client declaring nothing for
// INVOKE_PROVIDER still gets the providerCalls floor. Nothing in this module
// can be used to lower its own risk (charter F3; AC15/16/17).
//
// Pure module: no database access, no clock, no I/O.

import {
  MissionGovernanceInputError,
  MISSION_RISK_CLASS_RANK,
  type MissionActionType,
  type MissionRiskClass,
  type MissionSubjectClass,
} from "./mission-governance-contract";

export const FINANCIAL_IMPACT_LEVELS = ["NONE", "MINOR", "MODERATE", "SEVERE"] as const;
export type FinancialImpactLevel = (typeof FINANCIAL_IMPACT_LEVELS)[number];

export const SCOPE_BREADTH_VALUES = ["SINGLE", "MULTI_BUSINESS", "PORTFOLIO"] as const;
export type ScopeBreadth = (typeof SCOPE_BREADTH_VALUES)[number];

/** Closed declared-risk dimensions (proposal material — raise-only). */
export const MISSION_RISK_DIMENSIONS = [
  "financialImpact",
  "externalSideEffects",
  "customerImpact",
  "irreversibleEffects",
  "providerCalls",
  "dataMutation",
  "campaignActivation",
  "budgetConsumption",
  "regulatoryImplication",
  "scopeBreadth",
] as const;
export type MissionRiskDimension = (typeof MISSION_RISK_DIMENSIONS)[number];

export interface DeclaredMissionRisk {
  readonly financialImpact: FinancialImpactLevel;
  readonly externalSideEffects: boolean;
  readonly customerImpact: boolean;
  readonly irreversibleEffects: boolean;
  readonly providerCalls: boolean;
  readonly dataMutation: boolean;
  readonly campaignActivation: boolean;
  readonly budgetConsumption: boolean;
  readonly regulatoryImplication: boolean;
  readonly scopeBreadth: ScopeBreadth;
}

export const EMPTY_DECLARED_RISK: DeclaredMissionRisk = Object.freeze({
  financialImpact: "NONE",
  externalSideEffects: false,
  customerImpact: false,
  irreversibleEffects: false,
  providerCalls: false,
  dataMutation: false,
  campaignActivation: false,
  budgetConsumption: false,
  regulatoryImplication: false,
  scopeBreadth: "SINGLE",
});

const BOOLEAN_DIMENSIONS = [
  "externalSideEffects",
  "customerImpact",
  "irreversibleEffects",
  "providerCalls",
  "dataMutation",
  "campaignActivation",
  "budgetConsumption",
  "regulatoryImplication",
] as const;

/** Validate and normalise raw declared-risk material (fail closed). */
export function validateDeclaredMissionRisk(raw: unknown): DeclaredMissionRisk {
  if (raw === null || raw === undefined) return EMPTY_DECLARED_RISK;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new MissionGovernanceInputError(
      "MALFORMED_PROPOSAL",
      "declaredRisk must be an object"
    );
  }
  const r = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (r.financialImpact === undefined) {
    out.financialImpact = "NONE";
  } else if ((FINANCIAL_IMPACT_LEVELS as readonly string[]).includes(r.financialImpact as string)) {
    out.financialImpact = r.financialImpact;
  } else {
    throw new MissionGovernanceInputError(
      "MALFORMED_PROPOSAL",
      `declaredRisk.financialImpact must be one of ${FINANCIAL_IMPACT_LEVELS.join(",")}`
    );
  }
  for (const key of BOOLEAN_DIMENSIONS) {
    const v = r[key];
    if (v === undefined) {
      out[key] = false;
      continue;
    }
    if (typeof v !== "boolean") {
      throw new MissionGovernanceInputError(
        "MALFORMED_PROPOSAL",
        `declaredRisk.${key} must be a boolean`
      );
    }
    out[key] = v;
  }
  if (r.scopeBreadth === undefined) {
    out.scopeBreadth = "SINGLE";
  } else if ((SCOPE_BREADTH_VALUES as readonly string[]).includes(r.scopeBreadth as string)) {
    out.scopeBreadth = r.scopeBreadth;
  } else {
    throw new MissionGovernanceInputError(
      "MALFORMED_PROPOSAL",
      `declaredRisk.scopeBreadth must be one of ${SCOPE_BREADTH_VALUES.join(",")}`
    );
  }
  // Unknown keys in declaredRisk are ignored: declarations are material, not
  // authority, and the closed list above is the only thing that can raise
  // risk. (z.strictObject at the router layer still rejects authority-shaped
  // top-level keys.)
  return out as unknown as DeclaredMissionRisk;
}

/**
 * Semantic floors from the ACTION TYPE: authoritative facts about what an
 * action inherently does. Declarations can only raise these — never lower.
 * (F3: a client cannot lower risk by omitting a true signal; AC16.)
 */
export const ACTION_RISK_FLOORS: Readonly<Record<MissionActionType, readonly (keyof Omit<DeclaredMissionRisk, "financialImpact" | "scopeBreadth">)[]>> =
  Object.freeze({
    FORMULATE_MISSION: [],
    BIND_OBJECTIVES: [],
    PLAN_TASKS: [],
    SEQUENCE_DEPENDENCIES: [],
    COMMIT_SCHEDULE: [],
    EXECUTE_TASK: [],
    EXECUTE_STEP: [],
    RETRY_STEP: [],
    INVOKE_PROVIDER: ["providerCalls"],
    MUTATE_DATA: ["dataMutation"],
    ACTIVATE_CAMPAIGN: ["campaignActivation"],
    CONSUME_BUDGET: ["budgetConsumption"],
    CANCEL_MISSION: [],
    ESCALATE_TO_HUMAN: [],
    RECOVER_STATE: ["dataMutation"],
    MODIFY_POLICY: ["dataMutation"],
    SELF_APPROVE: [],
    INVOKE_BILLING: ["budgetConsumption"],
    ACCESS_SECRETS: [],
    ALTER_PERMISSIONS: ["dataMutation"],
  });

/** Subject-class base risk (the floor before declarations and content signals). */
const SUBJECT_BASE_RISK: Readonly<Record<MissionSubjectClass, MissionRiskClass>> = Object.freeze({
  MISSION_PROPOSAL: "LOW",
  MISSION_PLAN: "LOW",
  MISSION_SCHEDULE: "LOW",
  TASK: "MEDIUM",
  EXECUTION_STEP: "MEDIUM",
  RETRY: "MEDIUM",
  RECOVERY_ACTION: "MEDIUM",
  CANCELLATION: "LOW",
  ESCALATION: "MEDIUM",
});

function raise(current: MissionRiskClass, floor: MissionRiskClass): MissionRiskClass {
  return MISSION_RISK_CLASS_RANK[floor] > MISSION_RISK_CLASS_RANK[current] ? floor : current;
}

function raiseOne(current: MissionRiskClass): MissionRiskClass {
  if (current === "LOW") return "MEDIUM";
  if (current === "MEDIUM") return "HIGH";
  return "CRITICAL";
}

export interface DerivedMissionRisk {
  readonly riskClass: MissionRiskClass;
  /** True when any declared signal raised the class above its base. */
  readonly raisedByDeclaration: boolean;
  /** True when an action semantic floor overrode a false/absent declaration. */
  readonly semanticFloorApplied: boolean;
  /** Snapshot of the effective signals (declarations ∪ floors) for the receipt. */
  readonly factors: Readonly<Record<MissionRiskDimension, string | boolean>>;
}

/**
 * Deterministic derivation: base(subject) ∪ semantic floors(action) ∪
 * declared signals ∪ content signals (injection suspicion). Ordered raise
 * rules only — no rule lowers risk. Same inputs ⇒ same class ⇒ same receipt.
 */
export function deriveMissionRisk(input: {
  readonly subjectClass: MissionSubjectClass;
  readonly actionType: MissionActionType;
  readonly declaredRisk: DeclaredMissionRisk;
  readonly injectionSuspected: boolean;
}): DerivedMissionRisk {
  let risk = SUBJECT_BASE_RISK[input.subjectClass];
  let raisedByDeclaration = false;
  let semanticFloorApplied = false;

  const effective: Record<string, string | boolean> = {
    financialImpact: input.declaredRisk.financialImpact,
    externalSideEffects: input.declaredRisk.externalSideEffects,
    customerImpact: input.declaredRisk.customerImpact,
    irreversibleEffects: input.declaredRisk.irreversibleEffects,
    providerCalls: input.declaredRisk.providerCalls,
    dataMutation: input.declaredRisk.dataMutation,
    campaignActivation: input.declaredRisk.campaignActivation,
    budgetConsumption: input.declaredRisk.budgetConsumption,
    regulatoryImplication: input.declaredRisk.regulatoryImplication,
    scopeBreadth: input.declaredRisk.scopeBreadth,
  };

  // Semantic floors from the action type — applied BEFORE the raise rules, so
  // a false/absent declaration can never hide what the action inherently
  // does. Floors feed the compound rules through `effective`.
  for (const floorKey of ACTION_RISK_FLOORS[input.actionType]) {
    if (effective[floorKey] === false) {
      semanticFloorApplied = true;
    }
    effective[floorKey] = true;
  }

  const riskBeforeSignals = risk;

  // Ordered raise rules over the EFFECTIVE signals (declarations ∪ floors).
  // No rule lowers risk.
  if (effective.financialImpact === "MODERATE") risk = raise(risk, "MEDIUM");
  if (effective.financialImpact === "SEVERE") risk = raise(risk, "HIGH");
  if (effective.externalSideEffects) risk = raise(risk, "MEDIUM");
  if (effective.customerImpact) risk = raise(risk, "MEDIUM");
  if (effective.regulatoryImplication) risk = raise(risk, "MEDIUM");
  if (effective.budgetConsumption) risk = raise(risk, "MEDIUM");
  if (effective.dataMutation) risk = raise(risk, "MEDIUM");
  if (effective.providerCalls) risk = raise(risk, "MEDIUM");
  if (effective.campaignActivation) risk = raise(risk, "MEDIUM");
  if (effective.irreversibleEffects) risk = raise(risk, "MEDIUM");
  if (effective.scopeBreadth === "MULTI_BUSINESS") risk = raise(risk, "MEDIUM");
  if (effective.scopeBreadth === "PORTFOLIO") risk = raise(risk, "HIGH");
  if (effective.irreversibleEffects && (effective.providerCalls || effective.campaignActivation)) {
    risk = raise(risk, "HIGH");
  }
  if (effective.providerCalls && effective.campaignActivation) risk = raise(risk, "HIGH");

  raisedByDeclaration =
    MISSION_RISK_CLASS_RANK[risk] > MISSION_RISK_CLASS_RANK[riskBeforeSignals];
  // Content signal: injection suspicion can only raise, never widen authority.
  if (input.injectionSuspected) {
    risk = raiseOne(risk);
  }

  return Object.freeze({
    riskClass: risk,
    raisedByDeclaration,
    semanticFloorApplied,
    factors: Object.freeze(effective),
  });
}
