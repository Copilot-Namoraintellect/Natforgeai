/**
 * Post-live metrics observation scheduler health (WBS-R4-D).
 *
 * Classifies scheduler readiness without performing runtime work. Unlike the
 * post-live lifecycle scheduler (deliberately default-off), metrics
 * observation is part of normal platform autonomy and is enabled by default:
 * enabled-and-started is the healthy steady state, and any configuration vs
 * runtime mismatch is unhealthy and visible to System Health.
 */

export interface PostLiveMetricsObservationRuntimeHealthInput {
  enabled: boolean;
  configuredIntervalMs: number;
  runtime: {
    started: boolean;
    intervalMs: number | null;
    passInFlight: boolean;
  };
}

export interface PostLiveMetricsObservationRuntimeHealth {
  status: "ok" | "error";
  latencyMs: number;
  message: string;
}

export function resolvePostLiveMetricsObservationSchedulerHealth(
  input: PostLiveMetricsObservationRuntimeHealthInput
): PostLiveMetricsObservationRuntimeHealth {
  if (!input.enabled) {
    if (input.runtime.started) {
      return {
        status: "error",
        latencyMs: 0,
        message:
          "Post-live metrics observation scheduler is running while disabled by configuration",
      };
    }

    return {
      status: "ok",
      latencyMs: 0,
      message: "Post-live metrics observation scheduler disabled by configuration",
    };
  }

  if (!input.runtime.started) {
    return {
      status: "error",
      latencyMs: 0,
      message: "Post-live metrics observation scheduler is enabled but not started",
    };
  }

  if (input.runtime.intervalMs === null) {
    return {
      status: "error",
      latencyMs: 0,
      message: "Post-live metrics observation scheduler is running without a runtime interval",
    };
  }

  if (input.runtime.intervalMs !== input.configuredIntervalMs) {
    return {
      status: "error",
      latencyMs: 0,
      message:
        `Post-live metrics observation scheduler interval mismatch: configured=${input.configuredIntervalMs}ms runtime=${input.runtime.intervalMs}ms`,
    };
  }

  return {
    status: "ok",
    latencyMs: 0,
    message: input.runtime.passInFlight
      ? `Post-live metrics observation scheduler running at ${input.runtime.intervalMs}ms; observation pass in flight`
      : `Post-live metrics observation scheduler running at ${input.runtime.intervalMs}ms; idle`,
  };
}
