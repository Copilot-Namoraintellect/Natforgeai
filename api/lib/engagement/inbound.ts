/**
 * Inbound engagement webhook pipeline (Phase 1 — ingestion only).
 *
 * Safe inbound path:
 *   verified inbound event → normalize → deduplicate → identify
 *   integration/channel → identify campaign/thread where possible → persist
 *   inbound message/event → invoke Engagement processing exactly once.
 *
 * Explicitly NOT implemented here: any outbound sending of generated replies.
 * Replies are proposed and persisted by the Engagement agent only.
 *
 * Acceptance & recovery model (4F-C1A):
 * - The unique (provider, externalEventId) insert is the durable acceptance
 *   record. Acceptance alone does NOT count as processing: the row lands in
 *   `received` and must be atomically claimed (`processing`) before
 *   handleNewMessage runs. A conditional UPDATE is the single claim
 *   authority, so handleNewMessage executes at most once concurrently per
 *   provider + externalEventId, and a crash after acceptance leaves a
 *   recoverable (`received` / stale `processing` / `failed`) row instead of
 *   a permanently skipped duplicate.
 * - Redeliveries of terminal rows (`completed`, `escalated`, legacy
 *   `accepted`) are acknowledged as duplicates and never reprocess.
 * - Re-driven processing is side-effect safe: the pipeline passes an
 *   event-scoped dedupKey down to the Engagement agent, which persists the
 *   inbound message and its AI reply proposal idempotently.
 * - recoverStaleEngagementEvents() is the explicit recovery pass over stuck
 *   rows and uses the same claim semantics.
 *
 * Authority model:
 * - Meta (facebook/instagram/whatsapp) events are authentic only when the
 *   X-Hub-Signature-256 HMAC of the raw body verifies against the configured
 *   app secret. In production, unverifiable events are rejected fail-closed.
 * - Non-Meta platforms have no verifier in this codebase and are rejected
 *   fail-closed in production (log-only in non-production).
 */

import { createHmac, timingSafeEqual, createHash } from "crypto";
import { getDb } from "../../queries/connection";
import {
  socialIntegrations,
  businesses,
  conversationThreads,
  engagementWebhookEvents,
} from "@db/schema";
import { eq, and, or, inArray, lt } from "drizzle-orm";
import { isMySqlDuplicateKeyError } from "../billing/credit-engine";
import { handleNewMessage } from "../agents/engagement-agent";
import { logInfo, logError } from "../logger";
import { env } from "../env";

const META_PLATFORMS = new Set(["facebook", "instagram", "whatsapp"]);

export interface NormalizedInboundEvent {
  provider: string;
  externalEventId: string;
  externalThreadId: string;
  eventType: "message" | "comment";
  actorId: string;
  actorName: string | null;
  text: string;
  occurredAt: string;
  integrationPageId: string | null;
  metadata: Record<string, unknown>;
}

export type InboundEventDisposition =
  | {
      kind: "accepted";
      externalEventId: string;
      threadId: number | null;
      escalated: boolean;
      /** True when this completion came from a recovery claim rather than the first delivery. */
      recovered?: boolean;
    }
  | { kind: "duplicate"; externalEventId: string; reason?: string }
  | { kind: "rejected"; externalEventId: string; reason: string }
  | { kind: "error"; externalEventId: string; reason: string };

