// ─── R6-A Lead Identity — durable store ───
//
// DB-authoritative persistence. Convergence anchors are durable unique keys
// (no in-memory dedupe): (userId, identityKey) + (userId, leadId) on
// lead_identities; (userId, handoffId) + (userId, kind, evidenceHash) on
// provenance; (userId, mergeId) + (userId, canonicalLeadId, absorbedLeadId)
// on merges. Mutable identity state is optimistic-CAS guarded (version);
// stale writes fail closed (STALE_STATE). Provenance and merges are
// append-only. Optional caller executor seam (same discipline as
// opportunity-store / audit-store).

import { and, eq, or } from "drizzle-orm";
import {
  leadIdentities,
  leadIdentityProvenance,
  leadIdentityMerges,
  type LeadIdentityRow,
  type InsertLeadIdentityRow,
  type LeadIdentityProvenanceRow,
  type InsertLeadIdentityProvenanceRow,
  type LeadIdentityMergeRow,
  type InsertLeadIdentityMergeRow,
} from "@db/schema";
import { getDb } from "../../queries/connection";
import {
  LeadIdentityStateConflictError,
  type LeadIdentityDuplicateClassification,
} from "./lead-identity-contract";

type Db = ReturnType<typeof getDb>;

export interface LeadIdentityStoreExecutor {
  select: Db["select"];
  insert: Db["insert"];
  update: Db["update"];
}

