// ─── R7-B Attribution Intelligence — R7-A outcome consumption seam ───
//
// R7-B consumes R7-A business outcomes EXCLUSIVELY through the frozen
// conversion-outcome/v1 projection defined by the R7-A contract
// (docs/contracts/conversion-outcome-to-attribution-learning-contract.md,
// consumed from branch feature/r7-a-conversion-outcome-intelligence @ 3e8aea8
// by reference — never merged, never imported). This seam validates the
// frozen projection shape and re-derives nothing. R7-A code never asserts
// causation; neither does this seam.
//
// Production reads run against the R7-A `business_outcomes` table behind a
// guarded information-schema existence check (the table is a stream-local
// provisional artefact on the R7-A branch until R7-X convergence). When the
// table is absent the seam fail-closed degrades to "no outcome" — attribution
// is unavailable, never fabricated.

import { sql } from "drizzle-orm";
import { getDb } from "../../queries/connection";
import { AttributionStateError, HEX_64 } from "./attribution-contract";

/** Frozen projection version consumed (R7-A conversion-outcome/v1). */
export const CONSUMED_OUTCOME_PROJECTION_VERSION = "conversion-outcome/v1" as const;

/**
 * Exact top-level key allowlist of the frozen R7-A outcome projection
 * (mirrored verbatim from R7-A `api/lib/outcome/outcome-projection.ts`
 * OUTCOME_PROJECTION_FIELD_KEYS on the frozen ref — the compatibility test
 * asserts this list against the frozen contract document).
 */
export const CONSUMED_OUTCOME_PROJECTION_FIELD_KEYS = [
  "contractVersion",
  "outcomeId",
  "businessId",
  "leadId",
  "leadIdentityVersion",
  "conversionId",
  "outcomeType",
  "outcomeStatus",
  "valueType",
  "amountMinor",
  "currency",
  "currencyExponent",
  "quantity",
  "metricUnit",
  "evidenceSource",
  "evidenceAuthority",
  "evidenceIdentity",
  "evidenceHash",
  "occurredAt",
  "recordedAt",
  "reversesOutcomeId",
  "renewsOutcomeId",
  "supersedesOutcomeId",
  "lifecycle",
  "causationClaimed",
  "causationDisclaimer",
  "attributionClaimed",
  "attributionDisclaimer",
] as const;

/** Verbatim frozen disclaimers — asserted, never paraphrased. */
export const CONSUMED_OUTCOME_CAUSATION_DISCLAIMER =
  "Outcome evidence only. This projection does not assert that any campaign, publication, opportunity, engagement or marketing activity caused this business outcome." as const;
export const CONSUMED_OUTCOME_ATTRIBUTION_DISCLAIMER =
  "Outcome evidence does not imply attribution. Credit allocation, causal scores and channel weights are R7-B derivations on their own authority, never derived from this projection's fields." as const;

const OUTCOME_ID_PATTERN = /^out1:[a-f0-9]{64}$/;
const CONVERSION_ID_PATTERN = /^cnv1:[a-f0-9]{64}$/;
const ISO_8601_PARSEABLE = (value: string) => !Number.isNaN(Date.parse(value));

