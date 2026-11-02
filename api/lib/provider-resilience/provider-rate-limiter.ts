// ─── R10-D Provider & Integration Resilience — rate limiting (D9) ───
//
// PURE module. Deterministic token-bucket rate limiting over three closed
// scopes: provider-wide, provider+account, and provider+account+action.
// Models provider rate limits, account rate limits, action rate limits and
// provider retry-after hints. A rate limit is VISIBLE (classification
// RATE_LIMITED + retryAfterMs); it never triggers uncontrolled retries —
// retry authorization remains governed (R9-F) and bounded (D10).

import type { Clock } from "./provider-timeout";
import { systemClock } from "./provider-timeout";

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly remaining: number;
  /** Epoch ms after which the caller may retry within this stream's limits. */
  readonly retryAfterMs: number;
  readonly scope: "provider" | "account" | "action";
  readonly limit: number;
}

export interface TokenBucketState {
  readonly tokens: number;
  readonly updatedAtMs: number;
}

export interface ProviderRateLimiter {
  /** Consume one token per relevant scope; allowed only if every scope permits. */
  check(scopes: readonly RateScope[], nowMs?: number): RateLimitDecision;
  /** Provider-declared retry-after visibility (does not grant a retry). */
  noteProviderRetryAfter(
    scopeKey: string,
    retryAfterMs: number,
    nowMs?: number
  ): void;
  /** Read-only view of the tightest active limit for a scope (D14 signal). */
  currentLimitState(
    scopeKey: string,
    nowMs?: number
  ): { limited: boolean; retryAfterMs: number } | null;
}

export interface RateScope {
  readonly scope: "provider" | "account" | "action";
  readonly key: string;
  readonly capacity: number;
  readonly refillPerSecond: number;
}

export function deriveRateScopeKeys(input: {
  tenantUserId: number;
  providerId: string;
  providerAccountId: string;
  actionType: string;
}): readonly RateScope[] {
  return [
    {
      scope: "provider",
      key: `prl:${input.tenantUserId}:${input.providerId}`,
      capacity: 0,
      refillPerSecond: 0,
    },
    {
      scope: "account",
      key: `prl:${input.tenantUserId}:${input.providerId}:${input.providerAccountId}`,
      capacity: 0,
      refillPerSecond: 0,
    },
    {
      scope: "action",
      key: `prl:${input.tenantUserId}:${input.providerId}:${input.providerAccountId}:${input.actionType}`,
      capacity: 0,
      refillPerSecond: 0,
    },
  ];
}

/**
 * In-memory deterministic token bucket. Buckets are filled lazily from the
 * injected clock; the bucket map is externally inspectable so the acceptance
 * suite can assert visibility without a database. A durable rate-limit event
 * log belongs to the store; this module is the decision engine only.
 */
export function createProviderRateLimiter(
  options: { clock?: Clock } = {}
): ProviderRateLimiter {
  const clock = options.clock ?? systemClock;
  const buckets = new Map<string, TokenBucketState>();
  const providerRetryAfter = new Map<string, number>();

  function bucketFor(scope: RateScope, now = clock.nowMs()): TokenBucketState {
    const existing = buckets.get(scope.key);
    if (!existing) {
      const state: TokenBucketState = {
        tokens: scope.capacity,
        updatedAtMs: now,
      };
      buckets.set(scope.key, state);
      return state;
    }
    const elapsedSec = Math.max(0, (now - existing.updatedAtMs) / 1000);
    const refill = Math.floor(elapsedSec * scope.refillPerSecond);
    if (refill > 0) {
      const tokens = Math.min(scope.capacity, existing.tokens + refill);
      const state: TokenBucketState = {
        tokens,
        updatedAtMs:
          existing.updatedAtMs + (refill / scope.refillPerSecond) * 1000,
      };
      buckets.set(scope.key, state);
      return state;
    }
    return existing;
  }

  function evaluate(scope: RateScope, now: number): RateLimitDecision {
    const state = bucketFor(scope, now);
    const cooldown = Math.max(
      0,
      (providerRetryAfter.get(scope.key) ?? 0) - now
    );
    if (state.tokens >= 1 && cooldown === 0) {
      return {
        allowed: true,
        remaining: state.tokens - 1,
        retryAfterMs: 0,
        scope: scope.scope,
        limit: scope.capacity,
      };
    }
    const deficit = 1 - state.tokens;
    const waitMs =
      scope.refillPerSecond > 0
        ? Math.ceil((deficit / scope.refillPerSecond) * 1000)
        : Number.MAX_SAFE_INTEGER;
    const retryAfterMs = Math.max(state.tokens >= 1 ? 0 : waitMs, cooldown);
    return {
      allowed: false,
      remaining: 0,
      retryAfterMs,
      scope: scope.scope,
      limit: scope.capacity,
    };
  }

  return {
    check(scopes, nowMs) {
      // Evaluate every scope first; consume only when ALL scopes allow, so a
      // denial never burns tokens from other scopes.
      if (!scopes.length) throw new Error("rate scopes required");
      const now = nowMs ?? clock.nowMs();
      const decisions = scopes.map(scope => evaluate(scope, now));
      const denying = decisions.filter(d => !d.allowed);
      if (denying.length > 0) {
        return denying.reduce((tightest, d) =>
          d.retryAfterMs > tightest.retryAfterMs ? d : tightest
        );
      }
      for (const scope of scopes) {
        const state = bucketFor(scope, now);
        buckets.set(scope.key, { tokens: state.tokens - 1, updatedAtMs: now });
      }
      return decisions[decisions.length - 1];
    },
    noteProviderRetryAfter(scopeKey, retryAfterMs, nowMs) {
      const now = nowMs ?? clock.nowMs();
      providerRetryAfter.set(scopeKey, now + retryAfterMs);
    },
    currentLimitState(scopeKey, nowMs) {
      const now = nowMs ?? clock.nowMs();
      const retryAt = providerRetryAfter.get(scopeKey);
      if (retryAt && retryAt > now)
        return { limited: true, retryAfterMs: retryAt - now };
      const state = buckets.get(scopeKey);
      if (state && state.tokens < 1) return { limited: true, retryAfterMs: 0 };
      return null;
    },
  };
}
