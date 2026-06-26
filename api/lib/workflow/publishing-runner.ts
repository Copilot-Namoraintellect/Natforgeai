import { getDb } from "../../queries/connection";
import { publishingQueue, contentPosts, socialIntegrations } from "@db/schema";
import { eq, and, lte, or } from "drizzle-orm";
import {
  publishToFacebook,
  publishToInstagram,
  publishToLinkedIn,
  publishToTwitter,
  sendEmail,
} from "../integrations/platforms";
import { decryptToken } from "../crypto";
import { checkContentSafety } from "../safety/checker";
import { deductCredits } from "../billing/credit-engine";
import { createAlert } from "../alerts";
import { rateLimitUser } from "../rate-limiter";
import { ingestAudienceData } from "../audience/ingest";

const RETRY_DELAYS_MS = [60_000, 300_000, 900_000]; // 1min, 5min, 15min

/**
 * Run content safety check on a queue item and update its status.
 */
export async function runSafetyCheckOnQueueItem(queueItemId: number) {
  const db = getDb();

  const [item] = await db
    .select()
    .from(publishingQueue)
    .where(eq(publishingQueue.id, queueItemId))
    .limit(1);

  if (!item || !item.contentPostId) return;

  const [contentPost] = await db
    .select()
    .from(contentPosts)
    .where(eq(contentPosts.id, item.contentPostId))
    .limit(1);

  if (!contentPost) return;

  const content = `${contentPost.hook || ""}\n${contentPost.caption || ""}\n${contentPost.cta || ""}`.trim();

  const safety = await checkContentSafety(content, {}, {
    userId: item.userId,
    campaignId: item.campaignId ?? undefined,
  });

  await db
    .update(publishingQueue)
    .set({
      safetyStatus: safety.riskLevel,
      safetyReasons: safety.reasons as any,
    })
    .where(eq(publishingQueue.id, queueItemId));

  return safety;
}

/**
 * Publish a single queue item.
 * Used by both the cron runner and BullMQ worker.
 */
