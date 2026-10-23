/**
 * WBS-R4-D3 adversarial tests: KPI/performance dataset authority.
 *
 * Proves at the repository loader boundary that the canonical
 * CampaignPerformanceDataset:
 * - is materialised from strictly user+campaign scoped reads (no cross-user,
 *   cross-campaign or cross-business contamination, including corrupted rows
 *   carrying another user's id on this campaign's id);
 * - binds the CURRENT strategy authority (latest version of THIS campaign,
 *   approval evidence included) and never a sibling campaign's snapshot;
 * - resolves a deterministic evaluation window and a deterministic dataset
 *   identity (identical fingerprint across repeated loads — retry-safe
 *   materialisation);
 * - fails closed on incomplete lineage (missing strategy snapshot →
 *   authority_missing; unapproved lineage → required issue).
 *
 * Fake DB interprets the exact drizzle shapes the loader emits, including
 * or()/inArray()/orderBy(desc()). No live database.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../queries/connection", () => ({
  getDb: vi.fn(),
}));

import { getDb } from "../../../queries/connection";
import { loadCampaignPerformanceDataset } from "./loader";

// ─── fake DB ───

type Row = Record<string, unknown>;

function tableName(table: unknown): string {
  return String(
    (table as Record<symbol, unknown>)[Symbol.for("drizzle:Name") as symbol] ?? "unknown"
  );
}

function columnName(column: unknown): string {
  return String((column as { name?: string }).name ?? "");
}

function stringChunkValue(chunk: unknown): string {
  const value = (chunk as { value?: unknown }).value;
  return Array.isArray(value) ? value.join("") : "";
}

function isSql(value: unknown): boolean {
  return Boolean((value as { queryChunks?: unknown })?.queryChunks);
}

function isParamChunk(chunk: unknown): boolean {
  const c = chunk as { value?: unknown; name?: string } | null;
  return (
    c !== null &&
    typeof c === "object" &&
    !Array.isArray(c.value) &&
    c.value !== undefined &&
    !c.name &&
    !isSql(c)
  );
}

interface ClauseGroup {
  connector: "and" | "or";
  chunks: unknown[];
}

function clauseGroups(cond: unknown): ClauseGroup[] {
  const chunks = (cond as { queryChunks?: unknown[] }).queryChunks ?? [];
  const groups: ClauseGroup[] = [];
  let current: ClauseGroup = { connector: "and", chunks: [] };

  const flush = () => {
    if (current.chunks.length > 0) groups.push(current);
  };

  for (const chunk of chunks) {
    const text = stringChunkValue(chunk);
    if (text === " and " || text === " or ") {
      flush();
      current = { connector: text.trim() as "and" | "or", chunks: [] };
      continue;
    }
    if (text === "(" || text === ")") continue;
    if (isSql(chunk)) {
      // Nested SQL (and()/or() wrappers): splice groups into the stream.
      const nested = clauseGroups(chunk);
      if (nested.length > 0) {
        current.chunks.push(...nested[0].chunks);
        for (let i = 1; i < nested.length; i++) {
          flush();
          current = { connector: nested[i].connector, chunks: [...nested[i].chunks] };
        }
      }
      continue;
    }
    current.chunks.push(chunk);
  }
  flush();
  return groups;
}

function evalSimple(chunks: unknown[], row: Row): boolean {
  const colChunk = chunks.find((c) => (c as { name?: string })?.name);
  const op = chunks
    .filter((c) => Array.isArray((c as { value?: unknown }).value))
    .map((c) => ((c as { value: string[] }).value ?? []).join(""))
    .join("");
  const col = columnName(colChunk);
  const params: unknown[] = [];
  for (const c of chunks) {
    if (isParamChunk(c)) params.push((c as { value: unknown }).value);
    else if (Array.isArray(c)) {
      params.push(...c.filter(isParamChunk).map((p) => (p as { value: unknown }).value));
    }
  }

  if (op.includes("is not null")) return row[col] !== null && row[col] !== undefined;
  if (op.includes("is null")) return row[col] === null || row[col] === undefined;
  if (op.includes(" in ")) return params.some((p) => row[col] === p);
  if (op.includes("=")) return row[col] === params[0];
  throw new Error(`unsupported fake-db operator: ${op}`);
}

/**
 * Clause groups chain left to right: a group marked "or" joins the running
 * result disjunctively, "and" conjunctively. This matches the loader's
 * and(userScope, or(campaignScope, isNull)) shapes.
 */
