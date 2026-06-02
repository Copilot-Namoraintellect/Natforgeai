import { z } from "zod";
import { runAgent } from "./runner";
import { getDb } from "../../queries/connection";
import { campaigns, contentPosts, publishingQueue, approvalRequests } from "@db/schema";
import { eq, and } from "drizzle-orm";
import { checkContentSafety } from "../safety/checker";

const PublishingScheduleSchema = z.object({
  schedule: z.array(
    z.object({
      contentPostId: z.number(),
      platform: z.string(),
      scheduledAt: z.string(), // ISO datetime
      reason: z.string().optional(),
    })
  ),
});

export type PublishingScheduleOutput = z.infer<typeof PublishingScheduleSchema>;

export async function runDistributionAgent({
  userId,
  campaignId,
  approvalMode,
}: {
  userId: number;
  campaignId: number;
  approvalMode: "assisted" | "autonomous";
}) {
  const db = getDb();

  // Get campaign info
  const [campaign] = await db
    .select()
    .from(campaigns)
    .where(eq(campaigns.id, campaignId))
    .limit(1);

  if (!campaign) {
    throw new Error("Campaign not found");
  }

  // Get all content posts for this campaign
  const posts = await db
    .select()
    .from(contentPosts)
    .where(and(eq(contentPosts.campaignId, campaignId), eq(contentPosts.userId, userId)));

  if (posts.length === 0) {
    throw new Error("No content posts found for this campaign");
  }

  const strategyContext = campaign.workflowContext as any;

  // Build distribution schedule
  const schedulePrompt = `You are a publishing and distribution expert. Create an optimized publishing schedule for the following content.

CAMPAIGN:
- Name: ${campaign.name}
- Goal: ${campaign.goal}
- Platforms: ${campaign.platforms || "Not specified"}
- Approval Mode: ${approvalMode}

CONTENT POSTS:
${posts.map((p) => `- ID ${p.id}: ${p.title} (${p.platform}, ${p.type})`).join("\n")}

${strategyContext?.platformStrategy ? `Platform Strategy: ${JSON.stringify(strategyContext.platformStrategy)}` : ""}

Create a publishing schedule that:
- Spaces posts optimally (avoid spam, maximize engagement)
- Considers platform-specific best posting times
- Staggers content across platforms for maximum reach
- Batches similar content types together

Respond with structured data containing the schedule.`;

  const scheduleResult = await runAgent({
    userId,
    campaignId,
    agentType: "distribution",
    prompt: schedulePrompt,
    schema: PublishingScheduleSchema,
    system:
      "You are a social media scheduling expert. You understand optimal posting times, platform algorithms, and content distribution strategies. Always respond with valid structured data.",
  });

  // Create publishing queue entries with safety checks and deterministic approval mode
  const createdIds: number[] = [];
  for (const item of scheduleResult.output.schedule) {
    const post = posts.find((p) => p.id === item.contentPostId);
    const content = `${post?.hook || ""}\n${post?.caption || ""}\n${post?.cta || ""}`.trim();

    // Run content safety check (bundled into distribution agent cost)
    const safety = await checkContentSafety(content, {
      brandTone: (campaign.workflowContext as any)?.brandTone,
      industry: strategyContext?.industry,
    }, {
      userId,
      campaignId,
      skipDeduction: true,
    });

    // Determine status based on safety + approval mode
    let status: "draft" | "pending_approval" | "approved" | "safety_blocked" = "approved";
    let approvalRequired = false;

    if (safety.riskLevel === "high") {
      status = "safety_blocked";
      approvalRequired = true;
    } else if (safety.riskLevel === "medium") {
      status = "pending_approval";
      approvalRequired = true;
    } else if (approvalMode === "assisted") {
      status = "pending_approval";
      approvalRequired = true;
    }
    // autonomous + low risk = approved (default)

    const [result] = await db.insert(publishingQueue).values({
      userId,
      campaignId,
      contentPostId: item.contentPostId,
      platform: item.platform,
      scheduledAt: new Date(item.scheduledAt),
      status,
      approvalRequired,
      safetyStatus: safety.riskLevel,
      safetyReasons: safety.reasons as any,
      maxRetries: 3,
      retryCount: 0,
    });
    createdIds.push(Number(result.insertId));

    // Create approval request for medium-risk posts in autonomous mode
    if (safety.riskLevel === "medium" && approvalMode === "autonomous") {
      await db.insert(approvalRequests).values({
        userId,
        campaignId,
        approvalType: "brand_risk",
        title: `Content Safety Review: ${post?.title || "Post"}`,
        description: `A post scheduled for ${item.platform} was flagged with medium risk.\n\nReasons: ${safety.reasons.join("; ")}\n\nSuggested fixes: ${safety.suggestedFixes.join("; ")}`,
        aiRecommendation: "Review content before approving. Risks are manageable but require human verification.",
        riskLevel: "medium",
      });
    }
  }

  // Update campaign workflow state
  await db
    .update(campaigns)
    .set({
      workflowState: "schedule_generated",
      workflowContext: {
        ...(strategyContext || {}),
        scheduleGeneratedAt: new Date().toISOString(),
        distributionRunId: scheduleResult.runId,
        scheduledPosts: createdIds.length,
      } as any,
    })
    .where(eq(campaigns.id, campaignId));

  return {
    runId: scheduleResult.runId,
    schedule: scheduleResult.output,
    queueIds: createdIds,
  };
}