export async function publishSinglePost(queueItemId: number) {
  const db = getDb();
  const now = new Date();

  const [post] = await db
    .select()
    .from(publishingQueue)
    .where(eq(publishingQueue.id, queueItemId))
    .limit(1);

  if (!post) {
    return { id: queueItemId, status: "not_found", error: "Queue item not found" };
  }

  // Only process approved or retrying items
  if (post.status !== "approved" && post.status !== "retrying") {
    return { id: queueItemId, status: post.status, error: "Not ready for publishing" };
  }

  // Rate limit check
  try {
    await rateLimitUser({ req: new Request("http://localhost"), resHeaders: new Headers(), user: { id: post.userId } as any }, "publish");
  } catch {
    return { id: queueItemId, status: "rate_limited", error: "Publishing rate limit reached" };
  }

  try {
    // Safety check first
    if (!post.safetyStatus) {
      await runSafetyCheckOnQueueItem(post.id);
      const [refreshed] = await db
        .select()
        .from(publishingQueue)
        .where(eq(publishingQueue.id, post.id))
        .limit(1);
      if (!refreshed) {
        return { id: post.id, status: "not_found", error: "Queue item disappeared after safety check" };
      }

      if (refreshed.safetyStatus === "high") {
        await db
          .update(publishingQueue)
          .set({
            status: "safety_blocked",
            lastError: "Content safety check failed: high risk",
          })
          .where(eq(publishingQueue.id, post.id));
        return { id: post.id, status: "safety_blocked", platform: post.platform, error: "High risk content blocked by safety check" };
      }

      if (refreshed.safetyStatus === "medium") {
        await db
          .update(publishingQueue)
          .set({
            status: "pending_approval",
            approvalRequired: true,
            lastError: "Content safety check flagged medium risk; awaiting approval",
          })
          .where(eq(publishingQueue.id, post.id));
        return { id: post.id, status: "pending_approval", platform: post.platform, error: "Medium risk content requires approval" };
      }
    } else if (post.safetyStatus === "high") {
      await db
        .update(publishingQueue)
        .set({ status: "safety_blocked" })
        .where(eq(publishingQueue.id, post.id));
      return { id: post.id, status: "safety_blocked", platform: post.platform };
    } else if (post.safetyStatus === "medium" && post.status !== "approved") {
      await db
        .update(publishingQueue)
        .set({ status: "pending_approval", approvalRequired: true })
        .where(eq(publishingQueue.id, post.id));
      return { id: post.id, status: "pending_approval", platform: post.platform };
    }

    // Get the content post
    const [contentPost] = post.contentPostId
      ? await db
          .select()
          .from(contentPosts)
          .where(eq(contentPosts.id, post.contentPostId))
          .limit(1)
      : [null];

    // Get platform integration
    const [integration] = await db
      .select()
      .from(socialIntegrations)
      .where(
        and(
          eq(socialIntegrations.userId, post.userId),
          eq(socialIntegrations.platform, post.platform as any),
          eq(socialIntegrations.status, "connected")
        )
      )
      .limit(1);

    let publishResult: { success: boolean; postId?: string; url?: string; error?: string } = {
      success: false,
      error: "No integration connected",
    };

    if (!integration) {
      await db
        .update(publishingQueue)
        .set({
          status: "failed",
          lastError: `Admin setup required: no connected ${post.platform} account. Connect the platform in Settings > Integrations first.`,
          retryCount: (post.retryCount || 0) + 1,
          nextRetryAt: null,
        })
        .where(eq(publishingQueue.id, post.id));
      return {
        id: post.id,
        status: "failed",
        platform: post.platform,
        error: `Admin setup required: no connected ${post.platform} account. Connect the platform in Settings > Integrations first.`,
      };
    }

    // Deduct publishing credit before attempting publish
    // Skip deduction on retries — credits were already deducted on first attempt
    if (post.status !== "retrying") {
      try {
        await deductCredits({
          userId: post.userId,
          amount: 1,
          type: "publishing_deduction",
          description: `Publish to ${post.platform}`,
          metadata: { queueItemId: post.id, platform: post.platform, attempt: 1 },
        });
      } catch (creditError: any) {
        publishResult = {
          success: false,
          error: `Publishing blocked: ${creditError.message}`,
        };
      }
    }

    if (contentPost && !publishResult.error) {
      const postMeta = (contentPost.metadata || {}) as any;
      const imageUrl: string | undefined =
        postMeta?.imageUrl || (contentPost as any).imageUrl || undefined;

      const payload = {
        text: `${contentPost.hook || ""}\n\n${contentPost.caption || ""}\n\n${contentPost.cta || ""}`.trim(),
        mediaUrls: imageUrl ? [imageUrl] : undefined,
        mediaType: imageUrl ? ("image" as const) : undefined,
      };

      const accessToken = decryptToken(integration.accessTokenEncrypted || "");

      switch (post.platform) {
        case "facebook": {
          const pageToken = integration.pageAccessTokenEncrypted
            ? decryptToken(integration.pageAccessTokenEncrypted)
            : accessToken;
          const pageId = integration.pageId || integration.accountName || "me";
          publishResult = await publishToFacebook(pageToken, pageId, payload);
          break;
        }
        case "instagram":
          publishResult = await publishToInstagram(
            accessToken,
            integration.accountName || "",
            payload
          );
          break;
        case "linkedin":
          publishResult = await publishToLinkedIn(
            accessToken,
            integration.accountName || "",
            payload
          );
          break;
        case "twitter":
          publishResult = await publishToTwitter(accessToken, payload);
          break;
        case "whatsapp":
          publishResult = {
            success: false,
            error: "WhatsApp requires a recipient. Use the conversation inbox to send messages.",
          };
          break;
        case "email":
          publishResult = await sendEmail(
            {
              fromEmail: integration.accountName || "noreply@natforgeai.com",
              fromName: "NatForge AI",
            },
            "",
            contentPost.title || "Marketing Update",
            payload.text
          );
          break;
        default:
          publishResult = { success: false, error: `Platform ${post.platform} not supported` };
      }
    }

    // Update queue status
    if (publishResult.success) {
      await db
        .update(publishingQueue)
        .set({
          status: "published",
          publishedAt: now,
          externalPostId: publishResult.postId || null,
          lastError: null,
          retryCount: 0,
          nextRetryAt: null,
        })
        .where(eq(publishingQueue.id, post.id));

      if (post.contentPostId) {
        await db
          .update(contentPosts)
          .set({
            status: "published",
            publishedAt: now,
          })
          .where(eq(contentPosts.id, post.contentPostId));
      }

      // Refresh permissioned audience data after a successful publish so that
      // engagement and performance signals can feed back into Audience Intelligence.
      ingestAudienceData({ userId: post.userId, businessId: null, campaignId: post.campaignId }).catch((err: any) => {
        console.error(`[Publishing Runner] Post-publish audience ingestion failed for campaign ${post.campaignId}:`, err.message);
      });
    } else {
      // Retry logic
      const retryCount = (post.retryCount || 0) + 1;
      const maxRetries = post.maxRetries || 3;

      if (retryCount >= maxRetries) {
        await db
          .update(publishingQueue)
          .set({
            status: "failed",
            retryCount,
            lastError: publishResult.error || "Unknown error",
            nextRetryAt: null,
          })
          .where(eq(publishingQueue.id, post.id));

        await createAlert({
          severity: "warning",
          category: "publishing",
          message: `Publishing failed after ${maxRetries} retries for ${post.platform}`,
          details: { queueItemId: post.id, platform: post.platform, error: publishResult.error },
        });
      } else {
        const delay = RETRY_DELAYS_MS[Math.min(retryCount - 1, RETRY_DELAYS_MS.length - 1)];
        const nextRetryAt = new Date(now.getTime() + delay);

        await db
          .update(publishingQueue)
          .set({
            status: "retrying",
            retryCount,
            lastError: publishResult.error || "Unknown error",
            nextRetryAt,
          })
          .where(eq(publishingQueue.id, post.id));
      }
    }

    return {
      id: post.id,
      status: publishResult.success ? "published" : (post.retryCount || 0) + 1 >= (post.maxRetries || 3) ? "failed" : "retrying",
      platform: post.platform,
      error: publishResult.error,
      postId: publishResult.postId,
    };
  } catch (error: any) {
    const retryCount = (post.retryCount || 0) + 1;
    const maxRetries = post.maxRetries || 3;

    if (retryCount >= maxRetries) {
      await db
        .update(publishingQueue)
        .set({
          status: "failed",
          retryCount,
          lastError: error.message || "Unknown error",
          nextRetryAt: null,
        })
        .where(eq(publishingQueue.id, post.id));

      await createAlert({
        severity: "warning",
        category: "publishing",
        message: `Publishing crashed after ${maxRetries} retries for ${post.platform}`,
        details: { queueItemId: post.id, platform: post.platform, error: error.message },
      });
    } else {
      const delay = RETRY_DELAYS_MS[Math.min(retryCount - 1, RETRY_DELAYS_MS.length - 1)];
      const nextRetryAt = new Date(now.getTime() + delay);

      await db
        .update(publishingQueue)
        .set({
          status: "retrying",
          retryCount,
          lastError: error.message || "Unknown error",
          nextRetryAt,
        })
        .where(eq(publishingQueue.id, post.id));
    }

    return {
      id: post.id,
      status: retryCount >= maxRetries ? "failed" : "retrying",
      error: error.message,
      platform: post.platform,
    };
  }
}

