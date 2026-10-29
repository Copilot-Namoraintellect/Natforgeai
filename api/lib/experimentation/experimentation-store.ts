// ─── R7-D Experimentation Engine — durable store ───
//
// DB-authoritative persistence. Convergence anchors are durable unique keys
// (no in-memory dedupe): experimentId + natural key for experiments; the
// lifecycle event id; (userId, experimentId, subjectKey) for assignments;
// (userId, experimentId, outcomeId) for evidence; resultId + (userId,
// experimentId, calculationVersion) for results. Status transitions are
// optimistic-CAS guarded (version); stale writes fail closed. Experiment rows
// are immutable after acceptance — recordHash proves byte-stability; drift is
// tampering (EXPERIMENT_EVIDENCE_CONFLICT).
//
// Optional caller executor seam (house discipline): the default getDb()
// client and a Drizzle transaction callback client both satisfy the shape.

import { and, eq, type SQL } from "drizzle-orm";
import {
  experiments,
  experimentLifecycleEvents,
  experimentAssignments,
  experimentOutcomeEvidence,
  experimentResults,
  type ExperimentRow,
  type ExperimentLifecycleEventRow,
  type ExperimentAssignmentRow,
  type ExperimentOutcomeEvidenceRow,
  type ExperimentResultRow,
  type InsertExperimentRow,
  type InsertExperimentLifecycleEventRow,
  type InsertExperimentAssignmentRow,
  type InsertExperimentOutcomeEvidenceRow,
  type InsertExperimentResultRow,
} from "@db/schema";
import { getDb } from "../../queries/connection";
import { deriveRecordHash } from "./experimentation-identity";
import {
  ExperimentIdentityConflictError,
  ExperimentStateError,
  ExperimentTamperError,
  type ExperimentDuplicateClassification,
  type ExperimentStatus,
} from "./experimentation-contract";

type Db = ReturnType<typeof getDb>;

export interface ExperimentStoreExecutor {
  select: Db["select"];
  insert: Db["insert"];
  update: Db["update"];
}

export function resolveExperimentDb(executor?: ExperimentStoreExecutor): ExperimentStoreExecutor {
  return executor ?? getDb();
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

/** Normalize a Drizzle/MySQL DML result (object or [object]) to affected rows. */
function normalizeAffectedRows(result: unknown): number {
  if (typeof result === "number") return result;
  if (Array.isArray(result)) return normalizeAffectedRows(result[0]);
  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    return Number(r.rowsAffected ?? r.affectedRows ?? 0);
  }
  return 0;
}

export interface ExperimentStoreWriteResult<T> {
  row: T;
  inserted: boolean;
  duplicateClassification: ExperimentDuplicateClassification;
}

// ─── JSON normalisation ───

function jsonColumn<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

function normalizeExperiment(row: ExperimentRow): ExperimentRow {
  return {
    ...row,
    controlDefinition: jsonColumn(row.controlDefinition, {}),
    treatmentDefinitions: jsonColumn(row.treatmentDefinitions, []),
    allocationPolicy: jsonColumn(row.allocationPolicy, { fractionsBps: [] }),
    primaryMetric: jsonColumn(row.primaryMetric, {}),
    secondaryMetrics: jsonColumn(row.secondaryMetrics, []),
    guardrails: jsonColumn(row.guardrails, []),
  } as ExperimentRow;
}

/** Verify a retained experiment row against its immutable-core hash. */
export function verifyExperimentRow(row: ExperimentRow): ExperimentRow {
  const normalized = normalizeExperiment(row);
  const expected = deriveRecordHash({
    experimentId: normalized.experimentId,
    hypothesisId: normalized.hypothesisId,
    userId: normalized.userId,
    businessId: normalized.businessId,
    learningId: normalized.learningId,
    statement: normalized.statement,
    designType: normalized.designType,
    dimension: normalized.dimension,
    controlDefinition: normalized.controlDefinition,
    treatmentDefinitions: normalized.treatmentDefinitions,
    allocationPolicy: normalized.allocationPolicy,
    primaryMetric: normalized.primaryMetric,
    secondaryMetrics: normalized.secondaryMetrics,
    guardrails: normalized.guardrails,
    minimumSamplePerArm: normalized.minimumSamplePerArm,
    durationDays: normalized.durationDays,
    designHash: normalized.designHash,
    narrativeDraft: normalized.narrativeDraft,
  });
  if (expected !== normalized.recordHash) {
    throw new ExperimentTamperError(
      "EXPERIMENT_EVIDENCE_CONFLICT",
      "Experiment record hash drift detected; retained material no longer matches its hash."
    );
  }
  return normalized;
}

