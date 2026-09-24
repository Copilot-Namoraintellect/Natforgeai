import { Job, UnrecoverableError } from "bullmq";
import { createPublishingWorker, type PublishingJobData } from "./bullmq";
import { publishSinglePost } from "../workflow/publishing-runner";
import { isRedisConfigured } from "../redis";
import { createAlert } from "../alerts";
import { loadQueuePublishPackagePlan } from "../publish/publish-package-queue-persistence";

export async function processPublishingJob(job: Job<PublishingJobData>): Promise<void> {
  const { queueItemId, userId, platform } = job.data;
  console.log(`[Publishing Worker] Processing job ${job.id} for ${platform} (queueItem: ${queueItemId})`);

  // WBS13.4: the job stays identity-only; the exact immutable publish package
  // is reloaded from the durable queue row. Governed rows execute the
  // persisted package (retry-safe, never rebuilt from mutable rows); legacy
  // rows keep the established no-package call; a governed row with a missing
  // or tampered package fails closed before any provider execution.
  const plan = await loadQueuePublishPackagePlan(queueItemId);

  if (plan.kind === "fail_closed") {
    throw new UnrecoverableError(plan.reason);
  }

  const result =
    plan.kind === "governed"
      ? await publishSinglePost(queueItemId, { publishPackage: plan.publishPackage })
      : await publishSinglePost(queueItemId);

  // Permanent readiness failures (missing/stale output, approval pending,
  // failed/cancelled/generating output) are not transient and must not be retried.
  if (result.status === "precondition_failed") {
    throw new UnrecoverableError(result.error || `Publishing blocked: ${result.status}`);
  }

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
