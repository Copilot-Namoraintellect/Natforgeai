// ─── R6-C Lead Qualification — identity projection seam (C boundary) ───
//
// Re-validates the untrusted R6-A LeadIdentityProjection — it arrives as
// `unknown` and is never trusted until it passes this seam: exact key set,
// closed vocabularies, version allow-list, pattern anchors, strict ISO-UTC
// timestamps, and the deterministic C-derived identityReference content
// binding (contract §1, §14.4). The projection carries no decision/authority
// fields; this seam adds none. Internal source ≠ trusted source.

import {
  deriveIdentityReference,
  isAllowedLeadIdentityVersion,
  isIsoUtc,
  LEAD_ID_PATTERN,
  QualificationInputError,
  QualificationValidationError,
  type NormalizedIdentityEvidence,
} from "./qualification-contract";

export const IDENTITY_STATUS_VALUES = [
  "active",
  "anonymous",
  "partially_identified",
  "resolved",
  "conflicting",
  "suppressed",
  "merged",
  "archived",
] as const;

export const IDENTITY_CONFIDENCE_VALUES = ["unknown", "low", "medium", "high"] as const;

export const PRIMARY_IDENTITY_TYPE_VALUES = [
  "provider_actor",
  "email_hash",
  "phone_hash",
  "authenticated_customer_reference",
  "crm_external_reference",
  "anonymous_thread",
  "unknown",
] as const;

export const IDENTITY_PROVIDER_VALUES = ["meta", "linkedin", "twitter", "tiktok"] as const;

export const PROVENANCE_KIND_VALUES = [
  "opportunity_handoff",
  "identity_evidence",
  "merge",
  "conflict",
] as const;

const OPPORTUNITY_ID_PATTERN = /^opp1:[a-f0-9]{64}$/;
const HANDOFF_ID_PATTERN = /^oph1:[a-f0-9]{64}$/;

const IDENTITY_PROJECTION_KEYS = [
  "leadId",
  "businessId",
  "leadIdentityVersion",
  "identityStatus",
  "identityConfidence",
  "primaryIdentityType",
  "externalActorReferenceHash",
  "provider",
  "sourceOpportunityId",
  "sourceHandoffId",
  "canonicalLeadId",
  "firstObservedAt",
  "lastObservedAt",
  "provenance",
] as const;

const PROVENANCE_ITEM_KEYS = ["kind", "handoffId", "opportunityId", "evidenceType", "occurredAt"] as const;

const IDENTITY_STATUS_SET: ReadonlySet<string> = new Set(IDENTITY_STATUS_VALUES);
const IDENTITY_CONFIDENCE_SET: ReadonlySet<string> = new Set(IDENTITY_CONFIDENCE_VALUES);
const PRIMARY_IDENTITY_TYPE_SET: ReadonlySet<string> = new Set(PRIMARY_IDENTITY_TYPE_VALUES);
const IDENTITY_PROVIDER_SET: ReadonlySet<string> = new Set(IDENTITY_PROVIDER_VALUES);
const PROVENANCE_KIND_SET: ReadonlySet<string> = new Set(PROVENANCE_KIND_VALUES);
const HEX_64_PATTERN = /^[a-f0-9]{64}$/;
const MAX_EVIDENCE_TYPE_LENGTH = 64;

export interface ValidatedProvenanceItem {
  readonly kind: string;
  readonly handoffId: string | null;
  readonly opportunityId: string | null;
  /** Nullable upstream column (opportunity-handoff provenance carries none). */
  readonly evidenceType: string | null;
  readonly occurredAt: string;
}

/** Fully re-validated R6-A identity projection (trusted shape only). */
export interface ValidatedIdentityProjection {
  readonly leadId: string;
  readonly businessId: number | null;
  readonly leadIdentityVersion: string;
  readonly identityStatus: string;
  readonly identityConfidence: string;
  readonly primaryIdentityType: string;
  readonly externalActorReferenceHash: string | null;
  readonly provider: string | null;
  readonly sourceOpportunityId: string;
  readonly sourceHandoffId: string;
  readonly canonicalLeadId: string | null;
  readonly firstObservedAt: string;
  readonly lastObservedAt: string;
  readonly provenance: readonly ValidatedProvenanceItem[];
}

function fail(message: string): never {
  throw new QualificationValidationError("INVALID_IDENTITY_PROJECTION", message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function requireExactKeySet(
  value: Record<string, unknown>,
  allowed: readonly string[],
  what: string
): void {
  const expected = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) fail(`${what} carries unknown field: ${key}`);
  }
  for (const key of allowed) {
    if (!(key in value)) fail(`${what} is missing required field: ${key}`);
  }
}

function requirePattern(value: unknown, pattern: RegExp, field: string): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    fail(`${field} must match ${pattern}, got ${JSON.stringify(value)}`);
  }
  return value;
}

function requireNullablePattern(value: unknown, pattern: RegExp, field: string): string | null {
  if (value === null) return null;
  return requirePattern(value, pattern, field);
}

function requireClosedString(
  value: unknown,
  allowed: ReadonlySet<string>,
  field: string
): string {
  if (typeof value !== "string" || !allowed.has(value)) {
    fail(`${field} must be one of ${Array.from(allowed).join(", ")}, got ${JSON.stringify(value)}`);
  }
  return value;
}

function requireBoundedString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    fail(`${field} must be a non-empty string of at most ${maxLength} chars`);
  }
  return value;
}

function requireNullableBoundedString(value: unknown, field: string, maxLength: number): string | null {
  if (value === null) return null;
  return requireBoundedString(value, field, maxLength);
}

function requireIsoUtc(value: unknown, field: string): string {
  if (typeof value !== "string" || !isIsoUtc(value) || Number.isNaN(Date.parse(value))) {
    fail(`${field} must be a strict ISO-8601 UTC timestamp, got ${JSON.stringify(value)}`);
  }
  return value;
}

