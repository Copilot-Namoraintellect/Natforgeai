import { Job } from "bullmq";
import { createContentGenerationWorker, type ContentGenerationJobData } from "./bullmq";
import { isRedisConfigured } from "../redis";
import { processContentGenerationJob } from "../jobs/content-generation-job";

export async function processQueuedContentGenerationJob(
  job: Job<ContentGenerationJobData>
): Promise<void> {
  await processContentGenerationJob(job.data);
}

export function startContentGenerationWorker() {
  if (!isRedisConfigured()) {
    console.log("[Content Generation Worker] Redis not configured - worker not started.");
    return null;
  }

  const worker = createContentGenerationWorker(processQueuedContentGenerationJob);
  console.log("[Content Generation Worker] Started");
  return worker;
}
