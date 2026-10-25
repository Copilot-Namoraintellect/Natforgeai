// ─── R6-A Lead Identity — canonical contract (pure, no I/O, no clock) ───
//
// Closed vocabularies, canonical record types, strict input schemas, typed
// error taxonomy, and deterministic identity derivation for the lead-identity
// authority (docs/contracts/lead-identity-contract.md). This module performs
// no I/O and authorizes nothing.
//
// Upstream: the R5-D opportunity handoff envelope is FROZEN authority
// (docs/contracts/opportunity-to-lead-autonomy-contract.md) — consumed, never
// redefined. The envelope is treated as untrusted data at this seam: strict
// schema validation + deterministic tamper verification happen before any
// identity fact is derived from it (cross-agent security addendum §2/§4).

import { z } from "zod";
import {
  HANDOFF_ENVELOPE_VERSION,
  OpportunityTypeEnum,
  OpportunityStatusEnum,
  ConfidenceClassEnum,
  EvidenceStrengthEnum,
  UrgencyEnum,
  EvidenceRefSchema,
  type OpportunityHandoffEnvelope,
} from "../opportunity/opportunity-contract";
import { HANDOFF_ID_PREFIX } from "../opportunity/opportunity-identity";

export const LEAD_IDENTITY_CONTRACT_VERSION = "lead-identity/v1" as const;

// ─── Closed vocabularies (lead-identity contract §3, §4, §5 — closed) ───

export const IDENTITY_TYPE_VALUES = [
  "provider_actor",
  "email_hash",
  "phone_hash",
  "authenticated_customer_reference",
  "crm_external_reference",
  "anonymous_thread",
  "unknown",
] as const;

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

/** Authoritative linking-key types that may authorize a deterministic merge. */
export const LINKING_EVIDENCE_TYPE_VALUES = [
  "email_hash",
  "phone_hash",
  "authenticated_customer_reference",
  "crm_external_reference",
] as const;

/** Closed input vocabulary for governed identity enrichment (raw values; hashed server-side). */
export const IDENTITY_EVIDENCE_INPUT_TYPE_VALUES = [
  "email",
  "phone",
  "authenticated_customer_reference",
  "crm_external_reference",
] as const;

/** Closed governance suppression reasons. */
export const IDENTITY_SUPPRESSION_REASON_VALUES = [
  "privacy_request",
  "safety_escalation",
  "operator_request",
  "data_quality",
] as const;

export const IdentityTypeEnum = z.enum(IDENTITY_TYPE_VALUES);
export const IdentityStatusEnum = z.enum(IDENTITY_STATUS_VALUES);
export const IdentityConfidenceEnum = z.enum(IDENTITY_CONFIDENCE_VALUES);
export const LinkingEvidenceTypeEnum = z.enum(LINKING_EVIDENCE_TYPE_VALUES);
export const IdentityEvidenceInputTypeEnum = z.enum(IDENTITY_EVIDENCE_INPUT_TYPE_VALUES);
export const IdentitySuppressionReasonEnum = z.enum(IDENTITY_SUPPRESSION_REASON_VALUES);

export type IdentityType = z.infer<typeof IdentityTypeEnum>;
export type IdentityStatus = z.infer<typeof IdentityStatusEnum>;
export type IdentityConfidence = z.infer<typeof IdentityConfidenceEnum>;
export type LinkingEvidenceType = z.infer<typeof LinkingEvidenceTypeEnum>;
export type IdentityEvidenceInputType = z.infer<typeof IdentityEvidenceInputTypeEnum>;
export type IdentitySuppressionReason = z.infer<typeof IdentitySuppressionReasonEnum>;

// ─── Typed error taxonomy (stable codes, fail-closed) ───

export class LeadIdentityError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "LeadIdentityError";
    this.code = code;
  }
}

/** Intake/evidence input failed safety/bounding/ownership validation. */
export class LeadIdentityInputError extends LeadIdentityError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "LeadIdentityInputError";
  }
}

/** A record or envelope failed strict schema validation. */
export class LeadIdentityValidationError extends LeadIdentityError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "LeadIdentityValidationError";
  }
}

/** Handoff envelope hash drift — tampered or forged handoff. */
export class LeadIdentityTamperError extends LeadIdentityError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "LeadIdentityTamperError";
  }
}

/** Tenant/business ownership could not be proven server-side. */
export class LeadIdentityOwnershipError extends LeadIdentityError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "LeadIdentityOwnershipError";
  }
}

