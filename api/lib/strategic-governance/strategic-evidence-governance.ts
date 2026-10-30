// ─── R8-F Strategic Intelligence Governance — evidence & source-trust governance (F3) ───
//
// SERVER-DERIVED evidence trust. A strategic proposal cites evidence by opaque
// reference only; the authority provider resolves each reference against
// canonical, tenant-scoped records and THIS module derives the trust class
// from those records under policy. Neither the proposing client nor any
// runtime agent can supply, promote, or influence a trust class (charter F3 /
// F6; AC14 "a source cannot mark itself trusted", AC30 "an agent cannot raise
// evidence trust").
//
// Derivation rules (deterministic, rule-first — no model in the trust path):
// - sourceKind MODEL_GENERATED  -> never source truth: UNVERIFIED + reason
//   MODEL_GENERATED_NOT_SOURCE_TRUTH (a language model may synthesize evidence
//   but cannot create source truth — charter principle 4).
// - contradictionFlag           -> CONTRADICTED (contradictions stay visible;
//   they are never silently dropped — AC32).
// - INTERNAL_AUTHORITATIVE      -> AUTHORITATIVE_INTERNAL.
// - EXTERNAL_SOURCE on the server's registered-source allow-list -> VERIFIED_EXTERNAL.
// - EXTERNAL_SOURCE with >= 2 independent corroborating sources   -> CORROBORATED_EXTERNAL.
// - EXTERNAL_SOURCE with exactly 1 source                          -> SINGLE_EXTERNAL_SOURCE.
// - EXTERNAL_SOURCE with no provenance                             -> UNVERIFIED.
// - provider resolution missing/garbage for the tenant             -> MALFORMED /
//   treated as absent (cross-tenant evidence fails closed upstream).
//
// Pure module: no I/O, no clock, no state. Callers pass the clock reading in.

import {
  STRATEGIC_CONFIDENCE_RANK,
  STRATEGIC_EVIDENCE_TRUST_RANK,
  StrategicGovernanceValidationError,
  type StrategicConfidenceClass,
  type StrategicEvidenceTrustClass,
} from "./strategic-governance-contract";

/** Closed evidence source kinds carried by canonical evidence records. */
export const EVIDENCE_SOURCE_KINDS = [
  "INTERNAL_AUTHORITATIVE",
  "EXTERNAL_SOURCE",
  "MODEL_GENERATED",
] as const;
export type EvidenceSourceKind = (typeof EVIDENCE_SOURCE_KINDS)[number];

const EVIDENCE_SOURCE_KIND_SET: ReadonlySet<string> = new Set(EVIDENCE_SOURCE_KINDS);

export function isEvidenceSourceKind(value: unknown): value is EvidenceSourceKind {
  return typeof value === "string" && EVIDENCE_SOURCE_KIND_SET.has(value);
}

/**
 * The canonical, tenant-scoped evidence record as resolved by the authority
 * provider. Every field is server-side authority: the client never sees this
 * shape and can never supply it.
 */
export interface ResolvedEvidenceRecord {
  readonly evidenceRef: string;
  readonly ownerUserId: number;
  /** Null-or-equal business scope (same rule as R7-B journey reconstruction). */
  readonly businessId: number | null;
  readonly sourceKind: EvidenceSourceKind;
  /**
   * Set when the external source appears on the tenant's SERVER-SIDE
   * registered/trusted-source registry. The registry — never the source, never
   * the client — decides what is "registered".
   */
  readonly registeredSourceKey: string | null;
  /** Count of independent corroborating external sources (0 when unknown). */
  readonly corroborationCount: number;
  /** True when independent sources actively contradict each other. */
  readonly contradictionFlag: boolean;
  /** When the evidence was captured/observed (ISO 8601 UTC). */
  readonly observedAt: string;
}

/** Per-evidence derivation outcome. */
export interface DerivedEvidence {
  readonly evidenceRef: string;
  readonly trustClass: StrategicEvidenceTrustClass;
  /** Closed reason annotations carried into the decision (visible, bounded). */
  readonly notes: readonly string[];
  readonly stale: boolean;
}

