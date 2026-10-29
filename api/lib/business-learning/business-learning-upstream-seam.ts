// ─── R7-C Business Learning Engine — upstream consumption seams ───
//
// R7-X canonical binding (X4): R7-C consumes the ACTUAL integrated R7-A and
// R7-B authorities. Outcome evidence is read through A's store, A's
// immutable-core integrity assertion and A's canonical projection builder;
// attribution evidence through B's store (integrity asserted internally), B's
// canonical learning projection builder, and B's lineage store. Each
// projection is then re-validated against C's frozen consumption contract
// below. C re-derives nothing; upstream disclaimers flow through verbatim.
//
// Production reads run against the canonical R7 tables
// (0035_r7_business_optimisation_foundation — structurally verified,
// MIGRATION_EXECUTION=False) behind guarded information-schema existence
// checks. When a table is absent the seam fail-closed degrades to "no such
// evidence": learning is unavailable, never fabricated.

import { sql } from "drizzle-orm";
import { getDb } from "../../queries/connection";
import {
  getOutcomeByOutcomeId,
  listOutcomeLifecycleEvents,
  assertOutcomeEvidenceIntegrity,
} from "../outcome/outcome-store";
import { buildOutcomeProjection } from "../outcome/outcome-projection";
import {
  getAttributionById,
  findSupersedingAttribution as findSupersedingAttributionRow,
} from "../attribution/attribution-store";
import { buildAttributionLearningProjection } from "../attribution/attribution-projection";
import {
  LearningStateError,
  HEX_64,
  OUTCOME_ID_PATTERN,
  ATTRIBUTION_ID_PATTERN,
} from "./business-learning-contract";

// ─── Frozen R7-A outcome projection (conversion-outcome/v1) ───

export const CONSUMED_OUTCOME_PROJECTION_VERSION = "conversion-outcome/v1" as const;

/**
 * Exact top-level key allowlist of the frozen R7-A outcome projection
 * (mirrored verbatim from the frozen contract §10, branch
 * feature/r7-a-conversion-outcome-intelligence @ 3e8aea8). The compatibility
 * test asserts this list against the frozen contract document.
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

const ISO_8601_PARSEABLE = (value: string) => !Number.isNaN(Date.parse(value));

/** The frozen R7-A outcome projection as consumed by R7-C. */
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
  readonly lifecycle: {
    readonly statuses: readonly string[];
    readonly currentStatus: string;
    readonly eventCount: number;
  };
  readonly causationClaimed: false;
  readonly causationDisclaimer: string;
  readonly attributionClaimed: false;
  readonly attributionDisclaimer: string;
}

// ─── Frozen R7-B attribution learning projection (attribution-to-learning/v1) ───

export const CONSUMED_ATTRIBUTION_PROJECTION_VERSION = "attribution-to-learning/v1" as const;

/**
 * Exact top-level key allowlist of the frozen R7-B attribution learning
 * projection (mirrored verbatim from the frozen contract §10, branch
 * feature/r7-b-attribution-intelligence @ 6ff9eca).
 */
export const CONSUMED_ATTRIBUTION_PROJECTION_FIELD_KEYS = [
  "contractVersion",
  "attributionId",
  "outcomeId",
  "outcomeStatus",
  "outcomeType",
  "businessId",
  "leadId",
  "conversionId",
  "modelType",
  "modelVersion",
  "windowStart",
  "windowEnd",
  "touchpoints",
  "excludedTouchpoints",
  "totalCreditBps",
  "confidenceClass",
  "evidenceClass",
  "policyVersion",
  "sourceVersions",
  "supersedesAttributionId",
  "journeyHash",
  "calculatedAt",
  "causationClaimed",
  "causationDisclaimer",
  "attributionClaimed",
] as const;

/** Verbatim frozen disclaimer — asserted, never paraphrased. */
export const CONSUMED_ATTRIBUTION_CAUSATION_DISCLAIMER =
  "Allocated credit is association evidence, not causal proof. This projection does not assert that any touchpoint caused the business outcome." as const;

