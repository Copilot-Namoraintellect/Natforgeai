// ─── R9-B Mission Planning — durable store ───
//
// DB-authoritative persistence over the R9-B-owned tables. Convergence
// anchors are the durable unique keys (userId, planId) / (userId, taskId):
// retried or raced writes re-read the committed row and converge
// (idempotent_replay); a stored row under the same anchor with a different
// material fingerprint fails closed (PLAN_REPLAY_CONFLICT). Plan/task rows
// are immutable in their material core — revisions are NEW plan versions;
// only the plan lifecycle status transitions in place, guarded by an
// optimistic version CAS. Lifecycle history is append-only.
//
// Canonical tables live in @db/schema (single source of truth; the 0037
// migration artefact is stream-local provisional — NOT executed; R9-X owns
// canonical sequencing). The structural executor seam matches the
// AuditDbExecutor convention.

import { and, eq } from "drizzle-orm";
import { missionPlans, missionPlanTasks, missionPlanLifecycleEvents } from "@db/schema";
import { getDb } from "../../queries/connection";
import { PLAN_STATUSES, fail } from "./mission-planning-contract";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export interface MissionPlanningStoreExecutor {
  readonly select: Db["select"];
  readonly insert: Db["insert"];
  readonly update: Db["update"];
}

/** Bind a Drizzle client or transaction callback to the executor seam. */
export function bindMissionPlanningStoreExecutor(
  db: Pick<Db, "select" | "insert" | "update">
): MissionPlanningStoreExecutor {
  return db as MissionPlanningStoreExecutor;
}

function isDuplicateKeyError(err: unknown): boolean {
  const seen = new WeakSet<object>();
  let current: unknown = err;
  let depth = 0;
  while (current && typeof current === "object" && depth < 5) {
    if (seen.has(current)) break;
    seen.add(current);
    const e = current as Record<string, unknown>;
    if (e.code === "ER_DUP_ENTRY" || e.errno === 1062) return true;
    current = e.cause;
    depth += 1;
  }
  return false;
}

// ─── Plan rows ───

export interface MissionPlanRecord {
  readonly planId: string;
  readonly planVersion: number;
  readonly userId: number;
  readonly businessId: number;
  readonly missionId: string;
  readonly missionAuthorityVersion: string;
  readonly boundMissionVersion: number;
  readonly planScopeKey: string;
  readonly taskIds: unknown;
  readonly taskSetFingerprint: string;
  readonly constraintSetFingerprint: string;
  readonly missionConstraints: unknown;
  readonly planningAssumptions: unknown;
  readonly unresolvedItems: unknown;
  readonly completenessStatus: string;
  readonly status: string;
  readonly validFrom: string;
  readonly validUntil: string;
  readonly supersedesPlanId: string | null;
  readonly planFingerprint: string;
  readonly modelAssistanceFlagged: boolean;
  readonly version: number;
  readonly createdAt?: unknown;
  readonly updatedAt?: unknown;
}

export interface MissionPlanTaskRecord {
  readonly taskId: string;
  readonly planId: string;
  readonly planVersion: number;
  readonly userId: number;
  readonly businessId: number;
  readonly missionId: string;
  readonly taskType: string;
  readonly taskSequence: number;
  readonly taskObjective: string;
  readonly objectiveWordingDraft: string | null;
  readonly requiredInputs: unknown;
  readonly expectedOutputs: unknown;
  readonly requiredCapabilities: unknown;
  readonly constraints: unknown;
  readonly preconditions: unknown;
  readonly postconditions: unknown;
  readonly governanceClass: string;
  readonly sideEffectClass: string;
  readonly executionClass: string;
  readonly capabilityStatus: string;
  readonly governanceCharacteristics: unknown;
  readonly status: string;
  readonly taskFingerprint: string;
  readonly createdAt?: unknown;
  readonly updatedAt?: unknown;
}

