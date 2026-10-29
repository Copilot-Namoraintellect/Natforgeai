// ─── R7-A Conversion Outcome Intelligence — outcome value validation ───
//
// PURE module: safe handling of business-outcome value. Monetary outcomes use
// integer minor units (bigint grammar shared with R6-E: closed 20-code ISO
// allowlist, 1e15 magnitude bound, no NaN/Infinity, no floating-point money).
// Polarity is semantic: positive-outcome types require positive amounts,
// reversal types require negative amounts — refunds/reversals never mint
// positive duplicate value. Non-monetary outcomes carry an integer quantity
// and a closed metric unit and never fabricate a currency. No I/O, no clock.

import {
  OutcomeInputError,
  OUTCOME_REVERSAL_TYPE_SET,
  type NonMonetaryMetricUnit,
  type OutcomeType,
} from "./outcome-contract";
import {
  CURRENCY_CODE_SET,
  CURRENCY_EXPONENTS,
  MAX_CONVERSION_MINOR_UNITS,
  containsPaymentCredentialPattern,
} from "../conversion/conversion-value";
import { CURRENCY_CODES, type CurrencyCode } from "../conversion/conversion-contract";

/** Maximum absolute monetary value in integer minor units (shared R6-E grammar). */
export const MAX_OUTCOME_MINOR_UNITS = MAX_CONVERSION_MINOR_UNITS;

export const OUTCOME_CURRENCY_CODE_SET: ReadonlySet<string> = CURRENCY_CODE_SET;

/** ISO 4217 minor-unit exponent (JPY 0, others 2); null when no currency. */
export function outcomeCurrencyExponent(currency: string | null): number | null {
  if (currency === null || currency === undefined) return null;
  return CURRENCY_EXPONENTS[currency as CurrencyCode] ?? null;
}

/**
 * Validate a monetary business-outcome amount in integer minor units.
 * Rejects non-integer / non-finite values and magnitudes above 1e15
 * (OUTCOME_AMOUNT_INVALID). Positive-outcome types require amount > 0
 * (OUTCOME_AMOUNT_NOT_POSITIVE); reversal types require amount < 0
 * (OUTCOME_REVERSAL_AMOUNT_INVALID) so a refund/reversal can never become
 * positive duplicate value.
 */
export function validateOutcomeAmount(amount: number, outcomeType: OutcomeType): void {
  if (typeof amount !== "number" || !Number.isFinite(amount) || !Number.isInteger(amount)) {
    throw new OutcomeInputError(
      "OUTCOME_AMOUNT_INVALID",
      `amountMinor must be a finite integer (minor units), got ${String(amount)}.`
    );
  }
  if (Math.abs(amount) > MAX_OUTCOME_MINOR_UNITS) {
    throw new OutcomeInputError(
      "OUTCOME_AMOUNT_INVALID",
      `amountMinor magnitude ${Math.abs(amount)} exceeds the maximum of ${MAX_OUTCOME_MINOR_UNITS} minor units.`
    );
  }
  const isReversal = OUTCOME_REVERSAL_TYPE_SET.has(outcomeType);
  if (isReversal && amount >= 0) {
    throw new OutcomeInputError(
      "OUTCOME_REVERSAL_AMOUNT_INVALID",
      `outcome type ${outcomeType} requires a negative amountMinor (a reversal can never mint positive value); got ${amount}.`
    );
  }
  if (!isReversal && amount <= 0) {
    throw new OutcomeInputError(
      "OUTCOME_AMOUNT_NOT_POSITIVE",
      `outcome type ${outcomeType} requires a positive amountMinor; got ${amount}.`
    );
  }
}

/** Validate a currency code against the closed uppercase allowlist. */
export function validateOutcomeCurrency(currency: string): void {
  if (!OUTCOME_CURRENCY_CODE_SET.has(currency)) {
    throw new OutcomeInputError(
      "OUTCOME_CURRENCY_UNSUPPORTED",
      `currency ${JSON.stringify(currency)} is not in the supported allowlist (${CURRENCY_CODES.join(", ")}).`
    );
  }
}

