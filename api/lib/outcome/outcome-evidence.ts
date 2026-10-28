// ─── R7-A Conversion Outcome Intelligence — evidence authority registry ───
//
// PURE module: the server-side, deterministic mapping from business-outcome
// evidence source to evidence authority class, and the derivation of the
// initial outcome status from that class. The client can never supply or
// influence an authority class or a verification state — they are derived
// here, server-side only, from the closed evidence-source vocabulary. No I/O,
// no clock.

import {
  OUTCOME_EVIDENCE_SOURCES,
  type OutcomeEvidenceAuthority,
  type OutcomeEvidenceSource,
  type OutcomeStatus,
} from "./outcome-contract";

/**
 * Evidence source → authority class. Closed and deterministic: every member of
 * OUTCOME_EVIDENCE_SOURCES maps to exactly one class and anything outside the
 * closed vocabulary fails closed at the boundary.
 */
export const EVIDENCE_AUTHORITY_REGISTRY: Readonly<
  Record<OutcomeEvidenceSource, OutcomeEvidenceAuthority>
> = {
  payment_processor: "VERIFIED_PAYMENT",
  accounting_system: "VERIFIED_INTERNAL",
  contract_repository: "VERIFIED_CONTRACT",
  crm_record: "VERIFIED_CRM",
  platform_report: "VERIFIED_PLATFORM",
  internal_system: "VERIFIED_INTERNAL",
  user_attestation: "USER_ATTESTED",
  unverified_external: "UNVERIFIED_EXTERNAL",
};

/**
 * Authority classes whose recorded value is authoritative ("verified"). Only
 * these classes may mint an outcome in VERIFIED status (directly or via the
 * governed verification transition); USER_ATTESTED lands PROVISIONAL and
 * UNVERIFIED_EXTERNAL lands OBSERVED — stored as evidence, never silently
 * verified revenue.
 */
export const OUTCOME_VALUE_AUTHORITY_CLASSES: readonly OutcomeEvidenceAuthority[] = [
  "VERIFIED_PAYMENT",
  "VERIFIED_CONTRACT",
  "VERIFIED_CRM",
  "VERIFIED_PLATFORM",
  "VERIFIED_INTERNAL",
] as const;

const VALUE_AUTHORITY_SET: ReadonlySet<string> = new Set(OUTCOME_VALUE_AUTHORITY_CLASSES);

/** Derive the authority class for an evidence source (server-only). */
export function deriveEvidenceAuthority(source: string): OutcomeEvidenceAuthority {
  const authority = (EVIDENCE_AUTHORITY_REGISTRY as Record<string, OutcomeEvidenceAuthority>)[
    source
  ];
  if (!authority) {
    // Closed vocabulary guarantees this is unreachable at the boundary; it is
    // still a fail-closed backstop for direct internal callers.
    throw new Error(
      `OUTCOME_EVIDENCE_SOURCE_UNKNOWN: evidence source ${JSON.stringify(source)} is outside the closed vocabulary (${OUTCOME_EVIDENCE_SOURCES.join(", ")}).`
    );
  }
  return authority;
}

/** True when an authority class makes a recorded value authoritative. */
export function isValueAuthorityClass(authority: OutcomeEvidenceAuthority): boolean {
  return VALUE_AUTHORITY_SET.has(authority);
}

/**
 * Initial outcome status is derived server-side from the evidence authority:
 * VERIFIED_* classes land VERIFIED, USER_ATTESTED lands PROVISIONAL,
 * UNVERIFIED_EXTERNAL lands OBSERVED. Verification state is therefore never
 * client-selectable (acceptance: client cannot force VERIFIED).
 */
export function deriveInitialOutcomeStatus(authority: OutcomeEvidenceAuthority): OutcomeStatus {
  if (isValueAuthorityClass(authority)) return "VERIFIED";
  return authority === "USER_ATTESTED" ? "PROVISIONAL" : "OBSERVED";
}
