import { Queue, Worker, Job } from "bullmq";
import { Redis } from "ioredis";
import { env } from "../env";
import { createAlert } from "../alerts";

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
}

export interface ContentGenerationJobData {
  jobId: number;
  campaignId: number;
  userId: number;
  regenerate: boolean;
}

export async function schedulePublishingJob(
  queueItemId: number,
  userId: number,
  platform: string,
  scheduledAt: Date
): Promise<Job<PublishingJobData>> {
  const queue = getPublishingQueue();
  return queue.add(
    "publish",
    { queueItemId, userId, platform },
    {
      jobId: `publish:${queueItemId}`,
      delay: Math.max(0, scheduledAt.getTime() - Date.now()),
    }
  );
}

export async function removePublishingJob(queueItemId: number): Promise<void> {
  const queue = getPublishingQueue();
  await queue.remove(`publish:${queueItemId}`);
}

export async function scheduleContentGenerationJob(
  data: ContentGenerationJobData
): Promise<Job<ContentGenerationJobData>> {
  const queue = getContentGenerationQueue();
  return queue.add("content-generate", data, {
    jobId: `content-generate:${data.campaignId}`,
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

  publishingWorker.on("failed", async (job, err) => {
    console.error(`[BullMQ] Job ${job?.id} failed:`, err.message);
    await createAlert({
      severity: "warning",
      category: "worker",
      message: `BullMQ publishing job failed: ${err.message}`,
      details: { jobId: job?.id, queueItemId: job?.data.queueItemId, platform: job?.data.platform },
    }).catch(() => {});
  });

  return publishingWorker;
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

  contentGenerationWorker.on("failed", async (job, err) => {
    console.error(`[BullMQ] Content generation job ${job?.id} failed:`, err.message);
    await createAlert({
      severity: "warning",
      category: "worker",
      message: `BullMQ content generation job failed: ${err.message}`,
      details: { jobId: job?.id, campaignId: job?.data.campaignId, userId: job?.data.userId },
    }).catch(() => {});
  });

  return contentGenerationWorker;
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
  if (contentGenerationQueue) {
    await contentGenerationQueue.close();
    contentGenerationQueue = null;
  }
  if (contentGenerationWorker) {
    await contentGenerationWorker.close();
    contentGenerationWorker = null;
  }
  if (redisConnection) {
    await redisConnection.quit();
    redisConnection = null;
  }
}
