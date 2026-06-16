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
  getFacebookPages,
  getInstagramAccounts,
  getLinkedInProfile,
  getTwitterProfile,
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
    return db
      .select({
        id: socialIntegrations.id,
        provider: socialIntegrations.platform,
        providerAccountName: socialIntegrations.accountName,
        status: socialIntegrations.status,
        createdAt: socialIntegrations.createdAt,
      })
      .from(socialIntegrations)
      .where(eq(socialIntegrations.userId, ctx.user.id));
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

        const authUrl =
          `https://www.facebook.com/v18.0/dialog/oauth?` +
          `client_id=${encodeURIComponent(env.metaAppId)}` +
          `&redirect_uri=${encodeURIComponent(env.metaRedirectUri)}` +
          `&scope=${encodeURIComponent(
            "pages_read_engagement,pages_manage_posts,instagram_basic,instagram_content_publish"
          )}` +
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

      const tokens = await exchangeCodeForToken(config, input.code);

      // Fetch account info
      let accountName: string | undefined;
      let permissions: string[] = config.scopes;

      try {
        if (pending.platform === "facebook") {
          const pages = await getFacebookPages(tokens.accessToken);
          accountName = pages[0]?.name || "Facebook Page";
          permissions = ["pages_manage_posts", "pages_read_engagement"];
        } else if (pending.platform === "instagram") {
          const pages = await getFacebookPages(tokens.accessToken);
          const igAccount = pages[0]
            ? await getInstagramAccounts(tokens.accessToken, pages[0].id)
            : null;
          accountName = igAccount
            ? `Instagram (${pages[0]?.name})`
            : "Instagram Business";
          permissions = ["instagram_content_publish"];
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
          const pages = await getFacebookPages(accessToken);
          return { success: true, pages: pages.length };
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
