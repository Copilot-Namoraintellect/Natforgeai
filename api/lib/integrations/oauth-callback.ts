import { platformConfigs } from "./platforms";
import {
  fetchFacebookPages,
  selectFacebookPage,
  getFacebookGrantedPermissions,
  fetchInstagramBusinessAccount,
  getLinkedInProfile,
  getTwitterProfile,
} from "./platforms";
import { exchangeCodeForToken } from "./oauth";
import { getOAuthState, deleteOAuthState } from "./oauth-state";
import { getDb } from "../../queries/connection";
import { socialIntegrations } from "@db/schema";
import { eq, and } from "drizzle-orm";
import { encryptToken } from "../crypto";

export function hasInstagramPublishingPermission(permissions: string[]): boolean {
  return (
    permissions.includes("instagram_basic") &&
    (permissions.includes("instagram_content_publishing") ||
      permissions.includes("instagram_content_publish"))
  );
}

export interface MetaOAuthConnectionResult {
  platform: string;
  accountName?: string;
  pageId?: string;
  instagramBusinessAccountId?: string;
  instagramAccountName?: string;
  permissions: string[];
  facebookRowUpserted: boolean;
  instagramRowUpserted: boolean;
  instagramSkipReason?: string;
}

/**
 * Shared Meta/Facebook OAuth processing. Fetches granted permissions, Facebook Pages,
 * and any linked Instagram Business account, then upserts `social_integrations` rows.
 */
export async function processMetaOAuthConnection(
  db: any,
  pending: { userId: number; platform: string; businessId?: number | null },
  tokens: { accessToken: string; refreshToken?: string }
): Promise<MetaOAuthConnectionResult> {
  const isMetaPlatform = pending.platform === "facebook" || pending.platform === "instagram";

  let accountName: string | undefined;
  let pageId: string | undefined;
  let pageAccessToken: string | undefined;
  let instagramBusinessAccountId: string | undefined;
  let instagramAccountName: string | undefined;
  let permissions: string[] = platformConfigs[pending.platform]?.scopes ?? [];

  if (isMetaPlatform) {
    const granted = await getFacebookGrantedPermissions(tokens.accessToken);
    permissions = granted.length > 0 ? granted : platformConfigs[pending.platform].scopes;
    console.log("[OAuth Callback] Granted permission names", {
      platform: pending.platform,
      userId: pending.userId,
      permissions,
    });

    const pagesResult = await fetchFacebookPages(tokens.accessToken);
    console.log("[OAuth Callback] /me/accounts result", {
      platform: pending.platform,
      userId: pending.userId,
      ok: pagesResult.ok,
      status: pagesResult.status,
      count: pagesResult.pages.length,
      error: pagesResult.error,
    });

    if (!pagesResult.ok) {
      throw new Error(`Facebook Page lookup failed: ${pagesResult.error}`);
    }

    if (pagesResult.pages.length === 0) {
      throw new Error(
        "No Facebook Pages found for this account. Ensure you manage at least one Page and that pages_show_list is granted."
      );
    }

    const selectedPage = selectFacebookPage(pagesResult.pages);
    pageId = selectedPage?.id;
    pageAccessToken = selectedPage?.access_token;
    accountName = selectedPage?.name;

    console.log("[OAuth Callback] Selected Facebook Page", {
      platform: pending.platform,
      userId: pending.userId,
      pageId,
      pageName: selectedPage?.name,
      hasPageToken: !!pageAccessToken,
    });

    if (!pageAccessToken) {
      throw new Error(
        "Selected Facebook Page has no access token. Try reconnecting or selecting a different Page."
      );
    }

    try {
      const igAccount = await fetchInstagramBusinessAccount(pageAccessToken, pageId!);
      if (igAccount?.id) {
        instagramBusinessAccountId = igAccount.id;
        instagramAccountName = igAccount.username || `Instagram (${accountName})`;
        console.log("[OAuth Callback] Linked Instagram business account found", {
          platform: pending.platform,
          userId: pending.userId,
          pageId,
          instagramBusinessAccountId,
          username: igAccount.username,
        });
      } else {
        console.log("[OAuth Callback] No linked Instagram business account on selected Page", {
          platform: pending.platform,
          userId: pending.userId,
          pageId,
        });
      }
    } catch (err: any) {
      console.error("[OAuth Callback] Instagram business account lookup failed", {
        platform: pending.platform,
        userId: pending.userId,
        pageId,
        error: err.message,
      });
    }

    if (pending.platform === "instagram") {
      accountName = instagramAccountName || "Instagram Business";
    }
  } else if (pending.platform === "linkedin") {
    const profile = await getLinkedInProfile(tokens.accessToken);
    accountName = `${profile.localizedFirstName || ""} ${profile.localizedLastName || ""}`.trim() || "LinkedIn Profile";
  } else if (pending.platform === "twitter") {
    const profile = await getTwitterProfile(tokens.accessToken);
    accountName = profile.data?.username ? `@${profile.data.username}` : "Twitter/X Account";
  }

  // Upsert the Facebook/Meta platform row
  const [existing] = await db
    .select()
    .from(socialIntegrations)
    .where(
      and(
        eq(socialIntegrations.userId, pending.userId),
        eq(socialIntegrations.platform, pending.platform as any)
      )
    )
    .limit(1);

  const platformPayload = {
    accessTokenEncrypted: encryptToken(tokens.accessToken),
    refreshTokenEncrypted: tokens.refreshToken ? encryptToken(tokens.refreshToken) : null,
    pageId: pageId || existing?.pageId || null,
    pageAccessTokenEncrypted: pageAccessToken
      ? encryptToken(pageAccessToken)
      : existing?.pageAccessTokenEncrypted || null,
    accountName: accountName || existing?.accountName || null,
    businessId: pending.businessId ?? existing?.businessId ?? null,
    permissions: permissions as any,
    status: "connected" as const,
    lastSyncAt: new Date(),
  };

  if (existing) {
    await db.update(socialIntegrations).set(platformPayload).where(eq(socialIntegrations.id, existing.id));
    console.log("[OAuth Callback] Platform row updated", {
      userId: pending.userId,
      platform: pending.platform,
      pageId,
      accountName,
    });
  } else {
    await db.insert(socialIntegrations).values({
      userId: pending.userId,
      platform: pending.platform as any,
      ...platformPayload,
    });
    console.log("[OAuth Callback] Platform row inserted", {
      userId: pending.userId,
      platform: pending.platform,
      pageId,
      accountName,
    });
  }

  // Upsert a separate Instagram row when the Page has a linked IG account and permissions allow it
  const canPublishToInstagram = hasInstagramPublishingPermission(permissions);
  let instagramRowUpserted = false;
  let instagramSkipReason: string | undefined;

  if (instagramBusinessAccountId && pageAccessToken && canPublishToInstagram) {
    const [existingInstagram] = await db
      .select()
      .from(socialIntegrations)
      .where(
        and(
          eq(socialIntegrations.userId, pending.userId),
          eq(socialIntegrations.platform, "instagram")
        )
      )
      .limit(1);

    const instagramPayload = {
      accessTokenEncrypted: encryptToken(tokens.accessToken),
      refreshTokenEncrypted: tokens.refreshToken ? encryptToken(tokens.refreshToken) : null,
      pageId: pageId || null,
      pageAccessTokenEncrypted: encryptToken(pageAccessToken),
      instagramBusinessAccountId,
      accountName: instagramAccountName || "Instagram Business",
      businessId: pending.businessId ?? existingInstagram?.businessId ?? null,
      permissions: permissions as any,
      status: "connected" as const,
      lastSyncAt: new Date(),
    };

    if (existingInstagram) {
      await db
        .update(socialIntegrations)
        .set(instagramPayload)
        .where(eq(socialIntegrations.id, existingInstagram.id));
      console.log("[OAuth Callback] Instagram row updated", {
        userId: pending.userId,
        instagramBusinessAccountId,
        accountName: instagramAccountName,
        pageId,
      });
    } else {
      await db.insert(socialIntegrations).values({
        userId: pending.userId,
        platform: "instagram",
        ...instagramPayload,
      });
      console.log("[OAuth Callback] Instagram row inserted", {
        userId: pending.userId,
        instagramBusinessAccountId,
        accountName: instagramAccountName,
        pageId,
      });
    }
    instagramRowUpserted = true;
  } else {
    instagramSkipReason = !canPublishToInstagram
      ? "Missing instagram_basic or instagram_content_publishing permission"
      : "Selected Facebook Page has no linked Instagram professional account";
    console.log("[OAuth Callback] Instagram row skipped", {
      userId: pending.userId,
      platform: pending.platform,
      pageId,
      reason: instagramSkipReason,
      hasLinkedIgAccount: !!instagramBusinessAccountId,
      hasPublishingPermission: canPublishToInstagram,
    });
  }

  return {
    platform: pending.platform,
    accountName,
    pageId,
    instagramBusinessAccountId,
    instagramAccountName,
    permissions,
    facebookRowUpserted: true,
    instagramRowUpserted,
    instagramSkipReason,
  };
}

