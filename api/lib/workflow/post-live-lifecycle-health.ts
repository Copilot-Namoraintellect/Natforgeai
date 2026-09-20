export interface PostLiveLifecycleRuntimeHealthInput {
  enabled: boolean;
  configuredIntervalMs: number;
  runtime: {
    started: boolean;
    intervalMs: number | null;
    passInFlight: boolean;
  };
}

export interface PostLiveLifecycleRuntimeHealth {
  status: "ok" | "error";
  latencyMs: number;
  message: string;
}

/**
 * Classifies scheduler readiness without performing runtime work.
 *
 * Disabled-and-stopped is healthy because post-live scheduling is default-off.
 * Configuration/runtime mismatches are unhealthy and visible to System Health.
 */
export function resolvePostLiveLifecycleSchedulerHealth(
  input: PostLiveLifecycleRuntimeHealthInput
): PostLiveLifecycleRuntimeHealth {
  if (!input.enabled) {
    if (input.runtime.started) {
      return {
        status: "error",
        latencyMs: 0,
        message:
          "Post-live lifecycle scheduler is running while disabled by configuration",
      };
    }

    return {
      status: "ok",
      latencyMs: 0,
      message:
        "Post-live lifecycle scheduler disabled by configuration",
    };
  }

  if (!input.runtime.started) {
    return {
      status: "error",
      latencyMs: 0,
      message:
        "Post-live lifecycle scheduler is enabled but not started",
    };
  }

  if (input.runtime.intervalMs === null) {
    return {
      status: "error",
      latencyMs: 0,
      message:
        "Post-live lifecycle scheduler is running without a runtime interval",
    };
  }

  if (
    input.runtime.intervalMs !==
    input.configuredIntervalMs
  ) {
    return {
      status: "error",
      latencyMs: 0,
      message:
        `Post-live lifecycle scheduler interval mismatch: configured=${input.configuredIntervalMs}ms runtime=${input.runtime.intervalMs}ms`,
    };
  }

  return {
    status: "ok",
    latencyMs: 0,
    message: input.runtime.passInFlight
      ? `Post-live lifecycle scheduler running at ${input.runtime.intervalMs}ms; reconciliation pass in flight`
      : `Post-live lifecycle scheduler running at ${input.runtime.intervalMs}ms; idle`,
  };
}
