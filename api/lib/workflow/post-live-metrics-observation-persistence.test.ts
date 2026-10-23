/**
 * WBS-R4-D2 adversarial tests: idempotent, fail-closed observation
 * persistence against the default durable deps.
 *
 * The fake DB below interprets exactly the drizzle query shapes the default
 * observation deps emit (`and(eq..., isNotNull...)` + `desc` + `limit` for
 * reads; `insert().values().onDuplicateKeyUpdate()` for writes, enforcing the
 * observationId unique constraint). No live provider, Redis or MySQL.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../queries/connection", () => ({
  getDb: vi.fn(),
}));

import { getDb } from "../../queries/connection";
import { analytics } from "@db/schema";
import type { MetricType } from "../learning/contracts/observation";
import {
  buildObservationId,
  createDefaultPostLiveMetricsObservationPassDeps,
  runPostLiveMetricsObservationPass,
  type PublishedObservationCandidate,
} from "./post-live-metrics-observation-pass";

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

function stringChunkValue(chunk: unknown): string | null {
  const value = (chunk as { value?: unknown }).value;
  return Array.isArray(value) ? value.join("") : null;
}

function splitConjunctions(cond: unknown): unknown[][] {
  const chunks = (cond as { queryChunks?: unknown[] }).queryChunks ?? [];
  const parts: unknown[][] = [[]];
  for (const chunk of chunks) {
    const text = stringChunkValue(chunk);
    if (text === " and ") {
      parts.push([]);
      continue;
    }
    if (text === "(" || text === ")") continue;
    if ((chunk as { queryChunks?: unknown[] }).queryChunks) {
      // Nested SQL (and() wraps its operands): splice its conjunction parts
      // into the current position.
      const nested = splitConjunctions(chunk);
      parts[parts.length - 1].push(...nested[0]);
      for (let i = 1; i < nested.length; i++) parts.push(nested[i]);
      continue;
    }
    parts[parts.length - 1].push(chunk);
  }
  return parts;
}

function evalCondition(cond: unknown, row: Row): boolean {
  return splitConjunctions(cond).every((part) => evalSimple(part, row));
}

function evalSimple(chunks: unknown[], row: Row): boolean {
  const colChunk = chunks.find((c) => (c as { name?: string; table?: unknown })?.name);
  const paramChunk = chunks.find(
    (c) =>
      c !== colChunk &&
      (c as { value?: unknown; encoder?: unknown })?.value !== undefined &&
      !(Array.isArray((c as { value?: unknown }).value))
  );
  const op = chunks
    .filter((c) => Array.isArray((c as { value?: unknown }).value))
    .map((c) => ((c as { value: string[] }).value ?? []).join(""))
    .join("");
  const col = columnName(colChunk);
  if (op.includes("is not null")) return row[col] !== null && row[col] !== undefined;
  if (op.includes("=")) return row[col] === (paramChunk as { value?: unknown })?.value;
  throw new Error(`unsupported fake-db condition operator: ${op}`);
}

function createFakeDb() {
  const tables: Record<string, Row[]> = { analytics: [], publishing_queue: [] };
  const nextIds: Record<string, number> = { analytics: 1 };

  function applyProjection(rows: Row[], projection: unknown): Row[] {
    if (!projection || typeof projection !== "object" || Array.isArray(projection)) return rows;
    const out: Row[] = [];
    for (const row of rows) {
      const projected: Row = {};
      for (const [alias, column] of Object.entries(projection)) {
        projected[alias] = row[columnName(column)];
      }
      out.push(projected);
    }
    return out;
  }

  const db = {
    rows: tables,

    select(projection?: unknown) {
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
          orderCol = columnName(col);
          // drizzle's desc() wrapper is branded by its constructor name; the
          // only ordered read here is `desc(analytics.date)`.
          orderDesc = (col as object)?.constructor?.name === "_SD";
          return builder;
        },
        limit(n: number) {
          limitN = n;
          return builder;
        },
        then(resolve: (rows: Row[]) => unknown, reject?: (e: unknown) => void) {
          let rows = filtered;
          if (orderCol) {
            rows = [...rows].sort((a, b) => {
              const av = a[orderCol] as number;
              const bv = b[orderCol] as number;
              return orderDesc ? bv - av : av - bv;
            });
          }
          if (limitN !== null) rows = rows.slice(0, limitN);
          try {
            resolve(applyProjection(rows, projection));
          } catch (e) {
            reject?.(e);
          }
        },
      };
      return builder;
    },

    insert(table: unknown) {
      const name = tableName(table);
      return {
        values(obj: Row) {
          return {
            async onDuplicateKeyUpdate({ set }: { set: Row }) {
              const existing = (tables[name] ?? []).find(
                (r) =>
                  obj.observationId !== null &&
                  obj.observationId !== undefined &&
                  r.observationId === obj.observationId
              );
              if (existing) {
                Object.assign(existing, set);
                return;
              }
              const row: Row = { ...obj };
              if (name === "analytics") {
                row.id = nextIds.analytics++;
              }
              (tables[name] ??= []).push(row);
            },
            async then(resolve: (v: unknown) => unknown) {
              const row: Row = { ...obj };
              if (name === "analytics") row.id = nextIds.analytics++;
              (tables[name] ??= []).push(row);
              return resolve([{ insertId: row.id }]);
            },
          };
        },
      };
    },
  };

  return db;
}

// ─── fixtures ───

function candidate(overrides: Partial<PublishedObservationCandidate> = {}): PublishedObservationCandidate {
  return {
    queueItemId: 101,
    userId: 42,
    campaignId: 29,
    platform: "facebook",
    publishedAt: "2026-06-20T08:00:00.000Z",
    externalPostId: "ext-post-1",
    ...overrides,
  };
}

function seedPublishedQueue(db: ReturnType<typeof createFakeDb>, rows: Array<Partial<Row>>) {
  for (const row of rows) {
    db.rows.publishing_queue.push({
      id: 101,
      userId: 42,
      campaignId: 29,
      platform: "facebook",
      status: "published",
      publishedAt: new Date("2026-06-20T08:00:00.000Z"),
      externalPostId: "ext-post-1",
      ...row,
    });
  }
}

describe("buildObservationId", () => {
  it("is deterministic and material-distinct", () => {
    const base = {
      campaignId: 29,
      platform: "facebook",
      externalPostId: "ext-post-1",
      metricType: "impressions",
      date: "2026-06-21",
    };
    const a = buildObservationId(base);
    expect(a).toBe(buildObservationId({ ...base }));
    expect(a).toMatch(/^obs:[0-9a-f]{64}$/);
    // Any material drift changes the identity.
    expect(buildObservationId({ ...base, metricType: "clicks" })).not.toBe(a);
    expect(buildObservationId({ ...base, date: "2026-06-22" })).not.toBe(a);
    expect(buildObservationId({ ...base, externalPostId: "ext-post-2" })).not.toBe(a);
    expect(buildObservationId({ ...base, campaignId: 30 })).not.toBe(a);
    expect(buildObservationId({ ...base, platform: "instagram" })).not.toBe(a);
  });

  it("never embeds the untrusted provider post id", () => {
    const id = buildObservationId({
      campaignId: 29,
      platform: "facebook",
      externalPostId: "secret-provider-post-id-123",
      metricType: "impressions",
      date: "2026-06-21",
    });
    expect(id).not.toContain("secret-provider-post-id");
  });
});

describe("default observation deps durability (WBS-R4-D2)", () => {
  let db: ReturnType<typeof createFakeDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createFakeDb();
    vi.mocked(getDb).mockReturnValue(db as never);
    db.rows.publishing_queue = [];
    db.rows.analytics = [];
  });

  it("persists valid samples with deterministic observation ids bound to the queue candidate scope", async () => {
    seedPublishedQueue(db, [{}]);
    const deps = createDefaultPostLiveMetricsObservationPassDeps();

    await deps.persistObservations({
      candidate: candidate(),
      observedAt: "2026-06-21T00:00:00.000Z",
      metrics: [
        { metricType: "impressions", value: 120 },
        { metricType: "clicks", value: 7 },
      ],
    });

    expect(db.rows.analytics).toHaveLength(2);
    for (const row of db.rows.analytics) {
      expect(row.userId).toBe(42);
      expect(row.campaignId).toBe(29);
      expect(row.platform).toBe("facebook");
      expect(row.date).toEqual(new Date("2026-06-21T00:00:00.000Z"));
      expect(String(row.observationId)).toMatch(/^obs:[0-9a-f]{64}$/);
    }
    const ids = db.rows.analytics.map((r) => r.observationId);
    expect(new Set(ids).size).toBe(2);
  });

  it("upserts on exact replay: retries never duplicate durable metrics", async () => {
    const deps = createDefaultPostLiveMetricsObservationPassDeps();
    const input: Parameters<typeof deps.persistObservations>[0] = {
      candidate: candidate(),
      observedAt: "2026-06-21T00:00:00.000Z",
      metrics: [{ metricType: "impressions", value: 120 }],
    };

    await deps.persistObservations(input);
    await deps.persistObservations(input); // replayed provider payload / restarted pass
    await deps.persistObservations({
      ...input,
      metrics: [{ metricType: "impressions", value: 130 }],
    }); // same-day refresh with updated count

    expect(db.rows.analytics).toHaveLength(1);
    expect(db.rows.analytics[0].value).toBe(130);
  });

  it("treats a different observation day as a new durable row", async () => {
    const deps = createDefaultPostLiveMetricsObservationPassDeps();

    await deps.persistObservations({
      candidate: candidate(),
      observedAt: "2026-06-21T00:00:00.000Z",
      metrics: [{ metricType: "impressions", value: 120 }],
    });
    await deps.persistObservations({
      candidate: candidate(),
      observedAt: "2026-06-22T00:00:00.000Z",
      metrics: [{ metricType: "impressions", value: 150 }],
    });

    expect(db.rows.analytics).toHaveLength(2);
  });

  it("scopes due authority to observation rows only: manual rows never suppress observation", async () => {
    db.rows.analytics.push({
      id: 1,
      userId: 42,
      campaignId: 29,
      platform: "facebook",
      metricType: "impressions",
      value: 999,
      date: new Date("2026-06-21T00:00:00.000Z"),
      observationId: null, // manually recorded row
      createdAt: new Date(),
    });
    const deps = createDefaultPostLiveMetricsObservationPassDeps();

    const lastObservedAt = await deps.loadLastObservedAt(candidate());
    expect(lastObservedAt).toBeNull();
  });

  it("never leaks another user's or campaign's observations into due authority", async () => {
    db.rows.analytics.push(
      {
        id: 1,
        userId: 99,
        campaignId: 29,
        platform: "facebook",
        metricType: "impressions",
        value: 10,
        date: new Date("2026-06-21T00:00:00.000Z"),
        observationId: "obs:other-user",
        createdAt: new Date(),
      },
      {
        id: 2,
        userId: 42,
        campaignId: 77,
        platform: "facebook",
        metricType: "impressions",
        value: 10,
        date: new Date("2026-06-21T00:00:00.000Z"),
        observationId: "obs:other-campaign",
        createdAt: new Date(),
      },
      {
        id: 3,
        userId: 42,
        campaignId: 29,
        platform: "instagram",
        metricType: "impressions",
        value: 10,
        date: new Date("2026-06-21T00:00:00.000Z"),
        observationId: "obs:other-platform",
        createdAt: new Date(),
      }
    );
    const deps = createDefaultPostLiveMetricsObservationPassDeps();

    expect(await deps.loadLastObservedAt(candidate())).toBeNull();
    await deps.persistObservations({
      candidate: candidate(),
      observedAt: "2026-06-21T00:00:00.000Z",
      metrics: [{ metricType: "impressions", value: 5 }],
    });
    // Other tenants' rows untouched.
    expect(db.rows.analytics.filter((r) => String(r.observationId).startsWith("obs:other"))).toHaveLength(3);
  });

  it("survives a restart mid-ingestion without duplicating partially persisted metrics", async () => {
    seedPublishedQueue(db, [{}]);
    const deps = createDefaultPostLiveMetricsObservationPassDeps();
    const fetchSamples = vi.fn(async () => [
      { metricType: "impressions", value: 100 },
      { metricType: "clicks", value: 4 },
    ]);
    const customDeps = {
      ...deps,
      resolveBinding: () => ({ platform: "facebook" as const, fetchPostMetrics: fetchSamples }),
    };

    // First attempt crashes after persisting the first metric.
    const crashing = {
      ...customDeps,
      persistObservations: async (input: {
        candidate: PublishedObservationCandidate;
        observedAt: string;
        metrics: Array<{ metricType: MetricType; value: number }>;
      }) => {
        await deps.persistObservations({ ...input, metrics: input.metrics.slice(0, 1) });
        throw new Error("simulated crash after partial persist");
      },
    };
    const report1 = await runPostLiveMetricsObservationPass({ asOfDate: "2026-06-21", deps: crashing });
    expect(report1.results[0].status).toBe("persist_failed");
    expect(db.rows.analytics).toHaveLength(1);
    expect(fetchSamples).toHaveBeenCalledTimes(1);

    // Restart: same-day due authority is now satisfied, so the restarted pass
    // must NOT re-observe (no additional fetch, no duplicate). The partial
    // row stays.
    const report2 = await runPostLiveMetricsObservationPass({ asOfDate: "2026-06-21", deps: customDeps });
    expect(report2.results[0].status).toBe("not_due");
    expect(fetchSamples).toHaveBeenCalledTimes(1);
    expect(db.rows.analytics).toHaveLength(1);

    // Direct re-persist of the full batch (e.g. re-driven after fixing the
    // crash) completes the batch on the same rows without duplicates.
    await deps.persistObservations({
      candidate: candidate(),
      observedAt: "2026-06-21T00:00:00.000Z",
      metrics: [
        { metricType: "impressions", value: 100 },
        { metricType: "clicks", value: 4 },
      ],
    });
    expect(db.rows.analytics).toHaveLength(2);
  });

  it("drops malformed provider samples before persistence (fail closed on unknown metrics and invalid values)", async () => {
    seedPublishedQueue(db, [{}]);
    const deps = createDefaultPostLiveMetricsObservationPassDeps();
    const customDeps = {
      ...deps,
      resolveBinding: () => ({
        platform: "facebook" as const,
        fetchPostMetrics: async () => [
          { metricType: "impressions", value: 100 },
          { metricType: "provider_spend", value: 12 }, // unknown metric type
          { metricType: "clicks", value: null }, // invalid value
          { metricType: "reach", value: Number.NaN }, // invalid value
        ],
      }),
    };

    const report = await runPostLiveMetricsObservationPass({ asOfDate: "2026-06-21", deps: customDeps });

    expect(report.results[0].status).toBe("observed");
    expect(db.rows.analytics).toHaveLength(1);
    expect(db.rows.analytics[0].metricType).toBe("impressions");
  });

  it("marks transient provider failure as fetch_failed and persists nothing", async () => {
    seedPublishedQueue(db, [{}]);
    const deps = createDefaultPostLiveMetricsObservationPassDeps();
    const customDeps = {
      ...deps,
      resolveBinding: () => ({
        platform: "facebook" as const,
        fetchPostMetrics: async () => {
          throw new Error("provider timeout");
        },
      }),
    };

    const report = await runPostLiveMetricsObservationPass({ asOfDate: "2026-06-21", deps: customDeps });

    expect(report.results[0].status).toBe("fetch_failed");
    expect(db.rows.analytics).toHaveLength(0);
  });

  it("lists every published queue row with receipt binding as candidates (global publication authority)", async () => {
    seedPublishedQueue(db, [
      {},
      { id: 102, status: "approved" }, // not yet published
      { id: 103, externalPostId: null }, // no provider binding
      { id: 104, publishedAt: null }, // never went live
      { id: 105, userId: 99, campaignId: 55 }, // another tenant's published post
    ]);
    const deps = createDefaultPostLiveMetricsObservationPassDeps();

    const report = await runPostLiveMetricsObservationPass({ asOfDate: "2026-06-21", deps });

    // Candidate discovery is the global server-side publication authority;
    // tenant isolation is enforced at persistence scope (see the isolation
    // tests above), not by hiding other tenants' publications.
    expect(report.candidates).toBe(2);
    expect(report.results.map((r) => r.queueItemId).sort()).toEqual([101, 105]);
  });
});