export async function handleOAuthCallback(c: any) {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const error = c.req.query("error");

  console.log("[OAuth Callback] Route hit", {
    platform: "meta",
    hasState: !!state,
    hasCode: !!code,
    error,
  });

  if (error) {
    const errorDescription = c.req.query("error_description") || error;
    return c.redirect(`/integrations?error=${encodeURIComponent(errorDescription)}`);
  }

  if (!code || !state) {
    return c.redirect("/integrations?error=missing_oauth_params");
  }

  const pending = await getOAuthState(state);
  if (!pending) {
    return c.redirect("/integrations?error=invalid_oauth_state");
  }

  await deleteOAuthState(state);

  const config = platformConfigs[pending.platform];
  if (!config) {
    return c.redirect(`/integrations?error=unsupported_platform_${pending.platform}`);
  }

  console.log("[OAuth Callback] State resolved", {
    platform: pending.platform,
    userId: pending.userId,
  });

  try {
    const tokens = await exchangeCodeForToken(config, code);
    const db = getDb();
    const result = await processMetaOAuthConnection(db, pending, tokens);

    console.log("[OAuth Callback] Redirecting with success", {
      platform: result.platform,
      userId: pending.userId,
      pageId: result.pageId,
      accountName: result.accountName,
      instagramRowUpserted: result.instagramRowUpserted,
      instagramSkipReason: result.instagramSkipReason,
    });

    return c.redirect(`/integrations?success=${pending.platform}`);
  } catch (err: any) {
    console.error("[OAuth Callback] Error", {
      platform: pending.platform,
      userId: pending.userId,
      error: err.message,
    });
    return c.redirect(`/integrations?error=${encodeURIComponent(err.message)}`);
  }
}
