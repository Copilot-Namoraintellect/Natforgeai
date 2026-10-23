import { z } from "zod";
import { runAgent } from "./runner";
import { getDb } from "../../queries/connection";
import { campaigns, contentPosts, publishingQueue, approvalRequests, agentRuns } from "@db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { checkContentSafety } from "../safety/checker";
import { resolvePublicationSchedule } from "../publish/publication-schedule";
import {
  readCreativeReleasePackageForDistribution,
  selectReleasedContentPostIds,
} from "../publish/creative-release-consumer";

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

/**
 * Platforms eligible for distribution planning. Mirrors the auto-publish
 * boundary (content-router AUTO_PUBLISH_PLATFORMS): anything outside this set
 * has no publishing path and must never become an executable queue row.
 */
export const DISTRIBUTION_PLATFORMS = [
  "facebook",
  "instagram",
  "linkedin",
  "twitter",
  "tiktok",
  "email",
] as const;

const DISTRIBUTION_PLATFORM_SET = new Set<string>(DISTRIBUTION_PLATFORMS);

export interface DistributionSkippedItem {
  contentPostId?: number;
  platform?: string;
  reason:
    | "unknown_content_post"
    | "unsupported_platform"
    | "duplicate_live_queue_row"
    | "outside_release_package";
}

