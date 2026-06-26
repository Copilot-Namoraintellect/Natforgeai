import { z } from "zod";
import { randomBytes } from "crypto";
import { createRouter, authedQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { socialIntegrations } from "@db/schema";
import { eq, and } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { env } from "./lib/env";
import {
  getOAuthUrl,
  exchangeCodeForToken,
  refreshAccessToken,
} from "./lib/integrations/oauth";
import {
  platformConfigs,
  getMetaOAuthScopes,
  fetchFacebookPages,
  selectFacebookPage,
  getFacebookGrantedPermissions,
  getInstagramAccounts,
  getLinkedInProfile,
  getTwitterProfile,
  isFacebookPublishingReady,
} from "./lib/integrations/platforms";
import { setOAuthState, getOAuthState, deleteOAuthState } from "./lib/integrations/oauth-state";
import { encryptToken, decryptToken } from "./lib/crypto";

function generateOAuthState(): string {
  return randomBytes(16).toString("hex");
}

export const integrationRouter = createRouter({
  getPlatformConfigStatus: authedQuery.query(async () => {
    return {
      metaConfigured: !!(env.metaAppId && env.metaAppSecret && env.metaRedirectUri),
      linkedinConfigured: !!(
        env.linkedinClientId &&
        env.linkedinClientSecret &&
        env.linkedinRedirectUri
      ),
    };
  }),

  getConnectedPlatforms: authedQuery.query(async ({ ctx }) => {
    const db = getDb();
    const rows = await db
      .select({
        id: socialIntegrations.id,
        provider: socialIntegrations.platform,
        providerAccountName: socialIntegrations.accountName,
        status: socialIntegrations.status,
        permissions: socialIntegrations.permissions,
        pageId: socialIntegrations.pageId,
        pageAccessTokenEncrypted: socialIntegrations.pageAccessTokenEncrypted,
        createdAt: socialIntegrations.createdAt,
      })
      .from(socialIntegrations)
      .where(eq(socialIntegrations.userId, ctx.user.id));

    return rows.map((row) => ({
      ...row,
      ready:
        row.status === "connected" &&
        (row.provider === "facebook"
          ? isFacebookPublishingReady(row)
          : ["instagram", "linkedin", "twitter", "tiktok", "email"].includes(row.provider)),
    }));
  }),

  initiateConnection: authedQuery
    .input(z.object({ provider: z.enum(["meta", "linkedin"]) }))
    .mutation(async ({ ctx, input }) => {
      if (input.provider === "meta") {
        if (!env.metaAppId || !env.metaAppSecret || !env.metaRedirectUri) {
          return {
            success: false as const,
            code: "NOT_CONFIGURED" as const,
            message: "This connection is not configured yet.",
          };
        }

        const state = generateOAuthState();
        await setOAuthState(state, { userId: ctx.user.id, platform: input.provider });

        const scopes = getMetaOAuthScopes();
        const authUrl =
          `https://www.facebook.com/v18.0/dialog/oauth?` +
          `client_id=${encodeURIComponent(env.metaAppId)}` +
          `&redirect_uri=${encodeURIComponent(env.metaRedirectUri)}` +
          `&scope=${encodeURIComponent(scopes.join(","))}` +
          `&state=${encodeURIComponent(state)}`;

        return { success: true as const, authUrl };
      }

      if (!env.linkedinClientId || !env.linkedinClientSecret || !env.linkedinRedirectUri) {
        return {
          success: false as const,
          code: "NOT_CONFIGURED" as const,
          message: "This connection is not configured yet.",
        };
      }

      const state = generateOAuthState();
      await setOAuthState(state, { userId: ctx.user.id, platform: input.provider });

      const authUrl =
        `https://www.linkedin.com/oauth/v2/authorization?` +
        `response_type=code` +
        `&client_id=${encodeURIComponent(env.linkedinClientId)}` +
        `&redirect_uri=${encodeURIComponent(env.linkedinRedirectUri)}` +
        `&scope=${encodeURIComponent(
          "r_basicprofile,r_organization_social,w_organization_social,r_ads"
        )}` +
        `&state=${encodeURIComponent(state)}`;

      return { success: true as const, authUrl };
    }),

  disconnectPlatform: authedQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      await db
        .delete(socialIntegrations)
        .where(
          and(
            eq(socialIntegrations.id, input.id),
            eq(socialIntegrations.userId, ctx.user.id)
          )
        );
      return { success: true as const };
    }),

  // Legacy OAuth URL helper (used by the dedicated Integrations page for all platforms)
  getOAuthUrl: authedQuery
    .input(
      z.object({
        platform: z.enum([
          "facebook",
          "instagram",
          "linkedin",
          "tiktok",
          "twitter",
          "whatsapp",
          "email",
        ]),
      })
    )
    .query(async ({ ctx, input }) => {
      const config = platformConfigs[input.platform];
      if (!config || !config.clientId) {
        throw new TRPCError({
          code: "NOT_IMPLEMENTED",
          message: `${input.platform} integration is not configured. Add the client ID to environment variables.`,
        });
      }

      const state = `${input.platform}_${ctx.user.id}_${Date.now()}`;
      await setOAuthState(state, { userId: ctx.user.id, platform: input.platform });

      const url = getOAuthUrl(config, state);
      return { url, state };
    }),

  oauthCallback: authedQuery
    .input(
      z.object({
        code: z.string(),
        state: z.string(),
      })
    )
    .mutation(async ({ input }) => {
      console.log("[Integration OAuth Callback] Mutation hit", {
        hasCode: !!input.code,
        hasState: !!input.state,
      });

      const pending = await getOAuthState(input.state);
      if (!pending) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid OAuth state" });
      }

      await deleteOAuthState(input.state);

      const config = platformConfigs[pending.platform];
      if (!config) {
        throw new TRPCError({
          code: "NOT_IMPLEMENTED",
          message: `${pending.platform} is not supported`,
        });
      }

      console.log("[Integration OAuth Callback] Platform resolved", {
        platform: pending.platform,
        userId: pending.userId,
      });

      const tokens = await exchangeCodeForToken(config, input.code);

      // Fetch account info
      let accountName: string | undefined;
      let pageId: string | undefined;
      let pageAccessToken: string | undefined;
      let permissions: string[] = config.scopes;

      try {
        if (pending.platform === "facebook") {
          const granted = await getFacebookGrantedPermissions(tokens.accessToken);
          permissions = granted.length > 0 ? granted : config.scopes;
          console.log("[Integration OAuth Callback] Granted permissions", {
            platform: pending.platform,
            count: permissions.length,
            permissions,
          });

          const pagesResult = await fetchFacebookPages(tokens.accessToken);
          console.log("[Integration OAuth Callback] /me/accounts result", {
            ok: pagesResult.ok,
            status: pagesResult.status,
            count: pagesResult.pages.length,
            error: pagesResult.error,
          });

          if (!pagesResult.ok) {
            throw new TRPCError({
              code: "INTERNAL_SERVER_ERROR",
              message: `Facebook Page lookup failed: ${pagesResult.error}`,
            });
          }

          if (pagesResult.pages.length === 0) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message:
                "No Facebook Pages found for this account. Ensure you manage at least one Page and that pages_show_list is granted.",
            });
          }

          const selectedPage = selectFacebookPage(pagesResult.pages);
          console.log("[Integration OAuth Callback] Selected Page", {
            name: selectedPage?.name,
            id: selectedPage?.id,
            hasAccessToken: !!selectedPage?.access_token,
          });

          if (!selectedPage?.access_token) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "Selected Facebook Page has no access token.",
            });
          }

          accountName = selectedPage.name;
          pageId = selectedPage.id;
          pageAccessToken = selectedPage.access_token;
        } else if (pending.platform === "instagram") {
          const pagesResult = await fetchFacebookPages(tokens.accessToken);
          const igAccount = pagesResult.pages[0]
            ? await getInstagramAccounts(tokens.accessToken, pagesResult.pages[0].id)
            : null;
          accountName = igAccount
            ? `Instagram (${pagesResult.pages[0]?.name})`
            : "Instagram Business";
        } else if (pending.platform === "linkedin") {
          const profile = await getLinkedInProfile(tokens.accessToken);
          accountName = `${profile.localizedFirstName || ""} ${profile.localizedLastName || ""}`.trim() || "LinkedIn Profile";
        } else if (pending.platform === "twitter") {
          const profile = await getTwitterProfile(tokens.accessToken);
          accountName = profile.data?.username
            ? `@${profile.data.username}`
            : "Twitter/X Account";
        }
      } catch (err: any) {
        console.error("[Integration] Failed to fetch account info:", err.message);
        if (err instanceof TRPCError) throw err;
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Account info lookup failed: ${err.message}`,
        });
      }

      const db = getDb();

      // Check if integration already exists
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

      if (existing) {
        await db
          .update(socialIntegrations)
          .set({
            accessTokenEncrypted: encryptToken(tokens.accessToken),
            refreshTokenEncrypted: tokens.refreshToken ? encryptToken(tokens.refreshToken) : null,
            pageId: pageId || existing.pageId || null,
            pageAccessTokenEncrypted: pageAccessToken
              ? encryptToken(pageAccessToken)
              : existing.pageAccessTokenEncrypted || null,
            accountName: accountName || null,
            permissions: permissions as any,
            status: "connected",
            lastSyncAt: new Date(),
          })
          .where(eq(socialIntegrations.id, existing.id));
      } else {
        await db.insert(socialIntegrations).values({
          userId: pending.userId,
          platform: pending.platform as any,
          accountName: accountName || null,
          accessTokenEncrypted: encryptToken(tokens.accessToken),
          refreshTokenEncrypted: tokens.refreshToken ? encryptToken(tokens.refreshToken) : null,
          pageId: pageId || null,
          pageAccessTokenEncrypted: pageAccessToken ? encryptToken(pageAccessToken) : null,
          permissions: permissions as any,
          status: "connected",
          lastSyncAt: new Date(),
        });
      }

      return { success: true, platform: pending.platform };
    }),

  connectPlatform: authedQuery
    .input(
      z.object({
        platform: z.enum([
          "facebook",
          "instagram",
          "linkedin",
          "tiktok",
          "twitter",
          "whatsapp",
          "email",
        ]),
        authCode: z.string(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // This is an alternative flow where the frontend handles OAuth
      // and sends the auth code directly
      const config = platformConfigs[input.platform];
      if (!config) {
        throw new TRPCError({
          code: "NOT_IMPLEMENTED",
          message: `${input.platform} is not supported`,
        });
      }

      const tokens = await exchangeCodeForToken(config, input.authCode);

      const db = getDb();
      await db.insert(socialIntegrations).values({
        userId: ctx.user.id,
        platform: input.platform,
        accessTokenEncrypted: encryptToken(tokens.accessToken),
        refreshTokenEncrypted: tokens.refreshToken ? encryptToken(tokens.refreshToken) : null,
        permissions: config.scopes as any,
        status: "connected",
        lastSyncAt: new Date(),
      });

      return { success: true };
    }),

  refreshPlatformToken: authedQuery
    .input(
      z.object({
        platform: z.enum([
          "facebook",
          "instagram",
          "linkedin",
          "tiktok",
          "twitter",
          "whatsapp",
          "email",
        ]),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();

      const [integration] = await db
        .select()
        .from(socialIntegrations)
        .where(
          and(
            eq(socialIntegrations.userId, ctx.user.id),
            eq(socialIntegrations.platform, input.platform)
          )
        )
        .limit(1);

      if (!integration || !integration.refreshTokenEncrypted) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "No refresh token available",
        });
      }

      const config = platformConfigs[input.platform];
      if (!config) {
        throw new TRPCError({ code: "NOT_IMPLEMENTED", message: "Platform not supported" });
      }

      const refreshToken = decryptToken(integration.refreshTokenEncrypted);
      const tokens = await refreshAccessToken(
        {
          tokenUrl: config.tokenUrl,
          clientId: config.clientId,
          clientSecret: config.clientSecret,
        },
        refreshToken
      );

      await db
        .update(socialIntegrations)
        .set({
          accessTokenEncrypted: encryptToken(tokens.accessToken),
          refreshTokenEncrypted: tokens.refreshToken ? encryptToken(tokens.refreshToken) : integration.refreshTokenEncrypted,
          lastSyncAt: new Date(),
        })
        .where(eq(socialIntegrations.id, integration.id));

      return { success: true };
    }),

  testConnection: authedQuery
    .input(
      z.object({
        platform: z.enum([
          "facebook",
          "instagram",
          "linkedin",
          "tiktok",
          "twitter",
          "whatsapp",
          "email",
        ]),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();

      const [integration] = await db
        .select()
        .from(socialIntegrations)
        .where(
          and(
            eq(socialIntegrations.userId, ctx.user.id),
            eq(socialIntegrations.platform, input.platform)
          )
        )
        .limit(1);

      if (!integration || integration.status !== "connected") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Platform not connected",
        });
      }

      try {
        if (input.platform === "facebook") {
          const accessToken = decryptToken(integration.accessTokenEncrypted || "");
          const pagesResult = await fetchFacebookPages(accessToken);
          if (!pagesResult.ok) {
            throw new Error(pagesResult.error || `HTTP ${pagesResult.status}`);
          }
          return { success: true, pages: pagesResult.pages.length };
        } else if (input.platform === "linkedin") {
          const accessToken = decryptToken(integration.accessTokenEncrypted || "");
          const profile = await getLinkedInProfile(accessToken);
          return { success: true, profile: profile.localizedFirstName };
        } else if (input.platform === "twitter") {
          const accessToken = decryptToken(integration.accessTokenEncrypted || "");
          const profile = await getTwitterProfile(accessToken);
          return { success: true, username: profile.data?.username };
        }

        return { success: true };
      } catch (err: any) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Connection test failed: ${err.message}`,
        });
      }
    }),
});
