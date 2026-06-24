import { decryptToken } from "../../crypto";
import type {
  AdapterResult,
  AudiencePlatform,
  EngagementEventType,
  RawSocialProfile,
  SocialProfilePlatform,
} from "../types";

const GRAPH_API_BASE = "https://graph.facebook.com/v19.0";

function truncateText(text: string | null | undefined, maxLen = 500): string | null {
  if (!text) return null;
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + "...";
}

interface GraphPage {
  id?: string;
  name?: string;
  username?: string;
  link?: string;
  followers_count?: number;
  category?: string;
  category_list?: unknown[];
  location?: { city?: string; country?: string };
}

interface GraphPost {
  id?: string;
  message?: string;
  created_time?: string;
  likes?: { summary?: { total_count?: number } };
  shares?: { count?: number };
}

interface GraphComment {
  id?: string;
  from?: { id?: string; name?: string };
  message?: string;
  created_time?: string;
}

interface GraphListResponse<T> {
  data?: T[];
  paging?: unknown;
}

async function graphGet<T>(path: string, accessToken: string): Promise<T | null> {
  const separator = path.includes("?") ? "&" : "?";
  const url = `${GRAPH_API_BASE}${path}${separator}access_token=${encodeURIComponent(accessToken)}`;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Meta API ${res.status}: ${body.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Meta API request failed: ${message}`);
  }
}

export async function fetchMetaAudienceData(
  _userId: number,
  _businessId: number | undefined,
  encryptedToken: string
): Promise<AdapterResult> {
  const result: AdapterResult = { profiles: [], events: [], warnings: [] };

  let accessToken: string;
  try {
    accessToken = decryptToken(encryptedToken);
  } catch {
    result.warnings.push("Could not decrypt Meta access token.");
    return result;
  }

  // 1. Pages the user administers
  let pages: GraphPage[] = [];
  try {
    const accounts = await graphGet<GraphListResponse<GraphPage>>(
      "/me/accounts?fields=id,name,username,link,followers_count,category,category_list,location",
      accessToken
    );
    pages = accounts?.data || [];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.warnings.push(`Meta pages fetch failed: ${message}`);
    return result;
  }

  if (pages.length === 0) {
    result.warnings.push("No Facebook Pages found for this account.");
    return result;
  }

  for (const page of pages) {
    const pageId = String(page.id);
    const platform: SocialProfilePlatform = "facebook_page";
    const profile: RawSocialProfile = {
      platform,
      externalId: pageId,
      handle: page.username || null,
      displayName: page.name || null,
      url: page.link || `https://facebook.com/${pageId}`,
      followerCount: typeof page.followers_count === "number" ? page.followers_count : null,
      category: page.category || null,
      location: page.location?.city
        ? `${page.location.city}${page.location.country ? ", " + page.location.country : ""}`
        : null,
      profilePictureUrl: null,
      metadata: { categoryList: page.category_list },
    };
    result.profiles.push(profile);

    // 2. Recent posts for the page
    let posts: GraphPost[] = [];
    try {
      const postsRes = await graphGet<GraphListResponse<GraphPost>>(
        `/${pageId}/posts?fields=id,message,created_time,likes.summary(true),comments.summary(true),shares&limit=25`,
        accessToken
      );
      posts = postsRes?.data || [];
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.warnings.push(`Meta posts fetch failed for page ${pageId}: ${message}`);
      continue;
    }

    for (const post of posts) {
      const postId = String(post.id);
      const postTimestamp = post.created_time ? new Date(post.created_time) : new Date();

      // Likes as post_interaction events
      const likesCount = post.likes?.summary?.total_count ?? 0;
      if (likesCount > 0) {
        result.events.push({
          platform: "facebook" as AudiencePlatform,
          externalProfileId: pageId,
          externalContentId: postId,
          eventType: "like" as EngagementEventType,
          actorExternalId: null,
          actorHandle: null,
          actorDisplayName: null,
          messageText: truncateText(post.message),
          eventTimestamp: postTimestamp,
          metadata: { aggregatedCount: likesCount, kind: "page_post_like" },
        });
      }

      // Shares
      const sharesCount = post.shares?.count ?? 0;
      if (sharesCount > 0) {
        result.events.push({
          platform: "facebook" as AudiencePlatform,
          externalProfileId: pageId,
          externalContentId: postId,
          eventType: "share" as EngagementEventType,
          actorExternalId: null,
          actorHandle: null,
          actorDisplayName: null,
          messageText: truncateText(post.message),
          eventTimestamp: postTimestamp,
          metadata: { aggregatedCount: sharesCount, kind: "page_post_share" },
        });
      }

      // Comments as individual events (we only get a sample due to API limits)
      let comments: GraphComment[] = [];
      try {
        const commentsRes = await graphGet<GraphListResponse<GraphComment>>(
          `/${postId}/comments?fields=id,from,message,created_time&limit=50`,
          accessToken
        );
        comments = commentsRes?.data || [];
      } catch {
        // Ignore comment fetch errors; they require extra permissions
      }

      for (const comment of comments) {
        const actor = comment.from || {};
        result.events.push({
          platform: "facebook" as AudiencePlatform,
          externalProfileId: pageId,
          externalContentId: postId,
          eventType: "comment" as EngagementEventType,
          actorExternalId: actor.id ? String(actor.id) : null,
          actorHandle: null,
          actorDisplayName: actor.name || null,
          messageText: truncateText(comment.message),
          eventTimestamp: comment.created_time ? new Date(comment.created_time) : postTimestamp,
          metadata: { commentId: comment.id },
        });
      }
    }
  }

  return result;
}
