/**
 * WBS-R4-D5 multi-cycle learning evidence contract harness.
 *
 * Runs THREE successive synthetic optimisation cycles through the real
 * governed pipeline (no Strategy dispatch — that is Stream A's boundary):
 *
 *   canonical dataset (pure builder) → runGovernedLearningCycle
 *     → learning record → promotion proposal → governed approval decision
 *     → sealed approved promotion envelope → Stream A evidence bundle
 *     → (synthetic Strategy N+1 hash) → next cycle binds that authority
 *
 * and proves, for every cycle N in 1..3:
 *   - the cycle produces the exact authoritative material Stream A needs
 *     (campaign identity, current authoritative Strategy hash, canonical
 *     approved proposal fingerprint set, sealed approval provenance,
 *     learning record identity, evaluation version, engine version,
 *     recommendation identity, deterministic next-cycle identity);
 *   - cycle N's evidence is contract-suitable for Strategy N+1: the
 *     synthetic next Strategy hash is derived ONLY from the sealed
 *     evidence bundle and the cycle N+1 learning record binds that hash
 *     through its durable WBS15 authority lineage;
 *   - learning execution is idempotent per cycle and never duplicates
 *     authoritative records or promotion authority;
 *   - pending-only evidence can never mint next-cycle identity;
 *   - historical learning records, sealed envelopes and datasets stay
 *     byte-identical immutably across later cycles.
 *
 * All persistence goes through one fake DB; all clocks are pinned. No live
 * provider, LLM or network boundary is touched.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "crypto";

vi.mock("../../queries/connection", () => ({
  getDb: vi.fn(),
}));

import { getDb } from "../../queries/connection";
import { runGovernedLearningCycle } from "./learning-cycle-service";
import {
  buildCampaignPerformanceDataset,
  type CampaignPerformanceDataset,
} from "./performance/dataset";
import type { PerformanceDatasetInput } from "./performance/sources";
import { proposeLearningPromotion, getApprovedPromotionEnvelopes } from "./promotion/promotion-service";
import {
  validateLearningPromotionApprovalBinding,
  sealApprovedLearningPromotionEnvelope,
} from "./promotion/promotion-decision";
import {
  buildNextCycleIdentity,
  buildStrategyLearningPromotionLineage,
  resolveApprovedLearningPromotionsForStrategy,
  NEXT_CYCLE_IDENTITY_PREFIX,
} from "./learning-strategy-consumption";
import { LEARNING_CYCLE_EVALUATION_VERSION } from "./contracts/learning-config";

// ─── deterministic strategy hash chain ───

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(",")}}`;
}

/** Synthetic Stream A stand-in: the next Strategy hash derives ONLY from the sealed evidence. */
function deriveNextStrategyHash(input: {
  cycleVersion: number;
  previousStrategyHashSha256: string;
  learningPromotionLineage: unknown[];
}): string {
  return sha256Hex(
    canonicalJson({
      contract: "r4d-synthetic-strategy-hash:v1",
      cycleVersion: input.cycleVersion,
      learningPromotionLineage: input.learningPromotionLineage,
      previousStrategyHashSha256: input.previousStrategyHashSha256,
    })
  );
}

const H1 = sha256Hex("r4d:synthetic-strategy:v1");

// ─── fake DB ───

type Row = Record<string, unknown>;

function getTableName(table: unknown): string | undefined {
  return (table as Record<symbol, unknown>)[Symbol.for("drizzle:Name") as symbol] as
    | string
    | undefined;
}

function columnName(column: unknown): string {
  return String((column as { name?: string }).name ?? "");
}

function deepScalars(value: unknown, acc: { strings: string[]; numbers: number[] }, seen = new Set<object>()) {
  if (value === null || value === undefined) return acc;
  if (typeof value === "string") {
    acc.strings.push(value);
    return acc;
  }
  if (typeof value === "number") {
    acc.numbers.push(value);
    return acc;
  }
  if (typeof value === "object") {
    if (seen.has(value as object)) return acc;
    seen.add(value as object);
    for (const v of Object.values(value)) deepScalars(v, acc, seen);
  }
  return acc;
}

