import { describe, expect, it } from "vitest";
import {
  and,
  asc,
  desc,
  eq,
  leadQualificationReviewsTable,
  leadQualificationsTable,
  getLatestQualification,
  getQualification,
  getReview,
  getReviewByQualification,
  insertQualification,
  insertReview,
  listQualificationHistory,
  listReviews,
  updateReviewResolution,
  type LeadQualificationReviewRow,
  type LeadQualificationRow,
  type QualificationStoreExecutor,
  type StoreOrderTerm,
  type StorePredicate,
} from "./qualification-store";

const H64 = "ab".repeat(32);
const G64 = "cd".repeat(32);
const E64 = "ef".repeat(32);
const F64 = "12".repeat(32);
const LEAD_ID = `lid1:${H64}`;
const SCORE_ID = `lsc1:${H64}`;
const NOW = "2026-06-28T12:00:00.000Z";

type Row = Record<string, unknown>;

interface FakeDbState {
  qualifications: Row[];
  reviews: Row[];
  insertAttempts: number;
  insertedQualifications: Row[];
  insertedReviews: Row[];
  updateCalls: number;
}

function makeDuplicateKeyError(): Error & { code: string; errno: number } {
  const err = new Error("Duplicate entry for key 'PRIMARY'") as Error & {
    code: string;
    errno: number;
  };
  err.code = "ER_DUP_ENTRY";
  err.errno = 1062;
  return err;
}

function evaluatePredicate(row: Row, predicate: StorePredicate): boolean {
  if (predicate.kind === "eq") return row[predicate.field] === predicate.value;
  return predicate.conditions.every((condition) => evaluatePredicate(row, condition));
}

function compareRows(a: Row, b: Row, terms: readonly StoreOrderTerm[]): number {
  for (const term of terms) {
    const av = a[term.field];
    const bv = b[term.field];
    if (av === bv) continue;
    const cmp = av === null || av === undefined ? -1 : bv === null || bv === undefined ? 1 : av < bv ? -1 : 1;
    return term.direction === "asc" ? cmp : -cmp;
  }
  return 0;
}

function makeFakeDb(): { executor: QualificationStoreExecutor; state: FakeDbState } {
  const state: FakeDbState = {
    qualifications: [],
    reviews: [],
    insertAttempts: 0,
    insertedQualifications: [],
    insertedReviews: [],
    updateCalls: 0,
  };

  const buildQuery = (rows: Row[]) => {
    let current = [...rows];
    const query = {
      all: async () => current.map((row) => ({ ...row })),
      limit: async (n: number) => current.slice(0, n).map((row) => ({ ...row })),
      orderBy: (...terms: StoreOrderTerm[]) => {
        current = [...current].sort((a, b) => compareRows(a, b, terms));
        return query;
      },
    };
    return query;
  };

  const targetFor = (rows: Row[]) => ({
    where: (predicate: StorePredicate) => buildQuery(rows.filter((row) => evaluatePredicate(row, predicate))),
    orderBy: (...terms: StoreOrderTerm[]) => buildQuery([...rows].sort((a, b) => compareRows(a, b, terms))),
    all: async () => rows.map((row) => ({ ...row })),
    limit: async (n: number) => rows.slice(0, n).map((row) => ({ ...row })),
  });

  const executor: QualificationStoreExecutor = {
    select: () => ({
      from: (table) =>
        table.tableName === "lead_qualifications"
          ? targetFor(state.qualifications)
          : targetFor(state.reviews),
    }),
    insert: (table) => ({
      values: async (row: Row) => {
        state.insertAttempts += 1;
        if (table.tableName === "lead_qualifications") {
          if (
            state.qualifications.some(
              (existing) => existing.userId === row.userId && existing.qualificationId === row.qualificationId
            )
          ) {
            throw makeDuplicateKeyError();
          }
          state.qualifications.push({ ...row });
          state.insertedQualifications.push({ ...row });
          return [{ affectedRows: 1 }];
        }
        if (
          state.reviews.some(
            (existing) => existing.userId === row.userId && existing.reviewId === row.reviewId
          ) ||
          state.reviews.some(
            (existing) => existing.userId === row.userId && existing.qualificationId === row.qualificationId
          )
        ) {
          throw makeDuplicateKeyError();
        }
        state.reviews.push({ ...row });
        state.insertedReviews.push({ ...row });
        return [{ affectedRows: 1 }];
      },
    }),
    update: (table) => ({
      set: (patch: Row) => ({
        where: async (predicate: StorePredicate) => {
          state.updateCalls += 1;
          const rows = table.tableName === "lead_qualifications" ? state.qualifications : state.reviews;
          let affected = 0;
          for (const row of rows) {
            if (evaluatePredicate(row, predicate)) {
              Object.assign(row, patch);
              affected += 1;
            }
          }
          return { affectedRows: affected };
        },
      }),
    }),
  };

  return { executor, state };
}

