/**
 * WBS12F3 – Visual-quality release gate rollout mode configuration.
 *
 * Pure configuration parser for the production rollout of the WBS12F visual
 * quality release gate. The gate itself only knows "observe" and "enforce";
 * this module resolves which of those the production seam should run.
 *
 * Mode contract:
 *   - allowed configured values: "observe" | "enforce".
 *   - missing, empty, or whitespace-only configuration → "observe" (shadow),
 *     no warning. Production therefore defaults to observe/shadow behaviour.
 *   - surrounding whitespace is trimmed; the value is case-insensitive
 *     (lower-cased), matching the repository's getQualityAuthorityMode rule.
 *   - invalid configuration → "observe" plus at most one sanitized warning
 *     through the injected warn sink. The warning never contains the raw
 *     value. Invalid config can never escalate production to enforce.
 *   - a throwing warn sink can never change the outcome: the mode is still
 *     "observe" for invalid input and the exception is swallowed.
 *
 * process.env is read only when getConfiguredVisualQualityGateMode is invoked
 * without an explicit rawMode, never at module import time, so tests and the
 * request path stay deterministic.
 */

import type { VisualQualityReleaseGateMode } from "./visual-quality-release-gate";

export const VISUAL_QUALITY_GATE_MODE_ENV_VAR = "VISUAL_QUALITY_GATE_MODE" as const;

const VALID_CONFIGURED_MODES = new Set<string>(["observe", "enforce"]);

const DEFAULT_MODE: VisualQualityReleaseGateMode = "observe";

/**
 * Parse the configured visual-quality gate mode.
 *
 * When rawMode is omitted, process.env.VISUAL_QUALITY_GATE_MODE is read at
 * call time (never at module import). rawMode is injectable so tests and the
 * request owner stay deterministic.
 */
export function getConfiguredVisualQualityGateMode({
  rawMode,
  warn,
}: {
  rawMode?: string | null;
  warn?: (message: string) => void;
} = {}): VisualQualityReleaseGateMode {
  const raw = rawMode !== undefined && rawMode !== null
    ? rawMode
    : process.env[VISUAL_QUALITY_GATE_MODE_ENV_VAR];
  const trimmed = (raw ?? "").trim();

  if (trimmed.length === 0) {
    return DEFAULT_MODE;
  }

  const normalized = trimmed.toLowerCase();
  if (VALID_CONFIGURED_MODES.has(normalized)) {
    return normalized as VisualQualityReleaseGateMode;
  }

  // Fail closed to shadow with a sanitized warning: never include the raw value.
  emitWarn(
    warn,
    'Invalid VISUAL_QUALITY_GATE_MODE. Expected "observe" or "enforce". Defaulting to observe.'
  );
  return DEFAULT_MODE;
}

function emitWarn(warn: ((message: string) => void) | undefined, message: string): void {
  if (!warn) return;
  try {
    warn(message);
  } catch {
    // A failing warn sink must never change the fail-closed-to-observe outcome.
  }
}