/**
 * Publishes all due posts from the publishing queue.
 * Legacy cron-based approach — still available for manual triggers and dev fallback.
 */
export async function publishDuePosts() {
  const db = getDb();
  const now = new Date();

  const duePosts = await db
    .select()
    .from(publishingQueue)
    .where(
      and(
        or(
          eq(publishingQueue.status, "approved"),
          eq(publishingQueue.status, "retrying")
        ),
        or(
          lte(publishingQueue.scheduledAt, now),
          and(
            eq(publishingQueue.status, "retrying"),
            lte(publishingQueue.nextRetryAt, now)
          )
        )
      )
    );

  const results = [];
  for (const post of duePosts) {
    const result = await publishSinglePost(post.id);
    results.push(result);
  }

  return results;
}

/**
 * Starts the publishing runner interval.
 * Checks for due posts every 60 seconds.
 * In production, use BullMQ worker instead.
 */
export function startPublishingRunner() {
  console.log("[Publishing Runner] Started - checking every 60 seconds");

  setInterval(async () => {
    try {
      const results = await publishDuePosts();
      if (results.length > 0) {
        const published = results.filter((r) => r.status === "published").length;
        const failed = results.filter((r) => r.status === "failed").length;
        const retrying = results.filter((r) => r.status === "retrying").length;
        const blocked = results.filter((r) => r.status === "safety_blocked").length;
        console.log(
          `[Publishing Runner] Published: ${published}, Failed: ${failed}, Retrying: ${retrying}, Safety Blocked: ${blocked}`
        );
        for (const r of results) {
          if (r.error) {
            console.log(`[Publishing Runner] Error for ${r.platform}: ${r.error}`);
          }
        }
      }
    } catch (error) {
      console.error("[Publishing Runner] Error:", error);
    }
  }, 60000);
}
