import {
  connectRedis,
  isRedisConfigured,
} from "../redis";

export interface RedisCommandClient {
  sendCommand(
    args: string[]
  ): Promise<unknown>;
}

export interface PostLiveLifecycleLeaseStore {
  acquire(input: {
    key: string;
    ownerToken: string;
    ttlMs: number;
  }): Promise<boolean>;

  renew(input: {
    key: string;
    ownerToken: string;
    ttlMs: number;
  }): Promise<boolean>;

  release(input: {
    key: string;
    ownerToken: string;
  }): Promise<boolean>;
}

const RENEW_SCRIPT = [
  'if redis.call("GET", KEYS[1]) == ARGV[1] then',
  '  return redis.call("PEXPIRE", KEYS[1], ARGV[2])',
  'else',
  '  return 0',
  'end',
].join("\n");

const RELEASE_SCRIPT = [
  'if redis.call("GET", KEYS[1]) == ARGV[1] then',
  '  return redis.call("DEL", KEYS[1])',
  'else',
  '  return 0',
  'end',
].join("\n");

function assertKey(value: string): void {
  if (!value.trim()) {
    throw new Error(
      "Lease key must not be empty"
    );
  }
}

function assertOwnerToken(value: string): void {
  if (!value.trim()) {
    throw new Error(
      "Lease ownerToken must not be empty"
    );
  }
}

function assertTtlMs(value: number): void {
  if (
    !Number.isInteger(value) ||
    value <= 0
  ) {
    throw new Error(
      "Lease ttlMs must be a positive integer"
    );
  }
}

function redisIntegerReplyIsOne(
  value: unknown
): boolean {
  if (value === 1 || value === 1n) {
    return true;
  }

  return String(value) === "1";
}

/**
 * Command-level Redis lease adapter.
 *
 * Ownership contract:
 * - acquire succeeds only when no current owner exists;
 * - renew succeeds only for the current owner token;
 * - release succeeds only for the current owner token.
 *
 * Renew/release use compare-and-act Lua scripts so an expired owner can never
 * extend or delete a lease acquired by another process.
 */
export function createRedisCommandPostLiveLifecycleLeaseStore(
  redis: RedisCommandClient
): PostLiveLifecycleLeaseStore {
  return {
    async acquire({
      key,
      ownerToken,
      ttlMs,
    }) {
      assertKey(key);
      assertOwnerToken(ownerToken);
      assertTtlMs(ttlMs);

      const result =
        await redis.sendCommand([
          "SET",
          key,
          ownerToken,
          "PX",
          String(ttlMs),
          "NX",
        ]);

      return result === "OK";
    },

    async renew({
      key,
      ownerToken,
      ttlMs,
    }) {
      assertKey(key);
      assertOwnerToken(ownerToken);
      assertTtlMs(ttlMs);

      const result =
        await redis.sendCommand([
          "EVAL",
          RENEW_SCRIPT,
          "1",
          key,
          ownerToken,
          String(ttlMs),
        ]);

      return redisIntegerReplyIsOne(
        result
      );
    },

    async release({
      key,
      ownerToken,
    }) {
      assertKey(key);
      assertOwnerToken(ownerToken);

      const result =
        await redis.sendCommand([
          "EVAL",
          RELEASE_SCRIPT,
          "1",
          key,
          ownerToken,
        ]);

      return redisIntegerReplyIsOne(
        result
      );
    },
  };
}

/**
 * Production Redis-backed lease store.
 *
 * Creating the store does not acquire a lease. Redis is mutated only when
 * acquire/renew/release is explicitly invoked by a future runtime owner.
 */
export async function createRedisPostLiveLifecycleLeaseStore():
Promise<PostLiveLifecycleLeaseStore> {
  if (!isRedisConfigured()) {
    throw new Error(
      "Redis is required for post-live lifecycle distributed leasing"
    );
  }

  const redis = await connectRedis();

  return createRedisCommandPostLiveLifecycleLeaseStore(
    redis
  );
}