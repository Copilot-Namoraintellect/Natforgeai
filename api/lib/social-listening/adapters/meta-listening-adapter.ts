/**
 * Meta listening adapter (facebook / instagram / whatsapp surfaces).
 *
 * Webhook authenticity: Meta `X-Hub-Signature-256` HMAC over the raw body,
 * verified against the app secret (the same cryptographic rule the engagement
 * inbound pipeline uses — `verifyMetaWebhookSignature`).
 *
 * Parsing covers the Meta webhook shapes this codebase has authority for:
 *   - page messaging (facebook / whatsapp direct messages)
 *   - instagram messaging (object "instagram")
 *   - page changes field "comments" (comment / reply via parent_id)
 *   - page changes field "feed" with item types comment / reaction / share /
 *     mention (anything else → "unknown", never guessed)
 *
 * Events missing required identity (event id, actor, account) are skipped;
 * identity material that is present but malformed (control characters,
 * oversized) fails closed — that is tampering evidence, not a parse nicety.
 */

import {
  normalizeExternalIdentity,
  timestampFromEpochSeconds,
  timestampFromIsoDateTime,
  type SocialSignalPlatform,
  type SocialSignalType,
} from "../signal-contract";
import { verifyMetaWebhookSignature } from "../../integrations/webhook-authenticity";
import {
  MAX_EVENTS_PER_PAYLOAD,
  type PollingFetchInput,
  type PollingFetchResult,
  type PlatformListeningCapability,
  type RawSocialSignalEvent,
  type SocialListeningAdapter,
  type WebhookVerificationInput,
} from "./types";

const META_PROVIDER = "meta" as const;

const CAPABILITIES: readonly PlatformListeningCapability[] = [
  { platform: "facebook", webhook: "supported", polling: "supported" },
  { platform: "instagram", webhook: "supported", polling: "supported" },
  { platform: "whatsapp", webhook: "supported", polling: "unsupported" },
];

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function buildMessagingEvent(
  platform: SocialSignalPlatform,
  pageId: string,
  item: Record<string, any>
): RawSocialSignalEvent | null {
  const message = asRecord(item.message);
  const sender = asRecord(item.sender);
  const mid = message.mid != null ? String(message.mid) : null;
  const actorId = sender.id != null ? String(sender.id) : null;
  if (!mid || !actorId) return null;

  const occurredAt = timestampFromEpochSeconds(item.timestamp, "timestamp", "now");
  return {
    providerAccountId: normalizeExternalIdentity(pageId, "providerAccountId"),
    externalEventId: normalizeExternalIdentity(mid, "externalEventId"),
    externalObjectId: null,
    parentExternalObjectId: null,
    signalType: "direct_message",
    occurredAt,
    actorReference: normalizeExternalIdentity(actorId, "actorReference"),
    actorDisplayName: asString(sender.name),
    contentReference: null,
    contentText: asString(message.text),
    evidence: {
      kind: "messaging",
      platform,
      pageId,
      mid,
      actorId,
      timestamp: occurredAt.toISOString(),
    },
  };
}

function mapCommentShape(
  platform: SocialSignalPlatform,
  pageId: string,
  value: Record<string, any>
): RawSocialSignalEvent | null {
  const commentId = value.id != null ? String(value.id) : null;
  const from = asRecord(value.from);
  const actorId = from.id != null ? String(from.id) : null;
  if (!commentId || !actorId) return null;

  const postId = value.post_id != null ? String(value.post_id) : null;
  const parentId = value.parent_id != null ? String(value.parent_id) : null;
  // A comment whose parent is the post itself (or has no parent) is a
  // top-level comment; a parent pointing at another comment is a reply.
  const isReply = !!parentId && !!postId && parentId !== postId;
  const permalink = asString(value.permalink_url);

  return {
    providerAccountId: normalizeExternalIdentity(pageId, "providerAccountId"),
    externalEventId: normalizeExternalIdentity(commentId, "externalEventId"),
    externalObjectId: postId ? normalizeExternalIdentity(postId, "externalObjectId") : null,
    parentExternalObjectId: parentId
      ? normalizeExternalIdentity(parentId, "parentExternalObjectId")
      : null,
    signalType: isReply ? "reply" : "comment",
    occurredAt: timestampFromIsoDateTime(value.created_time, "created_time", "now"),
    actorReference: normalizeExternalIdentity(actorId, "actorReference"),
    actorDisplayName: asString(from.name),
    contentReference: permalink,
    contentText: asString(value.message),
    evidence: {
      kind: "comment",
      platform,
      pageId,
      commentId,
      postId,
      parentId,
      actorId,
      createdTime: asString(value.created_time),
    },
  };
}

