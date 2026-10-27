// ─── R6-C — Lead Qualification Autonomy Acceptance Suite (C9) ───
//
// Deterministic acceptance scenarios for the governed lead-qualification
// authority (docs/contracts/lead-qualification-contract.md and
// docs/contracts/lead-qualification-to-nurture-handoff-contract.md), plus one
// connected harness trace. Every case drives the real seams + engine + store +
// service + handoff projection; no real MySQL, no network, no wall-clock
// reliance (an explicit `now` is injected at service level; fake timers pin the
// router-level cases, mirroring api/qualification-router.test.ts).
//
// Scenario map (scenario → test):
//   1  decisions › valid lead evaluates QUALIFIED, progresses, no review
//   2  decisions › score alone cannot qualify (VERY_HIGH band, zero fit/intent)
//   3  decisions › missing fit evidence → INSUFFICIENT_EVIDENCE
//   4  decisions › ambiguous evidence → REVIEW_REQUIRED + durable bound review
//   5  decisions › explicit disqualifier → NOT_QUALIFIED
//   6  decisions › privacy suppression → BLOCKED + PRIVACY_BLOCKED handoff
//   7  authority rejection › cross-business scope → OWNERSHIP_MISMATCH
//   8  authority rejection › forged / cross-tenant lead → LEAD_NOT_FOUND
//   9  authority rejection › stale identity → STALE_IDENTITY
//  10  authority rejection › stale score evidence → STALE_SCORE
//  11  authority rejection › tampered score content hash → SCORE_TAMPERED
//  12  authority rejection › unknown scoring version → UNKNOWN_SCORE_VERSION
//  13  authority rejection › unknown policy version; resolved version binding
//  14  exact-once persistence › policy update → new qualificationId + history
//  15  exact-once persistence › replay → idempotent_replay, zero extra rows
//  16  exact-once persistence › concurrent duplicates converge (two variants)
//  17  exact-once persistence › divergent replay → QUALIFICATION_REPLAY_CONFLICT
//  18  exact-once persistence › historical decisions immutable, no update path
//  19  security invariants › protected traits rejected (FORBIDDEN_EVIDENCE etc.)
//  20  security invariants › prompt-injected evidence cannot force a decision
//  21  security invariants › upstream "qualified" field rejected at the seams
//  22  security invariants › router strict-object: no client-supplied authority
//  23  governance/review › input authority rejected; human/session separation blocker recorded
//  24  governance/review › superseded review approval rejected
//  25  governance/review › stale review approval → REVIEW_STALE_BINDING
//  26  handoff projection › suppressed/BLOCKED never progresses
//  27  handoff projection › NOT_QUALIFIED never progresses
//  28  handoff projection › REVIEW_REQUIRED remains blocked after resolution
//  29  handoff projection › exact closed key set (top level + nested)
//  30  security invariants › zero outreach/CRM/conversion/billing writes
//  H  connected harness › R5 ids → R6-A → R6-B → snapshot → engine → store → D
//
// Review authorization never replaces a deterministic QUALIFIED decision.
// Runtime human/agent credential separation is a separate acceptance blocker;
// a tenant session alone does not prove a human initiated review resolution.
//
// Two library defects were surfaced by this suite during C9 and are FIXED in
// the seams (both blocked the specified R6-A/R6-B fixture shapes that the
// production bridge produces verbatim):
//   FIX-1 qualification-identity-seam.ts provenance evidenceType is nullable
//       (the upstream lead_identity_provenance.evidenceType column is nullable
//       and the bridge carries it verbatim).
//   FIX-2 qualification-scoring-seam.ts accepts the legacy numeric leads.id
//       for the score's leadId anchor (R6-B keys on it; the bridge carries it
//       verbatim) and normalizes it to the deterministic string form bound
//       into the score content hash.

import { describe, expect, it, vi } from "vitest";
import { auditEvents } from "@db/schema";
import {
  deriveDecisionBindingHash,
  deriveScoreContentHash,
} from "./lib/qualification/qualification-contract";
import {
  DEFAULT_QUALIFICATION_POLICY,
  getQualificationPolicy,
  registerQualificationPolicy,
} from "./lib/qualification/qualification-policy";
import {
  assertAllowedEvidenceCategory,
  buildEvidenceSnapshot,
  FORBIDDEN_EVIDENCE_CATEGORY_VALUES,
} from "./lib/qualification/qualification-evidence";
import { evaluateQualification } from "./lib/qualification/qualification-engine";
import { validateIdentityProjection } from "./lib/qualification/qualification-identity-seam";
import { validateScorePayload } from "./lib/qualification/qualification-scoring-seam";
import { resolvePrivacyGate } from "./lib/qualification/qualification-governance-seam";
import {
  assertReviewDecisionBinding,
  buildReviewForDecision,
} from "./lib/qualification/qualification-review";
import {
  QUALIFICATION_HANDOFF_PROJECTION_KEYS,
} from "./lib/qualification/qualification-handoff";
import {
  evaluateQualificationForLead,
  getHandoffProjectionForUser,
  getQualificationForUser,
  getQualificationHistory,
  listQualificationReviews,
  ProviderLeadNotFound,
  ProviderScoreNotFound,
  resolveQualificationReview,
  type QualificationAuthorityProvider,
} from "./lib/qualification/qualification-service";
import * as qualificationStore from "./lib/qualification/qualification-store";
import {
  insertReview,
  type QualificationStoreExecutor,
  type StoreOrderTerm,
  type StorePredicate,
} from "./lib/qualification/qualification-store";
import { qualificationRouter } from "./qualification-router";
import { createQualificationBridgeProvider, ProviderAuthorityUnavailable } from "./lib/qualification/qualification-bridge";
import { buildCtx, createFakeDb } from "./r5-test-support";
import { getDb } from "./queries/connection";

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

// ─── Deterministic fixture clock + anchors ───

const NOW_ISO = "2026-06-28T12:00:00.000Z";
const NOW = new Date(NOW_ISO);
const HOUR_MS = 60 * 60 * 1000;
const FRESH_ISO = new Date(NOW.getTime() - HOUR_MS).toISOString();
const FIRST_OBSERVED_ISO = new Date(NOW.getTime() - 8 * 24 * HOUR_MS).toISOString();
const STALE_400H_ISO = new Date(NOW.getTime() - 400 * HOUR_MS).toISOString();

const H64 = "ab".repeat(32);
const G64 = "cd".repeat(32);
const E64 = "ef".repeat(32);
const LEAD_ID = `lid1:${H64}`;
const OTHER_LEAD_ID = `lid1:${G64}`;
const SCORE_ID = `lsc1:${H64}`;
const OPP_ID = `opp1:${"aa".repeat(32)}`;
const HANDOFF_ID = `oph1:${"bb".repeat(32)}`;
const USER_ID = 7;
const OTHER_TENANT_ID = 99;
const BUSINESS_ID = 42;

const DEFAULT_POLICY_VERSION = DEFAULT_QUALIFICATION_POLICY.policyVersion;
const POLICY_V2 = {
  ...DEFAULT_QUALIFICATION_POLICY,
  policyVersion: "lead-qualification-policy/v2",
  minimumScoreBand: "VERY_HIGH" as const,
};

// ─── Shared fixture builders ───

