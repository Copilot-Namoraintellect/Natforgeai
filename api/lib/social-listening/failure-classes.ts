/**
 * Listening failure classification (WBS-R5-A A5/A6).
 *
 * Every ingestion/polling failure is classified into exactly one durable
 * class so operators can see what needs what without source/database
 * inspection:
 *
 *   AUTO_RECOVER       transient provider/network/rate-limit — retry is safe
 *                      and expected to succeed (no operator needed).
 *   OPERATOR_ACTION    requires a human: expired/revoked authorization,
 *                      missing provider setup, missing permission scope.
 *   FAIL_CLOSED        authenticity/ownership/authority failure — the event
 *                      was rejected and must NOT be retried blindly.
 */

import {
  classifyProviderErrorMessage,
  type AdapterErrorCategory,
} from "../integrations/adapters/platform-adapter";
import { SignalContractError } from "./signal-contract";

export const LISTENING_FAILURE_CLASSES = [
  "AUTO_RECOVER",
  "OPERATOR_ACTION",
  "FAIL_CLOSED",
] as const;
export type ListeningFailureClass = (typeof LISTENING_FAILURE_CLASSES)[number];

export interface ListeningFailure {
  class: ListeningFailureClass;
  code: string;
  reason: string;
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** Contract-level failures are authority failures — fail closed. */
const CONTRACT_CLASS_BY_CODE: Record<string, ListeningFailureClass> = {
  MALFORMED_SIGNAL: "FAIL_CLOSED",
  UNKNOWN_PROVIDER: "FAIL_CLOSED",
  UNKNOWN_PLATFORM: "FAIL_CLOSED",
  OWNERSHIP_MISMATCH: "FAIL_CLOSED",
};

/** Provider error categories → failure classes. */
const CATEGORY_CLASS: Record<AdapterErrorCategory, ListeningFailureClass> = {
  auth: "OPERATOR_ACTION", // expired/revoked/insufficient authorization
  validation: "FAIL_CLOSED",
  rate_limited: "AUTO_RECOVER",
  network: "AUTO_RECOVER",
  provider: "AUTO_RECOVER",
  unsupported: "OPERATOR_ACTION", // capability/scope missing
};

const LISTENING_NOT_CONFIGURED = "LISTENING_NOT_CONFIGURED";

export function classifyListeningFailure(err: unknown): ListeningFailure {
  if (err instanceof SignalContractError) {
    return {
      class: CONTRACT_CLASS_BY_CODE[err.code] ?? "FAIL_CLOSED",
      code: err.code,
      reason: err.message,
    };
  }

  const message = messageOf(err);

  if (message.includes(LISTENING_NOT_CONFIGURED)) {
    return {
      class: "OPERATOR_ACTION",
      code: "LISTENING_NOT_CONFIGURED",
      reason: message,
    };
  }

  // Missing/revoked/expired authorization needs an operator to re-authorize.
  if (/permission|scope|token|credential|session|authoriz|unauthor/i.test(message)) {
    return {
      class: "OPERATOR_ACTION",
      code: /expired|revok|invalid/i.test(message) ? "provider_auth" : "provider_scope_missing",
      reason: message,
    };
  }

  const { category, code, retryable } = classifyProviderErrorMessage(message);
  return {
    class: CATEGORY_CLASS[category],
    code,
    reason: retryable ? message : message,
  };
}

export function isAutoRecoverable(err: unknown): boolean {
  return classifyListeningFailure(err).class === "AUTO_RECOVER";
}
