// ─── R6-D Nurture / Sales Handoff — versioned business policy (contract §6, §13) ───
//
// PURE module: the nurture/handoff policy model, the immutable default
// policy, validation, and deterministic version derivation. Policies are
// business-scoped, versioned ("nurture-handoff-policy/vN"), and immutable;
// changes create a new version (R5-E businessPolicies discipline mirrored).
// No I/O, no clock, no database access.

import { z } from "zod";
import { sha256Hex, canonicalJson } from "./nurture-identity";
import { NURTURE_CHANNELS, type NurtureChannel } from "./nurture-contract";

export const NURTURE_POLICY_CONTRACT_VERSION = "nurture-handoff-policy/v1" as const;

export const NurtureCadenceSchema = z.strictObject({
  /** Minimum hours between touches on one channel. */
  minIntervalHours: z.number().int().min(0).max(24 * 30),
  /** Rolling window length in days for the touch cap. */
  windowDays: z.number().int().min(1).max(90),
  /** Maximum touches per channel inside the rolling window. */
  maxTouchesPerWindow: z.number().int().min(1).max(100),
});

export const NurtureHandoffPolicyConfigSchema = z.strictObject({
  /** Stop nurture and suppress handoff when an authoritative conversion
   *  exists for the lead/business (contract §13). */
  stopOnAuthoritativeConversion: z.boolean(),
  /** Sales handoff always requires explicit human approval under this policy. */
  handoffRequiresApproval: z.boolean(),
  /** Channels the business allows nurture on (closed channel vocabulary). */
  allowedChannels: z.array(z.enum(NURTURE_CHANNELS)).min(1),
  /** Channel-level approval escalation (e.g. sms requires approval). */
  channelsRequiringApproval: z.array(z.enum(NURTURE_CHANNELS)),
  /** Policy-controlled frequency bounds (contract §7). */
  nurtureCadence: NurtureCadenceSchema,
  /** Decision validity TTL in hours (decision.validUntil). */
  decisionTtlHours: z.number().int().min(1).max(24 * 30),
});

export type NurtureHandoffPolicyConfig = z.infer<typeof NurtureHandoffPolicyConfigSchema>;

/** Immutable default policy — adopted per business on first use (idempotent). */
export function buildDefaultNurturePolicyConfig(): NurtureHandoffPolicyConfig {
  return NurtureHandoffPolicyConfigSchema.parse({
    stopOnAuthoritativeConversion: true,
    handoffRequiresApproval: true,
    allowedChannels: [...NURTURE_CHANNELS],
    channelsRequiringApproval: ["sms"],
    nurtureCadence: { minIntervalHours: 72, windowDays: 30, maxTouchesPerWindow: 4 },
    decisionTtlHours: 24,
  });
}

/** Deterministic config hash — the versioned identity of one policy material. */
export function hashNurturePolicyConfig(config: NurtureHandoffPolicyConfig): string {
  return sha256Hex(canonicalJson({ v: 1, config }));
}

export interface NurtureHandoffPolicy {
  policyVersion: string;
  configHash: string;
  config: NurtureHandoffPolicyConfig;
}

/**
 * Version derivation: the FIRST version is the contract version itself; a
 * business-specific config produces a deterministic suffix derived from its
 * content hash, so same-config policies share a version and any config change
 * is visibly a different version (STALE_POLICY_VERSION gates enforcement).
 */
export function derivePolicyVersion(
  _config: NurtureHandoffPolicyConfig,
  configHash: string
): string {
  const defaultHash = hashNurturePolicyConfig(buildDefaultNurturePolicyConfig());
  if (configHash === defaultHash) return NURTURE_POLICY_CONTRACT_VERSION;
  return `${NURTURE_POLICY_CONTRACT_VERSION}+${configHash.slice(0, 16)}`;
}

export function buildNurtureHandoffPolicy(
  config: NurtureHandoffPolicyConfig
): NurtureHandoffPolicy {
  const parsed = NurtureHandoffPolicyConfigSchema.parse(config);
  const configHash = hashNurturePolicyConfig(parsed);
  return {
    policyVersion: derivePolicyVersion(parsed, configHash),
    configHash,
    config: parsed,
  };
}

export function isChannelAllowed(policy: NurtureHandoffPolicy, channel: NurtureChannel): boolean {
  return policy.config.allowedChannels.includes(channel);
}

export function doesChannelRequireApproval(
  policy: NurtureHandoffPolicy,
  channel: NurtureChannel
): boolean {
  return policy.config.channelsRequiringApproval.includes(channel);
}

export function deriveDecisionValidity(policy: NurtureHandoffPolicy, occurredAt: Date): string {
  return new Date(occurredAt.getTime() + policy.config.decisionTtlHours * 3_600_000).toISOString();
}