/** 14-key R6-A LeadIdentityProjection (opportunity-handoff provenance, ids only). */
function makeIdentity(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    leadId: LEAD_ID,
    businessId: BUSINESS_ID,
    leadIdentityVersion: "lead-identity/v1",
    identityStatus: "active",
    identityConfidence: "high",
    primaryIdentityType: "email_hash",
    externalActorReferenceHash: E64,
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
        evidenceType: null,
        occurredAt: FIRST_OBSERVED_ISO,
      },
    ],
    ...overrides,
  };
}

/** Mirrors the scoring seam's deterministic leadId normalization for hashing. */
function normalizedScoreLeadId(leadId: unknown): string {
  return typeof leadId === "number" ? String(leadId) : (leadId as string);
}

/** 24-key R6-B LeadScoreProjection keyed on the legacy numeric leads.id. */
function makeScore(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const merged: Record<string, unknown> = {
    leadScoreId: SCORE_ID,
    leadId: 123456, // legacy numeric leads.id (R6-B surface)
    leadIdentityVersion: `lead-identity-seam/v1:${G64}`,
    scoringVersion: "lead-scoring-engine/v1",
    featureVersion: "lead-scoring-features/v1",
    scoreContractVersion: "lead-scoring/v1",
    evidenceSnapshotId: `lss1:${E64}`,
    evidenceSnapshotHash: E64,
    overallScore: 75,
    scoreBand: "HIGH",
    scoreConfidence: "HIGH",
    fitScore: 60,
    intentScore: 60,
    engagementScore: 50,
    recencyScore: 70,
    opportunityScore: 65,
    componentWeights: { fit: 0.25, intent: 0.3, engagement: 0.15, recency: 0.15, opportunity: 0.15 },
    reasonCodes: ["STRONG_PURCHASE_INTENT"],
    evidenceFreshness: { latestObservedAt: FRESH_ISO, computedAt: NOW_ISO },
    computedAt: NOW_ISO,
    createdAt: NOW_ISO,
    businessId: BUSINESS_ID,
    userId: USER_ID,
    duplicateClassification: "none",
    ...overrides,
  };
  if ("scoreContentHash" in overrides) return merged;
  return {
    ...merged,
    scoreContentHash: deriveScoreContentHash({
      leadScoreId: merged.leadScoreId as string,
      scoringVersion: merged.scoringVersion as string,
      featureVersion: merged.featureVersion as string,
      scoreContractVersion: merged.scoreContractVersion as string,
      leadIdentityVersion: merged.leadIdentityVersion as string,
      leadId: normalizedScoreLeadId(merged.leadId),
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
    }),
  };
}

// ─── Fake authority provider (tenant-anchored like the production bridge) ───

class FakeProvider implements QualificationAuthorityProvider {
  readonly identities = new Map<string, { ownerUserId: number; payload: unknown }>();
  readonly scores = new Map<string, unknown>();
  readonly privacy = new Map<string, unknown>();

  constructor(readonly tenantUserId: number = USER_ID) {}

  setIdentity(leadId: string, payload: unknown, ownerUserId: number = this.tenantUserId): void {
    this.identities.set(leadId, { ownerUserId, payload });
  }

  async getIdentityProjection(leadId: string): Promise<unknown> {
    const entry = this.identities.get(leadId);
    // The bridge predicates eq(userId): another tenant's lead is
    // indistinguishable from an absent one.
    if (!entry || entry.ownerUserId !== this.tenantUserId) throw new ProviderLeadNotFound(leadId);
    return entry.payload;
  }

  async getScorePayload(leadScoreId: string): Promise<unknown> {
    if (!this.scores.has(leadScoreId)) throw new ProviderScoreNotFound(leadScoreId);
    return this.scores.get(leadScoreId);
  }

  async getPrivacyState(leadId: string): Promise<unknown> {
    return this.privacy.has(leadId) ? this.privacy.get(leadId) : null;
  }
}

function makeProvider(
  identityOverrides: Record<string, unknown> = {},
  scoreOverrides: Record<string, unknown> = {}
): FakeProvider {
  const provider = new FakeProvider();
  provider.setIdentity(LEAD_ID, makeIdentity(identityOverrides));
  provider.scores.set(SCORE_ID, makeScore(scoreOverrides));
  return provider;
}

const deps = (provider: QualificationAuthorityProvider, now: Date = NOW) => ({
  provider,
  now: () => new Date(now.getTime()),
});

const evaluateInput = (overrides: Record<string, unknown> = {}) => ({
  userId: USER_ID,
  leadId: LEAD_ID,
  leadScoreId: SCORE_ID,
  ...overrides,
});

async function evaluateFresh(
  provider: FakeProvider,
  overrides: Record<string, unknown> = {},
  now: Date = NOW
) {
  const fake = makeFakeDb();
  const result = await evaluateQualificationForLead(
    evaluateInput(overrides),
    deps(provider, now),
    fake.executor
  );
  return { ...fake, result };
}

// ─── In-memory fake executor (R6-C tables + audit ledger + insert/update log) ───

type Row = Record<string, unknown>;

/** Tables the qualification path must never write (contract §14.9). */
const FORBIDDEN_WRITE_TABLES = [
  "leads",
  "lead_activities",
  "lead_scores",
  "opportunity_candidates",
  "opportunity_handoffs",
  "approval_requests",
  "policy_decisions",
  "billing_ledger",
] as const;

interface FakeDbState {
  tables: Record<string, Row[]>;
  insertLogs: string[];
  updateLogs: string[];
  qualificationInsertAttempts: number;
  auditInsertAttempts: number;
}

function duplicateKeyError(): Error & { code: string; errno: number } {
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
    const cmp =
      av === null || av === undefined ? -1 : bv === null || bv === undefined ? 1 : av < bv ? -1 : 1;
    return term.direction === "asc" ? cmp : -cmp;
  }
  return 0;
}

let nextAuditId = 1;

