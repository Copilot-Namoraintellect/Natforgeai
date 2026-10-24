import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { HttpBindings } from "@hono/node-server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "./router";
import { createContext } from "./context";
import { env } from "./lib/env";
import { startPublishingRunner } from "./lib/workflow/publishing-runner";
import { startCreditRenewalScheduler } from "./lib/jobs/credit-renewal";
import { startPostLiveLifecycleScheduler } from "./lib/workflow/post-live-lifecycle-scheduler";
import { startPostLiveMetricsObservationScheduler } from "./lib/workflow/post-live-metrics-observation-scheduler";
import { runApprovalContinuationSweep } from "./lib/workflow/approval-continuation";
import { runEngagementContinuationSweep } from "./lib/engagement/continuation";
import { runEngagementReconciliationSweep } from "./lib/engagement/execution";
import { connectRedis, isRedisConfigured } from "./lib/redis";
import { startPublishingWorker } from "./lib/queue/publishing-worker";
import { startContentGenerationWorker } from "./lib/queue/content-generation-worker";
import { handleOAuthCallback } from "./lib/integrations/oauth-callback";
import { processInboundWebhook } from "./lib/engagement/inbound";
import { processListeningWebhook } from "./lib/social-listening/webhook-ingest";
import { startListeningPollingScheduler } from "./lib/social-listening/polling-scheduler";
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
  startContentGenerationWorker();
} else {
  startPublishingRunner();
}

// Start daily credit renewal scheduler
startCreditRenewalScheduler();

// Post-live lifecycle reconciliation is deliberately default-off.
// Production activation requires explicit operational configuration.
if (env.postLiveLifecycleEnabled) {
  startPostLiveLifecycleScheduler({
    intervalMs: env.postLiveLifecycleIntervalMs,
  });
}

// Post-live metrics observation is part of normal platform autonomy and
// starts by default; set POST_LIVE_METRICS_OBSERVATION_ENABLED=false to
// disable it explicitly.
if (env.postLiveMetricsObservationEnabled) {
  startPostLiveMetricsObservationScheduler({
    intervalMs: env.postLiveMetricsObservationIntervalMs,
  });
}

// WBS-R5-A social listening polling is default-off and runs only against
// operator-configured provider fetch seams; without them the pass fails
// closed with OPERATOR_ACTION rather than faking success.
if (env.socialListeningPollingEnabled) {
  startListeningPollingScheduler({
    intervalMs: env.socialListeningPollingIntervalMs,
  });
}

// WBS-R4 A3: crash-recovery reconciliation for dangling approval
// continuations (a decision committed but its post-commit dispatch did not
// run). Fire-and-forget and NOT env-gated: the sweep only acts on decided
// approvals whose continuation evidence shows it never applied, and a sweep
// failure must never crash the server.
void runApprovalContinuationSweep()
  .then((summary) => {
    console.log(
      `[ApprovalContinuation] Boot sweep complete: ${summary.scanned} scanned, ${summary.reconciled} reconciled, ${summary.skipped} skipped, ${summary.failed} failed.`
    );
  })
  .catch((err) => {
    console.error(
      "[ApprovalContinuation] Boot sweep failed:",
      err instanceof Error ? err.message : err
    );
  });

// WBS-R5-C: crash-recovery for governed engagement. The continuation sweep
// re-drives approved marketing_action continuations and enforces rejected
// blocks; the reconciliation sweep probes ambiguous/crashed executions by
// provider operation identity. Both are fire-and-forget, durable-idempotent,
// and never touch a provider unless the operator-enabled transport exists.
void runEngagementContinuationSweep({ limit: 50 })
  .then((summary) => {
    console.log(
      `[Engagement] Continuation sweep complete: ${summary.scanned} scanned, ${summary.resumed} resumed, ${summary.blocked} blocked, ${summary.failed} failed.`
    );
  })
  .catch((err) => {
    console.error(
      "[Engagement] Continuation sweep failed:",
      err instanceof Error ? err.message : err
    );
  });

void runEngagementReconciliationSweep({ limit: 50 })
  .then((summary) => {
    console.log(
      `[Engagement] Reconciliation sweep complete: ${summary.scanned} scanned, ${summary.reconciled} reconciled, ${summary.executed} executed, ${summary.failed} failed.`
    );
  })
  .catch((err) => {
    console.error(
      "[Engagement] Reconciliation sweep failed:",
      err instanceof Error ? err.message : err
    );
  });

app.use(bodyLimit({ maxSize: 50 * 1024 * 1024 }));

// OAuth callback endpoint - handles redirects from social platforms
app.get("/api/oauth/callback", handleOAuthCallback);

// Alias for legacy Meta redirect URI configuration
app.get("/api/oauth/meta/callback", handleOAuthCallback);

// Webhook endpoints for inbound social platform messages
// Inbound engagement events are verified, normalized, deduplicated and
// processed exactly once by the engagement ingestion pipeline (inbound only —
// no outbound sending in this phase).
app.post("/api/webhooks/:platform", async (c) => {
  const platform = c.req.param("platform");
  const rawBody = await c.req.text();
  const signature = c.req.header("x-hub-signature-256") || c.req.header("x-twilio-signature") || c.req.header("x-zendesk-webhook-signature") || "";

  console.log(`[Webhook ${platform}] Received payload`, {
    timestamp: new Date().toISOString(),
    signaturePresent: !!signature,
    bodyBytes: rawBody.length,
  });

  // Creatify video generation webhook
  if (platform === "creatify") {
    const payload = (() => {
      try {
        return JSON.parse(rawBody);
      } catch {
        return null;
      }
    })();
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

  // Inbound engagement ingestion (facebook / instagram / whatsapp).
  const outcome = await processInboundWebhook({ platform, rawBody, signature });

  // WBS-R5-A canonical listening evidence layer (additive): same verified
  // Meta delivery also becomes canonical social signals. The engagement
  // pipeline above is unchanged; listening has its own exact-once dedup.
  let listening: unknown = null;
  if (["facebook", "instagram", "whatsapp", "linkedin"].includes(platform)) {
    try {
      listening = await processListeningWebhook({
        platform,
        rawBody,
        signature,
        appSecret: env.metaAppSecret || process.env.FACEBOOK_APP_SECRET || "",
      });
    } catch (err: any) {
      console.error(`[Webhook ${platform}] listening ingestion error:`, err?.message);
    }
  }

  return c.json(
    {
      received: outcome.received,
      platform,
      results: outcome.dispositions,
      listening,
      error: outcome.error,
    },
    outcome.httpStatus as 200 | 401
  );
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
