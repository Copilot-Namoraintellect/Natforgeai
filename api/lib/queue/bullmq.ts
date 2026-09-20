import { Queue, Worker, Job } from "bullmq";
import { Redis } from "ioredis";
import { env } from "../env";
import { createAlert } from "../alerts";
import {
  handleTerminalContentGenerationFailure,
  handleTerminalPublishingFailure,
  runContainedTerminalPersistence,
} from "./terminal-failure";

const PUBLISHING_QUEUE_NAME = "publishing-jobs";
const CONTENT_GENERATION_QUEUE_NAME = "content-generation-jobs";

let redisConnection: Redis | null = null;
let publishingQueue: Queue | null = null;
let publishingWorker: Worker | null = null;
let contentGenerationQueue: Queue | null = null;
let contentGenerationWorker: Worker | null = null;

function getRedisConnection(): Redis {
  if (!redisConnection) {
    redisConnection = new Redis(env.redisUrl || "redis://localhost:6379", {
      maxRetriesPerRequest: null,
    });
  }
  return redisConnection;
}

export function isBullMQAvailable(): boolean {
  return !!env.redisUrl;
}

export function getPublishingQueue(): Queue {
  if (!publishingQueue) {
    if (!isBullMQAvailable()) {
      throw new Error("Redis is required for BullMQ queues");
    }
    publishingQueue = new Queue(PUBLISHING_QUEUE_NAME, {
      connection: getRedisConnection() as any,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: "exponential",
          delay: 60_000,
        },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 100 },
      },
    });
  }
  return publishingQueue;
}

export function getContentGenerationQueue(): Queue {
  if (!contentGenerationQueue) {
    if (!isBullMQAvailable()) {
      throw new Error("Redis is required for BullMQ queues");
    }
    contentGenerationQueue = new Queue(CONTENT_GENERATION_QUEUE_NAME, {
      connection: getRedisConnection() as any,
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: { count: 200 },
        removeOnFail: { count: 200 },
      },
    });
  }
  return contentGenerationQueue;
}

export interface PublishingJobData {
  queueItemId: number;
  userId: number;
  platform: string;
  /** Set only for deliberate controlled replays (WBS9D2): the replay request that owns this job. */
  replayRequestId?: number;
}

export interface ContentGenerationJobData {
  jobId: number;
  campaignId: number;
  userId: number;
  regenerate: boolean;
  claimId?: number;
  ownerToken?: string;
}

export function toSafeBullMqJobId(value: string | number): string {
  const safe = String(value)
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return safe || "job";
}

export function toContentGenerationBullMqJobId(agentRunId: number): string {
  return toSafeBullMqJobId(`content-generation-${agentRunId}`);
}

export function toPublishingBullMqJobId(queueItemId: number): string {
  return toSafeBullMqJobId(`publish-${queueItemId}`);
}

export async function schedulePublishingJob(
  queueItemId: number,
  userId: number,
  platform: string,
  scheduledAt: Date,
  options?: { replayRequestId?: number }
): Promise<Job<PublishingJobData>> {
  const queue = getPublishingQueue();
  return queue.add(
    "publish",
    {
      queueItemId,
      userId,
      platform,
      ...(options?.replayRequestId != null
        ? { replayRequestId: options.replayRequestId }
        : {}),
    },
    {
      jobId: toPublishingBullMqJobId(queueItemId),
      delay: Math.max(0, scheduledAt.getTime() - Date.now()),
    }
  );
}

export async function removePublishingJob(queueItemId: number): Promise<void> {
  const queue = getPublishingQueue();
  await queue.remove(toPublishingBullMqJobId(queueItemId));
}

export interface PublishingJobInspection {
  exists: boolean;
  jobId: string;
  /** BullMQ job state, e.g. failed/waiting/delayed/active/completed; null if unreadable. */
  state: string | null;
  data: PublishingJobData | null;
  timestamp: number | null;
}

/**
 * Narrow inspection seam for controlled terminal replay (WBS9D2). Establishes
 * job existence, identity and state so a replay executor can reconcile an
 * existing deterministic job without touching live work it cannot prove.
 */
export async function inspectPublishingJob(jobId: string): Promise<PublishingJobInspection> {
  const queue = getPublishingQueue();
  const job = await queue.getJob(jobId);
  if (!job) {
    return { exists: false, jobId, state: null, data: null, timestamp: null };
  }
  const state = await job.getState().catch(() => null);
  return {
    exists: true,
    jobId,
    state,
    data: (job.data as PublishingJobData | undefined) ?? null,
    timestamp: job.timestamp ?? null,
  };
}

/** Remove a publishing job by its deterministic id; no-op if it does not exist. */
export async function removePublishingJobById(jobId: string): Promise<boolean> {
  const queue = getPublishingQueue();
  const job = await queue.getJob(jobId);
  if (!job) return false;
  await job.remove();
  return true;
}

export async function scheduleContentGenerationJob(
  data: ContentGenerationJobData
): Promise<Job<ContentGenerationJobData>> {
  const queue = getContentGenerationQueue();
  return queue.add("content-generate", data, {
    jobId: toContentGenerationBullMqJobId(data.jobId),
  });
}

