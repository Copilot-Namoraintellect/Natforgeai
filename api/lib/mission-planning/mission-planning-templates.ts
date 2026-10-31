// ─── R9-B Mission Planning — rule templates, capability registry,
//     governance pre-classification (B3/B6/B7) ───
//
// PURE deterministic decomposition. Task sets derive from the closed R9-A
// mission vocabulary + mission constraints via immutable code-level rule
// templates — no model in the decision path, no runtime template mutation,
// no fabricated capability. Tasks whose required capabilities are not
// present in this repository never become task definitions; they are
// unresolved planning work (contract §6).
//
// Governance characteristics here are PROPOSAL MATERIAL for R9-F only
// (contract §7): this stream sets no decision, no ALLOW, no risk class.

import {
  MISSION_TYPES,
  fail,
  type ArtifactType,
  type CapabilityStatus,
  type ConditionType,
  type ExecutionClass,
  type FinancialEffect,
  type GovernanceClass,
  type MissionConstraintType,
  type MissionType,
  type SideEffectClass,
  type TaskType,
} from "./mission-planning-contract";

// ─── Capability registry (B6; closed, code-level) ───

export interface CapabilityInfo {
  readonly status: CapabilityStatus;
  readonly basis: string;
}

export const CAPABILITY_REGISTRY: Readonly<Record<string, CapabilityInfo>> = Object.freeze({
  planning_validation: {
    status: "SUPPORTED",
    basis: "deterministic server-side planning validation",
  },
  market_research: {
    status: "CONDITIONALLY_SUPPORTED",
    basis: "external evidence ingestion exists (R8-C); availability depends on configured sources",
  },
  analytics_observation: {
    status: "SUPPORTED",
    basis: "analytics router / metrics",
  },
  content_generation: {
    status: "SUPPORTED",
    basis: "Content Studio / AI generation (content-router)",
  },
  human_review: {
    status: "SUPPORTED",
    basis: "approval ledger + OTP review authority",
  },
  campaign_configuration: {
    status: "SUPPORTED",
    basis: "campaign-router CRUD (configuration only — activation governed separately)",
  },
  governance_evaluation: {
    status: "SUPPORTED",
    basis: "policy + approval infrastructure (R5-E/R7-F/R8-F)",
  },
  social_publishing: {
    status: "CONDITIONALLY_SUPPORTED",
    basis: "provider-dependent (Meta/LinkedIn integrations); execution also requires R9-F authorization",
  },
  email_messaging: {
    status: "CONDITIONALLY_SUPPORTED",
    basis: "provider-dependent (email transport requires configuration)",
  },
  crm_record_management: {
    status: "SUPPORTED",
    basis: "lead-router CRM",
  },
  image_generation: {
    status: "SUPPORTED",
    basis: "image-router",
  },
  video_generation: {
    status: "CONDITIONALLY_SUPPORTED",
    basis: "feature-flagged video generation (ENABLE_*_VIDEO)",
  },
  budget_reallocation: {
    status: "CONDITIONALLY_SUPPORTED",
    basis: "R7-E exists; execution under R7-F governance",
  },
  task_scheduling: {
    status: "UNRESOLVED",
    basis: "R9-C scheduling is a downstream stream — not yet present",
  },
  whatsapp_messaging: {
    status: "UNSUPPORTED",
    basis: "provider unsupported (R6-X provider truth)",
  },
  sms_messaging: {
    status: "UNSUPPORTED",
    basis: "provider unsupported (R6-X provider truth)",
  },
});

export function classifyCapabilities(required: readonly string[]): CapabilityStatus {
  let status: CapabilityStatus = "SUPPORTED";
  for (const cap of required) {
    const info = CAPABILITY_REGISTRY[cap];
    if (!info) return "UNSUPPORTED"; // unknown capability — never fabricated
    if (info.status === "UNSUPPORTED") return "UNSUPPORTED";
    if (info.status === "UNRESOLVED") status = "UNRESOLVED";
    else if (info.status === "CONDITIONALLY_SUPPORTED" && status === "SUPPORTED") {
      status = "CONDITIONALLY_SUPPORTED";
    }
  }
  return status;
}

