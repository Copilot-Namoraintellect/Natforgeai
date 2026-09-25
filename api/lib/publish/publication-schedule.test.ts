import { describe, it, expect } from "vitest";
import { TRPCError } from "@trpc/server";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

import {
  assertPublicationScheduleMatchesPackageIntent,
  assertPublicationScheduleMatchesQueueRow,
  assertPublicationScheduleNotInPast,
  canonicalPublicationScheduleKey,
  publicationScheduleEquals,
  publicationScheduleFromQueueRow,
  publicationScheduleInstantEquals,
  resolvePublicationSchedule,
  toPublishPackageIntent,
  type ResolvedPublicationSchedule,
} from "./publication-schedule";

const NOW = new Date("2026-06-01T00:00:00.000Z");

function resolve(input: unknown, now: Date = NOW): ResolvedPublicationSchedule {
  return resolvePublicationSchedule(input, { now });
}

function expectFail(fn: () => unknown, messageRe: RegExp): void {
  expect(fn).toThrowError(TRPCError);
  expect(fn).toThrowError(messageRe);
}

describe("immediate mode", () => {
  it("canonicalizes an explicit immediate request with no timestamp ambiguity", () => {
    const schedule = resolve({ mode: "immediate" });
    expect(schedule).toEqual({
      schemaVersion: 1,
      mode: "immediate",
      requestedVia: "immediate",
      scheduledAtUtcIso: null,
      scheduledAtUtcMillis: null,
      requestedLocalDateTime: null,
      requestedTimezone: null,
      resolvedOffsetUtc: null,
      dstAmbiguity: "none",
    });
    expect(Object.isFrozen(schedule)).toBe(true);
  });

  it("rejects immediate requests that carry a scheduled timestamp", () => {
    expectFail(
      () =>
        resolve({ mode: "immediate", scheduledAtUtc: "2026-06-01T10:00:00Z" }),
      /immediate mode must not carry a scheduled timestamp/
    );
    expectFail(
      () =>
        resolve({
          mode: "immediate",
          localDateTime: "2026-06-01T10:00:00",
          timeZone: "UTC",
        }),
      /immediate mode must not carry a scheduled timestamp/
    );
  });

  it("projects to a PublishPackageIntent with a null timestamp", () => {
    const intent = toPublishPackageIntent(resolve({ mode: "immediate" }));
    expect(intent).toEqual({ mode: "immediate", scheduledAtIso: null });
  });
});

describe("malformed schedule input", () => {
  it("rejects non-object and array input", () => {
    expectFail(() => resolve(null), /malformed schedule input/);
    expectFail(() => resolve("scheduled"), /malformed schedule input/);
    expectFail(
      () => resolve([{ mode: "immediate" }]),
      /malformed schedule input/
    );
  });

  it("rejects a missing or invalid mode", () => {
    expectFail(() => resolve({}), /mode must be "immediate" or "scheduled"/);
    expectFail(
      () => resolve({ mode: "whenever" }),
      /mode must be "immediate" or "scheduled"/
    );
  });

  it("rejects scheduled requests with both local and instant forms", () => {
    expectFail(
      () =>
        resolve({
          mode: "scheduled",
          localDateTime: "2026-06-01T10:00:00",
          timeZone: "UTC",
          scheduledAtUtc: "2026-06-01T10:00:00Z",
        }),
      /either localDateTime or scheduledAtUtc, not both/
    );
  });

  it("rejects scheduled requests with neither local nor instant form", () => {
    expectFail(
      () => resolve({ mode: "scheduled" }),
      /requires localDateTime \+ timeZone, or an explicit scheduledAtUtc/
    );
  });

  it("rejects a malformed localDateTime string", () => {
    expectFail(
      () =>
        resolve({
          mode: "scheduled",
          localDateTime: "2026-06-01 10:00",
          timeZone: "UTC",
        }),
      /malformed localDateTime/
    );
    expectFail(
      () =>
        resolve({
          mode: "scheduled",
          localDateTime: "2026-06-01T10:00:00+04:00",
          timeZone: "UTC",
        }),
      /malformed localDateTime/
    );
  });

  it("rejects local timestamps that are not real calendar dates", () => {
    expectFail(
      () =>
        resolve({
          mode: "scheduled",
          localDateTime: "2026-02-30T10:00:00",
          timeZone: "UTC",
        }),
      /not a real calendar date/
    );
    expectFail(
      () =>
        resolve({
          mode: "scheduled",
          localDateTime: "2026-06-01T25:00:00",
          timeZone: "UTC",
        }),
      /out-of-range time component/
    );
  });
});

