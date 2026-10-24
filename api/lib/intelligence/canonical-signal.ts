// ─── R5-B Intent & Sentiment Intelligence — canonical social signal boundary ───
//
// PURE adapter module aligned with the frozen R5-A social-signal contract
// (docs/contracts/social-signal-contract.md @ c9a930e). It consumes the
// R5-A-consumable field set (§11 of the social-listening contract) and
// normalizes it into the canonical signal interpreted by R5-B. No R5-A code
// is imported; the structural mirror below is the only coupling.
//
// Identity mappings (R5-A → R5-B):
//   signalId      = R5-A signalKey        ("sigv1:" + sha256, consumed opaquely)
//   signalVersion = R5-A ingestionVersion (currently 1; bumped only by R5-A)
//
// Invalid input fails closed with a typed error before any rule or model
// processing (no record, no billing). No I/O, no clock, no logging.

import { z } from "zod";
import { InterpretationInputError } from "./interpretation-contract";

export const CANONICAL_SIGNAL_CONTRACT_VERSION = "canonical-social-signal/v1" as const;

/** Frozen R5-A signal types (social-signal-contract §3). */
export const SIGNAL_TYPE_VALUES = [
  "comment",
  "reply",
  "mention",
  "reaction",
  "direct_message",
  "repost",
  "follow",
  "unfollow",
  "campaign_response",
  "inbound_message",
  "unknown",
] as const;

export const PROVIDER_VALUES = ["meta", "linkedin", "twitter", "tiktok"] as const;

export const PLATFORM_VALUES = [
  "facebook",
  "instagram",
  "whatsapp",
  "linkedin",
  "twitter",
  "tiktok",
] as const;

export const ATTRIBUTION_TYPE_VALUES = ["direct", "business", "unattributed"] as const;

export type CanonicalSignalType = (typeof SIGNAL_TYPE_VALUES)[number];
export type CanonicalProvider = (typeof PROVIDER_VALUES)[number];
export type CanonicalPlatform = (typeof PLATFORM_VALUES)[number];
export type CanonicalAttributionType = (typeof ATTRIBUTION_TYPE_VALUES)[number];

const SIGNAL_TYPE_SET: ReadonlySet<string> = new Set(SIGNAL_TYPE_VALUES);

export const SignalTypeEnum = z.enum(SIGNAL_TYPE_VALUES);
export const ProviderEnum = z.enum(PROVIDER_VALUES);
export const PlatformEnum = z.enum(PLATFORM_VALUES);
export const AttributionTypeEnum = z.enum(ATTRIBUTION_TYPE_VALUES);

/** Signal types whose payload can carry interpretable free text (contract §7). */
export const TEXT_BEARING_SIGNAL_TYPES: readonly CanonicalSignalType[] = [
  "comment",
  "reply",
  "mention",
  "direct_message",
  "campaign_response",
  "inbound_message",
];

/** Derived complement of the text-bearing set, excluding `unknown` (rejected). */
export const NON_TEXT_BEARING_SIGNAL_TYPES: readonly CanonicalSignalType[] =
  SIGNAL_TYPE_VALUES.filter(
    (type) => type !== "unknown" && !TEXT_BEARING_SIGNAL_TYPES.includes(type)
  );

// ─── Strict input schema (aligned R5-A consumption boundary) ───

const ISO_8601_PARSEABLE = (value: string) => !Number.isNaN(Date.parse(value));
const ISO_REFINEMENT = {
  message: "must be a parseable ISO 8601 timestamp",
} as const;
const HEX_64 = /^[a-f0-9]{64}$/;