function validateResolvedRecord(raw: unknown, evidenceRef: string): ResolvedEvidenceRecord {
  if (typeof raw !== "object" || raw === null) {
    throw new StrategicGovernanceValidationError(
      "EVIDENCE_AUTHORITY_UNAVAILABLE",
      `evidence authority returned a malformed record for ${evidenceRef}`
    );
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.ownerUserId !== "number" || !Number.isInteger(r.ownerUserId) || r.ownerUserId <= 0) {
    throw new StrategicGovernanceValidationError(
      "EVIDENCE_AUTHORITY_UNAVAILABLE",
      `evidence record ${evidenceRef} is missing a valid owner`
    );
  }
  if (!isEvidenceSourceKind(r.sourceKind)) {
    throw new StrategicGovernanceValidationError(
      "EVIDENCE_AUTHORITY_UNAVAILABLE",
      `evidence record ${evidenceRef} carries an unknown source kind`
    );
  }
  if (r.businessId !== null && r.businessId !== undefined) {
    if (typeof r.businessId !== "number" || !Number.isInteger(r.businessId) || r.businessId <= 0) {
      throw new StrategicGovernanceValidationError(
        "EVIDENCE_AUTHORITY_UNAVAILABLE",
        `evidence record ${evidenceRef} carries an invalid business scope`
      );
    }
  }
  if (
    r.registeredSourceKey !== null &&
    r.registeredSourceKey !== undefined &&
    typeof r.registeredSourceKey !== "string"
  ) {
    throw new StrategicGovernanceValidationError(
      "EVIDENCE_AUTHORITY_UNAVAILABLE",
      `evidence record ${evidenceRef} carries an invalid registered source key`
    );
  }
  if (
    typeof r.corroborationCount !== "number" ||
    !Number.isInteger(r.corroborationCount) ||
    r.corroborationCount < 0
  ) {
    throw new StrategicGovernanceValidationError(
      "EVIDENCE_AUTHORITY_UNAVAILABLE",
      `evidence record ${evidenceRef} carries an invalid corroboration count`
    );
  }
  if (typeof r.contradictionFlag !== "boolean") {
    throw new StrategicGovernanceValidationError(
      "EVIDENCE_AUTHORITY_UNAVAILABLE",
      `evidence record ${evidenceRef} carries an invalid contradiction flag`
    );
  }
  if (typeof r.observedAt !== "string" || Number.isNaN(Date.parse(r.observedAt))) {
    throw new StrategicGovernanceValidationError(
      "EVIDENCE_AUTHORITY_UNAVAILABLE",
      `evidence record ${evidenceRef} carries an invalid observation timestamp`
    );
  }
  return {
    evidenceRef,
    ownerUserId: r.ownerUserId,
    businessId: (r.businessId as number | null | undefined) ?? null,
    sourceKind: r.sourceKind,
    registeredSourceKey: (r.registeredSourceKey as string | null | undefined) ?? null,
    corroborationCount: r.corroborationCount,
    contradictionFlag: r.contradictionFlag,
    observedAt: r.observedAt,
  };
}

export interface DeriveEvidenceTrustInput {
  readonly evidenceRef: string;
  /** Raw provider resolution (unknown until validated here). */
  readonly resolved: unknown;
  readonly userId: number;
  readonly businessId: number;
  /** Server-side registered/trusted external source keys for this tenant. */
  readonly trustedSourceKeys: ReadonlySet<string>;
  readonly nowMs: number;
  /** Evidence older than this is stale and cannot justify current claims. */
  readonly maxEvidenceAgeMs: number;
}

/**
 * Derive the trust class for ONE evidence reference from its canonical
 * resolution. Cross-tenant or cross-business evidence fails closed here —
// the derivation never returns a usable class for evidence the tenant does
 * not own (the engine turns that into a durable BLOCK).
 */
