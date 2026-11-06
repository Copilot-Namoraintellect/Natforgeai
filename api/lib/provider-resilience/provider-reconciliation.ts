// ─── R10-D Provider & Integration Resilience — reconciliation (D8) ───
//
// PURE module. The reconciliation interface for ambiguous outcomes. An
// ambiguous dispatch (UNCERTAIN) remains so until reconciliation determines,
// WITH EVIDENCE:
//
//   CONFIRMED_SUCCEEDED — provider confirms the business outcome succeeded
//   CONFIRMED_FAILED    — provider confirms the attempt failed
//   STILL_PENDING       — provider still processing; remains pending
//   UNKNOWN             — provider cannot say; remains uncertain
//
// Reconciliation must not fabricate provider evidence: an adapter that
// returns none of the above, or returns material without a verifiable
// evidence hash, folds to UNKNOWN.

import {
  PROVIDER_RECONCILIATION_OUTCOMES,
  ProviderInputError,
  type ProviderReconciliationOutcome,
} from "./provider-resilience-contract";
import { canonicalJson, sha256Hex } from "../conversion/conversion-contract";

/** Adapter-returned reconciliation evidence (bounded, untrusted until hashed). */
export type ReconciliationEvidence =
  | {
      readonly outcome: "CONFIRMED_SUCCEEDED";
      readonly providerReference: string;
      readonly detail?: Record<string, unknown>;
    }
  | {
      readonly outcome: "CONFIRMED_FAILED";
      readonly failureDetail?: string;
      readonly detail?: Record<string, unknown>;
    }
  | {
      readonly outcome: "STILL_PENDING";
      readonly detail?: Record<string, unknown>;
    }
  | { readonly outcome: "UNKNOWN"; readonly detail?: Record<string, unknown> };

export interface ReconciliationVerdict {
  readonly outcome: ProviderReconciliationOutcome;
  /** Deterministic fingerprint of the bounded evidence material. */
  readonly evidenceHash: string;
  readonly providerReference: string | null;
  /** Bounded redacted detail — never raw payloads. */
  readonly detail: Record<string, unknown>;
  /** True when the dispatch may leave the UNCERTAIN backlog. */
  readonly resolvesDispatch: boolean;
}

function boundedDetail(
  _detail: Record<string, unknown> | undefined
): Record<string, unknown> {
  // Adapter-controlled free text may echo credentials. Diagnostics use closed labels only.
  return {};
}

function hashEvidence(outcome: string, material: unknown): string {
  return sha256Hex(
    canonicalJson({ v: 1, outcome, material: material ?? null })
  );
}

/**
 * Classify adapter reconciliation evidence conservatively. Only an explicit
 * adapter verdict with a verifiable reference (for success) counts as
 * confirmed; everything else stays pending/unknown. The verdict never mints
 * evidence the adapter did not return.
 */
export function classifyReconciliationEvidence(
  evidence: unknown,
  requestId: string
): ReconciliationVerdict {
  // Evidence fingerprints are scoped to the exact request.
  if (
    !evidence ||
    typeof evidence !== "object" ||
    typeof (evidence as { outcome?: unknown }).outcome !== "string"
  ) {
    return {
      outcome: "UNKNOWN",
      evidenceHash: hashEvidence("UNKNOWN", { kind: "malformed_evidence" }),
      providerReference: null,
      detail: { kind: "malformed_evidence" },
      resolvesDispatch: false,
    };
  }
  const e = evidence as ReconciliationEvidence;
  if (
    ["CONFIRMED_SUCCEEDED", "CONFIRMED_FAILED", "STILL_PENDING"].includes(
      e.outcome
    ) &&
    (evidence as { requestId?: unknown }).requestId !== requestId
  ) {
    return classifyReconciliationEvidence(null, requestId);
  }
  switch (e.outcome) {
    case "CONFIRMED_SUCCEEDED": {
      const reference =
        typeof e.providerReference === "string" &&
        /^[A-Za-z0-9][A-Za-z0-9:_#/.@-]{0,190}$/.test(e.providerReference)
          ? e.providerReference
          : null;
      if (reference === null) {
        // A confirmation without a provider reference fabricates success — refuse.
        return {
          outcome: "UNKNOWN",
          evidenceHash: hashEvidence("UNKNOWN", {
            kind: "success_without_reference",
          }),
          providerReference: null,
          detail: { kind: "success_without_reference" },
          resolvesDispatch: false,
        };
      }
      return {
        outcome: "CONFIRMED_SUCCEEDED",
        evidenceHash: hashEvidence("CONFIRMED_SUCCEEDED", {
          reference,
          detail: boundedDetail(e.detail),
        }),
        providerReference: reference,
        detail: boundedDetail(e.detail),
        resolvesDispatch: true,
      };
    }
    case "CONFIRMED_FAILED":
      if (
        typeof e.failureDetail !== "string" ||
        e.failureDetail.length === 0 ||
        e.failureDetail.length > 191
      ) {
        return classifyReconciliationEvidence(null, requestId);
      }
      return {
        outcome: "CONFIRMED_FAILED",
        evidenceHash: hashEvidence("CONFIRMED_FAILED", {
          failureDetail: e.failureDetail ?? null,
          detail: boundedDetail(e.detail),
        }),
        providerReference: null,
        detail: boundedDetail(e.detail),
        resolvesDispatch: true,
      };
    case "STILL_PENDING":
      return {
        outcome: "STILL_PENDING",
        evidenceHash: hashEvidence("STILL_PENDING", {
          detail: boundedDetail(e.detail),
        }),
        providerReference: null,
        detail: boundedDetail(e.detail),
        resolvesDispatch: false,
      };
    case "UNKNOWN":
      return {
        outcome: "UNKNOWN",
        evidenceHash: hashEvidence("UNKNOWN", {
          detail: boundedDetail(e.detail),
        }),
        providerReference: null,
        detail: boundedDetail(e.detail),
        resolvesDispatch: false,
      };
    default:
      return {
        outcome: "UNKNOWN",
        evidenceHash: hashEvidence("UNKNOWN", {
          kind: "unknown_outcome",
          outcome: String((e as { outcome?: unknown }).outcome).slice(0, 32),
        }),
        providerReference: null,
        detail: { kind: "unknown_outcome" },
        resolvesDispatch: false,
      };
  }
}

export function isReconciliationOutcome(
  value: unknown
): value is ProviderReconciliationOutcome {
  return (
    typeof value === "string" &&
    (PROVIDER_RECONCILIATION_OUTCOMES as readonly string[]).includes(value)
  );
}

export function assertReconciliationOutcome(
  value: unknown
): ProviderReconciliationOutcome {
  if (!isReconciliationOutcome(value)) {
    throw new ProviderInputError(
      "PROVIDER_INPUT_MALFORMED",
      "unknown reconciliation outcome."
    );
  }
  return value;
}
