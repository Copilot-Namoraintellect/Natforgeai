import { createHash } from "crypto";
import { getDb } from "../../queries/connection";
import {
  socialIntegrations,
  socialProfiles,
  socialEngagementEvents,
  campaignInterestSignals,
} from "@db/schema";
import { eq, and, inArray, sql } from "drizzle-orm";
import { decryptToken } from "../crypto";
import { fetchMetaAudienceData } from "./adapters/meta-adapter";
import { fetchLinkedInAudienceData } from "./adapters/linkedin-adapter";
import type {
  AdapterResult,
  AudienceIngestionSummary,
  EngagementEventType,
  RawEngagementEvent,
  RawSocialProfile,
  SocialProfilePlatform,
} from "./types";

const ADAPTER_MAP: Record<
  string,
  (userId: number, businessId: number | undefined, token: string) => Promise<AdapterResult>
> = {
  facebook: fetchMetaAudienceData,
  instagram: fetchMetaAudienceData,
  linkedin: fetchLinkedInAudienceData,
};

function mapIntegrationPlatformToProfilePlatform(
  integrationPlatform: string
): SocialProfilePlatform | null {
  switch (integrationPlatform) {
    case "facebook":
      return "facebook_page";
    case "instagram":
      return "instagram_account";
    case "linkedin":
      return "linkedin_page";
    case "tiktok":
      return "tiktok_account";
    case "twitter":
      return "twitter_account";
    default:
      return null;
  }
}

function computeDedupHash(
  userId: number,
  event: RawEngagementEvent,
  externalProfileId: string
): string {
  const key = [
    userId,
    event.platform,
    externalProfileId,
    event.externalContentId || "",
    event.actorExternalId || "",
    event.eventType,
    event.eventTimestamp.toISOString(),
  ].join("|");
  return createHash("sha256").update(key).digest("hex");
}

function truncateText(text: string | null | undefined, maxLen = 500): string | null {
  if (!text) return null;
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + "...";
}

export async function ingestAudienceData({
  userId,
  businessId,
  campaignId,
}: {
  userId: number;
  businessId?: number | null;
  campaignId?: number | null;
}): Promise<AudienceIngestionSummary> {
  const db = getDb();
  const summary: AudienceIngestionSummary = {
    profilesSynced: 0,
    eventsSynced: 0,
    signalsGenerated: 0,
    warnings: [],
  };

  // 1. Load connected integrations
  const integrations = await db
    .select()
    .from(socialIntegrations)
    .where(
      and(
        eq(socialIntegrations.userId, userId),
        eq(socialIntegrations.status, "connected"),
        inArray(
          socialIntegrations.platform,
          Object.keys(ADAPTER_MAP) as ("facebook" | "instagram" | "linkedin")[]
        )
      )
    );

  if (integrations.length === 0) {
    summary.warnings.push(
      "No connected Facebook, Instagram, or LinkedIn integrations found. Connect an account in Integrations to discover leads."
    );
    return summary;
  }

  // 2. Run adapters
  const allProfiles: RawSocialProfile[] = [];
  const allEvents: RawEngagementEvent[] = [];

  for (const integration of integrations) {
    const adapter = ADAPTER_MAP[integration.platform];
    if (!adapter || !integration.accessTokenEncrypted) continue;

    try {
      // Light validation that the token is decryptable before hitting the API
      decryptToken(integration.accessTokenEncrypted);
    } catch {
      summary.warnings.push(`${integration.platform}: token decryption failed. Reconnect account.`);
      continue;
    }

    try {
      const result = await adapter(userId, businessId ?? undefined, integration.accessTokenEncrypted);
      allProfiles.push(...result.profiles);
      allEvents.push(...result.events);
      summary.warnings.push(...result.warnings);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      summary.warnings.push(`${integration.platform}: ${message}`);
    }
  }

  if (allProfiles.length === 0 && allEvents.length === 0) {
    return summary;
  }

  // 3. Upsert social profiles
  const profileValues = allProfiles.map((p) => ({
    userId,
    businessId: businessId ?? null,
    campaignId: campaignId ?? null,
    platform: p.platform,
    externalId: p.externalId,
    handle: p.handle ?? null,
    displayName: p.displayName ?? null,
    url: p.url ?? null,
    followerCount: p.followerCount ?? 0,
    category: p.category ?? null,
    location: p.location ?? null,
    profilePictureUrl: p.profilePictureUrl ?? null,
    lastSyncedAt: new Date(),
    metadata: p.metadata ?? null,
  }));

  if (profileValues.length > 0) {
    await db
      .insert(socialProfiles)
      .values(profileValues)
      .onDuplicateKeyUpdate({
        set: {
          handle: sql`VALUES(handle)`,
          displayName: sql`VALUES(displayName)`,
          url: sql`VALUES(url)`,
          followerCount: sql`VALUES(followerCount)`,
          category: sql`VALUES(category)`,
          location: sql`VALUES(location)`,
          profilePictureUrl: sql`VALUES(profilePictureUrl)`,
          lastSyncedAt: sql`VALUES(lastSyncedAt)`,
          metadata: sql`VALUES(metadata)`,
          updatedAt: new Date(),
        },
      });
    summary.profilesSynced = profileValues.length;
  }

  // Map external profile IDs to internal social profile IDs
  const profileIdMap = new Map<string, number>();
  const insertedProfiles = await db
    .select()
    .from(socialProfiles)
    .where(eq(socialProfiles.userId, userId));
  for (const row of insertedProfiles) {
    profileIdMap.set(`${row.platform}:${row.externalId}`, row.id);
  }

  // 4. Upsert engagement events
  const eventValues = allEvents.map((e) => {
    const profilePlatform = mapIntegrationPlatformToProfilePlatform(e.platform);
    const internalProfileId = profilePlatform
      ? profileIdMap.get(`${profilePlatform}:${e.externalProfileId}`)
      : undefined;
    const dedupHash = computeDedupHash(userId, e, e.externalProfileId);
    return {
      userId,
      businessId: businessId ?? null,
      campaignId: campaignId ?? null,
      platform: e.platform,
      socialProfileId: internalProfileId ?? null,
      externalProfileId: e.externalProfileId,
      externalContentId: e.externalContentId ?? null,
      dedupHash,
      eventType: e.eventType,
      actorHandle: e.actorHandle ?? null,
      actorDisplayName: e.actorDisplayName ?? null,
      actorExternalId: e.actorExternalId ?? null,
      messageText: truncateText(e.messageText),
      eventTimestamp: e.eventTimestamp,
      metadata: e.metadata ?? null,
    };
  });

  if (eventValues.length > 0) {
    const BATCH_SIZE = 200;
    for (let i = 0; i < eventValues.length; i += BATCH_SIZE) {
      const batch = eventValues.slice(i, i + BATCH_SIZE);
      await db
        .insert(socialEngagementEvents)
        .values(batch)
        .onDuplicateKeyUpdate({
          set: {
            actorHandle: sql`VALUES(actorHandle)`,
            actorDisplayName: sql`VALUES(actorDisplayName)`,
            messageText: sql`VALUES(messageText)`,
            metadata: sql`VALUES(metadata)`,
          },
        });
    }
    summary.eventsSynced = eventValues.length;
  }

  // 5. Aggregate interest signals
  if (campaignId) {
    summary.signalsGenerated = await aggregateInterestSignals(
      userId,
      businessId ?? null,
      campaignId
    );
  }

  return summary;
}