/** Guarded state transition rejected (stale version / illegal state). */
export class LeadIdentityStateConflictError extends LeadIdentityError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "LeadIdentityStateConflictError";
  }
}

export type LeadIdentityDuplicateClassification = "none" | "idempotent_replay";

// ─── Canonical local helpers (repo convention: each module owns a copy) ───

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "undefined";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const entries = Object.keys(obj)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`);
  return `{${entries.join(",")}}`;
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

import { createHash } from "crypto";

export const HEX_64 = /^[a-f0-9]{64}$/;
export const LEAD_ID_PREFIX = "lid1:";
export const MERGE_ID_PREFIX = "lmg1:";
export const NO_ACTOR = "no-actor";
const ISO_8601_PARSEABLE = (value: string) => !Number.isNaN(Date.parse(value));
const ISO_REFINEMENT = { message: "must be a parseable ISO 8601 timestamp" } as const;

// ─── R5 handoff envelope seam (strict, untrusted-data validation) ───
//
// Mirrors detector.ts envelopePreId exactly. z.strictObject rejects unknown
// fields; closed enums reject injected labels; `externalActorReference` must
// be null — any non-null value is a tamper/injection attempt and fails closed.

const HandoffEnvelopeSchema = z.strictObject({
  handoffEnvelopeVersion: z.literal(HANDOFF_ENVELOPE_VERSION),
  handoffId: z.string().regex(new RegExp(`^${HANDOFF_ID_PREFIX.replace(":", "\\:")}[a-f0-9]{64}$`)),
  opportunityId: z.string().regex(/^opp1:[a-f0-9]{64}$/),
  opportunityKey: z.string().regex(HEX_64),
  userId: z.number().int().positive(),
  businessId: z.number().int().positive().nullable(),
  opportunityType: OpportunityTypeEnum,
  opportunityStatusAtHandoff: OpportunityStatusEnum,
  confidenceClass: ConfidenceClassEnum,
  evidenceStrength: EvidenceStrengthEnum,
  urgency: UrgencyEnum,
  topic: z.string().max(48).nullable(),
  topicKey: z.string().min(1).max(128),
  actorKey: z.string().regex(new RegExp(`^(${HEX_64.source}|${NO_ACTOR})$`)),
  threadKey: z.string().min(1).max(128),
  campaignId: z.number().int().positive().nullable(),
  publicationId: z.string().max(128).nullable(),
  provider: z.enum(["meta", "linkedin", "twitter", "tiktok"]).nullable(),
  externalActorReference: z.null(),
  evidenceCount: z.number().int().min(0),
  contradictionCount: z.number().int().min(0),
  firstObservedAt: z.string().min(1).max(32).refine(ISO_8601_PARSEABLE, ISO_REFINEMENT),
  lastObservedAt: z.string().min(1).max(32).refine(ISO_8601_PARSEABLE, ISO_REFINEMENT),
  detectorRulesVersion: z.string().min(1).max(64),
  classifierVersions: z.array(z.string().min(1).max(64)).max(32),
  evidence: z.array(EvidenceRefSchema).max(256),
  evidenceSnapshotHash: z.string().regex(HEX_64),
  handedOffAt: z.string().min(1).max(32).refine(ISO_8601_PARSEABLE, ISO_REFINEMENT),
});

/** Strict schema validation; rejects malformed/oversized/injected envelopes. */
export function validateHandoffEnvelope(input: unknown): OpportunityHandoffEnvelope {
  const result = HandoffEnvelopeSchema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new LeadIdentityValidationError(
      "ENVELOPE_SCHEMA_INVALID",
      `handoff envelope failed strict validation at ${issue?.path.join(".") || "(root)"}: ${issue?.message ?? "unknown"}.`
    );
  }
  return result.data as OpportunityHandoffEnvelope;
}

/**
 * Deterministic tamper verification: the handoff id must be the content hash
 * of the canonical envelope, and the evidence snapshot hash must match the
 * embedded manifest. Any drift fails closed (HANDOFF_TAMPERED).
 */
export function verifyHandoffEnvelopeIntegrity(envelope: OpportunityHandoffEnvelope): void {
  const { handoffId, ...content } = envelope;
  const expectedHandoffId = `${HANDOFF_ID_PREFIX}${sha256Hex(canonicalJson(content))}`;
  if (expectedHandoffId !== handoffId) {
    throw new LeadIdentityTamperError(
      "HANDOFF_TAMPERED",
      "handoffId does not match the canonical envelope content hash."
    );
  }
  const expectedSnapshot = sha256Hex(canonicalJson(envelope.evidence));
  if (expectedSnapshot !== envelope.evidenceSnapshotHash) {
    throw new LeadIdentityTamperError(
      "HANDOFF_TAMPERED",
      "evidenceSnapshotHash does not match the embedded evidence manifest."
    );
  }
}

/** Full canonical-envelope content hash — the provenance lineage anchor. */
export function deriveEnvelopeHash(envelope: OpportunityHandoffEnvelope): string {
  return sha256Hex(canonicalJson(envelope));
}

// ─── Deterministic identity derivation (contract §1) ───

export interface LeadIdentityCoordinates {
  readonly userId: number;
  readonly businessId: number | null;
  /** R5 actorKey when actor-present; null for anonymous/thread-only identity. */
  readonly actorKey: string | null;
  /** R5 threadKey when anonymous; null when actor-present. */
  readonly threadKey: string | null;
}

export function buildIdentityCoordinates(
  envelope: OpportunityHandoffEnvelope
): LeadIdentityCoordinates {
  if (envelope.actorKey === NO_ACTOR) {
    return {
      userId: envelope.userId,
      businessId: envelope.businessId,
      actorKey: null,
      threadKey: envelope.threadKey,
    };
  }
  return {
    userId: envelope.userId,
    businessId: envelope.businessId,
    actorKey: envelope.actorKey,
    threadKey: null,
  };
}

export function deriveIdentityKey(coordinates: LeadIdentityCoordinates): string {
  return sha256Hex(
    canonicalJson({
      userId: coordinates.userId,
      businessId: coordinates.businessId,
      actorKey: coordinates.actorKey ?? NO_ACTOR,
      threadKey: coordinates.actorKey ? "no-thread" : coordinates.threadKey,
    })
  );
}

export function deriveLeadId(identityKey: string): string {
  return `${LEAD_ID_PREFIX}${identityKey}`;
}

// ─── Lead identity record + downstream-safe projection (contract §2, §12) ───

export interface LeadIdentityRecord {
  readonly leadId: string;
  readonly identityKey: string;
  readonly leadIdentityVersion: typeof LEAD_IDENTITY_CONTRACT_VERSION;
  readonly rowVersion: number;
  readonly userId: number;
  readonly businessId: number | null;
  readonly primaryIdentityType: IdentityType;
  readonly identityStatus: IdentityStatus;
  readonly identityConfidence: IdentityConfidence;
  readonly externalActorReferenceHash: string | null;
  readonly provider: "meta" | "linkedin" | "twitter" | "tiktok" | null;
  readonly emailIdentityHash: string | null;
  readonly phoneIdentityHash: string | null;
  readonly customerReferenceHash: string | null;
  readonly sourceOpportunityId: string;
  readonly sourceHandoffId: string;
  readonly canonicalLeadId: string | null;
  readonly firstObservedAt: string;
  readonly lastObservedAt: string;
  readonly provenanceCount: number;
  readonly identityEvidenceCount: number;
  readonly statusChangedAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface LeadIdentityProvenanceRef {
  readonly kind: "opportunity_handoff" | "identity_evidence" | "merge" | "conflict";
  readonly handoffId: string | null;
  readonly opportunityId: string | null;
  readonly evidenceType: string | null;
  readonly occurredAt: string;
}

/** The single downstream read surface (A8). Safe fields only — no PII exists. */
export interface LeadIdentityProjection {
  readonly leadId: string;
  readonly businessId: number | null;
  readonly leadIdentityVersion: typeof LEAD_IDENTITY_CONTRACT_VERSION;
  readonly identityStatus: IdentityStatus;
  readonly identityConfidence: IdentityConfidence;
  readonly primaryIdentityType: IdentityType;
  readonly externalActorReferenceHash: string | null;
  readonly provider: "meta" | "linkedin" | "twitter" | "tiktok" | null;
  readonly sourceOpportunityId: string;
  readonly sourceHandoffId: string;
  readonly canonicalLeadId: string | null;
  readonly firstObservedAt: string;
  readonly lastObservedAt: string;
  readonly provenance: readonly LeadIdentityProvenanceRef[];
}