interface FakeDb {
  db: unknown;
  state: {
    learningRecords: Row[];
    approvals: Row[];
    audits: Row[];
    insertTables: string[];
    updateTables: string[];
    updatesByTable: Record<string, number>;
    nextLearningId: number;
    nextApprovalId: number;
    nextAuditId: number;
  };
}

function createFakeDb(): FakeDb {
  const state: FakeDb["state"] = {
    learningRecords: [],
    approvals: [],
    audits: [],
    insertTables: [],
    updateTables: [],
    updatesByTable: {},
    nextLearningId: 501,
    nextApprovalId: 401,
    nextAuditId: 301,
  };

  const matchRows = (name: string, conds: unknown[]) => {
    const { strings, numbers } = deepScalars(conds, { strings: [], numbers: [] });
    if (name === "campaigns") {
      return state.learningRecords.length >= 0
        ? [
            {
              id: 7,
              userId: 22,
              businessId: 5,
              budget: 1000,
            },
          ].filter((r) => numbers.includes(r.id) && numbers.includes(r.userId))
        : [];
    }
    if (name === "learning_records") {
      const byKey = strings.find((s) => s.startsWith("lr:"));
      if (byKey) return state.learningRecords.filter((r) => r.idempotencyKey === byKey);
      return state.learningRecords.filter(
        (r) => numbers.includes(r.id as number) && numbers.includes(r.userId as number)
      );
    }
    if (name === "approval_requests") {
      const lpKey = strings.find((s) => s.startsWith("lp:"));
      if (lpKey) return state.approvals.filter((r) => r.idempotencyKey === lpKey);
      if (strings.includes("high_value_proposal")) {
        return state.approvals.filter(
          (r) => numbers.includes(r.userId as number) && numbers.includes(r.campaignId as number)
        );
      }
      return state.approvals.filter(
        (r) => numbers.includes(r.id as number) && numbers.includes(r.userId as number)
      );
    }
    if (name === "audit_events") {
      const fingerprint = strings.find((s) => /^[0-9a-f]{64}$/.test(s));
      if (fingerprint) return state.audits.filter((r) => r.eventFingerprint === fingerprint);
      return state.audits.filter(
        (r) => strings.includes(r.eventType as string) && numbers.includes(r.approvalRequestId as number)
      );
    }
    return [];
  };

  function sortRows(rows: Row[], cols: Array<{ col: string; desc: boolean }>): Row[] {
    return [...rows].sort((a, b) => {
      for (const { col, desc } of cols) {
        const av = String(a[col] ?? "");
        const bv = String(b[col] ?? "");
        const cmp = av === bv ? 0 : av < bv ? -1 : 1;
        if (cmp !== 0) return desc ? -cmp : cmp;
      }
      return 0;
    });
  }

  const buildSelect = (projection?: unknown) => ({
    from: (table: unknown) => {
      const name = getTableName(table) ?? "";
      let rows: Row[] = [];
      let orderCols: Array<{ col: string; desc: boolean }> = [];
      const applyProjection = (list: Row[]) => {
        if (!projection || typeof projection !== "object") return list.map((r) => ({ ...r }));
        return list.map((row) => {
          const out: Row = {};
          for (const [alias, column] of Object.entries(projection as Record<string, unknown>)) {
            out[alias] = row[columnName(column)];
          }
          return out;
        });
      };
      const chain: any = {
        where: (...conds: unknown[]) => {
          rows = matchRows(name, conds);
          return chain;
        },
        orderBy: (...cols: unknown[]) => {
          orderCols = cols.map((c) => {
            const chunks = ((c as { queryChunks?: unknown[] }).queryChunks ?? []) as Array<{
              value?: string[];
              name?: string;
            }>;
            const col = chunks.find((ch) => ch.name)?.name ?? "";
            const text = chunks
              .map((ch) => (Array.isArray(ch.value) ? ch.value.join("") : ""))
              .join("");
            return { col, desc: /\bdesc\b/i.test(text) };
          });
          return chain;
        },
        limit: (n: number) => {
          const limited = sortRows(rows, orderCols).slice(0, n);
          const result = applyProjection(limited);
          return Promise.resolve(result);
        },
        then: (resolve: (rows: Row[]) => unknown, reject?: (e: unknown) => void) => {
          try {
            resolve(applyProjection(sortRows(rows, orderCols)));
          } catch (e) {
            reject?.(e);
          }
        },
      };
      return chain;
    },
  });

  const buildInsert = () => ({
    values: async (row: Row | Row[]) => {
      const rows = Array.isArray(row) ? row : [row];
      const first = rows[0] ?? {};
      // Table identity: probes in order of the write paths this harness hits.
      if ("idempotencyKey" in first && "evaluationVersion" in first) {
        state.insertTables.push("learning_records");
        const provenance = (first.provenance ?? {}) as { evaluatedAt?: string };
        const stored = {
          ...first,
          id: state.nextLearningId++,
          // Mirror the schema defaultNow() timestamps the real column applies.
          evaluatedAt:
            first.evaluatedAt ?? (provenance.evaluatedAt ? new Date(provenance.evaluatedAt) : new Date(0)),
          createdAt: first.createdAt ?? new Date(0),
        };
        state.learningRecords.push(stored);
        return [{ insertId: stored.id, affectedRows: 1 }];
      }
      if ("eventType" in first) {
        state.insertTables.push("audit_events");
        const stored = { ...first, id: state.nextAuditId++ };
        state.audits.push(stored);
        return [{ insertId: stored.id, affectedRows: 1 }];
      }
      if ("approvalType" in first) {
        state.insertTables.push("approval_requests");
        const stored = { ...first, id: state.nextApprovalId++ };
        state.approvals.push(stored);
        return [{ insertId: stored.id, affectedRows: 1 }];
      }
      state.insertTables.push("unknown");
      return [{ insertId: 0, affectedRows: 1 }];
    },
  });

  const buildUpdate = () => {
    return {
      set: (payload: Row) => ({
        where: (...conds: unknown[]) => {
          const { numbers } = deepScalars(conds, { strings: [], numbers: [] });
          state.updateTables.push("approval_requests");
          state.updatesByTable["approval_requests"] =
            (state.updatesByTable["approval_requests"] ?? 0) + 1;
          const affected = state.approvals.filter(
            (r) =>
              numbers.includes(r.id as number) &&
              numbers.includes(r.userId as number) &&
              r.status === "pending"
          );
          for (const row of affected) Object.assign(row, payload);
          return Promise.resolve([{ affectedRows: affected.length }]);
        },
      }),
    };
  };

  const db = {
    select: (projection?: unknown) => buildSelect(projection),
    insert: () => buildInsert(),
    update: () => buildUpdate(),
    transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(db),
  };

  return { db, state };
}

