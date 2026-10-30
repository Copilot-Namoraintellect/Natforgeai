// ─── R8-E Strategic Opportunity & Risk — R8-D reasoning seam (E2) ───
//
// R8-D (strategic-reasoning-to-opportunity-risk/v1, frozen 00f9adf) is the
// ONLY source of strategic conclusions. This seam:
//
//   1. Mirrors the frozen 34-key projection contract — exact key allowlist,
//      frozen version, verbatim causation/attribution/execution disclaimers.
//      Every payload is re-validated at this boundary (untrusted until
//      accepted); unknown versions fail closed.
//   2. `StrategicReasoningReadPort` — the narrow read surface the service
//      calls. A registration port binds the authority; absence fails closed
//      (REASONING_AUTHORITY_UNAVAILABLE) — never guessed, never served.
//   3. `createRawSqlStrategicReasoningReadPort` — production binding over the
//      provisional `strategic_reasoning_records` durable rows (guarded
//      information-schema check; house seam pattern — the canonical table is
//      materialised at R8-X). Consumers may rebuild projections from durable
//      rows but must never extend the key allowlist (R8-D contract §3).
//   4. `createInMemoryStrategicReasoningReadPort` — test double over the
//      same frozen semantics.
//
// This seam never writes any R8-D table and never mints reasoning
// identities, hypotheses, implications, confidence, statuses or governance
// bindings. Cross-business / cross-tenant rows never resolve.

import { sql } from "drizzle-orm";
import { getDb } from "../../queries/connection";
import {
  fail,
  GOVERNANCE_DECISION_ID_PATTERN,
  HEX_64_PATTERN,
  REASONING_ID_PATTERN,
  STRATEGIC_OPPORTUNITY_RISK_BOUND_VERSIONS,
  canonicalJson,
  sha256Hex,
} from "./strategic-opportunity-risk-contract";

// ─── Frozen R8-D projection constants (strategic-reasoning-to-opportunity-risk/v1) ───

export const STRATEGIC_REASONING_PROJECTION_VERSION =
  STRATEGIC_OPPORTUNITY_RISK_BOUND_VERSIONS.strategicReasoning;

export const STRATEGIC_REASONING_CAUSATION_DISCLAIMER =
  "A strategic conclusion is evidence-preserving synthesis, not causal proof. " +
  "This projection does not assert that any marketing activity, attribution credit, " +
  "optimisation, market event or source claim caused any business outcome.";

export const STRATEGIC_REASONING_ATTRIBUTION_DISCLAIMER =
  "Attribution-derived evidence is association evidence, not causal proof. " +
  "Credit allocation and channel weights remain R7-B derivations on their own authority.";

export const STRATEGIC_REASONING_EXECUTION_DISCLAIMER =
  "A strategic conclusion recommends attention only. It is never an instruction to " +
  "execute: no campaign, strategy, budget, Business DNA, provider, payment, billing " +
  "or mission state may be mutated from this projection.";

export const STRATEGIC_REASONING_PROJECTION_FIELD_KEYS = [
  "contractVersion",
  "reasoningId",
  "businessId",
  "evidenceBundleId",
  "hypothesisId",
  "hypothesisType",
  "implicationType",
  "supportingEvidence",
  "contradictingEvidence",
  "missingEvidence",
  "confidenceClass",
  "uncertaintyClasses",
  "strategicRiskClass",
  "status",
  "governanceDecisionId",
  "governanceDecision",
  "approvalStatus",
  "policyVersion",
  "freshness",
  "limitations",
  "sourceVersions",
  "validUntil",
  "supersedesReasoningId",
  "createdAt",
  "causationClaimed",
  "causationDisclaimer",
  "attributionClaimed",
  "attributionDisclaimer",
  "executionClaimed",
  "executionDisclaimer",
] as const;

export type StrategicReasoningProjectionKey =
  (typeof STRATEGIC_REASONING_PROJECTION_FIELD_KEYS)[number];

