// ─── R9-X canonical C→B task-plan port binding ───
//
// Binds R9-C's provisional typed mission-task-plan/v1 input port to the
// actual frozen R9-B planning authority. Pre-integration, R9-C accepted the
// port document from the client boundary; at R9-X the production path is
// server-authoritative: the client references { missionId, planId } only and
// the port document is derived here from R9-B's durable plan rows through
// B's own scheduling-handoff service (guarded raw-SQL mission seam + B store
// executor + frozen projection validators). B's planning authority is never
// rewritten: this module maps B's material deterministically into C's port
// vocabulary and fails closed on any drift, staleness, ineligibility or
// schema mismatch. supportedCapabilities is the server-owned environment
// contract (closed platform capability registry), never client input.
//
// schedule != execution authorization: this binding mints scheduling
// material only; it grants no execution authority.

import { z } from "zod";
import {
  MISSION_TASK_PLAN_PORT_VERSION,
  MissionSchedulingInputError,
  MissionSchedulingOwnershipError,
  MissionSchedulingStateConflictError,
  missionTaskPlanPortSchema,
  MISSION_ID_PATTERN,
  PLAN_ID_PATTERN,
  type MissionTaskPlanPort,
  type MissionTaskSpec,
  type MissionTaskSideEffectClass,
} from "./mission-scheduling-contract";
import {
  registerMissionTaskPlan,
  type MissionSchedulingAuthContext,
  type MissionSchedulingServiceDeps,
  type RegisterMissionTaskPlanResult,
} from "./mission-scheduling-service";
import type { MissionSchedulingStoreExecutor } from "./mission-scheduling-store";
import {
  createRawSqlMissionAuthorityReadPort,
} from "../mission-planning/mission-planning-mission-seam";
import {
  bindMissionPlanningStoreExecutor,
  type MissionPlanningStoreExecutor,
} from "../mission-planning/mission-planning-store";
import {
  getSchedulingHandoffForUser,
  type MissionPlanningDeps,
} from "../mission-planning/mission-planning-service";
import type {
  MissionPlanningToSchedulingProjection,
  SchedulingTaskView,
} from "../mission-planning/mission-planning-projection";
import { CAPABILITY_REGISTRY } from "../mission-planning/mission-planning-templates";

// ─── Server-owned environment capability contract ───

/**
 * The closed set of capabilities the platform environment supports: R9-B's
 * closed planning capability registry (CAPABILITY_REGISTRY keys — the
 * vocabulary B's task requirements are minted from). Deterministic,
 * code-level, never client/model-supplied. R9-D's execution capability
 * vocabulary is a different namespace (dotted names that intentionally do
 * not satisfy this port's CAPABILITY_PATTERN) and is deliberately not
 * merged here — the port contract is verified exact, not weakened.
 * Capabilities outside this set keep a task unready/unresolved (readiness
 * never fabricates support).
 */
export const MISSION_ENVIRONMENT_CAPABILITIES: readonly string[] = Object.freeze(
  Object.keys(CAPABILITY_REGISTRY).sort()
);

// ─── Deterministic B→C vocabulary mapping ───

/** B side-effect class → C scheduling side-effect class (total over B's closed set). */
const SIDE_EFFECT_CLASS_MAP: Readonly<Record<string, MissionTaskSideEffectClass>> = Object.freeze({
  NONE: "NONE",
  INTERNAL_DATA: "INTERNAL_MUTATION",
  EXTERNAL_COMMUNICATION: "EXTERNAL_SIDE_EFFECT",
  PROVIDER_MUTATION: "EXTERNAL_SIDE_EFFECT",
  FINANCIAL: "FINANCIAL",
  CAMPAIGN_ACTIVATION: "EXTERNAL_SIDE_EFFECT",
});

