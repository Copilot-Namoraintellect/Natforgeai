// ─── Shared sanitized image-render claim error contract (B2B-4) ───
//
// Public, machine-readable outcome codes for the premium image-render claim
// path. These codes are safe to expose to clients: they carry no claim ids,
// owner tokens, attempt keys, fingerprints, deduction keys, active keys,
// generated-image ids, or raw database/provider errors. Servers transport a
// code as the TRPCError.message (standard tRPC codes carry HTTP semantics);
// clients extract codes with the strict predicate below and never parse prose.

export const IMAGE_RENDER_CLAIM_ERROR_CODES = [
  "TOKEN_REQUIRED",
  "INVALID_TOKEN",
  "ALREADY_RUNNING",
  "STALE_BLOCKED",
  "INTENT_CONFLICT",
  "ACTIVE_POST_CONFLICT",
  "AMBIGUOUS_BLOCKED",
  "CLAIM_SUBSYSTEM_UNAVAILABLE",
] as const;

export type ImageRenderClaimErrorCode =
  (typeof IMAGE_RENDER_CLAIM_ERROR_CODES)[number];

const CODE_SET = new Set<string>(IMAGE_RENDER_CLAIM_ERROR_CODES);

/** Strict predicate: only exact shared machine codes are recognized. */
export function isImageRenderClaimErrorCode(
  value: unknown
): value is ImageRenderClaimErrorCode {
  return typeof value === "string" && CODE_SET.has(value);
}
