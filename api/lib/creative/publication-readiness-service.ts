/**
 * Impure loader for the campaign publication-readiness resolver.
 *
 * Loads the persisted campaign, business, outputs and approvals from the
 * database and delegates to the pure resolver. This keeps the resolver itself
 * testable without a database, while the routers/runner get a one-call guard.
 */

import { eq, and } from "drizzle-orm";
import { campaigns, businesses, contentPosts, campaignAssets, generatedImages, approvalRequests } from "@db/schema";
import { TRPCError } from "@trpc/server";
import {
  resolveCampaignPublicationReadiness,
  assertCampaignPublicationReadiness,
  type CampaignPublicationReadiness,
} from "./publication-readiness";

export interface LoadAndResolveCampaignPublicationReadinessInput {
  db: any;
  userId: number;
  campaignId: number;
  selectedOutput?: {
    record: unknown;
    type: "content_post" | "campaign_asset" | "generated_image";
  };
  /**
   * When true, single-item paths (publish, schedule, mark posted) also require an
   * approved campaign_launch approval. Pass false for the queue-item approval
   * step so it does not deadlock.
   */
  requireLaunchApproval?: boolean;
}

export async function loadAndResolveCampaignPublicationReadiness({
  db,
  userId,
  campaignId,
  selectedOutput,
  requireLaunchApproval,
}: LoadAndResolveCampaignPublicationReadinessInput): Promise<CampaignPublicationReadiness> {
  const [campaign] = await db
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.userId, userId)))
    .limit(1);

  if (!campaign) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Campaign not found" });
  }

  let business: any = null;
  if (campaign?.businessId) {
    [business] = await db
      .select()
      .from(businesses)
      .where(eq(businesses.id, campaign.businessId))
      .limit(1);
  }

  const [contentPostsRows, campaignAssetsRows, generatedImagesRows, approvalsRows] = await Promise.all([
    db.select().from(contentPosts).where(and(eq(contentPosts.userId, userId), eq(contentPosts.campaignId, campaignId))),
    db.select().from(campaignAssets).where(and(eq(campaignAssets.userId, userId), eq(campaignAssets.campaignId, campaignId))),
    db.select().from(generatedImages).where(and(eq(generatedImages.userId, userId), eq(generatedImages.campaignId, campaignId))),
    db.select().from(approvalRequests).where(and(eq(approvalRequests.userId, userId), eq(approvalRequests.campaignId, campaignId))),
  ]);

  return resolveCampaignPublicationReadiness({
    campaign,
    business,
    contentPosts: contentPostsRows,
    campaignAssets: campaignAssetsRows,
    generatedImages: generatedImagesRows,
    approvals: approvalsRows,
    selectedOutput,
    requireLaunchApproval,
  });
}

export async function loadAndAssertCampaignPublicationReadiness(
  input: LoadAndResolveCampaignPublicationReadinessInput
): Promise<void> {
  const result = await loadAndResolveCampaignPublicationReadiness(input);
  assertCampaignPublicationReadiness(result);
}