interface BTaskGovernanceCharacteristics {
  readonly financialEffect?: string;
  readonly externalCommunication?: boolean;
  readonly providerUse?: boolean;
  readonly irreversibleMutation?: boolean;
  readonly dataMutation?: boolean;
  readonly customerImpact?: boolean;
  readonly campaignActivation?: boolean;
  readonly reviewHints?: readonly string[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/** B [{condition, ref}] → C bounded task-ref string (deterministic, total). */
function mapConditionRefs(items: readonly unknown[]): string[] {
  return items.map((item) => {
    const rec = asRecord(item);
    const condition = String(rec.condition ?? "");
    const ref = typeof rec.ref === "string" ? rec.ref : "";
    const mapped = ref.length > 0 ? `${condition}:${ref}` : condition;
    if (mapped.length === 0) {
      throw new MissionSchedulingInputError(
        "PLAN_PORT_MALFORMED",
        "plan task carries an empty precondition/postcondition reference"
      );
    }
    return mapped;
  });
}

/** Keep only records that belong to C's scheduling-constraint vocabulary. */
function mapSchedulingConstraints(items: readonly unknown[]): MissionTaskSpec["constraints"] {
  const out: Array<Record<string, unknown>> = [];
  for (const item of items) {
    const rec = asRecord(item);
    const constraintType = String(rec.constraintType ?? "");
    if (constraintType === "TIME_WINDOW" || constraintType === "EXCLUSIVE_RESOURCE") {
      out.push(rec);
    }
  }
  // The assembled port is re-validated through missionTaskPlanPortSchema
  // before use — malformed records fail closed at that boundary.
  return out as unknown as MissionTaskSpec["constraints"];
}

/**
 * Map one frozen R9-B scheduling task view into C's port task spec.
 * Authority is preserved, never widened: requiresApproval derives
 * conservatively from B's governance class; irreversible/financial exposure
 * carry B's own characteristics verbatim; side-effect class maps onto C's
 * closed vocabulary (total function — unknown input fails closed).
 */
export function mapPlanningTaskToPortSpec(task: SchedulingTaskView): MissionTaskSpec {
  const characteristics = asRecord(task.governanceCharacteristics) as unknown as BTaskGovernanceCharacteristics;
  const sideEffectClass = SIDE_EFFECT_CLASS_MAP[task.sideEffectClass];
  if (!sideEffectClass) {
    throw new MissionSchedulingInputError(
      "PLAN_PORT_MALFORMED",
      `plan task ${task.taskId} has side-effect class outside the closed vocabulary`
    );
  }
  return {
    taskId: task.taskId,
    taskType: task.taskType,
    preconditions: mapConditionRefs(task.preconditions),
    postconditions: mapConditionRefs(task.postconditions),
    requiredCapabilities: task.requiredCapabilities.map(String),
    constraints: mapSchedulingConstraints(task.constraints),
    governanceCharacteristics: {
      requiresApproval: task.governanceClass !== "AUTONOMY_CANDIDATE",
      irreversible: characteristics.irreversibleMutation === true,
      financialExposure:
        task.sideEffectClass === "FINANCIAL" || characteristics.financialEffect === "DIRECT_SPEND",
      sideEffectClass,
    },
    // R9-B defines no per-task validity windows; the plan-level validity
    // window is enforced by mission/plan freshness checks upstream.
    validity: null,
  };
}

/**
 * Assemble the mission-task-plan/v1 port document from B's frozen scheduling
 * projection. The task set is B's authoritative current task set (task status
 * READY_FOR_SCHEDULING); capability support is evaluated downstream by C
 * readiness against MISSION_ENVIRONMENT_CAPABILITIES — never dropped, never
 * fabricated. The assembled document is validated through the exact port
 * schema before return; mismatch fails closed.
 */
export function buildMissionTaskPlanPortFromProjection(
  projection: MissionPlanningToSchedulingProjection
): MissionTaskPlanPort {
  const tasks = projection.tasks
    .filter((task) => task.status === "READY_FOR_SCHEDULING")
    .map(mapPlanningTaskToPortSpec);
  const port: MissionTaskPlanPort = {
    portVersion: MISSION_TASK_PLAN_PORT_VERSION,
    missionId: projection.missionId,
    planId: projection.planId,
    supportedCapabilities: [...MISSION_ENVIRONMENT_CAPABILITIES],
    tasks,
  };
  const parsed = missionTaskPlanPortSchema.safeParse(port);
  if (!parsed.success) {
    throw new MissionSchedulingInputError(
      "PLAN_PORT_MALFORMED",
      `R9-B plan material does not satisfy the mission-task-plan/v1 port contract: ${parsed.error.issues[0]?.message ?? "unknown"}`
    );
  }
  return parsed.data;
}

// ─── Canonical production port (R9-B authority, read-only) ───

export interface CanonicalPlanPortDeps {
  /** R9-B planning deps (mission-authority seam; read-only). */
  readonly planning: MissionPlanningDeps;
  /** R9-B store executor (durable plan/task rows; read-only here). */
  readonly executor: MissionPlanningStoreExecutor;
}

export type CanonicalMissionTaskPlanPort = (
  ctx: { userId: number },
  input: { missionId: string; planId: string }
) => Promise<MissionTaskPlanPort>;

/**
 * The production binding over the frozen R9-B planning authority: loads the
 * plan's scheduling handoff through B's own service (mission revalidation,
 * freshness, effective-status derivation, frozen projection validators) and
 * derives the port document. Fail closed: unknown plan, cross-mission
 * reference, stale/ineligible plan, or malformed derived material.
 */
export function createCanonicalMissionTaskPlanPort(deps: CanonicalPlanPortDeps): CanonicalMissionTaskPlanPort {
  return async (ctx, input) => {
    const handoff = await getSchedulingHandoffForUser({
      userId: ctx.userId,
      planId: input.planId,
      deps: deps.planning,
      executor: deps.executor,
    });
    if (handoff.projection.missionId !== input.missionId) {
      throw new MissionSchedulingOwnershipError(
        "CROSS_MISSION_DEPENDENCY",
        `plan ${input.planId} belongs to mission ${handoff.projection.missionId}, not ${input.missionId}`
      );
    }
    if (!handoff.schedulingConsumable) {
      throw new MissionSchedulingStateConflictError(
        "MISSION_NOT_SCHEDULABLE",
        `plan ${input.planId} is not consumable for scheduling through the R9-B planning authority (status/freshness/eligibility)`
      );
    }
    return buildMissionTaskPlanPortFromProjection(handoff.projection);
  };
}

/** Build the canonical port deps over the production database handle. */
export function createCanonicalPlanPortDeps(db: unknown): CanonicalPlanPortDeps {
  return {
    planning: { missionAuthority: createRawSqlMissionAuthorityReadPort(db as never) },
    executor: bindMissionPlanningStoreExecutor(db as never),
  };
}

// ─── Authority-bound registration (client references ids only) ───

export const RegisterPlanFromAuthorityInputSchema = z.strictObject({
  missionId: z.string().regex(MISSION_ID_PATTERN),
  planId: z.string().regex(PLAN_ID_PATTERN),
});
export type RegisterPlanFromAuthorityInput = z.infer<typeof RegisterPlanFromAuthorityInputSchema>;

/**
 * Server-authoritative plan registration: the client supplies { missionId,
 * planId } only; the port document is resolved from the frozen R9-B
 * authority and registered as verbatim scheduling material (idempotent,
 * fingerprint-anchored). The typed provisional port path
 * (registerMissionTaskPlan) remains for direct service-level testing; the
 * router boundary no longer accepts client plan material.
 */
export async function registerMissionTaskPlanFromAuthority(
  db: MissionSchedulingStoreExecutor | undefined,
  deps: MissionSchedulingServiceDeps,
  planning: CanonicalPlanPortDeps,
  ctx: MissionSchedulingAuthContext,
  rawInput: unknown
): Promise<RegisterMissionTaskPlanResult> {
  const parsed = RegisterPlanFromAuthorityInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new MissionSchedulingInputError(
      "PLAN_PORT_MALFORMED",
      `plan registration reference is malformed: ${parsed.error.issues[0]?.message ?? "unknown"}`
    );
  }
  const port = await createCanonicalMissionTaskPlanPort(planning)(ctx, parsed.data);
  return registerMissionTaskPlan(db, deps, ctx, port);
}

// ─── Seam-classification surface (X4 inventory) ───

export const PLAN_PORT_BINDING = Object.freeze({
  seam: "R9-C mission-task-plan/v1 typed input port",
  owner: "R9-C (scheduling material) bound to R9-B (planning authority)",
  classification: "BIND",
  reason:
    "Provisional client-supplied typed port replaced at the router boundary by server-side derivation from frozen R9-B durable rows through B's own scheduling-handoff service; service-level typed path retained for direct tests.",
  authorityEffect: "Plan content authority remains R9-B; C only sequences/schedules.",
  securityEffect: "Clients can no longer inject arbitrary task definitions, capabilities or environment contracts.",
});
