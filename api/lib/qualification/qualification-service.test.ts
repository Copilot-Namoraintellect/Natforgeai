import { describe, expect, it } from "vitest";
import { auditEvents } from "@db/schema";
import { buildAuditEventFingerprint, createAuditEvent } from "../audit/audit-event";
import {
  DEFAULT_QUALIFICATION_POLICY,
  registerQualificationPolicy,
} from "./qualification-policy";
import {
  evaluateQualificationForLead,
  getHandoffProjectionForUser,
  getQualificationHistory,
  listQualificationReviews,
  ProviderLeadNotFound,
  ProviderScoreNotFound,
  resolveQualificationReview,
  type QualificationAuthorityProvider,
} from "./qualification-service";
import {
  type QualificationStoreExecutor,
  type StoreOrderTerm,
  type StorePredicate,
} from "./qualification-store";
import { deriveScoreContentHash } from "./qualification-contract";

const H64 = "ab".repeat(32);
const G64 = "cd".repeat(32);
const LEAD_ID = `lid1:${H64}`;
const OTHER_LEAD_ID = `lid1:${G64}`;
const SCORE_ID = `lsc1:${H64}`;
const OTHER_SCORE_ID = `lsc1:${G64}`;
const OPP_ID = `opp1:${"ef".repeat(32)}`;
const HANDOFF_ID = `oph1:${"12".repeat(32)}`;
const USER_ID = 7;
const BUSINESS_ID = 3;
const NOW_ISO = "2026-06-28T12:00:00.000Z";
const NOW = new Date(NOW_ISO);
const HOUR_MS = 60 * 60 * 1000;
const FRESH_ISO = new Date(NOW.getTime() - HOUR_MS).toISOString();
const STALE_ISO = new Date(NOW.getTime() - 337 * HOUR_MS).toISOString();

// ─── Fixtures ───

function identityProjection(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
    firstObservedAt: "2026-06-20T10:00:00.000Z",
    lastObservedAt: FRESH_ISO,
    provenance: [
      {
        kind: "opportunity_handoff",
        handoffId: HANDOFF_ID,
        opportunityId: OPP_ID,
        evidenceType: "handoff",
        occurredAt: "2026-06-20T10:00:00.000Z",
      },
    ],
    ...overrides,
  };
}

function baseScore(leadId = LEAD_ID): Record<string, unknown> {
  return {
    leadScoreId: SCORE_ID,
    leadId,
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
}

function withContentHash(payload: Record<string, unknown>): Record<string, unknown> {
  return {
    ...payload,
    scoreContentHash: deriveScoreContentHash({
      leadScoreId: payload.leadScoreId as string,
      scoringVersion: payload.scoringVersion as string,
      featureVersion: payload.featureVersion as string,
      scoreContractVersion: payload.scoreContractVersion as string,
      leadIdentityVersion: payload.leadIdentityVersion as string,
      leadId: payload.leadId as string,
      businessId: payload.businessId as number | null,
      overallScore: payload.overallScore as number,
      scoreBand: payload.scoreBand as string,
      scoreConfidence: payload.scoreConfidence as string,
      fitScore: payload.fitScore as number,
      intentScore: payload.intentScore as number,
      engagementScore: payload.engagementScore as number,
      recencyScore: payload.recencyScore as number,
      opportunityScore: payload.opportunityScore as number,
      reasonCodes: [...(payload.reasonCodes as string[])].sort(),
      evidenceSnapshotHash: payload.evidenceSnapshotHash as string,
      evidenceFreshness: payload.evidenceFreshness as {
        latestObservedAt: string | null;
        computedAt: string;
      },
    }),
  };
}

function scorePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const merged = { ...baseScore(), ...overrides };
  return "scoreContentHash" in overrides ? merged : withContentHash(merged);
}

// ─── Fake provider ───

class FakeProvider implements QualificationAuthorityProvider {
  readonly identities = new Map<string, unknown>();
  readonly scores = new Map<string, unknown>();
  readonly privacy = new Map<string, unknown>();

  async getIdentityProjection(leadId: string): Promise<unknown> {
    if (!this.identities.has(leadId)) throw new ProviderLeadNotFound(leadId);
    return this.identities.get(leadId);
  }

  async getScorePayload(leadScoreId: string): Promise<unknown> {
    if (!this.scores.has(leadScoreId)) throw new ProviderScoreNotFound(leadScoreId);
    return this.scores.get(leadScoreId);
  }

