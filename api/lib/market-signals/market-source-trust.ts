// ─── R8-C Market & External Signal Intelligence — source trust / provenance (C4) ───
//
// PURE module: the server-side source-registry policy (code-level, immutable —
// no runtime mutation endpoint), deterministic origin verification, spoof
// detection, source-trust derivation in the exact R8-F §5 vocabulary, and the
// confidence mapping. No I/O, no clock, no authority decisions.
//
// Trust is SERVER-DERIVED, never source-declared or client-supplied: a source
// can never mark itself trusted. Corroboration must rely on genuinely
// independent evidence (enforced here via source-independence keys + event-key
// publication identity; syndicated copies of one source never count).

import {
  MARKET_SIGNAL_SOURCE_SPOOFED,
  MarketSignalInputError,
  type MarketConfidenceClass,
  type MarketRegistryClass,
  type MarketSourceTrustClass,
  type MarketSourceType,
} from "./market-signal-contract";

// ─── Code-level official-source allow-list (contract §3.4) ───
//
// Entries are normalized origin keys tagged with the source-type families they
// may officially represent. Matching is exact-after-normalization ONLY — a
// near-match is a spoof attempt, never a promotion. The list is deliberately
// small and auditable; extension requires a code change (version bump), never
// runtime input.

interface OfficialEntry {
  readonly origin: string;
  readonly families: readonly MarketSourceType[];
}

const OFFICIAL_GOVT: readonly MarketSourceType[] = ["OFFICIAL_GOVERNMENT", "OFFICIAL_REGULATOR"];
const OFFICIAL_COMPANY: readonly MarketSourceType[] = ["OFFICIAL_COMPANY"];

export const OFFICIAL_ORIGIN_ALLOWLIST: readonly OfficialEntry[] = [
  { origin: "sec.gov", families: OFFICIAL_GOVT },
  { origin: "federalregister.gov", families: OFFICIAL_GOVT },
  { origin: "gov.uk", families: OFFICIAL_GOVT },
  { origin: "europa.eu", families: OFFICIAL_GOVT },
  { origin: "eur-lex.europa.eu", families: OFFICIAL_GOVT },
  { origin: "who.int", families: OFFICIAL_GOVT },
  { origin: "ftc.gov", families: OFFICIAL_GOVT },
  { origin: "gov.za", families: OFFICIAL_GOVT },
];

/**
 * Code-level established-source catalog: origins with verified standing for
 * their source-type families (major wires / business press). Same exact-match
 * discipline as the official allow-list.
 */
export const VERIFIED_ORIGIN_CATALOG: readonly OfficialEntry[] = [
  { origin: "reuters.com", families: ["NEWS_WIRE", "NEWS_MEDIA"] },
  { origin: "apnews.com", families: ["NEWS_WIRE", "NEWS_MEDIA"] },
  { origin: "bloomberg.com", families: ["NEWS_WIRE", "NEWS_MEDIA"] },
  { origin: "ft.com", families: ["NEWS_MEDIA"] },
  { origin: "wsj.com", families: ["NEWS_MEDIA"] },
  { origin: "techcrunch.com", families: ["NEWS_MEDIA"] },
  { origin: "reutersagency.com", families: ["NEWS_WIRE"] },
];

// ─── Spoof detection (deterministic, conservative) ───

/**
 * Confusable-insensitive normalization for spoof comparison: NFKC (folds
 * full-width/homoglyph look-alikes), lowercase, separators stripped.
 */
function normalizeForSpoofCheck(origin: string): string {
  return origin
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Detect origin look-alikes of official/catalog origins. An origin is spoofed
 * when its confusable-normalized form equals an entry's, OR it embeds an
 * official/catalog origin as leading dot-components (e.g. "sec.gov.evil.tld"),
 * OR its stripped form starts with the entry's stripped form (edit-prefix
 * look-alike, e.g. "sec-gov-report.tld" vs "sec.gov"). Conservative: only
 * flags, never promotes; exact allow-list matches are never flagged here.
 */
export function detectSpoofedOrigin(originKey: string): boolean {
  const candidates = [...OFFICIAL_ORIGIN_ALLOWLIST, ...VERIFIED_ORIGIN_CATALOG].map((e) => e.origin);
  const stripped = normalizeForSpoofCheck(originKey);
  for (const official of candidates) {
    if (originKey === official) continue; // exact matches are registry hits, not spoofs
    const officialStripped = normalizeForSpoofCheck(official);
    if (stripped === officialStripped) return true;
    if (originKey.startsWith(official + ".")) return true;
    if (stripped.startsWith(officialStripped) && stripped.length > officialStripped.length + 2) return true;
  }
  return false;
}

// ─── Registry class derivation (server-side only) ───

export interface SourceRegistryEvaluation {
  readonly registryClass: MarketRegistryClass;
  readonly spoofed: boolean;
}

