// ─── R8-C Market & External Signal Intelligence — identity & provenance (C2) ───
//
// PURE module: deterministic source/signal/claim identity, safe normalized
// source references, origin keys, spoof detection and the immutable-core
// evidence hash. No I/O, no clock, no authority. Identity binds normalized
// coordinates only — a client (or a compromised research agent) can never
// fabricate provenance: same coordinates ⇒ same identity; different material
// under one identity ⇒ conflicting replay (fail closed, enforced by the store).

import {
  MarketSignalInputError,
  SAFE_REFERENCE_PATTERN,
  canonicalJson,
  sha256Hex,
  type MarketSignalIngestInput,
  type MarketSignalSourceInput,
} from "./market-signal-contract";

export const SOURCE_ID_PREFIX = "src1:" as const;
export const SIGNAL_ID_PREFIX = "xsig1:" as const;
export const LIFECYCLE_EVENT_ID_PREFIX = "xsf1:" as const;

export const MAX_NORMALIZED_TEXT_CHARS = 2048;

// ─── Source URI normalization ───
//
// The client supplies a raw absolute http(s) URI. The server normalizes
// deterministically (lowercase scheme/host, default ports stripped, userinfo /
// query / fragment removed, path preserved as evidence, length-capped). The
// origin key is the lowercase host without a leading "www.". Anything that
// cannot be normalized to a safe http(s) reference is malformed and fails
// closed — never persisted.

export interface NormalizedSourceReference {
  /** Safe normalized reference: scheme + host + path only. */
  readonly sourceUriRef: string;
  /** Normalized publisher/origin key (lowercase host, no leading www.). */
  readonly originKey: string;
}

function failMalformed(message: string): never {
  throw new MarketSignalInputError("MARKET_SIGNAL_SOURCE_MALFORMED", message);
}

const CONTROL_OR_SPACE = /[\x00-\x20\x7f]/;

/**
 * Normalize one client-supplied source URI. Rejects non-http(s) schemes,
 * embedded credentials, IP-literal hosts (official-source impersonation
 * vector), non-printable residue and oversized parts. Deterministic: the same
 * raw input always yields the same normalized reference and origin key.
 */
export function normalizeSourceUri(raw: string): NormalizedSourceReference {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 600) {
    failMalformed(`sourceUriRef must be a string of 1..600 characters; got ${JSON.stringify(raw)?.slice(0, 64)}.`);
  }
  if (CONTROL_OR_SPACE.test(raw)) {
    failMalformed("sourceUriRef contains control/whitespace characters; rejected as malformed.");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    failMalformed(`sourceUriRef is not a parseable absolute URI: ${JSON.stringify(raw.slice(0, 96))}.`);
  }
  const scheme = url.protocol.toLowerCase();
  if (scheme !== "https:" && scheme !== "http:") {
    failMalformed(`sourceUriRef scheme "${scheme}" is not allowed; only http(s) sources are accepted.`);
  }
  if (url.username !== "" || url.password !== "") {
    failMalformed("sourceUriRef embeds credentials; credential-bearing source references are rejected.");
  }
  let host = url.hostname.toLowerCase();
  if (host.length === 0 || host.length > 190) {
    failMalformed("sourceUriRef host is empty or oversized.");
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":")) {
    failMalformed("IP-literal hosts are not accepted as external evidence sources.");
  }
  // Strip default ports; keep explicit non-default ports in the origin key.
  const explicitPort = url.port;
  const portSuffix = explicitPort !== "" && explicitPort !== "80" && explicitPort !== "443" ? `:${explicitPort}` : "";
  if (host.startsWith("www.")) host = host.slice(4);
  if (!/^[a-z0-9.-]+$/.test(host) || host.startsWith(".") || host.endsWith(".") || !host.includes(".")) {
    failMalformed(`sourceUriRef host "${host}" is not a well-formed registrable origin.`);
  }
  const originKey = `${host}${portSuffix}`;
  const path = url.pathname.replace(/\/+$/, "");
  const sourceUriRef = `${scheme}//${host}${portSuffix}${path}`;
  if (sourceUriRef.length > 191) {
    failMalformed(`normalized sourceUriRef exceeds 191 characters; rejected as malformed.`);
  }
  return { sourceUriRef, originKey };
}

/**
 * Normalize an optional client origin hint into an origin key candidate. The
 * hint may be a bare host or an http(s) URI; anything else is malformed.
 * The hint can only *corroborate* the URI-derived origin — it can never
 * override it (spoof guard in market-source-trust).
 */
export function normalizeOriginHint(hint: string | undefined, uriOriginKey: string): string {
  if (hint === undefined) return uriOriginKey;
  const trimmed = hint.trim().toLowerCase();
  if (trimmed === "") return uriOriginKey;
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    const normalized = normalizeSourceUri(trimmed);
    return normalized.originKey;
  }
  const cleaned = trimmed.replace(/^www\./, "").replace(/\/+$/, "");
  if (!/^[a-z0-9.-]+$/.test(cleaned) || !cleaned.includes(".")) {
    failMalformed(`originHint "${hint}" is not a well-formed origin.`);
  }
  return cleaned;
}

// ─── Deterministic identities ───

/** One origin per tenant ⇒ one durable source row (exact-once anchor). */
export function deriveSourceId(tenantUserId: number, originKey: string): string {
  return SOURCE_ID_PREFIX + sha256Hex(canonicalJson({ v: 1, tenantUserId, originKey }));
}

/** One business + source + event ⇒ one durable signal row. */
export function deriveSignalId(input: {
  tenantUserId: number;
  businessId: number;
  sourceId: string;
  eventKey: string;
}): string {
  return (
    SIGNAL_ID_PREFIX +
    sha256Hex(canonicalJson({ v: 1, tenantUserId: input.tenantUserId, businessId: input.businessId, sourceId: input.sourceId, eventKey: input.eventKey }))
  );
}