function evalCondition(cond: unknown, row: Row): boolean {
  const groups = clauseGroups(cond);
  if (groups.length === 0) return true;
  let result = evalSimple(groups[0].chunks, row);
  for (let i = 1; i < groups.length; i++) {
    const value = evalSimple(groups[i].chunks, row);
    result = groups[i].connector === "or" ? result || value : result && value;
  }
  return result;
}

function createFakeDb() {
  const tables: Record<string, Row[]> = {
    campaigns: [],
    analytics: [],
    strategy_snapshots: [],
    approval_requests: [],
    publishing_queue: [],
    audit_events: [],
    content_posts: [],
    social_engagement_events: [],
    leads: [],
    ai_usage: [],
  };

  const db = {
    rows: tables,
    select() {
      let table = "";
      let filtered: Row[] = [];
      let orderCol = "";
      let orderDesc = false;
      let limitN: number | null = null;

      const builder = {
        from(t: unknown) {
          table = tableName(t);
          filtered = tables[table] ?? [];
          return builder;
        },
        where(cond: unknown) {
          filtered = filtered.filter((row) => evalCondition(cond, row));
          return builder;
        },
        orderBy(col: unknown) {
          // drizzle's desc()/asc() are plain SQL wrappers: the column and the
          // direction keyword both ride inside queryChunks.
          const chunks = ((col as { queryChunks?: unknown[] }).queryChunks ?? []);
          orderCol = columnName(chunks.find((c) => (c as { name?: string })?.name));
          const text = chunks
            .map((c) =>
              Array.isArray((c as { value?: unknown }).value)
                ? ((c as { value: string[] }).value ?? []).join("")
                : ""
            )
            .join("");
          orderDesc = /\bdesc\b/i.test(text);
          return builder;
        },
        limit(n: number) {
          limitN = n;
          return builder;
        },
        then(resolve: (rows: Row[]) => unknown, reject?: (e: unknown) => void) {
          try {
            let rows = filtered;
            if (orderCol) {
              rows = [...rows].sort((a, b) => {
                const av = String(a[orderCol] ?? "");
                const bv = String(b[orderCol] ?? "");
                const cmp = av < bv ? -1 : av > bv ? 1 : 0;
                return orderDesc ? -cmp : cmp;
              });
            }
            if (limitN !== null) rows = rows.slice(0, limitN);
            resolve(rows);
          } catch (e) {
            reject?.(e);
          }
        },
      };
      return builder;
    },
  };
  return db;
}

// ─── fixtures ───

const HASH_V1 = "a".repeat(64);
const HASH_V2 = "b".repeat(64);
const HASH_OTHER_CAMPAIGN = "c".repeat(64);
const HASH_OTHER_USER = "d".repeat(64);

function approvedLineage(approvalRequestId: number, strategyHashSha256: string) {
  return {
    strategyApprovalLineage: {
      approvalRequestId,
      creativeBriefFingerprint: "fp-brief",
      strategySnapshotId: "snap-x",
      businessDnaSnapshotId: "bdna-x",
      strategyHashSha256,
      status: "approved",
      strategyRunId: 11,
      strategyVersion: 2,
    },
  };
}

