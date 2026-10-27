// ─── R6-E Conversion Tracking — deterministic source-trust registry ───
//
// PURE module: the server-side, deterministic mapping from source system to
// trust class. The client can never supply or influence a trust class — it is
// derived here, server-side only, from the closed source-system vocabulary.
// No I/O, no clock.

import {
  CONVERSION_SOURCE_SYSTEMS,
  type ConversionOutcomeStatus,
  type ConversionSourceSystem,
  type ConversionTrustClass,
} from "./conversion-contract";

/**
 * Source system → trust class. Closed and deterministic: every member of
 * CONVERSION_SOURCE_SYSTEMS maps to exactly one trust class and anything
 * outside the closed vocabulary fails closed.
 */
export const SOURCE_TRUST_REGISTRY: Readonly<
  Record<ConversionSourceSystem, ConversionTrustClass>
> = {
  internal: "VERIFIED_INTERNAL",
  stripe: "VERIFIED_PAYMENT",
  paypal: "VERIFIED_PAYMENT",
  shopify: "VERIFIED_PAYMENT",
  woocommerce: "VERIFIED_PAYMENT",
  salesforce: "VERIFIED_CRM",
  hubspot: "VERIFIED_CRM",
  calendly: "VERIFIED_CRM",
  meta: "VERIFIED_PROVIDER",
  linkedin: "VERIFIED_PROVIDER",
  google_analytics: "VERIFIED_PROVIDER",
  user_report: "USER_REPORTED",
  unverified_webhook: "UNVERIFIED_EXTERNAL",
};

/**
 * Trust classes whose monetary value is authoritative ("verified"). Only these
 * classes may carry a verifiedAmount in the R7 projection; all others expose
 * the value as "reported" only.
 */
export const FINANCIAL_AUTHORITY_TRUST_CLASSES: readonly ConversionTrustClass[] = [
  "VERIFIED_INTERNAL",
  "VERIFIED_PROVIDER",
  "VERIFIED_CRM",
  "VERIFIED_PAYMENT",
] as const;

const FINANCIAL_AUTHORITY_SET: ReadonlySet<string> = new Set(
  FINANCIAL_AUTHORITY_TRUST_CLASSES
);

/** Derive the authoritative trust class for a source system (server-only). */
export function deriveTrustClass(sourceSystem: string): ConversionTrustClass {
  const trustClass = (SOURCE_TRUST_REGISTRY as Record<string, ConversionTrustClass>)[
    sourceSystem
  ];
  if (!trustClass) {
    // Closed vocabulary guarantees this is unreachable at the boundary; it is
    // still a fail-closed backstop for direct internal callers.
    throw new Error(
      `CONVERSION_SOURCE_SYSTEM_UNKNOWN: source system ${JSON.stringify(sourceSystem)} is outside the closed vocabulary (${CONVERSION_SOURCE_SYSTEMS.join(", ")}).`
    );
  }
  return trustClass;
}

/** True when a trust class makes a monetary value authoritative. */
export function isFinancialAuthorityTrustClass(
  trustClass: ConversionTrustClass
): boolean {
  return FINANCIAL_AUTHORITY_SET.has(trustClass);
}

/**
 * Initial outcome status is derived server-side from the trust class:
 * VERIFIED_* and USER_REPORTED land CONFIRMED; UNVERIFIED_EXTERNAL lands
 * PENDING (it requires later corroboration before it can be authoritative).
 */
export function deriveInitialOutcomeStatus(
  trustClass: ConversionTrustClass
): ConversionOutcomeStatus {
  return trustClass === "UNVERIFIED_EXTERNAL" ? "PENDING" : "CONFIRMED";
}
