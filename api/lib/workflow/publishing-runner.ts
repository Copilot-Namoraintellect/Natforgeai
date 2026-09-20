import { getDb } from "../../queries/connection";
import { publishingQueue, contentPosts, socialIntegrations, campaigns } from "@db/schema";
import { eq, and, lte, or } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { transitionCampaignState } from "./engine";
import { createAuditEvent } from "../audit/audit-event";
import { persistAuditEvent } from "../audit/audit-store";
import {
  publishToFacebook,
  publishToInstagram,
  publishToLinkedIn,
  publishToTwitter,
  sendEmail,
} from "../integrations/platforms";
import { decryptToken } from "../crypto";
import { resolvePublicImageUrl } from "../media/url";
import { env } from "../env";
import { checkContentSafety } from "../safety/checker";
import { deductCredits } from "../billing/credit-engine";
import { createAlert } from "../alerts";
import { rateLimitUser } from "../rate-limiter";
import { ingestAudienceData } from "../audience/ingest";
import { loadAndAssertPublicationReadiness } from "../creative/publication-readiness-service";

const RETRY_DELAYS_MS = [60_000, 300_000, 900_000]; // 1min, 5min, 15min

type PublicationAuditEventType = "publication_attempt" | "publication_success" | "publication_failure";
type PublicationFailureStage = "billing" | "provider" | "runtime" | "precondition" | "integration" | "media";

/**
 * Build one canonical publication audit event. Only governed, non-sensitive
 * facts are ever placed in metadata: no content body, caption, token,
 * integration secret, provider response, or raw error text.
 */
function buildPublicationAuditEvent(input: {
  eventType: PublicationAuditEventType;
  occurredAt: string;
  queueItem: {
    id: number;
    userId: number;
    campaignId: number | null;
    contentPostId: number | null;
    platform: string;
  };
  businessId: number | null;
  attemptOrdinal: number;
  outcome: "succeeded" | "failed";
  metadata: Record<string, unknown>;
}) {
  return createAuditEvent({
    eventType: input.eventType,
    occurredAt: input.occurredAt,
    userId: input.queueItem.userId,
    source: "workflow",
    outcome: input.outcome,
    campaignId: input.queueItem.campaignId ?? null,
    businessId: input.businessId,
    contentId: input.queueItem.contentPostId ?? null,
    workflowOperationId: null,
    workflowAttemptId: null,
    approvalRequestId: null,
    artifactId: null,
    packageId: null,
    metadata: {
      queueItemId: input.queueItem.id,
      platform: input.queueItem.platform,
      attemptOrdinal: input.attemptOrdinal,
      ...input.metadata,
    },
  });
}

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
 * Finalize campaign and content-post state after queue items change.
 * When every queue row for the campaign is published, mark the campaign as
 * campaign_live and update content post metadata with per-platform IDs.
 */
