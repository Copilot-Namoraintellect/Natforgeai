// ─── R8-B Business Change Intelligence — R8-A strategic-memory seam ───
//
// Consumes R8-A strategic memory READ-ONLY as the previous-state comparison
// authority (B6). R8-A remains the memory authority: this seam never writes
// strategic_memory_records (or any upstream table), never mints memory
// identities/statuses, and fail-closed degrades to "no previous state" when
// the R8-A table is absent (guarded information-schema check — house seam
// pattern).
//
// Current-state semantics are enforced here exactly as the frozen
// strategic-memory-to-reasoning/v1 contract defines them:
//   - only factStatus='CURRENT' memory can serve as the active comparison
//     anchor (never stale/superseded/contradicted/expired/invalidated);
//   - a CURRENT row whose validUntil has already passed is excluded
//     (deterministic temporal state — expired memory is history, not context);
//   - FACT and ASSUMPTION remain distinct end-to-end (statementType is bound
//     into both state refs and caps derived confidence);
//   - contradiction history is preserved untouched (read-only).
//
// The subject → memory predicate table below is the R8-B consumption
// contract; R8-X integration reconciles it with R8-A ingest coordinates (the
// binding-proof pattern R7-X used for B's outcome seam).

import { sql } from "drizzle-orm";
import { getDb } from "../../queries/connection";
import { BusinessChangeInputError } from "./business-change-contract";
import type { BusinessChangeSubjectType } from "./business-change-contract";

/** The compared memory row (closed view of the R8-A current projection). */
export interface MemoryComparisonView {
  memoryId: string;
  sourceAuthority: string;
  sourceIdentity: string;
  sourceVersion: string;
  statementType: "FACT" | "ASSUMPTION";
  memoryType: string;
  statement: unknown;
  confidenceClass: string;
  evidenceHash: string;
}

export interface BusinessChangeMemoryPort {
  /**
   * Returns the active (CURRENT) memory comparison anchor for the subject,
   * or null when none exists. Implementations must enforce current-state
   * semantics (never silently serve non-current memory).
   */
  getCurrentMemoryForSubject(
    userId: number,
    businessId: number,
    subjectType: BusinessChangeSubjectType,
    subjectId: string
  ): Promise<MemoryComparisonView | null>;
}

// ─── Subject → memory predicate table (R8-B consumption contract) ───

const MEMORY_ID_PATTERN = /^mem1:[a-f0-9]{64}$/;

function escapeSqlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/"/g, '\\"');
}

/**
 * Deterministic WHERE fragment per subject (server-derived constants only).
 * R8-X convergence binding: R8-A mints governed-source memories with A's
 * canonical coordinates — business_dna memories are subjectType BUSINESS /
 * subjectId business:<id>; r7_budget_portfolio memories are subjectType
 * OPTIMISATION keyed by upstream optimisation id; r7_governance memories are
 * keyed by decision id. The previous-state lookup therefore anchors on the
 * source authority (latest CURRENT row for this tenant + business, id DESC),
 * never on B-local subject coordinates that A does not mint.
 */
export function memoryPredicateForSubject(
  subjectType: BusinessChangeSubjectType,
  subjectId: string,
  businessId: number
): string {
  switch (subjectType) {
    case "OBJECTIVE":
      return `memoryType = 'STRATEGIC_OBJECTIVE' AND subjectId = '${escapeSqlString(subjectId)}'`;
    case "PRODUCT_SET":
    case "AUDIENCE_SET":
      return `sourceAuthority = 'business_dna' AND subjectType = 'BUSINESS' AND subjectId = 'business:${businessId}'`;
    case "BUDGET_ENVELOPE":
    case "PROVIDER_CAPABILITY":
      return `sourceAuthority = 'r7_budget_portfolio'`;
    case "LEARNING": {
      // Learning changes bind to the pattern-family anchor (e.g.
      // learning:campaign:500); the previous-state memory is the CURRENT
      // LEARNING_PATTERN memory R8-A minted for that subject coordinate.
      const learningSubject = subjectId.replace(/^learning:/, "");
      return `memoryType = 'LEARNING_PATTERN' AND subjectId = '${escapeSqlString(learningSubject)}'`;
    }
    case "STRATEGY": {
      const campaignRef = subjectId.replace(/^strategy:/, "");
      return `sourceAuthority = 'strategy_snapshot' AND subjectType = 'CAMPAIGN' AND subjectId = '${escapeSqlString(campaignRef)}'`;
    }
    case "CONSTRAINT": {
      const decisionId = subjectId.replace(/^constraint:/, "");
      return `sourceAuthority = 'r7_governance' AND subjectId = '${escapeSqlString(decisionId)}'`;
    }
    case "RISK_POSTURE":
      return `sourceAuthority = 'r7_governance' AND subjectType = 'GOVERNANCE'`;
    default:
      throw new BusinessChangeInputError("CHANGE_DOMAIN_UNSUPPORTED", `No memory predicate for subjectType ${subjectType}.`);
  }
}

type SqlExecutor = { execute: ReturnType<typeof getDb>["execute"] };

const tableExistsCache = new Map<string, boolean>();

/** Normalize drizzle execute() result shapes to a plain row array. */
function normalizeSqlRows(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) {
    // mysql2 callback form: [rows, fields]
    const first = result[0];
    if (Array.isArray(first)) return first as Array<Record<string, unknown>>;
    if (first && typeof first === "object") return [first as Record<string, unknown>];
    return [];
  }
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown[] }).rows)) {
    return (result as { rows: Array<Record<string, unknown>> }).rows;
  }
  return [];
}

