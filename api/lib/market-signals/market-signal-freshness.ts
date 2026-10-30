// ─── R8-C Market & External Signal Intelligence — freshness / temporal lifecycle (C5) ───
//
// PURE module: deterministic freshness semantics over closed per-signal-type
// thresholds (code-level policy — no runtime mutation endpoint). Freshness is
// derived identically at read from (publishedAt ?? observedAt) + policy
// version; stale signals can never silently remain current: the current
// projection recomputes and labels, and EXPIRED evidence is excluded. No I/O,
// no hidden clock (now is injected), no authority.

import {
  MARKET_SIGNAL_FRESHNESS_POLICY_VERSION,
  MarketSignalInputError,
  type MarketFreshnessClass,
  type MarketSignalType,
} from "./market-signal-contract";

const HOUR_MS = 3_600_000;

interface FreshnessThresholds {
  /** ≤ currentHours → CURRENT */
  readonly currentHours: number;
  /** ≤ agingHours → AGING */
  readonly agingHours: number;
  /** ≤ staleHours → STALE; beyond → EXPIRED */
  readonly staleHours: number;
}

/**
 * Code-level freshness policy (contract §8). Fast-moving commercial evidence
 * (pricing, reputation) ages in days; structural evidence (regulation,
 * technology, macro, ecosystem) stays current for months.
 */
export const MARKET_FRESHNESS_POLICY: Readonly<Record<MarketSignalType, FreshnessThresholds>> = {
  PRICING_CHANGE: { currentHours: 72, agingHours: 168, staleHours: 720 },
  REPUTATION_SIGNAL: { currentHours: 72, agingHours: 336, staleHours: 1440 },
  COMPETITOR_ACTION: { currentHours: 168, agingHours: 720, staleHours: 2160 },
  PRODUCT_LAUNCH: { currentHours: 336, agingHours: 1440, staleHours: 4320 },
  MARKET_DEMAND: { currentHours: 336, agingHours: 1440, staleHours: 4320 },
  CHANNEL_PLATFORM_CHANGE: { currentHours: 336, agingHours: 2160, staleHours: 8760 },
  REGULATORY_CHANGE: { currentHours: 720, agingHours: 4320, staleHours: 17520 },
  TECHNOLOGY_CHANGE: { currentHours: 720, agingHours: 4320, staleHours: 17520 },
  MACRO_ENVIRONMENT: { currentHours: 720, agingHours: 4320, staleHours: 17520 },
  ECOSYSTEM_CHANGE: { currentHours: 720, agingHours: 4320, staleHours: 17520 },
};

export const MARKET_FRESHNESS_POLICY_VERSION = MARKET_SIGNAL_FRESHNESS_POLICY_VERSION;

/**
 * Derive the deterministic freshness class for one signal. Uses
 * publishedAt ?? observedAt against the per-type thresholds; `now` is
 * injected by the caller (no hidden clock). A future-dated reference time is
 * bounded by the house ±5 minute clock-skew rule; beyond that it is malformed
 * temporal evidence and fails closed.
 */
export function deriveFreshnessClass(input: {
  signalType: MarketSignalType;
  publishedAt: string | null;
  observedAt: string;
  now: string;
}): MarketFreshnessClass {
  const thresholds = MARKET_FRESHNESS_POLICY[input.signalType];
  if (!thresholds) {
    throw new MarketSignalInputError(
      "MARKET_SIGNAL_INPUT_INVALID",
      `No freshness policy for signal type ${input.signalType}.`
    );
  }
  const referenceIso = input.publishedAt ?? input.observedAt;
  const referenceMs = Date.parse(referenceIso);
  const nowMs = Date.parse(input.now);
  if (Number.isNaN(referenceMs) || Number.isNaN(nowMs)) {
    throw new MarketSignalInputError("MARKET_SIGNAL_INPUT_INVALID", "Freshness inputs must be valid ISO 8601 timestamps.");
  }
  // Bounded clock skew: reference may not run ahead of now by more than 5 min.
  if (referenceMs - nowMs > 5 * 60_000) {
    throw new MarketSignalInputError(
      "MARKET_SIGNAL_INPUT_INVALID",
      "Signal reference time is more than 5 minutes in the future; temporal evidence rejected."
    );
  }
  const ageHours = (nowMs - referenceMs) / HOUR_MS;
  if (ageHours <= thresholds.currentHours) return "CURRENT";
  if (ageHours <= thresholds.agingHours) return "AGING";
  if (ageHours <= thresholds.staleHours) return "STALE";
  return "EXPIRED";
}
