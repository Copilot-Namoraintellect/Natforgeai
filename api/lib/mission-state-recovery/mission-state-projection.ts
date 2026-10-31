// ─── R9-E Mission State & Recovery — read-only mission-control projection ───
//
// Frozen downstream projection (E11) for R9-X / future mission-control
// consumers: docs/contracts/mission-state-to-mission-control-contract.md.
// Exact key allowlist — asserted exact in acceptance. Verbatim disclaimers
// travel with every projection. Read-only: it authorizes nothing, mutates
// nothing and carries no secrets, credentials, action parameters or raw
// provider payloads — only hashes, closed labels and bounded references.

import { MISSION_STATE_TO_MISSION_CONTROL_PROJECTION_VERSION } from "./mission-state-recovery-contract";

export const MISSION_CONTROL_DISCLAIMER =
  "observability != authority. This projection is derived operational state — never mission " +
  "objective, never execution authorization, never governance. recovery proposal != recovery " +
  "authorization; authorized recovery != execution.";

export const MISSION_CONTROL_HISTORY_DISCLAIMER =
  "execution history is immutable input. Uncertainty != success; failure is never silently " +
  "converted to success. Consumers must never rewrite upstream authority records.";

export const MISSION_CONTROL_PROJECTION_FIELD_KEYS = [
  "contractVersion",
  "missionId",
  "planId",
  "scheduleId",
  "businessId",
  "missionStatus",
  "healthClass",
  "taskSummary",
  "taskStates",
  "latestExecutionRefs",
  "blockingReasons",
  "uncertainties",
  "recoveryCandidates",
  "governanceStatus",
  "latestAuthoritativeRefs",
  "observedAt",
  "derivedFromVersion",
  "validUntil",
  "limitations",
  "disclaimer",
  "historyDisclaimer",
] as const;

export type MissionControlProjectionKey = (typeof MISSION_CONTROL_PROJECTION_FIELD_KEYS)[number];

export interface MissionControlTaskStateProjection {
  readonly taskId: string;
  readonly status: string;
  readonly failureClass: string;
  readonly uncertaintyClass: string;
  readonly retryEligibility: boolean;
  readonly recoveryRequired: boolean;
  readonly blockingReasons: readonly string[];
  readonly uncertainties: readonly string[];
  readonly latestAttemptId: string | null;
  readonly lastUpdatedAt: string;
}

export interface MissionControlRecoveryProjection {
  readonly recoveryCandidateId: string;
  readonly taskId: string;
  readonly recoveryType: string;
  readonly status: string;
  readonly failureClass: string;
  readonly uncertaintyClass: string;
  readonly latestAttemptId: string | null;
  readonly advisoryOnly: true;
}

export interface MissionControlProjection {
  readonly contractVersion: typeof MISSION_STATE_TO_MISSION_CONTROL_PROJECTION_VERSION;
  readonly missionId: string;
  readonly planId: string;
  readonly scheduleId: string;
  readonly businessId: number;
  readonly missionStatus: string;
  readonly healthClass: string;
  readonly taskSummary: Record<string, unknown>;
  readonly taskStates: readonly MissionControlTaskStateProjection[];
  readonly latestExecutionRefs: readonly string[];
  readonly blockingReasons: readonly string[];
  readonly uncertainties: readonly string[];
  readonly recoveryCandidates: readonly MissionControlRecoveryProjection[];
  readonly governanceStatus: string;
  readonly latestAuthoritativeRefs: Record<string, unknown>;
  readonly observedAt: string;
  readonly derivedFromVersion: string;
  readonly validUntil: string;
  readonly limitations: readonly string[];
  readonly disclaimer: typeof MISSION_CONTROL_DISCLAIMER;
  readonly historyDisclaimer: typeof MISSION_CONTROL_HISTORY_DISCLAIMER;
}

const BASE_LIMITATIONS: readonly string[] = [
  "derived operational state — never mission objective authority",
  "observability != authority; this projection authorizes nothing",
  "recovery candidates are advisory; authorization is R9-F authority only",
  "authorized recovery is handed to R9-D for execution; execution never occurs in R9-E",
  "uncertainty != success; unknown external results remain visible",
  "no secrets, action parameters or provider payloads are carried",
];

export function buildMissionControlProjection(input: {
  missionId: string;
  planId: string;
  scheduleId: string;
  businessId: number;
  missionStatus: string;
  healthClass: string;
  taskSummary: Record<string, unknown>;
  taskStates: readonly MissionControlTaskStateProjection[];
  latestExecutionRefs: readonly string[];
  blockingReasons: readonly string[];
  uncertainties: readonly string[];
  recoveryCandidates: readonly MissionControlRecoveryProjection[];
  governanceStatus: string;
  latestAuthoritativeRefs: Record<string, unknown>;
  observedAt: string;
  derivedFromVersion: string;
  validUntil: string;
  extraLimitations?: readonly string[];
}): MissionControlProjection {
  return {
    contractVersion: MISSION_STATE_TO_MISSION_CONTROL_PROJECTION_VERSION,
    missionId: input.missionId,
    planId: input.planId,
    scheduleId: input.scheduleId,
    businessId: input.businessId,
    missionStatus: input.missionStatus,
    healthClass: input.healthClass,
    taskSummary: input.taskSummary,
    taskStates: input.taskStates,
    latestExecutionRefs: input.latestExecutionRefs,
    blockingReasons: input.blockingReasons,
    uncertainties: input.uncertainties,
    recoveryCandidates: input.recoveryCandidates,
    governanceStatus: input.governanceStatus,
    latestAuthoritativeRefs: input.latestAuthoritativeRefs,
    observedAt: input.observedAt,
    derivedFromVersion: input.derivedFromVersion,
    validUntil: input.validUntil,
    limitations: [...BASE_LIMITATIONS, ...(input.extraLimitations ?? [])],
    disclaimer: MISSION_CONTROL_DISCLAIMER,
    historyDisclaimer: MISSION_CONTROL_HISTORY_DISCLAIMER,
  };
}
