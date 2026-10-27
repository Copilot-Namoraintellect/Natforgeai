// ─── R6-A Lead Identity — controlled enrichment keys (pure) ───
//
// Normalization + deterministic hashing of verified identity evidence
// (contract §7). Raw values are validated and normalized, then hashed with
// domain separation; the raw value is NEVER persisted or returned. Oversized
// or malformed input fails closed before any hashing.

import {
  canonicalJson,
  sha256Hex,
  LeadIdentityInputError,
  IDENTITY_EVIDENCE_INPUT_TYPE_VALUES,
  type IdentityEvidenceInputType,
  type LinkingEvidenceType,
} from "./lead-identity-contract";

export const MAX_RAW_EVIDENCE_LENGTH = 512;

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PHONE_CLEAN_PATTERN = /^\+?[0-9]{7,15}$/;
const CONTROL_CHAR_PATTERN = /[\x00-\x1F\x7F]/;

function assertRawBounds(value: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new LeadIdentityInputError("INVALID_IDENTITY_EVIDENCE", "identity evidence value must be a non-empty string.");
  }
  if (value.length > MAX_RAW_EVIDENCE_LENGTH) {
    throw new LeadIdentityInputError(
      "IDENTITY_EVIDENCE_TOO_LARGE",
      `identity evidence value exceeds ${MAX_RAW_EVIDENCE_LENGTH} characters.`
    );
  }
}

export function normalizeEmailIdentity(value: string): string {
  assertRawBounds(value);
  const normalized = value.trim().toLowerCase();
  if (normalized.length > 320 || !EMAIL_PATTERN.test(normalized)) {
    throw new LeadIdentityInputError("INVALID_IDENTITY_EVIDENCE", "email evidence failed strict shape validation.");
  }
  return normalized;
}

export function normalizePhoneIdentity(value: string): string {
  assertRawBounds(value);
  const trimmed = value.trim();
  const digits = trimmed.startsWith("+") ? `+${trimmed.slice(1).replace(/[^0-9]/g, "")}` : trimmed.replace(/[^0-9]/g, "");
  if (!PHONE_CLEAN_PATTERN.test(digits)) {
    throw new LeadIdentityInputError(
      "INVALID_IDENTITY_EVIDENCE",
      "phone evidence must normalize to 7-15 digits (optional leading +)."
    );
  }
  return digits;
}

export function normalizeOpaqueReference(value: string): string {
  assertRawBounds(value);
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 128 || CONTROL_CHAR_PATTERN.test(normalized)) {
    throw new LeadIdentityInputError(
      "INVALID_IDENTITY_EVIDENCE",
      "customer/CRM reference must be 1-128 printable characters."
    );
  }
  return normalized;
}

/** Map the closed input vocabulary to its stored key type + hash column. */
export function resolveKeyType(
  evidenceType: IdentityEvidenceInputType
): { keyType: LinkingEvidenceType; column: "emailIdentityHash" | "phoneIdentityHash" | "customerReferenceHash" } {
  switch (evidenceType) {
    case "email":
      return { keyType: "email_hash", column: "emailIdentityHash" };
    case "phone":
      return { keyType: "phone_hash", column: "phoneIdentityHash" };
    case "authenticated_customer_reference":
      return { keyType: "authenticated_customer_reference", column: "customerReferenceHash" };
    case "crm_external_reference":
      return { keyType: "crm_external_reference", column: "customerReferenceHash" };
  }
}

export function normalizeIdentityEvidence(
  evidenceType: IdentityEvidenceInputType,
  value: string
): string {
  switch (evidenceType) {
    case "email":
      return normalizeEmailIdentity(value);
    case "phone":
      return normalizePhoneIdentity(value);
    default:
      return normalizeOpaqueReference(value);
  }
}

/** Deterministic, domain-separated hash; stable across process restarts. */
export function hashIdentityKey(keyType: LinkingEvidenceType, normalizedValue: string): string {
  return sha256Hex(canonicalJson({ keyType, value: normalizedValue }));
}

export interface VerifiedIdentityKey {
  readonly keyType: LinkingEvidenceType;
  readonly hash: string;
  readonly column: "emailIdentityHash" | "phoneIdentityHash" | "customerReferenceHash";
}

/** Validate → normalize → hash. The raw value never leaves this function. */
export function toVerifiedIdentityKey(
  evidenceType: IdentityEvidenceInputType,
  value: string
): VerifiedIdentityKey {
  const { keyType, column } = resolveKeyType(evidenceType);
  const normalized = normalizeIdentityEvidence(evidenceType, value);
  return { keyType, hash: hashIdentityKey(keyType, normalized), column };
}

export const IDENTITY_EVIDENCE_TYPES = IDENTITY_EVIDENCE_INPUT_TYPE_VALUES;
