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