// ─── Mission constraint record (verbatim R9-A shape) ───

export interface MissionConstraintRecord {
  readonly constraintType: MissionConstraintType | string;
  readonly statement: string;
  readonly referenceValue?: string | null;
  readonly amountMinorUnits?: number | null;
  readonly currency?: string | null;
}

export function missionHasConstraint(
  constraints: readonly MissionConstraintRecord[],
  constraintType: string
): boolean {
  return constraints.some((c) => c.constraintType === constraintType);
}

// ─── Task templates (B3; immutable per engine version) ───

export interface TaskGovernanceCharacteristics {
  readonly financialEffect: FinancialEffect;
  readonly externalCommunication: boolean;
  readonly providerUse: boolean;
  readonly irreversibleMutation: boolean;
  readonly dataMutation: boolean;
  readonly customerImpact: boolean;
  readonly campaignActivation: boolean;
  readonly reviewHints: readonly string[];
}

export interface TaskTemplate {
  readonly taskType: TaskType;
  readonly requiredInputs: readonly ArtifactType[];
  readonly expectedOutputs: readonly ArtifactType[];
  readonly requiredCapabilities: readonly string[];
  readonly preconditions: readonly { condition: ConditionType; ref: string | null }[];
  readonly postconditions: readonly { condition: ConditionType; ref: string | null }[];
  readonly sideEffectClass: SideEffectClass;
  readonly executionClass: ExecutionClass;
  readonly governanceClass: GovernanceClass;
  readonly characteristics: TaskGovernanceCharacteristics;
}

const T = (template: TaskTemplate): TaskTemplate => Object.freeze(template);