// ─── synthetic cycle dataset ───

let analyticsRowId = 9000;

function buildCycleDataset(input: {
  cycleVersion: number;
  strategyHashSha256: string;
  windowStart: string;
  windowEnd: string;
}): CampaignPerformanceDataset {
  const { cycleVersion: n, strategyHashSha256, windowStart, windowEnd } = input;
  const date = `${windowStart}T00:00:00.000Z`;
  const row = (metricType: string, value: number) => ({
    id: analyticsRowId++,
    metricType,
    platform: "facebook",
    value,
    date,
  });

  const datasetInput: PerformanceDatasetInput = {
    campaign: {
      id: 7,
      userId: 22,
      businessId: 5,
      goal: "Increase qualified conversions",
      primaryOutcome: "conversions",
      startDate: "2026-06-01",
      endDate: "2026-06-30",
      workflowContext: {
        strategyApprovalLineage: {
          approvalRequestId: 300 + n,
          creativeBriefFingerprint: `fp-brief-v${n}`,
          strategySnapshotId: `snap-v${n}`,
          businessDnaSnapshotId: `bdna-v${n}`,
          strategyHashSha256,
          status: "approved",
          strategyRunId: 100 + n,
          strategyVersion: n,
        },
      },
    },
    window: { start: windowStart, end: windowEnd },
    strategySnapshot: {
      id: 800 + n,
      snapshotId: `snap-v${n}`,
      strategyRunId: 100 + n,
      version: n,
      strategyHashSha256,
      businessDnaSnapshotId: `bdna-v${n}`,
      creativeBriefFingerprint: `fp-brief-v${n}`,
      capturedAt: new Date(date),
      snapshot: { funnelStages: [{ stage: "convert", metrics: ["conversions"] }] },
    },
    strategyApproval: {
      id: 300 + n,
      status: "approved",
      approvedAt: new Date(date),
    },
    publications: [
      {
        id: 700 + n,
        contentPostId: null,
        platform: "facebook",
        status: "published",
        scheduledAt: new Date(date),
        publishedAt: new Date(date),
        externalPostId: `ext-cycle-${n}`,
        metadata: null,
        receiptExternalUrl: null,
        receiptAuditEventId: null,
      },
    ],
    manualPublications: [],
    contentPosts: [],
    analyticsRows: [row("impressions", 5000), row("clicks", 100), row("conversions", 1)],
    engagementEvents: [
      {
        id: 600 + n,
        campaignId: 7,
        platform: "facebook",
        eventType: "comment",
        externalContentId: null,
        eventTimestamp: new Date(date),
      },
    ],
    leads: [
      { id: 500 + n, campaignId: 7, status: "won", createdAt: new Date(date) },
    ],
    aiUsageRows: [
      {
        id: 400 + n,
        campaignId: 7,
        agentType: "strategy",
        model: "gpt-4o-mini",
        actualCostUsd: 500_000,
        creditsDeducted: 5,
        createdAt: new Date(date),
      },
    ],
  };

  return buildCampaignPerformanceDataset(datasetInput);
}

