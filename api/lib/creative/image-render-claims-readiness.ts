import { sql } from "drizzle-orm";
import { getDb } from "../../queries/connection";
import {
  getConfiguredImageRenderClaimsMode,
  resolveEffectiveImageRenderClaimsMode,
  type ImageRenderClaimsMode,
} from "./image-render-claims-mode";

// ─── Dormant image-render claims schema readiness (B2B-3A) ───
//
// Verifies that the ACTUAL DEPLOYED DATABASE contains the committed
// image_render_claims structure (db/schema.ts; migrations 0018, 0019, 0020).
// Migration files alone do not prove the deployed database state, so the
// effective claim mode must be gated on this probe. The module is dormant:
// nothing production imports or invokes it, no database connection exists at
// import time (getDb is obtained lazily, only when the default executor is
// explicitly invoked), and all probes are read-only INFORMATION_SCHEMA queries.
//
// Security: results expose only stable reason codes. Database names, hosts,
// credentials, SQL text, raw metadata rows, and raw executor errors are never
// returned, warned, or logged. Readiness fails closed and never throws a raw
// database error to callers.
//
// Query bound: at most TWO queries per probe (columns, then indexes). The
// second query is skipped when the first already proves the schema unusable.

export type ImageRenderClaimsReadinessReason =
  | "claim_table_missing"
  | "claim_column_missing"
  | "claim_index_missing"
  | "claim_index_invalid"
  | "claim_database_unavailable"
  | "claim_metadata_malformed";

export type ImageRenderClaimsReadiness =
  | { ready: true }
  | { ready: false; reason: ImageRenderClaimsReadinessReason };

export const IMAGE_RENDER_CLAIMS_TABLE = "image_render_claims" as const;

// Exact required column set, derived from db/schema.ts imageRenderClaims
// (base columns from migration 0018, identity columns from 0019, durable
// result columns from 0020).
export const IMAGE_RENDER_CLAIMS_REQUIRED_COLUMNS = [
  "id",
  "userId",
  "contentPostId",
  "activeClaimKey",
  "ownerToken",
  "status",
  "leaseExpiresAt",
  "createdAt",
  "updatedAt",
  "requestAttemptKey",
  "intentFingerprint",
  "deductionKey",
  "deductionRecorded",
  "generatedImageId",
  "resultImageUrl",
  "resultProvider",
  "resultProviderJobId",
  "resultCreditsCharged",
  "resultQualityTier",
  "resultQualityLabel",
  "resultIsDraft",
  "completedAt",
] as const;

export interface ImageRenderClaimsRequiredIndex {
  readonly name: string;
  readonly unique: boolean;
  readonly columns: readonly string[];
}

// Exact required index set, derived from db/schema.ts imageRenderClaims:
// uniqueness and ordered indexed columns are both verified. No foreign keys
// are required (the committed schema deliberately has none).
export const IMAGE_RENDER_CLAIMS_REQUIRED_INDEXES: readonly ImageRenderClaimsRequiredIndex[] = [
  { name: "irc_active_claim_key_idx", unique: true, columns: ["activeClaimKey"] },
  { name: "irc_request_attempt_key_idx", unique: true, columns: ["requestAttemptKey"] },
  { name: "irc_deduction_key_idx", unique: false, columns: ["deductionKey"] },
  { name: "irc_user_post_idx", unique: false, columns: ["userId", "contentPostId"] },
  { name: "irc_generated_image_idx", unique: true, columns: ["generatedImageId"] },
];

/**
 * Injected read-only metadata executor. Both methods must perform read-only
 * metadata lookups scoped to image_render_claims; each may be called at most
 * once per probe. Unknown return values are validated (and rejected as
 * malformed) by the evaluator, so tests can script any shape without a
 * database.
 */
export interface ImageRenderClaimsReadinessExecutor {
  listClaimColumns(): Promise<unknown>;
  listClaimIndexes(): Promise<unknown>;
}

interface ParsedIndex {
  name: string;
  unique: boolean;
  columns: string[];
}

function notReady(reason: ImageRenderClaimsReadinessReason): ImageRenderClaimsReadiness {
  return { ready: false, reason };
}

function parseColumns(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const names: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0) return null;
    names.push(entry);
  }
  return names;
}

