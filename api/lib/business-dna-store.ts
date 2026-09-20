import { desc, eq } from "drizzle-orm";
import { getDb } from "../queries/connection";
import {
  businessDnaSnapshots,
  type BusinessDnaSnapshotRow,
} from "@db/schema";
import {
  assertCanonicalBusinessDnaSnapshot,
  type BusinessDNASnapshot,
} from "./business-dna";

/**
 * Durable Business DNA snapshot authority (BI-owned).
 *
 * Persists canonical {@link BusinessDNASnapshot} projections as immutable
 * rows. Snapshots are write-once: the module exposes no update or delete path,
 * a repeated insert of the same canonical snapshot replays idempotently, and a
 * colliding snapshotId with a different payload fails closed. Historical rows
 * are reconstructed from the stored canonical payload — never rebuilt from the
 * mutable businesses row.
 */

type BusinessDnaStoreDb = ReturnType<typeof getDb>;

/**
 * Structural executor seam: the default getDb() client and a Drizzle
 * transaction callback client both satisfy this shape. Supplied executors
 * carry no transaction-lifecycle ownership here.
 */
export interface BusinessDnaStoreDbExecutor {
  select: BusinessDnaStoreDb["select"];
  insert: BusinessDnaStoreDb["insert"];
}

function resolveBusinessDnaStoreDb(
  executor?: BusinessDnaStoreDbExecutor
): BusinessDnaStoreDbExecutor {
  return executor ?? getDb();
}

export class BusinessDnaSnapshotConflictError extends Error {
  readonly code = "BUSINESS_DNA_SNAPSHOT_CONFLICT" as const;
  readonly snapshotId: string;

  constructor(snapshotId: string) {
    super(
      `business DNA snapshot "${snapshotId}" already exists with a different canonical payload`
    );
    this.name = "BusinessDnaSnapshotConflictError";
    this.snapshotId = snapshotId;
  }
}

export interface PersistBusinessDnaSnapshotInput {
  /** Canonical snapshot to persist; carries the caller-provided capturedAtIso. */
  readonly snapshot: BusinessDNASnapshot;
  /** Owning user for the business at capture time. */
  readonly userId: number;
}

export type PersistedBusinessDnaSnapshot =
  | {
      readonly status: "inserted";
      readonly snapshot: BusinessDNASnapshot;
      readonly row: BusinessDnaSnapshotRow;
    }
  | {
      readonly status: "replayed";
      readonly snapshot: BusinessDNASnapshot;
      readonly row: BusinessDnaSnapshotRow;
    };

/**
 * Canonical JSON serialization with sorted object keys. MySQL normalizes JSON
 * object key order on storage, so replay/conflict comparison must be
 * key-order-insensitive while remaining exact on values.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function canonicalSnapshotsEquivalent(
  a: BusinessDNASnapshot,
  b: BusinessDNASnapshot
): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

function rowToCanonicalSnapshot(row: BusinessDnaSnapshotRow): BusinessDNASnapshot {
  return assertCanonicalBusinessDnaSnapshot(row.snapshot);
}

function requirePersistUserId(userId: number): number {
  const resolved = Number(userId);
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new Error("persistBusinessDnaSnapshot requires a positive numeric userId");
  }
  return resolved;
}

/** Narrow MySQL duplicate-key signal (ER_DUP_ENTRY / errno 1062) and nothing else. */
function isDuplicateKeyError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; errno?: unknown };
  return candidate.code === "ER_DUP_ENTRY" || candidate.errno === 1062;
}

interface CommittedSnapshotAuthority {
  readonly row: BusinessDnaSnapshotRow;
  readonly snapshot: BusinessDNASnapshot;
}

async function loadCommittedSnapshotBySnapshotId(
  db: BusinessDnaStoreDbExecutor,
  snapshotId: string
): Promise<CommittedSnapshotAuthority | null> {
  const [row] = await db
    .select()
    .from(businessDnaSnapshots)
    .where(eq(businessDnaSnapshots.snapshotId, snapshotId))
    .limit(1);
  return row ? { row, snapshot: rowToCanonicalSnapshot(row) } : null;
}

/**
 * A committed row only authorizes a replay when the immutable identity
 * columns and the full canonical payload match the incoming snapshot exactly.
 * Any deviation fails closed as a conflict.
 */