  async getPrivacyState(leadId: string): Promise<unknown> {
    return this.privacy.has(leadId) ? this.privacy.get(leadId) : null;
  }
}

function makeProvider(identityOverrides: Record<string, unknown> = {}, scoreOverrides: Record<string, unknown> = {}) {
  const provider = new FakeProvider();
  provider.identities.set(LEAD_ID, identityProjection(identityOverrides));
  provider.scores.set(SCORE_ID, scorePayload(scoreOverrides));
  return provider;
}

const deps = (provider: QualificationAuthorityProvider) => ({ provider, now: () => new Date(NOW) });

// ─── Fake executor (R6-C tables + audit_events ledger) ───

type Row = Record<string, unknown>;

interface FakeDbState {
  qualifications: Row[];
  reviews: Row[];
  auditRows: Row[];
  insertAttempts: number;
  insertedAudit: Row[];
  auditInsertAttempts: number;
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

function isStorePredicate(value: unknown): value is StorePredicate {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    ((value as { kind: unknown }).kind === "eq" || (value as { kind: unknown }).kind === "and")
  );
}

function evaluatePredicate(row: Row, predicate: StorePredicate): boolean {
  if (predicate.kind === "eq") return row[predicate.field] === predicate.value;
  return predicate.conditions.every((condition) => evaluatePredicate(row, condition));
}

function isSqlLike(value: unknown): value is { queryChunks: unknown[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { queryChunks?: unknown }).queryChunks)
  );
}

function isColumnLike(value: unknown): value is { name: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { name?: unknown }).name === "string"
  );
}

/** Extracts `field = value` pairs from a Drizzle SQL predicate's chunks. */
function extractEqConditions(cond: unknown): { field: string; value: unknown }[] {
  const out: { field: string; value: unknown }[] = [];
  const unwrap = (candidate: unknown): { ok: boolean; value: unknown } => {
    if (candidate === null || ["string", "number", "boolean"].includes(typeof candidate)) {
      return { ok: true, value: candidate };
    }
    // Drizzle wraps bind params: Param { value: <primitive> }.
    if (
      typeof candidate === "object" &&
      candidate !== null &&
      "value" in candidate &&
      !Array.isArray((candidate as { value: unknown }).value) &&
      ["string", "number", "boolean"].includes(typeof (candidate as { value: unknown }).value)
    ) {
      return { ok: true, value: (candidate as { value: unknown }).value };
    }
    return { ok: false, value: undefined };
  };
  const walk = (node: unknown): void => {
    if (!isSqlLike(node)) return;
    const chunks = node.queryChunks;
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (isSqlLike(chunk)) {
        walk(chunk);
        continue;
      }
      if (isColumnLike(chunk)) {
        for (let j = i + 1; j < chunks.length && j <= i + 3; j++) {
          const candidate = chunks[j];
          if (isColumnLike(candidate) || isSqlLike(candidate)) break;
          const unwrapped = unwrap(candidate);
          if (unwrapped.ok) {
            out.push({ field: chunk.name, value: unwrapped.value });
            break;
          }
        }
      }
    }
  };
  walk(cond);
  return out;
}

function tableNameOf(table: unknown): string {
  return (
    (table as Record<symbol, string>)[Symbol.for("drizzle:Name")] ??
    (table as { tableName?: string }).tableName ??
    "unknown"
  );
}

