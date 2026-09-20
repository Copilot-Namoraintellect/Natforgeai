export interface SystemHealthCheckDisplayInput {
  status: string;
  latencyMs: number;
  message?: string;
}

/**
 * Preserves the existing latency display for ordinary healthy checks while
 * surfacing the operational state message for the post-live lifecycle check.
 */
export function formatSystemHealthCheckValue(
  name: string,
  check: SystemHealthCheckDisplayInput
): string {
  if (
    name === "postLiveLifecycle" &&
    check.message
  ) {
    return check.message;
  }

  if (check.status === "ok") {
    return `${check.latencyMs}ms`;
  }

  return check.message ?? "";
}