describe("scheduled mode — timezone validation", () => {
  it("accepts a valid timezone and canonicalizes the request", () => {
    const schedule = resolve({
      mode: "scheduled",
      localDateTime: "2026-06-01T09:30:00",
      timeZone: "America/New_York",
    });
    expect(schedule.mode).toBe("scheduled");
    expect(schedule.requestedLocalDateTime).toBe("2026-06-01T09:30:00");
    expect(schedule.requestedTimezone).toBe("America/New_York");
    // June: New York observes EDT (UTC-4).
    expect(schedule.scheduledAtUtcIso).toBe("2026-06-01T13:30:00.000Z");
    expect(schedule.resolvedOffsetUtc).toBe("-04:00");
    expect(schedule.dstAmbiguity).toBe("none");
  });

  it("accepts UTC as a declared timezone", () => {
    const schedule = resolve({
      mode: "scheduled",
      localDateTime: "2026-06-01T09:30:00",
      timeZone: "UTC",
    });
    expect(schedule.requestedTimezone).toBe("UTC");
    expect(schedule.scheduledAtUtcIso).toBe("2026-06-01T09:30:00.000Z");
    expect(schedule.resolvedOffsetUtc).toBe("+00:00");
  });

  it("fails closed for an invalid timezone", () => {
    expectFail(
      () =>
        resolve({
          mode: "scheduled",
          localDateTime: "2026-06-01T09:30:00",
          timeZone: "Mars/Olympus_Mons",
        }),
      /invalid timezone/
    );
    expectFail(
      () =>
        resolve({
          mode: "scheduled",
          localDateTime: "2026-06-01T09:30:00",
          timeZone: 42,
        }),
      /declared timezone is required/
    );
  });

  it("fails closed when a required timezone is missing", () => {
    expectFail(
      () =>
        resolve({
          mode: "scheduled",
          localDateTime: "2026-06-01T09:30:00",
        }),
      /declared timezone is required/
    );
    expectFail(
      () =>
        resolve({
          mode: "scheduled",
          localDateTime: "2026-06-01T09:30:00",
          timeZone: "   ",
        }),
      /declared timezone is required/
    );
  });
});

describe("scheduled mode — UTC resolution and DST safety", () => {
  it("resolves the same local time to different UTC instants across timezones", () => {
    const newYork = resolve({
      mode: "scheduled",
      localDateTime: "2026-06-01T09:30:00",
      timeZone: "America/New_York",
    });
    const berlin = resolve({
      mode: "scheduled",
      localDateTime: "2026-06-01T09:30:00",
      timeZone: "Europe/Berlin",
    });
    expect(newYork.scheduledAtUtcIso).toBe("2026-06-01T13:30:00.000Z");
    expect(berlin.scheduledAtUtcIso).toBe("2026-06-01T07:30:00.000Z");
    expect(newYork.scheduledAtUtcMillis).not.toBe(berlin.scheduledAtUtcMillis);
  });

  it("tracks the offset across DST boundaries in the same timezone", () => {
    const januaryClock = new Date("2026-01-01T00:00:00.000Z");
    const summer = resolve(
      {
        mode: "scheduled",
        localDateTime: "2026-06-15T09:00:00",
        timeZone: "Europe/Berlin",
      },
      januaryClock
    );
    const winter = resolve(
      {
        mode: "scheduled",
        localDateTime: "2026-01-15T09:00:00",
        timeZone: "Europe/Berlin",
      },
      januaryClock
    );
    expect(summer.scheduledAtUtcIso).toBe("2026-06-15T07:00:00.000Z");
    expect(summer.resolvedOffsetUtc).toBe("+02:00");
    expect(winter.scheduledAtUtcIso).toBe("2026-01-15T08:00:00.000Z");
    expect(winter.resolvedOffsetUtc).toBe("+01:00");
  });

  it("rejects a nonexistent local timestamp inside a DST gap", () => {
    // 2026-03-08: US spring-forward; 02:30 does not exist in New York.
    expectFail(
      () =>
        resolve({
          mode: "scheduled",
          localDateTime: "2026-03-08T02:30:00",
          timeZone: "America/New_York",
        }),
      /does not exist in timezone.*DST gap/
    );
  });

  it("resolves a fold-ambiguous wall time deterministically to the earlier instant", () => {
    // 2026-11-01: US fall-back; 01:30 occurs twice in New York
    // (05:30Z EDT and 06:30Z EST). The authority picks the earlier one.
    const schedule = resolve({
      mode: "scheduled",
      localDateTime: "2026-11-01T01:30:00",
      timeZone: "America/New_York",
    });
    expect(schedule.scheduledAtUtcIso).toBe("2026-11-01T05:30:00.000Z");
    expect(schedule.dstAmbiguity).toBe("fold-resolved-to-earlier-instant");
    expect(schedule.resolvedOffsetUtc).toBe("-04:00");
  });
});

