import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./queries/connection", () => ({
  getDb: vi.fn(),
}));

vi.mock("./lib/redis", () => ({
  isRedisConfigured: vi.fn(() => false),
  getRedisClient: vi.fn(),
}));

vi.mock("./lib/queue/bullmq", () => ({
  getPublishingQueueStats: vi.fn(),
  getPublishingWorker: vi.fn(),
}));

vi.mock("./lib/alerts", () => ({
  createAlert: vi.fn().mockResolvedValue(undefined),
  listAlerts: vi.fn(),
  acknowledgeAlert: vi.fn(),
  resolveAlerts: vi.fn(),
  getAlertSummary: vi.fn(),
}));

vi.mock("./lib/rate-limiter", () => ({
  rateLimitPublic: vi.fn().mockResolvedValue(undefined),
  rateLimitUser: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./lib/env", () => ({
  env: {
    postLiveLifecycleEnabled: false,
    postLiveLifecycleIntervalMs: 300_000,
    postLiveMetricsObservationEnabled: true,
    postLiveMetricsObservationIntervalMs: 300_000,
  },
}));

vi.mock(
  "./lib/workflow/post-live-lifecycle-scheduler",
  () => ({
    getPostLiveLifecycleSchedulerStatus: vi.fn(),
  })
);

vi.mock(
  "./lib/workflow/post-live-metrics-observation-scheduler",
  () => ({
    getPostLiveMetricsObservationSchedulerStatus: vi.fn(),
  })
);

function buildCtx() {
  return {
    req: new Request(
      "http://localhost/api/trpc/health.getSystemHealth"
    ),
    resHeaders: new Headers(),
  } as any;
}

async function arrange(input: {
  enabled: boolean;
  runtime: {
    started: boolean;
    intervalMs: number | null;
    passInFlight: boolean;
  };
}) {
  const { getDb } =
    await import("./queries/connection");
  const { env } =
    await import("./lib/env");
  const {
    getPostLiveLifecycleSchedulerStatus,
  } = await import(
    "./lib/workflow/post-live-lifecycle-scheduler"
  );
  const {
    getPostLiveMetricsObservationSchedulerStatus,
  } = await import(
    "./lib/workflow/post-live-metrics-observation-scheduler"
  );
  const { healthRouter } =
    await import("./health-router");

  vi.mocked(getDb).mockReturnValue({
    execute: vi.fn().mockResolvedValue([]),
  } as any);

  (env as any).postLiveLifecycleEnabled =
    input.enabled;
  (env as any).postLiveLifecycleIntervalMs =
    300_000;

  vi.mocked(
    getPostLiveLifecycleSchedulerStatus
  ).mockReturnValue(input.runtime);

  vi.mocked(
    getPostLiveMetricsObservationSchedulerStatus
  ).mockReturnValue({
    started: true,
    intervalMs: 300_000,
    lastPassAt: null,
    lastPassStatus: null,
    passInFlight: false,
  });

  return {
    caller: healthRouter.createCaller(
      buildCtx()
    ),
    getPostLiveLifecycleSchedulerStatus,
    getPostLiveMetricsObservationSchedulerStatus,
  };
}

describe("healthRouter post-live lifecycle integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps overall health healthy when the default-off scheduler is disabled and stopped", async () => {
    const {
      caller,
      getPostLiveLifecycleSchedulerStatus,
    } = await arrange({
      enabled: false,
      runtime: {
        started: false,
        intervalMs: null,
        passInFlight: false,
      },
    });

    const result =
      await caller.getSystemHealth();

    expect(
      result.checks.postLiveLifecycle
    ).toEqual({
      status: "ok",
      latencyMs: 0,
      message:
        "Post-live lifecycle scheduler disabled by configuration",
    });
    expect(result.status).toBe("healthy");
    expect(
      getPostLiveLifecycleSchedulerStatus
    ).toHaveBeenCalledTimes(1);
  });

  it("degrades overall health when configuration enables a scheduler that is not started", async () => {
    const { caller } =
      await arrange({
        enabled: true,
        runtime: {
          started: false,
          intervalMs: null,
          passInFlight: false,
        },
      });

    const result =
      await caller.getSystemHealth();

    expect(
      result.checks.postLiveLifecycle
    ).toEqual({
      status: "error",
      latencyMs: 0,
      message:
        "Post-live lifecycle scheduler is enabled but not started",
    });
    expect(result.status).toBe("degraded");
  });

  it("keeps overall health healthy for an enabled scheduler running at the configured cadence", async () => {
    const { caller } =
      await arrange({
        enabled: true,
        runtime: {
          started: true,
          intervalMs: 300_000,
          passInFlight: false,
        },
      });

    const result =
      await caller.getSystemHealth();

    expect(
      result.checks.postLiveLifecycle.status
    ).toBe("ok");
    expect(
      result.checks.postLiveLifecycle.message
    ).toContain("idle");
    expect(result.status).toBe("healthy");
  });

  it("reports the default-on metrics observation scheduler as healthy and running", async () => {
    const {
      caller,
      getPostLiveMetricsObservationSchedulerStatus,
    } = await arrange({
      enabled: false,
      runtime: {
        started: false,
        intervalMs: null,
        passInFlight: false,
      },
    });

    const result = await caller.getSystemHealth();

    expect(
      result.checks.postLiveMetricsObservation
    ).toEqual({
      status: "ok",
      latencyMs: 0,
      message:
        "Post-live metrics observation scheduler running at 300000ms; idle",
    });
    expect(
      getPostLiveMetricsObservationSchedulerStatus
    ).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("healthy");
  });

  it("degrades overall health when the metrics observation scheduler is enabled but not started", async () => {
    const {
      caller,
      getPostLiveMetricsObservationSchedulerStatus,
    } = await arrange({
      enabled: false,
      runtime: {
        started: false,
        intervalMs: null,
        passInFlight: false,
      },
    });

    vi.mocked(
      getPostLiveMetricsObservationSchedulerStatus
    ).mockReturnValue({
      started: false,
      intervalMs: null,
      lastPassAt: null,
      lastPassStatus: null,
      passInFlight: false,
    });

    const result = await caller.getSystemHealth();

    expect(
      result.checks.postLiveMetricsObservation
    ).toEqual({
      status: "error",
      latencyMs: 0,
      message:
        "Post-live metrics observation scheduler is enabled but not started",
    });
    expect(result.status).toBe("degraded");
  });
});