const EVENT_WEIGHTS: Record<EngagementEventType, number> = {
  message: 40,
  share: 35,
  comment: 25,
  save: 20,
  follow: 30,
  click: 15,
  like: 10,
  post_interaction: 5,
};

function recencyMultiplier(eventTimestamp: Date): number {
  const days = (Date.now() - eventTimestamp.getTime()) / (1000 * 60 * 60 * 24);
  if (days <= 7) return 1.0;
  if (days <= 30) return 0.7;
  if (days <= 90) return 0.4;
  return 0;
}

async function aggregateInterestSignals(
  userId: number,
  businessId: number | null,
  campaignId: number
): Promise<number> {
  const db = getDb();

  // Load all events for this campaign (or user if campaign filter is loose)
  const events = await db
    .select()
    .from(socialEngagementEvents)
    .where(
      and(
        eq(socialEngagementEvents.userId, userId),
        eq(socialEngagementEvents.campaignId, campaignId)
      )
    );

  // Group by actor identifier
  const grouped = new Map<string, typeof events>();
  for (const event of events) {
    const key = `${event.platform}:${event.externalProfileId}:${event.actorExternalId || "anonymous"}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(event);
  }

  let signalsGenerated = 0;
  for (const [key, actorEvents] of grouped.entries()) {
    if (actorEvents.length === 0) continue;

    let strength = 0;
    const sourceIds: number[] = [];
    let contextSnippet: string | null = null;
    let signalType: "engagement" | "follow" | "message" | "click" = "engagement";
    const [platformPart, externalProfileId, actorId] = key.split(":");
    const externalIdentifier = actorId === "anonymous" ? `${platformPart}:${externalProfileId}` : actorId;

    for (const event of actorEvents) {
      const weight = EVENT_WEIGHTS[event.eventType] ?? 5;
      strength += weight * recencyMultiplier(event.eventTimestamp);
      sourceIds.push(event.id);
      if (!contextSnippet && event.messageText) {
        contextSnippet = event.messageText;
      }
      if (event.eventType === "message") signalType = "message";
      else if (event.eventType === "follow") signalType = "follow";
      else if (event.eventType === "click") signalType = "click";
    }

    strength = Math.min(100, Math.round(strength));
    if (strength === 0) continue;

    const socialProfileId = actorEvents[0].socialProfileId;

    await db
      .insert(campaignInterestSignals)
      .values({
        userId,
        businessId,
        campaignId,
        socialProfileId,
        externalIdentifier,
        signalType,
        strength,
        sourceEventIds: sourceIds,
        contextSnippet: truncateText(contextSnippet),
        detectedAt: new Date(),
      })
      .onDuplicateKeyUpdate({
        set: {
          strength: sql`VALUES(strength)`,
          signalType: sql`VALUES(signalType)`,
          sourceEventIds: sql`VALUES(sourceEventIds)`,
          contextSnippet: sql`VALUES(contextSnippet)`,
          detectedAt: sql`VALUES(detectedAt)`,
          updatedAt: new Date(),
        },
      });

    signalsGenerated += 1;
  }

  return signalsGenerated;
}
