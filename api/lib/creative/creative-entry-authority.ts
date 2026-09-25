import { TRPCError } from "@trpc/server";

import { assertApprovedStrategySemanticallyValid } from "../workflow/strategy-approval";
import { captureApprovedCreativeStrategyAuthority } from "./strategy-authority";
import {
  resolveImmutableCreativeStrategyInput,
  type CreativeStrategySnapshotInput,
} from "./strategy-snapshot-input";

export interface CreativeEntryAuthorityRequest {
  /** Campaign row loaded by the entry point; ownership already verified. */
  readonly campaign: unknown;
  readonly userId: number;
  readonly campaignId: number;
  /** Linked business row when the entry point already loaded it. */
  readonly business?: unknown;
}

/**
 * Governed immutable Strategy authority shared by every non-job Creative
 * entry point (manual agent runs and approval-triggered generation).
 *
 * Runs the same fail-closed authority chain as the content-generation job:
 * assertApprovedStrategySemanticallyValid → captureApprovedCreativeStrategyAuthority
 * → resolveImmutableCreativeStrategyInput. The returned snapshot input must be
 * passed to runCreativeAgent unchanged.
 *
 * Throws before any provider spend, Creative persistence or billing when the
 * approved Strategy authority is missing, stale, mismatched or no longer
 * approved. Mutable campaign Strategy fields are never consulted as a
 * fallback.
 */
export async function resolveCreativeEntryStrategyAuthority(
  request: CreativeEntryAuthorityRequest
): Promise<CreativeStrategySnapshotInput> {
  await assertApprovedStrategySemanticallyValid(
    request.campaign,
    request.userId,
    request.business
  );

  const authority =
    captureApprovedCreativeStrategyAuthority(request.campaign);

  const businessId = Number(
    (request.campaign as Record<string, unknown> | null)?.businessId
  );

  if (
    !Number.isInteger(businessId) ||
    businessId <= 0
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "Campaign is not linked to a business. Complete business onboarding first.",
    });
  }

  return resolveImmutableCreativeStrategyInput({
    authority,
    userId: request.userId,
    campaignId: request.campaignId,
    businessId,
  });
}
