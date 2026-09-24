import { getDb } from "../../queries/connection";
import {
  publishingQueue,
  contentPosts,
  socialIntegrations,
  campaigns,
  businesses,
  approvalRequests,
} from "@db/schema";
import { eq, and, lte, or, isNotNull, type SQL } from "drizzle-orm";
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
import {
  assertPublicationScheduleMatchesPackageIntent,
  publicationScheduleFromQueueRow,
} from "../publish/publication-schedule";
import {
  validatePrePublishReadiness,
  type PrePublishValidationIssue,
} from "../publish/pre-publish-validation";
import {
  buildPublicationOperationState,
  resolvePublicationExecutionDisposition,
} from "../publish/publication-idempotency";
import {
  loadPublicationReceiptForQueueItem,
  persistPublicationReceipt,
} from "../publish/publication-receipt-store";
import { buildLegacyReceiptFromQueueSuccess, buildPublicationReceipt } from "../publish/publication-receipt";
import {
  buildPublicationRecoveryEvent,
  decidePublicationRecovery,
  type PublicationPreconditionKind,
  type PublicationRecoveryDecision,
} from "../publish/publication-recovery-policy";
import { publishPackageToAuthoritativeInput } from "../publish/publish-package-adapter-input";
import type { PublishPackage } from "../publish/publish-package-builder";
import {
  createPlatformAdapterRegistry,
  type PlatformAdapterRegistry,
} from "../integrations/adapters/adapter-registry";
import { resolveQueuePublishPackagePlan } from "../publish/publish-package-queue-persistence";
import {
  classifyProviderErrorMessage,
  derivePublicationOperationId,
  normalizeAdapterError,
  type AdapterProviderError,
  type AuthoritativePublicationInput,
  type NormalizedPublicationReceipt,
  type PlatformAdapter,
  type PublicationOperationIdentity,
} from "../integrations/adapters/platform-adapter";
import type {
  FacebookAdapterDestination,
  InstagramAdapterDestination,
  LinkedInAdapterDestination,
  TwitterAdapterDestination,
} from "../integrations/adapters";

/**
 * The governed publishing retry schedule is owned by the canonical recovery
 * policy (publication-recovery-policy.ts: PUBLICATION_RETRY_DELAYS_MS); the
 * BullMQ queue options mirror it. No second retry schedule lives here.
 */

/**
 * The single governed adapter boundary used when an immutable publish package
 * is consumed. Adapters delegate submission to the existing provider functions
 * in ../integrations/platforms, so the established provider seam (and its
 * test mocks) is preserved end to end. Created lazily on first governed use so
 * merely importing the runner never instantiates adapters.
 */
let defaultPlatformAdapterRegistry: PlatformAdapterRegistry | null = null;

function getDefaultPlatformAdapterRegistry(): PlatformAdapterRegistry {
  defaultPlatformAdapterRegistry ??= createPlatformAdapterRegistry();
  return defaultPlatformAdapterRegistry;
}

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
  /** Governed publish-package correlation; null on the legacy path. */
  publishPackageId?: string | null;
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
    packageId: input.publishPackageId ?? null,
    metadata: {
      queueItemId: input.queueItem.id,
      platform: input.queueItem.platform,
      attemptOrdinal: input.attemptOrdinal,
      ...input.metadata,
    },
  });
}

/**
 * Durable fail-closed path for a queue item whose canonical pre-publish
 * validation (WBS13.5) failed before any side effect, or whose persisted
 * package schedule intent cannot be reconciled with the queue row (WBS13.2).
 * The recovery policy (WBS13.8) owns the terminal decision: authority failures
 * never consume retry budget, and an approval-authority block routes the row
 * to pending_approval instead of fabricating a failure. The only permitted
 * mutation is an idempotent update of this queue row plus one canonical
 * publication_failure event (and the canonical recovery-decision event),
 * committed together, so the worker can surface an UnrecoverableError and
 * stop retrying a non-transient failure.
 */