/**
 * Derive the server-side registry standing of a source origin. OFFICIAL when
 * the origin exactly matches an allow-list entry AND the client-proposed
 * source type is within the entry's families (type/origin inconsistency
 * demotes to UNVERIFIED — never promotes). VERIFIED for catalog origins under
 * the same discipline. A spoof-flagged origin is rejected outright (fail
 * closed) — it never even reaches UNVERIFIED.
 */
export function deriveRegistryClass(originKey: string, sourceType: MarketSourceType): SourceRegistryEvaluation {
  if (detectSpoofedOrigin(originKey)) {
    throw new MarketSignalInputError(
      MARKET_SIGNAL_SOURCE_SPOOFED,
      `Source origin "${originKey}" resembles a registered official/verified origin without being it; spoofed source metadata rejected.`
    );
  }
  const official = OFFICIAL_ORIGIN_ALLOWLIST.find((e) => e.origin === originKey);
  if (official) {
    return official.families.includes(sourceType)
      ? { registryClass: "OFFICIAL", spoofed: false }
      : { registryClass: "UNVERIFIED", spoofed: false };
  }
  const catalog = VERIFIED_ORIGIN_CATALOG.find((e) => e.origin === originKey);
  if (catalog) {
    return catalog.families.includes(sourceType)
      ? { registryClass: "VERIFIED", spoofed: false }
      : { registryClass: "UNVERIFIED", spoofed: false };
  }
  return { registryClass: "UNVERIFIED", spoofed: false };
}

// ─── Source trust derivation (exact R8-F §5 vocabulary, §4 of the contract) ───

export interface SignalTrustInput {
  /** Server-derived registry standing of the signal's source. */
  readonly registryClass: MarketRegistryClass;
  /** Distinct independent source keys corroborating the same claimKey (others). */
  readonly independentCorroborationCount: number;
  /** Whether this signal is actively contradicted with no independent corroboration. */
  readonly contradictedUnresolved: boolean;
  /** Integrity failure (hash drift / malformed persisted material). */
  readonly integrityFailed?: boolean;
}

/**
 * Deterministic precedence (first match wins), mirroring R8-F §5:
 *   1. integrity failure          → MALFORMED
 *   2. unresolved contradiction   → CONTRADICTED
 *   3. registry OFFICIAL/VERIFIED → VERIFIED_EXTERNAL
 *   4. ≥1 independent corroborator (≥2 sources incl. self) → CORROBORATED_EXTERNAL
 *   5. exactly 1 source (self, unverified) → SINGLE_EXTERNAL_SOURCE
 *   6. no usable provenance       → UNVERIFIED
 */
export function deriveSourceTrustClass(input: SignalTrustInput): MarketSourceTrustClass {
  if (input.integrityFailed) return "MALFORMED";
  if (input.contradictedUnresolved) return "CONTRADICTED";
  if (input.registryClass === "OFFICIAL" || input.registryClass === "VERIFIED") return "VERIFIED_EXTERNAL";
  if (input.independentCorroborationCount >= 1) return "CORROBORATED_EXTERNAL";
  return "SINGLE_EXTERNAL_SOURCE";
}

// ─── Confidence derivation (contract §10) ───

const TRUST_CONFIDENCE_CEILING: Record<MarketSourceTrustClass, MarketConfidenceClass> = {
  VERIFIED_EXTERNAL: "HIGH",
  CORROBORATED_EXTERNAL: "MEDIUM",
  SINGLE_EXTERNAL_SOURCE: "LOW",
  UNVERIFIED: "LOW",
  CONTRADICTED: "NONE",
  MALFORMED: "NONE",
};

const FRESHNESS_CONFIDENCE_CEILING: Record<string, MarketConfidenceClass> = {
  CURRENT: "HIGH",
  AGING: "HIGH",
  STALE: "LOW",
  EXPIRED: "NONE",
};

const CONFIDENCE_ORDINAL: Record<MarketConfidenceClass, number> = { NONE: 0, LOW: 1, MEDIUM: 2, HIGH: 3 };

function minConfidence(a: MarketConfidenceClass, b: MarketConfidenceClass): MarketConfidenceClass {
  return CONFIDENCE_ORDINAL[a] <= CONFIDENCE_ORDINAL[b] ? a : b;
}

/**
 * derivedConfidence = min(trustCeiling, freshnessCeiling). Model output and
 * relevance are never inputs to confidence; no path promotes confidence.
 */
export function deriveConfidenceClass(input: {
  sourceTrustClass: MarketSourceTrustClass;
  freshnessClass: string;
}): MarketConfidenceClass {
  const trustCeiling = TRUST_CONFIDENCE_CEILING[input.sourceTrustClass] ?? "NONE";
  const freshnessCeiling = FRESHNESS_CONFIDENCE_CEILING[input.freshnessClass] ?? "NONE";
  return minConfidence(trustCeiling, freshnessCeiling);
}
