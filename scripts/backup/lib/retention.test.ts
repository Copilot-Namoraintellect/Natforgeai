import { describe, expect, it } from "vitest";
import { prunePlan, DEFAULT_RETENTION, type RetentionCandidate } from "./retention";

function sets(...iso: string[]): RetentionCandidate[] {
  return iso.map((s, i) => ({ id: `set-${i}`, createdAt: new Date(s) }));
}

describe("retention prunePlan", () => {
  it("keeps the newest set per day for the daily window", () => {
    const input = sets(
      "2026-11-14T02:00:00Z", // same day, 02:00 → prune (04:00 is the day's representative)
      "2026-11-14T04:00:00Z", // newest, day 14
      "2026-11-13T02:00:00Z",
      "2026-11-12T02:00:00Z",
      "2026-11-11T02:00:00Z", // fourth distinct day, outside daily=3
    );
    const plan = prunePlan(input, { daily: 3, weekly: 0, monthly: 0 });
    expect(plan.keep).toEqual(["set-1", "set-2", "set-3"]);
    expect(plan.prune).toEqual(["set-0", "set-4"]);
    expect(plan.reason["set-1"]).toBe("daily");
    expect(plan.reason["set-4"]).toBe("expired");
  });

  it("keeps one set per ISO week beyond the daily window", () => {
    // 2026-11-09 is a Monday; weeks: 11-09..11-15, 11-02..11-08, 10-26..11-01
    const input = sets(
      "2026-11-14T02:00:00Z", // W1
      "2026-11-10T02:00:00Z", // W1, older → prune
      "2026-11-04T02:00:00Z", // W2
      "2026-10-28T02:00:00Z", // W3
    );
    const plan = prunePlan(input, { daily: 1, weekly: 2, monthly: 0 });
    expect(plan.keep).toContain("set-0"); // daily
    expect(plan.keep).toContain("set-2"); // weekly W2
    expect(plan.keep).toContain("set-3"); // weekly W3
    expect(plan.prune).toEqual(["set-1"]);
  });

  it("keeps one set per month beyond weekly, never pruning a kept set twice", () => {
    const input = sets(
      "2026-11-14T02:00:00Z",
      "2026-10-05T02:00:00Z", // same month as set-2 but older → prune
      "2026-10-20T02:00:00Z", // October's representative (weekly claim)
      "2026-09-15T02:00:00Z",
    );
    const plan = prunePlan(input, { daily: 1, weekly: 1, monthly: 2 });
    expect(new Set(plan.keep).size).toBe(plan.keep.length);
    expect(plan.keep).toEqual(["set-0", "set-2", "set-3"]);
    expect(plan.prune).toEqual(["set-1"]);
    expect(plan.reason["set-0"]).toBe("daily");
    expect(plan.reason["set-2"]).toBe("weekly");
    expect(plan.reason["set-3"]).toBe("monthly");
  });

  it("defaults preserve 14+8+12 and every set inside the daily window survives", () => {
    const input = sets(...Array.from({ length: 14 }, (_, i) => `2026-11-${String(14 - i).padStart(2, "0")}T02:00:00Z`));
    const plan = prunePlan(input, DEFAULT_RETENTION);
    expect(plan.prune).toEqual([]);
    expect(plan.keep).toHaveLength(14);
  });

  it("is deterministic for a shuffled input", () => {
    const input = sets("2026-11-14T02:00:00Z", "2026-11-10T02:00:00Z", "2026-10-01T02:00:00Z", "2026-09-01T02:00:00Z");
    const a = prunePlan(input, { daily: 2, weekly: 2, monthly: 2 });
    const b = prunePlan([...input].reverse(), { daily: 2, weekly: 2, monthly: 2 });
    expect(a.keep).toEqual(b.keep);
    expect(a.prune).toEqual(b.prune);
  });
});