export const STRATEGIC_REASONING_ACTIVE_STATUSES = [
  "SUPPORTED",
  "APPROVED_RECOMMENDATION",
  "REVIEW_REQUIRED",
] as const;

export interface StrategicReasoningEvidenceItem {
  readonly ref: string;
  readonly evidenceClass: "INTERNAL_MEMORY" | "INTERNAL_CHANGE" | "EXTERNAL_SIGNAL";
  readonly role?: "ANCHOR" | "SUPPORT" | "CONTEXT";
}

export interface StrategicReasoningContradictionItem {
  readonly ref: string;
  readonly evidenceClass: "INTERNAL_MEMORY" | "INTERNAL_CHANGE" | "EXTERNAL_SIGNAL";
}

/** Frozen read-only R8-D conclusion projection (34-key exact allowlist). */
export interface StrategicReasoningProjection {
  readonly contractVersion: typeof STRATEGIC_REASONING_PROJECTION_VERSION;
  readonly reasoningId: string;
  readonly businessId: number;
  readonly evidenceBundleId: string;
  readonly hypothesisId: string;
  readonly hypothesisType: string;
  readonly implicationType: string;
  readonly supportingEvidence: readonly StrategicReasoningEvidenceItem[];
  readonly contradictingEvidence: readonly StrategicReasoningContradictionItem[];
  readonly missingEvidence: readonly string[];
  readonly confidenceClass: string;
  readonly uncertaintyClasses: readonly string[];
  readonly strategicRiskClass: string | null;
  readonly status: string;
  readonly governanceDecisionId: string | null;
  readonly governanceDecision: string | null;
  readonly approvalStatus: "none" | "pending" | "approved" | "rejected";
  readonly policyVersion: string | null;
  readonly freshness: "current" | "stale";
  readonly limitations: readonly string[];
  readonly sourceVersions: Record<string, unknown>;
  readonly validUntil: string | null;
  readonly supersedesReasoningId: string | null;
  readonly createdAt: string;
  readonly causationClaimed: false;
  readonly causationDisclaimer: string;
  readonly attributionClaimed: false;
  readonly attributionDisclaimer: string;
  readonly executionClaimed: false;
  readonly executionDisclaimer: string;
}

// ─── Frozen upstream identity patterns (R8-D contract §6) ───

const MEMORY_REF_PATTERN = /^mem1:[a-f0-9]{64}$/;
const CHANGE_REF_PATTERN = /^chg1:[a-f0-9]{64}$/;
const SIGNAL_REF_PATTERN = /^xsig1:[a-f0-9]{64}$/;

// ─── Boundary validation (fail closed) ───

function isIsoUtc(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(value)) return false;
  return !Number.isNaN(Date.parse(value));
}

function validateEvidenceItem(raw: unknown): StrategicReasoningEvidenceItem {
  if (typeof raw !== "object" || raw === null) {
    fail("REASONING_PROJECTION_MALFORMED", "supporting evidence item must be an object");
  }
  const r = raw as Record<string, unknown>;
  const evidenceClass = r.evidenceClass;
  if (
    evidenceClass !== "INTERNAL_MEMORY" &&
    evidenceClass !== "INTERNAL_CHANGE" &&
    evidenceClass !== "EXTERNAL_SIGNAL"
  ) {
    fail("REASONING_PROJECTION_MALFORMED", "supporting evidence class outside frozen vocabulary");
  }
  const ref = r.ref;
  const refOk =
    (evidenceClass === "INTERNAL_MEMORY" && typeof ref === "string" && MEMORY_REF_PATTERN.test(ref)) ||
    (evidenceClass === "INTERNAL_CHANGE" && typeof ref === "string" && CHANGE_REF_PATTERN.test(ref)) ||
    (evidenceClass === "EXTERNAL_SIGNAL" && typeof ref === "string" && SIGNAL_REF_PATTERN.test(ref));
  if (!refOk) {
    fail("REASONING_PROJECTION_MALFORMED", "supporting evidence ref does not match its class pattern");
  }
  const role = r.role;
  return {
    ref: ref as string,
    evidenceClass,
    role:
      role === "ANCHOR" || role === "SUPPORT" || role === "CONTEXT"
        ? role
        : undefined,
  };
}

