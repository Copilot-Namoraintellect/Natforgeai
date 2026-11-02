// ─── R10-D Provider & Integration Resilience — result classification (D4/D5) ───
//
// PURE module. Normalizes raw provider outcomes CONSERVATIVELY into the
// closed classification set. Transport success (HTTP 200, ack, receipt) is
// never automatically business success: only an explicit, unambiguous
// terminal success payload classifies SUCCEEDED. Timeout, connection reset,
// truncation and ambiguity are never failure-by-fiat and never success —
// they remain UNCERTAIN until reconciliation (D8).
//
//   SUCCEEDED | FAILED_RETRYABLE | FAILED_FINAL | PENDING | UNCERTAIN |
//   RATE_LIMITED | AUTHENTICATION_FAILED

import {
  PROVIDER_FAILURE_CLASSES,
  PROVIDER_RESULT_CLASSIFICATIONS,
  ProviderInputError,
  type ProviderFailureClass,
  type ProviderResultClassification,
} from "./provider-resilience-contract";
import { deriveDispatchEvidenceHash } from "./provider-resilience-identity";

/** Raw provider outcome shapes returned by adapters (pre-classification). */
export type RawProviderOutcome =
  | {
      readonly kind: "explicit_success";
      readonly providerReference?: string;
      readonly detail?: Record<string, unknown>;
    }
  | {
      readonly kind: "explicit_failure";
      readonly retryable?: boolean;
      readonly failureDetail?: string;
      readonly detail?: Record<string, unknown>;
    }
  | {
      readonly kind: "rate_limited";
      readonly retryAfterMs?: number;
      readonly detail?: Record<string, unknown>;
    }
  | {
      readonly kind: "authentication_failed";
      readonly detail?: Record<string, unknown>;
    }
  | { readonly kind: "timeout"; readonly detail?: Record<string, unknown> }
  | {
      readonly kind: "connection_reset";
      readonly detail?: Record<string, unknown>;
    }
  | {
      readonly kind: "truncated_response";
      readonly detail?: Record<string, unknown>;
    }
  | {
      readonly kind: "ambiguous_response";
      readonly detail?: Record<string, unknown>;
    }
  | {
      readonly kind: "accepted_pending";
      readonly providerReference: string;
      readonly detail?: Record<string, unknown>;
    };

export interface ClassifiedProviderResult {
  readonly classification: ProviderResultClassification;
  readonly failureClass: ProviderFailureClass;
  /** Provider-issued reference for pending outcomes; null otherwise. */
  readonly providerReference: string | null;
  /** Provider-supplied retry-after hint (RATE_LIMITED); null otherwise. */
  readonly retryAfterMs: number | null;
  /** True when the outcome leaves the request unresolved (reconcile-able). */
  readonly reconciliationBacklog: boolean;
  /** Fingerprint of the redacted classification material — never raw payloads. */
  readonly evidenceHash: string;
  /** Bounded, redacted material for diagnostics — secrets never included. */
  readonly detail: Record<string, unknown>;
}

function boundedDetail(
  _detail: Record<string, unknown> | undefined
): Record<string, unknown> {
  // Adapter-controlled free text may echo credentials. Diagnostics use closed labels only.
  return {};
}

function isKnownFailureClass(value: unknown): value is ProviderFailureClass {
  return (
    typeof value === "string" &&
    (PROVIDER_FAILURE_CLASSES as readonly string[]).includes(value)
  );
}

function build(
  requestId: string,
  input: {
    classification: ProviderResultClassification;
    failureClass: ProviderFailureClass;
    providerReference: string | null;
    retryAfterMs: number | null;
    reconciliationBacklog: boolean;
    detail: Record<string, unknown>;
  }
): ClassifiedProviderResult {
  return {
    classification: input.classification,
    failureClass: input.failureClass,
    providerReference: input.providerReference,
    retryAfterMs: input.retryAfterMs,
    reconciliationBacklog: input.reconciliationBacklog,
    detail: input.detail,
    evidenceHash: deriveDispatchEvidenceHash({
      requestId,
      classification: input.classification,
      failureClass: input.failureClass,
      providerReference: input.providerReference,
      detail: input.detail,
    }),
  };
}

/**
 * Conservative classification of a raw provider outcome. Malformed/unknown
 * material is UNCERTAIN (never success). Explicit final failure maps
 * FAILED_FINAL; explicit retryable failure maps FAILED_RETRYABLE; explicit
 * rate limit / auth failure are visible as their own classes; transport
 * ambiguity stays UNCERTAIN and enters the reconciliation backlog.
 */