describe("loadCampaignPerformanceDataset authority & isolation (WBS-R4-D3)", () => {
  let db: ReturnType<typeof createFakeDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createFakeDb();
    vi.mocked(getDb).mockReturnValue(db as never);

    // user 42, business 7: campaign 29 (approved strategy authority)
    db.rows.campaigns.push({
      id: 29,
      userId: 42,
      businessId: 7,
      goal: "Increase walk-ins",
      primaryOutcome: "conversions",
      startDate: new Date("2026-06-01T00:00:00.000Z"),
      endDate: new Date("2026-06-30T00:00:00.000Z"),
      workflowContext: approvedLineage(33, HASH_V2),
    });
    // user 42, business 8: sibling campaign 30 (pending lineage)
    db.rows.campaigns.push({
      id: 30,
      userId: 42,
      businessId: 8,
      goal: "Other business goal",
      primaryOutcome: null,
      startDate: new Date("2026-06-01T00:00:00.000Z"),
      endDate: new Date("2026-06-30T00:00:00.000Z"),
      workflowContext: {
        strategyApprovalLineage: {
          ...approvedLineage(44, HASH_OTHER_CAMPAIGN).strategyApprovalLineage,
          status: "pending_review",
          strategyVersion: 1,
        },
      },
    });
    // user 42, no business: campaign 31 (no strategy snapshot at all)
    db.rows.campaigns.push({
      id: 31,
      userId: 42,
      businessId: null,
      goal: "Unstrategised campaign",
      primaryOutcome: null,
      startDate: new Date("2026-06-01T00:00:00.000Z"),
      endDate: new Date("2026-06-30T00:00:00.000Z"),
      workflowContext: {},
    });
    // user 99, business 7 (same business id number, different owner): campaign 77
    db.rows.campaigns.push({
      id: 77,
      userId: 99,
      businessId: 7,
      goal: "Foreign tenant campaign",
      primaryOutcome: null,
      startDate: new Date("2026-06-01T00:00:00.000Z"),
      endDate: new Date("2026-06-30T00:00:00.000Z"),
      workflowContext: {},
    });

    // Analytics: one row per scope, values distinguish the winner.
    db.rows.analytics.push(
      { id: 1, userId: 42, campaignId: 29, metricType: "impressions", value: 100, platform: "facebook", date: new Date("2026-06-10T00:00:00.000Z"), createdAt: new Date() },
      { id: 2, userId: 42, campaignId: 30, metricType: "impressions", value: 999, platform: "facebook", date: new Date("2026-06-10T00:00:00.000Z"), createdAt: new Date() },
      { id: 3, userId: 99, campaignId: 77, metricType: "impressions", value: 555, platform: "facebook", date: new Date("2026-06-10T00:00:00.000Z"), createdAt: new Date() },
      // Corrupted cross-tenant row: this campaign's id under another user.
      { id: 4, userId: 99, campaignId: 29, metricType: "impressions", value: 666, platform: "facebook", date: new Date("2026-06-10T00:00:00.000Z"), createdAt: new Date() }
    );

    // Strategy snapshots: campaign 29 has v1 and v2; siblings have their own.
    db.rows.strategy_snapshots.push(
      { id: 901, campaignId: 29, snapshotId: "snap-29-v1", version: 1, strategyRunId: 10, strategyHashSha256: HASH_V1, businessDnaSnapshotId: "bdna-29", creativeBriefFingerprint: "fp-29", capturedAt: new Date("2026-06-01T00:00:00.000Z") },
      { id: 902, campaignId: 29, snapshotId: "snap-29-v2", version: 2, strategyRunId: 11, strategyHashSha256: HASH_V2, businessDnaSnapshotId: "bdna-29", creativeBriefFingerprint: "fp-29", capturedAt: new Date("2026-06-02T00:00:00.000Z") },
      { id: 903, campaignId: 30, snapshotId: "snap-30", version: 1, strategyRunId: 20, strategyHashSha256: HASH_OTHER_CAMPAIGN, businessDnaSnapshotId: "bdna-30", creativeBriefFingerprint: "fp-30", capturedAt: new Date("2026-06-01T00:00:00.000Z") },
      { id: 904, campaignId: 77, snapshotId: "snap-77", version: 1, strategyRunId: 30, strategyHashSha256: HASH_OTHER_USER, businessDnaSnapshotId: "bdna-77", creativeBriefFingerprint: "fp-77", capturedAt: new Date("2026-06-01T00:00:00.000Z") }
    );

    db.rows.approval_requests.push(
      { id: 33, userId: 42, campaignId: 29, approvalType: "strategy_review", status: "approved", approvedAt: new Date("2026-06-02T00:00:00.000Z"), title: "t", description: null, aiRecommendation: null, riskLevel: "low", rejectedAt: null, idempotencyKey: null, context: null, createdAt: new Date() },
      { id: 44, userId: 42, campaignId: 30, approvalType: "strategy_review", status: "pending", approvedAt: null, title: "t", description: null, aiRecommendation: null, riskLevel: "low", rejectedAt: null, idempotencyKey: null, context: null, createdAt: new Date() }
    );

    // Publications + receipts for each campaign.
    for (const [id, userId, campaignId] of [
      [501, 42, 29],
      [502, 42, 30],
      [503, 99, 77],
    ] as const) {
      db.rows.publishing_queue.push({
        id,
        userId,
        campaignId,
        contentPostId: null,
        platform: "facebook",
        status: "published",
        scheduledAt: new Date("2026-06-05T00:00:00.000Z"),
        publishedAt: new Date("2026-06-05T00:00:00.000Z"),
        externalPostId: `ext-${id}`,
        metadata: null,
      });
      db.rows.audit_events.push({
        id: 9000 + id,
        eventType: "publication_success",
        userId,
        campaignId,
        approvalRequestId: null,
        metadata: { publicationReceipt: { queueItemId: id, externalUrl: `https://example.com/${id}` } },
        occurredAt: new Date("2026-06-05T00:00:00.000Z"),
      });
    }

    // Engagement: campaign-linked (user 42 / 29), unlinked user-level, other user.
    db.rows.social_engagement_events.push(
      { id: 1, userId: 42, campaignId: 29, platform: "facebook", eventType: "comment", eventTimestamp: new Date("2026-06-10T00:00:00.000Z") },
      { id: 2, userId: 42, campaignId: null, platform: "facebook", eventType: "like", eventTimestamp: new Date("2026-06-10T00:00:00.000Z") },
      { id: 3, userId: 42, campaignId: 30, platform: "facebook", eventType: "share", eventTimestamp: new Date("2026-06-10T00:00:00.000Z") },
      { id: 4, userId: 99, campaignId: 77, platform: "facebook", eventType: "comment", eventTimestamp: new Date("2026-06-10T00:00:00.000Z") }
    );

    db.rows.leads.push(
      { id: 1, userId: 42, campaignId: 29, status: "won", createdAt: new Date("2026-06-10T00:00:00.000Z") },
      { id: 2, userId: 42, campaignId: 30, status: "won", createdAt: new Date("2026-06-10T00:00:00.000Z") },
      { id: 3, userId: 99, campaignId: 77, status: "won", createdAt: new Date("2026-06-10T00:00:00.000Z") }
    );

    db.rows.ai_usage.push(
      { id: 1, userId: 42, campaignId: 29, agentType: "strategy", model: "gpt-4o-mini", actualCostUsd: 1_000_000, creditsDeducted: 10, createdAt: new Date("2026-06-10T00:00:00.000Z") },
      { id: 2, userId: 42, campaignId: 30, agentType: "strategy", model: "gpt-4o-mini", actualCostUsd: 2_000_000, creditsDeducted: 20, createdAt: new Date("2026-06-10T00:00:00.000Z") },
      { id: 3, userId: 99, campaignId: 77, agentType: "strategy", model: "gpt-4o-mini", actualCostUsd: 3_000_000, creditsDeducted: 30, createdAt: new Date("2026-06-10T00:00:00.000Z") }
    );
  });

  it("scopes every evidence class to the owning user+campaign (incl. corrupted cross-tenant rows)", async () => {
    const dataset = await loadCampaignPerformanceDataset({ userId: 42, campaignId: 29 });

    expect(dataset.identity.userId).toBe(42);
    expect(dataset.identity.businessId).toBe(7);
    expect(dataset.identity.window).toEqual({ start: "2026-06-01", end: "2026-06-30" });

    // Only this campaign's analytics row counts; sibling/foreign/corrupted rows excluded.
    expect(dataset.outcomes.totals.impressions).toBe(100);
    expect(dataset.outcomes.rowsConsidered).toBe(1);

    // Strategy authority binds THIS campaign's CURRENT snapshot version.
    expect(dataset.strategyAuthority.status).toBe("approved");
    expect(dataset.strategyAuthority.snapshot?.strategyHashSha256).toBe(HASH_V2);
    expect(dataset.strategyAuthority.snapshot?.strategyVersion).toBe(2);
    expect(dataset.strategyAuthority.approval.approvalRequestId).toBe(33);
    expect(dataset.strategyAuthority.approval.requestStatus).toBe("approved");

    // Publications: only this campaign's queue row + receipt.
    expect(dataset.publications).toHaveLength(1);
    expect(dataset.publications[0].queue?.queueItemId).toBe(501);
    expect(dataset.publications[0].provider.externalUrl).toBe("https://example.com/501");

    // Engagement: campaign-linked in-window fact only; user-level unlinked
    // event reported as excluded, never attributed. Sibling-campaign rows
    // are filtered out at the repository boundary (or(campaign, null)).
    expect(dataset.engagement.facts).toHaveLength(1);
    expect(dataset.engagement.facts[0].eventType).toBe("comment");
    expect(dataset.engagement.inWindowEventCount).toBe(1);
    expect(dataset.engagement.unlinkedEventCount).toBe(1); // user-level null-campaign row only

    // Leads and spend: this campaign only.
    expect(dataset.leads.inWindowLeadCount).toBe(1);
    expect(dataset.leads.conversionsWon).toBe(1);
    expect(dataset.spend.totalCostUsd).toBe("1");
  });

  it("refuses to load another user's campaign (no cross-tenant reads)", async () => {
    await expect(
      loadCampaignPerformanceDataset({ userId: 42, campaignId: 77 })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const foreign = await loadCampaignPerformanceDataset({ userId: 99, campaignId: 77 });
    expect(foreign.identity.userId).toBe(99);
    expect(foreign.outcomes.totals.impressions).toBe(555);
  });

  it("materialises deterministically: repeated loads are byte-identical (retry-safe)", async () => {
    const first = await loadCampaignPerformanceDataset({ userId: 42, campaignId: 29 });
    const second = await loadCampaignPerformanceDataset({ userId: 42, campaignId: 29 });

    expect(second.identity.fingerprint).toBe(first.identity.fingerprint);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("honours the explicit evaluation window deterministically", async () => {
    const dataset = await loadCampaignPerformanceDataset({
      userId: 42,
      campaignId: 29,
      windowStart: "2026-06-09",
      windowEnd: "2026-06-11",
    });

    expect(dataset.identity.window).toEqual({ start: "2026-06-09", end: "2026-06-11" });
    // The 2026-06-10 observation stays in scope; identity differs from the
    // campaign-date window load.
    expect(dataset.outcomes.totals.impressions).toBe(100);
    const defaultWindow = await loadCampaignPerformanceDataset({ userId: 42, campaignId: 29 });
    expect(dataset.identity.fingerprint).not.toBe(defaultWindow.identity.fingerprint);
  });

  it("fails closed on incomplete lineage: no strategy snapshot → authority_missing", async () => {
    const dataset = await loadCampaignPerformanceDataset({ userId: 42, campaignId: 31 });

    expect(dataset.strategyAuthority.status).toBe("missing");
    expect(dataset.strategyAuthority.snapshot).toBeNull();
    expect(dataset.readiness.status).toBe("authority_missing");
    expect(
      dataset.readiness.issues.some(
        (i) => i.code === "strategy_authority_missing" && i.severity === "required"
      )
    ).toBe(true);
  });

  it("surfaces unapproved lineage as a required issue (sibling campaign pending review)", async () => {
    const dataset = await loadCampaignPerformanceDataset({ userId: 42, campaignId: 30 });

    expect(dataset.strategyAuthority.status).toBe("unapproved");
    expect(dataset.strategyAuthority.snapshot?.strategyHashSha256).toBe(HASH_OTHER_CAMPAIGN);
    expect(dataset.readiness.status).toBe("authority_missing");
    expect(
      dataset.readiness.issues.some(
        (i) => i.code === "strategy_approval_missing" && i.severity === "required"
      )
    ).toBe(true);
  });
});
