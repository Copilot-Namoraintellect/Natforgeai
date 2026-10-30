// ─── R8-D Strategic Reasoning — upstream evidence seam ───
//
// Resolves R8-A / R8-B / R8-C evidence READ-ONLY by exact reference, behind
// guarded information-schema checks (house seam pattern — the upstream tables
// are provisional on sibling branches; R8-X owns canonical binding). Every
// row is re-validated at consumption: tenant + business scope, identity
// pattern, frozen upstream contract version, status/freshness. This seam
// never writes any upstream table and never mints upstream identities,
// statuses, trust classes or lifecycle resolutions.
//
// Cross-tenant / cross-business / unknown references are indistinguishable
// and fail closed with UNKNOWN_EVIDENCE_REFERENCE. Stale/unsupported contract
// versions fail closed with EVIDENCE_CONTRACT_VERSION_UNSUPPORTED. Absent
// upstream authority (table missing while refs are supplied) fails closed
// with EVIDENCE_AUTHORITY_UNAVAILABLE.

import { sql } from "drizzle-orm";
import { getDb } from "../../queries/connection";
import {
  CHANGE_REF_PATTERN,
  fail,
  isIsoUtc,
  MEMORY_REF_PATTERN,
  SIGNAL_REF_PATTERN,
} from "./strategic-reasoning-contract";

// ─── Frozen upstream contract versions (bound at evaluation) ───

/** R8-A strategic-memory/v1 — per-sourceAuthority frozen source versions. */
export const STRATEGIC_MEMORY_SOURCE_VERSIONS: Readonly<Record<string, string>> = Object.freeze({
  r7_outcome: "conversion-outcome/v1",
  r7_attribution: "attribution-to-learning/v1",
  r7_learning: "business-learning-to-experiment-optimisation/v1",
  r7_experimentation: "experimentation-result-handoff/v1",
  r7_budget_portfolio: "business-optimisation-to-strategy/v1",
  r7_governance: "optimisation-governance/v1",
  business_dna: "business-dna/v1",
  strategy_snapshot: "strategy-snapshot/v1",
  operator_attestation: "operator/v1",
});

/** R8-B business-change/v1 — per-sourceAuthority frozen source versions. */
export const BUSINESS_CHANGE_SOURCE_VERSIONS: Readonly<Record<string, string>> = Object.freeze({
  business_dna: "business-dna/v1",
  strategy_snapshot: "strategy-snapshot/v1",
  r7_budget_portfolio: "business-optimisation-to-strategy/v1",
  r7_learning: "business-learning-to-experiment-optimisation/v1",
  r7_governance: "optimisation-governance/v1",
  operator_attestation: "operator/v1",
});

/** R8-C market-external-signal/v1 — frozen freshness policy artefact. */
export const MARKET_SIGNAL_FRESHNESS_POLICY_VERSION = "market-signal-freshness/v1" as const;

// ─── Closed upstream vocabularies this seam re-validates against ───

const MEMORY_TYPES = new Set([
  "BUSINESS_FACT",
  "BUSINESS_ASSUMPTION",
  "STRATEGIC_OBJECTIVE",
  "STRATEGIC_DECISION",
  "OUTCOME_PATTERN",
  "LEARNING_PATTERN",
  "EXPERIMENT_RESULT",
  "OPTIMISATION_DECISION",
  "CONSTRAINT",
]);
const MEMORY_STATUSES = new Set(["CURRENT", "STALE", "SUPERSEDED", "CONTRADICTED", "EXPIRED", "INVALIDATED"]);
const MEMORY_CONFIDENCE = new Set(["AUTHORITATIVE", "VERIFIED", "PROVISIONAL", "OBSERVED", "UNVERIFIED"]);

