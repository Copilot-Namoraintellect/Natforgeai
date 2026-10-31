// ─── R9-A Mission Authority — durable store ───
//
// DB-authoritative persistence over the R9-A-owned tables. Convergence
// anchors are the durable unique keys (userId, missionId): retried or raced
// writes re-read the committed row and converge (idempotent_replay); a
// stored row under the same anchor with a different material fingerprint
// fails closed (MISSION_REPLAY_CONFLICT). Mission rows are immutable in
// their material core — corrections are NEW superseding missions; only the
// lifecycle status transitions in place, guarded by an optimistic version
// CAS. Lifecycle history is append-only.
//
// The canonical tables live in @db/schema (single source of truth; the 0037
// migration artefact is stream-local provisional — NOT executed; R9-X owns
// canonical sequencing). The structural executor seam matches the
// AuditDbExecutor convention.

import { and, eq } from "drizzle-orm";
import { missionProposals, missionLifecycleEvents } from "@db/schema";
import { getDb } from "../../queries/connection";
import { fail } from "./mission-authority-contract";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export interface MissionAuthorityStoreExecutor {
  readonly select: Db["select"];
  readonly insert: Db["insert"];
  readonly update: Db["update"];
}

/** Bind a Drizzle client or transaction callback to the executor seam. */
export function bindMissionAuthorityStoreExecutor(
  db: Pick<Db, "select" | "insert" | "update">
): MissionAuthorityStoreExecutor {
  return db as MissionAuthorityStoreExecutor;
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

// ─── Mission proposal rows ───

export interface MissionProposalRow {
  readonly missionId: string;
  readonly objectiveId: string;
  readonly userId: number;
  readonly businessId: number;
  readonly sourceCandidateId: string;
  readonly sourceReasoningIds: unknown;
  readonly missionType: string;
  readonly objectiveType: string;
  readonly objectiveStatement: string;
  readonly objectiveClientStatement: string;
  readonly objectiveWordingDraft: string | null;
  readonly modelAssistanceFlagged: boolean;
  readonly expectedOutcome: string;
  readonly successCriteria: unknown;
  readonly constraints: unknown;
  readonly assumptions: unknown;
  readonly scope: unknown;
  readonly scopeKey: string;
  readonly priorityContext: string;
  readonly strategicRiskClass: string;
  readonly confidenceClass: string;
  readonly governanceDecisionId: string | null;
  readonly governanceDecision: string | null;
  readonly policyVersion: string | null;
  readonly governanceRequirements: unknown;
  readonly validFrom: string;
  readonly validUntil: string;
  readonly limitations: unknown;
  readonly lineageHash: string;
  readonly missionFingerprint: string;
  readonly objectiveFingerprint: string;
  readonly constraintSetFingerprint: string;
  readonly sourceProjection: unknown;
  readonly sourceVersions: unknown;
  readonly supersedesMissionId: string | null;
  readonly status: string;
  readonly version: number;
  readonly createdAt?: unknown;
  readonly updatedAt?: unknown;
}

export async function getMissionProposal(
  executor: MissionAuthorityStoreExecutor,
  userId: number,
  missionId: string
): Promise<MissionProposalRow | null> {
  const rows = await executor
    .select()
    .from(missionProposals)
    .where(and(eq(missionProposals.userId, userId), eq(missionProposals.missionId, missionId)))
    .limit(1);
  return (rows[0] as unknown as MissionProposalRow | undefined) ?? null;
}

export async function insertMissionProposal(
  executor: MissionAuthorityStoreExecutor,
  row: MissionProposalRow
): Promise<{ inserted: boolean }> {
  const existing = await getMissionProposal(executor, row.userId, row.missionId);
  if (existing) {
    if (existing.missionFingerprint !== row.missionFingerprint) {
      fail(
        "MISSION_REPLAY_CONFLICT",
        `mission ${row.missionId} exists with a different material fingerprint — conflicting replay`
      );
    }
    return { inserted: false };
  }
  try {
    const { createdAt: _c, updatedAt: _u, ...insertRow } = row;
    void _c;
    void _u;
    await executor.insert(missionProposals).values(insertRow as never);
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    const raced = await getMissionProposal(executor, row.userId, row.missionId);
    if (raced && raced.missionFingerprint === row.missionFingerprint) return { inserted: false };
    fail("MISSION_REPLAY_CONFLICT", `mission ${row.missionId} raced with conflicting material`);
  }
  return { inserted: true };
}

export interface ListMissionProposalsFilter {
  readonly businessId?: number;
  readonly status?: string;
  readonly missionType?: string;
}

export async function listMissionProposalRows(
  executor: MissionAuthorityStoreExecutor,
  userId: number,
  filter: ListMissionProposalsFilter
): Promise<MissionProposalRow[]> {
  const rows = await executor.select().from(missionProposals).where(eq(missionProposals.userId, userId));
  return (rows as unknown as MissionProposalRow[]).filter((r) => {
    if (filter.businessId !== undefined && r.businessId !== filter.businessId) return false;
    if (filter.status !== undefined && r.status !== filter.status) return false;
    if (filter.missionType !== undefined && r.missionType !== filter.missionType) return false;
    return true;
  });
}

/** Optimistic-CAS status transition; concurrent drift fails closed. */
export async function transitionMissionStatus(
  executor: MissionAuthorityStoreExecutor,
  input: {
    userId: number;
    missionId: string;
    expectedVersion: number;
    nextStatus: string;
  }
): Promise<void> {
  const current = await getMissionProposal(executor, input.userId, input.missionId);
  if (!current) fail("MISSION_NOT_FOUND", `mission ${input.missionId} not found`);
  if (current.version !== input.expectedVersion) {
    fail("MISSION_LIFECYCLE_CONFLICT", `mission ${input.missionId} version drift — concurrent lifecycle transition`);
  }
  const result = await executor
    .update(missionProposals)
    .set({ status: input.nextStatus, version: input.expectedVersion + 1 } as never)
    .where(
      and(
        eq(missionProposals.userId, input.userId),
        eq(missionProposals.missionId, input.missionId),
        eq(missionProposals.version, input.expectedVersion)
      )
    );
  const affected = Array.isArray(result) ? result.length : Number((result as { affectedRows?: number })?.affectedRows ?? 0);
  if (affected === 0) {
    fail("MISSION_LIFECYCLE_CONFLICT", `mission ${input.missionId} CAS transition lost — concurrent lifecycle change`);
  }
}

// ─── Lifecycle rows (append-only) ───

export interface MissionLifecycleRow {
  readonly lifecycleEventId: string;
  readonly userId: number;
  readonly missionId: string;
  readonly lifecycleType: string;
  readonly targetStatus: string;
  readonly successorMissionId: string | null;
  readonly occurredAt: string;
  readonly reasonCode: string | null;
  readonly createdAt?: unknown;
}

export async function insertMissionLifecycleEvent(
  executor: MissionAuthorityStoreExecutor,
  row: MissionLifecycleRow
): Promise<{ inserted: boolean }> {
  const rows = await executor
    .select()
    .from(missionLifecycleEvents)
    .where(eq(missionLifecycleEvents.lifecycleEventId, row.lifecycleEventId))
    .limit(1);
  if (rows.length > 0) return { inserted: false };
  try {
    const { createdAt: _c, ...insertRow } = row;
    void _c;
    await executor.insert(missionLifecycleEvents).values(insertRow as never);
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    return { inserted: false };
  }
  return { inserted: true };
}

export async function listMissionLifecycleRows(
  executor: MissionAuthorityStoreExecutor,
  userId: number,
  missionId: string
): Promise<MissionLifecycleRow[]> {
  const rows = await executor
    .select()
    .from(missionLifecycleEvents)
    .where(eq(missionLifecycleEvents.missionId, missionId));
  return (rows as unknown as MissionLifecycleRow[]).filter((r) => r.userId === userId);
}
