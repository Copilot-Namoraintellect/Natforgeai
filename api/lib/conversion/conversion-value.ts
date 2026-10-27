// ─── R6-E Conversion Tracking — monetary value validation ───
//
// PURE module: bounded monetary value validation (integer minor units), the
// closed currency allowlist + exponent map, both-or-neither amount/currency
// enforcement, and the payment-credential leak guard. No I/O, no clock.

import {
  ConversionInputError,
  CURRENCY_CODES,
  REVERSAL_TYPE_SET,
  type ConversionType,
  type CurrencyCode,
} from "./conversion-contract";

/** Maximum absolute monetary value in integer minor units (1e15). */
export const MAX_CONVERSION_MINOR_UNITS = 1_000_000_000_000_000;

export const CURRENCY_CODE_SET: ReadonlySet<string> = new Set(CURRENCY_CODES);

/** ISO 4217 minor-unit exponent: JPY is zero-decimal; all others 2. */
export const CURRENCY_EXPONENTS: Readonly<Record<CurrencyCode, number>> = {
  USD: 2,
  EUR: 2,
  GBP: 2,
  ZAR: 2,
  CAD: 2,
  AUD: 2,
  NZD: 2,
  JPY: 0,
  CHF: 2,
  SEK: 2,
  NOK: 2,
  DKK: 2,
  INR: 2,
  BRL: 2,
  MXN: 2,
  SGD: 2,
  HKD: 2,
  AED: 2,
  PLN: 2,
  KES: 2,
};

/** Exponent for a currency code; null when no currency is present. */
export function currencyExponent(currency: string | null): number | null {
  if (currency === null || currency === undefined) return null;
  return CURRENCY_EXPONENTS[currency as CurrencyCode] ?? null;
}

/**
 * Validate a monetary amount in integer minor units. Rejects non-integer /
 * non-finite values and magnitudes above 1e15 (CONVERSION_AMOUNT_INVALID).
 * Negative amounts are permitted ONLY for reversal types
 * (CONVERSION_NEGATIVE_AMOUNT_NOT_PERMITTED otherwise).
 */
export function validateConversionAmount(
  amount: number,
  conversionType: ConversionType
): void {
  if (typeof amount !== "number" || !Number.isFinite(amount) || !Number.isInteger(amount)) {
    throw new ConversionInputError(
      "CONVERSION_AMOUNT_INVALID",
      `amount must be a finite integer (minor units), got ${String(amount)}.`
    );
  }
  if (Math.abs(amount) > MAX_CONVERSION_MINOR_UNITS) {
    throw new ConversionInputError(
      "CONVERSION_AMOUNT_INVALID",
      `amount magnitude ${Math.abs(amount)} exceeds the maximum of ${MAX_CONVERSION_MINOR_UNITS} minor units.`
    );
  }
  if (amount < 0 && !REVERSAL_TYPE_SET.has(conversionType)) {
    throw new ConversionInputError(
      "CONVERSION_NEGATIVE_AMOUNT_NOT_PERMITTED",
      `negative amounts are only permitted for reversal types (${Array.from(REVERSAL_TYPE_SET).join(", ")}); got conversion type "${conversionType}".`
    );
  }
}

/** Validate a currency code against the closed uppercase allowlist. */
export function validateConversionCurrency(currency: string): void {
  if (!CURRENCY_CODE_SET.has(currency)) {
    throw new ConversionInputError(
      "CONVERSION_CURRENCY_UNSUPPORTED",
      `currency ${JSON.stringify(currency)} is not in the supported allowlist (${CURRENCY_CODES.join(", ")}).`
    );
  }
}

/**
 * Amount and currency are both-or-neither: a monetary value is incomplete
 * when exactly one of the pair is present.
 */
export function assertAmountCurrencyPair(amount: number | null | undefined, currency: string | null | undefined): void {
  if ((amount === null || amount === undefined) !== (currency === null || currency === undefined)) {
    throw new ConversionInputError(
      "CONVERSION_AMOUNT_CURRENCY_MISMATCH",
      "amount and currency must be supplied together or omitted together."
    );
  }
}

// Card-like credential run: 13–19 consecutive digits (PAN-shaped).
const PAYMENT_CREDENTIAL_RUN = /\d{13,19}/;

/**
 * True when a free-text field contains a card/payment-credential-shaped run
 * of digits. Applied to external ids and evidence references so PANs can never
 * be persisted into the conversion ledger.
 */
export function containsPaymentCredentialPattern(value: string): boolean {
  return PAYMENT_CREDENTIAL_RUN.test(value);
}

/** Reject a free-text field that carries a payment-credential pattern. */
export function assertNoPaymentCredential(value: string, field: string): void {
  if (containsPaymentCredentialPattern(value)) {
    throw new ConversionInputError(
      "CONVERSION_PAYMENT_CREDENTIAL_REJECTED",
      `${field} contains a payment-credential-shaped digit run and must never be persisted.`
    );
  }
}
