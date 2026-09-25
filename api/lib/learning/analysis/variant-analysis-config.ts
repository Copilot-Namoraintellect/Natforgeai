/**
 * Governed variant analysis configuration — deterministic engine constants.
 *
 * Everything the variant analyzer treats as a threshold, gap or assumption
 * lives here and is pinned to VARIANT_ANALYSIS_VERSION, mirroring the Learning
 * engine convention in ../contracts/learning-config.ts: changing any value
 * here is a new analysis version, and persisted analyses stay bound to the
 * version that produced them.
 *
 * This module does not call providers, read the database, or mutate any
 * engine state.
 */

import {
  CONFIDENCE_IMPRESSIONS,
  CONFIDENCE_MIN_WINDOW_DAYS,
  CONFIDENCE_OBJECTIVE_VOLUME,
  MIN_CLICKS_FOR_CVR,
  MIN_IMPRESSIONS_FOR_CTR,
} from "../contracts/learning-config";

export const VARIANT_ANALYSIS_VERSION = "variant-analysis-v1";

/** A comparative claim requires at least two recorded variants. */
export const MIN_COMPARED_VARIANTS = 2;

/** Minimum attributed observation rows before a variant counts as evidence. */
export const MIN_VARIANT_OBSERVATION_COUNT = 5;

/**
 * Minimum attributed impressions per variant. Reuses the Learning engine's
 * CTR evidence floor: below this, a variant's rates are treated as noise.
 */
export const MIN_VARIANT_IMPRESSIONS = MIN_IMPRESSIONS_FOR_CTR;

/**
 * Minimum attributed clicks per variant. Reuses the Learning engine's CVR
 * evidence floor.
 */
export const MIN_VARIANT_CLICKS = MIN_CLICKS_FOR_CVR;

/**
 * Publication windows whose spans are separated by more than this many days
 * are materially incompatible for comparison (exposure windows do not align).
 */
export const MAX_VARIANT_WINDOW_GAP_DAYS = 14;

/** Confidence scoring — each satisfied condition adds one point. */
export const VARIANT_CONFIDENCE_MIN_OBJECTIVE_VOLUME =
  CONFIDENCE_OBJECTIVE_VOLUME;
export const VARIANT_CONFIDENCE_MIN_IMPRESSIONS = CONFIDENCE_IMPRESSIONS;
export const VARIANT_CONFIDENCE_MIN_WINDOW_DAYS = CONFIDENCE_MIN_WINDOW_DAYS;
