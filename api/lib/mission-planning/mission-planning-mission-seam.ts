// ─── R9-B Mission Planning — R9-A mission authority seam ───
//
// R9-A (mission-authority/v1 + mission-authority-to-planning/v1, frozen
// HEAD 273ce40) is the ONLY source of mission authority. This seam:
//
//   1. Mirrors the frozen 27-key planning projection contract — exact key
//      allowlist, frozen version, verbatim planning/execution disclaimers.
//      Every payload is re-validated at this boundary (untrusted until
//      accepted); unknown versions / non-verbatim disclaimers fail closed.
//   2. `MissionAuthorityReadPort` — the narrow read surface the service
//      calls. Absence of a bound port fails closed
//      (MISSION_AUTHORITY_UNAVAILABLE) — never guessed, never served.
//   3. `createRawSqlMissionAuthorityReadPort` — production binding over the
//      provisional `mission_proposals` durable rows (guarded
//      information-schema check; house seam pattern — the canonical table is
//      materialised at R9-X). This seam never writes any R9-A table and
//      never mints mission identities, objectives, constraints or statuses.
//   4. `createInMemoryMissionAuthorityReadPort` — test double over the
//      identical frozen semantics.
//
// Cross-tenant rows never resolve (userId predicate on every read);
// cross-business rows fail ownership re-verification against the durable
// `businesses` table every call.

import { sql } from "drizzle-orm";
import { getDb } from "../../queries/connection";
import {
  HEX_64_PATTERN,
  MISSION_ID_PATTERN,
  MISSION_PLANNING_BOUND_VERSIONS,
  MISSION_TYPES,
  STRATEGIC_RISK_CLASSES,
  fail,
} from "./mission-planning-contract";

// ─── Frozen R9-A projection constants (mission-authority-to-planning/v1) ───

export const MISSION_AUTHORITY_PROJECTION_VERSION =
  MISSION_PLANNING_BOUND_VERSIONS.missionAuthorityToPlanning;

export const MISSION_PLANNING_DISCLAIMER =
  "A mission proposal is bounded mission authority, not a plan. Task decomposition, " +
  "dependency analysis, scheduling and sequencing remain downstream planning authority " +
  "under separate governance.";

export const MISSION_EXECUTION_DISCLAIMER =
  "A mission proposal is never an execution authorization: no task, campaign, budget, " +
  "Business DNA, experiment, provider, payment or billing state may be mutated from this " +
  "projection. mission != task; recommendation != execution authorization.";

export const MISSION_PLANNING_PROJECTION_FIELD_KEYS = [
  "contractVersion",
  "missionId",
  "objectiveId",
  "businessId",
  "missionType",
  "objectiveType",
  "objectiveStatement",
  "expectedOutcome",
  "successCriteria",
  "constraints",
  "assumptions",
  "scope",
  "priorityContext",
  "strategicRisk",
  "validity",
  "status",
  "freshness",
  "r8Lineage",
  "governanceAuthorityScope",
  "governanceRequirements",
  "supersedesMissionId",
  "planningClaimed",
  "planningDisclaimer",
  "executionClaimed",
  "executionDisclaimer",
] as const;

export type MissionAuthorityProjectionKey = (typeof MISSION_PLANNING_PROJECTION_FIELD_KEYS)[number];

export const MISSION_AUTHORITY_ELIGIBLE_STATUS = "ELIGIBLE_FOR_PLANNING";

export interface MissionAuthorityProjection {
  readonly contractVersion: typeof MISSION_AUTHORITY_PROJECTION_VERSION;
  readonly missionId: string;
  readonly objectiveId: string;
  readonly businessId: number;
  readonly missionType: string;
  readonly objectiveType: string;
  readonly objectiveStatement: string;
  readonly expectedOutcome: string;
  readonly successCriteria: readonly unknown[];
  readonly constraints: readonly unknown[];
  readonly assumptions: readonly unknown[];
  readonly scope: {
    readonly subjectType: string;
    readonly businessScope: number;
    readonly channelScope: null;
    readonly campaignScope: null;
    readonly geography: null;
  };
  readonly priorityContext: string;
  readonly strategicRisk: string;
  readonly validity: { readonly validFrom: string; readonly validUntil: string };
  readonly status: string;
  readonly freshness: "current" | "stale";
  readonly r8Lineage: {
    readonly sourceCandidateId: string;
    readonly sourceReasoningIds: readonly string[];
    readonly governanceDecisionId: string | null;
    readonly governanceDecision: string | null;
    readonly policyVersion: string | null;
    readonly limitations: readonly string[];
  };
  readonly governanceAuthorityScope: "RECOMMENDATION_ONLY";
  readonly governanceRequirements: readonly string[];
  readonly supersedesMissionId: string | null;
  readonly planningClaimed: false;
  readonly planningDisclaimer: string;
  readonly executionClaimed: false;
  readonly executionDisclaimer: string;
}