function resolveDb(executor?: LeadIdentityStoreExecutor): LeadIdentityStoreExecutor {
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

export interface IdentityStoreWriteResult<T> {
  row: T;
  inserted: boolean;
  duplicateClassification: LeadIdentityDuplicateClassification;
}

// ─── Identities ───

export async function findIdentityByKey(
  userId: number,
  identityKey: string,
  executor?: LeadIdentityStoreExecutor
): Promise<LeadIdentityRow | null> {
  const db = resolveDb(executor);
  const [row] = await db
    .select()
    .from(leadIdentities)
    .where(and(eq(leadIdentities.userId, userId), eq(leadIdentities.identityKey, identityKey)))
    .limit(1);
  return row ?? null;
}

export async function findIdentityByLeadId(
  userId: number,
  leadId: string,
  executor?: LeadIdentityStoreExecutor
): Promise<LeadIdentityRow | null> {
  const db = resolveDb(executor);
  const [row] = await db
    .select()
    .from(leadIdentities)
    .where(and(eq(leadIdentities.userId, userId), eq(leadIdentities.leadId, leadId)))
    .limit(1);
  return row ?? null;
}

export async function findIdentityByLinkingHash(
  userId: number,
  column: "emailIdentityHash" | "phoneIdentityHash" | "customerReferenceHash",
  hash: string,
  executor?: LeadIdentityStoreExecutor
): Promise<LeadIdentityRow | null> {
  const db = resolveDb(executor);
  const [row] = await db
    .select()
    .from(leadIdentities)
    .where(and(eq(leadIdentities.userId, userId), eq(leadIdentities[column], hash)))
    .limit(1);
  return row ?? null;
}

export async function insertIdentity(
  row: InsertLeadIdentityRow,
  executor?: LeadIdentityStoreExecutor
): Promise<IdentityStoreWriteResult<LeadIdentityRow>> {
  const db = resolveDb(executor);
  try {
    await db.insert(leadIdentities).values(row);
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    const existing = await findIdentityByKey(Number(row.userId), row.identityKey, executor);
    if (existing) {
      return { row: existing, inserted: false, duplicateClassification: "idempotent_replay" };
    }
    throw err;
  }
  const inserted = await findIdentityByKey(Number(row.userId), row.identityKey, executor);
  return { row: inserted!, inserted: true, duplicateClassification: "none" };
}

export interface IdentityStatePatch {
  primaryIdentityType?: LeadIdentityRow["primaryIdentityType"];
  identityStatus?: LeadIdentityRow["identityStatus"];
  identityConfidence?: LeadIdentityRow["identityConfidence"];
  emailIdentityHash?: string | null;
  phoneIdentityHash?: string | null;
  customerReferenceHash?: string | null;
  canonicalLeadId?: string | null;
  lastObservedAt?: string;
  provenanceCount?: number;
  identityEvidenceCount?: number;
  statusChangedAt?: Date;
  updatedAt?: Date;
}

/** Optimistic-CAS guarded update; stale/raced writes fail closed. */
export async function updateIdentityState(
  userId: number,
  id: number,
  expectedVersion: number,
  patch: IdentityStatePatch,
  executor?: LeadIdentityStoreExecutor
): Promise<LeadIdentityRow> {
  const db = resolveDb(executor);
  const set: Record<string, unknown> = { ...patch, version: expectedVersion + 1 };
  const result = await db
    .update(leadIdentities)
    .set(set)
    .where(
      and(
        eq(leadIdentities.userId, userId),
        eq(leadIdentities.id, id),
        eq(leadIdentities.version, expectedVersion)
      )
    );
  const header = result as unknown as Record<string, unknown>;
  const affected = Number(header.affectedRows ?? header.rowsAffected ?? 0);
  if (affected === 0) {
    const [row] = await db
      .select()
      .from(leadIdentities)
      .where(and(eq(leadIdentities.userId, userId), eq(leadIdentities.id, id)))
      .limit(1);
    if (!row) {
      throw new LeadIdentityStateConflictError("STALE_STATE", `lead identity row ${id} not found for user ${userId}.`);
    }
    throw new LeadIdentityStateConflictError(
      "STALE_STATE",
      `lead identity row ${id} is at version ${row.version}; expected ${expectedVersion}. Stale write rejected.`
    );
  }
  const [updated] = await db
    .select()
    .from(leadIdentities)
    .where(and(eq(leadIdentities.userId, userId), eq(leadIdentities.id, id)))
    .limit(1);
  return updated!;
}

export async function listIdentities(
  userId: number,
  filters: { status?: string; identityType?: string; businessId?: number } = {},
  limit = 50,
  executor?: LeadIdentityStoreExecutor
): Promise<LeadIdentityRow[]> {
  const db = resolveDb(executor);
  const conditions = [eq(leadIdentities.userId, userId)];
  if (filters.status) conditions.push(eq(leadIdentities.identityStatus, filters.status as never));
  if (filters.identityType) {
    conditions.push(eq(leadIdentities.primaryIdentityType, filters.identityType as never));
  }
  if (filters.businessId !== undefined) {
    conditions.push(eq(leadIdentities.businessId, filters.businessId));
  }
  return db
    .select()
    .from(leadIdentities)
    .where(and(...conditions))
    .limit(Math.min(Math.max(limit, 1), 200)) as Promise<LeadIdentityRow[]>;
}

// ─── Provenance (immutable, append-only) ───

export async function findProvenanceByHandoff(
  userId: number,
  handoffId: string,
  executor?: LeadIdentityStoreExecutor
): Promise<LeadIdentityProvenanceRow | null> {
  const db = resolveDb(executor);
  const [row] = await db
    .select()
    .from(leadIdentityProvenance)
    .where(and(eq(leadIdentityProvenance.userId, userId), eq(leadIdentityProvenance.handoffId, handoffId)))
    .limit(1);
  return row ?? null;
}

export async function findProvenanceByKindHash(
  userId: number,
  kind: LeadIdentityProvenanceRow["kind"],
  evidenceHash: string,
  executor?: LeadIdentityStoreExecutor
): Promise<LeadIdentityProvenanceRow | null> {
  const db = resolveDb(executor);
  const [row] = await db
    .select()
    .from(leadIdentityProvenance)
    .where(
      and(
        eq(leadIdentityProvenance.userId, userId),
        eq(leadIdentityProvenance.kind, kind),
        eq(leadIdentityProvenance.evidenceHash, evidenceHash)
      )
    )
    .limit(1);
  return row ?? null;
}

export async function insertProvenance(
  row: InsertLeadIdentityProvenanceRow,
  executor?: LeadIdentityStoreExecutor
): Promise<IdentityStoreWriteResult<LeadIdentityProvenanceRow>> {
  const db = resolveDb(executor);
  try {
    await db.insert(leadIdentityProvenance).values(row);
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    const existing = await findProvenanceByKindHash(
      Number(row.userId),
      row.kind as LeadIdentityProvenanceRow["kind"],
      row.evidenceHash,
      executor
    );
    if (existing) {
      return { row: existing, inserted: false, duplicateClassification: "idempotent_replay" };
    }
    throw err;
  }
  const inserted = await findProvenanceByKindHash(
    Number(row.userId),
    row.kind as LeadIdentityProvenanceRow["kind"],
    row.evidenceHash,
    executor
  );
  return { row: inserted!, inserted: true, duplicateClassification: "none" };
}

export async function listProvenanceForLead(
  leadRowId: number,
  executor?: LeadIdentityStoreExecutor
): Promise<LeadIdentityProvenanceRow[]> {
  const db = resolveDb(executor);
  return db
    .select()
    .from(leadIdentityProvenance)
    .where(eq(leadIdentityProvenance.leadRowId, leadRowId)) as Promise<LeadIdentityProvenanceRow[]>;
}

// ─── Merges (immutable authority records) ───

export async function findMergeByPair(
  userId: number,
  canonicalLeadId: string,
  absorbedLeadId: string,
  executor?: LeadIdentityStoreExecutor
): Promise<LeadIdentityMergeRow | null> {
  const db = resolveDb(executor);
  const [row] = await db
    .select()
    .from(leadIdentityMerges)
    .where(
      and(
        eq(leadIdentityMerges.userId, userId),
        eq(leadIdentityMerges.canonicalLeadId, canonicalLeadId),
        eq(leadIdentityMerges.absorbedLeadId, absorbedLeadId)
      )
    )
    .limit(1);
  return row ?? null;
}

export async function insertMerge(
  row: InsertLeadIdentityMergeRow,
  executor?: LeadIdentityStoreExecutor
): Promise<IdentityStoreWriteResult<LeadIdentityMergeRow>> {
  const db = resolveDb(executor);
  try {
    await db.insert(leadIdentityMerges).values(row);
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    const existing = await findMergeByPair(
      Number(row.userId),
      row.canonicalLeadId,
      row.absorbedLeadId,
      executor
    );
    if (existing) {
      return { row: existing, inserted: false, duplicateClassification: "idempotent_replay" };
    }
    throw err;
  }
  const inserted = await findMergeByPair(
    Number(row.userId),
    row.canonicalLeadId,
    row.absorbedLeadId,
    executor
  );
  return { row: inserted!, inserted: true, duplicateClassification: "none" };
}

export async function listMergesForLead(
  userId: number,
  leadId: string,
  executor?: LeadIdentityStoreExecutor
): Promise<LeadIdentityMergeRow[]> {
  const db = resolveDb(executor);
  return db
    .select()
    .from(leadIdentityMerges)
    .where(
      and(
        eq(leadIdentityMerges.userId, userId),
        or(
          eq(leadIdentityMerges.canonicalLeadId, leadId),
          eq(leadIdentityMerges.absorbedLeadId, leadId)
        )
      )
    ) as Promise<LeadIdentityMergeRow[]>;
}
