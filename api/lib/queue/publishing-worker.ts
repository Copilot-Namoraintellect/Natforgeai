import { Job } from "bullmq";
import { createPublishingWorker, type PublishingJobData } from "./bullmq";
import { publishSinglePost } from "../workflow/publishing-runner";
import { isRedisConfigured } from "../redis";
import { createAlert } from "../alerts";

export async function processPublishingJob(job: Job<PublishingJobData>): Promise<void> {
  const { queueItemId, userId, platform } = job.data;
  console.log(`[Publishing Worker] Processing job ${job.id} for ${platform} (queueItem: ${queueItemId})`);

  const result = await publishSinglePost(queueItemId);

  if (result.status === "failed" || result.status === "safety_blocked") {
    throw new Error(result.error || `Publishing failed: ${result.status}`);
  }
}

export function startPublishingWorker() {
  if (!isRedisConfigured()) {
    console.log("[Publishing Worker] Redis not configured — worker not started. Use cron runner instead.");
    return null;
  }

  const worker = createPublishingWorker(processPublishingJob);
  console.log("[Publishing Worker] Started");
  return worker;
}

export async function stopPublishingWorker() {
  const { closePublishingQueue } = await import("./bullmq");
  await closePublishingQueue();
  console.log("[Publishing Worker] Stopped");
}