async function failQueueItemPrecondition(
  post: {
    id: number;
    userId: number;
    campaignId: number | null;
    contentPostId: number | null;
    platform: string;
    retryCount?: number | null;
    maxRetries?: number | null;
  },
  issue: Pick<PrePublishValidationIssue, "message" | "failureStage" | "code">,
  publishPackageId: string | null = null
): Promise<{ id: number; status: string; platform: string; error: string; unrecoverable: boolean }> {
  const db = getDb();
  const decision = decidePublicationRecovery({
    stage: issue.failureStage,
    preconditionKind:
      issue.failureStage === "precondition" ? preconditionKindOf(issue.code) : undefined,
    now: new Date(),
    retryCount: post.retryCount || 0,
    maxRetries: post.maxRetries || 3,
  });
  await db.transaction(async (tx) => {
    await tx
      .update(publishingQueue)
      .set({
        status: decision.terminalStatus!,
        lastError: issue.message,
        retryCount: decision.nextRetryCount,
        nextRetryAt: null,
      })
      .where(eq(publishingQueue.id, post.id));

    await persistAuditEvent(
      buildPublicationAuditEvent({
        eventType: "publication_failure",
        occurredAt: decision.decidedAt.toISOString(),
        queueItem: post,
        businessId: null,
        attemptOrdinal: (post.retryCount || 0) + 1,
        outcome: "failed",
        metadata: {
          terminal: true,
          nextState: decision.terminalStatus,
          failureStage: issue.failureStage,
          ...publicationRecoveryMetadata(decision, null),
        },
        publishPackageId,
      }),
      tx
    );
  });
  return {
    id: post.id,
    status:
      decision.terminalStatus === "pending_approval" ? "pending_approval" : "precondition_failed",
    platform: post.platform,
    error: issue.message,
    unrecoverable: true,
  };
}

/** Map a canonical validator code onto the recovery policy's precondition kinds. */
function preconditionKindOf(code: string): PublicationPreconditionKind {
  switch (code) {
    case "launch_approval_missing":
    case "publication_authority_missing":
      return "approval_authority";
    case "package_not_intact":
    case "package_classification_unrecognized":
    case "package_not_governed":
      return "package_integrity";
    case "package_payload_not_current":
      return "package_freshness";
    case "queue_package_mismatch":
      return "destination_mismatch";
    default:
      return "readiness";
  }
}

/**
 * Canonical WBS13.8 recovery-decision metadata, merged into the existing
 * publication_failure audit event (the audit event vocabulary is unchanged).
 * The normalized recovery event is built by the policy module; the runner
 * embeds its decision fields so the durable failure evidence records WHY the
 * queue landed where it did, without a second audit event.
 */
function publicationRecoveryMetadata(
  decision: PublicationRecoveryDecision,
  providerErrorCode: string | null
): Record<string, unknown> {
  const recoveryEvent = buildPublicationRecoveryEvent({ decision, providerErrorCode });
  const {
    mutationAuthorized: _mutationAuthorized,
    eventType: _eventType,
    occurredAt: _occurredAt,
    queueItemId: _queueItemId,
    platform: _platform,
    failureStage: _failureStage,
    ...metadata
  } = recoveryEvent;
  return metadata;
}

// ─── Governed package → adapter publication seam (WBS13 convergence) ───
//
// When an immutable publish package is consumed, the package payload is the
// semantic source of truth and the platform adapter is the last transport
// seam before the provider. The helpers below only translate: they never
// reconstruct copy, never reread mutable rows, and delegate submission to the
// existing provider functions bound inside the adapters.

type AnyAdapterDestination =
  | FacebookAdapterDestination
  | InstagramAdapterDestination
  | LinkedInAdapterDestination
  | TwitterAdapterDestination;

/**
 * The registry resolves to a union of concrete adapters; the destination is
 * built per platform to match. Method-syntax signatures are bivariant, so the
 * union binds cleanly to this transport-only view.
 */
type GovernedAdapterView = PlatformAdapter<AnyAdapterDestination, unknown>;

function isAdapterProviderError(error: unknown): error is AdapterProviderError {
  return (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof (error as { message: unknown }).message === "string" &&
    "category" in error &&
    "retryable" in error
  );
}

/**
 * Build the adapter destination (already-decrypted credentials + routing)
 * from the resolved social_integrations row, mirroring the exact credential
 * derivation the legacy direct-provider branch uses. The governed path fails
 * closed before any provider call when the destination cannot be constructed.
 */
