import {
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  createRedisCommandPostLiveLifecycleLeaseStore,
  type RedisCommandClient,
} from "./post-live-lifecycle-lease";

function clientWithReply(
  reply: unknown
): RedisCommandClient & {
  sendCommand: ReturnType<typeof vi.fn>;
} {
  return {
    sendCommand:
      vi.fn().mockResolvedValue(reply),
  };
}

describe(
  "createRedisCommandPostLiveLifecycleLeaseStore",
  () => {
    it("acquires atomically using SET PX NX", async () => {
      const redis =
        clientWithReply("OK");

      const store =
        createRedisCommandPostLiveLifecycleLeaseStore(
          redis
        );

      await expect(
        store.acquire({
          key: "natforge:p1:post-live",
          ownerToken: "owner-a",
          ttlMs: 120000,
        })
      ).resolves.toBe(true);

      expect(
        redis.sendCommand
      ).toHaveBeenCalledWith([
        "SET",
        "natforge:p1:post-live",
        "owner-a",
        "PX",
        "120000",
        "NX",
      ]);
    });

    it("reports lease contention when SET NX does not return OK", async () => {
      const redis =
        clientWithReply(null);

      const store =
        createRedisCommandPostLiveLifecycleLeaseStore(
          redis
        );

      await expect(
        store.acquire({
          key: "natforge:p1:post-live",
          ownerToken: "owner-b",
          ttlMs: 120000,
        })
      ).resolves.toBe(false);
    });

    it("renews only through an owner-token compare-and-PEXPIRE script", async () => {
      const redis =
        clientWithReply(1);

      const store =
        createRedisCommandPostLiveLifecycleLeaseStore(
          redis
        );

      await expect(
        store.renew({
          key: "natforge:p1:post-live",
          ownerToken: "owner-a",
          ttlMs: 120000,
        })
      ).resolves.toBe(true);

      const command =
        redis.sendCommand.mock.calls[0][0];

      expect(command[0]).toBe("EVAL");
      expect(command[1]).toContain(
        'redis.call("GET", KEYS[1]) == ARGV[1]'
      );
      expect(command[1]).toContain(
        'redis.call("PEXPIRE", KEYS[1], ARGV[2])'
      );
      expect(command.slice(2)).toEqual([
        "1",
        "natforge:p1:post-live",
        "owner-a",
        "120000",
      ]);
    });

    it("fails renewal when the caller no longer owns the lease", async () => {
      const redis =
        clientWithReply(0);

      const store =
        createRedisCommandPostLiveLifecycleLeaseStore(
          redis
        );

      await expect(
        store.renew({
          key: "natforge:p1:post-live",
          ownerToken: "expired-owner",
          ttlMs: 120000,
        })
      ).resolves.toBe(false);
    });

    it("releases only through an owner-token compare-and-delete script", async () => {
      const redis =
        clientWithReply(1);

      const store =
        createRedisCommandPostLiveLifecycleLeaseStore(
          redis
        );

      await expect(
        store.release({
          key: "natforge:p1:post-live",
          ownerToken: "owner-a",
        })
      ).resolves.toBe(true);

      const command =
        redis.sendCommand.mock.calls[0][0];

      expect(command[0]).toBe("EVAL");
      expect(command[1]).toContain(
        'redis.call("GET", KEYS[1]) == ARGV[1]'
      );
      expect(command[1]).toContain(
        'redis.call("DEL", KEYS[1])'
      );
      expect(command.slice(2)).toEqual([
        "1",
        "natforge:p1:post-live",
        "owner-a",
      ]);
    });

    it("cannot release another owner's lease", async () => {
      const redis =
        clientWithReply(0);

      const store =
        createRedisCommandPostLiveLifecycleLeaseStore(
          redis
        );

      await expect(
        store.release({
          key: "natforge:p1:post-live",
          ownerToken: "stale-owner",
        })
      ).resolves.toBe(false);
    });

    it("rejects a non-positive lease TTL before Redis is called", async () => {
      const redis =
        clientWithReply("OK");

      const store =
        createRedisCommandPostLiveLifecycleLeaseStore(
          redis
        );

      await expect(
        store.acquire({
          key: "natforge:p1:post-live",
          ownerToken: "owner-a",
          ttlMs: 0,
        })
      ).rejects.toThrow(
        "Lease ttlMs must be a positive integer"
      );

      expect(
        redis.sendCommand
      ).not.toHaveBeenCalled();
    });

    it("rejects an empty owner token before Redis is called", async () => {
      const redis =
        clientWithReply("OK");

      const store =
        createRedisCommandPostLiveLifecycleLeaseStore(
          redis
        );

      await expect(
        store.acquire({
          key: "natforge:p1:post-live",
          ownerToken: "",
          ttlMs: 120000,
        })
      ).rejects.toThrow(
        "Lease ownerToken must not be empty"
      );

      expect(
        redis.sendCommand
      ).not.toHaveBeenCalled();
    });
  }
);