function mapFeedShape(
  platform: SocialSignalPlatform,
  pageId: string,
  value: Record<string, any>
): RawSocialSignalEvent | null {
  const postId = value.post_id != null ? String(value.post_id) : null;
  const actor = asRecord(value.from ?? value.sender);
  const actorId = actor.id != null ? String(actor.id) : null;
  // Feed events need the object they refer to and an actor, otherwise they
  // are not attributable evidence.
  if (!postId || !actorId) return null;

  const item = asString(value.item) ?? "unknown";
  const changeId = value.comment_id ?? value.reaction_id ?? value.share_id ?? value.mention_id;
  const eventId = changeId != null ? String(changeId) : `feed:${postId}:${item}:${actorId}`;
  const parentId = value.parent_id != null ? String(value.parent_id) : null;
  const isReply = item === "comment" && !!parentId && parentId !== postId;

  let signalType: SocialSignalType = "unknown";
  if (item === "comment") signalType = isReply ? "reply" : "comment";
  else if (item === "reaction") signalType = "reaction";
  else if (item === "share") signalType = "repost";
  else if (item === "mention") signalType = "mention";
  // Anything else stays "unknown" — never guessed.

  return {
    providerAccountId: normalizeExternalIdentity(pageId, "providerAccountId"),
    externalEventId: normalizeExternalIdentity(eventId, "externalEventId"),
    externalObjectId: normalizeExternalIdentity(postId, "externalObjectId"),
    parentExternalObjectId: parentId
      ? normalizeExternalIdentity(parentId, "parentExternalObjectId")
      : null,
    signalType,
    occurredAt: timestampFromIsoDateTime(value.created_time, "created_time", "now"),
    actorReference: normalizeExternalIdentity(actorId, "actorReference"),
    actorDisplayName: asString(actor.name),
    contentReference: asString(value.permalink_url ?? value.link),
    contentText: asString(value.message),
    evidence: {
      kind: "feed",
      platform,
      pageId,
      postId,
      item,
      eventId,
      actorId,
      createdTime: asString(value.created_time),
    },
  };
}

export class MetaListeningAdapter implements SocialListeningAdapter {
  readonly provider = META_PROVIDER;
  readonly capabilities = CAPABILITIES;

  capabilityFor(platform: string): PlatformListeningCapability | null {
    return CAPABILITIES.find((c) => c.platform === platform) ?? null;
  }

  verifyWebhookAuthenticity(input: WebhookVerificationInput): boolean {
    const signature = input.headers["x-hub-signature-256"];
    if (!signature) return false;
    return verifyMetaWebhookSignature(input.rawBody, signature, input.appSecret);
  }

  parseWebhookPayload(
    platform: SocialSignalPlatform,
    payload: unknown
  ): RawSocialSignalEvent[] {
    if (!this.capabilityFor(platform)) return [];
    const body = asRecord(payload);
    const events: RawSocialSignalEvent[] = [];

    for (const entryRaw of Array.isArray(body.entry) ? body.entry : []) {
      if (events.length >= MAX_EVENTS_PER_PAYLOAD) break;
      const entry = asRecord(entryRaw);
      const pageId = entry.id != null ? String(entry.id) : null;
      if (!pageId) continue;

      for (const messagingItem of Array.isArray(entry.messaging) ? entry.messaging : []) {
        if (events.length >= MAX_EVENTS_PER_PAYLOAD) break;
        const item = asRecord(messagingItem);
        // Sender id equal to the page id is an echo of our own outbound
        // message — not an inbound signal.
        const sender = asRecord(item.sender);
        if (sender.id != null && String(sender.id) === pageId) continue;
        const event = buildMessagingEvent(platform, pageId, item);
        if (event) events.push(event);
      }

      for (const changeWrapper of Array.isArray(entry.changes) ? entry.changes : []) {
        if (events.length >= MAX_EVENTS_PER_PAYLOAD) break;
        const change = asRecord(changeWrapper);
        const value = asRecord(change.value);
        let event: RawSocialSignalEvent | null = null;
        if (change.field === "comments") {
          event = mapCommentShape(platform, pageId, value);
        } else if (change.field === "feed") {
          event = mapFeedShape(platform, pageId, value);
        }
        if (event) events.push(event);
      }
    }

    return events;
  }

  async fetchEvents(_input: PollingFetchInput): Promise<PollingFetchResult> {
    // Meta polling requires a live Graph API fetch seam. R5-A wires no live
    // provider calls: fail closed rather than fake success. The orchestration
    // layer injects a fetcher when an operator configures one.
    throw new Error(
      "LISTENING_NOT_CONFIGURED: meta polling fetch seam is not configured"
    );
  }
}

export const metaListeningAdapter = new MetaListeningAdapter();