function evaluateWhere(row: Row, cond: unknown): boolean {
  if (isStorePredicate(cond)) return evaluatePredicate(row, cond);
  const conditions = extractEqConditions(cond);
  return conditions.every((condition) => row[condition.field] === condition.value);
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

let nextAuditId = 1;

function makeFakeDb(): { executor: QualificationStoreExecutor; state: FakeDbState } {
  const state: FakeDbState = {
    qualifications: [],
    reviews: [],
    auditRows: [],
    insertAttempts: 0,
    insertedAudit: [],
    auditInsertAttempts: 0,
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
    where: (cond: unknown) => buildQuery(rows.filter((row) => evaluateWhere(row, cond))),
    orderBy: (...terms: StoreOrderTerm[]) => buildQuery([...rows].sort((a, b) => compareRows(a, b, terms))),
    all: async () => rows.map((row) => ({ ...row })),
    limit: async (n: number) => rows.slice(0, n).map((row) => ({ ...row })),
  });

  const executor: QualificationStoreExecutor = {
    select: () => ({
      from: (table) => {
        if ((table as unknown) === auditEvents) return targetFor(state.auditRows);
        if (tableNameOf(table) === "lead_qualifications") return targetFor(state.qualifications);
        return targetFor(state.reviews);
      },
    }),
    insert: (table) => ({
      values: async (row: Row) => {
        if ((table as unknown) === auditEvents) {
          state.auditInsertAttempts += 1;
          if (state.auditRows.some((existing) => existing.eventFingerprint === row.eventFingerprint)) {
            throw makeDuplicateKeyError();
          }
          state.auditRows.push({ id: nextAuditId++, createdAt: new Date(NOW_ISO), ...row });
          state.insertedAudit.push({ ...row });
          return [{ affectedRows: 1 }];
        }
        state.insertAttempts += 1;
        if (tableNameOf(table) === "lead_qualifications") {
          if (
            state.qualifications.some(
              (existing) => existing.userId === row.userId && existing.qualificationId === row.qualificationId
            )
          ) {
            throw makeDuplicateKeyError();
          }
          state.qualifications.push({ ...row });
          return [{ affectedRows: 1 }];
        }
        if (
          state.reviews.some((existing) => existing.userId === row.userId && existing.reviewId === row.reviewId) ||
          state.reviews.some(
            (existing) => existing.userId === row.userId && existing.qualificationId === row.qualificationId
          )
        ) {
          throw makeDuplicateKeyError();
        }
        state.reviews.push({ ...row });
        return [{ affectedRows: 1 }];
      },
    }),
    update: (table) => ({
      set: (patch: Row) => ({
        where: async (cond: unknown) => {
          const rows =
            (table as unknown) === auditEvents
              ? state.auditRows
              : tableNameOf(table) === "lead_qualifications"
                ? state.qualifications
                : state.reviews;
          let affected = 0;
          for (const row of rows) {
            if (evaluateWhere(row, cond)) {
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

const evaluateInput = (overrides: Record<string, unknown> = {}) => ({
  userId: USER_ID,
  leadId: LEAD_ID,
  leadScoreId: SCORE_ID,
  ...overrides,
});

// ─── Tests ───

describe("evaluateQualificationForLead — happy path", () => {
  it("persists a QUALIFIED decision and emits exactly one audit event", async () => {
    const provider = makeProvider();
    const { executor, state } = makeFakeDb();

    const result = await evaluateQualificationForLead(evaluateInput(), deps(provider), executor);

    expect(result.duplicateClassification).toBe("none");
    const q = result.qualification;
    expect(q.qualificationId).toMatch(/^lqu1:[a-f0-9]{64}$/);
    expect(q.decision).toBe("QUALIFIED");
    expect(q.reviewRequired).toBe(false);
    expect(q.confidenceScore).toBe(10000);
    expect(q.userId).toBe(USER_ID);
    expect(q.businessId).toBe(BUSINESS_ID);
    expect(q.leadId).toBe(LEAD_ID);
    expect(q.reasonCodes).toContain("POLICY_REQUIREMENTS_MET");
    expect(q.validUntil).toBe(new Date(NOW.getTime() + DEFAULT_QUALIFICATION_POLICY.validityMs).toISOString());
    expect(Object.isFrozen(q)).toBe(true);

    expect(state.qualifications).toHaveLength(1);
    expect(state.reviews).toHaveLength(0);
    expect(state.insertedAudit).toHaveLength(1);
    const event = state.insertedAudit[0];
    expect(event.eventType).toBe("lead_qualification_evaluated");
    expect(event.userId).toBe(USER_ID);
    expect(event.businessId).toBe(BUSINESS_ID);
    expect(event.source).toBe("system");
    expect(event.occurredAt).toBe(NOW_ISO);
    expect(event.metadata).toMatchObject({
      qualificationId: q.qualificationId,
      leadId: LEAD_ID,
      decision: "QUALIFIED",
      reviewRequired: false,
      qualificationPolicyVersion: "lead-qualification-policy/v1",
      engineVersion: "lead-qualification-engine/v1",
    });
  });

  it("is deterministic: identical inputs reproduce the same qualificationId", async () => {
    const provider = makeProvider();
    const first = await evaluateQualificationForLead(evaluateInput(), deps(provider), makeFakeDb().executor);
    const second = await evaluateQualificationForLead(evaluateInput(), deps(provider), makeFakeDb().executor);
    expect(first.qualification.qualificationId).toBe(second.qualification.qualificationId);
    expect(first.qualification).toEqual(second.qualification);
  });
});

describe("evaluateQualificationForLead — replay convergence", () => {
  it("a replay re-reads the durable row, inserts nothing, and emits zero audit", async () => {
    const provider = makeProvider();
    const { executor, state } = makeFakeDb();
    const first = await evaluateQualificationForLead(evaluateInput(), deps(provider), executor);
    const second = await evaluateQualificationForLead(evaluateInput(), deps(provider), executor);

    expect(second.duplicateClassification).toBe("idempotent_replay");
    expect(second.qualification).toMatchObject({
      qualificationId: first.qualification.qualificationId,
      decision: "QUALIFIED",
    });
    expect(state.qualifications).toHaveLength(1);
    expect(state.reviews).toHaveLength(0);
    expect(state.insertedAudit).toHaveLength(1);
  });

  it("fails closed when the stored row diverges from the recomputed decision", async () => {
    const provider = makeProvider();
    const { executor, state } = makeFakeDb();
    await evaluateQualificationForLead(evaluateInput(), deps(provider), executor);
    // Tamper with the durable row under the same convergence anchor.
    const stored = state.qualifications[0];
    stored.decision = "NOT_QUALIFIED";
    stored.reasonCodes = ["SCORE_BELOW_THRESHOLD"];

    await expect(
      evaluateQualificationForLead(evaluateInput(), deps(provider), executor)
    ).rejects.toMatchObject({
      name: "QualificationTamperError",
      code: "QUALIFICATION_REPLAY_CONFLICT",
    });
    expect(state.insertedAudit).toHaveLength(1); // no second audit on the failed replay
  });
});

describe("evaluateQualificationForLead — review path", () => {
  it("creates a pending review bound to the decision", async () => {
    const provider = makeProvider({}, { reasonCodes: ["CONTRADICTING_EVIDENCE"] });
    const { executor, state } = makeFakeDb();

    const result = await evaluateQualificationForLead(evaluateInput(), deps(provider), executor);
    expect(result.qualification.decision).toBe("REVIEW_REQUIRED");
    expect(result.qualification.reviewRequired).toBe(true);

    expect(state.reviews).toHaveLength(1);
    const review = state.reviews[0];
    expect(review.status).toBe("pending");
    expect(review.version).toBe(1);
    expect(review.qualificationId).toBe(result.qualification.qualificationId);
    expect(review.triggerReasonCodes).toEqual(["REVIEW_TRIGGERED_BY_POLICY", "CONTRADICTING_EVIDENCE"]);
    expect(state.insertedAudit).toHaveLength(1);
    expect(state.insertedAudit[0].eventType).toBe("lead_qualification_evaluated");

    const listed = await listQualificationReviews({ userId: USER_ID, leadId: LEAD_ID }, executor);
    expect(listed.map((row) => row.reviewId)).toEqual([review.reviewId]);
  });

  it("a replayed REVIEW_REQUIRED evaluation converges without a second review or audit", async () => {
    const provider = makeProvider({}, { reasonCodes: ["CONTRADICTING_EVIDENCE"] });
    const { executor, state } = makeFakeDb();
    const first = await evaluateQualificationForLead(evaluateInput(), deps(provider), executor);
    const second = await evaluateQualificationForLead(evaluateInput(), deps(provider), executor);
    expect(second.duplicateClassification).toBe("idempotent_replay");
    expect(state.reviews).toHaveLength(1);
    expect(state.insertedAudit).toHaveLength(1);
    expect(state.insertAttempts).toBe(3); // qualification dup + review dup attempts converge
    expect(first.qualification.qualificationId).toBe(second.qualification.qualificationId);
  });
});

describe("evaluateQualificationForLead — fail-closed inputs", () => {
  it("rejects a forged lead with LEAD_NOT_FOUND", async () => {
    const provider = new FakeProvider();
    provider.scores.set(SCORE_ID, scorePayload());
    await expect(
      evaluateQualificationForLead(evaluateInput(), deps(provider), makeFakeDb().executor)
    ).rejects.toMatchObject({ name: "QualificationInputError", code: "LEAD_NOT_FOUND" });
  });

  it("rejects an unknown score with SCORE_NOT_FOUND", async () => {
    const provider = new FakeProvider();
    provider.identities.set(LEAD_ID, identityProjection());
    await expect(
      evaluateQualificationForLead(evaluateInput(), deps(provider), makeFakeDb().executor)
    ).rejects.toMatchObject({ name: "QualificationInputError", code: "SCORE_NOT_FOUND" });
  });

  it("treats a cross-tenant score as SCORE_NOT_FOUND (indistinguishable)", async () => {
    const provider = makeProvider({}, { userId: 99 });
    await expect(
      evaluateQualificationForLead(evaluateInput(), deps(provider), makeFakeDb().executor)
    ).rejects.toMatchObject({ name: "QualificationInputError", code: "SCORE_NOT_FOUND" });
  });

  it("rejects a cross-business scope assertion with OWNERSHIP_MISMATCH", async () => {
    const provider = makeProvider();
    await expect(
      evaluateQualificationForLead(
        evaluateInput({ businessId: 999 }),
        deps(provider),
        makeFakeDb().executor
      )
    ).rejects.toMatchObject({ name: "QualificationOwnershipError", code: "OWNERSHIP_MISMATCH" });
  });

  it("rejects an identity older than the staleness window with STALE_IDENTITY", async () => {
    const provider = makeProvider({ lastObservedAt: STALE_ISO });
    await expect(
      evaluateQualificationForLead(evaluateInput(), deps(provider), makeFakeDb().executor)
    ).rejects.toMatchObject({ name: "QualificationInputError", code: "STALE_IDENTITY" });
  });

  it("rejects old or freshness-less score evidence with STALE_SCORE", async () => {
    const old = makeProvider({}, { evidenceFreshness: { latestObservedAt: STALE_ISO, computedAt: NOW_ISO } });
    await expect(
      evaluateQualificationForLead(evaluateInput(), deps(old), makeFakeDb().executor)
    ).rejects.toMatchObject({ name: "QualificationInputError", code: "STALE_SCORE" });

    const empty = makeProvider({}, { evidenceFreshness: { latestObservedAt: null, computedAt: NOW_ISO } });
    await expect(
      evaluateQualificationForLead(evaluateInput(), deps(empty), makeFakeDb().executor)
    ).rejects.toMatchObject({ name: "QualificationInputError", code: "STALE_SCORE" });
  });

  it("rejects a score under a different business scope with SCORE_TAMPERED", async () => {
    const provider = makeProvider();
    provider.scores.set(SCORE_ID, scorePayload({ businessId: 99 }));
    await expect(
      evaluateQualificationForLead(evaluateInput(), deps(provider), makeFakeDb().executor)
    ).rejects.toMatchObject({ name: "QualificationTamperError", code: "SCORE_TAMPERED" });
  });

  it("accepts a score bound through the R6-B seam identity version", async () => {
    // R6-B keys on the legacy numeric leads.id and binds
    // lead-identity-seam/v1:<hash> until R6-A publishes: C binds score to
    // identity by tenant + business scope, never by leadId/version equality.
    const seamVersion = `lead-identity-seam/v1:${G64}`;
    const provider = makeProvider();
    provider.scores.set(SCORE_ID, scorePayload({ leadIdentityVersion: seamVersion }));
    const result = await evaluateQualificationForLead(
      evaluateInput(),
      deps(provider),
      makeFakeDb().executor
    );
    expect(result.qualification.decision).toBe("QUALIFIED");
    expect(result.qualification.leadScoreId).toBe(SCORE_ID);
  });

  it("rejects an unknown policy version with UNKNOWN_POLICY_VERSION", async () => {
    const provider = makeProvider();
    await expect(
      evaluateQualificationForLead(
        evaluateInput({ policyVersion: "lead-qualification-policy/nope" }),
        deps(provider),
        makeFakeDb().executor
      )
    ).rejects.toMatchObject({ name: "QualificationInputError", code: "UNKNOWN_POLICY_VERSION" });
  });

  it("rejects malformed upstream payloads at the seam", async () => {
    const provider = makeProvider({ identityStatus: "qualified" }); // not in the closed set
    await expect(
      evaluateQualificationForLead(evaluateInput(), deps(provider), makeFakeDb().executor)
    ).rejects.toMatchObject({ name: "QualificationValidationError", code: "INVALID_IDENTITY_PROJECTION" });

    const badScore = makeProvider({}, { overallScore: 75, scoreBand: "MEDIUM" });
    await expect(
      evaluateQualificationForLead(evaluateInput(), deps(badScore), makeFakeDb().executor)
    ).rejects.toMatchObject({ name: "QualificationTamperError", code: "SCORE_TAMPERED" });
  });
});

describe("evaluateQualificationForLead — merged identity chains", () => {
  it("follows the canonical lead and evaluates its identity", async () => {
    const provider = new FakeProvider();
    provider.identities.set(LEAD_ID, identityProjection({ identityStatus: "merged", canonicalLeadId: OTHER_LEAD_ID }));
    provider.identities.set(OTHER_LEAD_ID, identityProjection({ leadId: OTHER_LEAD_ID }));
    provider.scores.set(SCORE_ID, scorePayload({ leadId: OTHER_LEAD_ID }));

    const { executor, state } = makeFakeDb();
    const result = await evaluateQualificationForLead(evaluateInput(), deps(provider), executor);
    expect(result.qualification.leadId).toBe(OTHER_LEAD_ID);
    expect(result.qualification.decision).toBe("QUALIFIED");
    expect(state.qualifications).toHaveLength(1);
  });

  it("fails closed when the canonical chain is broken", async () => {
    const provider = new FakeProvider();
    provider.identities.set(LEAD_ID, identityProjection({ identityStatus: "merged", canonicalLeadId: null }));
    provider.scores.set(SCORE_ID, scorePayload());
    await expect(
      evaluateQualificationForLead(evaluateInput(), deps(provider), makeFakeDb().executor)
    ).rejects.toMatchObject({
      name: "QualificationValidationError",
      code: "IDENTITY_MERGE_CHAIN_BROKEN",
    });
  });

  it("fails closed when the canonical chain exceeds five hops", async () => {
    const provider = new FakeProvider();
    const chain: string[] = [];
    for (let i = 0; i < 7; i++) {
      chain.push(`lid1:${String(i).padStart(2, "0").repeat(32)}`);
    }
    for (let i = 0; i < 6; i++) {
      provider.identities.set(
        chain[i],
        identityProjection({ leadId: chain[i], identityStatus: "merged", canonicalLeadId: chain[i + 1] })
      );
    }
    provider.scores.set(SCORE_ID, scorePayload({ leadId: chain[6] }));
    await expect(
      evaluateQualificationForLead(
        evaluateInput({ leadId: chain[0] }),
        deps(provider),
        makeFakeDb().executor
      )
    ).rejects.toMatchObject({
      name: "QualificationValidationError",
      code: "IDENTITY_MERGE_CHAIN_BROKEN",
    });
  });
});

describe("evaluateQualificationForLead — policy versions and re-evaluation", () => {
  it("a registered policy v2 produces a different qualificationId; both rows persist as history", async () => {
    registerQualificationPolicy({
      ...DEFAULT_QUALIFICATION_POLICY,
      policyVersion: "lead-qualification-policy/v2",
      minimumConfidence: 1000,
    });
    const provider = makeProvider();
    const { executor } = makeFakeDb();
    // Re-evaluation happens later: advance the injected clock between calls.
    let nowMs = NOW.getTime();
    const clockedDeps = { provider, now: () => new Date(nowMs) };

    const v1 = await evaluateQualificationForLead(evaluateInput(), clockedDeps, executor);
    nowMs += HOUR_MS;
    const v2 = await evaluateQualificationForLead(
      evaluateInput({ policyVersion: "lead-qualification-policy/v2" }),
      clockedDeps,
      executor
    );
    expect(v1.qualification.qualificationPolicyVersion).toBe("lead-qualification-policy/v1");
    expect(v2.qualification.qualificationPolicyVersion).toBe("lead-qualification-policy/v2");
    expect(v2.qualification.qualificationId).not.toBe(v1.qualification.qualificationId);

    const history = await getQualificationHistory({ userId: USER_ID, leadId: LEAD_ID }, executor);
    expect(history.map((row) => row.qualificationId)).toEqual([
      v1.qualification.qualificationId,
      v2.qualification.qualificationId,
    ]);
  });
});

describe("getHandoffProjectionForUser", () => {
  it("projects a fresh QUALIFIED decision as progression-eligible", async () => {
    const provider = makeProvider();
    const { executor } = makeFakeDb();
    const result = await evaluateQualificationForLead(evaluateInput(), deps(provider), executor);
    const projection = await getHandoffProjectionForUser(
      { userId: USER_ID, qualificationId: result.qualification.qualificationId },
      deps(provider),
      executor
    );
    expect(projection.mayProgress).toBe(true);
    expect(projection.progressBlockedReason).toBeNull();
    expect(projection.review).toBeNull();
    expect(projection.privacy).toEqual({ state: "ACTIVE", actionable: true });
  });

  it("blocks progression for REVIEW_REQUIRED until governed review authorizes it", async () => {
    const provider = makeProvider({}, { reasonCodes: ["CONTRADICTING_EVIDENCE"] });
    const { executor } = makeFakeDb();
    const result = await evaluateQualificationForLead(evaluateInput(), deps(provider), executor);
    const qualificationId = result.qualification.qualificationId;

    const pending = await getHandoffProjectionForUser({ userId: USER_ID, qualificationId }, deps(provider), executor);
    expect(pending.mayProgress).toBe(false);
    // The review exists but is still pending — progression is blocked without
    // a terminal blocked-reason class until review completes.
    expect(pending.progressBlockedReason).toBeNull();
    expect(pending.review?.status).toBe("pending");

    const [review] = await listQualificationReviews({ userId: USER_ID, leadId: LEAD_ID }, executor);
    await resolveQualificationReview(
      { userId: USER_ID, reviewId: review.reviewId, outcome: "progress_authorized", reason: "verified by ops" },
      deps(provider),
      executor
    );

    const authorized = await getHandoffProjectionForUser({ userId: USER_ID, qualificationId }, deps(provider), executor);
    expect(authorized.mayProgress).toBe(true);
    expect(authorized.review?.outcome).toBe("progress_authorized");
    expect(authorized.review?.reviewedAt).toBe(NOW_ISO);
  });

  it("projects a superseded decision as stale", async () => {
    registerQualificationPolicy({
      ...DEFAULT_QUALIFICATION_POLICY,
      policyVersion: "lead-qualification-policy/v3",
      minimumConfidence: 1000,
    });
    const provider = makeProvider();
    const { executor } = makeFakeDb();
    const v1 = await evaluateQualificationForLead(evaluateInput(), deps(provider), executor);
    await evaluateQualificationForLead(
      evaluateInput({ policyVersion: "lead-qualification-policy/v3" }),
      deps(provider),
      executor
    );
    const projection = await getHandoffProjectionForUser(
      { userId: USER_ID, qualificationId: v1.qualification.qualificationId },
      deps(provider),
      executor
    );
    expect(projection.mayProgress).toBe(false);
    expect(projection.progressBlockedReason).toBe("STALE_DECISION");
  });

  it("blocks progression for a suppressed lead with PRIVACY_BLOCKED", async () => {
    const provider = makeProvider();
    provider.privacy.set(LEAD_ID, { state: "SUPPRESSED" });
    const { executor } = makeFakeDb();
    const result = await evaluateQualificationForLead(evaluateInput(), deps(provider), executor);
    expect(result.qualification.decision).toBe("BLOCKED");

    const projection = await getHandoffProjectionForUser(
      { userId: USER_ID, qualificationId: result.qualification.qualificationId },
      deps(provider),
      executor
    );
    expect(projection.mayProgress).toBe(false);
    expect(projection.progressBlockedReason).toBe("PRIVACY_BLOCKED");
    expect(projection.privacy).toEqual({ state: "SUPPRESSED", actionable: false });
  });

  it("fails closed for a qualification owned by another tenant", async () => {
    const provider = makeProvider();
    const { executor } = makeFakeDb();
    const result = await evaluateQualificationForLead(evaluateInput(), deps(provider), executor);
    await expect(
      getHandoffProjectionForUser(
        { userId: 99, qualificationId: result.qualification.qualificationId },
        deps(provider),
        executor
      )
    ).rejects.toMatchObject({ name: "QualificationInputError", code: "QUALIFICATION_NOT_FOUND" });
  });
});

describe("resolveQualificationReview", () => {
  async function evaluatedReview() {
    const provider = makeProvider({}, { reasonCodes: ["CONTRADICTING_EVIDENCE"] });
    const fake = makeFakeDb();
    const result = await evaluateQualificationForLead(evaluateInput(), deps(provider), fake.executor);
    const [review] = await listQualificationReviews({ userId: USER_ID, leadId: LEAD_ID }, fake.executor);
    return { provider, ...fake, result, review };
  }

  it("resolves a pending review once and emits exactly one audit event", async () => {
    const { provider, executor, state, review } = await evaluatedReview();
    const updated = await resolveQualificationReview(
      { userId: USER_ID, reviewId: review.reviewId, outcome: "progress_authorized", reason: "verified by ops" },
      deps(provider),
      executor
    );
    expect(updated.status).toBe("progress_authorized");
    expect(updated.version).toBe(2);
    expect(updated.resolvedBy).toBe(USER_ID);
    expect(updated.resolvedAt).toBe(NOW_ISO);
    expect(updated.resolutionReason).toBe("verified by ops");

    expect(state.insertedAudit).toHaveLength(2);
    const event = state.insertedAudit[1];
    expect(event.eventType).toBe("lead_qualification_review_resolved");
    expect(event.source).toBe("user");
    expect(event.userId).toBe(USER_ID);
    expect(event.metadata).toMatchObject({
      reviewId: review.reviewId,
      qualificationId: review.qualificationId,
      outcome: "progress_authorized",
      decision: "REVIEW_REQUIRED",
      resolvedBy: USER_ID,
    });
  });

  it("a second resolution fails closed with REVIEW_ALREADY_RESOLVED", async () => {
    const { provider, executor, state, review } = await evaluatedReview();
    await resolveQualificationReview(
      { userId: USER_ID, reviewId: review.reviewId, outcome: "progress_authorized", reason: "first" },
      deps(provider),
      executor
    );
    await expect(
      resolveQualificationReview(
        { userId: USER_ID, reviewId: review.reviewId, outcome: "progression_rejected", reason: "second" },
        deps(provider),
        executor
      )
    ).rejects.toMatchObject({
      name: "QualificationStateConflictError",
      code: "REVIEW_ALREADY_RESOLVED",
    });
    expect(state.insertedAudit).toHaveLength(2); // no audit for the failed resolution
  });

  it("fails closed when the bound qualification drifted after review creation", async () => {
    const { provider, executor, state, review } = await evaluatedReview();
    state.qualifications[0].decision = "QUALIFIED"; // tamper with the durable decision
    await expect(
      resolveQualificationReview(
        { userId: USER_ID, reviewId: review.reviewId, outcome: "progress_authorized", reason: "too late" },
        deps(provider),
        executor
      )
    ).rejects.toMatchObject({
      name: "QualificationStateConflictError",
      code: "REVIEW_STALE_BINDING",
    });
    expect(state.insertedAudit).toHaveLength(1);
  });

  it("rejects an unknown outcome or an unbounded reason", async () => {
    const { provider, executor, review } = await evaluatedReview();
    await expect(
      resolveQualificationReview(
        { userId: USER_ID, reviewId: review.reviewId, outcome: "force_qualified", reason: "x" },
        deps(provider),
        executor
      )
    ).rejects.toMatchObject({ name: "QualificationValidationError", code: "INVALID_DECISION" });
    await expect(
      resolveQualificationReview(
        { userId: USER_ID, reviewId: review.reviewId, outcome: "progress_authorized", reason: "" },
        deps(provider),
        executor
      )
    ).rejects.toMatchObject({ name: "QualificationValidationError", code: "INVALID_REASON_CODE" });
  });

  it("rejects resolutions for reviews owned by another tenant", async () => {
    const { provider, executor, review } = await evaluatedReview();
    await expect(
      resolveQualificationReview(
        { userId: 99, reviewId: review.reviewId, outcome: "progress_authorized", reason: "x" },
        deps(provider),
        executor
      )
    ).rejects.toMatchObject({ name: "QualificationInputError", code: "REVIEW_NOT_FOUND" });
  });
});

describe("audit persistence through the shared executor", () => {
  it("persists canonical envelopes fingerprint-addressable in the ledger", async () => {
    const provider = makeProvider();
    const { executor, state } = makeFakeDb();
    const result = await evaluateQualificationForLead(evaluateInput(), deps(provider), executor);

    expect(state.auditRows).toHaveLength(1);
    const row = state.auditRows[0];
    expect(row.eventType).toBe("lead_qualification_evaluated");
    expect(row.userId).toBe(USER_ID);
    expect(row.metadata).toMatchObject({
      qualificationId: result.qualification.qualificationId,
      decision: "QUALIFIED",
    });

    // The durable row is fingerprint-addressable: rebuilding the canonical
    // envelope from the persisted material reproduces the stored fingerprint.
    const rebuilt = createAuditEvent({
      eventType: row.eventType as "lead_qualification_evaluated",
      occurredAt: row.occurredAt as string,
      userId: row.userId as number,
      source: row.source as "system",
      outcome: row.outcome as "succeeded",
      businessId: row.businessId as number | null,
      metadata: row.metadata as Record<string, unknown>,
    });
    expect(buildAuditEventFingerprint(rebuilt)).toBe(row.eventFingerprint);
    expect(row.eventFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });
});
