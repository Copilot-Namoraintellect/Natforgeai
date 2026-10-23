/**
 * Forward agent billing identities (WBS-R1.3).
 *
 * Caller-stable billing identities for the workflow chain agents, minted at
 * the workflow trigger boundary from durable run coordinates:
 *
 * - Audience:        agent-audience-${sha256(
 *     "workflow/agent-billing@v1:audience:{campaignId}:{creativeRunId}")}
 * - Distribution:    agent-distribution-${sha256(
 *     "workflow/agent-billing@v1:distribution:{campaignId}:{audienceRunId}")}
 * - Audience-intel:  agent-audience-intel-${sha256(
 *     "workflow/agent-billing@v1:audience-intel:{campaignId}:{continuationId}")}
 *
 * Because the identity is a pure function of durable material (campaign id +
 * the upstream completed run id), it is stable across retries of the same
 * logical step: a re-triggered audience step for the same creative run mints
 * the same identity, so the keyed deduction collapses duplicate charges onto
 * one durable credit-transaction row instead of double-billing.
 *
 * Pure, side-effect free. No billing happens here — the identity is handed to
 * the runner's keyed deduction at the trigger boundary.
 */

import { createHash } from "crypto";

export const AUDIENCE_BILLING_IDENTITY_PREFIX = "agent-audience-";
export const AUDIENCE_INTELLIGENCE_BILLING_IDENTITY_PREFIX = "agent-audience-intel-";
export const DISTRIBUTION_BILLING_IDENTITY_PREFIX = "agent-distribution-";

const AGENT_BILLING_CONTRACT = "workflow/agent-billing@v1";

function assertPositiveId(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function hashBillingIdentity(material: string): string {
  return createHash("sha256").update(material, "utf8").digest("hex");
}

/**
 * Stable audience billing identity for the audience step that follows a
 * completed creative run.
 */
export function buildAudienceBillingIdentity(input: {
  campaignId: number;
  creativeRunId: number;
}): string {
  assertPositiveId(input.campaignId, "campaignId");
  assertPositiveId(input.creativeRunId, "creativeRunId");
  return `${AUDIENCE_BILLING_IDENTITY_PREFIX}${hashBillingIdentity(
    `${AGENT_BILLING_CONTRACT}:audience:${input.campaignId}:${input.creativeRunId}`
  )}`;
}

/**
 * Stable distribution billing identity for the distribution step that
 * follows a completed audience run.
 */
export function buildDistributionBillingIdentity(input: {
  campaignId: number;
  audienceRunId: number;
}): string {
  assertPositiveId(input.campaignId, "campaignId");
  assertPositiveId(input.audienceRunId, "audienceRunId");
  return `${DISTRIBUTION_BILLING_IDENTITY_PREFIX}${hashBillingIdentity(
    `${AGENT_BILLING_CONTRACT}:distribution:${input.campaignId}:${input.audienceRunId}`
  )}`;
}

/**
 * Stable audience-intelligence billing identity (WBS-R4 C0.2 / Stream E
 * financial-reliability contract §2, frozen format):
 *
 *   agent-audience-intel-${sha256(
 *     "workflow/agent-billing@v1:audience-intel:{campaignId}:{continuationId}")}
 *
 * `continuationId` is the durable dispatch continuation identity minted at the
 * workflow trigger boundary (the launch/strategy approval request id, or the
 * cost-pause continuation id for a budget-resume replay). Because the identity
 * is a pure function of durable material, a recovered/replayed continuation
 * re-enters with the same key, so the governed reservation path collapses the
 * charge onto at most one durable wallet effect across retry/restart and
 * concurrent duplicate dispatch.
 */
export function buildAudienceIntelligenceBillingIdentity(input: {
  campaignId: number;
  continuationId: number;
}): string {
  assertPositiveId(input.campaignId, "campaignId");
  assertPositiveId(input.continuationId, "continuationId");
  return `${AUDIENCE_INTELLIGENCE_BILLING_IDENTITY_PREFIX}${hashBillingIdentity(
    `${AGENT_BILLING_CONTRACT}:audience-intel:${input.campaignId}:${input.continuationId}`
  )}`;
}