export async function finalizeCampaignPublishState(campaignId: number | null | undefined) {
  if (!campaignId) return;
  const db = getDb();

  const [campaign] = await db
    .select()
    .from(campaigns)
    .where(eq(campaigns.id, campaignId))
    .limit(1);
  if (!campaign) return;

  const queueRows = await db
    .select()
    .from(publishingQueue)
    .where(eq(publishingQueue.campaignId, campaignId));
  if (queueRows.length === 0) return;

  const allPublished = queueRows.every((q) => q.status === "published");

  const publishedPlatforms: string[] = [];
  const failedPlatforms: string[] = [];
  const pendingApprovalPlatforms: string[] = [];
  const platformPostIds: Record<string, string> = {};

  for (const q of queueRows) {
    const platform = String(q.platform || "").trim().toLowerCase();
    if (!platform) continue;
    if (q.status === "published") {
      publishedPlatforms.push(platform);
      if (q.externalPostId) {
        platformPostIds[`${platform}PostId`] = q.externalPostId;
      }
    } else if (q.status === "failed" || q.status === "safety_blocked") {
      failedPlatforms.push(platform);
    } else if (q.status === "pending_approval") {
      pendingApprovalPlatforms.push(platform);
    }
  }

  const contentPostIds = [...new Set(queueRows.map((q) => q.contentPostId).filter(Boolean))];
  for (const postId of contentPostIds) {
    const [post] = await db
      .select()
      .from(contentPosts)
      .where(eq(contentPosts.id, postId as number))
      .limit(1);
    if (!post) continue;

    const meta = (post.metadata || {}) as any;
    const updateSet: any = {
      metadata: {
        ...meta,
        publishedPlatforms,
        failedPlatforms,
        pendingApprovalPlatforms,
        ...platformPostIds,
      },
    };
    if (allPublished) {
      updateSet.status = "published";
      updateSet.publishedAt = new Date();
    }

    await db
      .update(contentPosts)
      .set(updateSet)
      .where(eq(contentPosts.id, postId as number));
  }

  if (allPublished && campaign.workflowState === "publication_pending") {
    // Approval authorises publication; actual publication completion is the
    // authority for the campaign_live transition.
    await transitionCampaignState(campaignId, campaign.userId, "go_live");

    await db
      .update(campaigns)
      .set({
        status: "active",
        updatedAt: new Date(),
      })
      .where(eq(campaigns.id, campaignId));

    // G-04 fail-closed: never convert a pending campaign_launch approval into
    // an approval decision here. Approval authority must come from an explicit
    // human decision recorded through the approval router only.
  } else if (allPublished && campaign.workflowState === "campaign_live") {
    // Idempotent finalization for a campaign that is already live.
    await db
      .update(campaigns)
      .set({
        status: "active",
        updatedAt: new Date(),
      })
      .where(eq(campaigns.id, campaignId));
  }
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

  // Load content post early so the Phase 2B readiness gate runs before any side effect.
  const [contentPost] = post.contentPostId
    ? await db
        .select()
        .from(contentPosts)
        .where(eq(contentPosts.id, post.contentPostId))
        .limit(1)
    : [null];

  // Publication-authority gate for every content-bound item, before any side
  // effect: campaign-linked content requires the campaign_launch approval;
  // standalone content has no authority model and fails closed.
  if (contentPost) {
    try {
      await loadAndAssertPublicationReadiness({
        db,
        userId: post.userId,
        campaignId: contentPost.campaignId ?? null,
        selectedOutput: { record: contentPost, type: "content_post" },
        requireLaunchApproval: true,
      });
    } catch (err: any) {
      const message = err instanceof TRPCError ? err.message : "Publication readiness check failed";
      // Phase 2B side-effect contract for a permanent readiness rejection:
      // - No external platform call, credit mutation, published/scheduled state,
      //   campaign-live transition, or success audit has occurred yet, and no
      //   publication_attempt is fabricated: the controlled-attempt boundary
      //   was never reached.
      // - The only permitted mutation is an idempotent update of this queue row
      //   to failed/blocked with a safe reason, so the worker can surface an
      //   UnrecoverableError to BullMQ and stop retrying a non-transient failure.
      //   It commits together with one canonical publication_failure event.
      await db.transaction(async (tx) => {
        await tx
          .update(publishingQueue)
          .set({
            status: "failed",
            lastError: message,
            retryCount: post.maxRetries || 3,
            nextRetryAt: null,
          })
          .where(eq(publishingQueue.id, post.id));

        await persistAuditEvent(
          buildPublicationAuditEvent({
            eventType: "publication_failure",
            occurredAt: new Date().toISOString(),
            queueItem: post,
            businessId: null,
            attemptOrdinal: (post.retryCount || 0) + 1,
            outcome: "failed",
            metadata: { terminal: true, nextState: "failed", failureStage: "precondition" },
          }),
          tx
        );
      });
      return {
        id: post.id,
        status: "precondition_failed",
        platform: post.platform,
        error: message,
      };
    }
  }

  // Rate limit check
  try {
    await rateLimitUser({ req: new Request("http://localhost"), resHeaders: new Headers(), user: { id: post.userId } as any }, "publish");
  } catch {
    return { id: queueItemId, status: "rate_limited", error: "Publishing rate limit reached" };
  }

  // Set when the provider reported success but local success evidence has
  // not committed yet; the catch block must then propagate rather than
  // fabricate a failure decision for an external effect that may exist.
  let providerSucceeded = false;

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

      // Medium-risk content normally requires approval. If the item has already
      // been explicitly approved (e.g. through the approval/retry flow), trust
      // that decision and allow publishing to proceed.
      if (refreshed.safetyStatus === "medium" && refreshed.status !== "approved") {
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

    // Content post was loaded before the readiness gate; reuse it here.
    const postMeta = contentPost ? (contentPost.metadata || {}) as any : {};

    // Get platform integration
    let integration: typeof socialIntegrations.$inferSelect | undefined;

    if (post.integrationId) {
      const [byId] = await db
        .select()
        .from(socialIntegrations)
        .where(
          and(
            eq(socialIntegrations.id, post.integrationId),
            eq(socialIntegrations.userId, post.userId)
          )
        )
        .limit(1);
      integration = byId;
    }

    if (!integration) {
      const [byPlatform] = await db
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
      integration = byPlatform;
    }

    let publishResult: { success: boolean; postId?: string; url?: string; error?: string } = { success: false };

    if (!integration) {
      const error = `Admin setup required: no connected ${post.platform} account. Connect the platform in Settings > Integrations first.`;
      await db.transaction(async (tx) => {
        await tx
          .update(publishingQueue)
          .set({
            status: "failed",
            lastError: error,
            retryCount: (post.retryCount || 0) + 1,
            nextRetryAt: null,
          })
          .where(eq(publishingQueue.id, post.id));

        await persistAuditEvent(
          buildPublicationAuditEvent({
            eventType: "publication_failure",
            occurredAt: new Date().toISOString(),
            queueItem: post,
            businessId: null,
            attemptOrdinal: (post.retryCount || 0) + 1,
            outcome: "failed",
            metadata: { terminal: true, nextState: "failed", failureStage: "integration" },
          }),
          tx
        );
      });
      return {
        id: post.id,
        status: "failed",
        platform: post.platform,
        error,
      };
    }

    // Build content payload
    const imageUrl: string | undefined =
      postMeta?.imageUrl || (contentPost as any)?.imageUrl || undefined;

    const payload = contentPost
      ? {
          text: `${contentPost.hook || ""}\n\n${contentPost.caption || ""}\n\n${contentPost.cta || ""}`.trim(),
          mediaUrls: imageUrl ? [imageUrl] : undefined,
          mediaType: imageUrl ? ("image" as const) : undefined,
        }
      : null;

    // For Facebook, validate/normalize the media URL before charging credits
    if (post.platform === "facebook" && payload?.mediaUrls?.[0]) {
      const { publicUrl: publicImageUrl, isAbsoluteUrl } = resolvePublicImageUrl(
        payload.mediaUrls[0],
        env.publicAppUrl
      );
      const publishMode = publicImageUrl ? "photo" : "text";

      console.log("[Publishing Runner] Facebook media", {
        queueItemId: post.id,
        contentPostId: post.contentPostId,
        rawImageUrl: imageUrl,
        publicImageUrl,
        isAbsoluteUrl,
        publishMode,
      });

      if (!publicImageUrl) {
        const error = "Facebook publishing failed: invalid image URL.";
        await db.transaction(async (tx) => {
          await tx
            .update(publishingQueue)
            .set({
              status: "failed",
              lastError: error,
              retryCount: (post.retryCount || 0) + 1,
              nextRetryAt: null,
            })
            .where(eq(publishingQueue.id, post.id));

          await persistAuditEvent(
            buildPublicationAuditEvent({
              eventType: "publication_failure",
              occurredAt: new Date().toISOString(),
              queueItem: post,
              businessId: null,
              attemptOrdinal: (post.retryCount || 0) + 1,
              outcome: "failed",
              metadata: { terminal: true, nextState: "failed", failureStage: "media" },
            }),
            tx
          );
        });
        return { id: post.id, status: "failed", platform: post.platform, error };
      }

      payload.mediaUrls = [publicImageUrl];
    }

    // ── Durable attempt evidence (WBS7C3) ─────────────────────────────
    // Every gate establishing a genuine controlled publication attempt has
    // now passed. Record publication_attempt BEFORE any credit mutation,
    // credential decryption, or provider call, so a provider side effect can
    // never occur without durable attempt evidence. If this persistence
    // fails it flows to the governed runtime-failure path below: no credit
    // mutation, no credential decryption, no provider call.
    const attemptOrdinal = (post.retryCount || 0) + 1;
    const [attemptCampaign] = post.campaignId
      ? await db
          .select()
          .from(campaigns)
          .where(and(eq(campaigns.id, post.campaignId), eq(campaigns.userId, post.userId)))
          .limit(1)
      : [null];
    const publicationBusinessId = attemptCampaign?.businessId ?? null;

    await persistAuditEvent(
      buildPublicationAuditEvent({
        eventType: "publication_attempt",
        occurredAt: new Date().toISOString(),
        queueItem: post,
        businessId: publicationBusinessId,
        attemptOrdinal,
        outcome: "succeeded",
        metadata: { queueStatusAtAttempt: post.status },
      })
    );

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

    if (payload && !publishResult.error) {
      const accessToken = decryptToken(integration.accessTokenEncrypted || "");

      console.log("[Publishing Runner] Publishing", {
        queueItemId: post.id,
        campaignId: post.campaignId,
        platform: post.platform,
        integrationId: integration.id,
        loadedIntegrationFound: true,
        loadedIntegrationPlatform: integration.platform,
        loadedIntegrationStatus: integration.status,
        pageId: post.platform === "facebook" ? (integration.pageId || integration.accountName || "me") : undefined,
        hasPageAccessToken: post.platform === "facebook" ? !!integration.pageAccessTokenEncrypted : undefined,
      });

      switch (post.platform) {
        case "facebook": {
          const pageToken = integration.pageAccessTokenEncrypted
            ? decryptToken(integration.pageAccessTokenEncrypted)
            : accessToken;
          const pageId = integration.pageId || integration.accountName || "me";
          publishResult = await publishToFacebook(pageToken, pageId, payload);
          break;
        }
        case "instagram": {
          if (!integration.instagramBusinessAccountId || !integration.pageAccessTokenEncrypted) {
            publishResult = {
              success: false,
              error:
                "Instagram publishing is not ready. Reconnect Meta and ensure a linked Instagram professional account exists.",
            };
            break;
          }
          const igPageToken = decryptToken(integration.pageAccessTokenEncrypted);
          publishResult = await publishToInstagram(
            igPageToken,
            integration.instagramBusinessAccountId,
            payload
          );
          break;
        }
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
            contentPost?.title || "Marketing Update",
            payload.text
          );
          break;
        default:
          publishResult = { success: false, error: `Platform ${post.platform} not supported` };
      }
    }

    // Update queue status
    if (publishResult.success) {
      // ONE publication-success timestamp shared by publishing_queue.publishedAt
      // and the audit event occurredAt — no independent second clock read.
      const publishedAt = new Date();
      providerSucceeded = true;

      await db.transaction(async (tx) => {
        const updateResult = await tx
          .update(publishingQueue)
          .set({
            status: "published",
            publishedAt,
            externalPostId: publishResult.postId || null,
            lastError: null,
            retryCount: 0,
            nextRetryAt: null,
          })
          .where(
            and(
              eq(publishingQueue.id, post.id),
              or(
                eq(publishingQueue.status, "approved"),
                eq(publishingQueue.status, "retrying")
              )
            )
          );

        // MySQL2 returns [ResultSetHeader, ...] where affectedRows is on the first element.
        const affectedRows = (updateResult as any)?.[0]?.affectedRows ?? 0;
        if (affectedRows === 0) {
          // A concurrent worker may already have terminalised this row.
          // Reread through the SAME tx and fail closed unless the durable
          // state is a compatible published row (idempotent replay), which
          // is then reconciled with its original success evidence.
          const [current] = await tx
            .select()
            .from(publishingQueue)
            .where(eq(publishingQueue.id, post.id))
            .limit(1);
          if (!current || current.status !== "published" || !current.publishedAt) {
            throw new Error(
              `Refusing to overwrite incompatible publishing_queue state for item ${post.id}: ${current?.status ?? "missing"}`
            );
          }
          await persistAuditEvent(
            buildPublicationAuditEvent({
              eventType: "publication_success",
              occurredAt: new Date(current.publishedAt as Date).toISOString(),
              queueItem: post,
              businessId: publicationBusinessId,
              attemptOrdinal,
              outcome: "succeeded",
              metadata: { externalPostIdPresent: Boolean(current.externalPostId) },
            }),
            tx
          );
          return;
        }

        await persistAuditEvent(
          buildPublicationAuditEvent({
            eventType: "publication_success",
            occurredAt: publishedAt.toISOString(),
            queueItem: post,
            businessId: publicationBusinessId,
            attemptOrdinal,
            outcome: "succeeded",
            metadata: { externalPostIdPresent: Boolean(publishResult.postId) },
          }),
          tx
        );
      });

      // Finalize campaign/content-post state once this platform is live. This covers
      // both the pack-publish path and the per-platform approve-and-publish path.
      // Runs only AFTER the success transaction commits; its go_live transition
      // is audited by the workflow engine (WBS7C1), not here.
      await finalizeCampaignPublishState(post.campaignId).catch((err: any) => {
        console.error(
          `[Publishing Runner] finalizeCampaignPublishState failed for campaign ${post.campaignId}:`,
          err.message
        );
      });

      // Refresh permissioned audience data after a successful publish so that
      // engagement and performance signals can feed back into Audience Intelligence.
      // Best-effort and post-commit: a failure here never erases durable success.
      ingestAudienceData({ userId: post.userId, businessId: null, campaignId: post.campaignId }).catch((err: any) => {
        console.error(`[Publishing Runner] Post-publish audience ingestion failed for campaign ${post.campaignId}:`, err.message);
      });
    } else {
      // Retry logic — the queue outcome mutation and one canonical
      // publication_failure event commit or roll back together.
      const retryCount = (post.retryCount || 0) + 1;
      const maxRetries = post.maxRetries || 3;
      const failureDecidedAt = new Date();
      const failureStage: PublicationFailureStage = publishResult.error?.startsWith("Publishing blocked:")
        ? "billing"
        : "provider";

      if (retryCount >= maxRetries) {
        await db.transaction(async (tx) => {
          await tx
            .update(publishingQueue)
            .set({
              status: "failed",
              retryCount,
              lastError: publishResult.error || "Unknown error",
              nextRetryAt: null,
            })
            .where(eq(publishingQueue.id, post.id));

          await persistAuditEvent(
            buildPublicationAuditEvent({
              eventType: "publication_failure",
              occurredAt: failureDecidedAt.toISOString(),
              queueItem: post,
              businessId: publicationBusinessId,
              attemptOrdinal,
              outcome: "failed",
              metadata: { terminal: true, nextState: "failed", failureStage },
            }),
            tx
          );
        });

        await createAlert({
          severity: "warning",
          category: "publishing",
          message: `Publishing failed after ${maxRetries} retries for ${post.platform}`,
          details: { queueItemId: post.id, platform: post.platform, error: publishResult.error },
        });
      } else {
        const delay = RETRY_DELAYS_MS[Math.min(retryCount - 1, RETRY_DELAYS_MS.length - 1)];
        const nextRetryAt = new Date(now.getTime() + delay);

        await db.transaction(async (tx) => {
          await tx
            .update(publishingQueue)
            .set({
              status: "retrying",
              retryCount,
              lastError: publishResult.error || "Unknown error",
              nextRetryAt,
            })
            .where(eq(publishingQueue.id, post.id));

          await persistAuditEvent(
            buildPublicationAuditEvent({
              eventType: "publication_failure",
              occurredAt: failureDecidedAt.toISOString(),
              queueItem: post,
              businessId: publicationBusinessId,
              attemptOrdinal,
              outcome: "failed",
              metadata: { terminal: false, nextState: "retrying", failureStage },
            }),
            tx
          );
        });
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
    if (providerSucceeded) {
      // The provider reported success but the durable local success evidence
      // could not be written. Propagate for later reconciliation: the
      // external post may already exist, so the queue row must NOT be marked
      // failed and no failure event may be fabricated.
      throw error;
    }

    const retryCount = (post.retryCount || 0) + 1;
    const maxRetries = post.maxRetries || 3;
    const runtimeFailureAt = new Date().toISOString();
    const runtimeOrdinal = (post.retryCount || 0) + 1;

    if (retryCount >= maxRetries) {
      await db.transaction(async (tx) => {
        await tx
          .update(publishingQueue)
          .set({
            status: "failed",
            retryCount,
            lastError: error.message || "Unknown error",
            nextRetryAt: null,
          })
          .where(eq(publishingQueue.id, post.id));

        await persistAuditEvent(
          buildPublicationAuditEvent({
            eventType: "publication_failure",
            occurredAt: runtimeFailureAt,
            queueItem: post,
            businessId: null,
            attemptOrdinal: runtimeOrdinal,
            outcome: "failed",
            metadata: { terminal: true, nextState: "failed", failureStage: "runtime" },
          }),
          tx
        );
      });

      await createAlert({
        severity: "warning",
        category: "publishing",
        message: `Publishing crashed after ${maxRetries} retries for ${post.platform}`,
        details: { queueItemId: post.id, platform: post.platform, error: error.message },
      });
    } else {
      const delay = RETRY_DELAYS_MS[Math.min(retryCount - 1, RETRY_DELAYS_MS.length - 1)];
      const nextRetryAt = new Date(now.getTime() + delay);

      await db.transaction(async (tx) => {
        await tx
          .update(publishingQueue)
          .set({
            status: "retrying",
            retryCount,
            lastError: error.message || "Unknown error",
            nextRetryAt,
          })
          .where(eq(publishingQueue.id, post.id));

        await persistAuditEvent(
          buildPublicationAuditEvent({
            eventType: "publication_failure",
            occurredAt: runtimeFailureAt,
            queueItem: post,
            businessId: null,
            attemptOrdinal: runtimeOrdinal,
            outcome: "failed",
            metadata: { terminal: false, nextState: "retrying", failureStage: "runtime" },
          }),
          tx
        );
      });
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
