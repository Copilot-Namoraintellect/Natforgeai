/**
 * WBS-R4-D2 adversarial tests: idempotent engagement processing.
 *
 * Engagement events arrive from provider adapters (untrusted, replayable
 * payloads). These tests prove that replaying the same provider payload —
 * or re-running the whole ingestion cycle after a restart — never
 * duplicates durable engagement events or derived interest signals, and
 * that actor scoping stays tenant-safe. All provider/DB boundaries are
 * faked; no live provider is called.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const adapterMocks = vi.hoisted(() => ({
  meta: vi.fn(),
  linkedin: vi.fn(),
}));

vi.mock("../../queries/connection", () => ({
  getDb: vi.fn(),
}));

vi.mock("../crypto", () => ({
  decryptToken: vi.fn(() => "decrypted-token"),
}));

vi.mock("./adapters/meta-adapter", () => ({
  fetchMetaAudienceData: adapterMocks.meta,
}));

vi.mock("./adapters/linkedin-adapter", () => ({
  fetchLinkedInAudienceData: adapterMocks.linkedin,
}));

import { getDb } from "../../queries/connection";
import { ingestAudienceData } from "./ingest";
import type { RawEngagementEvent, RawSocialProfile } from "./types";

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
      const nested = splitConjunctions(chunk);
      parts[parts.length - 1].push(...nested[0]);
      for (let i = 1; i < nested.length; i++) parts.push(nested[i]);
      continue;
    }
    parts[parts.length - 1].push(chunk);
  }
  return parts;
}

function isParamChunk(chunk: unknown): boolean {
  const c = chunk as { value?: unknown; name?: string } | null;
  return (
    c !== null &&
    typeof c === "object" &&
    !Array.isArray(c.value) &&
    c.value !== undefined &&
    !c.name
  );
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
    if (isParamChunk(c)) {
      params.push((c as { value: unknown }).value);
    } else if (Array.isArray(c)) {
      // inArray() nests its value list as an array chunk.
      params.push(...c.filter(isParamChunk).map((p) => (p as { value: unknown }).value));
    }
  }

  if (op.includes("is not null")) return row[col] !== null && row[col] !== undefined;
  if (op.includes(" in ")) return params.some((p) => row[col] === p);
  if (op.includes("=")) return row[col] === params[0];
  throw new Error(`unsupported fake-db condition operator: ${op}`);
}

function evalCondition(cond: unknown, row: Row): boolean {
  return splitConjunctions(cond).every((part) => evalSimple(part, row));
}

function isSqlFragment(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Boolean((value as { sql?: unknown }).sql ?? (value as { queryChunks?: unknown }).queryChunks)
  );
}

function createFakeDb() {
  const tables: Record<string, Row[]> = {
    social_integrations: [],
    social_profiles: [],
    social_engagement_events: [],
    campaign_interest_signals: [],
  };
  const nextIds: Record<string, number> = {
    social_profiles: 1,
    social_engagement_events: 1,
    campaign_interest_signals: 1,
  };

  const uniqueKeys: Record<string, Array<keyof Row>[]> = {
    social_engagement_events: [["dedupHash"]],
    campaign_interest_signals: [["campaignId", "externalIdentifier"]],
    social_profiles: [],
  };

  function applyInsert(table: string, obj: Row): { existing: Row | null; row: Row } {
    const rows = (tables[table] ??= []);
    const existing =
      uniqueKeys[table]?.flatMap((key) => {
        const hit = rows.find((r) => key.every((k) => r[k] === obj[k]));
        return hit ? [hit] : [];
      })[0] ?? null;
    if (existing) return { existing, row: existing };
    const row = { ...obj, id: nextIds[table]++ };
    rows.push(row);
    return { existing: null, row };
  }

  const db = {
    rows: tables,

    select() {
      let table = "";
      let filtered: Row[] = [];
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
        orderBy() {
          return builder;
        },
        limit(n: number) {
          limitN = n;
          return builder;
        },
        then(resolve: (rows: Row[]) => unknown, reject?: (e: unknown) => void) {
          try {
            resolve(limitN !== null ? filtered.slice(0, limitN) : filtered);
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
        values(obj: Row | Row[]) {
          const batch = Array.isArray(obj) ? obj : [obj];
          return {
            async onDuplicateKeyUpdate({ set }: { set: Record<string, unknown> }) {
              const rows: Row[] = [];
              for (const values of batch) {
                const { existing, row } = applyInsert(name, values);
                if (existing) {
                  for (const [key, value] of Object.entries(set)) {
                    // sql`VALUES(col)` means "take the inserted row's column";
                    // plain values are applied directly.
                    existing[key] = isSqlFragment(value) ? values[key] : value;
                  }
                }
                rows.push(row);
              }
              return rows;
            },
            async then(resolve: (v: unknown) => unknown) {
              const inserted = batch.map((values) => applyInsert(name, values).row);
              return resolve([{ insertId: inserted[inserted.length - 1]?.id }]);
            },
          };
        },
      };
    },

    update(table: unknown) {
      const name = tableName(table);
      let setValues: Row = {};
      return {
        set(values: Row) {
          setValues = values;
          return {
            where(cond: unknown) {
              return {
                async then(resolve: (v: unknown) => unknown) {
                  let affected = 0;
                  for (const row of tables[name] ?? []) {
                    if (evalCondition(cond, row)) {
                      Object.assign(row, setValues);
                      affected++;
                    }
                  }
                  return resolve([{ affectedRows: affected }]);
                },
              };
            },
          };
        },
      };
    },
  };

  return db;
}

// ─── provider fixtures ───

const NOW = new Date();

function providerEvents(overrides: Array<Partial<RawEngagementEvent>> = []): RawEngagementEvent[] {
  const base: RawEngagementEvent[] = [
    {
      platform: "facebook",
      externalProfileId: "page-1",
      externalContentId: "post-9",
      eventType: "comment",
      actorExternalId: "actor-7",
      actorHandle: "@commenter",
      actorDisplayName: "Commenter",
      messageText: "Loved this post!",
      eventTimestamp: new Date(NOW.getTime() - 60 * 60 * 1000),
      metadata: { provider: "fake" },
    },
    {
      platform: "facebook",
      externalProfileId: "page-1",
      externalContentId: "post-9",
      eventType: "like",
      actorExternalId: "actor-8",
      actorHandle: "@liker",
      actorDisplayName: null,
      messageText: null,
      eventTimestamp: new Date(NOW.getTime() - 2 * 60 * 60 * 1000),
      metadata: undefined,
    },
  ];
  return overrides.length > 0
    ? overrides.map((o, i) => ({ ...base[i % base.length], ...o }))
    : base;
}

function providerProfiles(): RawSocialProfile[] {
  return [
    {
      platform: "facebook_page",
      externalId: "page-1",
      handle: "pageone",
      displayName: "Page One",
      url: null,
      followerCount: 1200,
      category: null,
      location: null,
      profilePictureUrl: null,
      metadata: undefined,
    },
  ];
}

describe("engagement ingestion idempotency (WBS-R4-D2)", () => {
  let db: ReturnType<typeof createFakeDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createFakeDb();
    vi.mocked(getDb).mockReturnValue(db as never);
    db.rows.social_integrations.push({
      id: 1,
      userId: 42,
      platform: "facebook",
      status: "connected",
      accessTokenEncrypted: "cipher",
    });
    adapterMocks.meta.mockResolvedValue({
      profiles: providerProfiles(),
      events: providerEvents(),
      warnings: [],
    });
    adapterMocks.linkedin.mockResolvedValue({ profiles: [], events: [], warnings: [] });
  });

  it("replays the same provider payload without duplicating engagement events", async () => {
    const first = await ingestAudienceData({ userId: 42, businessId: 7, campaignId: 29 });
    expect(first.eventsSynced).toBe(2);
    expect(db.rows.social_engagement_events).toHaveLength(2);
    expect(db.rows.campaign_interest_signals).toHaveLength(2); // one per actor

    const idsAfterFirst = db.rows.social_engagement_events.map((r) => r.id).sort();

    // Provider redelivers the exact same payload (restart / retry / replay).
    const second = await ingestAudienceData({ userId: 42, businessId: 7, campaignId: 29 });

    expect(second.eventsSynced).toBe(2);
    expect(db.rows.social_engagement_events).toHaveLength(2);
    expect(db.rows.social_engagement_events.map((r) => r.id).sort()).toEqual(idsAfterFirst);
    // No duplicate actor signals from the replayed cycle.
    expect(db.rows.campaign_interest_signals).toHaveLength(2);
  });

  it("refreshes mutable event fields on replay without creating new rows", async () => {
    await ingestAudienceData({ userId: 42, businessId: 7, campaignId: 29 });

    adapterMocks.meta.mockResolvedValue({
      profiles: providerProfiles(),
      events: providerEvents([
        { actorDisplayName: "Renamed Commenter" },
        {},
      ]),
      warnings: [],
    });
    await ingestAudienceData({ userId: 42, businessId: 7, campaignId: 29 });

    expect(db.rows.social_engagement_events).toHaveLength(2);
    const comment = db.rows.social_engagement_events.find((r) => r.eventType === "comment");
    expect(comment?.actorDisplayName).toBe("Renamed Commenter");
  });

  it("scopes dedup per user: the same provider event ingested for another user is a separate durable row", async () => {
    await ingestAudienceData({ userId: 42, businessId: 7, campaignId: 29 });

    db.rows.social_integrations.push({
      id: 2,
      userId: 99,
      platform: "facebook",
      status: "connected",
      accessTokenEncrypted: "cipher",
    });
    await ingestAudienceData({ userId: 99, businessId: 7, campaignId: 30 });

    expect(db.rows.social_engagement_events).toHaveLength(4);
    expect(
      db.rows.social_engagement_events.filter((r) => r.userId === 42)
    ).toHaveLength(2);
    expect(
      db.rows.social_engagement_events.filter((r) => r.userId === 99)
    ).toHaveLength(2);
  });

  it("treats a different event timestamp as a new event, not a replay", async () => {
    await ingestAudienceData({ userId: 42, businessId: 7, campaignId: 29 });

    adapterMocks.meta.mockResolvedValue({
      profiles: providerProfiles(),
      events: [
        ...providerEvents(),
        {
          platform: "facebook",
          externalProfileId: "page-1",
          externalContentId: "post-9",
          eventType: "comment",
          actorExternalId: "actor-7",
          actorHandle: "@commenter",
          actorDisplayName: "Commenter",
          messageText: "Second comment an hour later",
          eventTimestamp: new Date(NOW.getTime() - 30 * 60 * 1000),
          metadata: undefined,
        },
      ],
      warnings: [],
    });
    await ingestAudienceData({ userId: 42, businessId: 7, campaignId: 29 });

    expect(db.rows.social_engagement_events).toHaveLength(3);
  });

  it("truncates oversized provider text instead of failing the batch", async () => {
    adapterMocks.meta.mockResolvedValue({
      profiles: providerProfiles(),
      events: providerEvents([{ messageText: "x".repeat(1200) }, {}]),
      warnings: [],
    });

    const summary = await ingestAudienceData({ userId: 42, businessId: 7, campaignId: 29 });

    expect(summary.eventsSynced).toBe(2);
    const comment = db.rows.social_engagement_events.find((r) => r.eventType === "comment");
    expect(String(comment?.messageText)).toHaveLength(500);
    expect(String(comment?.messageText)).toMatch(/\.\.\.$/);
  });

  it("keeps a failed adapter from blocking other platforms or duplicating prior events", async () => {
    adapterMocks.meta.mockRejectedValue(new Error("provider timeout"));

    const summary = await ingestAudienceData({ userId: 42, businessId: 7, campaignId: 29 });
    expect(summary.warnings.some((w) => w.includes("provider timeout"))).toBe(true);
    expect(db.rows.social_engagement_events).toHaveLength(0);

    // Recovery on the next cycle: the same payload lands once, not twice.
    adapterMocks.meta.mockResolvedValue({
      profiles: providerProfiles(),
      events: providerEvents(),
      warnings: [],
    });
    await ingestAudienceData({ userId: 42, businessId: 7, campaignId: 29 });
    expect(db.rows.social_engagement_events).toHaveLength(2);
  });
});
