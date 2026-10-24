import { describe, it, expect, vi } from "vitest";
import { runListeningPollingPass } from "./polling";
import {
  startListeningPollingScheduler,
  stopListeningPollingScheduler,
  getListeningPollingSchedulerStatus,
} from "./polling-scheduler";
import { createListeningFakeDb } from "./testing/fake-listening-db";
import type { RawSocialSignalEvent } from "./adapters/types";

function pollEvent(overrides: Partial<RawSocialSignalEvent> = {}): RawSocialSignalEvent {
  return {
    providerAccountId: "page-1",
    externalEventId: "poll-1",
    externalObjectId: null,
    parentExternalObjectId: null,
    signalType: "mention",
    occurredAt: new Date("2026-07-05T09:00:00.000Z"),
    actorReference: "user-3",
    actorDisplayName: null,
    contentReference: null,
    contentText: "mentioned you",
    evidence: { kind: "mention", id: "poll-1" },
    ...overrides,
  };
}

function seedDb() {
  return createListeningFakeDb({
    integrations: [
      {
        id: 11,
        userId: 7,
        businessId: 3,
        platform: "facebook",
        pageId: "page-1",
        instagramBusinessAccountId: null,
        status: "connected",
        accessTokenEncrypted: "enc-token",
      },
      {
        id: 12,
        userId: 7,
        businessId: 3,
        platform: "whatsapp",
        pageId: "wa-1",
        instagramBusinessAccountId: null,
        status: "connected",
        accessTokenEncrypted: "enc-token",
      },
    ],
  });
}

describe("runListeningPollingPass", () => {
  it("fetches one bounded page, ingests events, advances durable checkpoint", async () => {
    const db = seedDb();
    const fetcher = vi.fn().mockResolvedValue({
      events: [pollEvent(), pollEvent({ externalEventId: "poll-2", signalType: "reaction", evidence: { id: "poll-2" } })],
      nextCursor: "cursor-2",
    });

    const summary = await runListeningPollingPass({
      state: db,
      attribution: db,
      store: db,
      fetcherOverrides: { meta: fetcher },
    });

    expect(summary.bindingsScanned).toBe(1); // whatsapp is not a polling candidate
    // whatsapp has no polling capability → never polled.
    expect(summary.bindingsPolled).toBe(1);
    expect(summary.accepted).toBe(2);
    expect(db.signals.size).toBe(2);
    expect(db.states.get(11).cursor).toBe("cursor-2");
    expect(db.states.get(11).lastSuccessAt).toBeInstanceOf(Date);
    expect(fetcher).toHaveBeenCalledWith(
      expect.objectContaining({ providerAccountId: "page-1", cursor: null, limit: 25 })
    );
  });

  it("restart-safe: second pass resumes from the durable checkpoint (no full-history rescan)", async () => {
    const db = seedDb();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({ events: [pollEvent()], nextCursor: "cursor-2" })
      .mockResolvedValue({ events: [], nextCursor: null });

    await runListeningPollingPass({ state: db, attribution: db, store: db, fetcherOverrides: { meta: fetcher } });
    expect(db.states.get(11).cursor).toBe("cursor-2");

    await runListeningPollingPass({ state: db, attribution: db, store: db, fetcherOverrides: { meta: fetcher } });

    // Second pass starts exactly where the first durable checkpoint ended.
    expect(fetcher.mock.calls[1][0].cursor).toBe("cursor-2");
    // Empty page does not rewind the checkpoint.
    expect(db.states.get(11).cursor).toBe("cursor-2");
  });

  it("polling retry does not duplicate: same event re-fetched collapses", async () => {
    const db = seedDb();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({ events: [pollEvent()], nextCursor: null })
      // Provider returns the same event again (retry window overlap).
      .mockResolvedValueOnce({ events: [pollEvent()], nextCursor: null });

    const first = await runListeningPollingPass({ state: db, attribution: db, store: db, fetcherOverrides: { meta: fetcher } });
    const second = await runListeningPollingPass({ state: db, attribution: db, store: db, fetcherOverrides: { meta: fetcher } });

    expect(first.accepted).toBe(1);
    expect(second.duplicates).toBe(1);
    expect(db.signals.size).toBe(1);
  });

  it("rate-limit classifies AUTO_RECOVER and keeps the binding active", async () => {
    const db = seedDb();
    const fetcher = vi.fn().mockRejectedValue(new Error("429 Too Many Requests"));
    const summary = await runListeningPollingPass({ state: db, attribution: db, store: db, fetcherOverrides: { meta: fetcher } });

    expect(summary.failures).toEqual([
      { integrationId: 11, class: "AUTO_RECOVER", code: "provider_rate_limited" },
    ]);
    expect(db.states.get(11).lastFailureClass).toBe("AUTO_RECOVER");
    expect(db.states.get(11).status).toBe("active");
  });

  it("revoked credentials classify OPERATOR_ACTION and block the binding", async () => {
    const db = seedDb();
    const fetcher = vi.fn().mockRejectedValue(new Error("invalid token: authorization expired"));
    const summary = await runListeningPollingPass({ state: db, attribution: db, store: db, fetcherOverrides: { meta: fetcher } });

    expect(summary.failures[0].class).toBe("OPERATOR_ACTION");
    expect(db.states.get(11).status).toBe("blocked");
    expect(db.states.get(11).lastFailureCode).toBe("provider_auth");
  });

  it("missing provider seam fails closed as OPERATOR_ACTION (never fake success)", async () => {
    const db = seedDb();
    const summary = await runListeningPollingPass({ state: db, attribution: db, store: db });

    expect(summary.failures).toEqual([
      { integrationId: 11, class: "OPERATOR_ACTION", code: "LISTENING_NOT_CONFIGURED" },
    ]);
    expect(db.states.get(11).status).toBe("blocked");
  });

  it("supports linkedin via injected cursor fetcher", async () => {
    const db = createListeningFakeDb({
      integrations: [
        {
          id: 21,
          userId: 7,
          businessId: null,
          platform: "linkedin",
          // Operator-configured binding with a known org id (the real
          // linkedin flow stores no account column — see contract §8).
          pageId: "org-9",
          instagramBusinessAccountId: null,
          status: "connected",
          accessTokenEncrypted: "enc",
        },
      ],
    });
    const fetcher = vi.fn().mockResolvedValue({
      events: [pollEvent({ providerAccountId: "org-9", externalEventId: "ln-1", evidence: { id: "ln-1" } })],
      nextCursor: "ln-cursor",
    });
    const summary = await runListeningPollingPass({
      state: db,
      attribution: db,
      store: db,
      fetcherOverrides: { linkedin: fetcher },
    });
    expect(summary.accepted).toBe(1);
    expect(db.states.get(21).cursor).toBe("ln-cursor");
  });
});

