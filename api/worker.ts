/**
 * Standalone worker entry point for production.
 * Run with: node dist/worker.js
 */
import { connectRedis, isRedisConfigured } from "./lib/redis";
import { startPublishingWorker, stopPublishingWorker } from "./lib/queue/publishing-worker";
import { env } from "./lib/env";

async function main() {
  if (!isRedisConfigured()) {
    console.error("[Worker] Redis is required for workers. Set REDIS_URL.");
    process.exit(1);
  }

  await connectRedis();
  console.log("[Worker] Redis connected");

  startPublishingWorker();

  // Graceful shutdown
  process.on("SIGINT", async () => {
    console.log("[Worker] Shutting down...");
    await stopPublishingWorker();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    console.log("[Worker] Shutting down...");
    await stopPublishingWorker();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("[Worker] Fatal error:", err);
  process.exit(1);
});