/** One credited/excluded touchpoint inside the frozen attribution projection. */
export interface ConsumedAttributionTouchpoint {
  readonly touchpointId: string;
  readonly type: string;
  readonly sourceIdentity: string;
  readonly businessId: number | null;
  readonly occurredAt: string;
  readonly provenance?: unknown;
  readonly eligibility: string;
  readonly creditBps: number;
  readonly reason?: string;
}

/** The frozen R7-B attribution learning projection as consumed by R7-C. */
export interface ConsumedAttributionProjection {
  readonly contractVersion: typeof CONSUMED_ATTRIBUTION_PROJECTION_VERSION;
  readonly attributionId: string;
  readonly outcomeId: string;
  readonly outcomeStatus: string;
  readonly outcomeType: string;
  readonly businessId: number;
  readonly leadId: number | null;
  readonly conversionId: string;
  readonly modelType: string;
  readonly modelVersion: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly touchpoints: readonly ConsumedAttributionTouchpoint[];
  readonly excludedTouchpoints: readonly ConsumedAttributionTouchpoint[];
  readonly totalCreditBps: number;
  readonly confidenceClass: string;
  readonly evidenceClass: string;
  readonly policyVersion: string;
  readonly sourceVersions: unknown;
  readonly supersedesAttributionId: string | null;
  readonly journeyHash: string;
  readonly calculatedAt: string;
  readonly causationClaimed: false;
  readonly causationDisclaimer: string;
  readonly attributionClaimed: true;
}

// ─── Strict frozen-shape validators (fail closed on any drift) ───

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeySet(
  raw: Record<string, unknown>,
  allowlist: readonly string[],
  what: string
): void {
  const expected = new Set<string>(allowlist);
  const keys = Object.keys(raw);
  if (keys.length !== allowlist.length || keys.some((k) => !expected.has(k))) {
    throw new LearningStateError(
      "LEARNING_UPSTREAM_CONTRACT_MISMATCH",
      `${what} key set does not match the frozen allowlist.`
    );
  }
}

/**
 * Strict validator for the frozen R7-A outcome projection shape. Unknown
 * version, missing/extra key, wrong disclaimer, or a causal claim fails
 * closed. R7-C never guesses.
 */
export function validateConsumedOutcomeProjection(raw: unknown): ConsumedOutcomeProjection {
  if (!isPlainObject(raw)) {
    throw new LearningStateError(
      "LEARNING_UPSTREAM_CONTRACT_MISMATCH",
      "Outcome projection is not a structured object."
    );
  }
  assertExactKeySet(raw, CONSUMED_OUTCOME_PROJECTION_FIELD_KEYS, "Outcome projection");
  const p = raw as unknown as ConsumedOutcomeProjection;
  if (p.contractVersion !== CONSUMED_OUTCOME_PROJECTION_VERSION) {
    throw new LearningStateError(
      "LEARNING_UPSTREAM_CONTRACT_MISMATCH",
      `Outcome projection version ${String(p.contractVersion)} is not ${CONSUMED_OUTCOME_PROJECTION_VERSION}.`
    );
  }
  if (p.causationClaimed !== false || p.attributionClaimed !== false) {
    throw new LearningStateError(
      "LEARNING_UPSTREAM_CONTRACT_MISMATCH",
      "Outcome projection must disclaim causation and attribution (both claimed flags false)."
    );
  }
  if (
    p.causationDisclaimer !== CONSUMED_OUTCOME_CAUSATION_DISCLAIMER ||
    p.attributionDisclaimer !== CONSUMED_OUTCOME_ATTRIBUTION_DISCLAIMER
  ) {
    throw new LearningStateError(
      "LEARNING_UPSTREAM_CONTRACT_MISMATCH",
      "Outcome projection disclaimers do not match the frozen verbatim text."
    );
  }
  if (!OUTCOME_ID_PATTERN.test(p.outcomeId)) {
    throw new LearningStateError(
      "LEARNING_UPSTREAM_CONTRACT_MISMATCH",
      "Outcome projection outcomeId is not an out1: identity."
    );
  }
  if (!Number.isInteger(p.businessId) || p.businessId <= 0) {
    throw new LearningStateError(
      "LEARNING_UPSTREAM_CONTRACT_MISMATCH",
      "Outcome projection businessId is not a positive integer."
    );
  }
  if (!HEX_64.test(p.evidenceHash)) {
    throw new LearningStateError(
      "LEARNING_UPSTREAM_CONTRACT_MISMATCH",
      "Outcome projection evidenceHash is not a 64-hex sha256."
    );
  }
  if (!ISO_8601_PARSEABLE(p.occurredAt) || !ISO_8601_PARSEABLE(p.recordedAt)) {
    throw new LearningStateError(
      "LEARNING_UPSTREAM_CONTRACT_MISMATCH",
      "Outcome projection occurredAt/recordedAt must be parseable ISO 8601."
    );
  }
  if (!isPlainObject(p.lifecycle) || !Array.isArray(p.lifecycle.statuses)) {
    throw new LearningStateError(
      "LEARNING_UPSTREAM_CONTRACT_MISMATCH",
      "Outcome projection lifecycle must carry a statuses array."
    );
  }
  return p;
}

