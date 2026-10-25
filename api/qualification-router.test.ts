// ─── R6-C qualification router — caller-level tests ───
//
// The bridge provider is a scripted fake (the real bridge is slice-3 glue,
// covered in qualification-bridge.test.ts); the store/audit tables run on an
// in-memory drizzle-SQL-evaluating fake through the REAL
// bindQualificationStoreExecutor, so every predicate translation and
// convergence anchor is exercised end to end.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { getDb } from "./queries/connection";
import { qualificationRouter } from "./qualification-router";
import { createQualificationBridgeProvider } from "./lib/qualification/qualification-bridge";
import {
  ProviderLeadNotFound,
  ProviderScoreNotFound,
} from "./lib/qualification/qualification-service";
import { deriveScoreContentHash } from "./lib/qualification/qualification-contract";
import { QUALIFICATION_HANDOFF_PROJECTION_KEYS } from "./lib/qualification/qualification-handoff";
import { buildCtx } from "./r5-test-support";

vi.mock("./queries/connection", () => ({
  getDb: vi.fn(),
}));

vi.mock("./lib/qualification/qualification-bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/qualification/qualification-bridge")>();
  return {
    ...actual,
    createQualificationBridgeProvider: vi.fn(),
  };
});

const H64 = "ab".repeat(32);
const G64 = "cd".repeat(32);
const LEAD_ID = `lid1:${H64}`;
const OTHER_LEAD_ID = `lid1:${G64}`;
const SCORE_ID = `lsc1:${H64}`;
const OPP_ID = `opp1:${"ef".repeat(32)}`;
const HANDOFF_ID = `oph1:${"12".repeat(32)}`;
const USER_ID = 7;
const BUSINESS_ID = 3;
// The router path has no injected clock (wall time by design), so the fake
// timers pin the evaluation instant — this also keeps replay derivations
// byte-identical across the two evaluate calls.
const NOW_ISO = "2026-10-25T12:00:00.000Z";
const NOW = new Date(NOW_ISO);
const HOUR_MS = 60 * 60 * 1000;
const FRESH_ISO = new Date(NOW.getTime() - HOUR_MS).toISOString();
const FIRST_OBSERVED_ISO = new Date(NOW.getTime() - 8 * 24 * HOUR_MS).toISOString();

type Row = Record<string, unknown>;

// ─── Scripted fake provider ───

function makeFakeProvider() {
  const identities = new Map<string, unknown>();
  const scores = new Map<string, unknown>();
  const privacy = new Map<string, unknown>();
  return {
    identities,
    scores,
    privacy,
    async getIdentityProjection(leadId: string): Promise<unknown> {
      if (!identities.has(leadId)) throw new ProviderLeadNotFound(leadId);
      return identities.get(leadId);
    },
    async getScorePayload(leadScoreId: string): Promise<unknown> {
      if (!scores.has(leadScoreId)) throw new ProviderScoreNotFound(leadScoreId);
      return scores.get(leadScoreId);
    },
    async getPrivacyState(leadId: string): Promise<unknown> {
      return privacy.has(leadId) ? privacy.get(leadId) : null;
    },
  };
}

// ─── Fixtures ───

function identityProjection(overrides: Row = {}): Row {
  return {
    leadId: LEAD_ID,
    businessId: BUSINESS_ID,
    leadIdentityVersion: "lead-identity/v1",
    identityStatus: "active",
    identityConfidence: "high",
    primaryIdentityType: "provider_actor",
    externalActorReferenceHash: null,
    provider: "meta",
    sourceOpportunityId: OPP_ID,
    sourceHandoffId: HANDOFF_ID,
    canonicalLeadId: null,
    firstObservedAt: FIRST_OBSERVED_ISO,
    lastObservedAt: FRESH_ISO,
    provenance: [
      {
        kind: "opportunity_handoff",
        handoffId: HANDOFF_ID,
        opportunityId: OPP_ID,
        evidenceType: "handoff",
        occurredAt: FIRST_OBSERVED_ISO,
      },
    ],
    ...overrides,
  };
}