/** Durable-row material needed for plan identity binding (not projection keys). */
export interface MissionAuthorityMaterial {
  readonly missionFingerprint: string;
  readonly boundMissionVersion: number;
  readonly scopeKey: string;
  readonly constraintSetFingerprint: string;
}

export interface MissionAuthorityRead {
  readonly projection: MissionAuthorityProjection;
  readonly material: MissionAuthorityMaterial;
}

export interface MissionAuthorityReadPort {
  /** Resolve one mission for planning; null when unknown to the tenant. */
  readonly getMissionForPlanning: (input: {
    userId: number;
    missionId: string;
    now?: Date;
  }) => Promise<MissionAuthorityRead | null>;
  /** Re-verify business ownership from the durable businesses row. */
  readonly verifyBusinessOwnership: (input: { userId: number; businessId: number }) => Promise<boolean>;
}

// ─── Rebuild + validate (mirror of R9-A builder; never extends the allowlist) ───

function asStringArray(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(String);
}

function asArray(raw: unknown): readonly unknown[] {
  return Array.isArray(raw) ? raw : [];
}

function parseJson(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value;
}

function parseScope(raw: unknown): MissionAuthorityProjection["scope"] {
  const s = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    subjectType: String(s.subjectType ?? ""),
    businessScope: Number(s.businessScope ?? 0),
    channelScope: null,
    campaignScope: null,
    geography: null,
  };
}

export interface RawMissionRow {
  readonly missionId: string;
  readonly objectiveId: string;
  readonly userId: number;
  readonly businessId: number;
  readonly missionType: string;
  readonly objectiveType: string;
  readonly objectiveStatement: string;
  readonly expectedOutcome: string;
  readonly successCriteria: unknown;
  readonly constraints: unknown;
  readonly assumptions: unknown;
  readonly scope: unknown;
  readonly scopeKey: string;
  readonly priorityContext: string;
  readonly strategicRiskClass: string;
  readonly governanceDecisionId: string | null;
  readonly governanceDecision: string | null;
  readonly policyVersion: string | null;
  readonly governanceRequirements: unknown;
  readonly validFrom: string;
  readonly validUntil: string;
  readonly limitations: unknown;
  readonly sourceCandidateId: string;
  readonly sourceReasoningIds: unknown;
  readonly supersedesMissionId: string | null;
  readonly status: string;
  readonly version: number;
  readonly missionFingerprint: string;
  readonly constraintSetFingerprint: string;
}

/** Build the frozen planning projection from a durable mission row (read-only). */
export function buildMissionAuthorityProjection(input: {
  row: RawMissionRow;
  nowMs: number;
}): MissionAuthorityProjection {
  const { row, nowMs } = input;
  const validUntil = typeof row.validUntil === "string" ? row.validUntil : "";
  const expired = validUntil.length > 0 && Date.parse(validUntil) < nowMs;
  return {
    contractVersion: MISSION_AUTHORITY_PROJECTION_VERSION,
    missionId: String(row.missionId),
    objectiveId: String(row.objectiveId),
    businessId: Number(row.businessId),
    missionType: String(row.missionType),
    objectiveType: String(row.objectiveType),
    objectiveStatement: String(row.objectiveStatement ?? ""),
    expectedOutcome: String(row.expectedOutcome ?? ""),
    successCriteria: asArray(parseJson(row.successCriteria)),
    constraints: asArray(parseJson(row.constraints)),
    assumptions: asArray(parseJson(row.assumptions)),
    scope: parseScope(parseJson(row.scope)),
    priorityContext: String(row.priorityContext),
    strategicRisk: String(row.strategicRiskClass),
    validity: {
      validFrom: String(row.validFrom ?? ""),
      validUntil,
    },
    status: String(row.status),
    freshness: expired ? "stale" : "current",
    r8Lineage: {
      sourceCandidateId: String(row.sourceCandidateId),
      sourceReasoningIds: asStringArray(parseJson(row.sourceReasoningIds)),
      governanceDecisionId: typeof row.governanceDecisionId === "string" ? row.governanceDecisionId : null,
      governanceDecision: typeof row.governanceDecision === "string" ? row.governanceDecision : null,
      policyVersion: typeof row.policyVersion === "string" ? row.policyVersion : null,
      limitations: asStringArray(parseJson(row.limitations)),
    },
    governanceAuthorityScope: "RECOMMENDATION_ONLY",
    governanceRequirements: asStringArray(parseJson(row.governanceRequirements)),
    supersedesMissionId: typeof row.supersedesMissionId === "string" ? row.supersedesMissionId : null,
    planningClaimed: false,
    planningDisclaimer: MISSION_PLANNING_DISCLAIMER,
    executionClaimed: false,
    executionDisclaimer: MISSION_EXECUTION_DISCLAIMER,
  };
}