/**
 * Strict validator for the frozen R7-B attribution learning projection
 * shape. Same discipline: exact keys, frozen version, verbatim disclaimer,
 * atr1:/out1: identity patterns, closed class labels.
 */
export function validateConsumedAttributionProjection(
  raw: unknown
): ConsumedAttributionProjection {
  if (!isPlainObject(raw)) {
    throw new LearningStateError(
      "LEARNING_UPSTREAM_CONTRACT_MISMATCH",
      "Attribution projection is not a structured object."
    );
  }
  assertExactKeySet(
    raw,
    CONSUMED_ATTRIBUTION_PROJECTION_FIELD_KEYS,
    "Attribution projection"
  );
  const p = raw as unknown as ConsumedAttributionProjection;
  if (p.contractVersion !== CONSUMED_ATTRIBUTION_PROJECTION_VERSION) {
    throw new LearningStateError(
      "LEARNING_UPSTREAM_CONTRACT_MISMATCH",
      `Attribution projection version ${String(p.contractVersion)} is not ${CONSUMED_ATTRIBUTION_PROJECTION_VERSION}.`
    );
  }
  if (p.causationClaimed !== false || p.attributionClaimed !== true) {
    throw new LearningStateError(
      "LEARNING_UPSTREAM_CONTRACT_MISMATCH",
      "Attribution projection must disclaim causation (false) and claim attribution (true)."
    );
  }
  if (p.causationDisclaimer !== CONSUMED_ATTRIBUTION_CAUSATION_DISCLAIMER) {
    throw new LearningStateError(
      "LEARNING_UPSTREAM_CONTRACT_MISMATCH",
      "Attribution projection disclaimer does not match the frozen verbatim text."
    );
  }
  if (!ATTRIBUTION_ID_PATTERN.test(p.attributionId)) {
    throw new LearningStateError(
      "LEARNING_UPSTREAM_CONTRACT_MISMATCH",
      "Attribution projection attributionId is not an atr1: identity."
    );
  }
  if (!OUTCOME_ID_PATTERN.test(p.outcomeId)) {
    throw new LearningStateError(
      "LEARNING_UPSTREAM_CONTRACT_MISMATCH",
      "Attribution projection outcomeId is not an out1: identity."
    );
  }
  if (!Number.isInteger(p.businessId) || p.businessId <= 0) {
    throw new LearningStateError(
      "LEARNING_UPSTREAM_CONTRACT_MISMATCH",
      "Attribution projection businessId is not a positive integer."
    );
  }
  if (!Number.isInteger(p.totalCreditBps) || p.totalCreditBps < 0) {
    throw new LearningStateError(
      "LEARNING_UPSTREAM_CONTRACT_MISMATCH",
      "Attribution projection totalCreditBps is not a non-negative integer."
    );
  }
  if (!Array.isArray(p.touchpoints)) {
    throw new LearningStateError(
      "LEARNING_UPSTREAM_CONTRACT_MISMATCH",
      "Attribution projection touchpoints must be an array."
    );
  }
  return p;
}

