import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../queries/connection", () => ({
  getDb: vi.fn(),
}));

vi.mock("./credit-reservation-engine", () => ({
  releaseWalletCredits: vi.fn(),
}));

import { releaseWalletCredits } from "./credit-reservation-engine";
import {
  buildStaleReservationReleaseKey,
  isStaleReservation,
  reapStaleCreditReservations,
  STALE_RESERVATION_TTL_MS,
} from "./stale-reservation-reaper";

const NOW = new Date("2026-06-29T12:00:00.000Z");
const OLD = new Date(NOW.getTime() - STALE_RESERVATION_TTL_MS - 60_000);
const FRESH = new Date(NOW.getTime() - 60_000);

function createFakeDb(rows: Array<{ reservationId: string; state: string; reservedAt: Date }>) {
  const captured: { whereArg: unknown; limitArg: number | null } = {
    whereArg: null,
    limitArg: null,
  };
  const db = {
    select: () => ({
      from: () => ({
        where: (whereArg: unknown) => {
          captured.whereArg = whereArg;
          return {
            limit: (n: number) => {
              captured.limitArg = n;
              return Promise.resolve(rows);
            },
          };
        },
      }),
    }),
  } as never;
  return { db, captured };
}

describe("isStaleReservation", () => {
  it("classifies only reserved holds past the TTL as stale", () => {
    expect(
      isStaleReservation({ state: "reserved", reservedAt: OLD, now: NOW })
    ).toBe(true);
    expect(
      isStaleReservation({ state: "reserved", reservedAt: FRESH, now: NOW })
    ).toBe(false);
    expect(
      isStaleReservation({ state: "settled", reservedAt: OLD, now: NOW })
    ).toBe(false);
    expect(
      isStaleReservation({ state: "released", reservedAt: OLD, now: NOW })
    ).toBe(false);
  });

  it("honours an explicit ttlMs and rejects unparseable timestamps", () => {
    expect(
      isStaleReservation({ state: "reserved", reservedAt: FRESH, now: NOW, ttlMs: 30_000 })
    ).toBe(true);
    expect(
      isStaleReservation({ state: "reserved", reservedAt: null, now: NOW })
    ).toBe(false);
  });
});

describe("reapStaleCreditReservations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("releases only reserved holds past the TTL through the governed authority", async () => {
    const { db } = createFakeDb([
      { reservationId: "stale-1", state: "reserved", reservedAt: OLD },
      { reservationId: "stale-2", state: "reserved", reservedAt: OLD },
      { reservationId: "fresh", state: "reserved", reservedAt: FRESH },
      { reservationId: "already-settled", state: "settled", reservedAt: OLD },
    ]);
    vi.mocked(releaseWalletCredits).mockResolvedValue({
      reservation: {} as never,
      duplicateClassification: "none",
    });

    const summary = await reapStaleCreditReservations({
      now: NOW,
      executor: db,
    });

    expect(summary).toEqual({ examined: 2, released: 2, failed: 0 });
    expect(releaseWalletCredits).toHaveBeenCalledTimes(2);
    expect(releaseWalletCredits).toHaveBeenCalledWith(
      expect.objectContaining({
        reservationId: "stale-1",
        releaseKey: buildStaleReservationReleaseKey("stale-1"),
        reason: "stale_reservation_reap",
      })
    );
    expect(releaseWalletCredits).toHaveBeenCalledWith(
      expect.objectContaining({
        reservationId: "stale-2",
        releaseKey: buildStaleReservationReleaseKey("stale-2"),
      })
    );
  });

  it("counts a terminal conflict or engine error without retrying blindly", async () => {
    const { db } = createFakeDb([
      { reservationId: "stale-1", state: "reserved", reservedAt: OLD },
      { reservationId: "stale-2", state: "reserved", reservedAt: OLD },
    ]);
    vi.mocked(releaseWalletCredits)
      .mockResolvedValueOnce({
        reservation: {} as never,
        duplicateClassification: "none",
      })
      .mockRejectedValueOnce(new Error("RESERVATION_TERMINAL_STATE"));

    const summary = await reapStaleCreditReservations({ now: NOW, executor: db });

    expect(summary).toEqual({ examined: 2, released: 1, failed: 1 });
  });

  it("treats an idempotent reaper replay as a successful release", async () => {
    const { db } = createFakeDb([
      { reservationId: "stale-1", state: "reserved", reservedAt: OLD },
    ]);
    vi.mocked(releaseWalletCredits).mockResolvedValue({
      reservation: {} as never,
      duplicateClassification: "idempotent_replay",
    });

    const summary = await reapStaleCreditReservations({ now: NOW, executor: db });

    expect(summary).toEqual({ examined: 1, released: 1, failed: 0 });
  });
});
