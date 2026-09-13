import { describe, it, expect, vi } from "vitest";
import {
  createImageRenderClaimHeartbeat,
  IMAGE_RENDER_CLAIM_HEARTBEAT_INTERVAL_MS,
  IMAGE_RENDER_CLAIM_HEARTBEAT_LEASE_SECONDS,
  type ImageRenderClaimHeartbeatHandle,
} from "./image-render-claim-heartbeat";

// ─── Deterministic heartbeat tests ───
//
// A manual timer harness replaces setTimeout/clearTimeout so no fake timers
// or real waiting are needed: captured handlers fire only when a test says
// so. No database, filesystem, provider, or environment mutation.

const OWNER_TOKEN = "owner-secret-heartbeat-token";

function makeTimerHarness() {
  const pending = new Map<number, () => void>();
  let nextHandle = 1;
  const setTimeoutFn = (handler: () => void): number => {
    const handle = nextHandle;
    nextHandle += 1;
    pending.set(handle, handler);
    return handle;
  };
  const clearTimeoutFn = (handle: unknown): void => {
    pending.delete(Number(handle));
  };
  return {
    setTimeoutFn,
    clearTimeoutFn,
    scheduledCount: () => pending.size,
    fireNext(): void {
      const first = pending.entries().next().value as [number, () => void] | undefined;
      if (!first) throw new Error("no scheduled heartbeat");
      pending.delete(first[0]);
      first[1]();
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function makeDeps(overrides: Record<string, unknown> = {}) {
  const timers = makeTimerHarness();
  const renew = vi.fn(
    async (
      _args: { claimId: number; ownerToken: string; leaseSeconds: number }
    ): Promise<{ renewed: boolean }> => ({ renewed: true })
  );
  return {
    timers,
    renew,
    deps: {
      claimId: 777,
      ownerToken: OWNER_TOKEN,
      renew,
      intervalMs: 1_000,
      leaseSeconds: 600,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      ...overrides,
    },
  };
}

describe("createImageRenderClaimHeartbeat", () => {
  it("uses conservative fixed defaults and validates owner identity", () => {
    expect(IMAGE_RENDER_CLAIM_HEARTBEAT_INTERVAL_MS).toBe(120_000);
    expect(IMAGE_RENDER_CLAIM_HEARTBEAT_LEASE_SECONDS).toBe(600);
    expect(() =>
      createImageRenderClaimHeartbeat({ claimId: 0, ownerToken: OWNER_TOKEN })
    ).toThrow(/Invalid claimId/);
    expect(() =>
      createImageRenderClaimHeartbeat({ claimId: 1, ownerToken: "" })
    ).toThrow(/Invalid ownerToken/);
  });

  it("does not renew before the first interval and performs bounded periodic renewals", async () => {
    const { timers, renew, deps } = makeDeps();
    const heartbeat = createImageRenderClaimHeartbeat(deps);
    expect(renew).not.toHaveBeenCalled();
    expect(timers.scheduledCount()).toBe(1);

    timers.fireNext();
    await flushMicrotasks();
    expect(renew).toHaveBeenCalledTimes(1);
    expect(renew).toHaveBeenCalledWith({ claimId: 777, ownerToken: OWNER_TOKEN, leaseSeconds: 600 });
    expect(heartbeat.lostOwnership).toBe(false);
    expect(timers.scheduledCount()).toBe(1);

    timers.fireNext();
    await flushMicrotasks();
    expect(renew).toHaveBeenCalledTimes(2);
    expect(heartbeat.lostOwnership).toBe(false);
  });

  it("a renewed:false result marks ownership loss and stops scheduling", async () => {
    const { timers, renew, deps } = makeDeps();
    renew.mockResolvedValue({ renewed: false });
    const heartbeat = createImageRenderClaimHeartbeat(deps);

    timers.fireNext();
    await flushMicrotasks();

    expect(heartbeat.lostOwnership).toBe(true);
    expect(timers.scheduledCount()).toBe(0);
    // No further heartbeats fire after loss, even if a stale timer fires.
    await expect(heartbeat.assertStillOwned()).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: "CLAIM_SUBSYSTEM_UNAVAILABLE",
    });
  });

  it("a thrown renewal error marks ownership loss without an unhandled rejection", async () => {
    const { timers, renew, deps } = makeDeps();
    renew.mockRejectedValue(new Error("database exploded"));
    const heartbeat = createImageRenderClaimHeartbeat(deps);

    timers.fireNext();
    await flushMicrotasks();

    expect(heartbeat.lostOwnership).toBe(true);
    await expect(heartbeat.assertStillOwned()).rejects.toMatchObject({
      message: "CLAIM_SUBSYSTEM_UNAVAILABLE",
    });
  });

  it("assertStillOwned resolves while ownership is intact", async () => {
    const { deps } = makeDeps();
    const heartbeat = createImageRenderClaimHeartbeat(deps);
    await expect(heartbeat.assertStillOwned()).resolves.toBeUndefined();
    expect(heartbeat.lostOwnership).toBe(false);
  });

  it("stop() prevents later heartbeats and is safe to call repeatedly", async () => {
    const { timers, renew, deps } = makeDeps();
    const heartbeat = createImageRenderClaimHeartbeat(deps);

    await heartbeat.stop();
    expect(timers.scheduledCount()).toBe(0);
    // Nothing left scheduled to fire; a forced fire of nothing would throw,
    // so assert no renewal can happen by re-checking the schedule.
    expect(renew).not.toHaveBeenCalled();

    await heartbeat.stop();
    await heartbeat.stop();
    expect(renew).not.toHaveBeenCalled();
  });

  it("stop() awaits an in-flight renewal before returning", async () => {
    const { timers, renew, deps } = makeDeps();
    const gate = deferred<{ renewed: boolean }>();
    renew.mockReturnValue(gate.promise);
    const heartbeat = createImageRenderClaimHeartbeat(deps);

    timers.fireNext();
    await flushMicrotasks();
    expect(renew).toHaveBeenCalledTimes(1);

    let stopSettled = false;
    const stopPromise = heartbeat.stop().then(() => {
      stopSettled = true;
    });
    await flushMicrotasks();
    expect(stopSettled).toBe(false);

    gate.resolve({ renewed: true });
    await stopPromise;
    expect(stopSettled).toBe(true);
    expect(heartbeat.lostOwnership).toBe(false);
    await heartbeat.stop();
  });

  it("lost ownership during the in-flight renewal awaited by stop() is observed", async () => {
    const { timers, renew, deps } = makeDeps();
    const gate = deferred<{ renewed: boolean }>();
    renew.mockReturnValue(gate.promise);
    const heartbeat = createImageRenderClaimHeartbeat(deps);

    timers.fireNext();
    await flushMicrotasks();
    const stopPromise = heartbeat.stop();
    gate.resolve({ renewed: false });
    await stopPromise;

    expect(heartbeat.lostOwnership).toBe(true);
    await expect(heartbeat.assertStillOwned()).rejects.toMatchObject({
      message: "CLAIM_SUBSYSTEM_UNAVAILABLE",
    });
  });

  it("never exposes the owner token in errors, results, or logs", async () => {
    const { timers, renew, deps } = makeDeps();
    renew.mockRejectedValue(new Error(`ER_ACCESS_DENIED ${OWNER_TOKEN} mysql://u:p@h/db`));
    const heartbeat = createImageRenderClaimHeartbeat(deps);
    timers.fireNext();
    await flushMicrotasks();

    let caught: unknown = null;
    try {
      await heartbeat.assertStillOwned();
    } catch (err) {
      caught = err;
    }
    const serialized = JSON.stringify({ caught, handleKeys: Object.keys(heartbeat) });
    expect(serialized).not.toContain(OWNER_TOKEN);
    expect(serialized).not.toContain("mysql://");
    expect(JSON.stringify(caught)).not.toContain("ER_ACCESS_DENIED");
  });

  it("exposes no recovery, takeover, rearm, or finalization API", () => {
    const { deps } = makeDeps();
    const heartbeat: ImageRenderClaimHeartbeatHandle = createImageRenderClaimHeartbeat(deps);
    expect(Object.keys(heartbeat).sort()).toEqual([
      "assertStillOwned",
      "lostOwnership",
      "stop",
    ]);
  });
});