// ─── Experiment row reads/writes ───

export async function getExperimentById(
  userId: number,
  experimentId: string,
  executor?: ExperimentStoreExecutor
): Promise<ExperimentRow | null> {
  const db = resolveExperimentDb(executor);
  const rows = await db
    .select()
    .from(experiments)
    .where(and(eq(experiments.userId, userId), eq(experiments.experimentId, experimentId)))
    .limit(1);
  const row = rows[0];
  return row ? verifyExperimentRow(row) : null;
}

export async function findExperimentByNaturalKey(
  userId: number,
  learningId: string,
  hypothesisId: string,
  designHash: string,
  executor?: ExperimentStoreExecutor
): Promise<ExperimentRow | null> {
  const db = resolveExperimentDb(executor);
  const rows = await db
    .select()
    .from(experiments)
    .where(
      and(
        eq(experiments.userId, userId),
        eq(experiments.learningId, learningId),
        eq(experiments.hypothesisId, hypothesisId),
        eq(experiments.designHash, designHash)
      )
    )
    .limit(1);
  const row = rows[0];
  return row ? verifyExperimentRow(row) : null;
}

export async function insertExperiment(
  row: InsertExperimentRow,
  executor?: ExperimentStoreExecutor
): Promise<ExperimentStoreWriteResult<ExperimentRow>> {
  const db = resolveExperimentDb(executor);
  try {
    await db.insert(experiments).values(row);
    const created = await getExperimentById(row.userId, row.experimentId, executor);
    if (!created) throw new ExperimentStateError("EXPERIMENT_STORE_FAILURE", "Insert did not produce a readable row.");
    return { row: created, inserted: true, duplicateClassification: "none" };
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    const existing = await findExperimentByNaturalKey(
      row.userId,
      row.learningId,
      row.hypothesisId,
      row.designHash,
      executor
    );
    if (!existing) throw new ExperimentIdentityConflictError(
      "EXPERIMENT_REPLAY_CONFLICT",
      "experimentId collision without a matching natural key."
    );
    if (existing.experimentId !== row.experimentId || existing.recordHash !== row.recordHash) {
      throw new ExperimentIdentityConflictError(
        "EXPERIMENT_REPLAY_CONFLICT",
        "Same experiment identity reused with conflicting material."
      );
    }
    return { row: existing, inserted: false, duplicateClassification: "idempotent_replay" };
  }
}

/** Optimistic-CAS status (and bounded mutable fields) transition. */
export async function transitionExperimentStatus(
  userId: number,
  experimentId: string,
  expectedVersion: number,
  patch: Partial<Pick<InsertExperimentRow, "status" | "startAt" | "endAt" | "assignmentVersion" | "governanceDecisionId" | "approvalReference" | "resultId" | "recordHash">>,
  executor?: ExperimentStoreExecutor
): Promise<ExperimentRow> {
  const db = resolveExperimentDb(executor);
  const current = await getExperimentById(userId, experimentId, executor);
  if (!current) {
    throw new ExperimentStateError("EXPERIMENT_NOT_FOUND", "Experiment not found for this tenant.");
  }
  if (current.version !== expectedVersion) {
    throw new ExperimentStateError(
      "EXPERIMENT_STALE_STATE",
      "Optimistic concurrency conflict; the experiment changed concurrently."
    );
  }
  const result = await db
    .update(experiments)
    .set({ ...patch, version: expectedVersion + 1 })
    .where(
      and(
        eq(experiments.userId, userId),
        eq(experiments.experimentId, experimentId),
        eq(experiments.version, expectedVersion)
      )
    );
  const affected = normalizeAffectedRows(result);
  if (!affected) {
    throw new ExperimentStateError(
      "EXPERIMENT_STALE_STATE",
      "CAS update lost the race; the experiment changed concurrently."
    );
  }
  const updated = await getExperimentById(userId, experimentId, executor);
  if (!updated) throw new ExperimentStateError("EXPERIMENT_STORE_FAILURE", "Transition did not produce a readable row.");
  return updated;
}