const CHANGE_TYPES = new Set([
  "OBJECTIVE_ADDED",
  "OBJECTIVE_MODIFIED",
  "OBJECTIVE_REMOVED",
  "BUDGET_ENVELOPE_INCREASED",
  "BUDGET_ENVELOPE_DECREASED",
  "PROVIDER_SUPPORT_ADDED",
  "PROVIDER_SUPPORT_REMOVED",
  "PRODUCT_ADDED",
  "PRODUCT_REMOVED",
  "PRODUCT_REPOSITIONED",
  "AUDIENCE_SEGMENT_ADDED",
  "AUDIENCE_SEGMENT_REMOVED",
  "AUDIENCE_REPOSITIONED",
  "LEARNING_PATTERN_CONTRADICTED",
  "LEARNING_PATTERN_SUPERSEDED",
  "STRATEGY_REGIME_CHANGED",
  "CONSTRAINT_TIGHTENED",
  "CONSTRAINT_RELAXED",
  "RISK_POSTURE_ELEVATED",
  "RISK_POSTURE_REDUCED",
]);
const CHANGE_STATUSES = new Set(["DETECTED", "CONFIRMED", "PROVISIONAL", "CONTRADICTED", "SUPERSEDED", "INVALIDATED", "EXPIRED"]);
const CHANGE_SIGNIFICANCE = new Set(["LOW", "MODERATE", "HIGH", "CRITICAL"]);
const CHANGE_CONFIDENCE = new Set(["AUTHORITATIVE", "VERIFIED", "PROVISIONAL", "OBSERVED", "UNVERIFIED"]);

const SIGNAL_TYPES = new Set([
  "COMPETITOR_ACTION",
  "MARKET_DEMAND",
  "PRICING_CHANGE",
  "PRODUCT_LAUNCH",
  "REGULATORY_CHANGE",
  "TECHNOLOGY_CHANGE",
  "CHANNEL_PLATFORM_CHANGE",
  "MACRO_ENVIRONMENT",
  "REPUTATION_SIGNAL",
  "ECOSYSTEM_CHANGE",
]);
const SIGNAL_TRUST = new Set([
  "VERIFIED_EXTERNAL",
  "CORROBORATED_EXTERNAL",
  "SINGLE_EXTERNAL_SOURCE",
  "UNVERIFIED",
  "CONTRADICTED",
  "MALFORMED",
]);
const SIGNAL_FRESHNESS = new Set(["CURRENT", "AGING", "STALE", "EXPIRED"]);
const SIGNAL_CORROBORATION = new Set(["UNCORROBORATED", "CORROBORATED", "MIXED", "CONTRADICTED"]);
const SIGNAL_RELEVANCE = new Set(["DIRECT", "RELATED", "WEAK", "IRRELEVANT"]);
const SIGNAL_STATUSES = new Set(["OBSERVED", "CORROBORATED", "CONTRADICTED", "SUPERSEDED", "STALE", "INVALIDATED"]);
const SIGNAL_CONFIDENCE = new Set(["NONE", "LOW", "MEDIUM", "HIGH"]);

// ─── Evidence views (closed shapes; content never loaded) ───

export interface MemoryEvidenceView {
  readonly ref: string;
  readonly evidenceClass: "INTERNAL_MEMORY";
  readonly memoryType: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly statementType: "FACT" | "ASSUMPTION";
  readonly factStatus: string;
  readonly confidenceClass: string;
  readonly sourceAuthority: string;
  readonly sourceVersion: string;
  readonly evidenceHash: string;
  readonly observedAt: string;
  readonly recordedAt: string;
  readonly validUntil: string | null;
  readonly contradictsMemoryIds: readonly string[];
  readonly contextScopeType: string | null;
  readonly contextSubjectId: string | null;
}

export interface ChangeEvidenceView {
  readonly ref: string;
  readonly evidenceClass: "INTERNAL_CHANGE";
  readonly changeDomain: string;
  readonly changeType: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly significanceClass: string;
  readonly confidenceClass: string;
  readonly status: string;
  readonly sourceAuthority: string;
  readonly sourceVersion: string;
  readonly detectedAt: string;
  readonly effectiveAt: string;
  readonly recordedAt: string;
  readonly validUntil: string | null;
  readonly supersedesChangeId: string | null;
}

export interface SignalEvidenceView {
  readonly ref: string;
  readonly evidenceClass: "EXTERNAL_SIGNAL";
  readonly signalType: string;
  readonly subjectType: string;
  readonly subjectRef: string;
  readonly claimAspect: string;
  readonly sourceTrustClass: string;
  readonly confidenceClass: string;
  readonly freshnessClass: string;
  readonly freshnessPolicyVersion: string;
  readonly corroborationStatus: string;
  readonly corroboratingSignalIds: readonly string[];
  readonly contradictingSignalIds: readonly string[];
  readonly relevanceClass: string;
  readonly signalStatus: string;
  readonly observedAt: string;
  readonly ingestedAt: string;
  readonly injectionSuspected: boolean;
  readonly supersedesSignalId: string | null;
}

