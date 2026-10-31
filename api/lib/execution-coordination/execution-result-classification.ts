// ─── R9-D Execution Coordination — conservative result classification ───
//
// PURE module (contract §7). External results are untrusted: timeout,
// connection loss and ambiguous callbacks are NEVER mapped to success. The
// classified material that enters resultHash is a redacted, bounded shape —
// raw provider payloads never persist and never reach the audit ledger.

import { canonicalJson } from "../conversion/conversion-contract";
import {
  EXECUTION_FAILURE_CLASSES,
  EXECUTION_RESULT_STATUSES,
  ExecutionInputError,
  type ExecutionFailureClass,
  type ExecutionResultStatus,
  type ExecutionUncertaintyClass,
} from "./execution-coordination-contract";
import type { AdapterRawOutcome } from "./execution-adapter-registry";

export interface ClassifiedExecutionResult {
  readonly resultStatus: ExecutionResultStatus;
  readonly failureClass: ExecutionFailureClass;
  readonly uncertaintyClass: ExecutionUncertaintyClass;
  /** Server-issued reference carried by the outcome (validated upstream). */
  readonly externalReference: string | null;
  /** Redacted, bounded classification material (feeds resultHash). */
  readonly classifiedResult: Record<string, unknown>;
}

function isMember<T extends string>(set: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (set as readonly string[]).includes(value);
}

function boundedDetail(detail: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!detail || typeof detail !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(detail).slice(0, 16)) {
    if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
      out[key.slice(0, 64)] = value;
    } else {
      out[key.slice(0, 64)] = "[redacted:non-scalar]";
    }
  }
  return out;
}

/**
 * Conservative classification of a raw adapter outcome. Only an explicit,
 * unambiguous adapter success classifies SUCCEEDED. Everything ambiguous
 * lands UNCERTAIN / PENDING_EXTERNAL with a closed uncertainty class.
 */
export function classifyAdapterOutcome(
  raw: AdapterRawOutcome,
  issuedReference: string
): ClassifiedExecutionResult {
  if (!raw || typeof raw !== "object" || typeof (raw as { status?: unknown }).status !== "string") {
    return {
      resultStatus: "UNCERTAIN",
      failureClass: "INTERNAL",
      uncertaintyClass: "PROVIDER_STATE_UNKNOWN",
      externalReference: null,
      classifiedResult: { kind: "malformed_outcome" },
    };
  }
  switch (raw.status) {
    case "success": {
      const reference = typeof raw.reference === "string" && raw.reference.length > 0 ? raw.reference : issuedReference;
      return {
        resultStatus: "SUCCEEDED",
        failureClass: "NONE",
        uncertaintyClass: "NONE",
        externalReference: reference,
        classifiedResult: { kind: "success", detail: boundedDetail(raw.detail) },
      };
    }
    case "failure": {
      const failureClass = isMember(EXECUTION_FAILURE_CLASSES, raw.failureClass) &&
        raw.failureClass !== "NONE"
        ? raw.failureClass
        : "PROVIDER_ERROR";
      const retryable = raw.retryable === true;
      return {
        resultStatus: retryable ? "FAILED_RETRYABLE" : "FAILED_FINAL",
        failureClass,
        uncertaintyClass: "NONE",
        externalReference: null,
        classifiedResult: { kind: "failure", failureClass, retryable, detail: boundedDetail(raw.detail) },
      };
    }
    case "timeout":
      return {
        resultStatus: "UNCERTAIN",
        failureClass: "TIMEOUT",
        uncertaintyClass: "TIMEOUT",
        externalReference: null,
        classifiedResult: { kind: "timeout" },
      };
    case "ambiguous":
      return {
        resultStatus: "UNCERTAIN",
        failureClass: "AMBIGUOUS_CALLBACK",
        uncertaintyClass: "CALLBACK_AMBIGUOUS",
        externalReference: null,
        classifiedResult: { kind: "ambiguous", detail: boundedDetail(raw.detail) },
      };
    case "pending_external": {
      const reference = typeof raw.reference === "string" && raw.reference.length > 0 ? raw.reference : issuedReference;
      return {
        resultStatus: "PENDING_EXTERNAL",
        failureClass: "NONE",
        uncertaintyClass: "PARTIAL_CONFIRMATION",
        externalReference: reference,
        classifiedResult: { kind: "pending_external" },
      };
    }
    default:
      return {
        resultStatus: "UNCERTAIN",
        failureClass: "INTERNAL",
        uncertaintyClass: "PROVIDER_STATE_UNKNOWN",
        externalReference: null,
        classifiedResult: { kind: "unknown_status", status: String((raw as { status?: unknown }).status).slice(0, 32) },
      };
  }
}

/**
 * Classification of externally delivered callback material (bounded,
 * untrusted). The callback cannot claim success by fiat: a success claim
 * requires the attempt's issued reference plus an unambiguous payload.
 */
export function classifyCallbackMaterial(input: {
  attemptResultStatus: ExecutionResultStatus | null;
  externalReference: string | null;
  issuedReference: string;
  material: unknown;
}): ClassifiedExecutionResult {
  if (input.attemptResultStatus !== null && input.attemptResultStatus !== "PENDING_EXTERNAL") {
    throw new ExecutionInputError(
      "EXTERNAL_REFERENCE_MISMATCH",
      `attempt already carries a terminal result (${input.attemptResultStatus}); duplicate callback converges.`
    );
  }
  if (input.externalReference !== null && input.externalReference !== input.issuedReference) {
    throw new ExecutionInputError(
      "EXTERNAL_REFERENCE_MISMATCH",
      "callback reference does not match the attempt's server-issued reference."
    );
  }
  const raw = normalizeCallbackMaterial(input.material, input.issuedReference);
  return classifyAdapterOutcome(raw, input.issuedReference);
}

function normalizeCallbackMaterial(material: unknown, issuedReference: string): AdapterRawOutcome {
  if (material && typeof material === "object") {
    const m = material as Record<string, unknown>;
    const status = typeof m["status"] === "string" ? m["status"] : "";
    if (status === "success" || status === "SUCCEEDED") {
      return { status: "success", reference: typeof m["reference"] === "string" ? m["reference"] : issuedReference };
    }
    if (status === "failure" || status === "FAILED") {
      return {
        status: "failure",
        failureClass: typeof m["failureClass"] === "string" ? m["failureClass"] : undefined,
        retryable: m["retryable"] === true,
      };
    }
    if (status === "timeout" || status === "TIMED_OUT") return { status: "timeout" };
    if (status === "ambiguous") return { status: "ambiguous" };
    if (status === "pending_external") return { status: "pending_external", reference: issuedReference };
  }
  // No classifiable material: conservative uncertainty, never success.
  return { status: "ambiguous", detail: { received: canonicalJson(material ?? null).slice(0, 128) } };
}

export function isTerminalResultStatus(status: ExecutionResultStatus | null): boolean {
  return status !== null && (EXECUTION_RESULT_STATUSES as readonly string[]).includes(status);
}