function scorePayload(overrides: Row = {}): Row {
  const base: Row = {
    leadScoreId: SCORE_ID,
    leadId: LEAD_ID,
    leadIdentityVersion: "lead-identity/v1",
    scoringVersion: "lead-scoring-engine/v1",
    featureVersion: "lead-scoring-features/v1",
    scoreContractVersion: "lead-scoring/v1",
    evidenceSnapshotId: `lss1:${G64}`,
    evidenceSnapshotHash: G64,
    overallScore: 75,
    scoreBand: "HIGH",
    scoreConfidence: "HIGH",
    fitScore: 60,
    intentScore: 60,
    engagementScore: 10,
    recencyScore: 80,
    opportunityScore: 20,
    componentWeights: { fit: 0.2, intent: 0.2, engagement: 0.2, recency: 0.2, opportunity: 0.2 },
    reasonCodes: ["CAMPAIGN_ALIGNED", "RECENT_EVIDENCE"],
    evidenceFreshness: { latestObservedAt: FRESH_ISO, computedAt: NOW_ISO },
    computedAt: NOW_ISO,
    createdAt: NOW_ISO,
    businessId: BUSINESS_ID,
    userId: USER_ID,
    duplicateClassification: "none",
  };
  const merged = { ...base, ...overrides };
  if (!("scoreContentHash" in overrides)) {
    merged.scoreContentHash = deriveScoreContentHash({
      leadScoreId: merged.leadScoreId as string,
      scoringVersion: merged.scoringVersion as string,
      featureVersion: merged.featureVersion as string,
      scoreContractVersion: merged.scoreContractVersion as string,
      leadIdentityVersion: merged.leadIdentityVersion as string,
      leadId: merged.leadId as string,
      businessId: merged.businessId as number | null,
      overallScore: merged.overallScore as number,
      scoreBand: merged.scoreBand as string,
      scoreConfidence: merged.scoreConfidence as string,
      fitScore: merged.fitScore as number,
      intentScore: merged.intentScore as number,
      engagementScore: merged.engagementScore as number,
      recencyScore: merged.recencyScore as number,
      opportunityScore: merged.opportunityScore as number,
      reasonCodes: [...(merged.reasonCodes as string[])].sort(),
      evidenceSnapshotHash: merged.evidenceSnapshotHash as string,
      evidenceFreshness: merged.evidenceFreshness as {
        latestObservedAt: string | null;
        computedAt: string;
      },
    });
  }
  return merged;
}

// ─── In-memory drizzle-SQL-evaluating fake db ───

function evalCond(cond: any, row: Row): boolean {
  let field: string | null = null;
  let ok = true;
  const chunks: any[] = cond?.queryChunks ?? [];
  for (const chunk of chunks) {
    if (chunk === null || chunk === undefined) continue;
    if (Array.isArray(chunk?.queryChunks)) {
      if (!evalCond(chunk, row)) ok = false;
      continue;
    }
    if (typeof chunk === "object") {
      if (typeof chunk.name === "string" && chunk.table) {
        field = chunk.name;
        continue;
      }
      if (
        ["string", "number", "boolean"].includes(typeof chunk.value) &&
        !Array.isArray(chunk.value)
      ) {
        if (row[field ?? ""] !== chunk.value) ok = false;
        field = null;
        continue;
      }
      continue;
    }
    if (["string", "number", "boolean"].includes(typeof chunk)) {
      if (row[field ?? ""] !== chunk) ok = false;
      field = null;
    }
  }
  return ok;
}

function parseOrderTerm(term: any): { field: string; direction: "asc" | "desc" } {
  const chunks: any[] = term?.queryChunks ?? [];
  const column = chunks.find((c) => c && typeof c === "object" && typeof c.name === "string");
  const text = chunks
    .filter((c) => c && Array.isArray(c.value))
    .map((c) => c.value.join(" "))
    .join(" ");
  return { field: column?.name ?? "", direction: /\bdesc\b/i.test(text) ? "desc" : "asc" };
}

function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  const av = a instanceof Date ? a.getTime() : a;
  const bv = b instanceof Date ? b.getTime() : b;
  return av < bv ? -1 : 1;
}

function tableNameOf(table: unknown): string {
  return (
    (table as Record<symbol, string>)[Symbol.for("drizzle:Name")] ??
    (table as { tableName?: string }).tableName ??
    "unknown"
  );
}

