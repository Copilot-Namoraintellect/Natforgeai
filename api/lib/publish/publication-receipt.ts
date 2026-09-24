// ─── Publication Receipt contract (WBS13.7) ───
//
// Canonical normalized receipt for one successful external publication. A
// receipt is the durable, traceable proof that a publication operation
// completed at the provider: the provider's external post id, the external
// URL when the provider returned one, the publication status and timestamp,
// and — when a governed publish package was consumed — the package identity
// the success belongs to.
//
// Authority boundary:
//   - Receipts are built ONLY from the adapter boundary's normalized provider
//     receipt (NormalizedPublicationReceipt) plus the accepted operation
//     identity (derivePublicationOperationId over queue item + platform).
//     Raw provider payloads never enter this module.
//   - Receipts record SUCCESS only. Failures remain publication_failure audit
//     evidence; there is no failure "receipt".
//   - No tokens, secrets, credentials, or raw provider payloads are stored.
//     Every string field is shape-validated and scanned against the repo's
//     sensitive-key patterns; a receipt that fails the scan is rejected.
//
// Persistence shape: the receipt round-trips through a single nested
// `publicationReceipt` metadata key of a canonical `publication_success`
// audit event (see publication-receipt-audit.ts), correlated through the
// existing audit_events.packageId column when governed. Queue rows published
// before this authority existed hydrate an honest legacy receipt from the
// durable queue columns — never a fabricated package correlation.

import { TRPCError } from "@trpc/server";
import {
  derivePublicationOperationId,
  type NormalizedPublicationReceipt,
} from "../integrations/adapters/platform-adapter";
import {
  assertPersistedPublishPackageIntact,
  type PublishPackage,
  type PublishPackageClassification,
} from "./publish-package-contract";

export const PUBLICATION_RECEIPT_SCHEMA_VERSION = 1 as const;

/** Canonical metadata key under which a receipt is embedded in audit events. */
export const PUBLICATION_RECEIPT_METADATA_KEY = "publicationReceipt" as const;

/** Publication status a receipt can record. Receipts are success-only. */
export const PUBLICATION_RECEIPT_STATUSES = ["published"] as const;
export type PublicationReceiptStatus = (typeof PUBLICATION_RECEIPT_STATUSES)[number];

/**
 * Canonical normalized publication receipt. Deep-frozen at the boundary.
 * Governed receipts carry the publish package id + fingerprint the success
 * belongs to; legacy receipts (no governed package consumed) keep both null
 * and never fabricate package correlation.
 */
export interface PublicationReceipt {
  readonly schemaVersion: typeof PUBLICATION_RECEIPT_SCHEMA_VERSION;
  /** Accepted operation identity: publication:<platform>:<queueItemId>. */
  readonly operationId: string;
  readonly queueItemId: number;
  readonly platform: string;
  readonly status: PublicationReceiptStatus;
  /** Provider external post id, when the provider returned one. */
  readonly externalPostId: string | null;
  /** Provider/external URL, when available. */
  readonly externalUrl: string | null;
  /** Publication timestamp (ISO 8601); the success clock, never receipt time. */
  readonly publishedAtIso: string;
  /** Package classification consumed for this publication (mirrors the publish package). */
  readonly classification: PublishPackageClassification;
  /** Package identity consumed, from the actual package only; null when none. */
  readonly publishPackageId: string | null;
  readonly packageFingerprintSha256: string | null;
  /** Receipt normalization time (provenance only; never identity). */
  readonly receivedAtIso: string | null;
}

const ISO_8601_STRICT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:?\d{2})$/;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
// Mirrors the audit metadata hygiene rule: these patterns must never appear
// in any persisted receipt string field.
const SENSITIVE_VALUE_PATTERN =
  /token|password|passwd|authorization|secret|credential|api[-_]?key|session|cookie/i;

const LIMITS = {
  operationId: 128,
  platform: 64,
  externalPostId: 1024,
  externalUrl: 2048,
  publishPackageId: 128,
} as const;

function failReceipt(message: string): never {
  throw new TRPCError({ code: "BAD_REQUEST", message: `Publication receipt: ${message}` });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizePositiveId(value: unknown, name: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value <= 0 ||
    value > Number.MAX_SAFE_INTEGER
  ) {
    failReceipt(`invalid ${name}: expected a positive safe integer`);
  }
  return value;
}

function normalizeNullableBoundedText(
  value: unknown,
  name: string,
  max: number
): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") failReceipt(`invalid ${name}: expected a string or null`);
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > max) failReceipt(`invalid ${name}: expected at most ${max} characters`);
  if (SENSITIVE_VALUE_PATTERN.test(trimmed)) {
    failReceipt(`invalid ${name}: sensitive material must never be persisted in a receipt`);
  }
  return trimmed;
}

