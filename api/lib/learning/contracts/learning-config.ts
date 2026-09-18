/**
 * Learning engine configuration — deterministic engine constants.
 *
 * Everything the Learning engine treats as a threshold, band or assumption
 * lives here and is pinned to LEARNING_EVALUATION_VERSION. Changing any value
 * here is a new evaluation version: persisted learning records stay bound to
 * the version that produced them so idempotency and lineage remain honest.
 *
 * This module does not call providers, read the database, or mutate any
 * engine state.
 */

export const LEARNING_ENGINE_NAME = "learning-engine";

export const LEARNING_EVALUATION_VERSION = "learning-v1";

export const LEARNING_RECORD_STATUSES = ["recorded"] as const;

/** Minimum impressions before a click-through rate is treated as evidence. */
export const MIN_IMPRESSIONS_FOR_CTR = 200;

/** Minimum clicks before a conversion rate is treated as evidence. */
export const MIN_CLICKS_FOR_CVR = 50;

/** Minimum clicks (per scope) before per-platform conversion efficiency counts. */
export const MIN_CLICKS_FOR_PLATFORM_EFFICIENCY = 20;

/** Click-through rate bands: >= met is healthy, >= partial is acceptable. */
export const CTR_BANDS = { met: 0.02, partial: 0.005 } as const;

/** Conversion rate bands on clicks -> conversions. */
export const CVR_BANDS = { met: 0.05, partial: 0.01 } as const;

/** Engagement rate bands on engagements per impression. */
export const ENGAGEMENT_RATE_BANDS = { met: 0.04, partial: 0.01 } as const;

/**
 * Budget-relative objective target assumption. When the campaign objective is
 * conversions or leads and a budget exists, the deterministic volume target is
 * budget / CPA_ASSUMPTION_USD. This is an explicit engine assumption, not a
 * measured fact, and is labelled as such in the KPI assessment.
 */
export const CPA_ASSUMPTION_USD = 50;

/** Momentum rules compare objective volume in the first vs second window half. */
export const MOMENTUM_MIN_BASE_VOLUME = 5;
export const MOMENTUM_UP_RATIO = 1.2;
export const MOMENTUM_DOWN_RATIO = 0.8;

/** Single-platform dependency threshold on objective volume share. */
export const PLATFORM_DEPENDENCY_RATIO = 0.85;
export const PLATFORM_DEPENDENCY_MIN_VOLUME = 20;

/** Confidence scoring — each satisfied condition adds one point. */
export const CONFIDENCE_OBJECTIVE_VOLUME = 30;
export const CONFIDENCE_IMPRESSIONS = 1000;
export const CONFIDENCE_MIN_PLATFORMS = 2;
export const CONFIDENCE_MIN_WINDOW_DAYS = 14;
