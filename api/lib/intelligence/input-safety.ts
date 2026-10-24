// ─── R5-B Intent & Sentiment Intelligence — untrusted-input safety (§7) ───
//
// PURE sanitization module for untrusted social text before any rule or model
// processing. Rejects malformed unicode, NFC-normalizes, strips format/control
// characters and enforces the post-normalization character cap, failing closed
// with typed errors (no record, no billing). No logging, no clock, no I/O.

import { InterpretationInputError } from "./interpretation-contract";
import type { CanonicalSocialSignal, SanitizedSocialSignal } from "./canonical-signal";

/** Post-normalization hard cap on social text (contract §7). */
export const MAX_SOCIAL_TEXT_CHARS = 4000;

const C0_CONTROL_EXCEPT_TAB_NEWLINE = /[\x00-\x08\x0B-\x1F]/g;
const UNICODE_FORMAT_CHAR = /\p{Cf}/gu;

function failMalformed(message: string): never {
  throw new InterpretationInputError("MALFORMED_UNICODE", message);
}

function failOversized(length: number): never {
  throw new InterpretationInputError(
    "OVERSIZED_INPUT",
    `Social signal text exceeds the ${MAX_SOCIAL_TEXT_CHARS}-character post-normalization cap (got ${length}).`
  );
}

/**
 * Rejects lone surrogates / malformed unicode sequences. A valid UTF-16 pair
 * (high surrogate followed by low surrogate) is accepted; any unpaired
 * surrogate code unit fails closed.
 */
function assertWellFormedUnicode(raw: string): void {
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code < 0xd800 || code > 0xdfff) continue;
    if (code <= 0xdbff) {
      const next = i + 1 < raw.length ? raw.charCodeAt(i + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) {
        failMalformed(`Lone high-surrogate code unit at index ${i}.`);
      }
      i++; // consume the paired low surrogate
    } else {
      failMalformed(`Lone low-surrogate code unit at index ${i}.`);
    }
  }
}

/**
 * Sanitizes untrusted social text: well-formedness check → NFC normalization →
 * strip Unicode Cf format chars and C0 controls (except tab/newline) → enforce
 * the 4000-char post-normalization cap. An empty result is allowed; the caller
 * decides what an empty string means for its rule class.
 */
export function sanitizeSocialText(raw: string): string {
  if (typeof raw !== "string") {
    throw new InterpretationInputError(
      "MALFORMED_UNICODE",
      `Social signal text must be a string, got ${typeof raw}.`
    );
  }
  assertWellFormedUnicode(raw);
  const normalized = raw.normalize("NFC");
  const stripped = normalized
    .replace(UNICODE_FORMAT_CHAR, "")
    .replace(C0_CONTROL_EXCEPT_TAB_NEWLINE, "");
  if (stripped.length > MAX_SOCIAL_TEXT_CHARS) {
    failOversized(stripped.length);
  }
  return stripped;
}

/**
 * Applies {@link sanitizeSocialText} to a canonical signal when text is
 * present; null text becomes the empty string (the rules engine owns the
 * empty-text outcome, never the model). All other canonical fields pass
 * through untouched.
 */
export function sanitizeSignalText(signal: CanonicalSocialSignal): SanitizedSocialSignal {
  const contentText =
    signal.contentText === null ? "" : sanitizeSocialText(signal.contentText);
  return Object.freeze({ ...signal, contentText });
}

/**
 * Deterministic trimmed excerpt for evidence fields. Never cuts a surrogate
 * pair; always within maxLen code units of the trimmed source.
 */
export function excerptOf(text: string, maxLen = 160): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLen) return trimmed;
  let cut = maxLen;
  while (cut > 0) {
    const code = trimmed.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdfff) {
      cut--; // keep walking back across surrogate halves
    } else {
      break;
    }
  }
  return trimmed.slice(0, cut).trimEnd();
}