export type StrategicEvidenceView = MemoryEvidenceView | ChangeEvidenceView | SignalEvidenceView;

/**
 * The business authority is the canonical `businesses` table (resolved by the
 * service through the store executor, not this seam).
 */
export interface StrategicEvidenceAuthority {
  resolveMemory(userId: number, businessId: number, ref: string): Promise<MemoryEvidenceView | null>;
  resolveChange(userId: number, businessId: number, ref: string): Promise<ChangeEvidenceView | null>;
  resolveSignal(userId: number, businessId: number, ref: string): Promise<SignalEvidenceView | null>;
}

// ─── Row shaping + validation ───

function parseJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function asIso(value: unknown): string {
  return typeof value === "string" && isIsoUtc(value) ? value : "";
}

function shapeMemoryRow(row: Record<string, unknown>): MemoryEvidenceView {
  const ref = String(row.memoryId ?? "");
  if (!MEMORY_REF_PATTERN.test(ref)) fail("MALFORMED_EVIDENCE", "memory row has malformed memoryId");
  const memoryType = String(row.memoryType ?? "");
  const factStatus = String(row.factStatus ?? "");
  const confidenceClass = String(row.confidenceClass ?? "");
  const sourceAuthority = String(row.sourceAuthority ?? "");
  const sourceVersion = String(row.sourceVersion ?? "");
  if (!MEMORY_TYPES.has(memoryType)) fail("MALFORMED_EVIDENCE", `unknown memoryType ${memoryType}`);
  if (!MEMORY_STATUSES.has(factStatus)) fail("MALFORMED_EVIDENCE", `unknown factStatus ${factStatus}`);
  if (!MEMORY_CONFIDENCE.has(confidenceClass)) fail("MALFORMED_EVIDENCE", `unknown memory confidence ${confidenceClass}`);
  const frozen = STRATEGIC_MEMORY_SOURCE_VERSIONS[sourceAuthority];
  if (!frozen || sourceVersion !== frozen) {
    fail(
      "EVIDENCE_CONTRACT_VERSION_UNSUPPORTED",
      `memory ${ref} binds unsupported sourceVersion ${sourceVersion} for ${sourceAuthority}`
    );
  }
  const observedAt = asIso(row.observedAt);
  const recordedAt = asIso(row.recordedAt);
  if (!observedAt || !recordedAt) fail("MALFORMED_EVIDENCE", `memory ${ref} has malformed timestamps`);
  const evidenceHash = String(row.evidenceHash ?? "");
  if (!/^[a-f0-9]{64}$/.test(evidenceHash)) fail("MALFORMED_EVIDENCE", `memory ${ref} has malformed evidenceHash`);
  const statementType = row.statementType === "ASSUMPTION" ? "ASSUMPTION" : "FACT";
  const contextScope = row.contextScope;
  const scope =
    typeof contextScope === "string"
      ? (JSON.parse(contextScope) as Record<string, unknown>)
      : ((contextScope ?? {}) as Record<string, unknown>);
  const validUntilRaw = row.validUntil;
  return {
    ref,
    evidenceClass: "INTERNAL_MEMORY",
    memoryType,
    subjectType: String(row.subjectType ?? ""),
    subjectId: String(row.subjectId ?? ""),
    statementType,
    factStatus,
    confidenceClass,
    sourceAuthority,
    sourceVersion,
    evidenceHash,
    observedAt,
    recordedAt,
    validUntil: typeof validUntilRaw === "string" && validUntilRaw.length > 0 ? validUntilRaw : null,
    contradictsMemoryIds: parseJsonArray(row.contradictsMemoryIds).map(String),
    contextScopeType: typeof scope?.scopeType === "string" ? scope.scopeType : null,
    contextSubjectId: typeof scope?.subjectId === "string" ? scope.subjectId : null,
  };
}

