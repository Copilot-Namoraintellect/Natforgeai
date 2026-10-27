// ─── R6-D Nurture / Sales Handoff — upstream ports (contract §2–§4, §13) ───
//
// PURE module: the structural seams through which D consumes frozen upstream
// authorities (A identity, C qualification projection, F privacy, E
// conversion). Every payload is validated against the frozen contract shape
// BEFORE use: unknown versions, structural drift, or closed-vocabulary
// violations fail closed (NURTURE_UPSTREAM_CONTRACT_MISMATCH). D never
// trusts "internal" agent claims — cross-agent trust is re-validated here on
// every call. No I/O, no clock, no database access.

import { z } from "zod";
import { failNurture } from "./nurture-contract";

// ─── R6-C qualification handoff projection (frozen C §15 key set) ───

/** C contract version this D build was frozen against. */
export const SUPPORTED_QUALIFICATION_CONTRACT_PREFIX = "lead-qualification/v1" as const;
export const SUPPORTED_IDENTITY_CONTRACT_VERSION = "lead-identity/v1" as const;

const QUALIFICATION_DECISIONS = [
  "QUALIFIED",
  "NOT_QUALIFIED",
  "REVIEW_REQUIRED",
  "INSUFFICIENT_EVIDENCE",
  "BLOCKED",
] as const;

const PRIVACY_STATES = [
  "ACTIVE",
  "SUPPRESSED",
  "RESTRICTED",
  "RETENTION_PENDING",
  "RETENTION_EXPIRED",
  "ARCHIVED",
] as const;

const LEAD_ID_PATTERN = /^lid1:[a-f0-9]{64}$/;
const QUALIFICATION_ID_PATTERN = /^lqu1:[a-f0-9]{64}$/;