/** The frozen R7-A outcome projection as consumed by R7-B. */
export interface ConsumedOutcomeProjection {
  readonly contractVersion: typeof CONSUMED_OUTCOME_PROJECTION_VERSION;
  readonly outcomeId: string;
  readonly businessId: number;
  readonly leadId: number | null;
  readonly leadIdentityVersion: string | null;
  readonly conversionId: string;
  readonly outcomeType: string;
  readonly outcomeStatus: string;
  readonly valueType: string;
  readonly amountMinor: number | null;
  readonly currency: string | null;
  readonly currencyExponent: number | null;
  readonly quantity: number | null;
  readonly metricUnit: string | null;
  readonly evidenceSource: string;
  readonly evidenceAuthority: string;
  readonly evidenceIdentity: string;
  readonly evidenceHash: string;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly reversesOutcomeId: string | null;
  readonly renewsOutcomeId: string | null;
  readonly supersedesOutcomeId: string | null;
  readonly lifecycle: { readonly statuses: readonly string[]; readonly currentStatus: string; readonly eventCount: number };
  readonly causationClaimed: false;
  readonly causationDisclaimer: string;
  readonly attributionClaimed: false;
  readonly attributionDisclaimer: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Strict validator for the frozen projection shape. Any structural drift —
 * unknown version, missing/extra key, wrong disclaimer, causal claim — fails
 * closed (ATTRIBUTION_UPSTREAM_CONTRACT_MISMATCH). R7-B never guesses.
 */
export function validateConsumedOutcomeProjection(raw: unknown): ConsumedOutcomeProjection {
  if (!isPlainObject(raw)) {
    throw new AttributionStateError(
      "ATTRIBUTION_UPSTREAM_CONTRACT_MISMATCH",
      "Outcome projection is not a structured object."
    );
  }
  const keys = Object.keys(raw);
  const expected = new Set<string>(CONSUMED_OUTCOME_PROJECTION_FIELD_KEYS);
  if (keys.length !== CONSUMED_OUTCOME_PROJECTION_FIELD_KEYS.length || keys.some((k) => !expected.has(k))) {
    throw new AttributionStateError(
      "ATTRIBUTION_UPSTREAM_CONTRACT_MISMATCH",
      "Outcome projection key set does not match the frozen conversion-outcome/v1 allowlist."
    );
  }
  const p = raw as unknown as ConsumedOutcomeProjection;
  if (p.contractVersion !== CONSUMED_OUTCOME_PROJECTION_VERSION) {
    throw new AttributionStateError(
      "ATTRIBUTION_UPSTREAM_CONTRACT_MISMATCH",
      `Outcome projection version ${String(p.contractVersion)} is not ${CONSUMED_OUTCOME_PROJECTION_VERSION}.`
    );
  }
  if (p.causationClaimed !== false || p.attributionClaimed !== false) {
    throw new AttributionStateError(
      "ATTRIBUTION_UPSTREAM_CONTRACT_MISMATCH",
      "Outcome projection must disclaim causation and attribution (both claimed flags false)."
    );
  }
  if (
    p.causationDisclaimer !== CONSUMED_OUTCOME_CAUSATION_DISCLAIMER ||
    p.attributionDisclaimer !== CONSUMED_OUTCOME_ATTRIBUTION_DISCLAIMER
  ) {
    throw new AttributionStateError(
      "ATTRIBUTION_UPSTREAM_CONTRACT_MISMATCH",
      "Outcome projection disclaimers do not match the frozen verbatim text."
    );
  }
  if (!OUTCOME_ID_PATTERN.test(p.outcomeId)) {
    throw new AttributionStateError(
      "ATTRIBUTION_UPSTREAM_CONTRACT_MISMATCH",
      "Outcome projection outcomeId is not an out1: identity."
    );
  }
  if (!CONVERSION_ID_PATTERN.test(p.conversionId)) {
    throw new AttributionStateError(
      "ATTRIBUTION_UPSTREAM_CONTRACT_MISMATCH",
      "Outcome projection conversionId is not a cnv1: identity."
    );
  }
  if (!Number.isInteger(p.businessId) || p.businessId <= 0) {
    throw new AttributionStateError(
      "ATTRIBUTION_UPSTREAM_CONTRACT_MISMATCH",
      "Outcome projection businessId is not a positive integer."
    );
  }
  if (p.leadId !== null && (!Number.isInteger(p.leadId) || p.leadId <= 0)) {
    throw new AttributionStateError(
      "ATTRIBUTION_UPSTREAM_CONTRACT_MISMATCH",
      "Outcome projection leadId must be null or a positive integer."
    );
  }
  if (!HEX_64.test(p.evidenceHash)) {
    throw new AttributionStateError(
      "ATTRIBUTION_UPSTREAM_CONTRACT_MISMATCH",
      "Outcome projection evidenceHash is not a 64-hex sha256."
    );
  }
  if (!ISO_8601_PARSEABLE(p.occurredAt) || !ISO_8601_PARSEABLE(p.recordedAt)) {
    throw new AttributionStateError(
      "ATTRIBUTION_UPSTREAM_CONTRACT_MISMATCH",
      "Outcome projection occurredAt/recordedAt must be parseable ISO 8601."
    );
  }
  if (!isPlainObject(p.lifecycle) || !Array.isArray(p.lifecycle.statuses)) {
    throw new AttributionStateError(
      "ATTRIBUTION_UPSTREAM_CONTRACT_MISMATCH",
      "Outcome projection lifecycle must carry a statuses array."
    );
  }
  return p;
}

/** Outcome authority port. Production reads the R7-A table; tests inject fakes. */
export interface OutcomeAuthorityPort {
  /** Tenant-scoped read of one frozen-shaped outcome projection (or null). */
  getOutcomeForAttribution(userId: number, outcomeId: string): Promise<ConsumedOutcomeProjection | null>;
}

type DbExecutor = ReturnType<typeof getDb>;

let outcomeTableExistsCache: boolean | null = null;

async function businessOutcomesTableExists(db: DbExecutor): Promise<boolean> {
  if (outcomeTableExistsCache !== null) return outcomeTableExistsCache;
  try {
    const result = (await db.execute(sql`
      SELECT COUNT(*) AS c FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'business_outcomes'
    `)) as unknown;
    const rows = Array.isArray(result)
      ? (result as unknown[][])
      : Array.isArray((result as { rows?: unknown[] }).rows)
        ? (result as { rows: unknown[] }).rows
        : [];
    const first = rows[0] as unknown;
    const count =
      first && typeof first === "object"
        ? Number((first as Record<string, unknown>).c ?? (first as unknown[])[0])
        : 0;
    outcomeTableExistsCache = Number.isInteger(count) && count > 0;
  } catch {
    outcomeTableExistsCache = false;
  }
  return outcomeTableExistsCache;
}

/**
 * Map a raw business_outcomes row (R7-A provisional schema, frozen contract §4)
 * into the frozen projection shape. R7-B consumes only; it never re-derives
 * outcome authority. The R7-A lifecycle facts table is not materialised on
 * this branch, so the lifecycle summary is derived from the row's current
 * status (statuses: [row.outcomeStatus]) — a faithful consumption view, not a
 * re-implementation.
 */
function mapOutcomeRow(row: Record<string, unknown>): ConsumedOutcomeProjection {
  const currency = (row.currency as string | null) ?? null;
  const currencyExponent = currency === null ? null : currency === "JPY" ? 0 : 2;
  const raw: Record<string, unknown> = {
    contractVersion: CONSUMED_OUTCOME_PROJECTION_VERSION,
    outcomeId: row.outcomeId,
    businessId: Number(row.businessId),
    leadId: row.leadId === null || row.leadId === undefined ? null : Number(row.leadId),
    leadIdentityVersion: row.leadIdentityVersion ?? null,
    conversionId: row.conversionId,
    outcomeType: row.outcomeType,
    outcomeStatus: row.outcomeStatus,
    valueType: row.valueType,
    amountMinor: row.amountMinor === null || row.amountMinor === undefined ? null : Number(row.amountMinor),
    currency,
    currencyExponent,
    quantity: row.quantity === null || row.quantity === undefined ? null : Number(row.quantity),
    metricUnit: row.metricUnit ?? null,
    evidenceSource: row.evidenceSource,
    evidenceAuthority: row.evidenceAuthority,
    evidenceIdentity: row.evidenceIdentity,
    evidenceHash: row.evidenceHash,
    occurredAt: row.occurredAt,
    recordedAt: row.recordedAt,
    reversesOutcomeId: row.reversesOutcomeId ?? null,
    renewsOutcomeId: row.renewsOutcomeId ?? null,
    supersedesOutcomeId: row.supersedesOutcomeId ?? null,
    lifecycle: {
      statuses: [row.outcomeStatus],
      currentStatus: row.outcomeStatus,
      eventCount: 1,
    },
    causationClaimed: false,
    causationDisclaimer: CONSUMED_OUTCOME_CAUSATION_DISCLAIMER,
    attributionClaimed: false,
    attributionDisclaimer: CONSUMED_OUTCOME_ATTRIBUTION_DISCLAIMER,
  };
  return validateConsumedOutcomeProjection(raw);
}

/** Production outcome authority: guarded read of the R7-A table. */
export function createOutcomeAuthorityPort(executor?: DbExecutor): OutcomeAuthorityPort {
  const db = executor ?? getDb();
  return {
    async getOutcomeForAttribution(userId, outcomeId) {
      if (!(await businessOutcomesTableExists(db))) {
        // Fail-closed degradation: until R7-X materialises the R7-A tables,
        // no outcomes are readable. Attribution is unavailable, not fabricated.
        return null;
      }
      const result = (await db.execute(sql`
        SELECT outcomeId, businessId, leadId, leadIdentityVersion, conversionId,
               outcomeType, outcomeStatus, valueType, amountMinor, currency,
               quantity, metricUnit, evidenceSource, evidenceAuthority,
               evidenceIdentity, evidenceHash, occurredAt, recordedAt,
               reversesOutcomeId, renewsOutcomeId, supersedesOutcomeId
        FROM business_outcomes
        WHERE userId = ${userId} AND outcomeId = ${outcomeId}
        LIMIT 1
      `)) as unknown;
      const rows = Array.isArray(result)
        ? (result as Record<string, unknown>[])
        : Array.isArray((result as { rows?: unknown[] }).rows)
          ? (result as { rows: Record<string, unknown>[] }).rows
          : [];
      const row = rows[0];
      if (!row) return null;
      return mapOutcomeRow(row);
    },
  };
}