describe("scheduled mode — explicit instant form", () => {
  it("canonicalizes an explicit offset instant to Z-form", () => {
    const schedule = resolve({
      mode: "scheduled",
      scheduledAtUtc: "2026-06-01T15:30:00+02:00",
    });
    expect(schedule.scheduledAtUtcIso).toBe("2026-06-01T13:30:00.000Z");
    expect(schedule.requestedVia).toBe("instant");
    expect(schedule.requestedTimezone).toBeNull();
    expect(schedule.requestedLocalDateTime).toBeNull();
  });

  it("accepts Z-form and truncates sub-second precision deterministically", () => {
    const schedule = resolve({
      mode: "scheduled",
      scheduledAtUtc: "2026-06-01T13:30:00.250Z",
    });
    expect(schedule.scheduledAtUtcIso).toBe("2026-06-01T13:30:00.000Z");
  });

  it("rejects instant-form input without an explicit offset designator", () => {
    expectFail(
      () =>
        resolve({
          mode: "scheduled",
          scheduledAtUtc: "2026-06-01T13:30:00",
        }),
      /explicit Z or ±hh:mm offset/
    );
  });
});

describe("not-before publication policy", () => {
  it("rejects a scheduled instant strictly in the past", () => {
    expectFail(
      () =>
        resolve({
          mode: "scheduled",
          scheduledAtUtc: "2026-05-31T23:00:00Z",
        }),
      /in the past per the not-before publication policy/
    );
    expectFail(
      () =>
        resolve({
          mode: "scheduled",
          localDateTime: "2026-05-31T23:00:00",
          timeZone: "UTC",
        }),
      /in the past per the not-before publication policy/
    );
  });

  it("accepts an instant exactly at the reference clock (boundary due)", () => {
    const schedule = resolve({
      mode: "scheduled",
      scheduledAtUtc: "2026-06-01T00:00:00Z",
    });
    expect(schedule.scheduledAtUtcIso).toBe("2026-06-01T00:00:00.000Z");
  });

  it("supports the standalone replay policy gate", () => {
    const past = resolve({
      mode: "scheduled",
      scheduledAtUtc: "2026-06-01T00:00:00Z",
    });
    expect(() =>
      assertPublicationScheduleNotInPast(past, new Date("2026-06-01T00:00:01Z"))
    ).toThrowError(/in the past per the not-before publication policy/);
    expect(() =>
      assertPublicationScheduleNotInPast(past, new Date("2026-06-01T00:00:00Z"))
    ).not.toThrow();
    const immediate = resolve({ mode: "immediate" });
    expect(() =>
      assertPublicationScheduleNotInPast(
        immediate,
        new Date("2999-01-01T00:00:00Z")
      )
    ).not.toThrow();
  });
});