function buildAdapterDestination(
  platform: string,
  integration: typeof socialIntegrations.$inferSelect,
  accessToken: string
): { destination: AnyAdapterDestination } | { error: string } {
  switch (platform) {
    case "facebook":
      return {
        destination: {
          accessToken: integration.pageAccessTokenEncrypted
            ? decryptToken(integration.pageAccessTokenEncrypted)
            : accessToken,
          pageId: integration.pageId || integration.accountName || "me",
        },
      };
    case "instagram": {
      if (!integration.instagramBusinessAccountId || !integration.pageAccessTokenEncrypted) {
        return {
          error:
            "Instagram publishing is not ready. Reconnect Meta and ensure a linked Instagram professional account exists.",
        };
      }
      return {
        destination: {
          accessToken: decryptToken(integration.pageAccessTokenEncrypted),
          instagramBusinessAccountId: integration.instagramBusinessAccountId,
        },
      };
    }
    case "linkedin":
      return {
        destination: {
          accessToken,
          organizationId: integration.accountName || "",
        },
      };
    case "twitter":
      return { destination: { accessToken } };
    default:
      return { error: `Platform ${platform} not supported` };
  }
}

/**
 * Publish one already-validated governed package through the adapter
 * boundary. Resolves exactly one adapter, performs exactly one provider
 * submission, and maps the normalized receipt/error back onto the runner's
 * established publishResult shape so retry/failure semantics are unchanged.
 * The normalized provider artifacts travel with the result so the canonical
 * receipt (WBS13.7) and the recovery policy (WBS13.8) consume the adapter
 * boundary's own normalization instead of re-classifying anything.
 */
async function publishThroughGovernedAdapter(input: {
  registry: PlatformAdapterRegistry;
  governedInput: AuthoritativePublicationInput;
  platform: string;
  integration: typeof socialIntegrations.$inferSelect;
  accessToken: string;
}): Promise<{
  success: boolean;
  postId?: string;
  url?: string;
  error?: string;
  normalizedReceipt?: NormalizedPublicationReceipt;
  providerError?: AdapterProviderError;
}> {
  const { platform, integration, accessToken, governedInput } = input;
  const operation: PublicationOperationIdentity = governedInput;

  try {
    const adapter = input.registry.resolve(platform) as GovernedAdapterView;

    const inputValidation = adapter.validateInput(governedInput);
    if (!inputValidation.ok) {
      return {
        success: false,
        error: `Publication input validation failed: ${inputValidation.issues
          .map((issue) => `${issue.code} (${issue.message})`)
          .join("; ")}`,
      };
    }

    const destinationResult = buildAdapterDestination(platform, integration, accessToken);
    if ("error" in destinationResult) {
      return { success: false, error: destinationResult.error };
    }
    const destination = destinationResult.destination;

    const destinationValidation = adapter.validateDestination(destination);
    if (!destinationValidation.ok) {
      return {
        success: false,
        error: `Publication destination validation failed: ${destinationValidation.issues
          .map((issue) => `${issue.code} (${issue.message})`)
          .join("; ")}`,
      };
    }

    // Deterministic request construction; assertTransportFidelity inside the
    // adapter proves the transported text is the authoritative text.
    const request = adapter.buildProviderRequest(governedInput, destination);

    const receipt = await adapter.publish(request, destination, operation);
    return {
      success: true,
      postId: receipt.externalPostId,
      url: receipt.externalUrl,
      normalizedReceipt: receipt,
    };
  } catch (error: unknown) {
    // Adapters and the registry already reject/throw normalized
    // AdapterProviderError shapes; anything else is normalized here so the
    // runner's existing failure handling sees one stable message.
    const normalized = isAdapterProviderError(error)
      ? error
      : normalizeAdapterError(platform, error, operation);
    return { success: false, error: normalized.message, providerError: normalized };
  }
}

/**
 * WBS13.6 disposition for one queue item: load the durable canonical receipt
 * (when any), bind the expected governed package, and project the durable
 * queue row onto the pure idempotency authority. Throws only when durable
 * evidence is malformed — the caller fails closed.
 */
async function resolveExecutionDisposition(
  post: {
    id: number;
    userId: number;
    platform: string;
    status: string;
    retryCount: number | null;
    maxRetries: number | null;
    nextRetryAt: Date | null;
    externalPostId: string | null;
    publishedAt: Date | null;
  },
  frozenPackage: PublishPackage | null
): Promise<import("../publish/publication-idempotency").PublicationExecutionDisposition> {
  const db = getDb();
  const receipt = await loadPublicationReceiptForQueueItem({
    queueItemId: post.id,
    userId: post.userId,
    executor: db,
  });
  return resolvePublicationExecutionDisposition(
    buildPublicationOperationState({
      queue: post,
      receipt,
      expectedPackage: frozenPackage
        ? {
            publishPackageId: frozenPackage.packageId,
            packageFingerprintSha256: frozenPackage.packageFingerprintSha256,
          }
        : null,
      openAttemptOrdinal: null,
    })
  );
}