export async function pausePublishingQueue(): Promise<void> {
  const queue = getPublishingQueue();
  await queue.pause();
}

export async function resumePublishingQueue(): Promise<void> {
  const queue = getPublishingQueue();
  await queue.resume();
}

export async function getPublishingQueueStats(): Promise<{
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
}> {
  const queue = getPublishingQueue();
  const [waiting, active, completed, failed, delayed] = await Promise.all([
    queue.getWaitingCount(),
    queue.getActiveCount(),
    queue.getCompletedCount(),
    queue.getFailedCount(),
    queue.getDelayedCount(),
  ]);
  return { waiting, active, completed, failed, delayed };
}

export function createPublishingWorker(
  processor: (job: Job<PublishingJobData>) => Promise<any>
): Worker {
  if (!isBullMQAvailable()) {
    throw new Error("Redis is required for BullMQ workers");
  }

  publishingWorker = new Worker<PublishingJobData>(
    PUBLISHING_QUEUE_NAME,
    processor,
    {
      connection: getRedisConnection() as any,
      concurrency: 5,
    }
  );

  publishingWorker.on("completed", (job) => {
    console.log(`[BullMQ] Job ${job.id} completed`);
  });

  publishingWorker.on("failed", (job, err) => {
    void handlePublishingWorkerFailed(job, err).catch(() => {});
  });

  return publishingWorker;
}

/**
 * Publishing worker `failed` listener body. Existing logging and warning-alert
 * behavior is preserved; terminal (unrecoverable / attempts-exhausted) failures
 * additionally persist one durable queue_terminal_failures row, with
 * persistence failures contained and escalated as a critical alert.
 */
export async function handlePublishingWorkerFailed(
  job: Job<PublishingJobData> | undefined,
  err: Error
): Promise<void> {
  console.error(`[BullMQ] Job ${job?.id} failed:`, err.message);
  await createAlert({
    severity: "warning",
    category: "worker",
    message: `BullMQ publishing job failed: ${err.message}`,
    details: { jobId: job?.id, queueItemId: job?.data.queueItemId, platform: job?.data.platform },
  }).catch(() => {});

  await runContainedTerminalPersistence(
    () => handleTerminalPublishingFailure({ job, error: err, failedAt: new Date() }),
    { queueName: "publishing", bullmqJobId: job?.id }
  );
}

export function createContentGenerationWorker(
  processor: (job: Job<ContentGenerationJobData>) => Promise<any>
): Worker {
  if (!isBullMQAvailable()) {
    throw new Error("Redis is required for BullMQ workers");
  }

  contentGenerationWorker = new Worker<ContentGenerationJobData>(
    CONTENT_GENERATION_QUEUE_NAME,
    processor,
    {
      connection: getRedisConnection() as any,
      concurrency: 2,
    }
  );

  contentGenerationWorker.on("completed", (job) => {
    console.log(`[BullMQ] Content generation job ${job.id} completed`);
  });

  contentGenerationWorker.on("failed", (job, err) => {
    void handleContentGenerationWorkerFailed(job, err).catch(() => {});
  });

  return contentGenerationWorker;
}

/**
 * Content-generation worker `failed` listener body. Existing logging and
 * warning-alert behavior is preserved; terminal failures additionally persist
 * one durable queue_terminal_failures row, with persistence failures contained
 * and escalated as a critical alert.
 */
export async function handleContentGenerationWorkerFailed(
  job: Job<ContentGenerationJobData> | undefined,
  err: Error
): Promise<void> {
  console.error(`[BullMQ] Content generation job ${job?.id} failed:`, err.message);
  await createAlert({
    severity: "warning",
    category: "worker",
    message: `BullMQ content generation job failed: ${err.message}`,
    details: { jobId: job?.id, campaignId: job?.data.campaignId, userId: job?.data.userId },
  }).catch(() => {});

  await runContainedTerminalPersistence(
    () => handleTerminalContentGenerationFailure({ job, error: err, failedAt: new Date() }),
    { queueName: "content_generation", bullmqJobId: job?.id }
  );
}

export function getPublishingWorker(): Worker | null {
  return publishingWorker;
}

export function getContentGenerationWorker(): Worker | null {
  return contentGenerationWorker;
}

export async function closePublishingQueue(): Promise<void> {
  if (publishingQueue) {
    await publishingQueue.close();
    publishingQueue = null;
  }
  if (publishingWorker) {
    await publishingWorker.close();
    publishingWorker = null;
  }
}

export async function closeContentGenerationQueue(): Promise<void> {
  if (contentGenerationQueue) {
    await contentGenerationQueue.close();
    contentGenerationQueue = null;
  }
  if (contentGenerationWorker) {
    await contentGenerationWorker.close();
    contentGenerationWorker = null;
  }
}

export async function closeBullMqConnection(): Promise<void> {
  if (redisConnection) {
    await redisConnection.quit();
    redisConnection = null;
  }
}
