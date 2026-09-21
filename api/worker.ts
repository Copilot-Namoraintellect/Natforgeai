/**
 * Standalone worker entry point for production.
 * Run with: node dist/worker.js
 */
import { connectRedis, isRedisConfigured } from "./lib/redis";
import { startPublishingWorker, stopPublishingWorker } from "./lib/queue/publishing-worker";
import { startContentGenerationWorker, stopContentGenerationWorker } from "./lib/queue/content-generation-worker";
import { closeBullMqConnection } from "./lib/queue/bullmq";
import { env } from "./lib/env";

let shutdownPromise: Promise<void> | null = null;

function gracefulShutdown(): Promise<void> {
  if (!shutdownPromise) {
    shutdownPromise = (async () => {
      await stopPublishingWorker();
      await stopContentGenerationWorker();
      await closeBullMqConnection();
    })();
  }
  return shutdownPromise;
}

function handleShutdownSignal(signal: string) {
  console.log(`[Worker] ${signal} received, shutting down...`);
  gracefulShutdown()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[Worker] Shutdown failed:", err);
      process.exit(1);
    });
}

async function main() {
  if (!isRedisConfigured()) {
    console.error("[Worker] Redis is required for workers. Set REDIS_URL.");
    process.exit(1);
  }

  await connectRedis();
  console.log("[Worker] Redis connected");

  startPublishingWorker();
  startContentGenerationWorker();

  // Graceful shutdown
  process.on("SIGINT", () => handleShutdownSignal("SIGINT"));
  process.on("SIGTERM", () => handleShutdownSignal("SIGTERM"));
}

main().catch((err) => {
  console.error("[Worker] Fatal error:", err);
  process.exit(1);
});
