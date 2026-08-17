import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createLeafletPollingMachine } from "./useLeafletPolling";

describe("createLeafletPollingMachine", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls onPoll each interval while running and stops at maxAttempts", () => {
    const onPoll = vi.fn();
    const onTimedOut = vi.fn();
    const machine = createLeafletPollingMachine({
      maxAttempts: 4,
      intervalMs: 1000,
      onPoll,
      onTimedOut,
    });

    machine.start();

    // Before the limit, onPoll should fire every interval tick.
    vi.advanceTimersByTime(1000);
    expect(onPoll).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2000);
    expect(onPoll).toHaveBeenCalledTimes(3);

    // The next tick (the 4th) should trigger the timeout, not another poll.
    vi.advanceTimersByTime(1000);
    expect(onPoll).toHaveBeenCalledTimes(3);
    expect(onTimedOut).toHaveBeenCalledTimes(1);
    expect(onTimedOut).toHaveBeenCalledWith(expect.objectContaining({ attempts: 4 }));

    // After timing out, further ticks should do nothing.
    vi.advanceTimersByTime(2000);
    expect(onPoll).toHaveBeenCalledTimes(3);
    expect(onTimedOut).toHaveBeenCalledTimes(1);

    machine.stop();
  });

  it("does not poll before start is called", () => {
    const onPoll = vi.fn();
    const onTimedOut = vi.fn();
    createLeafletPollingMachine({
      maxAttempts: 2,
      intervalMs: 1000,
      onPoll,
      onTimedOut,
    });

    vi.advanceTimersByTime(5000);
    expect(onPoll).not.toHaveBeenCalled();
    expect(onTimedOut).not.toHaveBeenCalled();
  });

  it("stops polling when stop is called", () => {
    const onPoll = vi.fn();
    const onTimedOut = vi.fn();
    const machine = createLeafletPollingMachine({
      maxAttempts: 10,
      intervalMs: 1000,
      onPoll,
      onTimedOut,
    });

    machine.start();
    vi.advanceTimersByTime(2000);
    expect(onPoll).toHaveBeenCalledTimes(2);

    machine.stop();
    vi.advanceTimersByTime(5000);
    expect(onPoll).toHaveBeenCalledTimes(2);
    expect(onTimedOut).not.toHaveBeenCalled();
  });

  it("does not start a second overlapping interval when start is called twice", () => {
    const onPoll = vi.fn();
    const machine = createLeafletPollingMachine({
      maxAttempts: 10,
      intervalMs: 1000,
      onPoll,
      onTimedOut: () => {},
    });

    machine.start();
    machine.start();
    vi.advanceTimersByTime(3000);
    expect(onPoll).toHaveBeenCalledTimes(3);

    machine.stop();
  });

  it("does not reset attempt count or elapsed time when start is called while already running (rerender)", () => {
    const onPoll = vi.fn();
    const onTimedOut = vi.fn();
    const machine = createLeafletPollingMachine({
      maxAttempts: 5,
      intervalMs: 1000,
      onPoll,
      onTimedOut,
    });

    machine.start();
    vi.advanceTimersByTime(2500);
    expect(onPoll).toHaveBeenCalledTimes(2);

    // Simulate a React rerender that calls start() again while the status is still generating.
    machine.start();
    vi.advanceTimersByTime(2500);
    expect(onPoll).toHaveBeenCalledTimes(4);

    // The timeout should still fire at the original maxAttempts boundary, not later.
    vi.advanceTimersByTime(1000);
    expect(onTimedOut).toHaveBeenCalledTimes(1);
    expect(onTimedOut).toHaveBeenCalledWith(expect.objectContaining({ attempts: 5 }));

    machine.stop();
  });

  it("resets attempt count and elapsed time when restarted after a stop (campaign change or unmount)", () => {
    const onPoll = vi.fn();
    const onTimedOut = vi.fn();
    const machine = createLeafletPollingMachine({
      maxAttempts: 4,
      intervalMs: 1000,
      onPoll,
      onTimedOut,
    });

    machine.start();
    vi.advanceTimersByTime(3000);
    expect(onPoll).toHaveBeenCalledTimes(3);

    // Simulate a campaign change or unmount: the hook clears the timer.
    machine.stop();

    // A new campaign starts generating, so the machine is restarted.
    machine.start();
    vi.advanceTimersByTime(3000);
    // The full budget is available again because the counter reset.
    expect(onPoll).toHaveBeenCalledTimes(6);
    expect(onTimedOut).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    expect(onTimedOut).toHaveBeenCalledTimes(1);
    expect(onTimedOut).toHaveBeenCalledWith(expect.objectContaining({ attempts: 4 }));

    machine.stop();
  });

  it("resets attempt counting when restarted after a timeout", () => {
    const onPoll = vi.fn();
    const onTimedOut = vi.fn();
    const machine = createLeafletPollingMachine({
      maxAttempts: 3,
      intervalMs: 1000,
      onPoll,
      onTimedOut,
    });

    machine.start();
    vi.advanceTimersByTime(3000);
    expect(onTimedOut).toHaveBeenCalledTimes(1);
    expect(onTimedOut).toHaveBeenLastCalledWith(expect.objectContaining({ attempts: 3 }));

    machine.stop();
    machine.start();
    vi.advanceTimersByTime(3000);
    expect(onTimedOut).toHaveBeenCalledTimes(2);
    expect(onTimedOut).toHaveBeenLastCalledWith(expect.objectContaining({ attempts: 3 }));

    machine.stop();
  });

  it("reports elapsed time around maxAttempts * intervalMs", () => {
    const onTimedOut = vi.fn();
    const machine = createLeafletPollingMachine({
      maxAttempts: 4,
      intervalMs: 1000,
      onPoll: () => {},
      onTimedOut,
    });

    machine.start();
    vi.advanceTimersByTime(4000);
    expect(onTimedOut).toHaveBeenCalledWith(
      expect.objectContaining({
        attempts: 4,
        elapsedMs: expect.any(Number),
      })
    );
    const reported = onTimedOut.mock.calls[0][0].elapsedMs as number;
    expect(reported).toBeGreaterThanOrEqual(4000);
    expect(reported).toBeLessThan(4100);

    machine.stop();
  });

  it("times out after no more than 24 attempts and approximately 60 seconds", () => {
    const onPoll = vi.fn();
    const onTimedOut = vi.fn();
    const machine = createLeafletPollingMachine({
      maxAttempts: 24,
      intervalMs: 2500,
      onPoll,
      onTimedOut,
    });

    machine.start();
    // Just before the 24th tick the machine should still be polling.
    vi.advanceTimersByTime(57500);
    expect(onPoll).toHaveBeenCalledTimes(23);
    expect(onTimedOut).not.toHaveBeenCalled();

    // The 24th tick should trigger the timeout.
    vi.advanceTimersByTime(2500);
    expect(onPoll).toHaveBeenCalledTimes(23);
    expect(onTimedOut).toHaveBeenCalledTimes(1);
    expect(onTimedOut).toHaveBeenCalledWith(
      expect.objectContaining({
        attempts: 24,
        elapsedMs: expect.any(Number),
      })
    );
    const elapsedMs = onTimedOut.mock.calls[0][0].elapsedMs as number;
    expect(elapsedMs).toBeGreaterThanOrEqual(60000);
    expect(elapsedMs).toBeLessThan(60500);

    machine.stop();
  });

  it("does not poll for terminal states (ready, not_generated, failed, cancelled, timed_out)", () => {
    const onPoll = vi.fn();
    const onTimedOut = vi.fn();
    const machine = createLeafletPollingMachine({
      maxAttempts: 10,
      intervalMs: 1000,
      onPoll,
      onTimedOut,
    });

    // Simulate the hook's decision logic: only start when the resolved status is generating.
    const terminalStates: Array<
      "ready" | "not_generated" | "failed" | "cancelled" | "timed_out"
    > = ["ready", "not_generated", "failed", "cancelled", "timed_out"];

    for (const _status of terminalStates) {
      machine.stop();
      vi.advanceTimersByTime(3000);
    }

    expect(onPoll).not.toHaveBeenCalled();
    expect(onTimedOut).not.toHaveBeenCalled();

    machine.stop();
  });
});