/**
 * Impure loader for the canonical validator's approval domain: the campaign,
 * its business, and the campaign's approval rows. Returns nulls when the item
 * is not campaign-linked; the validator reports the missing authority itself.
 */
async function loadPublicationAuthorityRows(
  db: ReturnType<typeof getDb>,
  post: { userId: number; campaignId: number | null },
  contentPost: { campaignId?: number | null } | null
): Promise<[unknown, unknown, number | null, unknown[]]> {
  const campaignId = contentPost?.campaignId ?? post.campaignId;
  if (!campaignId) {
    return [null, null, null, []];
  }
  const [campaign] = await db
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.userId, post.userId)))
    .limit(1);
  if (!campaign) {
    return [null, null, null, []];
  }
  let business: unknown = null;
  if (campaign.businessId) {
    [business] = await db
      .select()
      .from(businesses)
      .where(eq(businesses.id, campaign.businessId))
      .limit(1);
  }
  const approvals = await db
    .select()
    .from(approvalRequests)
    .where(and(eq(approvalRequests.userId, post.userId), eq(approvalRequests.campaignId, campaignId)));
  return [campaign, business, campaign.businessId ?? null, approvals];
}

/**
 * Apply one canonical recovery decision (WBS13.8) to the durable queue state:
 * the queue row update, one canonical publication_failure event and the
 * canonical publication_recovery_decision event commit or roll back together.
 * Escalation alerts fire exactly once, only when the policy demands it.
 */