describe("replay determinism", () => {
  it("resolves the same input to the identical canonical record on every replay", () => {
    const input = {
      mode: "scheduled",
      localDateTime: "2026-06-01T09:30:00",
      timeZone: "America/New_York",
    } as const;
    const first = resolve(input);
    const second = resolve(input);
    const third = resolvePublicationSchedule(input, { now: new Date(NOW) });
    expect(publicationScheduleEquals(first, second)).toBe(true);
    expect(publicationScheduleEquals(first, third)).toBe(true);
    expect(canonicalPublicationScheduleKey(first)).toBe(
      canonicalPublicationScheduleKey(second)
    );
    expect(Object.isFrozen(first)).toBe(true);
  });

  it("instant-level equality ignores provenance the durable records do not carry", () => {
    const fromLocal = resolve({
      mode: "scheduled",
      localDateTime: "2026-06-01T09:30:00",
      timeZone: "America/New_York",
    });
    const fromInstant = resolve({
      mode: "scheduled",
      scheduledAtUtc: "2026-06-01T13:30:00Z",
    });
    expect(publicationScheduleEquals(fromLocal, fromInstant)).toBe(false);
    expect(publicationScheduleInstantEquals(fromLocal, fromInstant)).toBe(true);
  });
});

describe("machine-local timezone independence", () => {
  it("produces identical results under different server-local timezones", async () => {
    const modulePath = fileURLToPath(
      new URL("./publication-schedule.ts", import.meta.url)
    );
    // The bundle lives inside the repo so the external @trpc/server require
    // resolves against the repo's node_modules from the child process.
    const tempDir = fs.mkdtempSync(path.join(process.cwd(), ".tmp-pubsched-"));
    try {
      const bundlePath = path.join(tempDir, "schedule-bundle.cjs");
      const esbuild = (await import("esbuild"))
        .default as unknown as typeof import("esbuild");
      esbuild.buildSync({
        entryPoints: [modulePath],
        bundle: true,
        platform: "node",
        format: "cjs",
        outfile: bundlePath,
        external: ["@trpc/server"],
        logLevel: "silent",
      });
      const runnerPath = path.join(tempDir, "run.cjs");
      fs.writeFileSync(
        runnerPath,
        [
          "const bundle = process.argv[2];",
          "const { resolvePublicationSchedule } = require(bundle);",
          "const schedule = resolvePublicationSchedule({",
          '  mode: "scheduled",',
          '  localDateTime: "2030-06-01T09:30:00",',
          '  timeZone: "America/New_York",',
          "});",
          "process.stdout.write(JSON.stringify(schedule));",
        ].join("\n")
      );
      const runInTz = (tz: string): string =>
        execFileSync(process.execPath, [runnerPath, bundlePath], {
          env: { ...process.env, TZ: tz },
          encoding: "utf8",
        });
      const eastern = runInTz("America/New_York");
      const sydney = runInTz("Australia/Sydney");
      expect(eastern).toBe(sydney);
      const parsed = JSON.parse(eastern);
      expect(parsed.scheduledAtUtcIso).toBe("2030-06-01T13:30:00.000Z");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("PublishPackage intent binding", () => {
  const scheduled = resolve({
    mode: "scheduled",
    localDateTime: "2026-06-01T09:30:00",
    timeZone: "America/New_York",
  });

  it("projects a scheduled record onto the exact contract intent shape", () => {
    expect(toPublishPackageIntent(scheduled)).toEqual({
      mode: "scheduled",
      scheduledAtIso: "2026-06-01T13:30:00.000Z",
    });
  });

  it("accepts an exact package intent match", () => {
    expect(() =>
      assertPublicationScheduleMatchesPackageIntent(scheduled, {
        mode: "scheduled",
        scheduledAtIso: "2026-06-01T13:30:00.000Z",
      })
    ).not.toThrow();
  });

  it("accepts a package intent carrying an equivalent explicit offset", () => {
    expect(() =>
      assertPublicationScheduleMatchesPackageIntent(scheduled, {
        mode: "scheduled",
        scheduledAtIso: "2026-06-01T15:30:00+02:00",
      })
    ).not.toThrow();
  });

  it("fails on a mode mismatch in either direction", () => {
    expectFail(
      () =>
        assertPublicationScheduleMatchesPackageIntent(scheduled, {
          mode: "immediate",
          scheduledAtIso: null,
        }),
      /does not match package intent mode/
    );
    const immediate = resolve({ mode: "immediate" });
    expectFail(
      () =>
        assertPublicationScheduleMatchesPackageIntent(immediate, {
          mode: "scheduled",
          scheduledAtIso: "2026-06-01T13:30:00.000Z",
        }),
      /does not match package intent mode/
    );
  });

  it("fails on a scheduled timestamp mismatch", () => {
    expectFail(
      () =>
        assertPublicationScheduleMatchesPackageIntent(scheduled, {
          mode: "scheduled",
          scheduledAtIso: "2026-06-01T14:30:00.000Z",
        }),
      /does not match package intent scheduledAtIso/
    );
  });

  it("fails on a scheduled intent missing its timestamp", () => {
    expectFail(
      () =>
        assertPublicationScheduleMatchesPackageIntent(scheduled, {
          mode: "scheduled",
          scheduledAtIso: null,
        }),
      /missing scheduledAtIso/
    );
  });

  it("fails on an immediate intent that carries a timestamp", () => {
    const immediate = resolve({ mode: "immediate" });
    expectFail(
      () =>
        assertPublicationScheduleMatchesPackageIntent(immediate, {
          mode: "immediate",
          scheduledAtIso: "2026-06-01T13:30:00.000Z",
        }),
      /must not carry a scheduledAtIso/
    );
  });

  it("fails closed on offset-less or malformed intent timestamps", () => {
    expectFail(
      () =>
        assertPublicationScheduleMatchesPackageIntent(scheduled, {
          mode: "scheduled",
          scheduledAtIso: "2026-06-01T13:30:00",
        }),
      /explicit Z or ±hh:mm offset/
    );
    expectFail(
      () =>
        assertPublicationScheduleMatchesPackageIntent(scheduled, {
          mode: "scheduled",
          scheduledAtIso: "not-a-time",
        }),
      /explicit Z or ±hh:mm offset/
    );
    expectFail(
      () =>
        assertPublicationScheduleMatchesPackageIntent(scheduled, {
          when: "soon",
        }),
      /invalid mode/
    );
    expectFail(
      () =>
        assertPublicationScheduleMatchesPackageIntent(scheduled, "scheduled"),
      /malformed publish package intent/
    );
  });
});

describe("publishing_queue binding", () => {
  const scheduled = resolve({
    mode: "scheduled",
    scheduledAtUtc: "2026-06-01T13:30:00Z",
  });

  it("reconstructs an immediate schedule from a null scheduledAt", () => {
    const fromRow = publicationScheduleFromQueueRow({ scheduledAt: null });
    expect(fromRow.mode).toBe("immediate");
    expect(
      publicationScheduleInstantEquals(fromRow, resolve({ mode: "immediate" }))
    ).toBe(true);
  });

  it("proves queue schedule == resolved schedule for a matching row", () => {
    expect(() =>
      assertPublicationScheduleMatchesQueueRow(scheduled, {
        scheduledAt: new Date("2026-06-01T13:30:00Z"),
      })
    ).not.toThrow();
  });

  it("canonicalizes a queue Date to whole seconds before comparing", () => {
    expect(() =>
      assertPublicationScheduleMatchesQueueRow(scheduled, {
        scheduledAt: new Date("2026-06-01T13:30:00.500Z"),
      })
    ).not.toThrow();
  });

  it("fails when the queue instant differs", () => {
    expectFail(
      () =>
        assertPublicationScheduleMatchesQueueRow(scheduled, {
          scheduledAt: new Date("2026-06-01T14:30:00Z"),
        }),
      /does not match publishing_queue scheduledAt/
    );
  });

  it("fails when the queue row mode differs", () => {
    expectFail(
      () =>
        assertPublicationScheduleMatchesQueueRow(
          resolve({ mode: "immediate" }),
          {
            scheduledAt: new Date("2026-06-01T13:30:00Z"),
          }
        ),
      /does not match publishing_queue scheduledAt/
    );
  });

  it("fails closed on a malformed queue row or invalid Date", () => {
    expectFail(
      () =>
        assertPublicationScheduleMatchesQueueRow(scheduled, {
          scheduledAt: new Date("not-a-date"),
        }),
      /not a valid Date/
    );
  });
});
