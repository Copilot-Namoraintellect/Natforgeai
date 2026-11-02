// R10-C durable store. Every CAS proves its own affected row, never a reread.
// These tables fence runtime access; they grant no R9 execution authority.
import { and, desc, eq, lt, gt, inArray, isNull } from "drizzle-orm";
import { getDb } from "../../queries/connection";
import {
  runtimeWorkers,
  runtimeJobs,
  runtimeLeases,
  runtimeDeadLetters,
  runtimeLifecycleEvents,
  type RuntimeWorkerRow,
  type RuntimeJobRow,
  type RuntimeLeaseRow,
  type RuntimeDeadLetterRow,
  type RuntimeLifecycleEventRow,
  type InsertRuntimeWorkerRow,
  type InsertRuntimeJobRow,
  type InsertRuntimeLeaseRow,
  type InsertRuntimeDeadLetterRow,
  type InsertRuntimeLifecycleEventRow,
} from "@db/schema";
import {
  RuntimeIdentityConflictError,
  RuntimeStateConflictError,
  RuntimeTamperError,
  type RuntimeDuplicateClassification,
} from "./runtime-resilience-contract";

type Db = ReturnType<typeof getDb>;
export type RuntimeStoreExecutor = Db | undefined;
export function resolveRuntimeDb(executor?: RuntimeStoreExecutor): Db {
  return executor ?? getDb();
}
export function wonRuntimeCAS(result: unknown): boolean {
  const header = Array.isArray(result) ? result[0] : result;
  return (
    !!header &&
    typeof header === "object" &&
    (header as { affectedRows?: number }).affectedRows === 1
  );
}
function isDuplicateEntryError(err: unknown): boolean {
  let cursor = err;
  for (
    let depth = 0;
    depth < 5 && cursor && typeof cursor === "object";
    depth++
  ) {
    if ((cursor as { code?: unknown }).code === "ER_DUP_ENTRY") return true;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return false;
}
export interface InsertRuntimeWorkerResult {
  readonly row: RuntimeWorkerRow;
  readonly duplicateClassification: RuntimeDuplicateClassification;
}
export interface InsertRuntimeJobResult {
  readonly row: RuntimeJobRow;
  readonly duplicateClassification: RuntimeDuplicateClassification;
}
export interface InsertRuntimeLeaseResult {
  readonly row: RuntimeLeaseRow;
  readonly duplicateClassification: RuntimeDuplicateClassification;
}
export interface InsertRuntimeDeadLetterResult {
  readonly row: RuntimeDeadLetterRow;
  readonly duplicateClassification: RuntimeDuplicateClassification;
}

export async function getRuntimeWorkerByInstance(
  workerInstanceId: string,
  executor?: RuntimeStoreExecutor
): Promise<RuntimeWorkerRow | null> {
  const [row] = await resolveRuntimeDb(executor)
    .select()
    .from(runtimeWorkers)
    .where(eq(runtimeWorkers.workerInstanceId, workerInstanceId))
    .limit(1);
  return row ?? null;
}
export async function listRuntimeWorkers(
  executor?: RuntimeStoreExecutor
): Promise<RuntimeWorkerRow[]> {
  return resolveRuntimeDb(executor)
    .select()
    .from(runtimeWorkers)
    .orderBy(desc(runtimeWorkers.startedAt))
    .limit(500);
}
export async function insertRuntimeWorker(
  row: InsertRuntimeWorkerRow,
  executor?: RuntimeStoreExecutor
): Promise<InsertRuntimeWorkerResult> {
  try {
    await resolveRuntimeDb(executor).insert(runtimeWorkers).values(row);
    const inserted = await getRuntimeWorkerByInstance(
      row.workerInstanceId,
      executor
    );
    if (!inserted)
      throw new RuntimeTamperError(
        "WORKER_NOT_FOUND",
        "worker insert not readable"
      );
    return { row: inserted, duplicateClassification: "none" };
  } catch (err) {
    if (!isDuplicateEntryError(err)) throw err;
    const existing = await getRuntimeWorkerByInstance(
      row.workerInstanceId,
      executor
    );
    if (
      existing &&
      existing.workerId === row.workerId &&
      existing.service === row.service &&
      existing.runtimeVersion === row.runtimeVersion &&
      existing.releaseVersion === row.releaseVersion &&
      JSON.stringify(existing.capabilities) === JSON.stringify(row.capabilities)
    )
      return { row: existing, duplicateClassification: "idempotent_replay" };
    throw new RuntimeIdentityConflictError(
      "WORKER_DUPLICATE_IDENTITY",
      "conflicting worker registration"
    );
  }
}
export async function transitionWorkerState(input: {
  workerInstanceId: string;
  expectedVersion: number;
  toState: string;
  heartbeatAt: string;
  stoppedAt?: string | null;
  executor?: RuntimeStoreExecutor;
}): Promise<RuntimeWorkerRow> {
  const mutation = await resolveRuntimeDb(input.executor)
    .update(runtimeWorkers)
    .set({
      runtimeState: input.toState,
      heartbeatAt: input.heartbeatAt,
      ...(input.stoppedAt !== undefined ? { stoppedAt: input.stoppedAt } : {}),
      version: input.expectedVersion + 1,
      updatedAt: new Date(input.heartbeatAt),
    })
    .where(
      and(
        eq(runtimeWorkers.workerInstanceId, input.workerInstanceId),
        eq(runtimeWorkers.version, input.expectedVersion)
      )
    );
  if (!wonRuntimeCAS(mutation))
    throw new RuntimeStateConflictError("CLAIM_LOST", "worker CAS lost");
  const row = await getRuntimeWorkerByInstance(
    input.workerInstanceId,
    input.executor
  );
  if (!row)
    throw new RuntimeStateConflictError(
      "WORKER_NOT_FOUND",
      "worker disappeared"
    );
  return row;
}
export async function getRuntimeJobById(
  jobId: string,
  executor?: RuntimeStoreExecutor
): Promise<RuntimeJobRow | null> {
  const [row] = await resolveRuntimeDb(executor)
    .select()
    .from(runtimeJobs)
    .where(eq(runtimeJobs.jobId, jobId))
    .limit(1);
  return row ?? null;
}
export async function getRuntimeJobForUser(
  userId: number,
  jobId: string,
  executor?: RuntimeStoreExecutor
): Promise<RuntimeJobRow | null> {
  const [row] = await resolveRuntimeDb(executor)
    .select()
    .from(runtimeJobs)
    .where(and(eq(runtimeJobs.userId, userId), eq(runtimeJobs.jobId, jobId)))
    .limit(1);
  return row ?? null;
}
export async function listRuntimeJobs(
  filter: { userId?: number; state?: string } = {},
  executor?: RuntimeStoreExecutor
): Promise<RuntimeJobRow[]> {
  const conds = [];
  if (filter.userId !== undefined)
    conds.push(eq(runtimeJobs.userId, filter.userId));
  if (filter.state !== undefined)
    conds.push(eq(runtimeJobs.state, filter.state));
  return resolveRuntimeDb(executor)
    .select()
    .from(runtimeJobs)
    .where(and(...conds))
    .orderBy(desc(runtimeJobs.createdAt))
    .limit(500);
}
export async function insertRuntimeJob(
  row: InsertRuntimeJobRow,
  executor?: RuntimeStoreExecutor
): Promise<InsertRuntimeJobResult> {
  try {
    await resolveRuntimeDb(executor).insert(runtimeJobs).values(row);
    const inserted = await getRuntimeJobById(row.jobId, executor);
    if (!inserted)
      throw new RuntimeTamperError("JOB_TAMPER", "insert not readable");
    return { row: inserted, duplicateClassification: "none" };
  } catch (err) {
    if (!isDuplicateEntryError(err)) throw err;
    const existing = await getRuntimeJobById(row.jobId, executor);
    const keys = [
      "jobId",
      "userId",
      "businessId",
      "jobType",
      "authorityRef",
      "missionId",
      "planId",
      "scheduleId",
      "taskId",
      "attemptRef",
      "parametersFingerprint",
      "jobFingerprint",
      "runtimeVersion",
      "releaseVersion",
      "notBefore",
    ] as const;
    if (existing && keys.every(k => existing[k] === row[k]))
      return { row: existing, duplicateClassification: "idempotent_replay" };
    throw new RuntimeIdentityConflictError(
      "JOB_TAMPER",
      "conflicting job material"
    );
  }
}
interface ClaimFields {
  jobId: string;
  expectedVersion: number;
  leaseId: string;
  leaseOwnerInstanceId: string;
  leaseEpoch: number;
  leaseExpiresAt: string;
  executor?: RuntimeStoreExecutor;
}
function leaseSet(input: ClaimFields) {
  return {
    state: "LEASED",
    leaseId: input.leaseId,
    leaseOwnerInstanceId: input.leaseOwnerInstanceId,
    leaseEpoch: input.leaseEpoch,
    leaseExpiresAt: input.leaseExpiresAt,
    version: input.expectedVersion + 1,
    updatedAt: new Date(),
  };
}
export async function tryClaimFreshCAS(
  input: ClaimFields
): Promise<RuntimeJobRow | null> {
  const result = await resolveRuntimeDb(input.executor)
    .update(runtimeJobs)
    .set(leaseSet(input))
    .where(
      and(
        eq(runtimeJobs.jobId, input.jobId),
        eq(runtimeJobs.version, input.expectedVersion),
        eq(runtimeJobs.state, "PENDING")
      )
    );
  return wonRuntimeCAS(result)
    ? getRuntimeJobById(input.jobId, input.executor)
    : null;
}
export async function tryClaimReclaimCAS(
  input: ClaimFields & { nowIso: string }
): Promise<RuntimeJobRow | null> {
  const result = await resolveRuntimeDb(input.executor)
    .update(runtimeJobs)
    .set(leaseSet(input))
    .where(
      and(
        eq(runtimeJobs.jobId, input.jobId),
        eq(runtimeJobs.version, input.expectedVersion),
        eq(runtimeJobs.state, "LEASED"),
        lt(runtimeJobs.leaseExpiresAt, input.nowIso)
      )
    );
  return wonRuntimeCAS(result)
    ? getRuntimeJobById(input.jobId, input.executor)
    : null;
}
export async function completeJobWithFenceCAS(input: {
  jobId: string;
  expectedVersion: number;
  leaseId: string;
  leaseEpoch: number;
  resultStatus: string;
  nowIso: string;
  failureClass: string;
  uncertaintyClass: string;
  executor?: RuntimeStoreExecutor;
}): Promise<RuntimeJobRow | null> {
  const result = await resolveRuntimeDb(input.executor)
    .update(runtimeJobs)
    .set({
      state: "COMPLETED",
      resultStatus: input.resultStatus,
      failureClass: input.failureClass,
      uncertaintyClass: input.uncertaintyClass,
      version: input.expectedVersion + 1,
      updatedAt: new Date(input.nowIso),
    })
    .where(
      and(
        eq(runtimeJobs.jobId, input.jobId),
        eq(runtimeJobs.version, input.expectedVersion),
        eq(runtimeJobs.state, "LEASED"),
        eq(runtimeJobs.leaseId, input.leaseId),
        eq(runtimeJobs.leaseEpoch, input.leaseEpoch),
        gt(runtimeJobs.leaseExpiresAt, input.nowIso)
      )
    );
  return wonRuntimeCAS(result)
    ? getRuntimeJobById(input.jobId, input.executor)
    : null;
}
/** No execution retry: only a never-claimed pending row can remain pending. */
export async function requeueJobCAS(input: {
  jobId: string;
  expectedVersion: number;
  executor?: RuntimeStoreExecutor;
}): Promise<RuntimeJobRow | null> {
  const result = await resolveRuntimeDb(input.executor)
    .update(runtimeJobs)
    .set({ version: input.expectedVersion + 1, updatedAt: new Date() })
    .where(
      and(
        eq(runtimeJobs.jobId, input.jobId),
        eq(runtimeJobs.version, input.expectedVersion),
        eq(runtimeJobs.state, "PENDING"),
        isNull(runtimeJobs.resultStatus)
      )
    );
  return wonRuntimeCAS(result)
    ? getRuntimeJobById(input.jobId, input.executor)
    : null;
}
export async function transitionJobStateCAS(input: {
  jobId: string;
  expectedVersion: number;
  fromStates: readonly string[];
  toState: string;
  executor?: RuntimeStoreExecutor;
}): Promise<RuntimeJobRow | null> {
  if (!["DEAD_LETTERED", "CANCELLED"].includes(input.toState))
    throw new RuntimeStateConflictError(
      "JOB_STATE_INVALID",
      "unsupported transition"
    );
  const result = await resolveRuntimeDb(input.executor)
    .update(runtimeJobs)
    .set({
      state: input.toState,
      version: input.expectedVersion + 1,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(runtimeJobs.jobId, input.jobId),
        eq(runtimeJobs.version, input.expectedVersion),
        inArray(runtimeJobs.state, [...input.fromStates])
      )
    );
  return wonRuntimeCAS(result)
    ? getRuntimeJobById(input.jobId, input.executor)
    : null;
}
export async function beginRuntimeDispatch(input: {
  jobId: string;
  expectedVersion: number;
  leaseId: string;
  leaseEpoch: number;
  workerInstanceId: string;
  nowIso: string;
  executor?: RuntimeStoreExecutor;
}): Promise<RuntimeJobRow | null> {
  const result = await resolveRuntimeDb(input.executor)
    .update(runtimeJobs)
    .set({
      resultStatus: "DISPATCHING",
      version: input.expectedVersion + 1,
      updatedAt: new Date(input.nowIso),
    })
    .where(
      and(
        eq(runtimeJobs.jobId, input.jobId),
        eq(runtimeJobs.version, input.expectedVersion),
        eq(runtimeJobs.state, "LEASED"),
        eq(runtimeJobs.leaseId, input.leaseId),
        eq(runtimeJobs.leaseEpoch, input.leaseEpoch),
        eq(runtimeJobs.leaseOwnerInstanceId, input.workerInstanceId),
        gt(runtimeJobs.leaseExpiresAt, input.nowIso),
        isNull(runtimeJobs.resultStatus)
      )
    );
  return wonRuntimeCAS(result)
    ? getRuntimeJobById(input.jobId, input.executor)
    : null;
}
export async function getRuntimeLeaseById(
  leaseId: string,
  executor?: RuntimeStoreExecutor
): Promise<RuntimeLeaseRow | null> {
  const [row] = await resolveRuntimeDb(executor)
    .select()
    .from(runtimeLeases)
    .where(eq(runtimeLeases.leaseId, leaseId))
    .limit(1);
  return row ?? null;
}
export async function listLeasesForJob(
  jobId: string,
  executor?: RuntimeStoreExecutor
): Promise<RuntimeLeaseRow[]> {
  return resolveRuntimeDb(executor)
    .select()
    .from(runtimeLeases)
    .where(eq(runtimeLeases.jobId, jobId))
    .orderBy(desc(runtimeLeases.acquiredAt))
    .limit(50);
}
export async function insertRuntimeLease(
  row: InsertRuntimeLeaseRow,
  executor?: RuntimeStoreExecutor
): Promise<InsertRuntimeLeaseResult> {
  try {
    await resolveRuntimeDb(executor).insert(runtimeLeases).values(row);
    const inserted = await getRuntimeLeaseById(row.leaseId, executor);
    if (!inserted)
      throw new RuntimeTamperError("LEASE_NOT_FOUND", "lease not readable");
    return { row: inserted, duplicateClassification: "none" };
  } catch (err) {
    if (!isDuplicateEntryError(err)) throw err;
    const existing = await getRuntimeLeaseById(row.leaseId, executor);
    const keys = [
      "jobId",
      "userId",
      "businessId",
      "workerInstanceId",
      "authorityRef",
      "attemptRef",
      "leaseEpoch",
      "acquiredAt",
      "leaseExpiresAt",
    ] as const;
    if (existing && keys.every(k => existing[k] === row[k]))
      return { row: existing, duplicateClassification: "idempotent_replay" };
    throw new RuntimeIdentityConflictError(
      "LEASE_FENCING_CONFLICT",
      "conflicting lease material"
    );
  }
}
export async function transitionLeaseStateCAS(input: {
  leaseId: string;
  expectedVersion: number;
  toState: string;
  heartbeatAt?: string;
  executor?: RuntimeStoreExecutor;
}): Promise<RuntimeLeaseRow | null> {
  const result = await resolveRuntimeDb(input.executor)
    .update(runtimeLeases)
    .set({
      leaseState: input.toState,
      version: input.expectedVersion + 1,
      ...(input.heartbeatAt ? { heartbeatAt: input.heartbeatAt } : {}),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(runtimeLeases.leaseId, input.leaseId),
        eq(runtimeLeases.version, input.expectedVersion)
      )
    );
  return wonRuntimeCAS(result)
    ? getRuntimeLeaseById(input.leaseId, input.executor)
    : null;
}
export async function getRuntimeDeadLetterById(
  deadLetterId: string,
  executor?: RuntimeStoreExecutor
): Promise<RuntimeDeadLetterRow | null> {
  const [row] = await resolveRuntimeDb(executor)
    .select()
    .from(runtimeDeadLetters)
    .where(eq(runtimeDeadLetters.deadLetterId, deadLetterId))
    .limit(1);
  return row ?? null;
}
export async function listDeadLettersForJob(
  jobId: string,
  executor?: RuntimeStoreExecutor
): Promise<RuntimeDeadLetterRow[]> {
  return resolveRuntimeDb(executor)
    .select()
    .from(runtimeDeadLetters)
    .where(eq(runtimeDeadLetters.jobId, jobId))
    .orderBy(desc(runtimeDeadLetters.occurredAt))
    .limit(20);
}
export async function listRuntimeDeadLetters(
  userId: number,
  businessId: number,
  executor?: RuntimeStoreExecutor
): Promise<RuntimeDeadLetterRow[]> {
  return resolveRuntimeDb(executor)
    .select()
    .from(runtimeDeadLetters)
    .where(
      and(
        eq(runtimeDeadLetters.userId, userId),
        eq(runtimeDeadLetters.businessId, businessId)
      )
    )
    .orderBy(desc(runtimeDeadLetters.occurredAt))
    .limit(500);
}
export async function insertRuntimeDeadLetter(
  row: InsertRuntimeDeadLetterRow,
  executor?: RuntimeStoreExecutor
): Promise<InsertRuntimeDeadLetterResult> {
  try {
    await resolveRuntimeDb(executor).insert(runtimeDeadLetters).values(row);
    const inserted = await getRuntimeDeadLetterById(row.deadLetterId, executor);
    if (!inserted)
      throw new RuntimeTamperError(
        "DEAD_LETTER_CONFLICT",
        "evidence not readable"
      );
    return { row: inserted, duplicateClassification: "none" };
  } catch (err) {
    if (!isDuplicateEntryError(err)) throw err;
    const existing = await getRuntimeDeadLetterById(row.deadLetterId, executor);
    if (
      existing &&
      existing.deadLetterFingerprint === row.deadLetterFingerprint &&
      existing.userId === row.userId &&
      existing.businessId === row.businessId
    )
      return { row: existing, duplicateClassification: "idempotent_replay" };
    throw new RuntimeIdentityConflictError(
      "DEAD_LETTER_CONFLICT",
      "conflicting dead-letter evidence"
    );
  }
}
export async function insertRuntimeLifecycleEvent(
  row: InsertRuntimeLifecycleEventRow,
  executor?: RuntimeStoreExecutor
): Promise<{
  readonly duplicateClassification: RuntimeDuplicateClassification;
}> {
  try {
    await resolveRuntimeDb(executor).insert(runtimeLifecycleEvents).values(row);
    return { duplicateClassification: "none" };
  } catch (err) {
    if (!isDuplicateEntryError(err)) throw err;
    const [existing] = await resolveRuntimeDb(executor)
      .select()
      .from(runtimeLifecycleEvents)
      .where(eq(runtimeLifecycleEvents.lifecycleEventId, row.lifecycleEventId))
      .limit(1);
    if (
      existing &&
      existing.eventHash === row.eventHash &&
      existing.userId === row.userId
    )
      return { duplicateClassification: "idempotent_replay" };
    throw new RuntimeIdentityConflictError(
      "JOB_TAMPER",
      "conflicting lifecycle evidence"
    );
  }
}
export async function listRuntimeLifecycleForJob(
  jobId: string,
  executor?: RuntimeStoreExecutor
): Promise<RuntimeLifecycleEventRow[]> {
  return resolveRuntimeDb(executor)
    .select()
    .from(runtimeLifecycleEvents)
    .where(eq(runtimeLifecycleEvents.jobId, jobId))
    .orderBy(desc(runtimeLifecycleEvents.createdAt))
    .limit(200);
}
export async function listRuntimeLifecycleForWorker(
  workerInstanceId: string,
  executor?: RuntimeStoreExecutor
): Promise<RuntimeLifecycleEventRow[]> {
  return resolveRuntimeDb(executor)
    .select()
    .from(runtimeLifecycleEvents)
    .where(eq(runtimeLifecycleEvents.workerInstanceId, workerInstanceId))
    .orderBy(desc(runtimeLifecycleEvents.createdAt))
    .limit(200);
}