async function persistAttemptFailure(input: {
  post: {
    id: number;
    userId: number;
    campaignId: number | null;
    contentPostId: number | null;
    platform: string;
  };
  businessId: number | null;
  attemptOrdinal: number;
  decision: PublicationRecoveryDecision;
  error: string;
  publishPackageId: string | null;
  providerErrorCode?: string | null;
  alertMessage: string;
}): Promise<void> {
  const db = getDb();
  const { decision } = input;
  await db.transaction(async (tx) => {
    await tx
      .update(publishingQueue)
      .set({
        status: decision.terminal ? decision.terminalStatus! : "retrying",
        retryCount: decision.nextRetryCount,
        lastError: input.error,
        nextRetryAt: decision.nextRetryAt,
      })
      .where(eq(publishingQueue.id, input.post.id));

    await persistAuditEvent(
      buildPublicationAuditEvent({
        eventType: "publication_failure",
        occurredAt: decision.decidedAt.toISOString(),
        queueItem: input.post,
        businessId: input.businessId,
        attemptOrdinal: input.attemptOrdinal,
        outcome: "failed",
        metadata: {
          terminal: decision.terminal,
          nextState: decision.terminal ? decision.terminalStatus : "retrying",
          failureStage: decision.failureStage,
          ...publicationRecoveryMetadata(decision, input.providerErrorCode ?? null),
        },
        publishPackageId: input.publishPackageId,
      }),
      tx
    );
  });

  if (decision.escalationRequired) {
    await createAlert({
      severity: "warning",
      category: "publishing",
      message: input.alertMessage,
      details: { queueItemId: input.post.id, platform: input.post.platform, error: input.error },
    });
  }
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
 *
 * The optional publish-package correlation fields are populated only when an
 * immutable publish package was consumed for this attempt; the legacy
 * no-package path leaves them undefined.
 */
export interface PublishSinglePostResult {
  id: number;
  status: string;
  platform?: string;
  error?: string;
  postId?: string;
  publishPackageId?: string;
  packageFingerprintSha256?: string;
  publishPackageClassification?: string;
  /**
   * True when the canonical recovery policy (WBS13.8) decided this failure is
   * not eligible for automatic retry (terminal/reconnect/approval/escalation).
   * The BullMQ worker maps this to UnrecoverableError so durable-terminal
   * outcomes are never blindly re-driven.
   */
  unrecoverable?: boolean;
}

export async function publishSinglePost(
  queueItemId: number,
  options?: {
    publishPackage?: PublishPackage;
    /**
     * Internal injection seam for the governed adapter boundary. Production
     * callers omit this; the runner uses the default registry whose adapters
     * delegate to the existing provider functions.
     */
    adapterRegistry?: PlatformAdapterRegistry;
  }
): Promise<PublishSinglePostResult> {
  const db = getDb();

  const [loadedPost] = await db
    .select()
    .from(publishingQueue)
    .where(eq(publishingQueue.id, queueItemId))
    .limit(1);

  if (!loadedPost) {
    return { id: queueItemId, status: "not_found", error: "Queue item not found" };
  }
  let post = loadedPost;

  // Load content post early so the canonical validator can prove payload
  // currentness against the live row before any side effect.
  const [contentPost] = post.contentPostId
    ? await db
        .select()
        .from(contentPosts)
        .where(eq(contentPosts.id, post.contentPostId))
        .limit(1)
    : [null];

  const frozenPackage = options?.publishPackage ?? null;

  // ── WBS13.6 idempotency disposition ──────────────────────────────────
  // Consulted before any provider invocation: a durable success replays from
  // the stored canonical receipt (zero provider calls), terminal states never
  // reach the provider, and only execute/retry dispositions proceed. The
  // governed package binding correlates the attempt so a prior success that
  // belongs to a different package is never borrowed.
  let disposition: import("../publish/publication-idempotency").PublicationExecutionDisposition;
  try {
    disposition = await resolveExecutionDisposition(post, frozenPackage);
  } catch (err: any) {
    // Durable operation state is contradictory or malformed: fail closed.
    const message =
      err instanceof Error ? err.message : "Publication operation state failed closed";
    return { id: post.id, status: "precondition_failed", platform: post.platform, error: message };
  }

  if (disposition.outcome === "replay_success") {
    // The stored canonical receipt answers this retry; no provider call, no
    // duplicate external post, no duplicate success evidence.
    return {
      id: post.id,
      status: "published",
      platform: post.platform,
      postId: disposition.receipt.externalPostId ?? undefined,
      publishPackageId: disposition.receipt.publishPackageId ?? undefined,
      packageFingerprintSha256: disposition.receipt.packageFingerprintSha256 ?? undefined,
      publishPackageClassification: disposition.receipt.classification,
    };
  }

  if (disposition.outcome === "terminal") {
    if (disposition.reason === "not_ready" || disposition.reason === "already_terminal") {
      // Established runner convention: non-actionable/terminal rows are
      // reported without mutating their durable state.
      return { id: post.id, status: post.status, error: disposition.message };
    }
    // attempts_exhausted / package_mismatch / receipt_state_drift: fail closed
    // without a provider call and without touching durable success state.
    return {
      id: post.id,
      status: "precondition_failed",
      platform: post.platform,
      error: disposition.message,
      unrecoverable: true,
      publishPackageId: frozenPackage ? frozenPackage.packageId : undefined,
      packageFingerprintSha256: frozenPackage ? frozenPackage.packageFingerprintSha256 : undefined,
      publishPackageClassification: frozenPackage ? frozenPackage.classification : undefined,
    };
  }

  // ── WBS13.2 schedule authority: package intent ↔ queue row ───────────
  // Where a governed package is consumed, its declared schedule intent must
  // correspond to the same canonical schedule persisted on the queue row.
  // (Package intactness/binding/currentness are owned by the canonical
  // validator below; the schedule↔intent proof is the schedule authority's.)
  if (frozenPackage) {
    try {
      assertPublicationScheduleMatchesPackageIntent(
        publicationScheduleFromQueueRow(post),
        frozenPackage.identity.intent
      );
    } catch (err: any) {
      const message =
        err instanceof Error ? err.message : "Publish package schedule intent conflict check failed";
      return failQueueItemPrecondition(
        post,
        { code: "queue_package_mismatch", failureStage: "precondition", message },
        frozenPackage.packageId
      );
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
    // Safety EXECUTION/refresh is an impure pre-step owned by the runner: the
    // canonical validator only governs the persisted safetyStatus. The
    // publish/no-publish decision itself flows through
    // validatePrePublishReadiness below.
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
      post = refreshed;
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

    let publishResult: {
      success: boolean;
      postId?: string;
      url?: string;
      error?: string;
      normalizedReceipt?: NormalizedPublicationReceipt;
      providerError?: AdapterProviderError;
    } = { success: false };

    // ── Canonical pre-publish validation (WBS13.5) ───────────────────────
    // The validator owns the governed publish/no-publish decision over the
    // already-loaded projections. Impure pre-steps (safety refresh,
    // integration/campaign loading) stay with the runner; the queue,
    // approval, package, safety, integration, credential and media domains
    // evaluate in one deterministic order, and the first failing domain is
    // the only outcome.
    const [validationCampaign, validationBusiness, publicationBusinessId, validationApprovals] =
      await loadPublicationAuthorityRows(db, post, contentPost);

    const readiness = validatePrePublishReadiness({
      queueItem: {
        id: post.id,
        userId: post.userId,
        campaignId: post.campaignId,
        contentPostId: post.contentPostId,
        platform: post.platform,
        integrationId: post.integrationId ?? null,
        status: post.status,
        safetyStatus: post.safetyStatus ?? null,
      },
      contentPost,
      publishPackage: frozenPackage,
      integration: integration
        ? {
            id: integration.id,
            userId: integration.userId,
            businessId: integration.businessId ?? null,
            platform: integration.platform,
            status: integration.status,
            accountName: integration.accountName ?? null,
            accessTokenEncrypted: integration.accessTokenEncrypted ?? null,
            pageAccessTokenEncrypted: integration.pageAccessTokenEncrypted ?? null,
            instagramBusinessAccountId: integration.instagramBusinessAccountId ?? null,
          }
        : null,
      campaign: validationCampaign,
      business: validationBusiness,
      approvals: validationApprovals,
      publicAppUrl: env.publicAppUrl,
    });

    if (!readiness.ready) {
      const first = readiness.firstFailure!;
      // Safety governance keeps its established queue semantics: a plain row
      // update with no fabricated publication outcome and no audit event.
      if (first.domain === "safety" && first.code === "safety_high_blocked") {
        await db
          .update(publishingQueue)
          .set({ status: "safety_blocked", lastError: first.message })
          .where(eq(publishingQueue.id, post.id));
        return { id: post.id, status: "safety_blocked", platform: post.platform, error: first.message };
      }
      if (first.domain === "safety" && first.code === "safety_medium_requires_approval") {
        await db
          .update(publishingQueue)
          .set({ status: "pending_approval", approvalRequired: true, lastError: first.message })
          .where(eq(publishingQueue.id, post.id));
        return { id: post.id, status: "pending_approval", platform: post.platform, error: first.message };
      }
      // Every other domain fails closed on the durable precondition path; the
      // recovery policy decides the terminal shape (failed, or pending_approval
      // for an approval-authority block).
      return failQueueItemPrecondition(
        post,
        { code: first.code, failureStage: first.failureStage, message: first.message },
        frozenPackage?.packageId ?? null
      );
    }

    // Build content payload. WBS13.1/WBS13 convergence: when an immutable
    // publish package was handed off by publication preparation, its frozen
    // payload is the authoritative source — Distribution must not reconstruct
    // meaning from mutable campaign/business rows at execution time. The
    // governed mapping (package + queue identity → AuthoritativePublicationInput)
    // is the single seam into the platform adapter boundary. The legacy path
    // (cron/worker items without a package) keeps composing from the live row.
    const imageUrl: string | undefined =
      postMeta?.imageUrl || (contentPost as any)?.imageUrl || undefined;

    const governedInput = frozenPackage
      ? publishPackageToAuthoritativeInput(frozenPackage, post.id)
      : null;

    const payload = governedInput
      ? governedInput.content
      : contentPost
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
        // Unreachable when the canonical validator passed (it applies the
        // same resolvePublicImageUrl proof); retained as a fail-closed guard
        // that routes through the same durable precondition path.
        return failQueueItemPrecondition(
          post,
          {
            code: "media_url_invalid",
            failureStage: "media",
            message: "Facebook publishing failed: invalid image URL.",
          },
          frozenPackage?.packageId ?? null
        );
      }

      payload.mediaUrls = [publicImageUrl];
    }

    // ── Durable attempt evidence (WBS7C3) ─────────────────────────────
    // Every gate establishing a genuine controlled publication attempt has
    // now passed (disposition → canonical validation → rate limit). Record
    // publication_attempt BEFORE any credit mutation, credential decryption,
    // or provider call, so a provider side effect can never occur without
    // durable attempt evidence. If this persistence fails it flows to the
    // governed runtime-failure path below: no credit mutation, no credential
    // decryption, no provider call.
    const attemptOrdinal = (post.retryCount || 0) + 1;

    await persistAuditEvent(
      buildPublicationAuditEvent({
        eventType: "publication_attempt",
        occurredAt: new Date().toISOString(),
        queueItem: post,
        businessId: publicationBusinessId,
        attemptOrdinal,
        outcome: "succeeded",
        metadata: { queueStatusAtAttempt: post.status },
        publishPackageId: frozenPackage?.packageId ?? null,
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

      if (governedInput) {
        // Governed package path (WBS13 convergence): exactly one adapter
        // resolution and exactly one provider submission through the adapter
        // boundary. The legacy direct-provider switch below must not also run.
        publishResult = await publishThroughGovernedAdapter({
          registry: options?.adapterRegistry ?? getDefaultPlatformAdapterRegistry(),
          governedInput,
          platform: post.platform,
          integration,
          accessToken,
        });
      } else {
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
    }

    // Update queue status
    if (publishResult.success) {
      // ONE publication-success timestamp shared by publishing_queue.publishedAt,
      // the canonical receipt, and the success audit occurrence — no
      // independent second clock read.
      const publishedAt = new Date();
      const publishedAtIso = publishedAt.toISOString();
      providerSucceeded = true;

      const normalizedReceipt: NormalizedPublicationReceipt = publishResult.normalizedReceipt ?? {
        platform: post.platform,
        operationId: derivePublicationOperationId({ platform: post.platform, queueItemId: post.id }),
        status: "published",
        externalPostId: publishResult.postId,
        externalUrl: publishResult.url,
      };

      // WBS13.7: build the canonical receipt from the normalized provider
      // result before any durable write. The consumed governed package (when
      // any) is tamper-checked inside the builder; legacy successes produce
      // an honest legacy receipt with null package correlation.
      const publicationReceipt = buildPublicationReceipt({
        normalized: normalizedReceipt,
        queueItemId: post.id,
        platform: post.platform,
        publishedAtIso,
        publishPackage: frozenPackage,
      });

      await db.transaction(async (tx) => {
        const updateResult = await tx
          .update(publishingQueue)
          .set({
            status: "published",
            publishedAt,
            externalPostId: publicationReceipt.externalPostId,
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
          // is then reconciled with its original canonical receipt — never a
          // duplicate incompatible success event.
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
          const storedReceipt = await loadPublicationReceiptForQueueItem({
            queueItemId: post.id,
            userId: post.userId,
            executor: tx,
          });
          const reconciledReceipt =
            storedReceipt ??
            buildLegacyReceiptFromQueueSuccess({
              queueItemId: post.id,
              platform: post.platform,
              status: current.status,
              externalPostId: current.externalPostId,
              publishedAt: current.publishedAt,
            });
          if (!reconciledReceipt) {
            throw new Error(
              `Durable published state for item ${post.id} could not produce a canonical receipt; failing closed.`
            );
          }
          await persistPublicationReceipt(
            {
              receipt: reconciledReceipt,
              userId: post.userId,
              campaignId: post.campaignId,
              businessId: publicationBusinessId,
              contentId: post.contentPostId,
              executor: tx,
            }
          );
          return;
        }

        // Queue success state and the canonical receipt commit in the SAME
        // transaction; the receipt event is the single durable
        // publication_success evidence (no duplicate success audit).
        await persistPublicationReceipt(
          {
            receipt: publicationReceipt,
            userId: post.userId,
            campaignId: post.campaignId,
            businessId: publicationBusinessId,
            contentId: post.contentPostId,
            executor: tx,
          }
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

      return {
        id: post.id,
        status: "published",
        platform: post.platform,
        postId: publishResult.postId,
        publishPackageId: frozenPackage ? frozenPackage.packageId : undefined,
        packageFingerprintSha256: frozenPackage ? frozenPackage.packageFingerprintSha256 : undefined,
        publishPackageClassification: frozenPackage ? frozenPackage.classification : undefined,
      };
    } else {
      // WBS13.8: the recovery policy owns the retry/terminal decision. The
      // queue outcome mutation, one canonical publication_failure event and
      // the canonical recovery-decision event commit or roll back together;
      // escalation alerts fire exactly once for exhausted budgets.
      const failureDecidedAt = new Date();
      const failureStage: PublicationFailureStage = publishResult.error?.startsWith("Publishing blocked:")
        ? "billing"
        : "provider";
      const providerClassification = publishResult.providerError
        ? {
            category: publishResult.providerError.category,
            code: publishResult.providerError.code,
            retryable: publishResult.providerError.retryable,
          }
        : classifyProviderErrorMessage(publishResult.error || "Unknown error");
      const decision = decidePublicationRecovery({
        stage: failureStage,
        now: failureDecidedAt,
        retryCount: post.retryCount || 0,
        maxRetries: post.maxRetries || 3,
        provider: failureStage === "provider" ? providerClassification : null,
      });

      await persistAttemptFailure({
        post,
        businessId: publicationBusinessId,
        attemptOrdinal,
        decision,
        error: publishResult.error || "Unknown error",
        publishPackageId: frozenPackage?.packageId ?? null,
        providerErrorCode:
          publishResult.providerError?.code ??
          (failureStage === "provider" ? providerClassification.code : null),
        alertMessage: `Publishing failed after ${decision.maxRetries} attempts for ${post.platform}`,
      });

      return {
        id: post.id,
        status: decision.terminal
          ? decision.terminalStatus === "pending_approval"
            ? "pending_approval"
            : "failed"
          : "retrying",
        platform: post.platform,
        error: publishResult.error,
        postId: publishResult.postId,
        unrecoverable: decision.terminal,
        publishPackageId: frozenPackage ? frozenPackage.packageId : undefined,
        packageFingerprintSha256: frozenPackage ? frozenPackage.packageFingerprintSha256 : undefined,
        publishPackageClassification: frozenPackage ? frozenPackage.classification : undefined,
      };
    }
  } catch (error: any) {
    if (providerSucceeded) {
      // The provider reported success but the durable local success evidence
      // could not be written. Propagate for later reconciliation: the
      // external post may already exist, so the queue row must NOT be marked
      // failed and no failure event may be fabricated.
      throw error;
    }

    const runtimeFailureAt = new Date();
    const message = error instanceof Error ? error.message || "Unknown error" : "Unknown error";
    const classification = classifyProviderErrorMessage(message);
    const decision = decidePublicationRecovery({
      stage: "runtime",
      now: runtimeFailureAt,
      retryCount: post.retryCount || 0,
      maxRetries: post.maxRetries || 3,
      provider: {
        category: classification.category,
        code: classification.code,
        retryable: classification.retryable,
      },
    });

    await persistAttemptFailure({
      post,
      businessId: null,
      attemptOrdinal: (post.retryCount || 0) + 1,
      decision,
      error: message,
      publishPackageId: frozenPackage?.packageId ?? null,
      providerErrorCode: classification.code,
      alertMessage: `Publishing crashed after ${decision.maxRetries} attempts for ${post.platform}`,
    });

    return {
      id: post.id,
      status: decision.terminal
        ? decision.terminalStatus === "pending_approval"
          ? "pending_approval"
          : "failed"
        : "retrying",
      error: message,
      platform: post.platform,
      unrecoverable: decision.terminal,
      publishPackageId: frozenPackage ? frozenPackage.packageId : undefined,
      packageFingerprintSha256: frozenPackage ? frozenPackage.packageFingerprintSha256 : undefined,
      publishPackageClassification: frozenPackage ? frozenPackage.classification : undefined,
    };
  }
}

/**
 * Publishes all due posts from the publishing queue.
 * Legacy cron-based approach — still available for manual triggers and dev fallback.
 */
/**
 * Due-post predicate for legacy cron selection.
 *
 * approved: eligible when scheduledAt <= now.
 * retrying: eligible ONLY when nextRetryAt is non-null AND nextRetryAt <= now.
 *           A null nextRetryAt therefore makes a re-armed row BullMQ-only —
 *           legacy cron cannot race a deliberate controlled replay.
 */
export function buildDuePostsCondition(now: Date): SQL {
  return or(
    and(
      eq(publishingQueue.status, "approved"),
      lte(publishingQueue.scheduledAt, now)
    ),
    and(
      eq(publishingQueue.status, "retrying"),
      isNotNull(publishingQueue.nextRetryAt),
      lte(publishingQueue.nextRetryAt, now)
    )
  )!;
}

export async function publishDuePosts() {
  const db = getDb();
  const now = new Date();

  const duePosts = await db
    .select()
    .from(publishingQueue)
    .where(buildDuePostsCondition(now));

  const results = [];
  for (const post of duePosts) {
    // WBS13.4: reload the exact persisted publish package for this durable
    // queue row through the same loader the BullMQ worker uses. Governed rows
    // execute the persisted package; legacy rows keep the established
    // no-package call; a governed row with a missing or tampered package has
    // already been failed closed durably by the shared plan loader.
    const plan = await resolveQueuePublishPackagePlan(post);
    if (plan.kind === "fail_closed") {
      results.push({
        id: post.id,
        status: "precondition_failed",
        platform: post.platform,
        error: plan.reason,
      });
      continue;
    }
    const result =
      plan.kind === "governed"
        ? await publishSinglePost(post.id, { publishPackage: plan.publishPackage })
        : await publishSinglePost(post.id);
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