function normalizeRefText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Claim family: what is being claimed, independent of the specific claim. */
export function deriveClaimFamilyKey(input: {
  signalType: string;
  subjectType: string;
  subjectRef: string;
  claimAspect: string;
}): string {
  if (!SAFE_REFERENCE_PATTERN.test(input.subjectRef) || !SAFE_REFERENCE_PATTERN.test(input.claimAspect)) {
    throw new MarketSignalInputError("MARKET_SIGNAL_INPUT_INVALID", "subjectRef/claimAspect have invalid shape.");
  }
  return sha256Hex(
    canonicalJson({
      v: 1,
      signalType: input.signalType,
      subjectType: input.subjectType,
      subjectRef: normalizeRefText(input.subjectRef),
      claimAspect: normalizeRefText(input.claimAspect),
    })
  );
}

/** Claim fingerprint: the family + the exact normalized claim text. */
export function deriveClaimKey(claimFamilyKey: string, claimText: string): string {
  return sha256Hex(canonicalJson({ v: 1, claimFamilyKey, claimText: normalizeRefText(claimText) }));
}

// ─── Immutable core ───
//
// evidenceHash binds the material the reporter supplied and the server
// normalized; derived classes (trust/relevance/freshness/corroboration) and
// lineage-derived id lists are deliberately excluded — they are recomputed,
// never authoritative. Drift on read is tampering (MARKET_SIGNAL_EVIDENCE_CONFLICT).

export interface MarketSignalImmutableCore {
  readonly userId: number;
  readonly businessId: number;
  readonly signalType: string;
  readonly subjectType: string;
  readonly subjectRef: string;
  readonly claimAspect: string;
  readonly sourceId: string;
  readonly sourceType: string;
  readonly sourceUriRef: string;
  readonly eventKey: string;
  readonly claimText: string;
  readonly observedAt: string;
  readonly publishedAt: string | null;
  readonly freshnessPolicyVersion: string;
  readonly contradictsSignalIds: readonly string[];
  readonly supersedesSignalId: string | null;
}

export function deriveEvidenceHash(core: MarketSignalImmutableCore): string {
  return sha256Hex(
    canonicalJson({
      v: 1,
      userId: core.userId,
      businessId: core.businessId,
      signalType: core.signalType,
      subjectType: core.subjectType,
      subjectRef: core.subjectRef,
      claimAspect: core.claimAspect,
      sourceId: core.sourceId,
      sourceType: core.sourceType,
      sourceUriRef: core.sourceUriRef,
      eventKey: core.eventKey,
      claimText: core.claimText,
      observedAt: core.observedAt,
      publishedAt: core.publishedAt,
      freshnessPolicyVersion: core.freshnessPolicyVersion,
      contradictsSignalIds: [...core.contradictsSignalIds].sort(),
      supersedesSignalId: core.supersedesSignalId,
    })
  );
}

/** Deterministic lifecycle fact identity (xsf1:). */
export function deriveLifecycleEventId(input: {
  signalId: string;
  lifecycleType: string;
  counterpartySignalId: string | null;
  toStatus: string;
  occurredAt: string;
}): string {
  return (
    LIFECYCLE_EVENT_ID_PREFIX +
    sha256Hex(
      canonicalJson({
        v: 1,
        signalId: input.signalId,
        lifecycleType: input.lifecycleType,
        counterpartySignalId: input.counterpartySignalId,
        toStatus: input.toStatus,
        occurredAt: input.occurredAt,
      })
    )
  );
}

/** Source identity for a whole ingest (source row minting). */
export function resolveSourceIdentity(
  tenantUserId: number,
  source: Pick<MarketSignalSourceInput, "sourceUriRef" | "originHint">
): { sourceId: string } & NormalizedSourceReference {
  const normalized = normalizeSourceUri(source.sourceUriRef);
  const originKey = normalizeOriginHint(source.originHint, normalized.originKey);
  return { sourceId: deriveSourceId(tenantUserId, originKey), ...normalized };
}

/** Normalized inert claim text (NFC, control/format chars stripped, capped). */
export function normalizeClaimText(raw: string): string {
  if (typeof raw !== "string") {
    throw new MarketSignalInputError("MARKET_SIGNAL_INPUT_INVALID", "claimText must be a string.");
  }
  // Reject malformed unicode (lone surrogates) before normalization.
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdfff) {
      const paired = code <= 0xdbff && i + 1 < raw.length && raw.charCodeAt(i + 1) >= 0xdc00 && raw.charCodeAt(i + 1) <= 0xdfff;
      if (!paired) {
        throw new MarketSignalInputError("MARKET_SIGNAL_INPUT_INVALID", "claimText contains malformed unicode (lone surrogate).");
      }
      i++;
    }
  }
  const normalized = raw
    .normalize("NFC")
    .replace(/[\x00-\x08\x0B-\x1F\x7F]/g, "")
    .replace(/\p{Cf}/gu, "")
    .trim();
  if (normalized.length === 0) {
    throw new MarketSignalInputError("MARKET_SIGNAL_INPUT_INVALID", "claimText is empty after normalization.");
  }
  if (normalized.length > MAX_NORMALIZED_TEXT_CHARS) {
    throw new MarketSignalInputError(
      "MARKET_SIGNAL_INPUT_INVALID",
      `claimText exceeds the ${MAX_NORMALIZED_TEXT_CHARS}-character post-normalization cap (got ${normalized.length}).`
    );
  }
  return normalized;
}

export type { MarketSignalIngestInput };