export const TASK_TEMPLATES: Readonly<Record<TaskType, TaskTemplate>> = Object.freeze({
  RESEARCH: T({
    taskType: "RESEARCH",
    requiredInputs: ["MISSION_AUTHORITY"],
    expectedOutputs: ["RESEARCH_FINDINGS"],
    requiredCapabilities: ["market_research"],
    preconditions: [{ condition: "MISSION_CURRENT", ref: null }],
    postconditions: [
      { condition: "ARTIFACT_PRODUCED", ref: "RESEARCH_FINDINGS" },
      { condition: "EVIDENCE_RECORDED", ref: null },
    ],
    sideEffectClass: "NONE",
    executionClass: "INTERNAL_ONLY",
    governanceClass: "AUTONOMY_CANDIDATE",
    characteristics: {
      financialEffect: "NONE",
      externalCommunication: false,
      providerUse: false,
      irreversibleMutation: false,
      dataMutation: false,
      customerImpact: false,
      campaignActivation: false,
      reviewHints: ["EVIDENCE_QUALITY_REVIEW"],
    },
  }),
  ANALYSE: T({
    taskType: "ANALYSE",
    requiredInputs: ["RESEARCH_FINDINGS"],
    expectedOutputs: ["ANALYSIS_REPORT"],
    requiredCapabilities: ["analytics_observation"],
    preconditions: [{ condition: "INPUT_ARTIFACT_READY", ref: "RESEARCH_FINDINGS" }],
    postconditions: [{ condition: "ARTIFACT_PRODUCED", ref: "ANALYSIS_REPORT" }],
    sideEffectClass: "INTERNAL_DATA",
    executionClass: "INTERNAL_ONLY",
    governanceClass: "AUTONOMY_CANDIDATE",
    characteristics: {
      financialEffect: "NONE",
      externalCommunication: false,
      providerUse: false,
      irreversibleMutation: false,
      dataMutation: true,
      customerImpact: false,
      campaignActivation: false,
      reviewHints: ["ANALYSIS_QUALITY_REVIEW"],
    },
  }),
  VALIDATE: T({
    taskType: "VALIDATE",
    requiredInputs: ["MISSION_AUTHORITY", "ANALYSIS_REPORT"],
    expectedOutputs: ["PLAN_RECORD"],
    requiredCapabilities: ["planning_validation"],
    preconditions: [
      { condition: "MISSION_CURRENT", ref: null },
      { condition: "INPUT_ARTIFACT_READY", ref: "ANALYSIS_REPORT" },
    ],
    postconditions: [
      { condition: "EVIDENCE_RECORDED", ref: null },
      { condition: "GOVERNANCE_CLASSIFICATION_RECORDED", ref: null },
    ],
    sideEffectClass: "INTERNAL_DATA",
    executionClass: "INTERNAL_ONLY",
    governanceClass: "AUTONOMY_CANDIDATE",
    characteristics: {
      financialEffect: "NONE",
      externalCommunication: false,
      providerUse: false,
      irreversibleMutation: false,
      dataMutation: true,
      customerImpact: false,
      campaignActivation: false,
      reviewHints: ["VALIDATION_REVIEW"],
    },
  }),
  PREPARE_CONTENT: T({
    taskType: "PREPARE_CONTENT",
    requiredInputs: ["ANALYSIS_REPORT", "MISSION_AUTHORITY"],
    expectedOutputs: ["CONTENT_DRAFT"],
    requiredCapabilities: ["content_generation"],
    preconditions: [{ condition: "INPUT_ARTIFACT_READY", ref: "ANALYSIS_REPORT" }],
    postconditions: [{ condition: "ARTIFACT_PRODUCED", ref: "CONTENT_DRAFT" }],
    sideEffectClass: "INTERNAL_DATA",
    executionClass: "INTERNAL_ONLY",
    governanceClass: "AUTONOMY_CANDIDATE",
    characteristics: {
      financialEffect: "NONE",
      externalCommunication: false,
      providerUse: false,
      irreversibleMutation: false,
      dataMutation: true,
      customerImpact: false,
      campaignActivation: false,
      reviewHints: ["CONTENT_QUALITY_REVIEW"],
    },
  }),
  REVIEW_CONTENT: T({
    taskType: "REVIEW_CONTENT",
    requiredInputs: ["CONTENT_DRAFT"],
    expectedOutputs: ["REVIEWED_CONTENT"],
    requiredCapabilities: ["human_review"],
    preconditions: [{ condition: "INPUT_ARTIFACT_READY", ref: "CONTENT_DRAFT" }],
    postconditions: [
      { condition: "ARTIFACT_PRODUCED", ref: "REVIEWED_CONTENT" },
      { condition: "HUMAN_REVIEW_COMPLETED", ref: null },
    ],
    sideEffectClass: "NONE",
    executionClass: "GOVERNANCE_GATED",
    governanceClass: "STANDARD_REVIEW",
    characteristics: {
      financialEffect: "NONE",
      externalCommunication: false,
      providerUse: false,
      irreversibleMutation: false,
      dataMutation: false,
      customerImpact: false,
      campaignActivation: false,
      reviewHints: ["HUMAN_REVIEW"],
    },
  }),
  CONFIGURE_CAMPAIGN: T({
    taskType: "CONFIGURE_CAMPAIGN",
    requiredInputs: ["MISSION_AUTHORITY", "REVIEWED_CONTENT"],
    expectedOutputs: ["CAMPAIGN_CONFIGURATION"],
    requiredCapabilities: ["campaign_configuration"],
    preconditions: [
      { condition: "MISSION_CURRENT", ref: null },
      { condition: "HUMAN_REVIEW_COMPLETED", ref: null },
    ],
    postconditions: [
      { condition: "ARTIFACT_PRODUCED", ref: "CAMPAIGN_CONFIGURATION" },
      { condition: "GOVERNANCE_CLASSIFICATION_RECORDED", ref: null },
    ],
    sideEffectClass: "INTERNAL_DATA",
    executionClass: "GOVERNANCE_GATED",
    governanceClass: "STANDARD_REVIEW",
    characteristics: {
      financialEffect: "NONE",
      externalCommunication: false,
      providerUse: false,
      irreversibleMutation: false,
      dataMutation: true,
      customerImpact: false,
      campaignActivation: false,
      reviewHints: ["ACTIVATION_REQUIRES_GOVERNANCE"],
    },
  }),
  REQUEST_APPROVAL: T({
    taskType: "REQUEST_APPROVAL",
    requiredInputs: ["MISSION_AUTHORITY", "PLAN_RECORD"],
    expectedOutputs: ["APPROVAL_DECISION"],
    requiredCapabilities: ["governance_evaluation", "human_review"],
    preconditions: [{ condition: "MISSION_CURRENT", ref: null }],
    postconditions: [
      { condition: "ARTIFACT_PRODUCED", ref: "APPROVAL_DECISION" },
      { condition: "HUMAN_REVIEW_COMPLETED", ref: null },
      { condition: "GOVERNANCE_CLASSIFICATION_RECORDED", ref: null },
    ],
    sideEffectClass: "NONE",
    executionClass: "GOVERNANCE_GATED",
    governanceClass: "HUMAN_REVIEW_REQUIRED",
    characteristics: {
      financialEffect: "NONE",
      externalCommunication: false,
      providerUse: false,
      irreversibleMutation: false,
      dataMutation: false,
      customerImpact: false,
      campaignActivation: false,
      reviewHints: ["HUMAN_REVIEW", "APPROVAL_BINDING_REVIEW"],
    },
  }),
  SCHEDULE_ACTION: T({
    taskType: "SCHEDULE_ACTION",
    requiredInputs: ["PLAN_RECORD"],
    expectedOutputs: ["PLAN_RECORD"],
    requiredCapabilities: ["task_scheduling"],
    preconditions: [{ condition: "MISSION_CURRENT", ref: null }],
    postconditions: [{ condition: "READY_FOR_SCHEDULING", ref: null }],
    sideEffectClass: "NONE",
    executionClass: "SCHEDULING_BOUNDARY",
    governanceClass: "STANDARD_REVIEW",
    characteristics: {
      financialEffect: "NONE",
      externalCommunication: false,
      providerUse: false,
      irreversibleMutation: false,
      dataMutation: false,
      customerImpact: false,
      campaignActivation: false,
      reviewHints: ["SCHEDULING_BOUNDARY_REVIEW"],
    },
  }),
  MONITOR: T({
    taskType: "MONITOR",
    requiredInputs: ["CAMPAIGN_CONFIGURATION"],
    expectedOutputs: ["OBSERVATION_METRICS"],
    requiredCapabilities: ["analytics_observation"],
    preconditions: [{ condition: "ARTIFACT_PRODUCED", ref: "CAMPAIGN_CONFIGURATION" }],
    postconditions: [
      { condition: "ARTIFACT_PRODUCED", ref: "OBSERVATION_METRICS" },
      { condition: "EVIDENCE_RECORDED", ref: null },
    ],
    sideEffectClass: "NONE",
    executionClass: "INTERNAL_ONLY",
    governanceClass: "AUTONOMY_CANDIDATE",
    characteristics: {
      financialEffect: "NONE",
      externalCommunication: false,
      providerUse: false,
      irreversibleMutation: false,
      dataMutation: false,
      customerImpact: false,
      campaignActivation: false,
      reviewHints: ["OBSERVATION_FRESHNESS_REVIEW"],
    },
  }),
  RECONCILE: T({
    taskType: "RECONCILE",
    requiredInputs: ["OBSERVATION_METRICS", "MISSION_AUTHORITY"],
    expectedOutputs: ["RECONCILIATION_REPORT"],
    requiredCapabilities: ["analytics_observation", "budget_reallocation"],
    preconditions: [{ condition: "INPUT_ARTIFACT_READY", ref: "OBSERVATION_METRICS" }],
    postconditions: [
      { condition: "ARTIFACT_PRODUCED", ref: "RECONCILIATION_REPORT" },
      { condition: "EVIDENCE_RECORDED", ref: null },
    ],
    sideEffectClass: "FINANCIAL",
    executionClass: "GOVERNANCE_GATED",
    governanceClass: "STANDARD_REVIEW",
    characteristics: {
      financialEffect: "INDIRECT",
      externalCommunication: false,
      providerUse: false,
      irreversibleMutation: false,
      dataMutation: true,
      customerImpact: false,
      campaignActivation: false,
      reviewHints: ["FINANCIAL_REVIEW"],
    },
  }),
  REPORT: T({
    taskType: "REPORT",
    requiredInputs: ["ANALYSIS_REPORT", "OBSERVATION_METRICS"],
    expectedOutputs: ["FINAL_REPORT"],
    requiredCapabilities: ["analytics_observation"],
    preconditions: [{ condition: "PRIOR_TASKS_COMPLETED", ref: null }],
    postconditions: [
      { condition: "ARTIFACT_PRODUCED", ref: "FINAL_REPORT" },
      { condition: "EVIDENCE_RECORDED", ref: null },
    ],
    sideEffectClass: "NONE",
    executionClass: "INTERNAL_ONLY",
    governanceClass: "AUTONOMY_CANDIDATE",
    characteristics: {
      financialEffect: "NONE",
      externalCommunication: false,
      providerUse: false,
      irreversibleMutation: false,
      dataMutation: true,
      customerImpact: false,
      campaignActivation: false,
      reviewHints: ["REPORT_ACCURACY_REVIEW"],
    },
  }),
  ESCALATE: T({
    taskType: "ESCALATE",
    requiredInputs: ["MISSION_AUTHORITY"],
    expectedOutputs: ["ESCALATION_NOTICE"],
    requiredCapabilities: ["human_review", "governance_evaluation"],
    preconditions: [{ condition: "MISSION_CURRENT", ref: null }],
    postconditions: [
      { condition: "ARTIFACT_PRODUCED", ref: "ESCALATION_NOTICE" },
      { condition: "HUMAN_REVIEW_COMPLETED", ref: null },
    ],
    sideEffectClass: "EXTERNAL_COMMUNICATION",
    executionClass: "GOVERNANCE_GATED",
    governanceClass: "HUMAN_REVIEW_REQUIRED",
    characteristics: {
      financialEffect: "NONE",
      externalCommunication: true,
      providerUse: false,
      irreversibleMutation: false,
      dataMutation: false,
      customerImpact: true,
      campaignActivation: false,
      reviewHints: ["ESCALATION_REVIEW"],
    },
  }),
});

