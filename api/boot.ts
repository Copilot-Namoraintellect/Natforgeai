import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { HttpBindings } from "@hono/node-server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "./router";
import { createContext } from "./context";
import { env } from "./lib/env";
import { startPublishingRunner } from "./lib/workflow/publishing-runner";
import { startCreditRenewalScheduler } from "./lib/jobs/credit-renewal";
import { connectRedis, isRedisConfigured } from "./lib/redis";
import { startPublishingWorker } from "./lib/queue/publishing-worker";
import { handleOAuthCallback } from "./lib/integrations/oauth-callback";
import { getDb } from "./queries/connection";
import { videoRenderJobs } from "@db/schema";
import { eq } from "drizzle-orm";
import { completePremiumVideo } from "./lib/creative/service";
import { CreatifyVideoProvider } from "./lib/creative/providers/creatify-video-provider";
import { validateEncryption } from "./lib/crypto";

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