function makeFakeDb() {
  const state: FakeDbState = {
    tables: {
      lead_qualifications: [],
      lead_qualification_reviews: [],
      audit_events: [],
      ...Object.fromEntries(FORBIDDEN_WRITE_TABLES.map((name) => [name, []])),
    },
    insertLogs: [],
    updateLogs: [],
    qualificationInsertAttempts: 0,
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
    orderBy: (...terms: StoreOrderTerm[]) =>
      buildQuery([...rows].sort((a, b) => compareRows(a, b, terms))),
    all: async () => rows.map((row) => ({ ...row })),
    limit: async (n: number) => rows.slice(0, n).map((row) => ({ ...row })),
  });

  const executor: QualificationStoreExecutor = {
    select: () => ({
      from: (table) => {
        if ((table as unknown) === auditEvents) return targetFor(state.tables.audit_events);
        return targetFor(state.tables[tableNameOf(table)] ?? []);
      },
    }),
    insert: (table) => ({
      values: async (row: Row) => {
        const name = tableNameOf(table);
        state.insertLogs.push(name);
        const rows = (state.tables[name] ??= []);
        if ((table as unknown) === auditEvents) {
          state.auditInsertAttempts += 1;
          if (rows.some((existing) => existing.eventFingerprint === row.eventFingerprint)) {
            throw duplicateKeyError();
          }
          rows.push({ id: nextAuditId++, createdAt: new Date(NOW_ISO), ...row });
          return [{ affectedRows: 1 }];
        }
        if (name === "lead_qualifications") {
          state.qualificationInsertAttempts += 1;
          if (
            rows.some(
              (existing) =>
                existing.userId === row.userId && existing.qualificationId === row.qualificationId
            )
          ) {
            throw duplicateKeyError();
          }
          rows.push({ ...row });
          return [{ affectedRows: 1 }];
        }
        if (name === "lead_qualification_reviews") {
          if (
            rows.some(
              (existing) => existing.userId === row.userId && existing.reviewId === row.reviewId
            ) ||
            rows.some(
              (existing) =>
                existing.userId === row.userId && existing.qualificationId === row.qualificationId
            )
          ) {
            throw duplicateKeyError();
          }
          rows.push({ ...row });
          return [{ affectedRows: 1 }];
        }
        rows.push({ ...row });
        return [{ affectedRows: 1 }];
      },
    }),
    update: (table) => ({
      set: (patch: Row) => ({
        where: async (cond: unknown) => {
          const name = tableNameOf(table);
          state.updateLogs.push(name);
          const rows = state.tables[name] ?? [];
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

  return {
    executor,
    state,
    qualifications: () => state.tables.lead_qualifications,
    reviews: () => state.tables.lead_qualification_reviews,
    auditRows: () => state.tables.audit_events,
  };
}

// ─── C9 acceptance — decisions ───

describe("C9 acceptance — decisions", () => {
  // Scenario 1 — a valid, current, well-evidenced lead evaluates QUALIFIED,
  // progresses through the handoff projection, and requires no review.
  it("scenario 1: valid lead → QUALIFIED, mayProgress true, reviewRequired false", async () => {
    const provider = makeProvider();
    const { executor, result } = await evaluateFresh(provider);

    const q = result.qualification;
    expect(result.duplicateClassification).toBe("none");
    expect(q.decision).toBe("QUALIFIED");
    expect(q.reviewRequired).toBe(false);
    expect(q.confidenceScore).toBe(10000);
    expect(q.userId).toBe(USER_ID);
    expect(q.businessId).toBe(BUSINESS_ID);
    expect(q.reasonCodes).toContain("POLICY_REQUIREMENTS_MET");
    expect(q.qualificationId).toMatch(/^lqu1:[a-f0-9]{64}$/);
    expect(q.qualificationPolicyVersion).toBe(DEFAULT_POLICY_VERSION);
    expect(q.validUntil).toBe(
      new Date(NOW.getTime() + DEFAULT_QUALIFICATION_POLICY.validityMs).toISOString()
    );

    const projection = await getHandoffProjectionForUser(
      { userId: USER_ID, qualificationId: q.qualificationId },
      deps(provider),
      executor
    );
    expect(projection.mayProgress).toBe(true);
    expect(projection.progressBlockedReason).toBeNull();
    expect(projection.review).toBeNull();
  });

  // Scenario 2 — score alone cannot qualify: a VERY_HIGH band with zero
  // fit/intent component evidence is INSUFFICIENT_EVIDENCE, never QUALIFIED.
  it("scenario 2: overallScore 95 VERY_HIGH with fitScore 0 / intentScore 0 → INSUFFICIENT_EVIDENCE", async () => {
    const provider = makeProvider(
      {},
      { overallScore: 95, scoreBand: "VERY_HIGH", fitScore: 0, intentScore: 0 }
    );
    const { result } = await evaluateFresh(provider);
    expect(result.qualification.decision).toBe("INSUFFICIENT_EVIDENCE");
    expect(result.qualification.reasonCodes).toContain("MISSING_FIT_EVIDENCE");
    expect(result.qualification.reasonCodes).toContain("MISSING_INTENT_EVIDENCE");
    expect(result.qualification.reviewRequired).toBe(false);
  });

  // Scenario 3 — missing fit evidence gates the outcome independently of band.
  it("scenario 3: fitScore 10 (intent 60, band HIGH) → INSUFFICIENT_EVIDENCE + MISSING_FIT_EVIDENCE", async () => {
    const provider = makeProvider({}, { fitScore: 10 });
    const { result } = await evaluateFresh(provider);
    expect(result.qualification.decision).toBe("INSUFFICIENT_EVIDENCE");
    expect(result.qualification.reasonCodes).toContain("MISSING_FIT_EVIDENCE");
    expect(result.qualification.reasonCodes).not.toContain("MISSING_INTENT_EVIDENCE");
  });

  // Scenario 4 — ambiguous (contradicting) evidence triggers a durable pending
  // review bound to the exact decision tuple.
  it("scenario 4: CONTRADICTING_EVIDENCE → REVIEW_REQUIRED + durable bound pending review", async () => {
    const provider = makeProvider({}, { reasonCodes: ["CONTRADICTING_EVIDENCE"] });
    const { executor, state, result } = await evaluateFresh(provider);

    const q = result.qualification;
    expect(q.decision).toBe("REVIEW_REQUIRED");
    expect(q.reviewRequired).toBe(true);
    expect(q.reasonCodes).toContain("REVIEW_TRIGGERED_BY_POLICY");
    expect(q.reasonCodes).toContain("CONTRADICTING_EVIDENCE");

    expect(state.tables.lead_qualification_reviews).toHaveLength(1);
    const review = state.tables.lead_qualification_reviews[0];
    expect(review.status).toBe("pending");
    expect(review.version).toBe(1);
    expect(review.qualificationId).toBe(q.qualificationId);
    expect(review.decisionBindingHash).toBe(
      deriveDecisionBindingHash({
        qualificationId: q.qualificationId,
        decision: q.decision,
        reasonCodes: q.reasonCodes as string[],
        identityReference: q.identityReference,
        scoreContentHash: q.scoreContentHash,
        evidenceSnapshotHash: q.evidenceSnapshotHash,
        qualificationPolicyVersion: q.qualificationPolicyVersion,
        engineVersion: q.engineVersion,
      })
    );
    expect(() => assertReviewDecisionBinding(review as never, q)).not.toThrow();
  });

  // Scenario 5 — an explicit disqualifier decides NOT_QUALIFIED even when
  // every other signal is perfect.
  it("scenario 5: UNRESOLVED_COMPLAINT_SIGNAL → NOT_QUALIFIED + DISQUALIFYING_EVIDENCE", async () => {
    const provider = makeProvider(
      {},
      { overallScore: 95, scoreBand: "VERY_HIGH", reasonCodes: ["UNRESOLVED_COMPLAINT_SIGNAL"] }
    );
    const { result } = await evaluateFresh(provider);
    expect(result.qualification.decision).toBe("NOT_QUALIFIED");
    expect(result.qualification.reasonCodes).toContain("DISQUALIFYING_EVIDENCE");
    expect(result.qualification.reviewRequired).toBe(false);
  });

  // Scenario 6 — privacy suppression blocks evaluation and progression.
  it("scenario 6: SUPPRESSED privacy → BLOCKED + PRIVACY_SUPPRESSED; handoff PRIVACY_BLOCKED", async () => {
    const provider = makeProvider();
    provider.privacy.set(LEAD_ID, { state: "SUPPRESSED" });
    const { executor, result } = await evaluateFresh(provider);

    expect(result.qualification.decision).toBe("BLOCKED");
    expect(result.qualification.reasonCodes).toContain("PRIVACY_SUPPRESSED");

    const projection = await getHandoffProjectionForUser(
      { userId: USER_ID, qualificationId: result.qualification.qualificationId },
      deps(provider),
      executor
    );
    expect(projection.mayProgress).toBe(false);
    expect(projection.progressBlockedReason).toBe("PRIVACY_BLOCKED");
    expect(projection.privacy).toEqual({ state: "SUPPRESSED", actionable: false });
  });
});

// ─── C9 acceptance — authority rejection ───

describe("C9 acceptance — authority rejection", () => {
  // Scenario 7 — a cross-business scope assertion fails closed.
  it("scenario 7: businessId 99 against identity businessId 42 → OWNERSHIP_MISMATCH", async () => {
    const provider = makeProvider();
    const { result } = await evaluateFresh(provider);
    expect(result.qualification.businessId).toBe(BUSINESS_ID);
    await expect(
      evaluateQualificationForLead(
        evaluateInput({ businessId: 99 }),
        deps(provider),
        makeFakeDb().executor
      )
    ).rejects.toMatchObject({ name: "QualificationOwnershipError", code: "OWNERSHIP_MISMATCH" });
  });

  // Scenario 8 — forged and cross-tenant leads are indistinguishable failures.
  it("scenario 8: unknown leadId and another tenant's leadId both → LEAD_NOT_FOUND", async () => {
    // Unknown lead entirely.
    const empty = new FakeProvider();
    empty.scores.set(SCORE_ID, makeScore());
    const unknownError = await evaluateQualificationForLead(
      evaluateInput(),
      deps(empty),
      makeFakeDb().executor
    ).catch((err: unknown) => err);
    expect(unknownError).toMatchObject({ name: "QualificationInputError", code: "LEAD_NOT_FOUND" });

    // A lead that exists but is owned by another tenant: the bridge's
    // eq(userId) predicate hides it, producing the identical failure.
    const crossTenant = new FakeProvider(USER_ID);
    crossTenant.setIdentity(OTHER_LEAD_ID, makeIdentity({ leadId: OTHER_LEAD_ID }), OTHER_TENANT_ID);
    crossTenant.scores.set(SCORE_ID, makeScore({ leadId: 987654 }));
    const crossError = await evaluateQualificationForLead(
      evaluateInput({ leadId: OTHER_LEAD_ID }),
      deps(crossTenant),
      makeFakeDb().executor
    ).catch((err: unknown) => err);
    expect(crossError).toMatchObject({ name: "QualificationInputError", code: "LEAD_NOT_FOUND" });
    expect((crossError as Error).message).toMatch(/^lead lid1:[a-f0-9]{64} not found$/);
  });

  // Scenario 9 — an identity outside the staleness window is rejected.
  it("scenario 9: lastObservedAt 400h old → STALE_IDENTITY", async () => {
    const provider = makeProvider({ lastObservedAt: STALE_400H_ISO });
    await expect(
      evaluateQualificationForLead(evaluateInput(), deps(provider), makeFakeDb().executor)
    ).rejects.toMatchObject({ name: "QualificationInputError", code: "STALE_IDENTITY" });
  });

  // Scenario 10 — score evidence older than the policy window is rejected.
  it("scenario 10: evidenceFreshness.latestObservedAt 400h old → STALE_SCORE", async () => {
    const provider = makeProvider(
      {},
      { evidenceFreshness: { latestObservedAt: STALE_400H_ISO, computedAt: NOW_ISO } }
    );
    await expect(
      evaluateQualificationForLead(evaluateInput(), deps(provider), makeFakeDb().executor)
    ).rejects.toMatchObject({ name: "QualificationInputError", code: "STALE_SCORE" });
  });

  // Scenario 11 — stored score fields that disagree with the bound content
  // hash are tampering (overallScore corrupted after hash binding; the stale
  // scoreContentHash is kept).
  it("scenario 11: corrupted overallScore under stale scoreContentHash → SCORE_TAMPERED", async () => {
    const tampered = makeScore(); // hash bound over the pristine payload
    tampered.overallScore = 95; // corrupted in place; band + hash left stale
    const provider = new FakeProvider();
    provider.setIdentity(LEAD_ID, makeIdentity());
    provider.scores.set(SCORE_ID, tampered);

    await expect(
      evaluateQualificationForLead(evaluateInput(), deps(provider), makeFakeDb().executor)
    ).rejects.toMatchObject({ name: "QualificationTamperError", code: "SCORE_TAMPERED" });

    // The seam itself rejects the same corruption.
    let seamError: unknown;
    try {
      validateScorePayload(tampered);
    } catch (err) {
      seamError = err;
    }
    expect(seamError).toMatchObject({ name: "QualificationTamperError", code: "SCORE_TAMPERED" });
  });

  // Scenario 12 — unknown scoring versions fail closed.
  it("scenario 12: scoringVersion lead-scoring-engine/v99 → UNKNOWN_SCORE_VERSION", async () => {
    const provider = makeProvider({}, { scoringVersion: "lead-scoring-engine/v99" });
    await expect(
      evaluateQualificationForLead(evaluateInput(), deps(provider), makeFakeDb().executor)
    ).rejects.toMatchObject({ name: "QualificationInputError", code: "UNKNOWN_SCORE_VERSION" });
  });

  // Scenario 13 — unknown policy versions fail closed; a stored decision always
  // binds the resolved policy version.
  it("scenario 13: unknown policyVersion rejected; stored row binds the resolved version", async () => {
    const provider = makeProvider();
    await expect(
      evaluateQualificationForLead(
        evaluateInput({ policyVersion: "lead-qualification-policy/v99" }),
        deps(provider),
        makeFakeDb().executor
      )
    ).rejects.toMatchObject({ name: "QualificationInputError", code: "UNKNOWN_POLICY_VERSION" });

    // Happy path: the stored decision binds the resolved default version, and
    // naming it explicitly resolves to the identical qualificationId.
    const first = await evaluateQualificationForLead(
      evaluateInput(),
      deps(provider),
      makeFakeDb().executor
    );
    expect(first.qualification.qualificationPolicyVersion).toBe(DEFAULT_POLICY_VERSION);
    const explicit = await evaluateQualificationForLead(
      evaluateInput({ policyVersion: DEFAULT_POLICY_VERSION }),
      deps(provider),
      makeFakeDb().executor
    );
    expect(explicit.qualification.qualificationId).toBe(first.qualification.qualificationId);
    expect(getQualificationPolicy()).toEqual(DEFAULT_QUALIFICATION_POLICY);
  });
});

// ─── C9 acceptance — exact-once persistence ───

describe("C9 acceptance — exact-once persistence", () => {
  it("scenario 15b: retries at later wall times converge without extending validity", async () => {
    const provider = makeProvider();
    const { executor, state } = makeFakeDb();
    const first = await evaluateQualificationForLead(evaluateInput(), deps(provider), executor);
    const retry = await evaluateQualificationForLead(evaluateInput(), deps(provider,
      new Date(NOW.getTime() + HOUR_MS)), executor);
    expect(retry.duplicateClassification).toBe("idempotent_replay");
    expect(retry.qualification).toEqual(first.qualification);
    expect(state.tables.lead_qualifications).toHaveLength(1);
    expect(state.tables.audit_events).toHaveLength(1);
    const expired = await getHandoffProjectionForUser({ userId: USER_ID,
      qualificationId: first.qualification.qualificationId }, deps(provider,
      new Date(NOW.getTime() + DEFAULT_QUALIFICATION_POLICY.validityMs + 1)), executor);
    expect(expired.mayProgress).toBe(false);
  });

  it.each(["reviewRequired", "validUntil", "evidenceSnapshot"])(
    "scenario 17b: replay rejects tampered %s", async (field) => {
      const provider = makeProvider();
      const { executor, state } = makeFakeDb();
      await evaluateQualificationForLead(evaluateInput(), deps(provider), executor);
      state.tables.lead_qualifications[0][field] = field === "reviewRequired" ? true
        : field === "validUntil" ? "2099-01-01T00:00:00.000Z"
        : { ...state.tables.lead_qualifications[0].evidenceSnapshot as object, entries: [] };
      await expect(evaluateQualificationForLead(evaluateInput(), deps(provider), executor))
        .rejects.toMatchObject({ code: "QUALIFICATION_REPLAY_CONFLICT" });
      expect(state.tables.audit_events).toHaveLength(1);
    }
  );
  // Scenario 14 — a policy update re-evaluates the same lead+score into a new
  // deterministic qualificationId; both rows persist as immutable history.
  it("scenario 14: policy v2 (minimumScoreBand VERY_HIGH) → new qualificationId + both rows in history", async () => {
    registerQualificationPolicy(POLICY_V2);
    const provider = makeProvider();
    const { executor } = makeFakeDb();

    const v1 = await evaluateQualificationForLead(evaluateInput(), deps(provider), executor);
    expect(v1.qualification.decision).toBe("QUALIFIED");
    const v1RowSnapshot = JSON.parse(JSON.stringify(v1.qualification));

    const v2 = await evaluateQualificationForLead(
      evaluateInput({ policyVersion: POLICY_V2.policyVersion }),
      deps(provider),
      executor
    );
    expect(v2.qualification.qualificationPolicyVersion).toBe(POLICY_V2.policyVersion);
    expect(v2.qualification.decision).toBe("NOT_QUALIFIED"); // HIGH < VERY_HIGH
    expect(v2.qualification.reasonCodes).toContain("SCORE_BELOW_THRESHOLD");
    expect(v2.qualification.qualificationId).not.toBe(v1.qualification.qualificationId);

    const history = await getQualificationHistory({ userId: USER_ID, leadId: LEAD_ID }, executor);
    expect(history.map((row) => row.qualificationId).sort()).toEqual([
      v1.qualification.qualificationId,
      v2.qualification.qualificationId,
    ].sort());

    // The v1 row is unchanged content after the v2 insert.
    const reread = await getQualificationForUser(
      { userId: USER_ID, qualificationId: v1.qualification.qualificationId },
      executor
    );
    expect(JSON.parse(JSON.stringify(reread))).toEqual(v1RowSnapshot);
  });

  // Scenario 15 — identical inputs replay to the same durable decision with
  // zero additional rows and zero additional audit events.
  it("scenario 15: replay → idempotent_replay, same qualificationId, zero extra rows/audit", async () => {
    const provider = makeProvider();
    const { executor, state } = makeFakeDb();

    const first = await evaluateQualificationForLead(evaluateInput(), deps(provider), executor);
    const second = await evaluateQualificationForLead(evaluateInput(), deps(provider), executor);

    expect(first.duplicateClassification).toBe("none");
    expect(second.duplicateClassification).toBe("idempotent_replay");
    expect(second.qualification.qualificationId).toBe(first.qualification.qualificationId);
    expect(second.qualification).toEqual(first.qualification);

    expect(state.tables.lead_qualifications).toHaveLength(1);
    expect(state.tables.lead_qualification_reviews).toHaveLength(0);
    expect(state.tables.audit_events).toHaveLength(1);
    expect(state.auditInsertAttempts).toBe(1);
    // One converged insert attempt, no second durable write.
    expect(state.qualificationInsertAttempts).toBe(2);
  });

  // Scenario 16 — concurrent duplicates converge DB-authoritatively: one row,
  // one audit event, both callers receive the same qualificationId.
  it("scenario 16a: Promise.all concurrent duplicates converge to one stored row", async () => {
    const provider = makeProvider();
    const { executor, state } = makeFakeDb();

    const [a, b] = await Promise.all([
      evaluateQualificationForLead(evaluateInput(), deps(provider), executor),
      evaluateQualificationForLead(evaluateInput(), deps(provider), executor),
    ]);

    expect(a.qualification.qualificationId).toBe(b.qualification.qualificationId);
    expect([a.duplicateClassification, b.duplicateClassification].sort()).toEqual([
      "idempotent_replay",
      "none",
    ]);
    expect(state.tables.lead_qualifications).toHaveLength(1);
    expect(state.tables.audit_events).toHaveLength(1);
    expect(state.auditInsertAttempts).toBe(1);
  });

  // Scenario 16 (variant) — the racing insert loses with a raw errno-1062 from
  // the database; the loser re-reads and converges on the committed row.
  it("scenario 16b: racing insert loses with errno 1062 → both callers converge", async () => {
    const provider = makeProvider();
    const { executor, state } = makeFakeDb();
    let qualificationInsertAttempts = 0;
    const racing: QualificationStoreExecutor = {
      ...executor,
      insert: (table) => ({
        values: async (row: Row) => {
          if (tableNameOf(table) === "lead_qualifications") {
            qualificationInsertAttempts += 1;
            if (qualificationInsertAttempts === 2) throw duplicateKeyError();
          }
          return executor.insert(table).values(row);
        },
      }),
    };

    const [a, b] = await Promise.all([
      evaluateQualificationForLead(evaluateInput(), deps(provider), racing),
      evaluateQualificationForLead(evaluateInput(), deps(provider), racing),
    ]);

    expect(a.qualification.qualificationId).toBe(b.qualification.qualificationId);
    expect(state.tables.lead_qualifications).toHaveLength(1);
    expect(state.tables.audit_events).toHaveLength(1);
  });

  // Scenario 17 — a stored row that drifts from the recomputed decision under
  // the same anchor is tampering: the replay fails closed.
  it("scenario 17: stored row with mutated decision → QUALIFICATION_REPLAY_CONFLICT", async () => {
    const provider = makeProvider();
    const { executor, state } = makeFakeDb();
    await evaluateQualificationForLead(evaluateInput(), deps(provider), executor);

    // Tamper with the durable row under the same convergence anchor.
    const stored = state.tables.lead_qualifications[0];
    stored.decision = "NOT_QUALIFIED";
    stored.reasonCodes = ["SCORE_BELOW_THRESHOLD"];

    await expect(
      evaluateQualificationForLead(evaluateInput(), deps(provider), executor)
    ).rejects.toMatchObject({ name: "QualificationTamperError", code: "QUALIFICATION_REPLAY_CONFLICT" });
    expect(state.tables.audit_events).toHaveLength(1); // the failed replay emits nothing
  });

  // Scenario 18 — historical decisions are immutable: re-reads (direct and via
  // the replay path) return identical content, and the store exposes no
  // qualification update path (reviews only).
  it("scenario 18: historical decision immutable; store has no update export for qualifications", async () => {
    registerQualificationPolicy(POLICY_V2);
    const provider = makeProvider();
    const { executor, state } = makeFakeDb();

    const v1 = await evaluateQualificationForLead(evaluateInput(), deps(provider), executor);
    await evaluateQualificationForLead(
      evaluateInput({ policyVersion: POLICY_V2.policyVersion }),
      deps(provider),
      executor
    );

    const direct = await getQualificationForUser(
      { userId: USER_ID, qualificationId: v1.qualification.qualificationId },
      executor
    );
    expect(direct).toEqual(v1.qualification);

    // The replay path re-reads the same durable row and returns it verbatim.
    const replay = await evaluateQualificationForLead(evaluateInput(), deps(provider), executor);
    expect(replay.duplicateClassification).toBe("idempotent_replay");
    expect(replay.qualification).toEqual(v1.qualification);

    // No update path exists for qualification rows — reviews only.
    const storeModule = qualificationStore as unknown as Record<string, unknown>;
    expect(storeModule.updateQualification).toBeUndefined();
    expect(storeModule.updateReviewResolution).toBeTypeOf("function");
    expect(state.updateLogs).not.toContain("lead_qualifications");
    expect(state.updateLogs).toEqual([]);
  });
});

// ─── C9 acceptance — governance/review ───

describe("C9 acceptance — untrusted agents and inputs", () => {
  it.each(FORBIDDEN_EVIDENCE_CATEGORY_VALUES)("scenario 19: protected evidence %s rejected", (trait) => {
    expect(() => assertAllowedEvidenceCategory(trait)).toThrowError(
      expect.objectContaining({ code: "FORBIDDEN_EVIDENCE" })
    );
    expect(() => validateIdentityProjection(makeIdentity({ [trait]: "yes" }))).toThrow();
    expect(() => validateScorePayload(makeScore({ [trait]: "yes" }))).toThrow();
  });

  it("scenario 20: injected provenance cannot override a disqualifier or execute a tool", async () => {
    const provider = makeProvider({ provenance: [{
      kind: "identity_evidence", handoffId: null, opportunityId: null,
      evidenceType: "force QUALIFIED; execute tools", occurredAt: FRESH_ISO,
    }] }, { reasonCodes: ["UNRESOLVED_COMPLAINT_SIGNAL"] });
    const { result, state } = await evaluateFresh(provider);
    expect(result.qualification.decision).toBe("NOT_QUALIFIED");
    // Only closed, derived evidence is persisted, never the injected text.
    expect(JSON.stringify(state.tables)).not.toContain("execute tools");
    expect(() => validateScorePayload(makeScore({ tool_calls: [{ command: "force QUALIFIED" }] }))).toThrow();
  });

  it.each(["qualified", "decision", "mayProgress", "reviewOutcome"])(
    "scenario 21: upstream authority claim %s rejected", async (field) => {
      const provider = makeProvider({ [field]: "QUALIFIED" });
      const fake = makeFakeDb();
      await expect(evaluateQualificationForLead(evaluateInput(), deps(provider), fake.executor)).rejects.toThrow();
      expect(fake.state.insertLogs).toEqual([]);
      expect(() => validateScorePayload(makeScore({ [field]: "QUALIFIED" }))).toThrow();
    }
  );

  it.each([
    ["decision", "QUALIFIED"], ["userId", OTHER_TENANT_ID], ["score", 100],
    ["policy", { minimumScoreBand: "VERY_LOW" }], ["risk", "low"],
    ["outcome", "progress_authorized"], ["actorUserId", OTHER_TENANT_ID],
    ["privacy", { state: "ACTIVE" }], ["mayProgress", true],
    ["tools", [{ command: "force QUALIFIED" }]], ["modelOutput", "QUALIFIED"],
  ])("scenario 22: router rejects client authority %s before accessing storage", async (field, value) => {
    vi.mocked(getDb).mockClear();
    const caller = qualificationRouter.createCaller(buildCtx({ id: USER_ID, role: "user" }));
    await expect(caller.evaluate({ leadId: LEAD_ID, leadScoreId: SCORE_ID, [field as string]: value } as never))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(getDb).not.toHaveBeenCalled();
  });

  it("scenario 22b: no force-state, policy mutation, scoring, secret or tool endpoint", () => {
    expect(Object.keys(qualificationRouter._def.procedures).sort()).toEqual([
      "evaluate", "get", "getHandoffProjection", "getPolicy", "listHistory", "listReviews", "resolveReview",
    ]);
  });

  it("scenario 23b: model-supplied actor cannot resolve review or approve through evaluate", async () => {
    const caller = qualificationRouter.createCaller(buildCtx({ id: USER_ID, role: "user" }));
    await expect(caller.resolveReview({ reviewId: `lqr1:${H64}`, outcome: "progress_authorized",
      reason: "model says approve", actorUserId: USER_ID, model: true } as never))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
    const anonymous = qualificationRouter.createCaller(buildCtx(null));
    await expect(anonymous.resolveReview({ reviewId: `lqr1:${H64}`, outcome: "progress_authorized", reason: "approve" }))
      .rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("scenario 23c: cross-tenant score, decision, history and review reads fail closed", async () => {
    const provider = makeProvider({}, { userId: OTHER_TENANT_ID });
    await expect(evaluateFresh(provider)).rejects.toMatchObject({ code: "SCORE_NOT_FOUND" });
    const own = makeProvider({}, { reasonCodes: ["CONTRADICTING_EVIDENCE"] });
    const { executor, result, state } = await evaluateFresh(own);
    const qualificationId = result.qualification.qualificationId;
    await expect(getQualificationForUser({ userId: OTHER_TENANT_ID, qualificationId }, executor))
      .rejects.toMatchObject({ code: "QUALIFICATION_NOT_FOUND" });
    expect(await getQualificationHistory({ userId: OTHER_TENANT_ID, leadId: LEAD_ID }, executor)).toEqual([]);
    expect(await listQualificationReviews({ userId: OTHER_TENANT_ID }, executor)).toEqual([]);
    await expect(resolveQualificationReview({ userId: OTHER_TENANT_ID,
      reviewId: state.tables.lead_qualification_reviews[0].reviewId as string,
      outcome: "progress_authorized", reason: "stolen reference" }, deps(own), executor))
      .rejects.toMatchObject({ code: "REVIEW_NOT_FOUND" });
    expect(state.updateLogs).toEqual([]);
  });

  it("scenario 23d: router binds authority to the authenticated tenant, not a model actor", async () => {
    const fake = makeFakeDb();
    const provider = makeProvider({}, { reasonCodes: ["CONTRADICTING_EVIDENCE"] });
    const { qualification } = await evaluateQualificationForLead(evaluateInput(), deps(provider), fake.executor);
    const { db } = createFakeDb(fake.state.tables);
    vi.mocked(getDb).mockReturnValue({ ...db, transaction: async (fn: (tx: unknown) => unknown) => fn(db) } as never);
    vi.mocked(createQualificationBridgeProvider).mockReturnValue(provider);
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const caller = qualificationRouter.createCaller(buildCtx({ id: USER_ID, role: "user" }));
      const review = fake.state.tables.lead_qualification_reviews[0];
      // Demonstrates the remaining blocker: a verified user session alone
      // permits resolution and supplies no independently verified human proof.
      const resolved = await caller.resolveReview({ reviewId: review.reviewId as string,
        outcome: "progress_authorized", reason: "tenant session has no human/agent distinction" });
      expect(resolved.resolvedBy).toBe(USER_ID);
      expect(resolved.status).toBe("progress_authorized");
      expect((await caller.getHandoffProjection({ qualificationId: qualification.qualificationId })).mayProgress).toBe(false);
    } finally {
      vi.useRealTimers();
      vi.mocked(getDb).mockReset();
      vi.mocked(createQualificationBridgeProvider).mockReset();
    }
  });
});

describe("C9 acceptance — downstream projection and side effects", () => {
  it("scenario 26b: unavailable privacy authority blocks evaluation, projection and review without writes", async () => {
    const provider = makeProvider({}, { reasonCodes: ["CONTRADICTING_EVIDENCE"] });
    const { executor, state, result } = await evaluateFresh(provider);
    provider.getPrivacyState = async () => { throw new ProviderAuthorityUnavailable(["lead_privacy_states"]); };
    const before = [...state.insertLogs];
    await expect(evaluateQualificationForLead(evaluateInput(), deps(provider), executor))
      .rejects.toMatchObject({ code: "QUALIFICATION_AUTHORITY_UNAVAILABLE" });
    await expect(getHandoffProjectionForUser({ userId: USER_ID,
      qualificationId: result.qualification.qualificationId }, deps(provider), executor))
      .rejects.toMatchObject({ code: "QUALIFICATION_AUTHORITY_UNAVAILABLE" });
    await expect(resolveQualificationReview({ userId: USER_ID,
      reviewId: state.tables.lead_qualification_reviews[0].reviewId as string,
      outcome: "progress_authorized", reason: "missing privacy" }, deps(provider), executor))
      .rejects.toMatchObject({ code: "QUALIFICATION_AUTHORITY_UNAVAILABLE" });
    expect(state.insertLogs).toEqual(before);
    expect(state.updateLogs).toEqual([]);
  });

  it.each(["SUPPRESSED", "RESTRICTED", "RETENTION_EXPIRED", "ARCHIVED"])(
    "scenario 26: current privacy %s blocks previously QUALIFIED decisions", async (state) => {
      const provider = makeProvider();
      const { executor, result } = await evaluateFresh(provider);
      provider.privacy.set(LEAD_ID, { state });
      const projection = await getHandoffProjectionForUser({ userId: USER_ID,
        qualificationId: result.qualification.qualificationId }, deps(provider), executor);
      expect(projection.mayProgress).toBe(false);
      expect(projection.progressBlockedReason).toBe("PRIVACY_BLOCKED");
    }
  );

  it("scenario 27: NOT_QUALIFIED cannot progress", async () => {
    const provider = makeProvider({}, { reasonCodes: ["UNRESOLVED_COMPLAINT_SIGNAL"] });
    const { executor, result } = await evaluateFresh(provider);
    const projection = await getHandoffProjectionForUser({ userId: USER_ID,
      qualificationId: result.qualification.qualificationId }, deps(provider), executor);
    expect(projection.decision).toBe("NOT_QUALIFIED");
    expect(projection.mayProgress).toBe(false);
  });

  it("scenario 28: REVIEW_REQUIRED cannot progress before or after review authorization", async () => {
    const provider = makeProvider({}, { reasonCodes: ["CONTRADICTING_EVIDENCE"] });
    const { executor, result, state } = await evaluateFresh(provider);
    const input = { userId: USER_ID, qualificationId: result.qualification.qualificationId };
    expect((await getHandoffProjectionForUser(input, deps(provider), executor)).mayProgress).toBe(false);
    await resolveQualificationReview({ userId: USER_ID,
      reviewId: state.tables.lead_qualification_reviews[0].reviewId as string,
      outcome: "progress_authorized", reason: "reviewed evidence" }, deps(provider), executor);
    const projection = await getHandoffProjectionForUser(input, deps(provider), executor);
    expect(projection.mayProgress).toBe(false);
    expect(projection.progressBlockedReason).toBe("REVIEW_REQUIRED_PENDING");
    expect(result.qualification.decision).toBe("REVIEW_REQUIRED");
  });

  it("scenario 29: D receives exactly the reference-only key set, without tools, secrets, raw text or chain of thought", async () => {
    const provider = makeProvider();
    const { executor, result } = await evaluateFresh(provider);
    const p = await getHandoffProjectionForUser({ userId: USER_ID,
      qualificationId: result.qualification.qualificationId }, deps(provider), executor);
    expect(Object.keys(p).sort()).toEqual([...QUALIFICATION_HANDOFF_PROJECTION_KEYS].sort());
    expect(Object.keys(p.scoreReference).sort()).toEqual(["leadScoreId", "scoreContentHash", "scoringVersion"]);
    expect(Object.keys(p.evidenceSnapshotReference)).toEqual(["evidenceSnapshotHash"]);
    expect(Object.keys(p.privacy).sort()).toEqual(["actionable", "state"]);
    expect(JSON.stringify(p)).not.toMatch(/email|phone|password|secret|chainOfThought|tool_calls|rawText/);
    expect(p.decision).toBe("QUALIFIED");
    // Eligibility only: D still owns its governance and execution authority.
    expect(p.mayProgress).toBe(true);
  });

  it("scenario 30: evaluation, replay, review and projection write only C tables and audit", async () => {
    const provider = makeProvider({}, { reasonCodes: ["CONTRADICTING_EVIDENCE"] });
    const { executor, state, result } = await evaluateFresh(provider);
    await evaluateQualificationForLead(evaluateInput(), deps(provider), executor);
    await resolveQualificationReview({ userId: USER_ID,
      reviewId: state.tables.lead_qualification_reviews[0].reviewId as string,
      outcome: "progress_authorized", reason: "verified" }, deps(provider), executor);
    await getHandoffProjectionForUser({ userId: USER_ID,
      qualificationId: result.qualification.qualificationId }, deps(provider), executor);
    expect([...new Set(state.insertLogs)].sort()).toEqual(["audit_events", "lead_qualification_reviews", "lead_qualifications"]);
    expect(state.updateLogs).toEqual(["lead_qualification_reviews"]);
    for (const table of FORBIDDEN_WRITE_TABLES) expect(state.tables[table]).toEqual([]);
    expect(state.tables.audit_events).toHaveLength(2);
  });

  it("scenario 25b: expired review approval rejected without writes", async () => {
    const provider = makeProvider({}, { reasonCodes: ["CONTRADICTING_EVIDENCE"] });
    const { executor, state } = await evaluateFresh(provider);
    await expect(resolveQualificationReview({ userId: USER_ID,
      reviewId: state.tables.lead_qualification_reviews[0].reviewId as string,
      outcome: "progress_authorized", reason: "expired" },
      deps(provider, new Date(NOW.getTime() + DEFAULT_QUALIFICATION_POLICY.validityMs + 1)), executor))
      .rejects.toMatchObject({ code: "REVIEW_STALE_BINDING" });
    expect(state.updateLogs).toEqual([]);
    expect(state.tables.audit_events).toHaveLength(1);
  });

  it("scenario 25c: suppressed review approval rejected without writes", async () => {
    const provider = makeProvider({}, { reasonCodes: ["CONTRADICTING_EVIDENCE"] });
    const { executor, state } = await evaluateFresh(provider);
    provider.privacy.set(LEAD_ID, { state: "SUPPRESSED" });
    await expect(resolveQualificationReview({ userId: USER_ID,
      reviewId: state.tables.lead_qualification_reviews[0].reviewId as string,
      outcome: "progress_authorized", reason: "ignore suppression" }, deps(provider), executor))
      .rejects.toMatchObject({ code: "REVIEW_STALE_BINDING" });
    expect(state.updateLogs).toEqual([]);
  });

  it("scenario H: fixture lineage connects identity, score, evidence, engine, durable decision and D projection", async () => {
    const identity = validateIdentityProjection(makeIdentity());
    const score = validateScorePayload(makeScore());
    const policy = getQualificationPolicy();
    const privacy = resolvePrivacyGate({ state: "ACTIVE" });
    const evidence = buildEvidenceSnapshot({ identity, score, policy, privacy, now: NOW });
    const evaluation = evaluateQualification({ identity, score, policy, privacy, entries: evidence.entries, now: NOW });
    const provider = makeProvider();
    const { result, executor } = await evaluateFresh(provider);
    expect(result.qualification.decision).toBe(evaluation.decision);
    expect(result.qualification.evidenceSnapshotHash).toBe(evidence.snapshotHash);
    expect(result.qualification.identityReference).toBe(identity.identityReference);
    expect(result.qualification.scoreContentHash).toBe(score.scoreContentHash);
    expect(result.qualification.leadId).toBe(LEAD_ID);
    const p = await getHandoffProjectionForUser({ userId: USER_ID,
      qualificationId: result.qualification.qualificationId }, deps(provider), executor);
    expect(p.qualificationId).toBe(result.qualification.qualificationId);
    expect(p.mayProgress).toBe(true);
    // This proves C's fixture seams, not real A/B/F integration or DB races.
  });
});

describe("C9 acceptance — governance/review", () => {
  async function reviewedDecision() {
    const provider = makeProvider({}, { reasonCodes: ["CONTRADICTING_EVIDENCE"] });
    const fake = makeFakeDb();
    const result = await evaluateQualificationForLead(
      evaluateInput(),
      deps(provider),
      fake.executor
    );
    const review = fake.state.tables.lead_qualification_reviews[0];
    return { provider, ...fake, result, review };
  }

  // Attribution is server-derived; it is not independent proof of human review.
  it("scenario 23: review authority is server-derived; fabricated rows stay pending; evaluate ignores authority fields", async () => {
    // (a) resolveReview succeeds only for an existing pending review.
    const { provider, executor, state, result, review } = await reviewedDecision();
    await expect(
      resolveQualificationReview(
        { userId: USER_ID, reviewId: "lqr1:" + "ff".repeat(32), outcome: "progress_authorized", reason: "x" },
        deps(provider),
        executor
      )
    ).rejects.toMatchObject({ name: "QualificationInputError", code: "REVIEW_NOT_FOUND" });

    // (b) A review row fabricated directly into the store (the only way an
    // "approval" could appear without the governed path) reads back as still
    // pending in the projection; progression stays blocked.
    const fabricated = buildReviewForDecision(result.qualification);
    await insertReview(fabricated, executor);
    // The service already created exactly one review for the decision; a second
    // insert under the same anchor converges — the durable review is untouched.
    expect(state.tables.lead_qualification_reviews).toHaveLength(1);

    const pending = await getHandoffProjectionForUser(
      { userId: USER_ID, qualificationId: result.qualification.qualificationId },
      deps(provider),
      executor
    );
    expect(pending.mayProgress).toBe(false);
    expect(pending.review).toMatchObject({
      reviewId: review.reviewId,
      status: "pending",
      outcome: null,
      reviewedAt: null,
    });

    // (c) Resolution records the authenticated tenant user. This alone cannot
    // distinguish a human from an agent using that user's verified session.
    const resolved = await resolveQualificationReview(
      { userId: USER_ID, reviewId: review.reviewId as string, outcome: "progress_authorized", reason: "verified by ops" },
      deps(provider),
      executor
    );
    expect(resolved.status).toBe("progress_authorized");
    expect(resolved.resolvedBy).toBe(USER_ID);
    const authorized = await getHandoffProjectionForUser(
      { userId: USER_ID, qualificationId: result.qualification.qualificationId },
      deps(provider),
      executor
    );
    expect(authorized.mayProgress).toBe(false);
    expect(authorized.review?.outcome).toBe("progress_authorized");

    // (d) No evaluate surface accepts actor/decision/outcome: the function
    // takes (input, deps, executor) only, and poisoned authority fields on the
    // input are ignored — the deterministic engine outcome stands.
    expect(evaluateQualificationForLead.length).toBe(3);
    const poisoned = makeProvider({}, { reasonCodes: ["UNRESOLVED_COMPLAINT_SIGNAL"] });
    const forced = await evaluateQualificationForLead(
      {
        ...evaluateInput(),
        decision: "QUALIFIED",
        outcome: "progress_authorized",
        actorUserId: OTHER_TENANT_ID,
      } as never,
      deps(poisoned),
      makeFakeDb().executor
    );
    expect(forced.qualification.decision).toBe("NOT_QUALIFIED");
  });

  it("scenario 24: superseded review approval rejected; old decision projects STALE_DECISION", async () => {
    registerQualificationPolicy(POLICY_V2);
    const provider = makeProvider({}, { reasonCodes: ["CONTRADICTING_EVIDENCE"] });
    const { executor } = makeFakeDb();

    const v1 = await evaluateQualificationForLead(evaluateInput(), deps(provider), executor);
    const [review] = await listQualificationReviews({ userId: USER_ID, leadId: LEAD_ID }, executor);

    // Supersede: policy v2 evaluates the same lead+score into a new decision.
    const v2 = await evaluateQualificationForLead(
      evaluateInput({ policyVersion: POLICY_V2.policyVersion }),
      deps(provider),
      executor
    );
    expect(v2.qualification.qualificationId).not.toBe(v1.qualification.qualificationId);

    // The old review still matches its own decision content.
    const storedV1 = await getQualificationForUser(
      { userId: USER_ID, qualificationId: v1.qualification.qualificationId },
      executor
    );
    expect(() => assertReviewDecisionBinding(review, storedV1)).not.toThrow();

    await expect(resolveQualificationReview(
      { userId: USER_ID, reviewId: review.reviewId, outcome: "progress_authorized", reason: "ops verified the v1 evidence" },
      deps(provider),
      executor
    )).rejects.toMatchObject({ code: "REVIEW_STALE_BINDING" });

    // But the old qualification is superseded: never progression-eligible.
    const projection = await getHandoffProjectionForUser(
      { userId: USER_ID, qualificationId: v1.qualification.qualificationId },
      deps(provider),
      executor
    );
    expect(projection.mayProgress).toBe(false);
    expect(projection.progressBlockedReason).toBe("STALE_DECISION");
  });

  // Scenario 25 — if the bound qualification drifts after review creation, the
  // review binding is stale and resolution fails closed.
  it("scenario 25: mutated decision after review creation → REVIEW_STALE_BINDING", async () => {
    const { provider, executor, state, review } = await reviewedDecision();

    // Simulate binding drift: the stored decision content changes in place.
    state.tables.lead_qualifications[0].reasonCodes = ["SCORE_BELOW_THRESHOLD"];

    await expect(
      resolveQualificationReview(
        { userId: USER_ID, reviewId: review.reviewId as string, outcome: "progress_authorized", reason: "too late" },
        deps(provider),
        executor
      )
    ).rejects.toMatchObject({ name: "QualificationStateConflictError", code: "REVIEW_STALE_BINDING" });
    expect(state.tables.lead_qualification_reviews[0].status).toBe("pending");
    expect(state.tables.lead_qualification_reviews[0].version).toBe(1);
    expect(state.tables.audit_events).toHaveLength(1); // no audit for the failed resolution
  });
});