function validateContradictionItem(raw: unknown): StrategicReasoningContradictionItem {
  if (typeof raw !== "object" || raw === null) {
    fail("REASONING_PROJECTION_MALFORMED", "contradicting evidence item must be an object");
  }
  const r = raw as Record<string, unknown>;
  const evidenceClass = r.evidenceClass;
  if (
    evidenceClass !== "INTERNAL_MEMORY" &&
    evidenceClass !== "INTERNAL_CHANGE" &&
    evidenceClass !== "EXTERNAL_SIGNAL"
  ) {
    fail("REASONING_PROJECTION_MALFORMED", "contradicting evidence class outside frozen vocabulary");
  }
  const ref = r.ref;
  const refOk =
    (evidenceClass === "INTERNAL_MEMORY" && typeof ref === "string" && MEMORY_REF_PATTERN.test(ref)) ||
    (evidenceClass === "INTERNAL_CHANGE" && typeof ref === "string" && CHANGE_REF_PATTERN.test(ref)) ||
    (evidenceClass === "EXTERNAL_SIGNAL" && typeof ref === "string" && SIGNAL_REF_PATTERN.test(ref));
  if (!refOk) {
    fail("REASONING_PROJECTION_MALFORMED", "contradicting evidence ref does not match its class pattern");
  }
  return { ref: ref as string, evidenceClass };
}

/** Seam validator: exact key allowlist + frozen version + disclaimers verbatim. */
export function validateStrategicReasoningProjection(raw: unknown): StrategicReasoningProjection {
  if (typeof raw !== "object" || raw === null) {
    fail("REASONING_PROJECTION_MALFORMED", "strategic reasoning projection must be an object");
  }
  const keys = Object.keys(raw).sort();
  const expected = [...STRATEGIC_REASONING_PROJECTION_FIELD_KEYS].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expected)) {
    fail("REASONING_PROJECTION_MALFORMED", "strategic reasoning projection key allowlist mismatch");
  }
  const p = raw as Record<string, unknown>;
  if (p.contractVersion !== STRATEGIC_REASONING_PROJECTION_VERSION) {
    fail(
      "REASONING_CONTRACT_VERSION_UNSUPPORTED",
      `strategic reasoning projection version ${String(p.contractVersion)} is not supported`
    );
  }
  if (typeof p.reasoningId !== "string" || !REASONING_ID_PATTERN.test(p.reasoningId)) {
    fail("REASONING_PROJECTION_MALFORMED", "reasoningId must match rsn1:<sha256>");
  }
  if (typeof p.businessId !== "number" || !Number.isInteger(p.businessId) || p.businessId <= 0) {
    fail("REASONING_PROJECTION_MALFORMED", "businessId must be a positive integer");
  }
  if (typeof p.evidenceBundleId !== "string" || !/^evb1:[a-f0-9]{64}$/.test(p.evidenceBundleId)) {
    fail("REASONING_PROJECTION_MALFORMED", "evidenceBundleId must match evb1:<sha256>");
  }
  if (!Array.isArray(p.supportingEvidence)) {
    fail("REASONING_PROJECTION_MALFORMED", "supportingEvidence must be an array");
  }
  if (!Array.isArray(p.contradictingEvidence)) {
    fail("REASONING_PROJECTION_MALFORMED", "contradictingEvidence must be an array");
  }
  if (p.causationClaimed !== false || p.attributionClaimed !== false || p.executionClaimed !== false) {
    fail(
      "REASONING_PROJECTION_MALFORMED",
      "strategic reasoning projection must never claim causation/attribution/execution"
    );
  }
  if (
    p.causationDisclaimer !== STRATEGIC_REASONING_CAUSATION_DISCLAIMER ||
    p.attributionDisclaimer !== STRATEGIC_REASONING_ATTRIBUTION_DISCLAIMER ||
    p.executionDisclaimer !== STRATEGIC_REASONING_EXECUTION_DISCLAIMER
  ) {
    fail("REASONING_PROJECTION_MALFORMED", "strategic reasoning projection disclaimers must be verbatim");
  }
  const supporting = (p.supportingEvidence as unknown[]).map(validateEvidenceItem);
  const contradicting = (p.contradictingEvidence as unknown[]).map(validateContradictionItem);
  const missing = Array.isArray(p.missingEvidence)
    ? (p.missingEvidence as unknown[]).map(String)
    : [];
  const uncertainty = Array.isArray(p.uncertaintyClasses)
    ? (p.uncertaintyClasses as unknown[]).map(String)
    : [];
  const limitations = Array.isArray(p.limitations) ? (p.limitations as unknown[]).map(String) : [];
  const sourceVersions =
    typeof p.sourceVersions === "object" && p.sourceVersions !== null
      ? (p.sourceVersions as Record<string, unknown>)
      : {};
  const approvalStatus = p.approvalStatus;
  if (
    approvalStatus !== "none" &&
    approvalStatus !== "pending" &&
    approvalStatus !== "approved" &&
    approvalStatus !== "rejected"
  ) {
    fail("REASONING_PROJECTION_MALFORMED", "approvalStatus outside frozen vocabulary");
  }
  const freshness = p.freshness;
  if (freshness !== "current" && freshness !== "stale") {
    fail("REASONING_PROJECTION_MALFORMED", "freshness outside frozen vocabulary");
  }
  return {
    ...(raw as unknown as StrategicReasoningProjection),
    supportingEvidence: supporting,
    contradictingEvidence: contradicting,
    missingEvidence: missing,
    uncertaintyClasses: uncertainty,
    limitations,
    sourceVersions,
    approvalStatus,
    freshness,
  };
}