export function classifyProviderOutcome(
  raw: RawProviderOutcome,
  requestId: string
): ClassifiedProviderResult {
  if (
    !raw ||
    typeof raw !== "object" ||
    typeof (raw as { kind?: unknown }).kind !== "string"
  ) {
    return build(requestId, {
      classification: "UNCERTAIN",
      failureClass: "AMBIGUOUS_RESPONSE",
      providerReference: null,
      retryAfterMs: null,
      reconciliationBacklog: true,
      detail: { kind: "malformed_outcome" },
    });
  }
  switch (raw.kind) {
    case "explicit_success": {
      const reference =
        typeof raw.providerReference === "string" &&
        /^[A-Za-z0-9][A-Za-z0-9:_#/.@-]{0,190}$/.test(raw.providerReference)
          ? raw.providerReference
          : null;
      if (reference === null) {
        // A success claim without a provider reference is not verifiable.
        return build(requestId, {
          classification: "UNCERTAIN",
          failureClass: "AMBIGUOUS_RESPONSE",
          providerReference: null,
          retryAfterMs: null,
          reconciliationBacklog: true,
          detail: { kind: "success_without_reference" },
        });
      }
      return build(requestId, {
        classification: "SUCCEEDED",
        failureClass: "NONE",
        providerReference: reference,
        retryAfterMs: null,
        reconciliationBacklog: false,
        detail: boundedDetail(raw.detail),
      });
    }
    case "explicit_failure": {
      const detail = boundedDetail(raw.detail);
      const failureClass: ProviderFailureClass = isKnownFailureClass(
        raw.detail?.["failureClass"]
      )
        ? (raw.detail?.["failureClass"] as ProviderFailureClass)
        : "PROVIDER_REJECTED";
      return build(requestId, {
        classification:
          raw.retryable === true ? "FAILED_RETRYABLE" : "FAILED_FINAL",
        failureClass,
        providerReference: null,
        retryAfterMs: null,
        reconciliationBacklog: false,
        detail,
      });
    }
    case "rate_limited": {
      const retryAfterMs =
        typeof raw.retryAfterMs === "number" &&
        Number.isInteger(raw.retryAfterMs) &&
        raw.retryAfterMs >= 0 &&
        raw.retryAfterMs <= 3_600_000
          ? raw.retryAfterMs
          : null;
      return build(requestId, {
        classification: "RATE_LIMITED",
        failureClass: "RATE_LIMITED",
        providerReference: null,
        retryAfterMs,
        reconciliationBacklog: false,
        detail: boundedDetail(raw.detail),
      });
    }
    case "authentication_failed":
      return build(requestId, {
        classification: "AUTHENTICATION_FAILED",
        failureClass: "AUTHENTICATION",
        providerReference: null,
        retryAfterMs: null,
        reconciliationBacklog: false,
        detail: boundedDetail(raw.detail),
      });
    case "timeout":
      return build(requestId, {
        classification: "UNCERTAIN",
        failureClass: "TIMEOUT",
        providerReference: null,
        retryAfterMs: null,
        reconciliationBacklog: true,
        detail: boundedDetail(raw.detail),
      });
    case "connection_reset":
      return build(requestId, {
        classification: "UNCERTAIN",
        failureClass: "CONNECTION_RESET",
        providerReference: null,
        retryAfterMs: null,
        reconciliationBacklog: true,
        detail: boundedDetail(raw.detail),
      });
    case "truncated_response":
      return build(requestId, {
        classification: "UNCERTAIN",
        failureClass: "TRUNCATED_RESPONSE",
        providerReference: null,
        retryAfterMs: null,
        reconciliationBacklog: true,
        detail: boundedDetail(raw.detail),
      });
    case "ambiguous_response":
      return build(requestId, {
        classification: "UNCERTAIN",
        failureClass: "AMBIGUOUS_RESPONSE",
        providerReference: null,
        retryAfterMs: null,
        reconciliationBacklog: true,
        detail: boundedDetail(raw.detail),
      });
    case "accepted_pending":
      return build(requestId, {
        classification: "PENDING",
        failureClass: "NONE",
        providerReference:
          typeof raw.providerReference === "string" &&
          /^[A-Za-z0-9][A-Za-z0-9:_#/.@-]{0,190}$/.test(raw.providerReference)
            ? raw.providerReference
            : null,
        retryAfterMs: null,
        reconciliationBacklog: true,
        detail: boundedDetail(raw.detail),
      });
    default:
      return build(requestId, {
        classification: "UNCERTAIN",
        failureClass: "INTERNAL",
        providerReference: null,
        retryAfterMs: null,
        reconciliationBacklog: true,
        detail: { kind: "unknown_outcome" },
      });
  }
}

/**
 * Transport-level error normalization (D5): a thrown transport error (DNS
 * failure, socket hang-up, truncation mid-flight, response never completed)
 * is UNCERTAIN — never success, never a provider-confirmed failure. The
 * reconciliation backlog owns the follow-up.
 */
export function classifyTransportError(
  err: unknown,
  requestId: string
): ClassifiedProviderResult {
  const message = err instanceof Error ? err.message : String(err ?? "unknown");
  const code = (err as { code?: unknown })?.code;
  const text = `${String(code ?? "")} ${message}`.toLowerCase();
  let failureClass: ProviderFailureClass = "AMBIGUOUS_RESPONSE";
  if (
    text.includes("timed out") ||
    text.includes("timeout") ||
    text.includes("etimedout")
  ) {
    failureClass = "TIMEOUT";
  } else if (
    text.includes("econnreset") ||
    text.includes("connection reset") ||
    text.includes("socket hang up")
  ) {
    failureClass = "CONNECTION_RESET";
  } else if (
    text.includes("enotfound") ||
    text.includes("eai_again") ||
    text.includes("dns")
  ) {
    failureClass = "CONNECTION_RESET";
  } else if (
    text.includes("truncat") ||
    text.includes("unexpected end") ||
    text.includes("econnaborted")
  ) {
    failureClass = "TRUNCATED_RESPONSE";
  }
  return build(requestId, {
    classification: "UNCERTAIN",
    failureClass,
    providerReference: null,
    retryAfterMs: null,
    reconciliationBacklog: true,
    detail: { kind: "transport_error", transportClass: failureClass },
  });
}

/** Closed check used by the circuit breaker and degraded-mode modules. */
export function isKnownClassification(
  value: unknown
): value is ProviderResultClassification {
  return (
    typeof value === "string" &&
    (PROVIDER_RESULT_CLASSIFICATIONS as readonly string[]).includes(value)
  );
}

export function assertClassificationShape(
  value: unknown
): ProviderResultClassification {
  if (!isKnownClassification(value)) {
    throw new ProviderInputError(
      "PROVIDER_INPUT_MALFORMED",
      "unknown provider result classification."
    );
  }
  return value;
}
