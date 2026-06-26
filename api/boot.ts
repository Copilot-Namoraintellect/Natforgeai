import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { HttpBindings } from "@hono/node-server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "./router";
import { createContext } from "./context";
import { env } from "./lib/env";
import { startPublishingRunner } from "./lib/workflow/publishing-runner";
import { startCreditRenewalScheduler } from "./lib/jobs/credit-renewal";
import { getOAuthState, deleteOAuthState } from "./lib/integrations/oauth-state";
import { connectRedis, isRedisConfigured } from "./lib/redis";
import { startPublishingWorker } from "./lib/queue/publishing-worker";
import {
  platformConfigs,
  selectFacebookPage,
  getFacebookGrantedPermissions,
  getInstagramAccounts,
  getLinkedInProfile,
  getTwitterProfile,
} from "./lib/integrations/platforms";
import { exchangeCodeForToken } from "./lib/integrations/oauth";
import { getDb } from "./queries/connection";
import { socialIntegrations, videoRenderJobs } from "@db/schema";
import { eq, and } from "drizzle-orm";
import { completePremiumVideo } from "./lib/creative/service";
import { CreatifyVideoProvider } from "./lib/creative/providers/creatify-video-provider";
import { encryptToken, validateEncryption } from "./lib/crypto";

// Validate encryption at startup
if (env.isProduction) {
  validateEncryption();
}

const app = new Hono<{ Bindings: HttpBindings }>();

// Start Redis if configured
if (isRedisConfigured()) {
  connectRedis().catch((err) => console.error("[Redis] Failed to connect:", err.message));
}

// Start publishing worker in production, cron runner in dev
if (env.isProduction && isRedisConfigured()) {
  startPublishingWorker();
} else {
  startPublishingRunner();
}

// Start daily credit renewal scheduler
startCreditRenewalScheduler();

app.use(bodyLimit({ maxSize: 50 * 1024 * 1024 }));