// ─── Rule decomposition table (B3; contract §4.2) ───

const MISSION_TYPE_TASK_RULES: Readonly<Record<MissionType, readonly TaskType[]>> = Object.freeze({
  OPPORTUNITY_PURSUIT: ["RESEARCH", "ANALYSE", "PREPARE_CONTENT", "REVIEW_CONTENT", "CONFIGURE_CAMPAIGN", "MONITOR", "REPORT"],
  MARKET_EXPANSION: ["RESEARCH", "ANALYSE", "PREPARE_CONTENT", "REVIEW_CONTENT", "CONFIGURE_CAMPAIGN", "MONITOR", "REPORT"],
  POSITIONING_ACTION: ["RESEARCH", "ANALYSE", "PREPARE_CONTENT", "REVIEW_CONTENT", "REPORT"],
  RISK_RESPONSE: ["RESEARCH", "ANALYSE", "VALIDATE", "CONFIGURE_CAMPAIGN", "MONITOR", "REPORT", "ESCALATE"],
  DEFENSIVE_RESPONSE: ["RESEARCH", "VALIDATE", "CONFIGURE_CAMPAIGN", "MONITOR", "ESCALATE", "REPORT"],
  CAPABILITY_ACTION: ["RESEARCH", "ANALYSE", "VALIDATE", "CONFIGURE_CAMPAIGN", "RECONCILE", "REPORT"],
  CHANNEL_SHIFT: ["RESEARCH", "ANALYSE", "CONFIGURE_CAMPAIGN", "MONITOR", "RECONCILE", "REPORT"],
  PORTFOLIO_REBALANCE: ["ANALYSE", "RECONCILE", "REPORT", "ESCALATE"],
});