function normalizePlatform(value: unknown): string {
  const platform = normalizeNullableBoundedText(value, "platform", LIMITS.platform);
  if (!platform) failReceipt("invalid platform: expected a non-empty string");
  return platform.toLowerCase();
}

function requireIsoTimestamp(value: unknown, name: string): string {
  if (typeof value !== "string" || !ISO_8601_STRICT.test(value.trim())) {
    failReceipt(`invalid ${name}: expected a strict ISO 8601 timestamp`);
  }
  const trimmed = value.trim();
  if (Number.isNaN(Date.parse(trimmed))) {
    failReceipt(`invalid ${name}: unparseable ISO 8601 timestamp`);
  }
  return trimmed;
}

function normalizeNullableIsoTimestamp(value: unknown, name: string): string | null {
  if (value === null || value === undefined) return null;
  return requireIsoTimestamp(value, name);
}

function normalizeNullableSha256Hex(value: unknown, name: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") failReceipt(`invalid ${name}: expected a string or null`);
  const normalized = value.trim().toLowerCase();
  if (!SHA256_HEX_PATTERN.test(normalized)) {
    failReceipt(`invalid ${name}: expected 64-character lowercase SHA-256 hex`);
  }
  return normalized;
}

/**
 * Fail-closed validation of any candidate receipt-shaped value. Accepts only
 * the exact canonical shape produced by buildPublicationReceipt; tampered or
 * hand-built candidates are rejected. Pure.
 */
export function normalizePublicationReceipt(candidate: unknown): PublicationReceipt {
  if (!isPlainObject(candidate)) {
    failReceipt("expected a structured receipt object");
  }
  if (candidate.schemaVersion !== PUBLICATION_RECEIPT_SCHEMA_VERSION) {
    failReceipt("unsupported schema version");
  }
  const queueItemId = normalizePositiveId(candidate.queueItemId, "queueItemId");
  const platform = normalizePlatform(candidate.platform);
  const status = candidate.status;
  if (status !== "published") {
    failReceipt('invalid status: receipts record success only ("published")');
  }
  const operationId = normalizeNullableBoundedText(
    candidate.operationId,
    "operationId",
    LIMITS.operationId
  );
  if (!operationId) failReceipt("invalid operationId: expected a non-empty string");
  const expectedOperationId = derivePublicationOperationId({ platform, queueItemId });
  if (operationId !== expectedOperationId) {
    failReceipt("operationId does not match the accepted queue-item/platform identity");
  }
  const classification = candidate.classification;
  if (classification !== "governed" && classification !== "legacy") {
    failReceipt('invalid classification: expected "governed" or "legacy"');
  }
  const publishPackageId = normalizeNullableBoundedText(
    candidate.publishPackageId,
    "publishPackageId",
    LIMITS.publishPackageId
  );
  const packageFingerprintSha256 = normalizeNullableSha256Hex(
    candidate.packageFingerprintSha256,
    "packageFingerprintSha256"
  );
  if (classification === "governed" && (!publishPackageId || !packageFingerprintSha256)) {
    failReceipt("governed receipts must carry publish package id and fingerprint");
  }
  // Legacy receipts may carry REAL package correlation (a legacy-classified
  // package was consumed); the builder only ever supplies package identity
  // from an actual package, so null fields here mean "no package" — the
  // never-fabricated legacy shape — and are enforced by the build path.
  return Object.freeze({
    schemaVersion: PUBLICATION_RECEIPT_SCHEMA_VERSION,
    operationId,
    queueItemId,
    platform,
    status,
    externalPostId: normalizeNullableBoundedText(
      candidate.externalPostId,
      "externalPostId",
      LIMITS.externalPostId
    ),
    externalUrl: normalizeNullableBoundedText(
      candidate.externalUrl,
      "externalUrl",
      LIMITS.externalUrl
    ),
    publishedAtIso: requireIsoTimestamp(candidate.publishedAtIso, "publishedAtIso"),
    classification,
    publishPackageId,
    packageFingerprintSha256,
    receivedAtIso: normalizeNullableIsoTimestamp(candidate.receivedAtIso, "receivedAtIso"),
  });
}

/**
 * Build the canonical receipt for one successful governed/legacy publication.
 * The normalized adapter receipt is the ONLY provider-sourced input; the
 * package, when supplied, is tamper-checked before its identity is recorded.
 * A governed package whose destination platform diverges from the operation
 * platform fails closed.
 */
