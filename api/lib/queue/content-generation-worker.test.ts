import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../jobs/content-generation-job", () => ({
  processContentGenerationJob: vi.fn(async () => undefined),
}));

vi.mock("../redis", () => ({
  isRedisConfigured: vi.fn(),
}));

vi.mock("../env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../env")>();
  return { ...actual, env: { ...actual.env, redisUrl: "redis://test:6379" } };
});

vi.mock("bullmq", () => {
  class FakeQueue {
    static instances: FakeQueue[] = [];
    name: string;
    opts: any;
    close = vi.fn(async () => {});
    constructor(name: string, opts: any) {
      this.name = name;
      this.opts = opts;
      FakeQueue.instances.push(this);
    }
  }
  class FakeWorker {
    static instances: FakeWorker[] = [];
    name: string;
    processor: any;
    opts: any;
    handlers: Record<string, ((...args: any[]) => void)[]> = {};
    close = vi.fn(async () => {});
    constructor(name: string, processor: any, opts: any) {
      this.name = name;
      this.processor = processor;
      this.opts = opts;
      FakeWorker.instances.push(this);
    }
    on(event: string, handler: (...args: any[]) => void) {
      (this.handlers[event] ??= []).push(handler);
    }
  }
  return { Queue: FakeQueue, Worker: FakeWorker, Job: class {} };
});

vi.mock("ioredis", () => ({
  Redis: class FakeRedis {
    static instances: FakeRedis[] = [];
    url: string;
    opts: any;
    quit = vi.fn(async () => {});
    constructor(url: string, opts: any) {
      this.url = url;
      this.opts = opts;
      FakeRedis.instances.push(this);
    }
  },
}));

import { Worker, type Queue } from "bullmq";
import { isRedisConfigured } from "../redis";
import * as bullmq from "./bullmq";
import {
  processQueuedContentGenerationJob,
  startContentGenerationWorker,
  stopContentGenerationWorker,
} from "./content-generation-worker";

function workerInstances() {
  return (Worker as unknown as { instances: { processor: any }[] }).instances;
}

describe("content generation worker", () => {
  let publishingQueue: Queue;
  let publishingWorker: Worker;
  let contentGenerationQueue: Queue;
  let contentGenerationWorker: Worker;
  let redis: { quit: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    vi.clearAllMocks();
    // Reset any module-level refs left over from a previous test.
    await bullmq.closePublishingQueue();
    await bullmq.closeContentGenerationQueue();
    await bullmq.closeBullMqConnection();
    // Seed one fake instance of every shared BullMQ resource.
    publishingQueue = bullmq.getPublishingQueue();
    publishingWorker = bullmq.createPublishingWorker(async () => {});
    contentGenerationQueue = bullmq.getContentGenerationQueue();
    contentGenerationWorker = bullmq.createContentGenerationWorker(async () => {});
    redis = (publishingQueue as any).opts.connection;
  });

  it("worker receives queued job data and forwards it to the job processor", async () => {
    const { processContentGenerationJob } = await import("../jobs/content-generation-job");

    const fakeJob = {
      data: {
        jobId: 333,
        userId: 18,
        campaignId: 30,
        regenerate: false,
      },
    } as any;

    await processQueuedContentGenerationJob(fakeJob);

    expect(processContentGenerationJob).toHaveBeenCalledTimes(1);
    expect(processContentGenerationJob).toHaveBeenCalledWith(fakeJob.data);
  });

  it("rejects when processing fails so BullMQ marks the job as failed", async () => {
    const { processContentGenerationJob } = await import("../jobs/content-generation-job");
    vi.mocked(processContentGenerationJob).mockRejectedValueOnce(new Error("processor failure"));

    const fakeJob = {
      data: {
        jobId: 334,
        userId: 18,
        campaignId: 30,
        regenerate: false,
      },
    } as any;

    await expect(processQueuedContentGenerationJob(fakeJob)).rejects.toThrow("processor failure");
  });

  it("does not start a worker when redis is not configured", () => {
    vi.mocked(isRedisConfigured).mockReturnValue(false);
    const instancesBefore = workerInstances().length;

    const worker = startContentGenerationWorker();

    expect(worker).toBeNull();
    expect(workerInstances().length).toBe(instancesBefore);
  });

  it("starts the worker through the shared BullMQ factory when redis is configured", () => {
    vi.mocked(isRedisConfigured).mockReturnValue(true);

    const worker = startContentGenerationWorker();

    const created = workerInstances()[workerInstances().length - 1];
    expect(worker).toBe(created);
    expect(created.processor).toBe(processQueuedContentGenerationJob);
  });

  it("stopContentGenerationWorker closes content-generation resources only", async () => {
    await stopContentGenerationWorker();

    expect(contentGenerationQueue.close).toHaveBeenCalledTimes(1);
    expect(contentGenerationWorker.close).toHaveBeenCalledTimes(1);
    expect(publishingQueue.close).not.toHaveBeenCalled();
    expect(publishingWorker.close).not.toHaveBeenCalled();
    expect(redis.quit).not.toHaveBeenCalled();
  });

  it("closePublishingQueue closes publishing resources only", async () => {
    await bullmq.closePublishingQueue();

    expect(publishingQueue.close).toHaveBeenCalledTimes(1);
    expect(publishingWorker.close).toHaveBeenCalledTimes(1);
    expect(contentGenerationQueue.close).not.toHaveBeenCalled();
    expect(contentGenerationWorker.close).not.toHaveBeenCalled();
    expect(redis.quit).not.toHaveBeenCalled();
  });

  it("repeated stops are safe and clear the module references", async () => {
    await stopContentGenerationWorker();
    await stopContentGenerationWorker();
    expect(contentGenerationQueue.close).toHaveBeenCalledTimes(1);
    expect(contentGenerationWorker.close).toHaveBeenCalledTimes(1);

    await bullmq.closePublishingQueue();
    await bullmq.closePublishingQueue();
    expect(publishingQueue.close).toHaveBeenCalledTimes(1);
    expect(publishingWorker.close).toHaveBeenCalledTimes(1);

    expect(bullmq.getPublishingWorker()).toBeNull();
    expect(bullmq.getContentGenerationWorker()).toBeNull();
  });

  it("closeBullMqConnection quits the shared redis connection idempotently without touching queues or workers", async () => {
    await bullmq.closeBullMqConnection();
    expect(redis.quit).toHaveBeenCalledTimes(1);
    expect(publishingQueue.close).not.toHaveBeenCalled();
    expect(publishingWorker.close).not.toHaveBeenCalled();
    expect(contentGenerationQueue.close).not.toHaveBeenCalled();
    expect(contentGenerationWorker.close).not.toHaveBeenCalled();

    await bullmq.closeBullMqConnection();
    expect(redis.quit).toHaveBeenCalledTimes(1);
  });
});