export const QualificationHandoffProjectionSchema = z.strictObject({
  qualificationId: z.string().regex(QUALIFICATION_ID_PATTERN),
  businessId: z.number().int().positive().nullable(),
  leadId: z.string().regex(LEAD_ID_PATTERN),
  decision: z.enum(QUALIFICATION_DECISIONS),
  reasonCodes: z.array(z.string().min(1).max(64)).max(8),
  scoreReference: z.strictObject({
    leadScoreId: z.string().min(1).max(96),
    scoringVersion: z.string().min(1).max(64),
    scoreContentHash: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  evidenceSnapshotReference: z.strictObject({
    evidenceSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  qualificationPolicyVersion: z.string().min(1).max(96),
  engineVersion: z.string().min(1).max(64),
  evaluatedAt: z.string().min(1),
  validUntil: z.string().min(1),
  review: z
    .strictObject({
      reviewId: z.string().min(1).max(96),
      status: z.enum(["pending", "progress_authorized", "progression_rejected"]),
      outcome: z.string().max(64).nullable(),
      reviewedAt: z.string().nullable(),
    })
    .nullable(),
  privacy: z.strictObject({
    state: z.enum(PRIVACY_STATES),
    actionable: z.boolean(),
  }),
  mayProgress: z.boolean(),
  progressBlockedReason: z
    .enum([
      "DECISION_NOT_QUALIFIED",
      "REVIEW_REQUIRED_PENDING",
      "REVIEW_REJECTED",
      "STALE_DECISION",
      "PRIVACY_BLOCKED",
    ])
    .nullable(),
});

export type QualificationHandoffProjection = z.infer<typeof QualificationHandoffProjectionSchema>;

export function isQualificationContractVersionSupported(engineVersion: string): boolean {
  return engineVersion.startsWith(SUPPORTED_QUALIFICATION_CONTRACT_PREFIX);
}

/**
 * Strict validation of one upstream projection payload (C port output).
 * Structural drift / unknown decision / unsupported contract version ⇒
 * fail closed. `source` names the port for bounded error messages only.
 */
export function validateQualificationProjection(
  raw: unknown,
  source = "qualificationPort"
): QualificationHandoffProjection {
  const parsed = QualificationHandoffProjectionSchema.safeParse(raw);
  if (!parsed.success) {
    failNurture(
      "NURTURE_UPSTREAM_CONTRACT_MISMATCH",
      `${source}: qualification handoff projection failed structural validation (frozen C contract): ${parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".")} ${i.message}`)
        .join("; ")}`
    );
  }
  const projection = parsed.data;
  if (!isQualificationContractVersionSupported(projection.engineVersion)) {
    failNurture(
      "NURTURE_UPSTREAM_CONTRACT_MISMATCH",
      `${source}: unsupported qualification engineVersion ${projection.engineVersion}; supported: ${SUPPORTED_QUALIFICATION_CONTRACT_PREFIX}*.`
    );
  }
  if (projection.mayProgress && projection.decision !== "QUALIFIED") {
    failNurture(
      "NURTURE_UPSTREAM_CONTRACT_MISMATCH",
      `${source}: mayProgress=true with non-QUALIFIED decision is contractually impossible; refusing tampered projection.`
    );
  }
  if (!isNurtureDecisionCompat(projection.decision)) {
    failNurture(
      "NURTURE_UPSTREAM_CONTRACT_MISMATCH",
      `${source}: unknown qualification decision ${String(projection.decision)}.`
    );
  }
  return projection;
}

function isNurtureDecisionCompat(value: unknown): boolean {
  return typeof value === "string" && (QUALIFICATION_DECISIONS as readonly string[]).includes(value);
}

// ─── R6-A identity reference (frozen A §12 projection subset) ───

export const LeadIdentityRefSchema = z.strictObject({
  leadId: z.string().regex(LEAD_ID_PATTERN),
  businessId: z.number().int().positive().nullable(),
  identityStatus: z.enum([
    "active",
    "anonymous",
    "partially_identified",
    "resolved",
    "conflicting",
    "suppressed",
    "merged",
    "archived",
  ]),
  canonicalLeadId: z.string().nullable(),
});

export type LeadIdentityRef = z.infer<typeof LeadIdentityRefSchema>;

export function validateLeadIdentityRef(raw: unknown, source = "identityPort"): LeadIdentityRef {
  const parsed = LeadIdentityRefSchema.safeParse(raw);
  if (!parsed.success) {
    failNurture(
      "NURTURE_UPSTREAM_CONTRACT_MISMATCH",
      `${source}: lead identity reference failed structural validation (frozen A contract).`
    );
  }
  return parsed.data;
}

// ─── R6-F privacy evidence (mirrors F LeadPrivacyEvidence shape) ───

export const PrivacyEvidenceSchema = z.strictObject({
  available: z.boolean(),
  reason: z.string().max(128).optional(),
  state: z.enum(PRIVACY_STATES),
  explicit: z.boolean(),
  retentionDeadlineAt: z.string().nullable(),
  previousState: z.enum(PRIVACY_STATES).nullable(),
  source: z.string().max(64).nullable(),
  actorUserId: z.number().int().positive().nullable(),
  updatedAt: z.string().nullable(),
});

export type PrivacyEvidence = z.infer<typeof PrivacyEvidenceSchema>;

export function validatePrivacyEvidence(raw: unknown, source = "privacyPort"): PrivacyEvidence {
  const parsed = PrivacyEvidenceSchema.safeParse(raw);
  if (!parsed.success) {
    failNurture(
      "NURTURE_UPSTREAM_CONTRACT_MISMATCH",
      `${source}: privacy evidence failed structural validation (frozen F contract).`
    );
  }
  return parsed.data;
}

/** F gate semantics (contract §4): actionable ⇔ ACTIVE or in-window RETENTION_PENDING. */
export function isPrivacyActionable(evidence: PrivacyEvidence, now: Date): boolean {
  if (!evidence.available) return false;
  if (evidence.state === "ACTIVE") return true;
  if (evidence.state === "RETENTION_PENDING") {
    if (!evidence.retentionDeadlineAt) return true; // F invariant: pending requires deadline; tolerate as actionable until proven otherwise
    return now.getTime() <= Date.parse(evidence.retentionDeadlineAt);
  }
  return false;
}

/** Blocker reason code for a non-actionable privacy state (closed mapping). */
export function privacyBlockReason(
  evidence: PrivacyEvidence
): "PRIVACY_STATE_UNAVAILABLE" | "PRIVACY_SUPPRESSED" | "PRIVACY_RESTRICTED" | "RETENTION_EXPIRED" | "PRIVACY_ARCHIVED" {
  if (!evidence.available) return "PRIVACY_STATE_UNAVAILABLE";
  switch (evidence.state) {
    case "SUPPRESSED":
      return "PRIVACY_SUPPRESSED";
    case "RESTRICTED":
      return "PRIVACY_RESTRICTED";
    case "RETENTION_EXPIRED":
      return "RETENTION_EXPIRED";
    case "ARCHIVED":
      return "PRIVACY_ARCHIVED";
    default:
      return "PRIVACY_STATE_UNAVAILABLE";
  }
}

// ─── R6-E conversion stop evidence (frozen E §5–§6, §11) ───

export const AUTHORITATIVE_TRUST_CLASSES = [
  "VERIFIED_INTERNAL",
  "VERIFIED_PROVIDER",
  "VERIFIED_CRM",
  "VERIFIED_PAYMENT",
  "USER_REPORTED",
] as const;

const TERMINAL_REVERSAL_STATUSES = ["REVERSED", "REFUNDED", "CANCELLED"] as const;

export const ConversionEvidenceRefSchema = z.strictObject({
  conversionId: z.string().min(1).max(96),
  businessId: z.number().int().positive(),
  outcomeStatus: z.string().max(32),
  sourceTrustClass: z.string().max(32),
  occurredAt: z.string().min(1),
});

export type ConversionEvidenceRef = z.infer<typeof ConversionEvidenceRefSchema>;

export function validateConversionEvidence(
  raw: unknown,
  source = "conversionPort"
): ConversionEvidenceRef[] {
  const parsed = z.array(ConversionEvidenceRefSchema).safeParse(raw);
  if (!parsed.success) {
    failNurture(
      "NURTURE_UPSTREAM_CONTRACT_MISMATCH",
      `${source}: conversion evidence failed structural validation (frozen E contract).`
    );
  }
  return parsed.data;
}

/** Authoritative stop evidence (contract §13): trusted class + not terminally reversed. */
export function selectAuthoritativeConversions(
  rows: readonly ConversionEvidenceRef[]
): ConversionEvidenceRef[] {
  return rows.filter(
    (row) =>
      (AUTHORITATIVE_TRUST_CLASSES as readonly string[]).includes(row.sourceTrustClass) &&
      !(TERMINAL_REVERSAL_STATUSES as readonly string[]).includes(row.outcomeStatus)
  );
}
