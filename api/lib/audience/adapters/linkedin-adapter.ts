import { decryptToken } from "../../crypto";
import type {
  AdapterResult,
  AudiencePlatform,
  EngagementEventType,
  RawSocialProfile,
  SocialProfilePlatform,
} from "../types";

const LINKEDIN_API_BASE = "https://api.linkedin.com/v2";

function truncateText(text: string | null | undefined, maxLen = 500): string | null {
  if (!text) return null;
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + "...";
}

interface LinkedInOrgAcl {
  "organization~"?: LinkedInOrganization;
}

interface LinkedInOrganization {
  id?: string;
  vanityName?: string;
  localizedName?: string;
  name?: { localized?: { en_US?: string } };
  locations?: Array<{
    address?: { city?: string; country?: string };
  }>;
  logoV2?: {
    original?: {
      "com.linkedin.common.VectorImage"?: {
        elements?: Array<{
          identifiers?: Array<{ identifier?: string }>;
        }>;
      };
    };
  };
}

interface LinkedInPost {
  id?: string;
  created?: { time?: number };
  specificContent?: {
    "com.linkedin.ugc.ShareContent"?: {
      shareCommentary?: { text?: string };
    };
  };
}

interface LinkedInComment {
  id?: string;
  actor?: string;
  message?: { text?: string };
  created?: { time?: number };
}

interface LinkedInListResponse<T> {
  elements?: T[];
}

async function linkedInGet<T>(
  path: string,
  accessToken: string,
  options?: { version?: string }
): Promise<T | null> {
  const version = options?.version ?? "202401";
  const separator = path.includes("?") ? "&" : "?";
  const url = `${LINKEDIN_API_BASE}${path}${separator}oauth2_access_token=${encodeURIComponent(
    accessToken
  )}`;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "X-Restli-Protocol-Version": "2.0.0",
        "LinkedIn-Version": version,
      },
    });
    if (res.status === 403 || res.status === 401) {
      const body = await res.text();
      throw new Error(`LinkedIn permission denied (${res.status}): ${body.slice(0, 200)}`);
    }
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`LinkedIn API ${res.status}: ${body.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`LinkedIn API request failed: ${message}`);
  }
}

export async function fetchLinkedInAudienceData(
  _userId: number,
  _businessId: number | undefined,
  encryptedToken: string
): Promise<AdapterResult> {
  const result: AdapterResult = { profiles: [], events: [], warnings: [] };

  let accessToken: string;
  try {
    accessToken = decryptToken(encryptedToken);
  } catch {
    result.warnings.push("Could not decrypt LinkedIn access token.");
    return result;
  }

  // 1. Organizations the user administers
  let organizations: LinkedInOrgAcl[] = [];
  try {
    const orgRes = await linkedInGet<LinkedInListResponse<LinkedInOrgAcl>>(
      "/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&projection=(elements*(organization~))",
      accessToken
    );
    organizations = orgRes?.elements || [];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.warnings.push(`LinkedIn organization fetch failed: ${message}`);
    return result;
  }

  if (organizations.length === 0) {
    result.warnings.push("No LinkedIn organizations found for this account.");
    return result;
  }

  for (const acl of organizations) {
    const org = acl["organization~"] || {};
    const orgId = org.id;
    if (!orgId) continue;
    const orgUrn = `urn:li:organization:${orgId}`;

    const platform: SocialProfilePlatform = "linkedin_page";
    const profile: RawSocialProfile = {
      platform,
      externalId: String(orgId),
      handle: org.vanityName || null,
      displayName: org.localizedName || org.name?.localized?.en_US || null,
      url: org.vanityName ? `https://linkedin.com/company/${org.vanityName}` : null,
      followerCount: null,
      category: null,
      location: org.locations?.[0]
        ? `${org.locations[0].address?.city || ""}${
            org.locations[0].address?.country ? ", " + org.locations[0].address.country : ""
          }`.trim() || null
        : null,
      profilePictureUrl:
        org.logoV2?.original?.["com.linkedin.common.VectorImage"]?.elements?.[0]?.identifiers?.[0]
          ?.identifier,
      metadata: { orgUrn },
    };
    result.profiles.push(profile);

    // 2. Recent posts by the organization
    let posts: LinkedInPost[] = [];
    try {
      const postsRes = await linkedInGet<LinkedInListResponse<LinkedInPost>>(
        `/posts?author=${encodeURIComponent(orgUrn)}&q=author&count=25&sortBy=LAST_MODIFIED`,
        accessToken
      );
      posts = postsRes?.elements || [];
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.warnings.push(`LinkedIn posts fetch failed for ${orgUrn}: ${message}`);
      continue;
    }

    for (const post of posts) {
      const postUrn = post.id;
      const postId = postUrn ? postUrn.replace("urn:li:share:", "") : "";
      const postTimestamp = post.created?.time ? new Date(Number(post.created.time)) : new Date();
      const commentary =
        post.specificContent?.["com.linkedin.ugc.ShareContent"]?.shareCommentary?.text || null;

      result.events.push({
        platform: "linkedin" as AudiencePlatform,
        externalProfileId: String(orgId),
        externalContentId: postId,
        eventType: "post_interaction" as EngagementEventType,
        actorExternalId: null,
        actorHandle: null,
        actorDisplayName: null,
        messageText: truncateText(commentary),
        eventTimestamp: postTimestamp,
        metadata: { postUrn, aggregated: true },
      });

      // Try to fetch comments if permissions allow
      let comments: LinkedInComment[] = [];
      if (postUrn) {
        try {
          const socialActionUrn = encodeURIComponent(
            postUrn.replace("urn:li:share:", "urn:li:activity:")
          );
          const commentsRes = await linkedInGet<LinkedInListResponse<LinkedInComment>>(
            `/socialActions/${socialActionUrn}/comments?start=0&count=50`,
            accessToken
          );
          comments = commentsRes?.elements || [];
        } catch {
          // Ignore; comments require elevated permissions
        }
      }

      for (const comment of comments) {
        const actorUrn = comment.actor;
        const actorId = actorUrn ? actorUrn.split(":").pop() : null;
        result.events.push({
          platform: "linkedin" as AudiencePlatform,
          externalProfileId: String(orgId),
          externalContentId: postId,
          eventType: "comment" as EngagementEventType,
          actorExternalId: actorId,
          actorHandle: null,
          actorDisplayName: null,
          messageText: truncateText(comment.message?.text),
          eventTimestamp: comment.created?.time
            ? new Date(Number(comment.created.time))
            : postTimestamp,
          metadata: { commentUrn: comment.id },
        });
      }
    }
  }

  return result;
}