export async function runDistributionAgent({
  userId,
  campaignId,
  approvalMode,
  billingIdentity,
}: {
  userId: number;
  campaignId: number;
  approvalMode: "assisted" | "autonomous";
  /**
   * Caller-stable billing identity minted at the workflow trigger boundary.
   * Passed to the keyed runner deduction so retries of this logical step
   * never double-charge.
   */
  billingIdentity?: string;
}) {
  const db = getDb();

  // Get campaign info — owner-scoped: a campaign owned by another user is
  // invisible (strict tenant isolation, WBS-R4 security mandate).
  const [campaign] = await db
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.userId, userId)))
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

  const strategyContext = (campaign.workflowContext || {}) as Record<string, unknown>;

  // ─── Keyed idempotent-replay guard (WBS-R4 C2 duplicate trigger) ───
  // A keyed dispatch records its billing identity beside the durable plan
  // coordinates. A replayed/restarted trigger for the SAME logical operation
  // returns the already-authoritative plan without a second LLM run, a second
  // set of queue rows, or a second charge. Unkeyed (manual) invocations never
  // match and always execute.
  if (billingIdentity) {
    const recordedKey = strategyContext.distributionBillingKey;
    const recordedRunId = strategyContext.distributionRunId;
    if (recordedKey === billingIdentity && Number.isInteger(recordedRunId)) {
      const [recordedRun] = await db
        .select()
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.id, recordedRunId as number),
            eq(agentRuns.userId, userId),
            eq(agentRuns.campaignId, campaignId),
            eq(agentRuns.agentType, "distribution")
          )
        )
        .limit(1);
      if (recordedRun && recordedRun.status === "completed") {
        // The durable plan rows are the authority; re-select them.
        const planRows = await db
          .select({ id: publishingQueue.id })
          .from(publishingQueue)
          .where(
            and(
              eq(publishingQueue.userId, userId),
              eq(publishingQueue.campaignId, campaignId),
              inArray(publishingQueue.status, [
                "draft",
                "pending_approval",
                "approved",
                "retrying",
                "safety_blocked",
                "published",
              ])
            )
          );
        return {
          runId: recordedRunId as number,
          schedule: [] as PublishingScheduleOutput["schedule"],
          queueIds: planRows.map((r) => r.id),
          replayed: true,
          skipped: [] as DistributionSkippedItem[],
        };
      }
    }
  }

  // ─── Governed creative release consumption (CREATIVE_TO_DISTRIBUTION_CONTRACT §3/§5) ───
  // A sealed, intact release package constrains WHICH content posts may be
  // scheduled (selection/validation only). Absent or malformed package reads
  // as not released and the existing per-item gates remain authoritative.
  const release = readCreativeReleasePackageForDistribution({
    campaignId,
    userId,
    workflowContext: campaign.workflowContext,
  });
  const releasedPostIds =
    release.status === "released" ? new Set(selectReleasedContentPostIds(release.package)) : null;

  // Existing live queue rows for this campaign — a schedule item that already
  // has a live row (any non-failed state) is not re-inserted, so duplicate
  // triggers cannot duplicate executable publications.
  const existingRows = await db
    .select({
      contentPostId: publishingQueue.contentPostId,
      platform: publishingQueue.platform,
      status: publishingQueue.status,
    })
    .from(publishingQueue)
    .where(and(eq(publishingQueue.userId, userId), eq(publishingQueue.campaignId, campaignId)));
  const liveRowKeys = new Set(
    existingRows
      .filter(
        (r) =>
          r.contentPostId !== null &&
          r.platform !== null &&
          r.status !== null &&
          r.status !== "failed"
      )
      .map((r) => `${r.contentPostId}:${r.platform}`)
  );

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
    ...(billingIdentity ? { billingIdempotencyKey: billingIdentity } : {}),
  });

  // Create publishing queue entries with safety checks and deterministic approval mode
  const createdIds: number[] = [];
  const skipped: DistributionSkippedItem[] = [];
  for (const item of scheduleResult.output.schedule) {
    // LLM output is untrusted: the post id must resolve to a content post
    // owned by this user and campaign, otherwise no row is created.
    const post = posts.find((p) => p.id === item.contentPostId);
    if (!post) {
      skipped.push({ contentPostId: item.contentPostId, platform: item.platform, reason: "unknown_content_post" });
      continue;
    }
    // Platform eligibility: platforms with no publishing path must never
    // become executable queue rows.
    if (!DISTRIBUTION_PLATFORM_SET.has(item.platform)) {
      skipped.push({ contentPostId: item.contentPostId, platform: item.platform, reason: "unsupported_platform" });
      continue;
    }
    // Duplicate live row: a live (non-failed) queue row already targets this
    // post+platform — the existing durable row stays authoritative.
    if (liveRowKeys.has(`${item.contentPostId}:${item.platform}`)) {
      skipped.push({ contentPostId: item.contentPostId, platform: item.platform, reason: "duplicate_live_queue_row" });
      continue;
    }
    // Governed creative release: when a sealed package is released for this
    // campaign, only its bundled content_post artefacts may be scheduled
    // (contract §3/§5 — the release selects and validates content).
    if (releasedPostIds && !releasedPostIds.has(item.contentPostId)) {
      skipped.push({ contentPostId: item.contentPostId, platform: item.platform, reason: "outside_release_package" });
      continue;
    }

    const content = `${post?.hook || ""}\n${post?.caption || ""}\n${post?.cta || ""}`.trim();

    // WBS13.2: the declared schedule resolves through the canonical schedule
    // authority BEFORE the queue row is inserted. Explicit-offset instants
    // only — server-local implicit Date parsing is never used for a governed
    // scheduled publication — and the resolved canonical UTC instant is what
    // is persisted.
    const schedule = resolvePublicationSchedule({
      mode: "scheduled",
      scheduledAtUtc: item.scheduledAt,
    });
    const canonicalScheduledAt = new Date(schedule.scheduledAtUtcMillis!);

    // Run content safety check (bundled into distribution agent cost)
    const safety = await checkContentSafety(content, {
      brandTone: (campaign.workflowContext as any)?.brandTone,
      industry: strategyContext?.industry as string | undefined,
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
    liveRowKeys.add(`${item.contentPostId}:${item.platform}`);

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
        ...(billingIdentity ? { distributionBillingKey: billingIdentity } : {}),
        ...(skipped.length > 0 ? { distributionSkipped: skipped } : {}),
      } as any,
    })
    .where(eq(campaigns.id, campaignId));

  return {
    runId: scheduleResult.runId,
    schedule: scheduleResult.output,
    queueIds: createdIds,
    replayed: false,
    skipped,
  };
}
