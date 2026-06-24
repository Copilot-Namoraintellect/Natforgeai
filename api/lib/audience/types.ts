/**
 * Shared types for the Audience Intelligence ingestion layer.
 * All data comes from official/permissioned APIs — no scraping.
 */

export type AudiencePlatform =
  | "facebook"
  | "instagram"
  | "linkedin"
  | "tiktok"
  | "twitter";

export type SocialProfilePlatform =
  | "facebook_page"
  | "instagram_account"
  | "linkedin_page"
  | "tiktok_account"
  | "twitter_account";

export type EngagementEventType =
  | "follow"
  | "like"
  | "comment"
  | "share"
  | "message"
  | "click"
  | "save"
  | "post_interaction";

export interface RawSocialProfile {
  platform: SocialProfilePlatform;
  externalId: string;
  handle?: string | null;
  displayName?: string | null;
  url?: string | null;
  followerCount?: number | null;
  category?: string | null;
  location?: string | null;
  profilePictureUrl?: string | null;
  metadata?: Record<string, unknown>;
}

export interface RawEngagementEvent {
  platform: AudiencePlatform;
  externalProfileId: string;
  externalContentId?: string | null;
  eventType: EngagementEventType;
  actorHandle?: string | null;
  actorDisplayName?: string | null;
  actorExternalId?: string | null;
  messageText?: string | null;
  eventTimestamp: Date;
  metadata?: Record<string, unknown>;
}

export interface AdapterResult {
  profiles: RawSocialProfile[];
  events: RawEngagementEvent[];
  warnings: string[];
}

export interface AudienceIngestionSummary {
  profilesSynced: number;
  eventsSynced: number;
  signalsGenerated: number;
  warnings: string[];
}

export interface IngestionAdapter {
  name: string;
  fetch(userId: number, businessId: number | undefined, accessToken: string): Promise<AdapterResult>;
}