function qualificationRow(overrides: Partial<LeadQualificationRow> = {}): LeadQualificationRow {
  return {
    qualificationId: `lqu1:${H64}`,
    contractVersion: "lead-qualification/v1",
    engineVersion: "lead-qualification-engine/v1",
    userId: 7,
    businessId: 3,
    leadId: LEAD_ID,
    leadIdentityVersion: "lead-identity/v1",
    identityReference: G64,
    leadScoreId: SCORE_ID,
    scoringVersion: "lead-scoring-engine/v1",
    scoreContentHash: E64,
    qualificationPolicyVersion: "lead-qualification-policy/v1",
    evidenceSnapshotHash: F64,
    evidenceSnapshot: { assembledAt: NOW, entries: [] },
    decision: "QUALIFIED",
    reasonCodes: ["POLICY_REQUIREMENTS_MET"],
    confidenceScore: 10000,
    reviewRequired: false,
    evaluatedAt: NOW,
    validUntil: "2026-07-05T12:00:00.000Z",
    createdAt: NOW,
    ...overrides,
  };
}

function reviewRow(overrides: Partial<LeadQualificationReviewRow> = {}): LeadQualificationReviewRow {
  return {
    reviewId: `lqr1:${H64}`,
    userId: 7,
    businessId: 3,
    leadId: LEAD_ID,
    qualificationId: `lqu1:${H64}`,
    decisionBindingHash: G64,
    status: "pending",
    triggerReasonCodes: ["REVIEW_TRIGGERED_BY_POLICY"],
    resolvedBy: null,
    resolvedAt: null,
    resolutionReason: null,
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("qualification store — decisions", () => {
  it("inserts and reads back a decision row", async () => {
    const { executor, state } = makeFakeDb();
    const row = qualificationRow();
    const result = await insertQualification(row, executor);
    expect(result).toEqual({ inserted: true, duplicateClassification: "none" });
    expect(state.insertedQualifications).toHaveLength(1);

    const fetched = await getQualification(7, row.qualificationId, executor);
    expect(fetched).toEqual(row);
  });

  it("tenant-anchors reads: a different user cannot see the row", async () => {
    const { executor } = makeFakeDb();
    const row = qualificationRow();
    await insertQualification(row, executor);
    await expect(getQualification(9, row.qualificationId, executor)).rejects.toMatchObject({
      name: "QualificationInputError",
      code: "QUALIFICATION_NOT_FOUND",
    });
  });

  it("converges duplicate inserts without a second row", async () => {
    const { executor, state } = makeFakeDb();
    const row = qualificationRow();
    const first = await insertQualification(row, executor);
    const second = await insertQualification(qualificationRow(), executor);
    expect(first.inserted).toBe(true);
    expect(second).toEqual({ inserted: false, duplicateClassification: "idempotent_replay" });
    expect(state.qualifications).toHaveLength(1);
    expect(state.insertedQualifications).toHaveLength(1);
    expect(state.insertAttempts).toBe(2);
  });

  it("detects duplicates through the errno 1062 cause chain too", async () => {
    const { executor, state } = makeFakeDb();
    await insertQualification(qualificationRow(), executor);
    const wrapped = Object.assign(new Error("wrapper"), { cause: makeDuplicateKeyError() });
    const originalInsert = executor.insert;
    const wrappedExecutor: QualificationStoreExecutor = {
      ...executor,
      insert: (table) => ({
        values: async (inserted) => {
          if (state.insertAttempts > 0) throw wrapped;
          return originalInsert(table).values(inserted);
        },
      }),
    };
    const replay = await insertQualification(qualificationRow(), wrappedExecutor);
    expect(replay.duplicateClassification).toBe("idempotent_replay");
  });

  it("lists history oldest-first with a deterministic qualificationId tiebreak", async () => {
    const { executor } = makeFakeDb();
    const later = qualificationRow({
      qualificationId: `lqu1:${"aa".repeat(32)}`,
      evaluatedAt: "2026-06-29T12:00:00.000Z",
    });
    const earlyB = qualificationRow({
      qualificationId: `lqu1:${"bb".repeat(32)}`,
      evaluatedAt: "2026-06-27T12:00:00.000Z",
    });
    const earlyA = qualificationRow({
      qualificationId: `lqu1:${"cc".repeat(32)}`,
      evaluatedAt: "2026-06-27T12:00:00.000Z",
    });
    await insertQualification(later, executor);
    await insertQualification(earlyB, executor);
    await insertQualification(earlyA, executor);

    const history = await listQualificationHistory(7, LEAD_ID, executor);
    expect(history.map((row) => row.qualificationId)).toEqual([
      earlyB.qualificationId, // "bb" < "cc" at equal evaluatedAt
      earlyA.qualificationId,
      later.qualificationId,
    ]);
  });

  it("scopes history and latest by tenant", async () => {
    const { executor } = makeFakeDb();
    await insertQualification(qualificationRow(), executor);
    await insertQualification(qualificationRow({ userId: 9 }), executor);
    expect(await listQualificationHistory(9, LEAD_ID, executor)).toHaveLength(1);
  });

  it("resolves the latest decision with a deterministic tiebreak", async () => {
    const { executor } = makeFakeDb();
    expect(await getLatestQualification(7, LEAD_ID, executor)).toBeNull();
    const tiedA = qualificationRow({ qualificationId: `lqu1:${"dd".repeat(32)}` });
    const tiedB = qualificationRow({ qualificationId: `lqu1:${"ee".repeat(32)}` });
    await insertQualification(tiedA, executor);
    await insertQualification(tiedB, executor);
    const latest = await getLatestQualification(7, LEAD_ID, executor);
    expect(latest?.qualificationId).toBe(tiedB.qualificationId); // "ee" > "dd"
  });
});

describe("qualification store — reviews", () => {
  it("inserts and reads back a review row", async () => {
    const { executor } = makeFakeDb();
    const row = reviewRow();
    const result = await insertReview(row, executor);
    expect(result).toEqual({ inserted: true, duplicateClassification: "none" });
    expect(await getReview(7, row.reviewId, executor)).toEqual(row);
    expect(await getReviewByQualification(7, row.qualificationId, executor)).toEqual(row);
    await expect(getReview(9, row.reviewId, executor)).rejects.toMatchObject({
      code: "REVIEW_NOT_FOUND",
    });
  });

  it("returns null from getReviewByQualification when absent", async () => {
    const { executor } = makeFakeDb();
    expect(await getReviewByQualification(7, `lqu1:${H64}`, executor)).toBeNull();
  });

  it("converges duplicate review inserts on either durable anchor", async () => {
    const { executor, state } = makeFakeDb();
    const row = reviewRow();
    await insertReview(row, executor);
    const sameId = await insertReview(reviewRow({ qualificationId: `lqu1:${"ff".repeat(32)}` }), executor);
    expect(sameId).toEqual({ inserted: false, duplicateClassification: "idempotent_replay" });
    const sameQualification = await insertReview(reviewRow({ reviewId: `lqr1:${"ff".repeat(32)}` }), executor);
    expect(sameQualification).toEqual({ inserted: false, duplicateClassification: "idempotent_replay" });
    expect(state.reviews).toHaveLength(1);
    expect(state.insertedReviews).toHaveLength(1);
  });

  it("lists reviews with filters and deterministic ordering", async () => {
    const { executor } = makeFakeDb();
    const older = reviewRow({
      reviewId: `lqr1:${"aa".repeat(32)}`,
      qualificationId: `lqu1:${"aa".repeat(32)}`,
      createdAt: "2026-06-27T12:00:00.000Z",
      status: "progress_authorized",
      leadId: `lid1:${"aa".repeat(32)}`,
    });
    const newer = reviewRow({ reviewId: `lqr1:${"bb".repeat(32)}`, status: "pending" });
    await insertReview(newer, executor);
    await insertReview(older, executor);

    const all = await listReviews(7, {}, executor);
    expect(all.map((row) => row.reviewId)).toEqual([older.reviewId, newer.reviewId]);
    const pending = await listReviews(7, { status: "pending" }, executor);
    expect(pending.map((row) => row.reviewId)).toEqual([newer.reviewId]);
    const byLead = await listReviews(7, { leadId: older.leadId }, executor);
    expect(byLead.map((row) => row.reviewId)).toEqual([older.reviewId]);
  });

  it("resolves a review exactly once via optimistic CAS", async () => {
    const { executor, state } = makeFakeDb();
    const row = reviewRow();
    await insertReview(row, executor);

    const updated = await updateReviewResolution(
      7,
      row.reviewId,
      1,
      {
        status: "progress_authorized",
        resolvedBy: 7,
        resolvedAt: "2026-06-29T12:00:00.000Z",
        resolutionReason: "verified by ops",
      },
      executor
    );
    expect(updated.status).toBe("progress_authorized");
    expect(updated.version).toBe(2);
    expect(updated.resolvedBy).toBe(7);
    expect(updated.resolutionReason).toBe("verified by ops");
    expect(updated.updatedAt).toBe("2026-06-29T12:00:00.000Z");

    await expect(
      updateReviewResolution(
        7,
        row.reviewId,
        1,
        {
          status: "progression_rejected",
          resolvedBy: 7,
          resolvedAt: "2026-06-29T13:00:00.000Z",
          resolutionReason: "too late",
        },
        executor
      )
    ).rejects.toMatchObject({
      name: "QualificationStateConflictError",
      code: "REVIEW_ALREADY_RESOLVED",
    });
    // The stored row is untouched by the failed CAS.
    const stored = await getReview(7, row.reviewId, executor);
    expect(stored.status).toBe("progress_authorized");
    expect(stored.resolutionReason).toBe("verified by ops");
    expect(state.updateCalls).toBe(2);
  });

  it("fails closed when the review row does not exist", async () => {
    const { executor } = makeFakeDb();
    await expect(
      updateReviewResolution(
        7,
        `lqr1:${H64}`,
        1,
        { status: "progress_authorized", resolvedBy: 7, resolvedAt: NOW, resolutionReason: "x" },
        executor
      )
    ).rejects.toMatchObject({ code: "REVIEW_ALREADY_RESOLVED" });
  });
});

describe("qualification store — predicate helpers", () => {
  it("builds eq/and/asc/desc descriptors", () => {
    expect(eq("userId", 7)).toEqual({ kind: "eq", field: "userId", value: 7 });
    expect(and(eq("a", 1), eq("b", 2))).toEqual({
      kind: "and",
      conditions: [
        { kind: "eq", field: "a", value: 1 },
        { kind: "eq", field: "b", value: 2 },
      ],
    });
    expect(asc("evaluatedAt")).toEqual({ field: "evaluatedAt", direction: "asc" });
    expect(desc("qualificationId")).toEqual({ field: "qualificationId", direction: "desc" });
  });

  it("exposes the R6-C table handles", () => {
    expect(leadQualificationsTable.tableName).toBe("lead_qualifications");
    expect(leadQualificationReviewsTable.tableName).toBe("lead_qualification_reviews");
  });
});