function makeFakeDb() {
  const seed: Record<string, Row[]> = {
    lead_qualifications: [],
    lead_qualification_reviews: [],
    audit_events: [],
  };
  const duplicateKeyError = () =>
    Object.assign(new Error("Duplicate entry"), { code: "ER_DUP_ENTRY", errno: 1062 });
  const db = {
    seed,
    select: () => ({
      from: (table: unknown) => {
        const name = tableNameOf(table);
        let rows = [...(seed[name] ?? [])];
        const chain: any = {
          where: (cond: any) => {
            rows = rows.filter((row) => evalCond(cond, row));
            return chain;
          },
          orderBy: (...terms: any[]) => {
            const parsed = terms.map(parseOrderTerm);
            rows = [...rows].sort((a, b) => {
              for (const term of parsed) {
                const cmp = compareValues(a[term.field], b[term.field]);
                if (cmp !== 0) return term.direction === "asc" ? cmp : -cmp;
              }
              return 0;
            });
            return chain;
          },
          limit: (n: number) => Promise.resolve(rows.slice(0, n).map((r) => ({ ...r }))),
          then: (onF: any, onR: any) => Promise.resolve(rows.map((r) => ({ ...r }))).then(onF, onR),
        };
        return chain;
      },
    }),
    insert: (table: unknown) => ({
      values: async (row: Row) => {
        const name = tableNameOf(table);
        const rows = (seed[name] ??= []);
        if (name === "lead_qualifications") {
          if (rows.some((r) => r.userId === row.userId && r.qualificationId === row.qualificationId)) {
            throw duplicateKeyError();
          }
        }
        if (name === "lead_qualification_reviews") {
          if (
            rows.some((r) => r.userId === row.userId && r.reviewId === row.reviewId) ||
            rows.some((r) => r.userId === row.userId && r.qualificationId === row.qualificationId)
          ) {
            throw duplicateKeyError();
          }
        }
        if (name === "audit_events") {
          if (rows.some((r) => r.eventFingerprint === row.eventFingerprint)) {
            throw duplicateKeyError();
          }
        }
        rows.push({ ...row });
        return [{ affectedRows: 1 }];
      },
    }),
    update: (table: unknown) => ({
      set: (patch: Row) => ({
        where: async (cond: any) => {
          const rows = seed[tableNameOf(table)] ?? [];
          let affected = 0;
          for (const row of rows) {
            if (evalCond(cond, row)) {
              Object.assign(row, patch);
              affected += 1;
            }
          }
          return { affectedRows: affected };
        },
      }),
    }),
    transaction: async (fn: (tx: unknown) => unknown) => fn(db),
  };
  return db;
}

// ─── Test harness ───

let fakeDb: ReturnType<typeof makeFakeDb>;
let provider: ReturnType<typeof makeFakeProvider>;

function seedProvider(identityOverrides: Row = {}, scoreOverrides: Row = {}) {
  provider.identities.set(LEAD_ID, identityProjection(identityOverrides));
  provider.scores.set(SCORE_ID, scorePayload(scoreOverrides));
}

function callerFor(user: Record<string, unknown> | null) {
  return qualificationRouter.createCaller(buildCtx(user));
}