function shapeChangeRow(row: Record<string, unknown>): ChangeEvidenceView {
  const ref = String(row.changeId ?? "");
  if (!CHANGE_REF_PATTERN.test(ref)) fail("MALFORMED_EVIDENCE", "change row has malformed changeId");
  const changeType = String(row.changeType ?? "");
  const status = String(row.status ?? "");
  const significanceClass = String(row.significanceClass ?? "");
  const confidenceClass = String(row.confidenceClass ?? "");
  const sourceAuthority = String(row.sourceAuthority ?? "");
  const sourceVersion = String(row.sourceVersion ?? "");
  if (!CHANGE_TYPES.has(changeType)) fail("MALFORMED_EVIDENCE", `unknown changeType ${changeType}`);
  if (!CHANGE_STATUSES.has(status)) fail("MALFORMED_EVIDENCE", `unknown change status ${status}`);
  if (!CHANGE_SIGNIFICANCE.has(significanceClass)) fail("MALFORMED_EVIDENCE", `unknown significance ${significanceClass}`);
  if (!CHANGE_CONFIDENCE.has(confidenceClass)) fail("MALFORMED_EVIDENCE", `unknown change confidence ${confidenceClass}`);
  const frozen = BUSINESS_CHANGE_SOURCE_VERSIONS[sourceAuthority];
  if (!frozen || sourceVersion !== frozen) {
    fail(
      "EVIDENCE_CONTRACT_VERSION_UNSUPPORTED",
      `change ${ref} binds unsupported sourceVersion ${sourceVersion} for ${sourceAuthority}`
    );
  }
  const detectedAt = asIso(row.detectedAt);
  const effectiveAt = asIso(row.effectiveAt);
  const recordedAt = asIso(row.recordedAt);
  if (!detectedAt || !effectiveAt || !recordedAt) fail("MALFORMED_EVIDENCE", `change ${ref} has malformed timestamps`);
  const evidenceHash = String(row.evidenceHash ?? "");
  if (!/^[a-f0-9]{64}$/.test(evidenceHash)) fail("MALFORMED_EVIDENCE", `change ${ref} has malformed evidenceHash`);
  const validUntilRaw = row.validUntil;
  const supersedes = row.supersedesChangeId;
  return {
    ref,
    evidenceClass: "INTERNAL_CHANGE",
    changeDomain: String(row.changeDomain ?? ""),
    changeType,
    subjectType: String(row.subjectType ?? ""),
    subjectId: String(row.subjectId ?? ""),
    significanceClass,
    confidenceClass,
    status,
    sourceAuthority,
    sourceVersion,
    detectedAt,
    effectiveAt,
    recordedAt,
    validUntil: typeof validUntilRaw === "string" && validUntilRaw.length > 0 ? validUntilRaw : null,
    supersedesChangeId: typeof supersedes === "string" && supersedes.length > 0 ? supersedes : null,
  };
}