export const CanonicalSocialSignalInputSchema = z.strictObject({
  /** R5-A signalKey, consumed opaquely. */
  signalId: z.string().min(1).max(128),
  /** R5-A ingestionVersion. */
  signalVersion: z.number().int().min(1),
  signalType: SignalTypeEnum,
  provider: ProviderEnum,
  platform: PlatformEnum,
  /** Opaque provider actor id; display only, never an authority. */
  actorReference: z.string().min(1).max(255).nullable().optional(),
  /** Bounded display name; PII minimized. */
  actorDisplayName: z.string().min(1).max(255).nullable().optional(),
  /** Untrusted social text; bounded by the frozen R5-A 1024-char cap here and
   * by the 4000-char sanitizer cap in input-safety (defense in depth). */
  contentText: z.string().max(1024).nullable().optional(),
  /** Provider perma-link (comment URL…); display only. */
  contentReference: z.string().min(1).max(255).nullable().optional(),
  /** Provider event time, ISO 8601; display only. */
  occurredAt: z
    .string()
    .min(1)
    .refine(ISO_8601_PARSEABLE, ISO_REFINEMENT)
    .nullable()
    .optional(),
  /** Acceptance clock at persistence; display only. */
  observedAt: z
    .string()
    .min(1)
    .refine(ISO_8601_PARSEABLE, ISO_REFINEMENT)
    .nullable()
    .optional(),
  attributionType: AttributionTypeEnum,
  sourceCampaignId: z.number().int().positive().nullable().optional(),
  parentExternalObjectId: z.string().min(1).max(255).nullable().optional(),
  /** R5-A evidence integrity hash; participates in the content hash. */
  providerEvidenceHash: z.string().regex(HEX_64, "providerEvidenceHash must be 64 hex chars").nullable().optional(),
});

export type CanonicalSocialSignalInput = z.infer<typeof CanonicalSocialSignalInputSchema>;

/** Canonical, normalized, deeply-frozen social signal consumed by R5-B. */
export interface CanonicalSocialSignal {
  readonly signalContractVersion: typeof CANONICAL_SIGNAL_CONTRACT_VERSION;
  readonly signalId: string;
  readonly signalVersion: number;
  readonly signalType: CanonicalSignalType;
  readonly provider: CanonicalProvider;
  readonly platform: CanonicalPlatform;
  readonly actorReference: string | null;
  readonly actorDisplayName: string | null;
  /** Untrusted social text; null when absent. */
  readonly contentText: string | null;
  readonly contentReference: string | null;
  readonly occurredAt: string | null;
  readonly observedAt: string | null;
  readonly attributionType: CanonicalAttributionType;
  readonly sourceCampaignId: number | null;
  readonly parentExternalObjectId: string | null;
  readonly providerEvidenceHash: string | null;
}

/** Canonical signal after input-safety: text is always a (possibly empty) string. */
export type SanitizedSocialSignal = Omit<CanonicalSocialSignal, "contentText"> & {
  readonly contentText: string;
};

function isSupportedSignalType(value: unknown): value is CanonicalSignalType {
  return typeof value === "string" && SIGNAL_TYPE_SET.has(value);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

function failInput(message: string): never {
  throw new InterpretationInputError("INVALID_SIGNAL_INPUT", message);
}

/**
 * Validates and normalizes an R5-A-facing signal into the canonical readonly
 * shape. Fails closed with {@link InterpretationInputError} on any schema
 * deviation, or on a signalType outside the closed enum (before any
 * processing).
 */
export function toCanonicalSignal(input: unknown): CanonicalSocialSignal {
  if (
    input !== null &&
    typeof input === "object" &&
    !Array.isArray(input) &&
    typeof (input as Record<string, unknown>).signalType === "string" &&
    !isSupportedSignalType((input as Record<string, unknown>).signalType)
  ) {
    // Closed-enum violation is surfaced as its own fail-closed class so the
    // caller can distinguish "unsupported signal" from "malformed signal".
    throw new InterpretationInputError(
      "UNSUPPORTED_SIGNAL_TYPE",
      `signalType "${String((input as Record<string, unknown>).signalType)}" is outside the frozen R5-A signal vocabulary.`
    );
  }

  const result = CanonicalSocialSignalInputSchema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    failInput(`Canonical social signal failed schema validation: ${issues}`);
  }

  const parsed = result.data;
  const toIso = (value: string | null | undefined): string | null =>
    value == null ? null : value;
  const toTrimmed = (value: string | null | undefined): string | null =>
    value == null ? null : value.trim();

  const signal: CanonicalSocialSignal = {
    signalContractVersion: CANONICAL_SIGNAL_CONTRACT_VERSION,
    signalId: parsed.signalId.trim(),
    signalVersion: parsed.signalVersion,
    signalType: parsed.signalType,
    provider: parsed.provider,
    platform: parsed.platform,
    actorReference: toTrimmed(parsed.actorReference),
    actorDisplayName: toTrimmed(parsed.actorDisplayName),
    contentText: parsed.contentText === undefined ? null : parsed.contentText,
    contentReference: toTrimmed(parsed.contentReference),
    occurredAt: toIso(parsed.occurredAt),
    observedAt: toIso(parsed.observedAt),
    attributionType: parsed.attributionType,
    sourceCampaignId: parsed.sourceCampaignId === undefined ? null : parsed.sourceCampaignId,
    parentExternalObjectId: toTrimmed(parsed.parentExternalObjectId),
    providerEvidenceHash:
      parsed.providerEvidenceHash == null
        ? null
        : parsed.providerEvidenceHash.toLowerCase(),
  };
  return deepFreeze(signal);
}