// ─── Upstream authority ports (production reads the upstream tables; tests inject fakes) ───

export interface OutcomeAuthorityPort {
  /** Tenant-scoped read of one frozen-shaped outcome projection (or null). */
  getOutcomeForLearning(userId: number, outcomeId: string): Promise<ConsumedOutcomeProjection | null>;
}

export interface AttributionAuthorityPort {
  /** Tenant-scoped read of one frozen-shaped attribution projection (or null). */
  getAttributionForLearning(
    userId: number,
    attributionId: string
  ): Promise<ConsumedAttributionProjection | null>;
  /**
   * Returns the attributionId of the row that superseded this one (or null
   * when current), per the frozen R7-B lineage column
   * (supersedesAttributionId). R7-C consumes the lineage; it never
   * re-implements supersession authority.
   */
  findSupersedingAttribution(userId: number, attributionId: string): Promise<string | null>;
}

export interface BusinessLearningUpstreamPorts {
  readonly outcomes: OutcomeAuthorityPort;
  readonly attributions: AttributionAuthorityPort;
}

type DbExecutor = ReturnType<typeof getDb>;

const tableExistsCache = new Map<string, boolean>();

async function tableExists(db: DbExecutor, tableName: string): Promise<boolean> {
  const cached = tableExistsCache.get(tableName);
  if (cached !== undefined) return cached;
  let exists = false;
  try {
    const result = (await db.execute(sql`
      SELECT COUNT(*) AS c FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${tableName}
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
    exists = Number.isInteger(count) && count > 0;
  } catch {
    exists = false;
  }
  tableExistsCache.set(tableName, exists);
  return exists;
}

/**
 * Production upstream authority (X4 canonical binding). Outcome evidence is
 * read through the integrated R7-A authority — store read, immutable-core
 * integrity assertion, canonical projection builder (real lifecycle facts) —
 * then re-validated against C's frozen consumption contract. Attribution
 * evidence is read through B's store (record integrity asserted internally)
 * and projected by B's canonical learning-projection builder. Lineage
 * (supersession) is B store authority, never re-implemented here. When a
 * canonical table is absent every read degrades fail-closed to "no such
 * evidence" — learning is unavailable, never fabricated.
 */
export function createUpstreamPorts(executor?: DbExecutor): BusinessLearningUpstreamPorts {
  const db = executor ?? getDb();
  return {
    outcomes: {
      async getOutcomeForLearning(userId, outcomeId) {
        if (!(await tableExists(db, "business_outcomes"))) return null;
        const row = await getOutcomeByOutcomeId(userId, outcomeId, db);
        if (!row) return null;
        assertOutcomeEvidenceIntegrity(row as never);
        const lifecycle = await listOutcomeLifecycleEvents(userId, outcomeId, db);
        const projection = buildOutcomeProjection(row as never, lifecycle);
        return validateConsumedOutcomeProjection(projection);
      },
    },
    attributions: {
      async getAttributionForLearning(userId, attributionId) {
        if (!(await tableExists(db, "attribution_results"))) return null;
        const row = await getAttributionById(userId, attributionId, db);
        if (!row) return null;
        return validateConsumedAttributionProjection(buildAttributionLearningProjection(row));
      },
      async findSupersedingAttribution(userId, attributionId) {
        if (!(await tableExists(db, "attribution_results"))) return null;
        return findSupersedingAttributionRow(userId, attributionId, db);
      },
    },
  };
}