export interface MissionPlanLifecycleRecord {
  readonly lifecycleEventId: string;
  readonly userId: number;
  readonly planId: string;
  readonly lifecycleType: string;
  readonly targetStatus: string;
  readonly successorPlanId: string | null;
  readonly occurredAt: string;
  readonly reasonCode: string | null;
  readonly createdAt?: unknown;
}

export async function getPlan(
  executor: MissionPlanningStoreExecutor,
  userId: number,
  planId: string
): Promise<MissionPlanRecord | null> {
  const rows = await executor
    .select()
    .from(missionPlans)
    .where(and(eq(missionPlans.userId, userId), eq(missionPlans.planId, planId)))
    .limit(1);
  return (rows[0] as unknown as MissionPlanRecord | undefined) ?? null;
}

export async function getPlanByMissionVersion(
  executor: MissionPlanningStoreExecutor,
  userId: number,
  missionId: string,
  planVersion: number
): Promise<MissionPlanRecord | null> {
  const rows = await executor
    .select()
    .from(missionPlans)
    .where(and(eq(missionPlans.userId, userId), eq(missionPlans.missionId, missionId)))
    .limit(50);
  return (
    (rows as unknown as MissionPlanRecord[]).find((r) => r.planVersion === planVersion) ?? null
  );
}

export async function listPlanRows(
  executor: MissionPlanningStoreExecutor,
  userId: number,
  filter: { missionId?: string; status?: string } = {}
): Promise<MissionPlanRecord[]> {
  const rows = await executor.select().from(missionPlans).where(eq(missionPlans.userId, userId));
  return (rows as unknown as MissionPlanRecord[])
    .filter((r) => (filter.missionId === undefined || r.missionId === filter.missionId))
    .filter((r) => (filter.status === undefined || r.status === filter.status))
    .sort((a, b) => a.planVersion - b.planVersion);
}

export async function insertPlan(
  executor: MissionPlanningStoreExecutor,
  row: MissionPlanRecord
): Promise<{ inserted: boolean }> {
  const existing = await getPlan(executor, row.userId, row.planId);
  if (existing) {
    if (existing.planFingerprint !== row.planFingerprint) {
      fail(
        "PLAN_REPLAY_CONFLICT",
        `plan ${row.planId} exists with a different material fingerprint — conflicting replay`
      );
    }
    return { inserted: false };
  }
  try {
    const { createdAt: _c, updatedAt: _u, ...insertRow } = row;
    void _c;
    void _u;
    await executor.insert(missionPlans).values(insertRow as never);
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    const raced = await getPlan(executor, row.userId, row.planId);
    if (raced && raced.planFingerprint === row.planFingerprint) return { inserted: false };
    fail("PLAN_REPLAY_CONFLICT", `plan ${row.planId} raced with conflicting material`);
  }
  return { inserted: true };
}

export async function updatePlanStatus(
  executor: MissionPlanningStoreExecutor,
  input: {
    userId: number;
    planId: string;
    expectedVersion: number;
    status: string;
    reasonCode?: string | null;
  }
): Promise<{ updated: boolean }> {
  if (!(PLAN_STATUSES as readonly string[]).includes(input.status)) {
    fail("INVALID_PLAN_INPUT", `plan status ${input.status} is outside the closed vocabulary`);
  }
  const current = await getPlan(executor, input.userId, input.planId);
  if (!current) fail("PLAN_NOT_FOUND", `plan ${input.planId} not found`);
  if (current.version !== input.expectedVersion) {
    fail("PLAN_STATE_CONFLICT", `plan ${input.planId} CAS version drift`);
  }
  const result = await executor
    .update(missionPlans)
    .set({ status: input.status, version: input.expectedVersion + 1 })
    .where(
      and(
        eq(missionPlans.userId, input.userId),
        eq(missionPlans.planId, input.planId),
        eq(missionPlans.version, input.expectedVersion)
      )
    );
  const header = result as { affectedRows?: number } | Array<{ affectedRows?: number }>;
  const affected = Array.isArray(header)
    ? Number(header[0]?.affectedRows ?? 0)
    : Number((header as { affectedRows?: number }).affectedRows ?? 0);
  if (affected === 0) {
    const reread = await getPlan(executor, input.userId, input.planId);
    if (reread && reread.status === input.status) return { updated: true };
    fail("PLAN_STATE_CONFLICT", `plan ${input.planId} CAS version drift`);
  }
  return { updated: true };
}