function shapeSignalRow(row: Record<string, unknown>): SignalEvidenceView {
  const ref = String(row.signalId ?? "");
  if (!SIGNAL_REF_PATTERN.test(ref)) fail("MALFORMED_EVIDENCE", "signal row has malformed signalId");
  const signalType = String(row.signalType ?? "");
  const trust = String(row.sourceTrustClass ?? "");
  const confidenceClass = String(row.confidenceClass ?? "");
  const freshnessClass = String(row.freshnessClass ?? "");
  const freshnessPolicyVersion = String(row.freshnessPolicyVersion ?? "");
  const corroborationStatus = String(row.corroborationStatus ?? "");
  const relevanceClass = String(row.relevanceClass ?? "");
  const signalStatus = String(row.signalStatus ?? "");
  if (!SIGNAL_TYPES.has(signalType)) fail("MALFORMED_EVIDENCE", `unknown signalType ${signalType}`);
  if (!SIGNAL_TRUST.has(trust)) fail("MALFORMED_EVIDENCE", `unknown sourceTrustClass ${trust}`);
  if (!SIGNAL_CONFIDENCE.has(confidenceClass)) fail("MALFORMED_EVIDENCE", `unknown signal confidence ${confidenceClass}`);
  if (!SIGNAL_FRESHNESS.has(freshnessClass)) fail("MALFORMED_EVIDENCE", `unknown freshnessClass ${freshnessClass}`);
  if (freshnessPolicyVersion !== MARKET_SIGNAL_FRESHNESS_POLICY_VERSION) {
    fail(
      "EVIDENCE_CONTRACT_VERSION_UNSUPPORTED",
      `signal ${ref} binds unsupported freshnessPolicyVersion ${freshnessPolicyVersion}`
    );
  }
  if (!SIGNAL_CORROBORATION.has(corroborationStatus)) fail("MALFORMED_EVIDENCE", `unknown corroborationStatus ${corroborationStatus}`);
  if (!SIGNAL_RELEVANCE.has(relevanceClass)) fail("MALFORMED_EVIDENCE", `unknown relevanceClass ${relevanceClass}`);
  if (!SIGNAL_STATUSES.has(signalStatus)) fail("MALFORMED_EVIDENCE", `unknown signalStatus ${signalStatus}`);
  const observedAt = asIso(row.observedAt);
  const ingestedAt = asIso(row.ingestedAt);
  if (!observedAt || !ingestedAt) fail("MALFORMED_EVIDENCE", `signal ${ref} has malformed timestamps`);
  const evidenceHash = String(row.evidenceHash ?? "");
  if (!/^[a-f0-9]{64}$/.test(evidenceHash)) fail("MALFORMED_EVIDENCE", `signal ${ref} has malformed evidenceHash`);
  const injection = row.injectionSuspected;
  const supersedes = row.supersedesSignalId;
  return {
    ref,
    evidenceClass: "EXTERNAL_SIGNAL",
    signalType,
    subjectType: String(row.subjectType ?? ""),
    subjectRef: String(row.subjectRef ?? ""),
    claimAspect: String(row.claimAspect ?? ""),
    sourceTrustClass: trust,
    confidenceClass,
    freshnessClass,
    freshnessPolicyVersion,
    corroborationStatus,
    corroboratingSignalIds: parseJsonArray(row.corroboratingSignalIds).map(String),
    contradictingSignalIds: parseJsonArray(row.contradictingSignalIds).map(String),
    relevanceClass,
    signalStatus,
    observedAt,
    ingestedAt,
    injectionSuspected: injection === true || injection === "true",
    supersedesSignalId: typeof supersedes === "string" && supersedes.length > 0 ? supersedes : null,
  };
}

// ─── Production port: raw SQL behind guarded information-schema checks ───

type SqlExecutor = { execute: ReturnType<typeof getDb>["execute"] };

const tableExistsCache = new Map<string, boolean>();

function normalizeSqlRows(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) {
    const first = result[0];
    if (Array.isArray(first)) return first as Array<Record<string, unknown>>;
    if (first && typeof first === "object") return [first as Record<string, unknown>];
    return [];
  }
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown[] }).rows)) {
    return (result as { rows: Array<Record<string, unknown>> }).rows;
  }
  return [];
}

async function upstreamTableExists(db: SqlExecutor, table: string): Promise<boolean> {
  const cached = tableExistsCache.get(table);
  if (cached !== undefined) return cached;
  let exists = false;
  try {
    const rows = normalizeSqlRows(
      await db.execute(sql`
        SELECT COUNT(*) AS c FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${table}
      `)
    );
    const first = rows[0];
    const count = first ? Number(first.c ?? 0) : 0;
    exists = Number.isInteger(count) && count > 0;
  } catch {
    exists = false;
  }
  tableExistsCache.set(table, exists);
  return exists;
}

