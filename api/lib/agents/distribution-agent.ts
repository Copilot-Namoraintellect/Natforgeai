import { z } from "zod";
import { runAgent } from "./runner";
import { getDb } from "../../queries/connection";
import { campaigns, contentPosts, publishingQueue, approvalRequests } from "@db/schema";
import { eq, and } from "drizzle-orm";
import { checkContentSafety } from "../safety/checker";
import { resolvePublicationSchedule } from "../publish/publication-schedule";

export const PublishingScheduleSchema = z.object({
  schedule: z.array(
    z.object({
      contentPostId: z.number(),
      platform: z.string(),
      scheduledAt: z.string(), // ISO datetime
      reason: z.string(),
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
  // Capture one authoritative scheduling reference for both model grounding
  // and deterministic canonical publication validation.
  const schedulingReference = new Date();
  const schedulingReferenceIso = schedulingReference.toISOString();

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
      `You are a social media scheduling expert.
Authoritative scheduling reference instant: ${schedulingReferenceIso}.
Every scheduledAt value MUST represent an instant at or after this reference instant.
Never generate a publication timestamp before this reference instant.
You understand optimal posting times, platform algorithms, and content distribution strategies. Always respond with valid structured data.`,
  });

  // Create publishing queue entries with safety checks and deterministic approval mode
  const createdIds: number[] = [];
  let campaignContentApprovalRequired = false;
  let campaignContentApprovalRisk: "low" | "medium" = "low";
  for (const item of scheduleResult.output.schedule) {
    const post = posts.find((p) => p.id === item.contentPostId);
    const content = `${post?.hook || ""}\n${post?.caption || ""}\n${post?.cta || ""}`.trim();

    // WBS13.2: the declared schedule resolves through the canonical schedule
    // authority BEFORE the queue row is inserted. Explicit-offset instants
    // only — server-local implicit Date parsing is never used for a governed
    // scheduled publication — and the resolved canonical UTC instant is what
    // is persisted.
    const schedule = resolvePublicationSchedule({
      mode: "scheduled",
      scheduledAtUtc: item.scheduledAt,
    }, { now: schedulingReference });
    const canonicalScheduledAt = new Date(schedule.scheduledAtUtcMillis!);

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
      scheduledAt: canonicalScheduledAt,
      status,
      approvalRequired,
      safetyStatus: safety.riskLevel,
      safetyReasons: safety.reasons as any,
      maxRetries: 3,
      retryCount: 0,
    });
    createdIds.push(Number(result.insertId));

    // Record campaign-scoped human approval authority for any queue
    // item that has entered pending_approval. Resolution intentionally
    // governs the campaign's pending publishing rows as one decision.
    if (status === "pending_approval") {
      campaignContentApprovalRequired = true;
      if (safety.riskLevel === "medium") {
        campaignContentApprovalRisk = "medium";
      }
    }
  }

  if (campaignContentApprovalRequired) {
    const existingBrandRiskApproval = await db
      .select()
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.userId, userId),
          eq(approvalRequests.campaignId, campaignId),
          eq(approvalRequests.approvalType, "brand_risk"),
          eq(approvalRequests.status, "pending")
        )
      )
      .limit(1);

    if (existingBrandRiskApproval.length === 0) {
      await db.insert(approvalRequests).values({
        userId,
        campaignId,
        approvalType: "brand_risk",
        title: "Content Approval Required",
        description:
          "One or more scheduled posts require human approval before publication.",
        aiRecommendation:
          "Review the campaign's pending scheduled content before approving publication.",
        riskLevel: campaignContentApprovalRisk,
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