export function buildPublicationReceipt(input: {
  normalized: NormalizedPublicationReceipt;
  queueItemId: number;
  platform: string;
  /** The one shared publication-success timestamp (queue publishedAt clock). */
  publishedAtIso: string;
  publishPackage?: PublishPackage | null;
  receivedAtIso?: string | null;
}): PublicationReceipt {
  if (!isPlainObject(input)) failReceipt("build input must be a structured object");
  const normalized = input.normalized;
  if (!isPlainObject(normalized)) {
    failReceipt("normalized provider receipt is required");
  }
  const queueItemId = normalizePositiveId(input.queueItemId, "queueItemId");
  const platform = normalizePlatform(input.platform);
  if (normalized.status !== "published") {
    failReceipt("only successful provider receipts can build a publication receipt");
  }
  if (
    typeof normalized.operationId !== "string" ||
    normalized.operationId !== derivePublicationOperationId({ platform, queueItemId })
  ) {
    failReceipt("normalized receipt operationId does not match the queue operation identity");
  }
  const packageIdentity = input.publishPackage ?? null;
  if (packageIdentity) {
    assertPersistedPublishPackageIntact(packageIdentity);
    if (packageIdentity.identity.destination.platform !== platform) {
      failReceipt("publish package destination platform does not match the operation platform");
    }
  }
  return normalizePublicationReceipt({
    schemaVersion: PUBLICATION_RECEIPT_SCHEMA_VERSION,
    operationId: derivePublicationOperationId({ platform, queueItemId }),
    queueItemId,
    platform,
    status: "published",
    externalPostId: normalized.externalPostId ?? null,
    externalUrl: normalized.externalUrl ?? null,
    publishedAtIso: input.publishedAtIso,
    classification: packageIdentity ? packageIdentity.classification : "legacy",
    publishPackageId: packageIdentity ? packageIdentity.packageId : null,
    packageFingerprintSha256: packageIdentity
      ? packageIdentity.packageFingerprintSha256
      : null,
    receivedAtIso: input.receivedAtIso ?? null,
  });
}

/**
 * Project a receipt into the canonical audit metadata shape. Returns a fresh
 * mutable record holding the receipt under its single canonical key.
 */
export function publicationReceiptToMetadata(
  receipt: PublicationReceipt
): Record<string, unknown> {
  const normalized = normalizePublicationReceipt(receipt);
  return {
    [PUBLICATION_RECEIPT_METADATA_KEY]: { ...normalized },
  };
}

/**
 * Extract and fail-closed-validate a canonical receipt from audit metadata.
 * Returns null when no canonical receipt is present (e.g. success events
 * recorded before this authority existed — callers then fall back to the
 * durable queue row). A present-but-malformed receipt is evidence tampering
 * and throws.
 */
export function extractPublicationReceiptFromMetadata(
  metadata: unknown
): PublicationReceipt | null {
  if (!isPlainObject(metadata)) return null;
  const candidate = metadata[PUBLICATION_RECEIPT_METADATA_KEY];
  if (candidate === null || candidate === undefined) return null;
  return normalizePublicationReceipt(candidate);
}

/**
 * Hydrate an honest legacy receipt from the durable queue row alone. Existing
 * published rows predate this authority: they carry the provider post id and
 * the publication timestamp, but no package correlation can be proven from
 * the row, so the receipt is legacy with null package fields — never
 * fabricated. Returns null unless the row is durably published.
 */
export function buildLegacyReceiptFromQueueSuccess(input: {
  queueItemId: number;
  platform: string;
  status: string;
  externalPostId: unknown;
  publishedAt: unknown;
}): PublicationReceipt | null {
  const status = typeof input.status === "string" ? input.status.trim() : "";
  if (status !== "published" || input.publishedAt === null || input.publishedAt === undefined) {
    return null;
  }
  const publishedAt = input.publishedAt;
  const publishedAtIso =
    publishedAt instanceof Date
      ? publishedAt.toISOString()
      : typeof publishedAt === "string"
        ? publishedAt
        : null;
  if (!publishedAtIso) return null;
  const queueItemId = normalizePositiveId(input.queueItemId, "queueItemId");
  const platform = normalizePlatform(input.platform);
  return normalizePublicationReceipt({
    schemaVersion: PUBLICATION_RECEIPT_SCHEMA_VERSION,
    operationId: derivePublicationOperationId({ platform, queueItemId }),
    queueItemId,
    platform,
    status: "published",
    externalPostId: input.externalPostId,
    externalUrl: null,
    publishedAtIso,
    classification: "legacy",
    publishPackageId: null,
    packageFingerprintSha256: null,
    receivedAtIso: null,
  });
}