/** Injected-clock production port. Never writes. Absent authority ⇒ null / fail-closed at caller. */
export function createStrategicEvidenceAuthority(now: () => Date = () => new Date()): StrategicEvidenceAuthority {
  void now; // reserved for future freshness recomputation parity with upstream
  return {
    async resolveMemory(userId, businessId, ref) {
      if (!MEMORY_REF_PATTERN.test(ref)) return null;
      const db = getDb();
      if (!(await upstreamTableExists(db, "strategic_memory_records"))) return null;
      const rows = normalizeSqlRows(
        await db.execute(sql`
          SELECT memoryId, memoryType, subjectType, subjectId, statementType, factStatus,
                 confidenceClass, sourceAuthority, sourceVersion, evidenceHash,
                 observedAt, recordedAt, validUntil, contradictsMemoryIds, contextScope
          FROM strategic_memory_records
          WHERE userId = ${userId} AND businessId = ${businessId} AND memoryId = ${ref}
          LIMIT 1
        `)
      );
      const row = rows[0];
      if (!row) return null;
      return shapeMemoryRow(row);
    },
    async resolveChange(userId, businessId, ref) {
      if (!CHANGE_REF_PATTERN.test(ref)) return null;
      const db = getDb();
      if (!(await upstreamTableExists(db, "business_change_events"))) return null;
      const rows = normalizeSqlRows(
        await db.execute(sql`
          SELECT changeId, changeDomain, changeType, subjectType, subjectId,
                 significanceClass, confidenceClass, status, sourceAuthority, sourceVersion,
                 detectedAt, effectiveAt, recordedAt, validUntil, supersedesChangeId, evidenceHash
          FROM business_change_events
          WHERE userId = ${userId} AND businessId = ${businessId} AND changeId = ${ref}
          LIMIT 1
        `)
      );
      const row = rows[0];
      if (!row) return null;
      return shapeChangeRow(row);
    },
    async resolveSignal(userId, businessId, ref) {
      if (!SIGNAL_REF_PATTERN.test(ref)) return null;
      const db = getDb();
      if (!(await upstreamTableExists(db, "external_signals"))) return null;
      const rows = normalizeSqlRows(
        await db.execute(sql`
          SELECT signalId, signalType, subjectType, subjectRef, claimAspect,
                 sourceTrustClass, confidenceClass, freshnessClass, freshnessPolicyVersion,
                 corroborationStatus, corroboratingSignalIds, contradictingSignalIds,
                 relevanceClass, signalStatus, observedAt, ingestedAt, evidenceHash,
                 injectionSuspected, supersedesSignalId
          FROM external_signals
          WHERE userId = ${userId} AND businessId = ${businessId} AND signalId = ${ref}
          LIMIT 1
        `)
      );
      const row = rows[0];
      if (!row) return null;
      return shapeSignalRow(row);
    },
  };
}

// ─── Test/injection port over RAW upstream rows (identical validation) ───

/**
 * Raw upstream-shaped row planted under a tenant/business scope (used to
 * prove isolation). The in-memory port runs the exact production shapers, so
 * tests exercise the real validation semantics (patterns, frozen contract
 * versions, vocabularies, timestamps, hashes).
 */
export interface FakeEvidenceRow {
  readonly userId: number;
  readonly businessId: number;
  readonly table: "strategic_memory_records" | "business_change_events" | "external_signals";
  readonly row: Record<string, unknown>;
}

export function createInMemoryEvidenceAuthority(rows: FakeEvidenceRow[]): StrategicEvidenceAuthority {
  const resolve = (
    userId: number,
    businessId: number,
    table: FakeEvidenceRow["table"],
    idField: "memoryId" | "changeId" | "signalId",
    ref: string,
    shape: (row: Record<string, unknown>) => StrategicEvidenceView
  ): StrategicEvidenceView | null => {
    const hit = rows.find(
      (r) => r.table === table && r.userId === userId && r.businessId === businessId && r.row[idField] === ref
    );
    if (!hit) return null;
    return shape(hit.row);
  };
  return {
    async resolveMemory(userId, businessId, ref) {
      if (!MEMORY_REF_PATTERN.test(ref)) return null;
      return resolve(userId, businessId, "strategic_memory_records", "memoryId", ref, (row) =>
        shapeMemoryRow(row)
      ) as MemoryEvidenceView | null;
    },
    async resolveChange(userId, businessId, ref) {
      if (!CHANGE_REF_PATTERN.test(ref)) return null;
      return resolve(userId, businessId, "business_change_events", "changeId", ref, (row) =>
        shapeChangeRow(row)
      ) as ChangeEvidenceView | null;
    },
    async resolveSignal(userId, businessId, ref) {
      if (!SIGNAL_REF_PATTERN.test(ref)) return null;
      return resolve(userId, businessId, "external_signals", "signalId", ref, (row) =>
        shapeSignalRow(row)
      ) as SignalEvidenceView | null;
    },
  };
}
