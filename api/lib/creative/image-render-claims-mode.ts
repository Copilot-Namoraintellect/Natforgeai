// ─── Dormant image-render claims activation mode (B2B-3A) ───
//
// Pure configuration parser and effective-mode resolver for the dormant
// image-render claim system. This module is entirely dormant: nothing in the
// production request path imports or invokes it, it performs no database
// work, imports no claim primitives, constructs no coordinator, calls no
// replay gate, mutates no global state, and caches nothing at import time.
// process.env is read only when getConfiguredImageRenderClaimsMode is invoked
// without an explicit rawMode, never at module import.
//
// Mode contract (narrowest safe design):
//   - allowed configured values: "off" | "on". There is deliberately no
//     "observe" mode: claims mutate rows, so an observe mode would either be
//     unsafe (writes) or meaningless (no-ops).
//   - missing, empty, or whitespace-only configuration → "off", no warning.
//   - surrounding whitespace is trimmed; the value is case-insensitive
//     (lower-cased), matching the repository's getQualityAuthorityMode rule.
//   - invalid configuration → "off" plus at most one sanitized warning through
//     the injected warn sink. The warning never contains the raw value.
//   - a throwing warn sink can never change the outcome: the mode is still
//     "off" for invalid input and the exception is swallowed.
//   - QUALITY_AUTHORITY_MODE has no effect on image-render claims mode.
//
// Effective-mode invariant:
//   configured "on" + readiness { ready: true } → "on";
//   every other combination (configured off, readiness not_ready,
//   unavailable, malformed, or unknown) → "off".

export type ImageRenderClaimsMode = "off" | "on";

export const IMAGE_RENDER_CLAIMS_MODE_ENV_VAR = "IMAGE_RENDER_CLAIMS_MODE" as const;

const VALID_CONFIGURED_MODES = new Set<string>(["off", "on"]);

/**
 * Parse the configured image-render claims mode.
 *
 * When rawMode is omitted, process.env.IMAGE_RENDER_CLAIMS_MODE is read at
 * call time (never at module import). rawMode is injectable so tests and the
 * future request owner stay deterministic.
 */
export function getConfiguredImageRenderClaimsMode({
  rawMode,
  warn,
}: {
  rawMode?: string | null;
  warn?: (message: string) => void;
} = {}): ImageRenderClaimsMode {
  const raw = rawMode !== undefined && rawMode !== null
    ? rawMode
    : process.env[IMAGE_RENDER_CLAIMS_MODE_ENV_VAR];
  const trimmed = (raw ?? "").trim();

  if (trimmed.length === 0) {
    return "off";
  }

  const normalized = trimmed.toLowerCase();
  if (VALID_CONFIGURED_MODES.has(normalized)) {
    return normalized as ImageRenderClaimsMode;
  }

  // Fail closed with a sanitized warning: never include the raw value.
  emitWarn(
    warn,
    'Invalid IMAGE_RENDER_CLAIMS_MODE. Expected "off" or "on". Defaulting to off.'
  );
  return "off";
}

function emitWarn(warn: ((message: string) => void) | undefined, message: string): void {
  if (!warn) return;
  try {
    warn(message);
  } catch {
    // A failing warn sink must never change the fail-closed outcome.
  }
}

/**
 * Resolve the effective mode from the configured mode and a readiness result.
 * Accepts only a literal { ready: true } as sufficient; every other value —
 * not_ready, unavailable, malformed, or unknown shapes — resolves to "off".
 */
export function resolveEffectiveImageRenderClaimsMode({
  configuredMode,
  readiness,
}: {
  configuredMode: ImageRenderClaimsMode;
  readiness: unknown;
}): ImageRenderClaimsMode {
  if (configuredMode !== "on") {
    return "off";
  }
  if (
    readiness !== null &&
    typeof readiness === "object" &&
    (readiness as { ready?: unknown }).ready === true
  ) {
    return "on";
  }
  return "off";
}