/**
 * Deterministic task-type sequence for a mission type + constraint set.
 * Unknown mission types fail closed (contract §4.2). Constraint-driven
 * additions: HUMAN_REVIEW_REQUIRED ⇒ REQUEST_APPROVAL before the first
 * side-effecting task; MEASURABLE_OUTCOME_REQUIRED ⇒ MONITOR+REPORT ensured;
 * BUDGET_CEILING ⇒ RECONCILE ensured.
 */
export function deriveTaskTypeSequence(
  missionType: string,
  constraints: readonly MissionConstraintRecord[]
): TaskType[] {
  const base = MISSION_TYPE_TASK_RULES[missionType as MissionType];
  if (!base) fail("MISSION_NOT_PLANNABLE", `mission type ${missionType} has no rule decomposition`);
  const sequence: TaskType[] = [...base];

  const ensure = (types: readonly TaskType[]) => {
    for (const t of types) if (!sequence.includes(t)) sequence.push(t);
  };

  if (missionHasConstraint(constraints, "HUMAN_REVIEW_REQUIRED") && !sequence.includes("REQUEST_APPROVAL")) {
    // Insert before the first side-effecting task (sideEffectClass != NONE).
    const firstSideEffecting = sequence.findIndex(
      (t) => TASK_TEMPLATES[t].sideEffectClass !== "NONE"
    );
    if (firstSideEffecting === -1) sequence.push("REQUEST_APPROVAL");
    else sequence.splice(firstSideEffecting, 0, "REQUEST_APPROVAL");
  }
  if (missionHasConstraint(constraints, "MEASURABLE_OUTCOME_REQUIRED")) {
    ensure(["MONITOR", "REPORT"]);
  }
  if (missionHasConstraint(constraints, "BUDGET_CEILING")) {
    ensure(["RECONCILE"]);
  }
  return sequence;
}

