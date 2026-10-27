// ─── R6-D Nurture / Sales Handoff — provider capability truth (contract §10) ───
//
// PURE module: the truthful capability answer for nurture/handoff execution
// channels. POLICY-SIDE EXISTENCE IS NOT CAPABILITY (same rule as R5-X):
// a channel the policy can govern but the codebase cannot truthfully execute
// is UNSUPPORTED / REQUIRES_CONFIGURATION — never simulated.
//
// Ground truth at the R6-D base:
//   - email    : real SMTP exists (api/lib/email.ts) but is NOT wired for
//                governed autonomous nurture ⇒ REQUIRES_CONFIGURATION.
//   - whatsapp : no repository transport ⇒ UNSUPPORTED.
//   - sms      : no repository transport ⇒ UNSUPPORTED.
//   - crm      : no CRM handoff dispatch transport exists ⇒ UNSUPPORTED.
//
// The ONLY supported execution path in R6-D is the explicitly fake/test-only
// in-memory transport (nurture-fake-transport.ts), used solely by tests.
// Where an R6-D action maps onto an R5 engagement action, capability defers
// to the R5-X integrated matrix — no parallel matrix is introduced.
// No I/O, no clock, no database access.

import {
  type NurtureChannel,
  type ProviderCapabilityState,
  failNurture,
} from "./nurture-contract";

export const NURTURE_CAPABILITY_VIEW_VERSION = "nurture-capability-view/v1" as const;

/** The provider id of the explicitly fake, test-only transport. */
export const FAKE_TEST_PROVIDER = "fake_test" as const;

export interface NurtureCapabilityDescriptor {
  readonly channel: NurtureChannel;
  readonly provider: string | null;
  readonly state: ProviderCapabilityState;
  /** Bounded, human-readable reason; never contains secrets or PII. */
  readonly reason: string;
}

const TRUTH: Record<NurtureChannel, Omit<NurtureCapabilityDescriptor, "channel" | "provider">> = {
  email: {
    state: "REQUIRES_CONFIGURATION",
    reason: "SMTP exists but is not wired for governed autonomous nurture; activation is an R6-X configuration slot.",
  },
  whatsapp: {
    state: "UNSUPPORTED",
    reason: "No repository WhatsApp transport; policy-side existence is not capability.",
  },
  sms: {
    state: "UNSUPPORTED",
    reason: "No repository SMS transport; policy-side existence is not capability.",
  },
  crm: {
    state: "UNSUPPORTED",
    reason: "No CRM handoff dispatch transport exists in the repository; handoff preparation and approval remain fully governed.",
  },
};

const FAKE_TRUTH: Omit<NurtureCapabilityDescriptor, "channel"> = {
  provider: FAKE_TEST_PROVIDER,
  state: "SUPPORTED",
  reason: "Explicitly fake in-memory test transport; performs no network I/O and contacts no real lead.",
};

/**
 * Truthful capability for one channel+provider. The fake_test provider is
 * SUPPORTED for every channel (test-only); every real provider answers the
 * honest repository truth above. Unknown providers are UNSUPPORTED.
 */
export function resolveNurtureCapability(input: {
  channel: NurtureChannel;
  provider?: string | null;
}): NurtureCapabilityDescriptor {
  const provider = input.provider ?? null;
  if (provider === FAKE_TEST_PROVIDER) {
    return Object.freeze({ channel: input.channel, ...FAKE_TRUTH });
  }
  const truth = TRUTH[input.channel];
  return Object.freeze({
    channel: input.channel,
    provider,
    state: truth.state,
    reason: truth.reason,
  });
}

/** Fail-closed dispatch gate (contract §10, §11): only SUPPORTED may dispatch. */
export function assertCapabilityDispatchable(descriptor: NurtureCapabilityDescriptor): void {
  if (descriptor.state === "SUPPORTED") return;
  if (descriptor.state === "UNSUPPORTED" || descriptor.state === "BLOCKED") {
    failNurture(
      "CAPABILITY_UNSUPPORTED",
      `CAPABILITY_UNSUPPORTED: channel ${descriptor.channel} is ${descriptor.state} (${descriptor.state === "BLOCKED" ? "governance-blocked" : "no truthful transport"}); failing closed.`
    );
  }
  // REQUIRES_CONFIGURATION / REQUIRES_APPROVAL: not dispatchable autonomously.
  failNurture(
    "CAPABILITY_UNSUPPORTED",
    `CAPABILITY_UNSUPPORTED: channel ${descriptor.channel} is ${descriptor.state}; dispatch requires configuration/approval outside this execution path.`
  );
}

/** Type guard helper for the service layer (maps state → reason code family). */
export function capabilityReasonCode(
  descriptor: NurtureCapabilityDescriptor
): "CAPABILITY_UNSUPPORTED" | "CAPABILITY_REQUIRES_CONFIGURATION" | "CAPABILITY_BLOCKED" {
  if (descriptor.state === "BLOCKED") return "CAPABILITY_BLOCKED";
  if (descriptor.state === "REQUIRES_CONFIGURATION") return "CAPABILITY_REQUIRES_CONFIGURATION";
  return "CAPABILITY_UNSUPPORTED";
}