function assertCommittedMatchesIncoming(
  committed: CommittedSnapshotAuthority,
  snapshot: BusinessDNASnapshot
): void {
  if (
    committed.row.snapshotId !== snapshot.snapshotId ||
    committed.row.businessId !== snapshot.businessId ||
    committed.row.version !== snapshot.version ||
    committed.row.evidenceHashSha256 !== snapshot.evidenceHashSha256 ||
    !canonicalSnapshotsEquivalent(committed.snapshot, snapshot)
  ) {
    throw new BusinessDnaSnapshotConflictError(snapshot.snapshotId);
  }
}

export async function persistBusinessDnaSnapshot(
  input: PersistBusinessDnaSnapshotInput,
  executor?: BusinessDnaStoreDbExecutor
): Promise<PersistedBusinessDnaSnapshot> {
  const db = resolveBusinessDnaStoreDb(executor);
  const snapshot = assertCanonicalBusinessDnaSnapshot(input.snapshot);
  const userId = requirePersistUserId(input.userId);

  const existing = await loadCommittedSnapshotBySnapshotId(db, snapshot.snapshotId);
  if (existing) {
    assertCommittedMatchesIncoming(existing, snapshot);
    return { status: "replayed", snapshot: existing.snapshot, row: existing.row };
  }

  try {
    const [insertResult] = await db
      .insert(businessDnaSnapshots)
      .values({
        snapshotId: snapshot.snapshotId,
        businessId: snapshot.businessId,
        userId,
        version: snapshot.version,
        evidenceHashSha256: snapshot.evidenceHashSha256,
        businessName: snapshot.businessName,
        industry: snapshot.industry,
        primaryOffering: snapshot.primaryOffering,
        snapshot,
        capturedAt: new Date(snapshot.capturedAtIso),
      });

    const [row] = await db
      .select()
      .from(businessDnaSnapshots)
      .where(eq(businessDnaSnapshots.id, Number(insertResult.insertId)))
      .limit(1);

    if (!row) {
      throw new Error("failed to reload inserted business DNA snapshot row");
    }
    return { status: "inserted", snapshot: rowToCanonicalSnapshot(row), row };
  } catch (error) {
    if (!isDuplicateKeyError(error)) {
      throw error;
    }
    // Lost a concurrent insert race for the same snapshotId: the unique
    // constraint is the authority, so resolve through the committed row
    // instead of surfacing a raw duplicate-key error.
    const committed = await loadCommittedSnapshotBySnapshotId(db, snapshot.snapshotId);
    if (!committed) {
      throw new Error(
        `business DNA snapshot "${snapshot.snapshotId}" reported a duplicate key but no committed row could be loaded`
      );
    }
    assertCommittedMatchesIncoming(committed, snapshot);
    return { status: "replayed", snapshot: committed.snapshot, row: committed.row };
  }
}

export async function getBusinessDnaSnapshotById(
  id: number,
  executor?: BusinessDnaStoreDbExecutor
): Promise<BusinessDNASnapshot | null> {
  const db = resolveBusinessDnaStoreDb(executor);
  const [row] = await db
    .select()
    .from(businessDnaSnapshots)
    .where(eq(businessDnaSnapshots.id, id))
    .limit(1);
  return row ? rowToCanonicalSnapshot(row) : null;
}

export async function getBusinessDnaSnapshotBySnapshotId(
  snapshotId: string,
  executor?: BusinessDnaStoreDbExecutor
): Promise<BusinessDNASnapshot | null> {
  const db = resolveBusinessDnaStoreDb(executor);
  const [row] = await db
    .select()
    .from(businessDnaSnapshots)
    .where(eq(businessDnaSnapshots.snapshotId, snapshotId))
    .limit(1);
  return row ? rowToCanonicalSnapshot(row) : null;
}

export async function getLatestBusinessDnaSnapshotForBusiness(
  businessId: number,
  executor?: BusinessDnaStoreDbExecutor
): Promise<BusinessDNASnapshot | null> {
  const db = resolveBusinessDnaStoreDb(executor);
  const [row] = await db
    .select()
    .from(businessDnaSnapshots)
    .where(eq(businessDnaSnapshots.businessId, businessId))
    .orderBy(desc(businessDnaSnapshots.capturedAt), desc(businessDnaSnapshots.id))
    .limit(1);
  return row ? rowToCanonicalSnapshot(row) : null;
}