export function isActiveReasoningStatus(status: string): boolean {
  return (STRATEGIC_REASONING_ACTIVE_STATUSES as readonly string[]).includes(status);
}

// ─── Narrow read port + registry (absence fails closed) ───

export interface StrategicReasoningReadPort {
  /** Fetch + validate one conclusion projection (tenant + business scoped). */
  getReasoning(input: {
    userId: number;
    businessId: number;
    reasoningId: string;
  }): Promise<StrategicReasoningProjection | null>;
  /** Current-state handoff projections for a business (active only unless flagged). */
  listReasoningProjections(input: {
    userId: number;
    businessId: number;
    includeNonActive: boolean;
  }): Promise<StrategicReasoningProjection[]>;
}

let registeredPort: StrategicReasoningReadPort | null = null;

/** R8-X integration registers the canonical R8-D read surface exactly once. */
export function registerStrategicReasoningReadPort(port: StrategicReasoningReadPort): void {
  registeredPort = port;
}

export function clearStrategicReasoningReadPort(): void {
  registeredPort = null;
}

export function getStrategicReasoningReadPort(): StrategicReasoningReadPort {
  if (!registeredPort) {
    fail(
      "UNKNOWN_REASONING_REFERENCE",
      "the R8-D strategic-reasoning authority is not bound on this branch; no strategic candidate may be derived without governed reasoning"
    );
  }
  return registeredPort;
}

// ─── Frozen approval-status derivation (F5 binding hash, mirrors R8-D) ───

export const STRATEGIC_RECOMMENDATION_APPROVAL_TYPE = "strategic_recommendation" as const;

export interface StrategicApprovalBindingRecord {
  readonly governanceDecisionId: string;
  readonly policyVersion: string;
  readonly proposalFingerprint: string;
  readonly evidenceFingerprint: string;
  readonly approvalBindingHash: string;
}

export function deriveApprovalBindingHash(input: {
  governanceDecisionId: string;
  policyVersion: string;
  proposalFingerprint: string;
  evidenceFingerprint: string;
}): string {
  return sha256Hex(
    canonicalJson({
      v: 1,
      governanceDecisionId: input.governanceDecisionId,
      policyVersion: input.policyVersion,
      proposalFingerprint: input.proposalFingerprint,
      evidenceFingerprint: input.evidenceFingerprint,
    })
  );
}