async function memoryTableExists(db: SqlExecutor): Promise<boolean> {
  const cached = tableExistsCache.get("strategic_memory_records");
  if (cached !== undefined) return cached;
  let exists = false;
  try {
    const rows = normalizeSqlRows(
      await db.execute(sql`
        SELECT COUNT(*) AS c FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'strategic_memory_records'
      `)
    );
    const first = rows[0];
    const count = first ? Number(first.c ?? 0) : 0;
    exists = Number.isInteger(count) && count > 0;
  } catch {
    exists = false;
  }
  tableExistsCache.set("strategic_memory_records", exists);
  return exists;
}

function shapeMemoryRow(row: Record<string, unknown>): MemoryComparisonView {
  return {
    memoryId: String(row.memoryId ?? ""),
    sourceAuthority: String(row.sourceAuthority ?? ""),
    sourceIdentity: String(row.sourceIdentity ?? ""),
    sourceVersion: String(row.sourceVersion ?? ""),
    statementType: row.statementType === "ASSUMPTION" ? "ASSUMPTION" : "FACT",
    memoryType: String(row.memoryType ?? ""),
    statement: row.statement ?? null,
    confidenceClass: String(row.confidenceClass ?? ""),
    evidenceHash: String(row.evidenceHash ?? ""),
  };
}

function isCurrentlyValid(view: MemoryComparisonView, row: Record<string, unknown>, now: string): boolean {
  if (!MEMORY_ID_PATTERN.test(view.memoryId)) return false;
  const validUntil = row.validUntil;
  if (typeof validUntil === "string" && validUntil.length > 0) {
    if (!Number.isNaN(Date.parse(validUntil)) && Date.parse(validUntil) < Date.parse(now)) return false;
  }
  return true;
}

/**
 * Production memory port: reads strategic_memory_records through raw SQL
 * behind the guarded existence check. Only factStatus='CURRENT' rows are
 * candidates; already-expired validity windows are excluded deterministically.
 * Never writes. When the R8-A table is absent, degrades to "no previous
 * state" (the caller fails closed with CHANGE_PREVIOUS_STATE_MISSING).
 */
export function createBusinessChangeMemoryPort(now: string): BusinessChangeMemoryPort {
  return {
    async getCurrentMemoryForSubject(userId, businessId, subjectType, subjectId) {
      const db = getDb();
      if (!(await memoryTableExists(db))) return null;
      const predicate = memoryPredicateForSubject(subjectType, subjectId, businessId);
      const rows = normalizeSqlRows(
        await db.execute(sql`
          SELECT memoryId, sourceAuthority, sourceIdentity, sourceVersion, statementType,
                 memoryType, statement, confidenceClass, evidenceHash, validUntil
          FROM strategic_memory_records
          WHERE userId = ${userId} AND businessId = ${businessId} AND factStatus = 'CURRENT'
            AND ${sql.raw(predicate)}
          ORDER BY id DESC
          LIMIT 1
        `)
      );
      const row = rows[0];
      if (!row) return null;
      const view = shapeMemoryRow(row);
      if (!isCurrentlyValid(view, row, now)) return null;
      return view;
    },
  };
}

/** Test/injection port over pre-shaped memory rows (fake enforces CURRENT-only semantics). */
export interface FakeMemoryRow extends MemoryComparisonView {
  subjectId: string;
  factStatus: string;
  validUntil?: string | null;
}

export function createInMemoryBusinessChangePort(rows: FakeMemoryRow[]): BusinessChangeMemoryPort {
  return {
    async getCurrentMemoryForSubject(_userId, _businessId, subjectType, subjectId) {
      const current = rows.filter((row) => row.factStatus === "CURRENT");
      // Newest-first so the latest CURRENT row wins (parity with id DESC).
      const match = [...current].reverse().find((row) => {
        if (subjectType === "OBJECTIVE") {
          return row.memoryType === "STRATEGIC_OBJECTIVE" && row.subjectId === subjectId;
        }
        if (subjectType === "PRODUCT_SET" || subjectType === "AUDIENCE_SET") {
          // R8-X binding: R8-A mints DNA memories as subjectType BUSINESS /
          // subjectId business:<id>.
          return row.sourceAuthority === "business_dna" && row.subjectId === `business:${_businessId}`;
        }
        if (subjectType === "BUDGET_ENVELOPE" || subjectType === "PROVIDER_CAPABILITY") {
          return row.sourceAuthority === "r7_budget_portfolio";
        }
        if (subjectType === "LEARNING") {
          return row.memoryType === "LEARNING_PATTERN" && `learning:${row.subjectId}` === subjectId;
        }
        if (subjectType === "STRATEGY") {
          return row.sourceAuthority === "strategy_snapshot" && `strategy:${row.subjectId}` === subjectId;
        }
        if (subjectType === "CONSTRAINT") {
          return row.sourceAuthority === "r7_governance" && `constraint:${row.subjectId}` === subjectId;
        }
        if (subjectType === "RISK_POSTURE") {
          // R8-X binding: latest CURRENT r7_governance memory is the posture.
          return row.sourceAuthority === "r7_governance";
        }
        return false;
      });
      if (!match) return null;
      if (match.validUntil && Date.parse(match.validUntil) < Date.parse(new Date().toISOString())) return null;
      return match;
    },
  };
}