export async function listExperimentsForUser(
  userId: number,
  filter: { businessId?: number; status?: ExperimentStatus } = {},
  executor?: ExperimentStoreExecutor
): Promise<ExperimentRow[]> {
  const db = resolveExperimentDb(executor);
  const conds: SQL[] = [eq(experiments.userId, userId)];
  if (filter.businessId !== undefined) conds.push(eq(experiments.businessId, filter.businessId));
  if (filter.status !== undefined) conds.push(eq(experiments.status, filter.status));
  const rows = await db.select().from(experiments).where(and(...conds));
  return rows.map(verifyExperimentRow);
}

// ─── Lifecycle facts ───

export async function insertLifecycleEvent(
  row: InsertExperimentLifecycleEventRow,
  executor?: ExperimentStoreExecutor
): Promise<ExperimentStoreWriteResult<ExperimentLifecycleEventRow>> {
  const db = resolveExperimentDb(executor);
  try {
    await db.insert(experimentLifecycleEvents).values(row);
    const created = (
      await db
        .select()
        .from(experimentLifecycleEvents)
        .where(eq(experimentLifecycleEvents.experimentLifecycleEventId, row.experimentLifecycleEventId))
        .limit(1)
    )[0];
    return { row: created, inserted: true, duplicateClassification: "none" };
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    const existing = (
      await db
        .select()
        .from(experimentLifecycleEvents)
        .where(eq(experimentLifecycleEvents.experimentLifecycleEventId, row.experimentLifecycleEventId))
        .limit(1)
    )[0];
    if (
      !existing ||
      existing.experimentId !== row.experimentId ||
      existing.toStatus !== row.toStatus ||
      existing.lifecycleType !== row.lifecycleType
    ) {
      throw new ExperimentIdentityConflictError(
        "EXPERIMENT_REPLAY_CONFLICT",
        "Lifecycle event id reused with conflicting material."
      );
    }
    return { row: existing, inserted: false, duplicateClassification: "idempotent_replay" };
  }
}

export async function listLifecycleEventsForExperiment(
  userId: number,
  experimentId: string,
  executor?: ExperimentStoreExecutor
): Promise<ExperimentLifecycleEventRow[]> {
  const db = resolveExperimentDb(executor);
  return db
    .select()
    .from(experimentLifecycleEvents)
    .where(and(eq(experimentLifecycleEvents.userId, userId), eq(experimentLifecycleEvents.experimentId, experimentId)));
}

// ─── Assignments ───