export interface InboundWebhookOutcome {
  httpStatus: number;
  received: boolean;
  dispositions: InboundEventDisposition[];
  error?: string;
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function verifyMetaWebhookSignature(
  rawBody: string,
  signature: string,
  appSecret: string
): boolean {
  if (!appSecret || !signature) return false;
  const expected = `sha256=${createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex")}`;
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
}

function isoFromEpochSeconds(value: unknown): string {
  const ms = Number(value);
  if (Number.isFinite(ms) && ms > 0) return new Date(ms * 1000).toISOString();
  return new Date().toISOString();
}

/**
 * Normalize a Meta webhook payload (page messaging + page comment changes)
 * into the internal inbound-event contract. Returns an empty array when the
 * payload matches no supported inbound shape.
 */
export function normalizeMetaWebhookPayload(
  provider: string,
  payload: unknown
): NormalizedInboundEvent[] {
  const body = asRecord(payload);
  const events: NormalizedInboundEvent[] = [];

  for (const entry of Array.isArray(body.entry) ? body.entry : []) {
    const e = asRecord(entry);
    const pageId = e.id != null ? String(e.id) : null;

    for (const messagingItem of Array.isArray(e.messaging) ? e.messaging : []) {
      const item = asRecord(messagingItem);
      const message = asRecord(item.message);
      const sender = asRecord(item.sender);
      const text = typeof message.text === "string" ? message.text : "";
      const mid = message.mid != null ? String(message.mid) : null;
      const actorId = sender.id != null ? String(sender.id) : null;
      if (!mid || !actorId) continue;
      events.push({
        provider,
        externalEventId: mid,
        externalThreadId: `meta:message:${pageId ?? "unknown"}:${actorId}`,
        eventType: "message",
        actorId,
        actorName: typeof sender.name === "string" ? sender.name : null,
        text,
        occurredAt: isoFromEpochSeconds(item.timestamp),
        integrationPageId: pageId,
        metadata: { pageId, mid },
      });
    }

    for (const changeWrapper of Array.isArray(e.changes) ? e.changes : []) {
      const change = asRecord(changeWrapper);
      if (change.field !== "comments") continue;
      const value = asRecord(change.value);
      const commentId = value.id != null ? String(value.id) : null;
      const from = asRecord(value.from);
      const actorId = from.id != null ? String(from.id) : null;
      const text = typeof value.message === "string" ? value.message : "";
      if (!commentId || !actorId) continue;
      const postId = value.post_id != null ? String(value.post_id) : commentId;
      events.push({
        provider,
        externalEventId: `comment-${commentId}`,
        externalThreadId: `meta:comment:${postId}:${actorId}`,
        eventType: "comment",
        actorId,
        actorName: typeof from.name === "string" ? from.name : null,
        text,
        occurredAt:
          typeof value.created_time === "string"
            ? value.created_time
            : new Date().toISOString(),
        integrationPageId: pageId,
        metadata: { pageId, commentId, postId },
      });
    }
  }

  return events;
}

async function recordRejectedEvent(
  db: any,
  provider: string,
  externalEventId: string,
  eventType: string,
  reason: string
): Promise<void> {
  try {
    await db.insert(engagementWebhookEvents).values({
      provider,
      externalEventId: externalEventId.slice(0, 255),
      eventType,
      status: "rejected",
      error: reason,
      payloadSummary: {},
    });
  } catch (err: any) {
    // Audit insert must never break webhook acknowledgement.
    logError("[EngagementInbound] failed to record rejected event", {
      provider,
      externalEventId,
      reason,
      error: err?.message,
    });
  }
  logInfo("[EngagementInbound] event rejected", {
    provider,
    externalEventId,
    reason,
  });
}

async function resolveIntegration(db: any, event: NormalizedInboundEvent) {
  const platformFilter =
    event.provider === "instagram"
      ? (["instagram"] as const)
      : event.provider === "whatsapp"
        ? (["whatsapp"] as const)
        : (["facebook"] as const);

  if (event.integrationPageId) {
    const byPage = await db
      .select()
      .from(socialIntegrations)
      .where(
        and(
          eq(socialIntegrations.pageId, event.integrationPageId),
          inArray(socialIntegrations.platform, [...platformFilter]),
          eq(socialIntegrations.status, "connected")
        )
      )
      .limit(1);
    if (byPage[0]) return byPage[0];
  }

  return null;
}

async function loadBusinessContext(db: any, integration: any) {
  if (!integration?.businessId) return null;
  const [business] = await db
    .select()
    .from(businesses)
    .where(eq(businesses.id, integration.businessId))
    .limit(1);
  if (!business) return null;
  return {
    name: business.name,
    productOrService: business.productOrService ?? undefined,
    brandTone: business.brandTone ?? business.tone ?? undefined,
    mainGoal: business.mainGoal ?? undefined,
  };
}

/**
 * How long a processing claim stays healthy. Must comfortably exceed the
 * worst-case handleNewMessage duration so a redelivery cannot reclaim an
 * event whose original attempt is still running; expired leases become
 * reclaimable, which is what makes crash-recovery bounded.
 */
export const ENGAGEMENT_EVENT_CLAIM_LEASE_MS = 5 * 60 * 1000;

/**
 * Statuses that must never re-enter processing. `accepted` and `error` are
 * legacy rows written before the crash-recovery lifecycle: `accepted` means
 * the event already ran (or was accepted under the old insert-is-authority
 * design) and `error` was terminal under the old semantics. Both stay
 * terminal so pre-existing dedup behavior is preserved.
 */
const TERMINAL_EVENT_STATUSES = new Set([
  "accepted",
  "completed",
  "escalated",
  "rejected",
  "error",
  "duplicate",
]);

type EngagementEventRow = typeof engagementWebhookEvents.$inferSelect;

async function markEventSeen(db: any, rowId: number): Promise<void> {
  await db
    .update(engagementWebhookEvents)
    .set({ lastSeenAt: new Date() })
    .where(eq(engagementWebhookEvents.id, rowId));
}

/**
 * Atomic processing claim. The conditional UPDATE is the single authority
 * over who may invoke handleNewMessage for an event: exactly one caller
 * observes affectedRows === 1, even under concurrent deliveries. Claimable
 * states are `received` and `failed`, plus `processing` rows whose lease has
 * expired (stale claims from a crashed attempt). A healthy in-flight claim
 * is never stolen, and every claim records its attempt for audit.
 */
async function tryClaimEvent(
  db: any,
  row: Pick<EngagementEventRow, "id" | "retryCount">
): Promise<boolean> {
  const now = new Date();
  const [header] = await db
    .update(engagementWebhookEvents)
    .set({
      status: "processing",
      claimedAt: now,
      claimExpiresAt: new Date(now.getTime() + ENGAGEMENT_EVENT_CLAIM_LEASE_MS),
      retryCount: (row.retryCount ?? 0) + 1,
      // Previous failure is kept for audit; the attempt outcome overwrites it.
    })
    .where(
      and(
        eq(engagementWebhookEvents.id, row.id),
        or(
          inArray(engagementWebhookEvents.status, ["received", "failed"]),
          and(
            eq(engagementWebhookEvents.status, "processing"),
            lt(engagementWebhookEvents.claimExpiresAt, now)
          )
        )
      )
    );
  return Number(header?.affectedRows ?? 0) === 1;
}

interface ClaimedProcessingContext {
  integration: any;
  campaignId: number | null;
  businessContext: {
    name: string;
    productOrService?: string;
    brandTone?: string;
    mainGoal?: string;
  };
}

/**
 * Runs Engagement processing for an event this caller has already claimed,
 * then durably records the outcome. A failure here is recoverable: the row
 * is moved to `failed` with its error, and a later redelivery or recovery
 * pass re-claims it. The event-scoped dedupKey makes the agent's persisted
 * effects idempotent across such retries.
 */
async function runClaimedEvent(
  db: any,
  event: NormalizedInboundEvent,
  eventRowId: number,
  ctx: ClaimedProcessingContext,
  recovered: boolean
): Promise<InboundEventDisposition> {
  try {
    const { threadId, result } = await handleNewMessage({
      userId: ctx.integration.userId,
      campaignId: ctx.campaignId,
      platform: event.provider,
      externalThreadId: event.externalThreadId,
      messageText: event.text,
      businessContext: ctx.businessContext,
      dedupKey: `${event.provider}:${event.externalEventId}`,
    });

    const escalated = !!result?.output?.shouldEscalate;
    await db
      .update(engagementWebhookEvents)
      .set({
        status: escalated ? "escalated" : "completed",
        threadId,
        completedAt: new Date(),
        claimExpiresAt: null,
        error: null,
      })
      .where(eq(engagementWebhookEvents.id, eventRowId));

    logInfo("[EngagementInbound] engagement processing completed", {
      provider: event.provider,
      externalEventId: event.externalEventId,
      threadId,
      escalated,
      recovered,
    });
    return {
      kind: "accepted",
      externalEventId: event.externalEventId,
      threadId,
      escalated,
      ...(recovered ? { recovered: true } : {}),
    };
  } catch (err: any) {
    await db
      .update(engagementWebhookEvents)
      .set({
        status: "failed",
        error: err?.message || String(err),
        claimExpiresAt: null,
      })
      .where(eq(engagementWebhookEvents.id, eventRowId));
    logError("[EngagementInbound] engagement processing failed", {
      provider: event.provider,
      externalEventId: event.externalEventId,
      error: err?.message,
    });
    return {
      kind: "error",
      externalEventId: event.externalEventId,
      reason: err?.message || "processing_failed",
    };
  }
}

async function processEvent(
  db: any,
  event: NormalizedInboundEvent
): Promise<InboundEventDisposition> {
  const integration = await resolveIntegration(db, event);
  if (!integration) {
    await recordRejectedEvent(
      db,
      event.provider,
      event.externalEventId,
      event.eventType,
      "no_connected_integration"
    );
    return {
      kind: "rejected",
      externalEventId: event.externalEventId,
      reason: "no_connected_integration",
    };
  }

  const [existingThread] = await db
    .select()
    .from(conversationThreads)
    .where(
      and(
        eq(conversationThreads.userId, integration.userId),
        eq(conversationThreads.externalThreadId, event.externalThreadId),
        eq(conversationThreads.platform, event.provider)
      )
    )
    .limit(1);

  const campaignId = existingThread?.campaignId ?? null;
  const businessContext = (await loadBusinessContext(db, integration)) ?? {
    name: integration.accountName || "NatForgeAI Business",
  };
  const processingCtx: ClaimedProcessingContext = {
    integration,
    campaignId,
    businessContext,
  };

  // Durable acceptance. The unique (provider, externalEventId) index still
  // accepts each event exactly once, but acceptance now lands in `received`:
  // the crash window between insert and completed processing is recoverable
  // instead of silently skipped on redelivery.
  let eventRowId: number | null = null;
  try {
    const [insertResult] = await db.insert(engagementWebhookEvents).values({
      provider: event.provider,
      externalEventId: event.externalEventId.slice(0, 255),
      eventType: event.eventType,
      status: "received",
      userId: integration.userId,
      integrationId: integration.id,
      campaignId,
      actorId: event.actorId,
      payloadSummary: {
        actorName: event.actorName,
        text: event.text,
        textPreview: event.text.slice(0, 280),
        externalThreadId: event.externalThreadId,
        occurredAt: event.occurredAt,
        metadata: event.metadata,
      },
    });
    eventRowId = Number(insertResult.insertId);
  } catch (err: any) {
    if (!isMySqlDuplicateKeyError(err)) throw err;
    eventRowId = null;
  }

  if (eventRowId !== null) {
    // First acceptance: claim immediately. If a concurrent redelivery claims
    // first, it owns processing and this delivery backs off as a duplicate.
    const claimed = await tryClaimEvent(db, { id: eventRowId, retryCount: 0 });
    if (!claimed) {
      return {
        kind: "duplicate",
        externalEventId: event.externalEventId,
        reason: "claim_lost",
      };
    }

    logInfo("[EngagementInbound] event accepted", {
      provider: event.provider,
      externalEventId: event.externalEventId,
      eventType: event.eventType,
      userId: integration.userId,
      campaignId,
    });
    return runClaimedEvent(db, event, eventRowId, processingCtx, false);
  }

  // Redelivery of an already-accepted event.
  const [existing] = await db
    .select()
    .from(engagementWebhookEvents)
    .where(
      and(
        eq(engagementWebhookEvents.provider, event.provider),
        eq(
          engagementWebhookEvents.externalEventId,
          event.externalEventId.slice(0, 255)
        )
      )
    )
    .limit(1);

  if (!existing) {
    // Row vanished between the duplicate-key error and the reload. Acknowledge
    // without processing — never risk double side effects.
    return {
      kind: "duplicate",
      externalEventId: event.externalEventId,
      reason: "row_missing",
    };
  }

  await markEventSeen(db, existing.id);

  if (TERMINAL_EVENT_STATUSES.has(existing.status)) {
    logInfo("[EngagementInbound] duplicate event ignored", {
      provider: event.provider,
      externalEventId: event.externalEventId,
      status: existing.status,
    });
    return {
      kind: "duplicate",
      externalEventId: event.externalEventId,
      reason: existing.status,
    };
  }

  if (
    existing.status === "processing" &&
    existing.claimExpiresAt &&
    existing.claimExpiresAt.getTime() > Date.now()
  ) {
    // Healthy in-flight claim held by another delivery: acknowledge without
    // stealing it.
    return {
      kind: "duplicate",
      externalEventId: event.externalEventId,
      reason: "processing_in_flight",
    };
  }

  // Recoverable event: never completed (`received`), previously failed
  // (`failed`), or holding a stale claim from a crashed attempt. Attempt the
  // atomic claim; if another recovery path wins the race, back off.
  const claimed = await tryClaimEvent(db, existing);
  if (!claimed) {
    return {
      kind: "duplicate",
      externalEventId: event.externalEventId,
      reason: "claim_lost",
    };
  }

  logInfo("[EngagementInbound] event reclaimed for recovery", {
    provider: event.provider,
    externalEventId: event.externalEventId,
    previousStatus: existing.status,
    retryCount: (existing.retryCount ?? 0) + 1,
  });
  return runClaimedEvent(db, event, existing.id, processingCtx, true);
}

export async function processInboundWebhook(input: {
  platform: string;
  rawBody: string;
  signature: string;
}): Promise<InboundWebhookOutcome> {
  const { platform, rawBody, signature } = input;
  const db = getDb();

  if (!META_PLATFORMS.has(platform)) {
    if (env.isProduction) {
      logError(
        "[EngagementInbound] unsupported platform rejected (production fail-closed)",
        { platform }
      );
      return {
        httpStatus: 401,
        received: false,
        dispositions: [],
        error: `Unsupported or unverifiable webhook platform: ${platform}`,
      };
    }
    logInfo(
      "[EngagementInbound] unsupported platform ignored (non-production)",
      { platform }
    );
    return { httpStatus: 200, received: true, dispositions: [] };
  }

  const appSecret = env.metaAppSecret || process.env.FACEBOOK_APP_SECRET || "";
  const signatureValid = appSecret
    ? verifyMetaWebhookSignature(rawBody, signature, appSecret)
    : false;

  if (!signatureValid) {
    if (env.isProduction || appSecret) {
      // Production fail-closed for anything unverifiable; also fail-closed in
      // any environment once a secret is configured and the signature is wrong.
      const externalEventId = `unverified-${sha256Hex(`${platform}:${rawBody}`)}`;
      await recordRejectedEvent(
        db,
        platform,
        externalEventId,
        "unknown",
        "invalid_signature"
      );
      return {
        httpStatus: 401,
        received: false,
        dispositions: [
          { kind: "rejected", externalEventId, reason: "invalid_signature" },
        ],
        error: "Invalid webhook signature",
      };
    }
    logInfo(
      "[EngagementInbound] signature absent and no secret configured (non-production dev accept)",
      {
        platform,
      }
    );
  }

  let payload: unknown = null;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    payload = null;
  }

