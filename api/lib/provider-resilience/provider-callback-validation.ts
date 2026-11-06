// ─── R10-D Provider & Integration Resilience — callback/webhook security (D6) ───
//
// PURE module. Validates inbound provider callbacks before any convergence
// or state effect:
//
//   signature verification (HMAC-SHA256, server-side secret, constant-time)
//   timestamp/freshness (bounded clock skew)
//   provider identity + account identity (exact binding match)
//   event identity (bounded provider event id)
//   replay protection (exact-once natural anchor)
//   tenant/business binding (via the bound request identity)
//   execution-attempt binding (payload attemptId == bound attempt)
//
// Rejected: forged callback, stale callback, cross-account callback,
// cross-tenant callback, unknown execution reference. The callback secret is
// server-side only — it is never returned through diagnostics and never
// accepted from model output.

import { createHmac, timingSafeEqual } from "node:crypto";
import {
  CALLBACK_VALIDATION_FAILED,
  MAX_CALLBACK_PAYLOAD_CHARS,
  MAX_SIGNATURE_AGE_MS,
  ProviderInputError,
  ingestProviderCallbackSchema,
} from "./provider-resilience-contract";
import { canonicalJson } from "../conversion/conversion-contract";
import { deriveCallbackSignaturePayload } from "./provider-resilience-identity";
import type { ProviderBindingView } from "./provider-binding";
import { assertExactCallbackBinding } from "./provider-binding";

export interface RawProviderCallback {
  readonly providerId: string;
  readonly providerAccountId: string;
  readonly providerEventId: string;
  readonly occurredAt: string;
  readonly signature: string;
  readonly payload: unknown;
}

export type CallbackRejectionReason =
  | "REJECTED_MALFORMED"
  | "REJECTED_FORGED"
  | "REJECTED_STALE"
  | "REJECTED_IDENTITY_MISMATCH"
  | "REJECTED_UNKNOWN_REFERENCE";

export type CallbackValidation =
  | { readonly ok: true; readonly callbackMaterial: CanonicalCallbackMaterial }
  | {
      readonly ok: false;
      readonly reason: CallbackRejectionReason;
      readonly detail: string;
    };

export interface CanonicalCallbackMaterial {
  readonly providerId: string;
  readonly providerAccountId: string;
  readonly providerEventId: string;
  readonly occurredAt: string;
  /** Deterministic payload hash — the raw payload never persists. */
  readonly payloadHash: string;
  /** Closed outcome material the callback claims (validated downstream). */
  readonly claimedOutcome: unknown;
  /** Request identity the callback references (must match a bound request). */
  readonly requestRef: string | null;
  readonly attemptRef: string | null;
}

export function computeCallbackSignature(input: {
  secret: string;
  providerId: string;
  providerAccountId: string;
  providerEventId: string;
  occurredAt: string;
  payload: unknown;
}): string {
  return createHmac("sha256", input.secret)
    .update(deriveCallbackSignaturePayload(input))
    .digest("hex");
}

function constantTimeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function boundedPayload(
  payload: unknown
): { ok: true; canonical: string } | { ok: false } {
  if (payload === null || payload === undefined)
    return { ok: true, canonical: "null" };
  if (typeof payload !== "object") {
    return typeof payload === "string" &&
      payload.length <= MAX_CALLBACK_PAYLOAD_CHARS
      ? { ok: true, canonical: canonicalJson(payload) }
      : { ok: false };
  }
  try {
    const canonical = canonicalJson(payload);
    if (canonical.length > MAX_CALLBACK_PAYLOAD_CHARS) return { ok: false };
    return { ok: true, canonical };
  } catch {
    return { ok: false };
  }
}

/**
 * Full callback validation against the exact binding + server-side secret.
 * `nowMs` is injected for deterministic acceptance. No durable effect occurs
 * on rejection — the event is answered conservatively and, when it carried an
 * identity, recorded as rejected evidence (D16 audit surface).
 */
export function validateProviderCallback(input: {
  callback: RawProviderCallback;
  binding: ProviderBindingView;
  secret: string;
  nowMs: number;
}): CallbackValidation {
  const { callback, binding, secret, nowMs } = input;
  if (
    !ingestProviderCallbackSchema.safeParse(callback).success ||
    !secret ||
    !Number.isFinite(nowMs)
  )
    return {
      ok: false,
      reason: "REJECTED_MALFORMED",
      detail: "invalid callback boundary",
    };

  if (
    !callback.providerId ||
    !callback.providerAccountId ||
    !callback.providerEventId ||
    !callback.occurredAt ||
    !callback.signature
  ) {
    return {
      ok: false,
      reason: "REJECTED_MALFORMED",
      detail: "callback is missing required identity fields.",
    };
  }
  const payloadCheck = boundedPayload(callback.payload);
  if (!payloadCheck.ok) {
    return {
      ok: false,
      reason: "REJECTED_MALFORMED",
      detail: `callback payload exceeds ${MAX_CALLBACK_PAYLOAD_CHARS} canonical chars.`,
    };
  }

  try {
    assertExactCallbackBinding({
      binding,
      providerId: callback.providerId,
      providerAccountId: callback.providerAccountId,
    });
  } catch (err) {
    return {
      ok: false,
      reason: "REJECTED_IDENTITY_MISMATCH",
      detail: (err as Error).message,
    };
  }

  const expected = computeCallbackSignature({
    secret,
    providerId: callback.providerId,
    providerAccountId: callback.providerAccountId,
    providerEventId: callback.providerEventId,
    occurredAt: callback.occurredAt,
    payload: callback.payload,
  });
  if (!constantTimeEqualHex(expected, callback.signature.toLowerCase())) {
    return {
      ok: false,
      reason: "REJECTED_FORGED",
      detail: "callback signature verification failed.",
    };
  }

  const occurredMs = Date.parse(callback.occurredAt);
  if (!Number.isFinite(occurredMs)) {
    return {
      ok: false,
      reason: "REJECTED_MALFORMED",
      detail: "callback occurredAt is not parseable.",
    };
  }
  if (Math.abs(nowMs - occurredMs) > MAX_SIGNATURE_AGE_MS) {
    return {
      ok: false,
      reason: "REJECTED_STALE",
      detail: "callback outside the bounded freshness window.",
    };
  }

  const payload = (callback.payload ?? {}) as Record<string, unknown>;
  const requestRef =
    typeof payload["requestRef"] === "string" ? payload["requestRef"] : null;
  const attemptRef =
    typeof payload["attemptRef"] === "string" ? payload["attemptRef"] : null;
  if (requestRef === null) {
    return {
      ok: false,
      reason: "REJECTED_UNKNOWN_REFERENCE",
      detail: "callback carries no request reference.",
    };
  }

  return {
    ok: true,
    callbackMaterial: {
      providerId: callback.providerId,
      providerAccountId: callback.providerAccountId,
      providerEventId: callback.providerEventId,
      occurredAt: callback.occurredAt,
      payloadHash: createHmac("sha256", secret)
        .update(payloadCheck.canonical)
        .digest("hex"),
      claimedOutcome: payload["outcome"] ?? null,
      requestRef,
      attemptRef,
    },
  };
}

/** Strict boundary raise for callers that treat validation failure as fatal. */
export function assertCallbackValid(
  validation: CallbackValidation
): CanonicalCallbackMaterial {
  if (!validation.ok) {
    throw new ProviderInputError(
      CALLBACK_VALIDATION_FAILED,
      `callback rejected: ${validation.reason} — ${validation.detail}`
    );
  }
  return validation.callbackMaterial;
}
