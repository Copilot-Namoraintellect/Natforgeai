// ─── R7-B Attribution Intelligence — R7-A outcome consumption seam ───
//
// R7-B consumes R7-A business outcomes EXCLUSIVELY through the frozen
// conversion-outcome/v1 projection defined by the R7-A contract
// (docs/contracts/conversion-outcome-to-attribution-learning-contract.md).
// R7-X canonical binding (X3): the production port reads through the
// integrated R7-A authority itself — A's store reads, A's immutable-core
// integrity assertion, and A's projection builder — then re-validates the
// result against B's frozen consumption contract below. B re-derives nothing;
// R7-A code never asserts causation; neither does this seam.
//
// Production reads run against the canonical R7-A tables
// (0035_r7_business_optimisation_foundation — structurally verified,
// MIGRATION_EXECUTION=False) behind a guarded information-schema existence
// check over the canonical outcome table pair. When the tables are absent the
// seam fail-closed degrades to "no outcome" — attribution is unavailable,
// never fabricated.

import { sql } from "drizzle-orm";
import { getDb } from "../../queries/connection";
import {
  getOutcomeByOutcomeId,
  listOutcomeLifecycleEvents,
  assertOutcomeEvidenceIntegrity,
} from "../outcome/outcome-store";
import { buildOutcomeProjection } from "../outcome/outcome-projection";
import type { OutcomeProjection } from "../outcome/outcome-projection";
import { AttributionStateError, HEX_64 } from "./attribution-contract";

/** Frozen projection version consumed (R7-A conversion-outcome/v1). */
export const CONSUMED_OUTCOME_PROJECTION_VERSION = "conversion-outcome/v1" as const;

/**
 * Exact top-level key allowlist of the frozen R7-A outcome projection
 * (mirrored verbatim from R7-A `api/lib/outcome/outcome-projection.ts`
 * OUTCOME_PROJECTION_FIELD_KEYS — the compatibility test asserts this list
 * against the frozen contract document).
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

/** Outcome authority port. Production reads through integrated R7-A; tests inject fakes. */
export interface OutcomeAuthorityPort {
  /** Tenant-scoped read of one frozen-shaped outcome projection (or null). */
  getOutcomeForAttribution(userId: number, outcomeId: string): Promise<ConsumedOutcomeProjection | null>;
}

type DbExecutor = ReturnType<typeof getDb>;

let outcomeTablesExistCache: boolean | null = null;

async function businessOutcomeTablesExist(db: DbExecutor): Promise<boolean> {
  if (outcomeTablesExistCache !== null) return outcomeTablesExistCache;
  try {
    const result = (await db.execute(sql`
      SELECT COUNT(*) AS c FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('business_outcomes', 'business_outcome_lifecycle_events')
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
    // Canonical pair: both R7-A tables must exist for a faithful projection.
    outcomeTablesExistCache = Number.isInteger(count) && count === 2;
  } catch {
    outcomeTablesExistCache = false;
  }
  return outcomeTablesExistCache;
}

/**
 * Production outcome authority: canonical read through the integrated R7-A
 * authority (X3 binding). The immutable-core integrity assertion is A's own —
 * a hash-drifted row is tampering and fails closed before B ever sees it.
 * The projection is A's canonical builder (real lifecycle facts), re-validated
 * here against B's frozen consumption contract.
 */
export function createOutcomeAuthorityPort(executor?: DbExecutor): OutcomeAuthorityPort {
  const db = executor ?? getDb();
  return {
    async getOutcomeForAttribution(userId, outcomeId) {
      if (!(await businessOutcomeTablesExist(db))) {
        // Fail-closed degradation: without the canonical R7-A tables no
        // outcomes are readable. Attribution is unavailable, not fabricated.
        return null;
      }
      const row = await getOutcomeByOutcomeId(userId, outcomeId, db);
      if (!row) return null;
      assertOutcomeEvidenceIntegrity(row as never);
      const lifecycle = await listOutcomeLifecycleEvents(userId, outcomeId, db);
      const projection = buildOutcomeProjection(row as never, lifecycle) as OutcomeProjection;
      return validateConsumedOutcomeProjection(projection);
    },
  };
}