export function parseStrategicApprovalBinding(context: unknown): StrategicApprovalBindingRecord | null {
  if (typeof context !== "object" || context === null) return null;
  const raw = (context as Record<string, unknown>).strategicGovernanceBinding;
  if (typeof raw !== "object" || raw === null) return null;
  const b = raw as Record<string, unknown>;
  if (
    typeof b.governanceDecisionId !== "string" ||
    typeof b.policyVersion !== "string" ||
    typeof b.proposalFingerprint !== "string" ||
    typeof b.evidenceFingerprint !== "string" ||
    typeof b.approvalBindingHash !== "string"
  ) {
    return null;
  }
  return {
    governanceDecisionId: b.governanceDecisionId,
    policyVersion: b.policyVersion,
    proposalFingerprint: b.proposalFingerprint,
    evidenceFingerprint: b.evidenceFingerprint,
    approvalBindingHash: b.approvalBindingHash,
  };
}

interface StoredDecisionFingerprints {
  readonly governanceDecisionId: string;
  readonly policyVersion: string;
  readonly proposalFingerprint: string;
  readonly evidenceFingerprint: string;
}

/** Derive the approval status for a stored decision; forged bindings fail closed. */
export function deriveApprovalStatus(input: {
  decision: StoredDecisionFingerprints;
  bindings: readonly (StrategicApprovalBindingRecord | null)[];
  approvalStatuses: readonly string[];
}): "none" | "pending" | "approved" | "rejected" {
  const { decision, bindings, approvalStatuses } = input;
  for (let i = 0; i < bindings.length; i++) {
    const binding = bindings[i];
    if (!binding) continue;
    if (binding.governanceDecisionId !== decision.governanceDecisionId) continue;
    const expected = deriveApprovalBindingHash({
      governanceDecisionId: decision.governanceDecisionId,
      policyVersion: decision.policyVersion,
      proposalFingerprint: decision.proposalFingerprint,
      evidenceFingerprint: decision.evidenceFingerprint,
    });
    if (binding.approvalBindingHash !== expected) {
      fail(
        "APPROVAL_BINDING_MISMATCH",
        `approval binding hash does not match the stored governance decision — forged or tampered approval material`
      );
    }
    if (
      binding.policyVersion !== decision.policyVersion ||
      binding.proposalFingerprint !== decision.proposalFingerprint ||
      binding.evidenceFingerprint !== decision.evidenceFingerprint
    ) {
      fail("APPROVAL_BINDING_MISMATCH", "approval binds different decision material");
    }
  }
  if (approvalStatuses.some((s) => s === "rejected")) return "rejected";
  if (approvalStatuses.some((s) => s === "approved")) return "approved";
  if (bindings.some((b) => b !== null)) return "pending";
  return "none";
}

// ─── Production raw-SQL binding over provisional R8-D durable rows ───

type Db = ReturnType<typeof getDb>;