describe("listening polling scheduler", () => {
  it("singleton lifecycle: start → first pass → status → stop", async () => {
    const runPass = vi.fn().mockResolvedValue({
      bindingsScanned: 0, bindingsPolled: 0, eventsFetched: 0,
      accepted: 0, duplicates: 0, rejected: 0, failures: [],
    });
    const intervals: Array<{ cb: () => void; ms: number }> = [];
    const deps = {
      runPass,
      startInterval: (cb: () => void, ms: number) => {
        intervals.push({ cb, ms });
        return {} as ReturnType<typeof setInterval>;
      },
      stopInterval: vi.fn(),
      log: vi.fn(),
      logError: vi.fn(),
    };

    const first = startListeningPollingScheduler({ intervalMs: 1000, deps });
    expect(first.status).toBe("started");
    await vi.waitFor(() => expect(runPass).toHaveBeenCalledTimes(1)); // first pass immediate
    await vi.waitFor(() =>
      expect(getListeningPollingSchedulerStatus().passInFlight).toBe(false)
    );
    expect(getListeningPollingSchedulerStatus().started).toBe(true);

    const again = startListeningPollingScheduler({ intervalMs: 5000, deps });
    expect(again.status).toBe("already_started");

    intervals[0].cb(); // scheduled tick
    await vi.waitFor(() => expect(runPass.mock.calls.length).toBeGreaterThanOrEqual(2));

    stopListeningPollingScheduler();
    expect(getListeningPollingSchedulerStatus().started).toBe(false);
    expect(deps.stopInterval).toHaveBeenCalled();
  });

  it("rejects invalid intervals", () => {
    expect(() => startListeningPollingScheduler({ intervalMs: 0 })).toThrow();
    stopListeningPollingScheduler();
  });
});