async function handleOAuthCallback(c: any) {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const error = c.req.query("error");

  console.log("[OAuth Callback] Route hit", {
    hasCode: !!code,
    hasState: !!state,
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

  console.log("[OAuth Callback] Platform resolved", {
    platform: pending.platform,
    userId: pending.userId,
  });

  try {
    const tokens = await exchangeCodeForToken(config, code);

    // Fetch account info
    let accountName: string | undefined;
    let pageId: string | undefined;
    let pageAccessToken: string | undefined;
    let permissions: string[] = config.scopes;

    try {
      if (pending.platform === "facebook") {
        const granted = await getFacebookGrantedPermissions(tokens.accessToken);
        permissions = granted.length > 0 ? granted : config.scopes;
        console.log("[OAuth Callback] Granted permissions", {
          count: permissions.length,
          permissions,
        });

        const accountsUrl =
          `https://graph.facebook.com/v18.0/me/accounts?fields=id,name,access_token,category&access_token=${tokens.accessToken}`;
        console.log("[OAuth Callback] Fetching /me/accounts", {
          url: accountsUrl.replace(tokens.accessToken, "[REDACTED]"),
        });

        const response = await fetch(accountsUrl);
        console.log("[OAuth Callback] /me/accounts HTTP status", {
          status: response.status,
        });

        const data = await response.json() as any;

        if (!response.ok || data.error) {
          const errorMessage = data?.error?.message || `HTTP ${response.status}`;
          console.error("[OAuth Callback] /me/accounts failed", {
            error: errorMessage,
            body: data,
          });
          return c.redirect(
            `/integrations?error=${encodeURIComponent(`Facebook Page lookup failed: ${errorMessage}`)}`
          );
        }

        const pages = data.data || [];
        console.log("[OAuth Callback] /me/accounts Pages returned", {
          count: pages.length,
        });

        if (pages.length === 0) {
          console.error("[OAuth Callback] No Facebook Pages returned");
          return c.redirect(
            `/integrations?error=${encodeURIComponent(
              "No Facebook Pages found for this account. Ensure you manage at least one Page and that pages_show_list is granted."
            )}`
          );
        }

        const selectedPage = selectFacebookPage(pages);
        console.log("[OAuth Callback] Selected Page", {
          name: selectedPage?.name,
          id: selectedPage?.id,
          hasAccessToken: !!selectedPage?.access_token,
        });

        if (!selectedPage?.access_token) {
          return c.redirect(
            `/integrations?error=${encodeURIComponent(
              "Selected Facebook Page has no access token. Try reconnecting or selecting a different Page."
            )}`
          );
        }

        accountName = selectedPage.name;
        pageId = selectedPage.id;
        pageAccessToken = selectedPage.access_token;
      } else if (pending.platform === "instagram") {
        const accountsUrl =
          `https://graph.facebook.com/v18.0/me/accounts?fields=id,name,access_token,category&access_token=${tokens.accessToken}`;
        const response = await fetch(accountsUrl);
        const data = await response.json() as any;
        const pages = data.data || [];
        const igAccount = pages[0]
          ? await getInstagramAccounts(tokens.accessToken, pages[0].id)
          : null;
        accountName = igAccount
          ? `Instagram (${pages[0]?.name})`
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
      console.error("[OAuth Callback] Failed to fetch account info:", err.message);
      return c.redirect(
        `/integrations?error=${encodeURIComponent(`Account info lookup failed: ${err.message}`)}`
      );
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

    console.log("[OAuth Callback] Integration saved", {
      platform: pending.platform,
      userId: pending.userId,
      accountName,
      pageId,
      hasPageToken: !!pageAccessToken,
    });

    return c.redirect(`/integrations?success=${pending.platform}`);
  } catch (err: any) {
    console.error("[OAuth Callback] Error:", err.message);
    return c.redirect(`/integrations?error=${encodeURIComponent(err.message)}`);
  }
}

// OAuth callback endpoint - handles redirects from social platforms
app.get("/api/oauth/callback", handleOAuthCallback);

// Alias for legacy Meta redirect URI configuration
app.get("/api/oauth/meta/callback", handleOAuthCallback);

// Webhook endpoints for inbound social platform messages
// For now: verify signatures where possible and log payloads safely
app.post("/api/webhooks/:platform", async (c) => {
  const platform = c.req.param("platform");
  const payload = await c.req.json().catch(() => null);
  const signature = c.req.header("x-hub-signature-256") || c.req.header("x-twilio-signature") || c.req.header("x-zendesk-webhook-signature") || "";

  console.log(`[Webhook ${platform}] Received payload`, {
    timestamp: new Date().toISOString(),
    signaturePresent: !!signature,
    payloadKeys: payload ? Object.keys(payload) : null,
  });

  // Creatify video generation webhook
  if (platform === "creatify") {
    const providerJobId = payload?.id;
    if (!providerJobId) {
      return c.json({ received: false, error: "Missing Creatify job id" }, 400);
    }

    try {
      const db = getDb();
      const [job] = await db
        .select()
        .from(videoRenderJobs)
        .where(eq(videoRenderJobs.renderJobId, String(providerJobId)))
        .limit(1);

      if (!job) {
        console.warn(`[Webhook creatify] Job not found | providerJobId=${providerJobId}`);
        return c.json({ received: false, error: "Job not found" }, 404);
      }

      const provider = new CreatifyVideoProvider();
      const result = provider.parseVideoResponse(payload);
      await completePremiumVideo({ userId: job.userId, providerJobId: String(providerJobId), resultOverride: result });
      return c.json({ received: true, providerJobId });
    } catch (err: any) {
      console.error(`[Webhook creatify] Error processing webhook | providerJobId=${providerJobId} | error="${err.message}"`);
      return c.json({ received: false, error: err.message }, 500);
    }
  }

  // Meta (Facebook/Instagram/WhatsApp) signature verification placeholder
  if (platform === "facebook" || platform === "instagram" || platform === "whatsapp") {
    const appSecret = process.env.FACEBOOK_APP_SECRET || "";
    if (appSecret && signature) {
      // In production: verify HMAC-SHA256 signature
      // const expectedSig = "sha256=" + crypto.createHmac("sha256", appSecret).update(JSON.stringify(payload)).digest("hex");
      // if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig))) { return c.json({ error: "Invalid signature" }, 401); }
      console.log(`[Webhook ${platform}] Signature verification skipped (FACEBOOK_APP_SECRET configured)`);
    } else {
      console.log(`[Webhook ${platform}] No signature verification (FACEBOOK_APP_SECRET not configured)`);
    }
  }

  // Return 200 OK quickly — platforms expect fast responses
  return c.json({ received: true, platform, timestamp: Date.now() });
});

// Meta webhook verification (GET challenge)
app.get("/api/webhooks/:platform", async (c) => {
  const platform = c.req.param("platform");
  const mode = c.req.query("hub.mode");
  const token = c.req.query("hub.verify_token");
  const challenge = c.req.query("hub.challenge");

  if (mode === "subscribe" && token === process.env.FACEBOOK_WEBHOOK_VERIFY_TOKEN) {
    console.log(`[Webhook ${platform}] Subscription verified`);
    return c.text(challenge || "OK");
  }

  return c.json({ received: true, platform }, 200);
});

// tRPC handler
app.use("/api/trpc/*", async (c) => {
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req: c.req.raw,
    router: appRouter,
    createContext,
    allowMethodOverride: true,
  });
});

app.all("/api/*", (c) => c.json({ error: "Not Found" }, 404));

export default app;

if (env.isProduction) {
  const { serve } = await import("@hono/node-server");
  const { serveStaticFiles, servePersistentMedia } = await import("./lib/vite");
  serveStaticFiles(app);
  servePersistentMedia(app);

  const port = parseInt(process.env.PORT || "3001", 10);

  serve(
    {
      fetch: app.fetch,
      port,
      hostname: "127.0.0.1",
    },
    () => {
      console.log(`[API] NatForgeAI backend listening on http://127.0.0.1:${port}`);
    }
  );
}