interface RawReasoningRow {
  reasoningId: string;
  userId: number;
  businessId: number;
  bundleId: string;
  hypothesisId: string;
  hypothesisType: string;
  implicationType: string;
  supportingEvidence: unknown;
  contradictingEvidence: unknown;
  missingEvidence: unknown;
  confidenceClass: string;
  uncertaintyClasses: unknown;
  strategicRiskClass: string | null;
  status: string;
  governanceDecisionId: string | null;
  governanceDecision: string | null;
  governanceDecisionRecord: unknown;
  policyVersion: string | null;
  evidenceFingerprint: string;
  reasoningFingerprint: string;
  limitations: unknown;
  validUntil: string | null;
  supersedesReasoningId: string | null;
  sourceVersions: unknown;
  createdAt?: unknown;
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

async function reasoningTableAvailable(db: Db): Promise<boolean> {
  try {
    const result = (await db.execute(sql`
      SELECT COUNT(*) AS c FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'strategic_reasoning_records'
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

async function fetchApprovalRows(
  db: Db,
  userId: number,
  governanceDecisionId: string
): Promise<{ bindings: (StrategicApprovalBindingRecord | null)[]; statuses: string[] }> {
  const result: unknown = await db.execute(sql`
    SELECT status, context FROM approval_requests
    WHERE userId = ${userId} AND approvalType = ${STRATEGIC_RECOMMENDATION_APPROVAL_TYPE}
    ORDER BY id ASC
  `);
  let rawRows: Array<Record<string, unknown>> = [];
  if (Array.isArray(result)) {
    const first: unknown = result[0];
    rawRows = Array.isArray(first)
      ? (first as Array<Record<string, unknown>>)
      : first && typeof first === "object"
        ? [first as Record<string, unknown>]
        : [];
  } else if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown[] }).rows)) {
    rawRows = (result as { rows: Array<Record<string, unknown>> }).rows;
  }
  const bindings: (StrategicApprovalBindingRecord | null)[] = [];
  const statuses: string[] = [];
  for (const row of rawRows) {
    const binding = parseStrategicApprovalBinding(parseJson(row.context));
    if (binding && binding.governanceDecisionId !== governanceDecisionId) continue;
    bindings.push(binding);
    statuses.push(String(row.status ?? ""));
  }
  return { bindings, statuses };
}

function toDecisionFingerprints(record: RawReasoningRow): StoredDecisionFingerprints | null {
  if (!record.governanceDecisionId || !GOVERNANCE_DECISION_ID_PATTERN.test(record.governanceDecisionId)) {
    return null;
  }
  const raw = parseJson(record.governanceDecisionRecord);
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.policyVersion !== "string" ||
    typeof r.proposalFingerprint !== "string" ||
    !HEX_64_PATTERN.test(r.proposalFingerprint) ||
    typeof r.evidenceFingerprint !== "string" ||
    !HEX_64_PATTERN.test(r.evidenceFingerprint)
  ) {
    return null;
  }
  return {
    governanceDecisionId: record.governanceDecisionId,
    policyVersion: r.policyVersion,
    proposalFingerprint: r.proposalFingerprint,
    evidenceFingerprint: r.evidenceFingerprint,
  };
}

/** Rebuild the frozen projection from a durable row (never extends the allowlist). */
async function buildProjectionFromRow(
  db: Db,
  row: RawReasoningRow,
  nowMs: number
): Promise<StrategicReasoningProjection> {
  let approvalStatus: "none" | "pending" | "approved" | "rejected" = "none";
  const fingerprints = toDecisionFingerprints(row);
  if (fingerprints) {
    const approvalRows = await fetchApprovalRows(db, row.userId, fingerprints.governanceDecisionId);
    approvalStatus = deriveApprovalStatus({
      decision: fingerprints,
      bindings: approvalRows.bindings,
      approvalStatuses: approvalRows.statuses,
    });
  }
  // Derived display state: REVIEW_REQUIRED + valid approval reads APPROVED_RECOMMENDATION.
  const status =
    row.status === "REVIEW_REQUIRED" && approvalStatus === "approved"
      ? "APPROVED_RECOMMENDATION"
      : row.status;
  const expired =
    row.validUntil !== null && row.validUntil !== undefined && isIsoUtc(row.validUntil)
      ? Date.parse(row.validUntil as string) < nowMs
      : false;
  const createdAt =
    row.createdAt instanceof Date
      ? row.createdAt.toISOString()
      : typeof row.createdAt === "string"
        ? row.createdAt
        : "";
  const projection = {
    contractVersion: STRATEGIC_REASONING_PROJECTION_VERSION,
    reasoningId: row.reasoningId,
    businessId: row.businessId,
    evidenceBundleId: row.bundleId,
    hypothesisId: row.hypothesisId,
    hypothesisType: row.hypothesisType,
    implicationType: row.implicationType,
    supportingEvidence: parseJson(row.supportingEvidence) ?? [],
    contradictingEvidence: parseJson(row.contradictingEvidence) ?? [],
    missingEvidence: parseJson(row.missingEvidence) ?? [],
    confidenceClass: row.confidenceClass,
    uncertaintyClasses: parseJson(row.uncertaintyClasses) ?? [],
    strategicRiskClass: row.strategicRiskClass,
    status,
    governanceDecisionId: row.governanceDecisionId,
    governanceDecision: row.governanceDecision,
    approvalStatus,
    policyVersion: row.policyVersion,
    freshness: expired ? "stale" : "current",
    limitations: parseJson(row.limitations) ?? [],
    sourceVersions: parseJson(row.sourceVersions) ?? {},
    validUntil: row.validUntil,
    supersedesReasoningId: row.supersedesReasoningId,
    createdAt,
    causationClaimed: false,
    causationDisclaimer: STRATEGIC_REASONING_CAUSATION_DISCLAIMER,
    attributionClaimed: false,
    attributionDisclaimer: STRATEGIC_REASONING_ATTRIBUTION_DISCLAIMER,
    executionClaimed: false,
    executionDisclaimer: STRATEGIC_REASONING_EXECUTION_DISCLAIMER,
  };
  return validateStrategicReasoningProjection(projection);
}

export function createRawSqlStrategicReasoningReadPort(db: Db): StrategicReasoningReadPort {
  return {
    async getReasoning(input) {
      if (!(await reasoningTableAvailable(db))) return null;
      const result: unknown = await db.execute(sql`
        SELECT * FROM strategic_reasoning_records
        WHERE reasoningId = ${input.reasoningId} AND userId = ${input.userId}
        LIMIT 1
      `);
      const rows = Array.isArray(result)
        ? (result as Array<Record<string, unknown>>)
        : Array.isArray((result as { rows?: unknown[] })?.rows)
          ? ((result as { rows: Array<Record<string, unknown>> }).rows)
          : [];
      const row = rows[0] as unknown as RawReasoningRow | undefined;
      if (!row) return null;
      if (row.businessId !== input.businessId || row.userId !== input.userId) return null;
      return buildProjectionFromRow(db, row, Date.now());
    },
    async listReasoningProjections(input) {
      if (!(await reasoningTableAvailable(db))) return [];
      const result: unknown = await db.execute(sql`
        SELECT * FROM strategic_reasoning_records
        WHERE userId = ${input.userId} AND businessId = ${input.businessId}
        ORDER BY createdAt ASC
      `);
      const rows = Array.isArray(result)
        ? (result as Array<Record<string, unknown>>)
        : Array.isArray((result as { rows?: unknown[] })?.rows)
          ? ((result as { rows: Array<Record<string, unknown>> }).rows)
          : [];
      const out: StrategicReasoningProjection[] = [];
      for (const raw of rows) {
        const projection = await buildProjectionFromRow(db, raw as unknown as RawReasoningRow, Date.now());
        if (!input.includeNonActive && !isActiveReasoningStatus(projection.status)) continue;
        out.push(projection);
      }
      return out;
    },
  };
}

// ─── In-memory test double (same frozen semantics) ───

export function createInMemoryStrategicReasoningReadPort(
  rows: readonly Record<string, unknown>[]
): StrategicReasoningReadPort {
  // Live view: rows may be planted after construction (tests plant raw
  // conclusions and resolve them through the same frozen validators).
  const materialized = () => rows.map((r) => validateStrategicReasoningProjection(r));
  return {
    async getReasoning(input) {
      const found = materialized().find(
        (p) => p.reasoningId === input.reasoningId && p.businessId === input.businessId
      );
      return found ?? null;
    },
    async listReasoningProjections(input) {
      return materialized().filter((p) => {
        if (p.businessId !== input.businessId) return false;
        if (!input.includeNonActive && !isActiveReasoningStatus(p.status)) return false;
        return true;
      });
    },
  };
}
