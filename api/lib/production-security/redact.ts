/**
 * R10-F — Cross-surface secret redaction.
 *
 * One deep-redaction primitive shared by every emission surface (structured
 * logs, error responses, webhook/HTTP callbacks, diagnostics bundles). The
 * audit envelope keeps its own constructor-time hygiene
 * (`api/lib/audit/audit-event.ts`) — this module mirrors its key taxonomy so
 * no surface can drift wider than audit.
 *
 * Rules:
 *  - Pure and deterministic; same input ⇒ same output.
 *  - Sensitive KEY names are redacted at every nesting level (value → "***").
 *  - String VALUES are in-place masked for secret shapes (context preserved);
 *    the whole value becomes "***" only when it is itself entirely secret
 *    (e.g. a bare key or DSN).
 *  - Cycle-safe; depth-capped (default 12); non-plain objects are replaced
 *    with a placeholder rather than serialized (no toString side effects).
 *  - Never throws: redaction runs on failure paths where throwing would mask
 *    the original error.
 */

import { maskSecretShapes } from "./secret-shapes";

export const REDACTED = "***";
const MAX_DEPTH = 12;

/**
 * Sensitive key taxonomy — deliberately a superset match of the audit
 * envelope's SENSITIVE_METADATA_KEY plus credential-material keys
 * (private/access keys, client secrets, refresh tokens, webhook secrets).
 * Case-insensitive substring match on the key name.
 */
export const SENSITIVE_KEY_PATTERN =
  /token|password|passwd|authorization|secret|credential|api[-_]?key|session|cookie|private[-_]?key|access[-_]?key|refresh[-_]?token|client[-_]?secret|webhook[-_]?secret/i;

/** URL query-parameter credentials: ?api_key=… &token=… #password=… etc. */
const URL_QUERY_CREDENTIAL =
  /([?&])([a-z0-9[_-]*?(?:api[_-]?key|token|password|passwd|secret|authorization|signature|credential))=([^&\s]+)/gi;
/** Inline assignments in free text: "password=…", "api_key: …", "token = …". */
const INLINE_CREDENTIAL =
  /\b([a-z0-9_.-]{0,32}?(?:password|passwd|secret|token|api[_-]?key|authorization))\s*[:=]\s*([^\s&]+)/gi;
const BEARER_RUN = /(Bearer\s+)[a-zA-Z0-9._-]+/gi;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function maskStringPreservingContext(value: string): string {
  let out = value.replace(URL_QUERY_CREDENTIAL, "$1$2=" + REDACTED);
  out = out.replace(INLINE_CREDENTIAL, "$1=" + REDACTED);
  out = out.replace(BEARER_RUN, "$1" + REDACTED);
  out = maskSecretShapes(out, REDACTED);
  return out;
}

function isEntirelySecret(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  const masked = maskStringPreservingContext(trimmed);
  // Entirely secret = masking consumed everything but the mask itself and
  // surrounding whitespace/punctuation-free content.
  const residue = masked.replaceAll(REDACTED, "").trim();
  return residue.length === 0;
}

function redactInternal(value: unknown, key: string | null, depth: number, seen: WeakSet<object>): unknown {
  if (depth > MAX_DEPTH) return "[MAX_DEPTH]";
  if (typeof value === "string") {
    const sensitiveKey = key !== null && SENSITIVE_KEY_PATTERN.test(key);
    if (sensitiveKey) {
      // Redact any non-empty string under a sensitive key; keep empty/short
      // markers (e.g. flags) visible but harmless.
      return value.length === 0 ? value : REDACTED;
    }
    const masked = maskStringPreservingContext(value);
    if (masked !== value && isEntirelySecret(value)) return REDACTED;
    return masked;
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) {
    return value;
  }
  if (typeof value === "bigint" || typeof value === "symbol" || typeof value === "function") {
    return `[${typeof value}]`;
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[CIRCULAR]";
    seen.add(value);
    const out = value.map((item) => redactInternal(item, null, depth + 1, seen));
    seen.delete(value);
    return out;
  }
  if (isPlainObject(value)) {
    if (seen.has(value)) return "[CIRCULAR]";
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = redactInternal(v, k, depth + 1, seen);
    }
    seen.delete(value);
    return out;
  }
  return "[UNSERIALIZABLE]";
}

/**
 * Deep-redact an arbitrary JSON-like payload. Key names are preserved
 * (stable fingerprints/dedup downstream); values are masked in place.
 */
export function redactDeep(payload: unknown): unknown {
  return redactInternal(payload, null, 0, new WeakSet());
}

/** Structured-log fields: object map redacted key-by-key. */
export function redactForLog(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = redactInternal(value, key, 0, new WeakSet());
  }
  return out;
}

/**
 * Error surface: message-only, shape-masked. Stacks, causes and custom
 * fields are deliberately dropped — error paths cross trust boundaries and
 * must carry no payload material.
 */
export function redactForError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) {
    return { name: error.name, message: maskStringPreservingContext(error.message) };
  }
  return { name: "Error", message: maskStringPreservingContext(String(error)) };
}

/** Webhook / third-party HTTP callback payloads before logging or echoing. */
export function redactForCallback(payload: unknown): unknown {
  return redactDeep(payload);
}

/** Diagnostics/support bundles: same redaction, depth-capped. */
export function redactForDiagnostics(payload: unknown): unknown {
  return redactDeep(payload);
}