/**
 * A candidate task is prohibited when the mission's PROHIBITED_ACTION
 * constraint reference (upper-cased) matches its task type or one of its
 * review hints (contract §4.2). Prohibited candidates never become tasks.
 */
export function isTaskProhibited(
  taskType: TaskType,
  constraints: readonly MissionConstraintRecord[]
): { prohibited: boolean; matchedConstraint: MissionConstraintRecord | null } {
  for (const c of constraints) {
    if (c.constraintType !== "PROHIBITED_ACTION") continue;
    const ref = String(c.referenceValue ?? "").trim().toUpperCase();
    if (!ref) continue;
    const template = TASK_TEMPLATES[taskType];
    if (
      taskType === ref ||
      template.characteristics.reviewHints.some((h) => h === ref)
    ) {
      return { prohibited: true, matchedConstraint: c };
    }
  }
  return { prohibited: false, matchedConstraint: null };
}

/**
 * Server-derived canonical task objective (contract §3/§4.3) — deterministic
 * template wording bound to mission material; never client/model text; never
 * hashed with advisory rewording.
 */
export function deriveTaskObjective(input: {
  taskType: TaskType;
  missionId: string;
  missionType: string;
  objectiveType: string;
  planScopeKey: string;
}): string {
  const patterns: Record<TaskType, string> = {
    RESEARCH: "Research governed market and audience evidence for the mission within the bounded plan scope",
    ANALYSE: "Analyse the governed research evidence and bind findings to the mission objective",
    VALIDATE: "Validate mission feasibility, assumptions and constraint preservation before downstream work",
    PREPARE_CONTENT: "Prepare bounded campaign content drafts serving the mission objective",
    REVIEW_CONTENT: "Review prepared content under independent human review before any configuration use",
    CONFIGURE_CAMPAIGN: "Configure the bounded campaign serving the mission objective (activation remains governed)",
    REQUEST_APPROVAL: "Request the governed human approval required by mission constraints before side-effecting work",
    SCHEDULE_ACTION: "Define the scheduling handoff for downstream sequencing authority",
    MONITOR: "Monitor bounded observation metrics against the mission success criteria",
    RECONCILE: "Reconcile observed outcomes and budget posture against the mission constraint set",
    REPORT: "Report the mission outcome evidence and unresolved items to the operator",
    ESCALATE: "Escalate mission-relevant risk or exception evidence to independent human review",
  };
  return (
    `${patterns[input.taskType]} [mission ${input.missionId}; type ${input.missionType}; ` +
    `objective ${input.objectiveType}; scope ${input.planScopeKey}]`
  );
}

/** Mission types outside the closed R9-A vocabulary are never planned. */
export function isKnownMissionType(missionType: string): boolean {
  return (MISSION_TYPES as readonly string[]).includes(missionType);
}
