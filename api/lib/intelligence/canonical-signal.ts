// ─── R5-B Intent & Sentiment Intelligence — canonical social signal boundary ───
//
// PURE adapter module: strict input schema + normalization for the canonical
// social signal consumed by the interpretation authority
// (docs/contracts/social-intelligence-contract.md §3). It is the isolated
// boundary until R5-A publishes its social-listening contract, modelled on the
// social_engagement_events authority. No I/O, no clock, no logging; invalid
// input fails closed with a typed error before any rule or model processing
// (no record, no billing).

import { z } from "zod";
import { InterpretationInputError } from "./interpretation-contract";

export const CANONICAL_SIGNAL_CONTRACT_VERSION = "canonical-social-signal/v1" as const;

export const SIGNAL_TYPE_VALUES = [
  "comment",
  "message",
  "mention",
  "reaction",
  "share",
  "dm",
  "post_interaction",
  "unknown",
] as const;

export const PLATFORM_VALUES = [
  "facebook",
  "instagram",
  "linkedin",
  "tiktok",
  "twitter",
  "other",
] as const;

/** Signal types whose payload can carry interpretable free text (§7). */
export const TEXT_BEARING_SIGNAL_TYPES: readonly CanonicalSignalType[] = [
  "comment",
  "message",
  "mention",
  "dm",
];

export type CanonicalSignalType = (typeof SIGNAL_TYPE_VALUES)[number];
export type CanonicalPlatform = (typeof PLATFORM_VALUES)[number];

const SIGNAL_TYPE_SET: ReadonlySet<string> = new Set(SIGNAL_TYPE_VALUES);

export const SignalTypeEnum = z.enum(SIGNAL_TYPE_VALUES);
export const PlatformEnum = z.enum(PLATFORM_VALUES);

// ─── Bounded provider metadata (§3): plain JSON, shallow arrays only ───

const MetadataPrimitiveSchema = z.union([
  z.string().max(256),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

const MetadataValueSchema = z.union([
  MetadataPrimitiveSchema,
  z.array(MetadataPrimitiveSchema).max(8),
]);

const MAX_METADATA_KEYS = 16;
const MAX_METADATA_SERIALIZED_CHARS = 2000;

const SignalMetadataSchema = z.record(z.string(), MetadataValueSchema);

// ─── Strict input schema (adapter boundary) ───

export const CanonicalSocialSignalInputSchema = z.strictObject({
  signalId: z.string().min(1).max(128),
  signalVersion: z.number().int().min(1),
  signalType: SignalTypeEnum,
  platform: PlatformEnum,
  /** Display only; never an authority. Optional → null. */
  actorHandle: z.string().min(1).max(128).nullable().optional(),
  /** Untrusted social text; bounded later by input-safety. Null when absent. */
  text: z.string().nullable().optional(),
  /** Provider event time, ISO 8601; display only. */
  occurredAt: z
    .string()
    .min(1)
    .refine((value) => !Number.isNaN(Date.parse(value)), {
      message: "occurredAt must be a parseable ISO 8601 timestamp",
    })
    .nullable()
    .optional(),
  /** Bounded provider metadata only; plain JSON, no nested objects. */
  metadata: SignalMetadataSchema.optional(),
});

export type CanonicalSocialSignalInput = z.infer<typeof CanonicalSocialSignalInputSchema>;

/** Canonical, normalized, deeply-frozen social signal consumed by R5-B. */
export interface CanonicalSocialSignal {
  readonly signalContractVersion: typeof CANONICAL_SIGNAL_CONTRACT_VERSION;
  readonly signalId: string;
  readonly signalVersion: number;
  readonly signalType: CanonicalSignalType;
  readonly platform: CanonicalPlatform;
  readonly actorHandle: string | null;
  readonly text: string | null;
  readonly occurredAt: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
}

/** Canonical signal after input-safety: text is always a (possibly empty) string. */
export type SanitizedSocialSignal = Omit<CanonicalSocialSignal, "text"> & {
  readonly text: string;
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
 * deviation, on metadata exceeding its bounds (≤16 keys, ≤2000 serialized
 * chars), or on a signalType outside the closed enum (before any processing).
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
      `signalType "${String((input as Record<string, unknown>).signalType)}" is outside the closed canonical signal vocabulary.`
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
  const metadata = parsed.metadata ?? {};
  const keys = Object.keys(metadata);
  if (keys.length > MAX_METADATA_KEYS) {
    failInput(`Signal metadata exceeds the ${MAX_METADATA_KEYS}-key bound (got ${keys.length}).`);
  }
  const serialized = JSON.stringify(metadata);
  if (serialized.length > MAX_METADATA_SERIALIZED_CHARS) {
    failInput(
      `Signal metadata exceeds the ${MAX_METADATA_SERIALIZED_CHARS}-character serialized bound (got ${serialized.length}).`
    );
  }

  const signal: CanonicalSocialSignal = {
    signalContractVersion: CANONICAL_SIGNAL_CONTRACT_VERSION,
    signalId: parsed.signalId.trim(),
    signalVersion: parsed.signalVersion,
    signalType: parsed.signalType,
    platform: parsed.platform,
    actorHandle: parsed.actorHandle == null ? null : parsed.actorHandle.trim(),
    text: parsed.text === undefined ? null : parsed.text,
    occurredAt: parsed.occurredAt === undefined ? null : parsed.occurredAt,
    metadata,
  };
  return deepFreeze(signal);
}