const evaluateInput = { leadId: LEAD_ID, leadScoreId: SCORE_ID };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  fakeDb = makeFakeDb();
  provider = makeFakeProvider();
  vi.mocked(getDb).mockReturnValue(fakeDb as never);
  vi.mocked(createQualificationBridgeProvider).mockReturnValue(provider as never);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("qualificationRouter — auth boundary", () => {
  it("rejects an unauthenticated caller with UNAUTHORIZED", async () => {
    const caller = callerFor(null);
    await expect(caller.evaluate(evaluateInput)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(caller.getPolicy()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

describe("qualificationRouter — evaluate", () => {
  it("evaluates a lead to QUALIFIED and persists exactly one decision + audit event", async () => {
    seedProvider();
    const caller = callerFor({ id: USER_ID, role: "user" });

    const result = await caller.evaluate(evaluateInput);
    expect(result.duplicateClassification).toBe("none");
    expect(result.qualification.decision).toBe("QUALIFIED");
    expect(result.qualification.userId).toBe(USER_ID);
    expect(result.qualification.qualificationId).toMatch(/^lqu1:[a-f0-9]{64}$/);

    expect(fakeDb.seed.lead_qualifications).toHaveLength(1);
    expect(fakeDb.seed.audit_events).toHaveLength(1);
    expect(fakeDb.seed.audit_events[0].eventType).toBe("lead_qualification_evaluated");
  });

  it("rejects unknown input fields (no client-supplied authority, contract §14.3)", async () => {
    seedProvider();
    const caller = callerFor({ id: USER_ID, role: "user" });
    await expect(
      caller.evaluate({ ...evaluateInput, decision: "QUALIFIED" } as never)
    ).rejects.toMatchObject({ code: "BAD_REQUEST", cause: { name: "ZodError" } });
    expect(fakeDb.seed.lead_qualifications).toHaveLength(0);
    expect(fakeDb.seed.audit_events).toHaveLength(0);
  });

  it("replays converge to the durable decision (idempotent_replay, zero extra audit)", async () => {
    seedProvider();
    const caller = callerFor({ id: USER_ID, role: "user" });

    const first = await caller.evaluate(evaluateInput);
    const second = await caller.evaluate(evaluateInput);
    expect(second.duplicateClassification).toBe("idempotent_replay");
    expect(second.qualification.qualificationId).toBe(first.qualification.qualificationId);

    expect(fakeDb.seed.lead_qualifications).toHaveLength(1);
    expect(fakeDb.seed.audit_events).toHaveLength(1);
  });

  it("maps OWNERSHIP_MISMATCH to FORBIDDEN", async () => {
    seedProvider();
    const caller = callerFor({ id: USER_ID, role: "user" });
    await expect(
      caller.evaluate({ ...evaluateInput, businessId: 999 })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("maps a forged leadId to NOT_FOUND (indistinguishable from absent)", async () => {
    provider.scores.set(SCORE_ID, scorePayload());
    const caller = callerFor({ id: USER_ID, role: "user" });
    await expect(
      caller.evaluate({ leadId: OTHER_LEAD_ID, leadScoreId: SCORE_ID })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("qualificationRouter — reads", () => {
  it("get / listHistory return the durable decision rows for the tenant", async () => {
    seedProvider();
    const caller = callerFor({ id: USER_ID, role: "user" });
    const { qualification } = await caller.evaluate(evaluateInput);

    const fetched = await caller.get({ qualificationId: qualification.qualificationId });
    expect(fetched.qualificationId).toBe(qualification.qualificationId);

    const history = await caller.listHistory({ leadId: LEAD_ID });
    expect(history.map((row) => row.qualificationId)).toEqual([qualification.qualificationId]);

    await expect(caller.get({ qualificationId: qualification.qualificationId })).resolves.toBeDefined();
    const otherTenant = qualificationRouter.createCaller(buildCtx({ id: 99, role: "user" }));
    await expect(
      otherTenant.get({ qualificationId: qualification.qualificationId })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("getPolicy exposes the conservative default + registered versions", async () => {
    const caller = callerFor({ id: USER_ID, role: "user" });
    const result = await caller.getPolicy();
    expect(result.policy.policyVersion).toBe("lead-qualification-policy/v1");
    expect(result.availableVersions.map((p) => p.policyVersion)).toContain(
      "lead-qualification-policy/v1"
    );
  });
});

describe("qualificationRouter — handoff projection", () => {
  it("returns the exact closed projection key set for a fresh QUALIFIED decision", async () => {
    seedProvider();
    const caller = callerFor({ id: USER_ID, role: "user" });
    const { qualification } = await caller.evaluate(evaluateInput);

    const projection = await caller.getHandoffProjection({
      qualificationId: qualification.qualificationId,
    });
    expect(Object.keys(projection).sort()).toEqual([...QUALIFICATION_HANDOFF_PROJECTION_KEYS].sort());
    expect(projection).toMatchObject({
      qualificationId: qualification.qualificationId,
      decision: "QUALIFIED",
      mayProgress: true,
      progressBlockedReason: null,
      privacy: { state: "ACTIVE", actionable: true },
      review: null,
    });
  });

  it("review lifecycle end-to-end: REVIEW_REQUIRED blocks until governed resolution authorizes", async () => {
    seedProvider({}, { reasonCodes: ["CONTRADICTING_EVIDENCE"] });
    const caller = callerFor({ id: USER_ID, role: "user" });
    const { qualification } = await caller.evaluate(evaluateInput);
    expect(qualification.decision).toBe("REVIEW_REQUIRED");

    const pending = await caller.getHandoffProjection({
      qualificationId: qualification.qualificationId,
    });
    expect(pending.mayProgress).toBe(false);

    const reviews = await caller.listReviews({ leadId: LEAD_ID, status: "pending" });
    expect(reviews).toHaveLength(1);
    const review = reviews[0];
    expect(review.qualificationId).toBe(qualification.qualificationId);

    const resolved = await caller.resolveReview({
      reviewId: review.reviewId,
      outcome: "progress_authorized",
      reason: "verified by ops",
    });
    expect(resolved.status).toBe("progress_authorized");
    expect(resolved.version).toBe(2);

    // The audit ledger carries exactly the evaluation + the resolution.
    expect(fakeDb.seed.audit_events.map((row) => row.eventType)).toEqual([
      "lead_qualification_evaluated",
      "lead_qualification_review_resolved",
    ]);

    const authorized = await caller.getHandoffProjection({
      qualificationId: qualification.qualificationId,
    });
    expect(authorized.mayProgress).toBe(true);
    expect(authorized.review).toMatchObject({
      reviewId: review.reviewId,
      status: "progress_authorized",
      outcome: "progress_authorized",
    });

    // A second resolution conflicts; the durable review is untouched.
    await expect(
      caller.resolveReview({
        reviewId: review.reviewId,
        outcome: "progression_rejected",
        reason: "too late",
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