function requireNullablePositiveInt(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    fail(`${field} must be a positive integer or null, got ${String(value)}`);
  }
  return value;
}

function validateProvenance(value: unknown): readonly ValidatedProvenanceItem[] {
  if (!Array.isArray(value)) fail("provenance must be an array");
  const items: ValidatedProvenanceItem[] = [];
  for (const raw of value) {
    if (!isPlainObject(raw)) fail("provenance items must be plain objects");
    requireExactKeySet(raw, PROVENANCE_ITEM_KEYS, "provenance item");
    items.push(
      Object.freeze({
        kind: requireClosedString(raw.kind, PROVENANCE_KIND_SET, "provenance.kind"),
        handoffId: requireNullablePattern(raw.handoffId, HANDOFF_ID_PATTERN, "provenance.handoffId"),
        opportunityId: requireNullablePattern(
          raw.opportunityId,
          OPPORTUNITY_ID_PATTERN,
          "provenance.opportunityId"
        ),
        evidenceType: requireNullableBoundedString(
          raw.evidenceType,
          "provenance.evidenceType",
          MAX_EVIDENCE_TYPE_LENGTH
        ),
        occurredAt: requireIsoUtc(raw.occurredAt, "provenance.occurredAt"),
      })
    );
  }
  return Object.freeze(items);
}

/**
 * C-derived identity content binding over the exact projection subset
 * {leadId, businessId, leadIdentityVersion, identityStatus, identityConfidence,
 * primaryIdentityType, externalActorReferenceHash, provider, canonicalLeadId,
 * firstObservedAt, lastObservedAt, provenance} (contract §1). Any material
 * identity change ⇒ different reference ⇒ different qualification binding.
 */
export function deriveIdentityProjectionReference(
  input: Omit<ValidatedIdentityProjection, "sourceOpportunityId" | "sourceHandoffId">
): string {
  return deriveIdentityReference({
    leadId: input.leadId,
    businessId: input.businessId,
    leadIdentityVersion: input.leadIdentityVersion,
    identityStatus: input.identityStatus,
    identityConfidence: input.identityConfidence,
    primaryIdentityType: input.primaryIdentityType,
    externalActorReferenceHash: input.externalActorReferenceHash,
    provider: input.provider,
    canonicalLeadId: input.canonicalLeadId,
    firstObservedAt: input.firstObservedAt,
    lastObservedAt: input.lastObservedAt,
    provenance: input.provenance,
  });
}

/**
 * Strict boundary validation for the R6-A identity projection. Extra or
 * missing keys, out-of-vocabulary values, unknown identity versions
 * (IDENTITY_VERSION_UNKNOWN), bad anchors or timestamps all fail closed.
 */
export function validateIdentityProjection(input: unknown): NormalizedIdentityEvidence {
  if (!isPlainObject(input)) {
    fail("identity projection must be a plain object");
  }
  requireExactKeySet(input, IDENTITY_PROJECTION_KEYS, "identity projection");

  const leadIdentityVersion = input.leadIdentityVersion;
  if (typeof leadIdentityVersion !== "string" || !isAllowedLeadIdentityVersion(leadIdentityVersion)) {
    throw new QualificationInputError(
      "IDENTITY_VERSION_UNKNOWN",
      `unknown leadIdentityVersion: ${String(leadIdentityVersion)}`
    );
  }

  const projection: ValidatedIdentityProjection = Object.freeze({
    leadId: requirePattern(input.leadId, LEAD_ID_PATTERN, "leadId"),
    businessId: requireNullablePositiveInt(input.businessId, "businessId"),
    leadIdentityVersion,
    identityStatus: requireClosedString(input.identityStatus, IDENTITY_STATUS_SET, "identityStatus"),
    identityConfidence: requireClosedString(
      input.identityConfidence,
      IDENTITY_CONFIDENCE_SET,
      "identityConfidence"
    ),
    primaryIdentityType: requireClosedString(
      input.primaryIdentityType,
      PRIMARY_IDENTITY_TYPE_SET,
      "primaryIdentityType"
    ),
    externalActorReferenceHash: requireNullablePattern(
      input.externalActorReferenceHash,
      HEX_64_PATTERN,
      "externalActorReferenceHash"
    ),
    provider: requireClosedStringOrNull(input.provider, IDENTITY_PROVIDER_SET, "provider"),
    sourceOpportunityId: requirePattern(
      input.sourceOpportunityId,
      OPPORTUNITY_ID_PATTERN,
      "sourceOpportunityId"
    ),
    sourceHandoffId: requirePattern(input.sourceHandoffId, HANDOFF_ID_PATTERN, "sourceHandoffId"),
    canonicalLeadId: requireNullablePattern(input.canonicalLeadId, LEAD_ID_PATTERN, "canonicalLeadId"),
    firstObservedAt: requireIsoUtc(input.firstObservedAt, "firstObservedAt"),
    lastObservedAt: requireIsoUtc(input.lastObservedAt, "lastObservedAt"),
    provenance: validateProvenance(input.provenance),
  });

  return Object.freeze({
    leadId: projection.leadId,
    businessId: projection.businessId,
    leadIdentityVersion: projection.leadIdentityVersion,
    identityStatus: projection.identityStatus,
    identityConfidence: projection.identityConfidence,
    lastObservedAt: projection.lastObservedAt,
    identityReference: deriveIdentityProjectionReference(projection),
    canonicalLeadId: projection.canonicalLeadId,
  });
}

function requireClosedStringOrNull(
  value: unknown,
  allowed: ReadonlySet<string>,
  field: string
): string | null {
  if (value === null) return null;
  return requireClosedString(value, allowed, field);
}