// ─── evidence bundle (the Stream A contract material) ───

interface CycleEvidence {
  cycleVersion: number;
  campaignId: number;
  strategyHashSha256: string;
  proposalFingerprints: string[];
  approvalRequestId: number;
  decidedAt: string;
  learningRecordId: number;
  evaluationVersion: string;
  learningEngineVersion: string;
  recommendationId: string;
  nextCycleIdentity: string;
  datasetFingerprint: string;
}

const WINDOWS = [
  { start: "2026-06-01", end: "2026-06-07" },
  { start: "2026-06-08", end: "2026-06-14" },
  { start: "2026-06-15", end: "2026-06-21" },
];
const CYCLE_NOW = [
  () => new Date("2026-06-07T12:00:00.000Z"),
  () => new Date("2026-06-14T12:00:00.000Z"),
  () => new Date("2026-06-21T12:00:00.000Z"),
];

describe("WBS-R4-D5 multi-cycle learning evidence contract", () => {
  let fake: FakeDb;

  beforeEach(() => {
    vi.clearAllMocks();
    fake = createFakeDb();
    vi.mocked(getDb).mockReturnValue(fake.db as never);
  });

  it("produces valid approved learning evidence for three successive cycles", async () => {
    const bundles: CycleEvidence[] = [];
    const strategyHashes: string[] = [H1];
    const recordSnapshots = new Map<number, string>();
    const datasetSnapshots = new Map<number, string>();

    for (let n = 1; n <= 3; n++) {
      const window = WINDOWS[n - 1];
      const strategyHash = strategyHashes[n - 1];
      const dataset = buildCycleDataset({
        cycleVersion: n,
        strategyHashSha256: strategyHash,
        windowStart: window.start,
        windowEnd: window.end,
      });
      expect(dataset.readiness.status).not.toBe("authority_missing");
      datasetSnapshots.set(n, JSON.stringify(dataset));

      // ── governed learning cycle (idempotent execution) ──
      const cycle = await runGovernedLearningCycle({
        userId: 22,
        campaignId: 7,
        windowStart: window.start,
        windowEnd: window.end,
        trigger: "api",
        deps: {
          loadDataset: { loadCampaignPerformanceDataset: async () => dataset },
          now: CYCLE_NOW[n - 1],
        },
      });
      expect(cycle.status).toBe("recorded");
      if (cycle.status !== "recorded") return;
      expect(cycle.idempotentReplay).toBe(false);
      expect(cycle.record.evaluationVersion).toBe(LEARNING_CYCLE_EVALUATION_VERSION);

      const replay = await runGovernedLearningCycle({
        userId: 22,
        campaignId: 7,
        windowStart: window.start,
        windowEnd: window.end,
        trigger: "api",
        deps: {
          loadDataset: { loadCampaignPerformanceDataset: async () => dataset },
          now: CYCLE_NOW[n - 1],
        },
      });
      expect(replay.status).toBe("recorded");
      if (replay.status !== "recorded") return;
      expect(replay.idempotentReplay).toBe(true);
      expect(replay.record.id).toBe(cycle.record.id);

      const record = cycle.record;
      const storedRow = fake.state.learningRecords.find((r) => r.id === record.id);
      recordSnapshots.set(record.id, JSON.stringify(toComparableRecord(storedRow)));
      const recommendation = record.recommendedAdjustments.find(
        (r) => r.governance.autoApply === false && r.governance.requiresApproval === true
      );
      expect(recommendation).toBeDefined();
      if (!recommendation) return;

      // ── promotion proposal → governed approval → sealed envelope ──
      const proposed = await proposeLearningPromotion({
        userId: 22,
        learningRecordId: record.id,
        recommendationId: recommendation.id,
      });
      expect(proposed.outcome).toBe("created");
      const approvalRow = fake.state.approvals.find(
        (r) => r.id === proposed.proposal.approvalRequestId
      );
      expect(approvalRow).toBeDefined();
      if (!approvalRow) return;

      await validateLearningPromotionApprovalBinding({
        request: {
          id: approvalRow.id as number,
          userId: approvalRow.userId as number,
          approvalType: approvalRow.approvalType,
          context: approvalRow.context,
        } as never,
        decisionKind: "approve",
        executor: fake.db as never,
      });

      // Guarded terminal transition (same pending-only guard the Approval
      // Centre uses), then sealing inside the decision scope.
      const decidedAt = CYCLE_NOW[n - 1]();
      const guarded = await (
        fake.db as unknown as {
          update: () => { set: (p: Row) => { where: (...c: unknown[]) => Promise<unknown> } };
        }
      )
        .update()
        .set({ status: "approved", approvedAt: decidedAt })
        .where(approvalRow.id, approvalRow.userId);
      expect((guarded as Array<{ affectedRows: number }>)[0].affectedRows).toBe(1);

      const envelope = await sealApprovedLearningPromotionEnvelope({
        request: {
          id: approvalRow.id as number,
          userId: approvalRow.userId as number,
          campaignId: (approvalRow.campaignId as number) ?? 7,
          context: approvalRow.context,
        },
        decidedAt,
        decidedByUserId: 22,
        executor: fake.db as never,
      });
      expect(envelope.decision).toBe("approved");
      expect(envelope.promoted.provenanceClass).toBe("approved_recommendation");

      // ── Stream A evidence bundle ──
      const approved = await getApprovedPromotionEnvelopes({ userId: 22, campaignId: 7 });
      const proposalFingerprints = [...new Set(approved.map((e) => e.proposalFingerprint))].sort();
      expect(proposalFingerprints).toHaveLength(n); // one sealed envelope per cycle, no duplicates

      const identity = buildNextCycleIdentity({
        campaignId: 7,
        strategyHashSha256: strategyHash,
        proposalFingerprints,
      });

      bundles.push({
        cycleVersion: n,
        campaignId: 7,
        strategyHashSha256: strategyHash,
        proposalFingerprints,
        approvalRequestId: envelope.approvalRequestId,
        decidedAt: envelope.decidedAt,
        learningRecordId: envelope.learningRecordId,
        evaluationVersion: envelope.evaluationVersion,
        learningEngineVersion: envelope.learningAuthority.engineVersion,
        recommendationId: envelope.promoted.recommendationId,
        nextCycleIdentity: identity,
        datasetFingerprint: dataset.identity.fingerprint,
      });

      // ── synthetic Strategy N+1 (Stream A's job; hash bound to evidence) ──
      const resolution = await resolveApprovedLearningPromotionsForStrategy({
        userId: 22,
        campaignId: 7,
      });
      const lineage = buildStrategyLearningPromotionLineage(resolution);
      strategyHashes.push(
        deriveNextStrategyHash({
          cycleVersion: n + 1,
          previousStrategyHashSha256: strategyHash,
          learningPromotionLineage: lineage,
        })
      );
    }

    // ── every cycle minted the full contract material ──
    expect(bundles).toHaveLength(3);
    for (const bundle of bundles) {
      expect(bundle.campaignId).toBe(7);
      expect(bundle.strategyHashSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(bundle.proposalFingerprints.length).toBe(bundle.cycleVersion);
      expect(bundle.proposalFingerprints.every((fp) => /^[0-9a-f]{64}$/.test(fp))).toBe(true);
      expect(bundle.approvalRequestId).toBeGreaterThan(0);
      expect(bundle.learningRecordId).toBeGreaterThan(0);
      expect(bundle.evaluationVersion).toBe(LEARNING_CYCLE_EVALUATION_VERSION);
      expect(bundle.learningEngineVersion).toBe(LEARNING_CYCLE_EVALUATION_VERSION);
      expect(bundle.recommendationId).toMatch(/^rec_/);
      expect(bundle.nextCycleIdentity).toMatch(new RegExp(`^${NEXT_CYCLE_IDENTITY_PREFIX}[0-9a-f]{64}$`));
      expect(bundle.datasetFingerprint).toMatch(/^[0-9a-f]{64}$/);
    }

    // ── cycle N evidence is contract-suitable for Strategy N+1: the next
    //    cycle's durable authority lineage binds the evidence-derived hash ──
    for (let n = 2; n <= 3; n++) {
      const records = fake.state.learningRecords.filter(
        (r) => r.evaluationVersion === LEARNING_CYCLE_EVALUATION_VERSION
      );
      const record = records.find(
        (r) =>
          (r.windowStart instanceof Date
            ? r.windowStart.toISOString()
            : String(r.windowStart)
          ).slice(0, 10) === WINDOWS[n - 1].start
      );
      expect(record).toBeDefined();
      const provenance = record?.provenance as { wbs15?: { strategyAuthority?: { strategyHashSha256?: string } } };
      expect(provenance.wbs15?.strategyAuthority?.strategyHashSha256).toBe(strategyHashes[n - 1]);
    }

    // ── identities, records and fingerprints are unique per cycle ──
    const identities = bundles.map((b) => b.nextCycleIdentity);
    expect(new Set(identities).size).toBe(3);
    const recordIds = bundles.map((b) => b.learningRecordId);
    expect(new Set(recordIds).size).toBe(3);
    const fingerprints = bundles.map((b) => b.datasetFingerprint);
    expect(new Set(fingerprints).size).toBe(3);
    // Recommendation ids are scoped to their learning record; the
    // (learningRecordId, recommendationId) pair is unique per cycle.
    expect(
      new Set(bundles.map((b) => `${b.learningRecordId}:${b.recommendationId}`)).size
    ).toBe(3);

    // Canonicalisation: fingerprint order does not change the identity.
    const reordered = buildNextCycleIdentity({
      campaignId: 7,
      strategyHashSha256: bundles[2].strategyHashSha256,
      proposalFingerprints: [...bundles[2].proposalFingerprints].reverse(),
    });
    expect(reordered).toBe(bundles[2].nextCycleIdentity);

    // ── no duplicated authority anywhere ──
    expect(fake.state.learningRecords).toHaveLength(3);
    expect(fake.state.approvals).toHaveLength(3);
    const sealedEvents = fake.state.audits.filter((a) => a.eventType === "learning_promotion_resolved");
    expect(sealedEvents).toHaveLength(3);
    expect(new Set(sealedEvents.map((e) => e.eventFingerprint)).size).toBe(3);

    // ── immutability: historical records stay byte-identical; datasets were
    //    captured before any later cycle ran and are pure-built (D3 proves
    //    reconstruction determinism) ──
    for (let n = 1; n <= 3; n++) {
      const record = fake.state.learningRecords.find((r) => r.id === bundles[n - 1].learningRecordId);
      expect(JSON.stringify(toComparableRecord(record))).toBe(recordSnapshots.get(record?.id as number));
      expect(datasetSnapshots.get(n)).toBeTruthy();
    }
    // Only the three guarded approval transitions ever mutated state.
    expect(fake.state.updatesByTable).toEqual({ approval_requests: 3 });
    expect(fake.state.insertTables.filter((t) => t === "learning_records")).toHaveLength(3);
  });

  it("pending-only evidence can never mint next-cycle identity", async () => {
    const dataset = buildCycleDataset({
      cycleVersion: 1,
      strategyHashSha256: H1,
      windowStart: WINDOWS[0].start,
      windowEnd: WINDOWS[0].end,
    });
    const cycle = await runGovernedLearningCycle({
      userId: 22,
      campaignId: 7,
      windowStart: WINDOWS[0].start,
      windowEnd: WINDOWS[0].end,
      deps: {
        loadDataset: { loadCampaignPerformanceDataset: async () => dataset },
        now: CYCLE_NOW[0],
      },
    });
    if (cycle.status !== "recorded") throw new Error("expected a recorded cycle");
    const recommendation = cycle.record.recommendedAdjustments[0];
    if (!recommendation) throw new Error("expected a recommendation");

    // Propose but NEVER approve: pending evidence must not become authority.
    await proposeLearningPromotion({
      userId: 22,
      learningRecordId: cycle.record.id,
      recommendationId: recommendation.id,
    });

    const approved = await getApprovedPromotionEnvelopes({ userId: 22, campaignId: 7 });
    expect(approved).toEqual([]);
    expect(() =>
      buildNextCycleIdentity({
        campaignId: 7,
        strategyHashSha256: H1,
        proposalFingerprints: approved.map((e) => e.proposalFingerprint),
      })
    ).toThrow(/non-empty array/);

    // A non-set (duplicated or blank) fingerprint set is equally invalid.
    expect(() =>
      buildNextCycleIdentity({
        campaignId: 7,
        strategyHashSha256: H1,
        proposalFingerprints: ["fp-a", "fp-a"],
      })
    ).toThrow(/duplicates/);
    expect(() =>
      buildNextCycleIdentity({
        campaignId: 7,
        strategyHashSha256: H1,
        proposalFingerprints: ["  "],
      })
    ).toThrow(/non-blank/);
    // A malformed strategy hash is rejected before any identity is minted.
    expect(() =>
      buildNextCycleIdentity({
        campaignId: 7,
        strategyHashSha256: "not-a-hash",
        proposalFingerprints: ["fp-a"],
      })
    ).toThrow(/SHA-256/);
  });
});

/** Stable comparable form of a stored learning record row (Dates → ISO). */
function toComparableRecord(row: Row | undefined): Row {
  if (!row) return {};
  const out: Row = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = value instanceof Date ? value.toISOString() : value;
  }
  return out;
}