/**
 * Validate the non-monetary metric shape: quantity a bounded positive integer
 * and metricUnit in the closed vocabulary (OUTCOME_METRIC_INVALID).
 */
export function validateOutcomeMetric(
  quantity: number,
  metricUnit: NonMonetaryMetricUnit
): void {
  if (
    typeof quantity !== "number" ||
    !Number.isFinite(quantity) ||
    !Number.isInteger(quantity) ||
    quantity < 1 ||
    quantity > 1_000_000_000
  ) {
    throw new OutcomeInputError(
      "OUTCOME_METRIC_INVALID",
      `quantity must be an integer between 1 and 1,000,000,000; got ${String(quantity)}.`
    );
  }
  if (metricUnit === undefined || metricUnit === null || String(metricUnit).trim() === "") {
    throw new OutcomeInputError("OUTCOME_METRIC_INVALID", "metricUnit must be a closed-vocabulary value.");
  }
}

/**
 * Monetary cross-check against the governed R6-E conversion amount: when the
 * conversion carries an authoritative monetary value (financial-authority
 * trust class), an outcome monetary value must match its amount and currency.
 * Conversion metadata is never trusted as business value merely because it
 * contains a number — only an equality cross-check against governed
 * conversion authority passes (OUTCOME_VALUE_CONFLICT otherwise).
 */
export function assertConversionValueConsistency(args: {
  conversionAmount: number | null;
  conversionCurrency: string | null;
  outcomeAmount: number | null;
  outcomeCurrency: string | null;
}): void {
  const { conversionAmount, conversionCurrency, outcomeAmount, outcomeCurrency } = args;
  if (conversionAmount === null || conversionAmount === undefined) return;
  if (outcomeAmount === null || outcomeAmount === undefined) return;
  if (Number(conversionAmount) !== Number(outcomeAmount) || (conversionCurrency ?? null) !== (outcomeCurrency ?? null)) {
    throw new OutcomeInputError(
      "OUTCOME_VALUE_CONFLICT",
      `outcome monetary value ${outcomeAmount} ${outcomeCurrency ?? "null"} conflicts with the governed conversion value ${conversionAmount} ${conversionCurrency ?? "null"}.`
    );
  }
}

/**
 * Monetary reversal cross-check against the referenced outcome: currency must
 * match when both are monetary, and the reversal magnitude must not exceed the
 * target's (partial reversals supported, over-reversal fails closed).
 */
export function assertReversalValueConsistency(args: {
  targetAmount: number | null;
  targetCurrency: string | null;
  reversalAmount: number | null;
  reversalCurrency: string | null;
}): void {
  const { targetAmount, targetCurrency, reversalAmount, reversalCurrency } = args;
  if (targetAmount === null || targetAmount === undefined) {
    if (reversalAmount !== null && reversalAmount !== undefined) {
      throw new OutcomeInputError(
        "OUTCOME_VALUE_CONFLICT",
        "reversal monetary value cannot reference a non-monetary target outcome."
      );
    }
    return;
  }
  if (reversalAmount === null || reversalAmount === undefined) return;
  if ((targetCurrency ?? null) !== (reversalCurrency ?? null)) {
    throw new OutcomeInputError(
      "OUTCOME_VALUE_CONFLICT",
      `reversal currency ${reversalCurrency ?? "null"} does not match target currency ${targetCurrency ?? "null"}.`
    );
  }
  if (Math.abs(Number(reversalAmount)) > Math.abs(Number(targetAmount))) {
    throw new OutcomeInputError(
      "OUTCOME_VALUE_CONFLICT",
      `reversal magnitude ${Math.abs(Number(reversalAmount))} exceeds the target outcome magnitude ${Math.abs(Number(targetAmount))}.`
    );
  }
}

/** True when an evidence identity carries a payment-credential digit run. */
export function outcomeContainsPaymentCredential(value: string): boolean {
  return containsPaymentCredentialPattern(value);
}
