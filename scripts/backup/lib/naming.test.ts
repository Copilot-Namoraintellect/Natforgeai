import { describe, expect, it } from "vitest";
import { setId, setIdToDate, isValidSetId, runId } from "./naming";

describe("naming", () => {
  it("produces lexicographically sortable UTC set ids", () => {
    const a = setId(new Date("2026-11-01T02:00:00Z"));
    const b = setId(new Date("2026-11-02T02:00:00Z"));
    expect(a).toBe("set-20261101T020000Z");
    expect(b).toBe("set-20261102T020000Z");
    expect(a < b).toBe(true);
    expect(isValidSetId(a)).toBe(true);
    expect(isValidSetId("set-2026-11-01")).toBe(false);
    expect(isValidSetId("set-20261101T020000")).toBe(false);
  });

  it("round-trips a set id to the same instant", () => {
    const d = new Date("2026-11-14T02:00:01Z");
    expect(setIdToDate(setId(d))?.toISOString()).toBe(d.toISOString());
    expect(setIdToDate("bogus")).toBeNull();
  });

  it("run ids share the same timestamp shape", () => {
    expect(runId(new Date("2026-11-14T02:00:00Z"))).toBe("bkp-20261114T020000Z");
  });
});
