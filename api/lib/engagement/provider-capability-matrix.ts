// ─── R5-X convergence — integrated provider capability view + eligibility ───
//
// ONE truthful capability view across the R5 surface, composed exclusively
// from the frozen per-stream authorities (no parallel capability matrix is
// introduced here — everything DELEGATES):
//
//   - Listening (inbound) capability  → R5-A adapter registry
//     (`resolveListeningMechanism`, api/lib/social-listening/adapters).
//   - Engagement execution (outbound) capability → R5-C transport matrix
//     (`resolveEngagementCapability`, api/lib/engagement/provider-boundary).
//
// Ground truth (evidence-backed):
//   Listening    — Meta webhook: facebook/instagram/whatsapp supported;
//                  LinkedIn: polling seam only (no webhook verifier);
//                  Twitter/TikTok: no adapter → unsupported.
//   Execution    — public reply on facebook/instagram via the Meta comment
//                  reply transport only; LinkedIn/Twitter/TikTok replies,
//                  reactions and private messages have NO repository transport.
//
// POLICY-SIDE EXISTENCE IS NOT CAPABILITY. R5-E's marketing-action vocabulary
// (`MARKETING_ACTION_TYPES`: react, reply_privately, nurture_candidate, …)
// defines what policy can GOVERN, never what the codebase can EXECUTE. An
// action whose policy-side type exists but whose transport does not is
// INELIGIBLE and fails closed — the C9 execution gate already enforces this
// (see r5-c-acceptance C9.22); this module makes the rule explicit and
// testable in one place.
//
// Final eligibility rule (all four legs must hold, else fail closed):
//   policy allows the action
//   AND the provider transport supports (actionType, platform)
//   AND the account/binding is valid (owner + credential verified)
//   AND the execution transport is operator-enabled
// → eligible for execution. Any other combination → ineligible.

import {
  resolveListeningMechanism,
  type PlatformListeningCapability,
  type ResolvedListeningMechanism,
} from "../social-listening/adapters";
import {
  resolveEngagementCapability,
  type EngagementCapabilityDescriptor,
} from "./provider-boundary";

export const PROVIDER_CAPABILITY_MATRIX_VERSION = "provider-capability-matrix/v1" as const;

/** How one inbound (listening) surface is supported, if at all. */
export function describeListeningCapability(
  provider: string,
  platform: string
): ResolvedListeningMechanism {
  return resolveListeningMechanism(provider, platform);
}

/** The transport seam for one outbound (engagement) action, or null. */
export function describeEngagementExecutionCapability(
  actionType: string,
  platform: string
): EngagementCapabilityDescriptor | null {
  return resolveEngagementCapability(actionType, platform);
}

export function isListeningSupported(provider: string, platform: string): boolean {
  return resolveListeningMechanism(provider, platform).kind === "supported";
}

export function isEngagementExecutionSupported(actionType: string, platform: string): boolean {
  return resolveEngagementCapability(actionType, platform) !== null;
}

export type EngagementEligibilityVerdict =
  | { eligible: true }
  | { eligible: false; reason: "POLICY_NOT_ALLOWED" | "TRANSPORT_UNSUPPORTED" | "BINDING_INVALID" | "TRANSPORT_DISABLED" };

export interface EngagementEligibilityInput {
  /** Outcome of the R5-E policy gate (ALLOW only; DENY/ESCALATE are never eligible). */
  policyAllows: boolean;
  actionType: string;
  platform: string;
  /** Outcome of R5-C binding ownership + credential verification. */
  bindingVerified: boolean;
  /** Operator enablement of the live execution transport (env-gated). */
  transportEnabled: boolean;
}

/**
 * The integrated eligibility rule. This is the declarative twin of the C
 * execution gate's ordered checks (capability → binding → policy → content →
 * transport); both must agree. It introduces no new authority — each leg
 * delegates to the stream that owns it.
 */
export function evaluateEngagementEligibility(
  input: EngagementEligibilityInput
): EngagementEligibilityVerdict {
  if (!input.policyAllows) {
    return { eligible: false, reason: "POLICY_NOT_ALLOWED" };
  }
  if (!isEngagementExecutionSupported(input.actionType, input.platform)) {
    return { eligible: false, reason: "TRANSPORT_UNSUPPORTED" };
  }
  if (!input.bindingVerified) {
    return { eligible: false, reason: "BINDING_INVALID" };
  }
  if (!input.transportEnabled) {
    return { eligible: false, reason: "TRANSPORT_DISABLED" };
  }
  return { eligible: true };
}