/** Seam validator: exact key allowlist + frozen version + disclaimers verbatim. */
export function validateMissionAuthorityProjection(raw: unknown): MissionAuthorityProjection {
  if (typeof raw !== "object" || raw === null) {
    fail("MISSION_NOT_FOUND", "mission authority projection must be an object");
  }
  const keys = Object.keys(raw).sort();
  const expected = [...MISSION_PLANNING_PROJECTION_FIELD_KEYS].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expected)) {
    fail("MISSION_AUTHORITY_UNAVAILABLE", "mission authority projection key allowlist mismatch");
  }
  const p = raw as Record<string, unknown>;
  if (p.contractVersion !== MISSION_AUTHORITY_PROJECTION_VERSION) {
    fail("MISSION_AUTHORITY_UNAVAILABLE", "mission authority projection version mismatch");
  }
  if (p.planningClaimed !== false || p.executionClaimed !== false) {
    fail("MISSION_AUTHORITY_UNAVAILABLE", "mission authority projection must never claim planning or execution");
  }
  if (p.planningDisclaimer !== MISSION_PLANNING_DISCLAIMER || p.executionDisclaimer !== MISSION_EXECUTION_DISCLAIMER) {
    fail("MISSION_AUTHORITY_UNAVAILABLE", "mission authority projection disclaimers must be verbatim");
  }
  if (p.governanceAuthorityScope !== "RECOMMENDATION_ONLY") {
    fail("MISSION_AUTHORITY_UNAVAILABLE", "mission authority scope must be RECOMMENDATION_ONLY");
  }
  return raw as unknown as MissionAuthorityProjection;
}

/** Durable-material validator (plan identity binding inputs). */
export function validateMissionAuthorityMaterial(raw: RawMissionRow): MissionAuthorityMaterial {
  if (typeof raw.missionFingerprint !== "string" || !HEX_64_PATTERN.test(raw.missionFingerprint)) {
    fail("MISSION_AUTHORITY_UNAVAILABLE", "mission authority material fingerprint malformed");
  }
  if (typeof raw.scopeKey !== "string" || raw.scopeKey.length === 0 || raw.scopeKey.length > 512) {
    fail("MISSION_AUTHORITY_UNAVAILABLE", "mission authority scope key malformed");
  }
  if (
    typeof raw.constraintSetFingerprint !== "string" ||
    !HEX_64_PATTERN.test(raw.constraintSetFingerprint)
  ) {
    fail("MISSION_AUTHORITY_UNAVAILABLE", "mission authority constraint fingerprint malformed");
  }
  if (!Number.isInteger(raw.version) || raw.version < 0) {
    fail("MISSION_AUTHORITY_UNAVAILABLE", "mission authority version malformed");
  }
  if (!MISSION_ID_PATTERN.test(raw.missionId)) {
    fail("MISSION_NOT_FOUND", "mission identity malformed");
  }
  if (!(MISSION_TYPES as readonly string[]).includes(raw.missionType)) {
    fail("MISSION_NOT_ELIGIBLE", "mission type outside the closed vocabulary");
  }
  if (!(STRATEGIC_RISK_CLASSES as readonly string[]).includes(raw.strategicRiskClass)) {
    fail("MISSION_AUTHORITY_UNAVAILABLE", "mission strategic risk class malformed");
  }
  return {
    missionFingerprint: raw.missionFingerprint,
    boundMissionVersion: raw.version,
    scopeKey: raw.scopeKey,
    constraintSetFingerprint: raw.constraintSetFingerprint,
  };
}