// ─── Structural R5-A convergence seam (no R5-A code imported) ───

/**
 * Structural mirror of the frozen R5-A `social_signals` row (c9a930e). Field
 * names match the durable R5-A table so an R5-A row (or row-like join) adapts
 * without transformation beyond Dates → ISO strings.
 */
export interface SocialSignalRowLike {
  readonly signalKey: string;
  readonly ingestionVersion: number;
  readonly signalType: string;
  readonly provider: string;
  readonly platform: string;
  readonly actorReference: string | null;
  readonly actorDisplayName: string | null;
  readonly contentText: string | null;
  readonly contentReference: string | null;
  readonly occurredAt: Date | string | null;
  readonly observedAt: Date | string | null;
  readonly attributionType: string;
  readonly sourceCampaignId: number | null;
  readonly parentExternalObjectId: string | null;
  readonly providerEvidenceHash: string;
}

function requireRowString(row: SocialSignalRowLike, key: keyof SocialSignalRowLike): string {
  const value = row[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    failInput(`social_signals row is missing required string field "${String(key)}".`);
  }
  return value as string;
}

function toIsoString(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      failInput("social_signals row carries an invalid Date timestamp.");
    }
    return value.toISOString();
  }
  if (typeof value === "string") {
    if (Number.isNaN(Date.parse(value))) {
      failInput(`social_signals row carries an invalid timestamp string "${value}".`);
    }
    return value;
  }
  failInput("social_signals row carries an unsupported timestamp value.");
}

/**
 * Adapts a structural R5-A `social_signals` row onto the canonical input
 * shape. Required R5-A keys (identity, enums, evidence hash) fail closed with
 * {@link InterpretationInputError} when missing or null; `Date` timestamps
 * convert to ISO strings.
 */
export function adaptSocialSignal(row: SocialSignalRowLike): CanonicalSocialSignalInput {
  if (!row || typeof row !== "object") {
    failInput("adaptSocialSignal requires a social_signals row-like object.");
  }
  const adapted = {
    signalId: requireRowString(row, "signalKey"),
    signalVersion: (() => {
      const version = row.ingestionVersion;
      if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
        failInput("social_signals row is missing a valid ingestionVersion.");
      }
      return version;
    })(),
    signalType: requireRowString(row, "signalType"),
    provider: requireRowString(row, "provider"),
    platform: requireRowString(row, "platform"),
    attributionType: requireRowString(row, "attributionType"),
    providerEvidenceHash: requireRowString(row, "providerEvidenceHash"),
    actorReference: row.actorReference ?? null,
    actorDisplayName: row.actorDisplayName ?? null,
    contentText: row.contentText ?? null,
    contentReference: row.contentReference ?? null,
    occurredAt: toIsoString(row.occurredAt),
    observedAt: toIsoString(row.observedAt),
    sourceCampaignId: row.sourceCampaignId ?? null,
    parentExternalObjectId: row.parentExternalObjectId ?? null,
  } as unknown as CanonicalSocialSignalInput;
  // Route through the strict schema so every aligned bound (including the
  // closed enums above) is enforced before the value is consumed.
  toCanonicalSignal(adapted);
  return adapted;
}
