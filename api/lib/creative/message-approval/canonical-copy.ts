import type {
  CanonicalFooter,
  CanonicalMessagePackCopy,
  CanonicalPlatformCaption,
  ReadonlyDeep,
} from "./contracts";

export interface CanonicalCopyInput {
  readonly copySchemaVersion: string;
  readonly headline: string;
  readonly subheadline: string;
  readonly benefitBulletsOrdered: readonly string[];
  readonly cta: string;
  readonly proofPointsOrdered?: readonly string[];
  readonly platformCaptionsOrdered?:
    | readonly {
        readonly platform: string;
        readonly caption: string;
        readonly cta: string;
        readonly hashtagsOrdered?: readonly string[];
      }[]
    | null;
  readonly footer?: {
    readonly phone?: string | null;
    readonly whatsapp?: string | null;
    readonly email?: string | null;
    readonly website?: string | null;
    readonly location?: string | null;
  } | null;
}

function normalizeScalar(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFC")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
}

function toCanonicalFooter(value: CanonicalCopyInput["footer"]): CanonicalFooter | null {
  if (!value) return null;
  return {
    phone: normalizeScalar(value.phone) || null,
    whatsapp: normalizeScalar(value.whatsapp) || null,
    email: normalizeScalar(value.email) || null,
    website: normalizeScalar(value.website) || null,
    location: normalizeScalar(value.location) || null,
  };
}

function toCanonicalPlatformCaptions(
  value: CanonicalCopyInput["platformCaptionsOrdered"]
): readonly CanonicalPlatformCaption[] {
  if (!value) return Object.freeze([]);
  return Object.freeze(
    value.map((item) =>
      Object.freeze({
        platform: normalizeScalar(item.platform),
        caption: normalizeScalar(item.caption),
        cta: normalizeScalar(item.cta),
        hashtagsOrdered: Object.freeze((item.hashtagsOrdered || []).map((tag) => normalizeScalar(tag))),
      })
    )
  );
}

function deepFreeze<T>(value: T): ReadonlyDeep<T> {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child as T);
    }
  }
  return value as ReadonlyDeep<T>;
}

export function canonicalizeMessagePackCopy(input: CanonicalCopyInput): CanonicalMessagePackCopy {
  const canonical: CanonicalMessagePackCopy = {
    copySchemaVersion: normalizeScalar(input.copySchemaVersion),
    headline: normalizeScalar(input.headline),
    subheadline: normalizeScalar(input.subheadline),
    benefitBulletsOrdered: Object.freeze(
      input.benefitBulletsOrdered.map((item) => normalizeScalar(item))
    ),
    cta: normalizeScalar(input.cta),
    footer: toCanonicalFooter(input.footer),
    proofPointsOrdered: Object.freeze((input.proofPointsOrdered || []).map((item) => normalizeScalar(item))),
    platformCaptionsOrdered: toCanonicalPlatformCaptions(input.platformCaptionsOrdered),
  };

  return deepFreeze(canonical) as CanonicalMessagePackCopy;
}