/** Planning-eligibility gate (R9-A contract §3): consumable only when
 * ELIGIBLE, freshness-current and RECOMMENDATION_ONLY. Consumers must not
 * infer eligibility from any other field. */
export function isMissionPlanningConsumable(projection: MissionAuthorityProjection): boolean {
  return (
    projection.status === MISSION_AUTHORITY_ELIGIBLE_STATUS &&
    projection.freshness === "current" &&
    projection.governanceAuthorityScope === "RECOMMENDATION_ONLY"
  );
}

// ─── Raw SQL production port ───

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

async function missionTableAvailable(db: Db): Promise<boolean> {
  try {
    const result = (await db.execute(sql`
      SELECT COUNT(*) AS c FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mission_proposals'
    `)) as unknown;
    const rows = Array.isArray(result)
      ? (result as unknown[])
      : Array.isArray((result as { rows?: unknown[] }).rows)
        ? (result as { rows: unknown[] }).rows
        : [];
    const first = rows[0] as unknown;
    const count =
      first && typeof first === "object"
        ? Number((first as Record<string, unknown>).c ?? (first as unknown[])[0])
        : 0;
    return Number.isInteger(count) && count > 0;
  } catch {
    return false;
  }
}

function rowsFrom(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) {
    const first: unknown = result[0];
    if (Array.isArray(first)) return first as Array<Record<string, unknown>>;
    return result as Array<Record<string, unknown>>;
  }
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown[] }).rows)) {
    return (result as { rows: Array<Record<string, unknown>> }).rows;
  }
  return [];
}

export function createRawSqlMissionAuthorityReadPort(db: Db): MissionAuthorityReadPort {
  return {
    async getMissionForPlanning(input) {
      if (!(await missionTableAvailable(db))) return null;
      const result: unknown = await db.execute(sql`
        SELECT * FROM mission_proposals
        WHERE missionId = ${input.missionId} AND userId = ${input.userId}
        LIMIT 1
      `);
      const row = rowsFrom(result)[0] as unknown as RawMissionRow | undefined;
      if (!row) return null;
      if (row.userId !== input.userId) return null;
      const nowMs = input.now ? input.now.getTime() : Date.now();
      const projection = validateMissionAuthorityProjection(
        buildMissionAuthorityProjection({ row, nowMs })
      );
      const material = validateMissionAuthorityMaterial(row);
      return { projection, material };
    },
    async verifyBusinessOwnership(input) {
      const result: unknown = await db.execute(sql`
        SELECT id FROM businesses WHERE id = ${input.businessId} AND userId = ${input.userId} LIMIT 1
      `);
      return rowsFrom(result).length > 0;
    },
  };
}

// ─── In-memory port (identical frozen semantics; tests only) ───

export function createInMemoryMissionAuthorityReadPort(
  rows: ReadonlyArray<Record<string, unknown>>
): MissionAuthorityReadPort {
  // Live references (no row copies): callers may evolve mission rows between
  // calls (staleness/demotion scenarios) and the port must observe the
  // current durable state, exactly like the raw-SQL production port.
  const table: Array<Record<string, unknown>> = rows.slice();
  return {
    async getMissionForPlanning(input) {
      const found = table.find(
        (r) => r.missionId === input.missionId && r.userId === input.userId
      );
      if (!found) return null;
      const row = found as unknown as RawMissionRow;
      const nowMs = input.now ? input.now.getTime() : Date.now();
      const projection = validateMissionAuthorityProjection(
        buildMissionAuthorityProjection({ row, nowMs })
      );
      const material = validateMissionAuthorityMaterial(row);
      return { projection, material };
    },
    async verifyBusinessOwnership(input) {
      const owned = (rows as ReadonlyArray<Record<string, unknown>>).some(
        (r) =>
          (r.__kind === "business" || r.kind === "business") &&
          r.id === input.businessId &&
          r.userId === input.userId
      );
      return owned;
    },
  };
}