  const events = payload ? normalizeMetaWebhookPayload(platform, payload) : [];
  if (events.length === 0) {
    const externalEventId = `unknown-${sha256Hex(`${platform}:${rawBody}`)}`;
    await recordRejectedEvent(
      db,
      platform,
      externalEventId,
      "unknown",
      "unknown_event"
    );
    return {
      httpStatus: 200,
      received: true,
      dispositions: [
        { kind: "rejected", externalEventId, reason: "unknown_event" },
      ],
    };
  }

  const dispositions: InboundEventDisposition[] = [];
  for (const event of events) {
    dispositions.push(await processEvent(db, event));
  }

  return { httpStatus: 200, received: true, dispositions };
}

/**
 * Explicit recovery pass over durably accepted events that never completed:
 * rows stuck in `received` (crash between acceptance and claim), `failed`
 * (processing threw), or holding a stale `processing` claim from a crashed
 * attempt. Uses the same atomic claim as redelivery recovery — it cannot
 * double-process, cannot steal a healthy in-flight claim, and never invokes
 * outbound senders.
 */
export async function recoverStaleEngagementEvents(
  input: { limit?: number } = {}
): Promise<{
  scanned: number;
  recovered: number;
  failed: number;
  skipped: number;
}> {
  const db = getDb();
  const now = new Date();
  const limit = input.limit ?? 25;

  const staleRows = await db
    .select()
    .from(engagementWebhookEvents)
    .where(
      or(
        inArray(engagementWebhookEvents.status, ["received", "failed"]),
        and(
          eq(engagementWebhookEvents.status, "processing"),
          lt(engagementWebhookEvents.claimExpiresAt, now)
        )
      )
    )
    .limit(limit);

  let recovered = 0;
  let failed = 0;
  let skipped = 0;

  for (const row of staleRows) {
    const summary = asRecord(row.payloadSummary);
    const text = typeof summary.text === "string" ? summary.text : null;
    const externalThreadId =
      typeof summary.externalThreadId === "string"
        ? summary.externalThreadId
        : null;

    if (!text || !externalThreadId || !row.integrationId) {
      await db
        .update(engagementWebhookEvents)
        .set({
          status: "failed",
          error: "recovery_payload_incomplete",
          claimExpiresAt: null,
        })
        .where(eq(engagementWebhookEvents.id, row.id));
      failed += 1;
      continue;
    }

    const claimed = await tryClaimEvent(db, row);
    if (!claimed) {
      // Lost the race to a redelivery or another recovery worker.
      skipped += 1;
      continue;
    }

    const [integration] = await db
      .select()
      .from(socialIntegrations)
      .where(eq(socialIntegrations.id, row.integrationId))
      .limit(1);
    if (!integration) {
      await db
        .update(engagementWebhookEvents)
        .set({
          status: "failed",
          error: "no_connected_integration",
          claimExpiresAt: null,
        })
        .where(eq(engagementWebhookEvents.id, row.id));
      failed += 1;
      continue;
    }

    const businessContext = (await loadBusinessContext(db, integration)) ?? {
      name: integration.accountName || "NatForgeAI Business",
    };

    const metadata = asRecord(summary.metadata);
    const event: NormalizedInboundEvent = {
      provider: row.provider,
      externalEventId: row.externalEventId,
      externalThreadId,
      eventType: row.eventType === "comment" ? "comment" : "message",
      actorId: row.actorId ?? "unknown",
      actorName:
        typeof summary.actorName === "string" ? summary.actorName : null,
      text,
      occurredAt:
        typeof summary.occurredAt === "string"
          ? summary.occurredAt
          : new Date().toISOString(),
      integrationPageId:
        typeof metadata.pageId === "string" ? metadata.pageId : null,
      metadata,
    };

    const disposition = await runClaimedEvent(
      db,
      event,
      row.id,
      {
        integration,
        campaignId: row.campaignId ?? null,
        businessContext,
      },
      true
    );
    if (disposition.kind === "accepted") recovered += 1;
    else failed += 1;
  }

  logInfo("[EngagementInbound] recovery pass completed", {
    scanned: staleRows.length,
    recovered,
    failed,
    skipped,
  });

  return { scanned: staleRows.length, recovered, failed, skipped };
}
