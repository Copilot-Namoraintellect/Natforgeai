// ─── R10-D Provider & Integration Resilience — timeout semantics (D5) ───
//
// PURE module. Wraps an adapter call with the declared timeout model. The
// composition rule: an ambiguous dispatch (timeout, connection reset,
// truncation, never-completed response) is UNCERTAIN — it remains so until
// reconciliation (D8). Timeout != failure; timeout != success.
//
// The wall-clock is injected so acceptance runs deterministically; the
// default production wrapper uses real timers (see withProviderTimeout in
// api/lib/reliability for the central AI-provider analogue).

import type { RawProviderOutcome } from "./provider-result-classification";
import {
  classifyTransportError,
  classifyProviderOutcome,
} from "./provider-result-classification";
import type { ClassifiedProviderResult } from "./provider-result-classification";

export class ProviderCallTimeoutError extends Error {
  readonly code = "PROVIDER_CALL_TIMEOUT" as const;
  readonly phase: "connect" | "read";
  readonly timeoutMs: number;
  constructor(phase: "connect" | "read", timeoutMs: number) {
    super(`provider call ${phase} timeout after ${timeoutMs}ms`);
    this.name = "ProviderCallTimeoutError";
    this.phase = phase;
    this.timeoutMs = timeoutMs;
  }
}

export function isProviderCallTimeoutError(err: unknown): boolean {
  return (
    err instanceof ProviderCallTimeoutError ||
    (!!err &&
      typeof err === "object" &&
      (err as { code?: unknown }).code === "PROVIDER_CALL_TIMEOUT")
  );
}

export interface ProviderTimeoutSpec {
  readonly connectTimeoutMs: number;
  readonly readTimeoutMs: number;
}

export interface Clock {
  nowMs(): number;
}

export const systemClock: Clock = { nowMs: () => Date.now() };

/**
 * Executes `call` under the declared connect/read timeout model. The adapter
 * receives a deadline signal; if the adapter reports a phase timeout via
 * ProviderCallTimeoutError (or throws any transport error), the result is
 * classified conservatively — UNCERTAIN for ambiguous transport outcomes.
 */
export async function executeProviderCallWithTimeout(input: {
  spec: ProviderTimeoutSpec;
  requestId: string;
  call: (deadline: {
    connectTimeoutMs: number;
    readTimeoutMs: number;
  }) => Promise<RawProviderOutcome>;
}): Promise<ClassifiedProviderResult> {
  const { spec, requestId, call } = input;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const raw = await Promise.race([
      Promise.resolve().then(() =>
        call({
          connectTimeoutMs: spec.connectTimeoutMs,
          readTimeoutMs: spec.readTimeoutMs,
        })
      ),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new ProviderCallTimeoutError("read", spec.readTimeoutMs)),
          spec.connectTimeoutMs + spec.readTimeoutMs
        );
      }),
    ]);
    return classifyProviderOutcome(raw, requestId);
  } catch (err) {
    if (isProviderCallTimeoutError(err)) {
      const phase = (err as ProviderCallTimeoutError).phase;
      return classifyTransportError(
        new ProviderCallTimeoutError(
          phase,
          phase === "connect" ? spec.connectTimeoutMs : spec.readTimeoutMs
        ),
        requestId
      );
    }
    return classifyTransportError(err, requestId);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Pure read-deadline check used by polling adapters: a response arriving
 * after the read deadline is ambiguous — the provider may have processed the
 * request. Conservative: UNCERTAIN, reconciliation backlog.
 */
export function evaluateResponseFreshness(input: {
  sentAtMs: number;
  receivedAtMs: number;
  readTimeoutMs: number;
  complete: boolean;
  requestId: string;
}): ClassifiedProviderResult | null {
  const elapsed = input.receivedAtMs - input.sentAtMs;
  if (elapsed > input.readTimeoutMs) {
    return classifyTransportError(
      new ProviderCallTimeoutError("read", input.readTimeoutMs),
      input.requestId
    );
  }
  if (!input.complete) {
    return classifyTransportError(
      new Error("response truncated: connection closed mid-body"),
      input.requestId
    );
  }
  return null;
}