function parseIndexes(value: unknown): ParsedIndex[] | null {
  if (!Array.isArray(value)) return null;
  const parsed: ParsedIndex[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return null;
    const record = entry as Record<string, unknown>;
    if (typeof record.name !== "string" || record.name.length === 0) return null;
    if (typeof record.unique !== "boolean") return null;
    if (!Array.isArray(record.columns) || record.columns.length === 0) return null;
    for (const column of record.columns) {
      if (typeof column !== "string" || column.length === 0) return null;
    }
    parsed.push({
      name: record.name,
      unique: record.unique,
      columns: [...record.columns],
    });
  }
  return parsed;
}

function sameIndexDefinition(a: ParsedIndex, b: ParsedIndex): boolean {
  return (
    a.unique === b.unique &&
    a.columns.length === b.columns.length &&
    a.columns.every((column, index) => column === b.columns[index])
  );
}

/**
 * One-shot readiness evaluation. Issues at most two executor calls; a
 * failure of the first bounds the probe to a single query. Never throws.
 */
export async function checkImageRenderClaimsReadiness(
  executor: ImageRenderClaimsReadinessExecutor
): Promise<ImageRenderClaimsReadiness> {
  let rawColumns: unknown;
  try {
    rawColumns = await executor.listClaimColumns();
  } catch {
    return notReady("claim_database_unavailable");
  }
  const columns = parseColumns(rawColumns);
  if (columns === null) {
    return notReady("claim_metadata_malformed");
  }
  // A table with zero columns cannot exist in MySQL: an empty metadata set
  // means the table is absent from the deployed database.
  if (columns.length === 0) {
    return notReady("claim_table_missing");
  }
  const columnSet = new Set(columns);
  for (const required of IMAGE_RENDER_CLAIMS_REQUIRED_COLUMNS) {
    if (!columnSet.has(required)) {
      return notReady("claim_column_missing");
    }
  }

  let rawIndexes: unknown;
  try {
    rawIndexes = await executor.listClaimIndexes();
  } catch {
    return notReady("claim_database_unavailable");
  }
  const indexes = parseIndexes(rawIndexes);
  if (indexes === null) {
    return notReady("claim_metadata_malformed");
  }
  const byName = new Map<string, ParsedIndex>();
  for (const index of indexes) {
    const existing = byName.get(index.name);
    if (existing) {
      // Duplicate metadata rows are tolerated only when identical; conflicting
      // duplicates mean the metadata itself cannot be trusted.
      if (!sameIndexDefinition(existing, index)) {
        return notReady("claim_metadata_malformed");
      }
      continue;
    }
    byName.set(index.name, index);
  }
  for (const required of IMAGE_RENDER_CLAIMS_REQUIRED_INDEXES) {
    const actual = byName.get(required.name);
    if (!actual) {
      return notReady("claim_index_missing");
    }
    if (
      actual.unique !== required.unique ||
      actual.columns.length !== required.columns.length ||
      actual.columns.some((column, index) => column !== required.columns[index])
    ) {
      return notReady("claim_index_invalid");
    }
  }

  return { ready: true };
}

/**
 * Default executor: lazily obtains the application database (only when a
 * readiness probe is explicitly invoked) and performs read-only
 * INFORMATION_SCHEMA queries scoped to the current schema via DATABASE() —
 * no credentials, database names, or connection strings appear in SQL. It
 * returns plain, unvalidated shapes; the evaluator owns all well-formedness
 * checks.
 */