export async function updatePlanSupersedes(
  executor: MissionPlanningStoreExecutor,
  input: { userId: number; planId: string; supersedesPlanId: string }
): Promise<void> {
  await executor
    .update(missionPlans)
    .set({ supersedesPlanId: input.supersedesPlanId })
    .where(and(eq(missionPlans.userId, input.userId), eq(missionPlans.planId, input.planId)));
}

// ─── Task rows ───

export async function getTask(
  executor: MissionPlanningStoreExecutor,
  userId: number,
  taskId: string
): Promise<MissionPlanTaskRecord | null> {
  const rows = await executor
    .select()
    .from(missionPlanTasks)
    .where(and(eq(missionPlanTasks.userId, userId), eq(missionPlanTasks.taskId, taskId)))
    .limit(1);
  return (rows[0] as unknown as MissionPlanTaskRecord | undefined) ?? null;
}

export async function listTaskRows(
  executor: MissionPlanningStoreExecutor,
  userId: number,
  planId: string
): Promise<MissionPlanTaskRecord[]> {
  const rows = await executor
    .select()
    .from(missionPlanTasks)
    .where(and(eq(missionPlanTasks.userId, userId), eq(missionPlanTasks.planId, planId)));
  return (rows as unknown as MissionPlanTaskRecord[]).sort((a, b) => a.taskSequence - b.taskSequence);
}

export async function insertTask(
  executor: MissionPlanningStoreExecutor,
  row: MissionPlanTaskRecord
): Promise<{ inserted: boolean }> {
  const existing = await getTask(executor, row.userId, row.taskId);
  if (existing) {
    if (existing.taskFingerprint !== row.taskFingerprint) {
      fail(
        "PLAN_REPLAY_CONFLICT",
        `task ${row.taskId} exists with a different material fingerprint — conflicting replay`
      );
    }
    return { inserted: false };
  }
  try {
    const { createdAt: _c, updatedAt: _u, ...insertRow } = row;
    void _c;
    void _u;
    await executor.insert(missionPlanTasks).values(insertRow as never);
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    const raced = await getTask(executor, row.userId, row.taskId);
    if (raced && raced.taskFingerprint === row.taskFingerprint) return { inserted: false };
    fail("PLAN_REPLAY_CONFLICT", `task ${row.taskId} raced with conflicting material`);
  }
  return { inserted: true };
}

export async function updateTaskStatus(
  executor: MissionPlanningStoreExecutor,
  input: { userId: number; taskId: string; status: string }
): Promise<void> {
  await executor
    .update(missionPlanTasks)
    .set({ status: input.status })
    .where(and(eq(missionPlanTasks.userId, input.userId), eq(missionPlanTasks.taskId, input.taskId)));
}

// ─── Lifecycle rows (append-only) ───

export async function insertPlanLifecycleEvent(
  executor: MissionPlanningStoreExecutor,
  row: MissionPlanLifecycleRecord
): Promise<{ inserted: boolean }> {
  try {
    const { createdAt: _c, ...insertRow } = row;
    void _c;
    await executor.insert(missionPlanLifecycleEvents).values(insertRow as never);
    return { inserted: true };
  } catch (err) {
    if (isDuplicateKeyError(err)) return { inserted: false };
    throw err;
  }
}

export async function listPlanLifecycleRows(
  executor: MissionPlanningStoreExecutor,
  userId: number,
  planId: string
): Promise<MissionPlanLifecycleRecord[]> {
  const rows = await executor
    .select()
    .from(missionPlanLifecycleEvents)
    .where(and(eq(missionPlanLifecycleEvents.userId, userId), eq(missionPlanLifecycleEvents.planId, planId)));
  return rows as unknown as MissionPlanLifecycleRecord[];
}