export async function findAssignment(
  userId: number,
  experimentId: string,
  subjectKey: string,
  executor?: ExperimentStoreExecutor
): Promise<ExperimentAssignmentRow | null> {
  const db = resolveExperimentDb(executor);
  const rows = await db
    .select()
    .from(experimentAssignments)
    .where(
      and(
        eq(experimentAssignments.userId, userId),
        eq(experimentAssignments.experimentId, experimentId),
        eq(experimentAssignments.subjectKey, subjectKey)
      )
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function insertAssignment(
  row: InsertExperimentAssignmentRow,
  executor?: ExperimentStoreExecutor
): Promise<ExperimentStoreWriteResult<ExperimentAssignmentRow>> {
  const db = resolveExperimentDb(executor);
  try {
    await db.insert(experimentAssignments).values(row);
    const created = (
      await db
        .select()
        .from(experimentAssignments)
        .where(eq(experimentAssignments.assignmentId, row.assignmentId))
        .limit(1)
    )[0];
    return { row: created, inserted: true, duplicateClassification: "none" };
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    const existing = await findAssignment(row.userId, row.experimentId, row.subjectKey, executor);
    if (!existing) {
      throw new ExperimentIdentityConflictError(
        "EXPERIMENT_ASSIGNMENT_CONFLICT",
        "Assignment id collision without a matching natural key."
      );
    }
    return { row: existing, inserted: false, duplicateClassification: "idempotent_replay" };
  }
}

export async function listAssignmentsForExperiment(
  userId: number,
  experimentId: string,
  executor?: ExperimentStoreExecutor
): Promise<ExperimentAssignmentRow[]> {
  const db = resolveExperimentDb(executor);
  return db
    .select()
    .from(experimentAssignments)
    .where(and(eq(experimentAssignments.userId, userId), eq(experimentAssignments.experimentId, experimentId)));
}

// ─── Outcome evidence ───

export async function findEvidence(
  userId: number,
  experimentId: string,
  outcomeId: string,
  executor?: ExperimentStoreExecutor
): Promise<ExperimentOutcomeEvidenceRow | null> {
  const db = resolveExperimentDb(executor);
  const rows = await db
    .select()
    .from(experimentOutcomeEvidence)
    .where(
      and(
        eq(experimentOutcomeEvidence.userId, userId),
        eq(experimentOutcomeEvidence.experimentId, experimentId),
        eq(experimentOutcomeEvidence.outcomeId, outcomeId)
      )
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function insertEvidence(
  row: InsertExperimentOutcomeEvidenceRow,
  executor?: ExperimentStoreExecutor
): Promise<ExperimentStoreWriteResult<ExperimentOutcomeEvidenceRow>> {
  const db = resolveExperimentDb(executor);
  try {
    await db.insert(experimentOutcomeEvidence).values(row);
    const created = (
      await db
        .select()
        .from(experimentOutcomeEvidence)
        .where(eq(experimentOutcomeEvidence.evidenceId, row.evidenceId))
        .limit(1)
    )[0];
    return { row: created, inserted: true, duplicateClassification: "none" };
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    const existing = await findEvidence(row.userId, row.experimentId, row.outcomeId, executor);
    if (
      !existing ||
      existing.subjectKey !== row.subjectKey ||
      existing.armIndex !== row.armIndex ||
      existing.evidenceHash !== row.evidenceHash
    ) {
      throw new ExperimentIdentityConflictError(
        "EXPERIMENT_DUPLICATE_EVIDENCE",
        "Outcome already bound to this experiment with conflicting material."
      );
    }
    return { row: existing, inserted: false, duplicateClassification: "idempotent_replay" };
  }
}

export async function listEvidenceForExperiment(
  userId: number,
  experimentId: string,
  executor?: ExperimentStoreExecutor
): Promise<ExperimentOutcomeEvidenceRow[]> {
  const db = resolveExperimentDb(executor);
  return db
    .select()
    .from(experimentOutcomeEvidence)
    .where(and(eq(experimentOutcomeEvidence.userId, userId), eq(experimentOutcomeEvidence.experimentId, experimentId)));
}

// ─── Results ───

export async function findResultByNaturalKey(
  userId: number,
  experimentId: string,
  calculationVersion: string,
  executor?: ExperimentStoreExecutor
): Promise<ExperimentResultRow | null> {
  const db = resolveExperimentDb(executor);
  const rows = await db
    .select()
    .from(experimentResults)
    .where(
      and(
        eq(experimentResults.userId, userId),
        eq(experimentResults.experimentId, experimentId),
        eq(experimentResults.calculationVersion, calculationVersion)
      )
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function insertResult(
  row: InsertExperimentResultRow,
  executor?: ExperimentStoreExecutor
): Promise<ExperimentStoreWriteResult<ExperimentResultRow>> {
  const db = resolveExperimentDb(executor);
  try {
    await db.insert(experimentResults).values(row);
    const created = (
      await db
        .select()
        .from(experimentResults)
        .where(eq(experimentResults.resultId, row.resultId))
        .limit(1)
    )[0];
    return { row: created, inserted: true, duplicateClassification: "none" };
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    const existing = await findResultByNaturalKey(row.userId, row.experimentId, row.calculationVersion, executor);
    if (!existing || existing.resultHash !== row.resultHash) {
      throw new ExperimentIdentityConflictError(
        "EXPERIMENT_REPLAY_CONFLICT",
        "Same result version computed with conflicting material."
      );
    }
    return { row: existing, inserted: false, duplicateClassification: "idempotent_replay" };
  }
}

export async function getResultById(
  userId: number,
  resultId: string,
  executor?: ExperimentStoreExecutor
): Promise<ExperimentResultRow | null> {
  const db = resolveExperimentDb(executor);
  const rows = await db
    .select()
    .from(experimentResults)
    .where(and(eq(experimentResults.userId, userId), eq(experimentResults.resultId, resultId)))
    .limit(1);
  return rows[0] ?? null;
}