export function createDefaultImageRenderClaimsReadinessExecutor(): ImageRenderClaimsReadinessExecutor {
  let client: ReturnType<typeof getDb> | null = null;
  const getClient = () => {
    if (!client) {
      client = getDb();
    }
    return client;
  };

  return {
    async listClaimColumns() {
      const result = await getClient().execute(sql`
        SELECT COLUMN_NAME AS name
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'image_render_claims'
      `);
      const rows = (result as unknown[])?.[0];
      if (!Array.isArray(rows)) return [];
      return rows.map((row) => (row as { name?: unknown })?.name);
    },
    async listClaimIndexes() {
      const result = await getClient().execute(sql`
        SELECT
          INDEX_NAME AS name,
          NON_UNIQUE AS nonUnique,
          COLUMN_NAME AS columnName
        FROM INFORMATION_SCHEMA.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'image_render_claims'
        ORDER BY INDEX_NAME, SEQ_IN_INDEX
      `);
      const rows = (result as unknown[])?.[0];
      if (!Array.isArray(rows)) return [];
      const grouped = new Map<string, { unique: boolean; columns: string[] }>();
      for (const row of rows as { name?: unknown; nonUnique?: unknown; columnName?: unknown }[]) {
        if (typeof row?.name !== "string") continue;
        const entry = grouped.get(row.name) ?? {
          unique: row.nonUnique === 0 || row.nonUnique === "0",
          columns: [],
        };
        if (typeof row.columnName === "string") {
          entry.columns.push(row.columnName);
        }
        grouped.set(row.name, entry);
      }
      return [...grouped.entries()].map(([name, value]) => ({
        name,
        unique: value.unique,
        columns: value.columns,
      }));
    },
  };
}

// ─── Process-local readiness cache with in-flight deduplication ───

export const IMAGE_RENDER_CLAIMS_READINESS_NEGATIVE_CACHE_MS = 60_000;

export interface ImageRenderClaimsReadinessChecker {
  check(): Promise<ImageRenderClaimsReadiness>;
}

/**
 * Process-local, bounded, injectable readiness cache. No timers, no polling,
 * no background work: time comes from the injected `now` millisecond clock.
 *
 *   - ready=true is cached permanently for the process lifetime;
 *   - ready=false is cached until now() + negativeCacheMs, then re-probed —
 *     so a transient database failure or not-yet-applied migrations recover
 *     automatically without a process restart;
 *   - concurrent check() calls share a single in-flight probe; a failed
 *     probe clears the in-flight slot so the next call re-probes.
 */
export function createImageRenderClaimsReadinessChecker({
  executor,
  now,
  negativeCacheMs = IMAGE_RENDER_CLAIMS_READINESS_NEGATIVE_CACHE_MS,
}: {
  executor: ImageRenderClaimsReadinessExecutor;
  now: () => number;
  negativeCacheMs?: number;
}): ImageRenderClaimsReadinessChecker {
  let cachedReady = false;
  let negative: { expiresAt: number; result: ImageRenderClaimsReadiness } | null = null;
  let inFlight: Promise<ImageRenderClaimsReadiness> | null = null;

  return {
    check(): Promise<ImageRenderClaimsReadiness> {
      if (cachedReady) {
        return Promise.resolve({ ready: true });
      }
      if (negative && now() < negative.expiresAt) {
        return Promise.resolve(negative.result);
      }
      if (inFlight) {
        return inFlight;
      }
      inFlight = (async () => {
        const result = await checkImageRenderClaimsReadiness(executor);
        if (result.ready) {
          cachedReady = true;
          negative = null;
        } else {
          negative = { expiresAt: now() + negativeCacheMs, result };
        }
        return result;
      })();
      try {
        return inFlight;
      } finally {
        const current = inFlight;
        current
          .catch(() => undefined)
          .finally(() => {
            if (inFlight === current) {
              inFlight = null;
            }
          });
      }
    },
  };
}

/**
 * Narrow composite: resolves the effective claims mode while guaranteeing
 * that configured off (missing, empty, or invalid) NEVER invokes the
 * readiness dependency. Only configured "on" can trigger a probe; any probe
 * failure resolves to "off". The readiness dependency is injected, so tests
 * can supply one that throws if called.
 */
export async function getEffectiveImageRenderClaimsMode({
  rawMode,
  warn,
  readiness,
}: {
  rawMode?: string | null;
  warn?: (message: string) => void;
  readiness: ImageRenderClaimsReadinessChecker;
}): Promise<ImageRenderClaimsMode> {
  const configuredMode = getConfiguredImageRenderClaimsMode({ rawMode, warn });
  if (configuredMode !== "on") {
    return "off";
  }
  let readinessResult: unknown;
  try {
    readinessResult = await readiness.check();
  } catch {
    return "off";
  }
  return resolveEffectiveImageRenderClaimsMode({ configuredMode, readiness: readinessResult });
}