export function deriveEvidenceTrust(input: DeriveEvidenceTrustInput): DerivedEvidence {
  const { evidenceRef, userId, businessId, trustedSourceKeys, nowMs, maxEvidenceAgeMs } = input;

  // Absent resolution: indistinguishable from cross-tenant/forged. The engine
  // classifies this as a block; here we mark MALFORMED-with-absence.
  if (input.resolved === null || input.resolved === undefined) {
    return {
      evidenceRef,
      trustClass: "MALFORMED",
      notes: ["CROSS_TENANT_EVIDENCE"],
      stale: false,
    };
  }

  const record = validateResolvedRecord(input.resolved, evidenceRef);

  // Tenant + business scope: evidence must belong to this tenant, and its
  // business scope must be null (business-agnostic) or equal.
  if (record.ownerUserId !== userId) {
    return { evidenceRef, trustClass: "MALFORMED", notes: ["CROSS_TENANT_EVIDENCE"], stale: false };
  }
  if (record.businessId !== null && record.businessId !== businessId) {
    return { evidenceRef, trustClass: "MALFORMED", notes: ["CROSS_TENANT_EVIDENCE"], stale: false };
  }

  const stale = nowMs - Date.parse(record.observedAt) > maxEvidenceAgeMs;

  // Contradiction poisons trust but stays VISIBLE (never silently dropped).
  if (record.contradictionFlag) {
    return {
      evidenceRef,
      trustClass: "CONTRADICTED",
      notes: ["CONTRADICTED_EVIDENCE_PRESENT"],
      stale,
    };
  }

  switch (record.sourceKind) {
    case "MODEL_GENERATED":
      // Model output is synthesis, never source truth (charter principle 4).
      return {
        evidenceRef,
        trustClass: "UNVERIFIED",
        notes: ["MODEL_GENERATED_NOT_SOURCE_TRUTH"],
        stale,
      };
    case "INTERNAL_AUTHORITATIVE":
      return { evidenceRef, trustClass: "AUTHORITATIVE_INTERNAL", notes: [], stale };
    case "EXTERNAL_SOURCE": {
      if (
        record.registeredSourceKey !== null &&
        trustedSourceKeys.has(record.registeredSourceKey)
      ) {
        return { evidenceRef, trustClass: "VERIFIED_EXTERNAL", notes: [], stale };
      }
      if (record.corroborationCount >= 2) {
        return { evidenceRef, trustClass: "CORROBORATED_EXTERNAL", notes: [], stale };
      }
      if (record.corroborationCount === 1) {
        return { evidenceRef, trustClass: "SINGLE_EXTERNAL_SOURCE", notes: [], stale };
      }
      return { evidenceRef, trustClass: "UNVERIFIED", notes: [], stale };
    }
  }
}

/** Confidence ceiling implied by a single evidence trust class (policy mirror). */
export function confidenceCeilingForTrust(
  trustClass: StrategicEvidenceTrustClass
): StrategicConfidenceClass {
  switch (trustClass) {
    case "AUTHORITATIVE_INTERNAL":
    case "VERIFIED_EXTERNAL":
      return "HIGH";
    case "CORROBORATED_EXTERNAL":
      return "MEDIUM";
    case "SINGLE_EXTERNAL_SOURCE":
    case "UNVERIFIED":
      return "LOW";
    case "CONTRADICTED":
    case "MALFORMED":
      return "NONE";
  }
}

/**
 * Aggregate a set of derived evidences into the proposal-level source trust
 * class and confidence ceiling:
 * - best trust = highest-ranked non-malformed class (malformed descriptors
 *   carry no positive information but stay visible via notes);
 * - ANY contradiction caps the confidence ceiling at NONE (a contradiction
 *   can never silently support a confident claim — AC10/AC32);
 * - the ceiling is the minimum of the best-trust ceiling and the contradiction
 *   cap.
 */
export function aggregateEvidence(input: {
  readonly derived: readonly DerivedEvidence[];
}): {
  readonly sourceTrustClass: StrategicEvidenceTrustClass;
  readonly confidenceCeiling: StrategicConfidenceClass;
  readonly hasContradiction: boolean;
  readonly hasMalformed: boolean;
  readonly allStale: boolean;
  readonly anyStale: boolean;
  readonly evidenceCount: number;
} {
  const { derived } = input;
  let best: StrategicEvidenceTrustClass = "MALFORMED";
  let hasContradiction = false;
  let hasMalformed = false;
  let staleCount = 0;

  for (const d of derived) {
    if (d.trustClass === "CONTRADICTED") hasContradiction = true;
    if (d.trustClass === "MALFORMED") hasMalformed = true;
    if (d.stale) staleCount += 1;
    if (STRATEGIC_EVIDENCE_TRUST_RANK[d.trustClass] > STRATEGIC_EVIDENCE_TRUST_RANK[best]) {
      best = d.trustClass;
    }
  }

  let confidenceCeiling = confidenceCeilingForTrust(best);
  if (hasContradiction && STRATEGIC_CONFIDENCE_RANK[confidenceCeiling] > 0) {
    confidenceCeiling = "NONE";
  }

  const evidenceCount = derived.length;
  return {
    sourceTrustClass: best,
    confidenceCeiling,
    hasContradiction,
    hasMalformed,
    allStale: evidenceCount > 0 && staleCount === evidenceCount,
    anyStale: staleCount > 0,
    evidenceCount,
  };
}

/** Bound a claimed confidence by the evidence-implied ceiling (min by rank). */
export function boundConfidence(
  claimed: StrategicConfidenceClass,
  ceiling: StrategicConfidenceClass
): StrategicConfidenceClass {
  return STRATEGIC_CONFIDENCE_RANK[claimed] <= STRATEGIC_CONFIDENCE_RANK[ceiling]
    ? claimed
    : ceiling;
}

export { STRATEGIC_EVIDENCE_TRUST_RANK, STRATEGIC_CONFIDENCE_RANK };
