import { describe, expect, it, vi } from "vitest";
import * as store from "./interpretation-store";
import { acceptInterpretation } from "./interpretation-store";
import {
  CLASSIFIER_VERSION,
  InterpretationTamperError,
  SOCIAL_INTELLIGENCE_SCHEMA_VERSION,
  type SocialInterpretation,
} from "./interpretation-contract";
import { toCanonicalSignal } from "./canonical-signal";
import { sanitizeSignalText } from "./input-safety";
import {
  buildInterpretationBillingIdentity,
  computeInterpretationFingerprint,
  computeInterpretationId,
  computeSignalContentHash,
} from "./interpretation-identity";

const CLASSIFIER = CLASSIFIER_VERSION;
const FIXED_CREATED_AT = "2026-06-01T12:00:00.000Z";

function makeRecord(overrides: Partial<SocialInterpretation> = {}): SocialInterpretation {
  const businessId = overrides.businessId ?? 3;
  const signal = sanitizeSignalText(
    toCanonicalSignal({
      signalId: overrides.signalId ?? "sig-store-1",
      signalVersion: overrides.signalVersion ?? 1,
      signalType: "comment",
      platform: "instagram",
      text: "store fixture text",
    })
  );
  const signalContentHash = computeSignalContentHash(signal);
  const base = {
    interpretationId: computeInterpretationId({
      schemaVersion: SOCIAL_INTELLIGENCE_SCHEMA_VERSION,
      businessId,
      signalId: signal.signalId,
      signalVersion: signal.signalVersion,
      signalContentHash,
      classifierVersion: CLASSIFIER,
    }),
    schemaVersion: SOCIAL_INTELLIGENCE_SCHEMA_VERSION,
    classifierVersion: CLASSIFIER,
    userId: 7,
    businessId,
    signalId: signal.signalId,
    signalVersion: signal.signalVersion,
    signalContentHash,
    signalType: signal.signalType,
    source: "RULE" as const,
    intent: "spam" as const,
    intentConfidence: "high" as const,
    sentiment: "neutral" as const,
    sentimentConfidence: "high" as const,
    urgency: "low" as const,
    relevance: "not_relevant" as const,
    relevanceConfidence: "high" as const,
    overallConfidence: "high" as const,
    confidenceBasis: "deterministic_rule" as const,
    topics: [],
    riskFlags: [{ flag: "spam_or_scam" as const, evidence: "marker" }],
    opportunityIndicators: [],
    recommendedHandling: "no_action" as const,
    businessDnaSnapshotId: null,
    evidenceReferences: [{ kind: "rule" as const, ref: "rules-engine:spam_markers" }],
    explanation: "Deterministic spam markers matched; signal is not relevant to the business.",
    billingIdentity: null,
    interpretationFingerprint: "",
    createdAt: FIXED_CREATED_AT,
    status: "accepted" as const,
  };
  const record = { ...base, ...overrides };
  return {
    ...record,
    interpretationFingerprint: computeInterpretationFingerprint(record),
  } as SocialInterpretation;
}

interface FakeState {
  rows: any[];
  inserts: any[];
}

function isNaturalKeyDup(rows: any[], row: any): boolean {
  return rows.some(
    (r) =>
      r.businessId === row.businessId &&
      r.signalId === row.signalId &&
      r.signalVersion === row.signalVersion &&
      r.classifierVersion === row.classifierVersion
  );
}

function createFakeExecutor(initialRows: any[] = []) {
  const state: FakeState = { rows: [...initialRows], inserts: [] };
  const db: any = {
    state,
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn((...conds: any[]) => {
          const wanted = collectPredicateValues(conds);
          const filtered = state.rows.filter((r) =>
            wanted.every((v) => Object.values(r).includes(v))
          );
          return {
            limit: vi.fn(async () => filtered.slice(0, 1)),
            orderBy: vi.fn(async () =>
              [...filtered].sort(
                (a, b) => a.signalVersion - b.signalVersion || String(a.classifierVersion).localeCompare(String(b.classifierVersion))
              )
            ),
          };
        }),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(async (row: any) => {
        if (
          state.rows.some((r) => r.interpretationId === row.interpretationId) ||
          isNaturalKeyDup(state.rows, row)
        ) {
          const error: any = new Error("Duplicate entry for key 'social_interpretation'");
          error.code = "ER_DUP_ENTRY";
          error.errno = 1062;
          throw error;
        }
        state.rows.push(row);
        state.inserts.push(row);
        return [{ insertId: state.rows.length, affectedRows: 1 }];
      }),
    })),
  };
  return { db, state };
}

/** Extract primitive predicate values from drizzle eq()/and() SQL objects. */
function collectPredicateValues(conds: unknown[]): unknown[] {
  const out: unknown[] = [];
  const seen = new Set<object>();
  const walk = (value: unknown): void => {
    if (value === null || value === undefined) return;
    if (typeof value === "number") {
      out.push(value);
      return;
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed || /^[=<>!\s&|]+$/.test(trimmed) || /^(and|or)$/i.test(trimmed)) return;
      out.push(value);
      return;
    }
    if (typeof value !== "object") return;
    if (seen.has(value as object)) return;
    seen.add(value as object);
    const rec = value as Record<string, unknown>;
    // drizzle Column: carries name/table; never a predicate value.
    if ("name" in rec && "table" in rec) return;
    // drizzle StringChunk: SQL syntax container.
    if (Array.isArray(rec.value) && !("queryChunks" in rec)) return;
    if ("queryChunks" in rec) {
      for (const chunk of rec.queryChunks as unknown[]) walk(chunk);
      return;
    }
    for (const nested of Object.values(rec)) walk(nested);
  };
  for (const cond of conds) walk(cond);
  return out;
}

describe("acceptInterpretation", () => {
  it("accepts a new record (replayed: false) and persists identity + canonical record", async () => {
    const { db, state } = createFakeExecutor();
    const record = makeRecord();

    const result = await acceptInterpretation(record, db);

    expect(result.replayed).toBe(false);
    expect(result.record).toEqual(record);
    expect(state.inserts).toHaveLength(1);
    const row = state.rows[0];
    expect(row.interpretationId).toBe(record.interpretationId);
    expect(row.modelOrRuleSource).toBe("RULE");
    expect(row.billingIdentity).toBeNull();
    expect(row.record).toEqual(record);
  });

  it("replays an identical re-presented record without a second insert", async () => {
    const { db, state } = createFakeExecutor();
    const record = makeRecord();

    const first = await acceptInterpretation(record, db);
    const second = await acceptInterpretation(record, db);

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.record).toEqual(record);
    expect(state.inserts).toHaveLength(1);
  });

  it("fails closed with InterpretationTamperError on colliding natural key with different content", async () => {
    const original = makeRecord();
    const { db, state } = createFakeExecutor();
    await acceptInterpretation(original, db);

    const tampered = makeRecord({
      signalContentHash: "f".repeat(64),
      interpretationId: computeInterpretationId({
        schemaVersion: SOCIAL_INTELLIGENCE_SCHEMA_VERSION,
        businessId: 3,
        signalId: "sig-store-1",
        signalVersion: 1,
        signalContentHash: "f".repeat(64),
        classifierVersion: CLASSIFIER,
      }),
    });

    try {
      await acceptInterpretation(tampered, db);
      expect.unreachable("expected tamper rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(InterpretationTamperError);
      expect((error as InterpretationTamperError).code).toBe("SIGNAL_CONTENT_HASH_MISMATCH");
    }
    // Existing durable row is untouched.
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0].signalContentHash).toBe(original.signalContentHash);
  });

  it("accepts the same signalId under a different businessId as an independent row", async () => {
    const { db, state } = createFakeExecutor();
    const a = makeRecord();
    const b = makeRecord({ businessId: 4, userId: 8 });

    await acceptInterpretation(a, db);
    const second = await acceptInterpretation(b, db);

    expect(second.replayed).toBe(false);
    expect(state.rows).toHaveLength(2);
  });

  it("accepts a new signalVersion for the same signalId as a new row", async () => {
    const { db, state } = createFakeExecutor();
    await acceptInterpretation(makeRecord(), db);
    const next = await acceptInterpretation(makeRecord({ signalVersion: 2 }), db);

    expect(next.replayed).toBe(false);
    expect(state.rows.map((r) => r.signalVersion)).toEqual([1, 2]);
  });

  it("stores the MODEL-path billing identity on the row", async () => {
    const { db, state } = createFakeExecutor();
    const record = makeRecord({ source: "MODEL" });
    const billingIdentity = buildInterpretationBillingIdentity({
      businessId: record.businessId,
      signalId: record.signalId,
      signalVersion: record.signalVersion,
      signalContentHash: record.signalContentHash,
      classifierVersion: CLASSIFIER,
    });
    const withBilling = { ...record, billingIdentity };

    await acceptInterpretation(withBilling, db);
    expect(state.rows[0].billingIdentity).toBe(billingIdentity);
  });

  it("rejects structurally invalid records before any insert", async () => {
    const { db, state } = createFakeExecutor();
    const invalid = { ...makeRecord(), intent: "buy_everything" } as unknown as SocialInterpretation;
    await expect(acceptInterpretation(invalid, db)).rejects.toThrow();
    expect(state.inserts).toHaveLength(0);
  });
});

describe("read paths", () => {
  it("getInterpretationById returns the raw row or null", async () => {
    const record = makeRecord();
    const { db } = createFakeExecutor([toRow(record)]);

    const found = await store.getInterpretationById(record.interpretationId, db);
    expect(found?.interpretationId).toBe(record.interpretationId);
    expect(await store.getInterpretationById("nope", db)).toBeNull();
  });

  it("listInterpretationsForSignal orders by signalVersion then classifierVersion", async () => {
    const v1 = makeRecord();
    const v2 = makeRecord({ signalVersion: 2 });
    const { db } = createFakeExecutor([toRow(v2), toRow(v1)]);

    const rows = await store.listInterpretationsForSignal(3, "sig-store-1", db);
    expect(rows.map((r) => r.signalVersion)).toEqual([1, 2]);
  });
});

describe("immutability surface", () => {
  it("exports no update or delete path", () => {
    const mutating = Object.keys(store).filter(
      (key) => typeof (store as Record<string, unknown>)[key] === "function" &&
        /update|delete|remove/i.test(key)
    );
    expect(mutating).toEqual([]);
  });
});

function toRow(record: SocialInterpretation) {
  return {
    id: 501,
    userId: record.userId,
    businessId: record.businessId,
    signalId: record.signalId,
    signalVersion: record.signalVersion,
    signalContentHash: record.signalContentHash,
    classifierVersion: record.classifierVersion,
    interpretationId: record.interpretationId,
    modelOrRuleSource: record.source,
    intent: record.intent,
    sentiment: record.sentiment,
    urgency: record.urgency,
    relevance: record.relevance,
    overallConfidence: record.overallConfidence,
    recommendedHandling: record.recommendedHandling,
    billingIdentity: record.billingIdentity,
    record: record as unknown as Record<string, unknown>,
    createdAt: new Date(record.createdAt),
  };
}
