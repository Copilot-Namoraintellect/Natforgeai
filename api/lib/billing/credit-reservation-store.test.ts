import { describe, it, expect, afterEach, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { getTableName } from "drizzle-orm";
import * as connectionModule from "../../queries/connection";
import {
  buildCreditReservationId,
  buildCreditReservationIdempotencyKey,
  type ReserveCreditsInput,
} from "./credit-reservation";
import {
  getCreditReservation,
  releaseCreditReservation,
  reserveCreditReservation,
  settleCreditReservation,
  type CreditReservationStoreExecutor,
} from "./credit-reservation-store";

// ─── Pure-fake executor tests: no real database is ever touched. ───
// Every test installs a getDb() that throws, so any hidden default-route
// escape fails the test by construction.

interface RecordedOp {
  op: "select" | "insert" | "update" | "execute";
  table?: string;
  detail?: unknown;
  params?: unknown[];
}

function makeExecutorFake(config: {
  selectQueue?: unknown[][];
  failInsertWith?: Error;
  executeAffectedRows?: number;
}) {
  const recorded: RecordedOp[] = [];
  const queue = [...(config.selectQueue ?? [])];

  function chain(rows: unknown[]) {
    const c: Record<string, unknown> = {
      from: () => c,
      where: () => c,
      limit: () => c,
      orderBy: () => c,
      then: (resolve: (value: unknown[]) => unknown) => resolve(rows),
    };
    return c;
  }

  const executor = {
    select: vi.fn(() => {
      const rows = queue.length > 0 ? (queue.shift() as unknown[]) : [];
      recorded.push({ op: "select" });
      return chain(rows);
    }),
    insert: vi.fn((table: unknown) => ({
      values: async (values: Record<string, unknown>) => {
        recorded.push({ op: "insert", table: getTableName(table as never), detail: values });
        if (config.failInsertWith) throw config.failInsertWith;
        return [{ insertId: 500 }];
      },
    })),
    update: vi.fn((_table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: async (_cond: unknown) => {
          recorded.push({ op: "update", detail: patch });
          return [{ affectedRows: 1 }];
        },
      }),
    })),
    execute: vi.fn(async (query: unknown) => {
      const compiled = new MySqlDialect().sqlToQuery(query as never);
      recorded.push({ op: "execute", detail: compiled.sql, params: compiled.params });
      return [{ affectedRows: config.executeAffectedRows ?? 1 }];
    }),
  };

  return {
    executor: executor as unknown as CreditReservationStoreExecutor,
    recorded,
  };
}

function duplicateKeyError(): Error {
  const err = new Error("Duplicate entry for key 'reservationId'") as Error & {
    code: string;
    errno: number;
  };
  err.code = "ER_DUP_ENTRY";
  err.errno = 1062;
  return err;
}

function forbidGetDb() {
  return vi.spyOn(connectionModule, "getDb").mockImplementation(() => {
    throw new Error("getDb must not be called when an executor is supplied");
  });
}

function baseReserve(overrides: Partial<ReserveCreditsInput> = {}): ReserveCreditsInput {
  return {
    userId: 7,
    reservationReference: "creative-success:42:job:888",
    campaignId: 42,
    workflowOperationId: "op-sha-1",
    workflowAttemptId: "attempt-sha-1",
    stageId: "creative_generation",
    amount: 150,
    reason: "hold for creative generation",
    agentType: "creative",
    model: "premium-v2-template",
    provider: "openai",
    artifactId: "artifact-1",
    packageId: "pack-9",
    asOf: "2026-05-29T10:00:00.000Z",
    ...overrides,
  };
}

/** A persisted row matching baseReserve(), overridable per scenario. */
function reservationRow(overrides: Record<string, unknown> = {}) {
  const reserve = baseReserve();
  return {
    id: 55,
    reservationId: buildCreditReservationId(reserve),
    idempotencyKey: buildCreditReservationIdempotencyKey(reserve),
    reservationReference: "creative-success:42:job:888",
    userId: 7,
    campaignId: 42,
    workflowOperationId: "op-sha-1",
    workflowAttemptId: "attempt-sha-1",
    stageId: "creative_generation",
    artifactId: "artifact-1",
    packageId: "pack-9",
    agentType: "creative",
    model: "premium-v2-template",
    provider: "openai",
    reservedAmount: 150,
    settledAmount: null,
    state: "reserved",
    reason: "hold for creative generation",
    settleKey: null,
    releaseKey: null,
    releaseReason: null,
    reservedAt: new Date("2026-05-29T10:00:00.000Z"),
    settledAt: null,
    releasedAt: null,
    createdAt: new Date("2026-05-29T10:00:00.000Z"),
    updatedAt: new Date("2026-05-29T10:00:00.000Z"),
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("durable reserve", () => {
  it("inserts a fully attributed reserved row through the supplied executor", async () => {
    const getDbSpy = forbidGetDb();
    const { executor, recorded } = makeExecutorFake({});

    const result = await reserveCreditReservation({ ...baseReserve(), executor });

    expect(getDbSpy).not.toHaveBeenCalled();
    expect(result.duplicateClassification).toBe("none");
    expect(result.reservation.state).toBe("reserved");
    expect(result.reservation.amount).toBe(150);
    expect(result.reservation.attribution).toEqual({
      userId: 7,
      campaignId: 42,
      workflowOperationId: "op-sha-1",
      workflowAttemptId: "attempt-sha-1",
      stageId: "creative_generation",
      artifactId: "artifact-1",
      packageId: "pack-9",
      agentType: "creative",
      model: "premium-v2-template",
      provider: "openai",
    });

    expect(recorded.map((entry) => entry.op)).toEqual(["insert"]);
    expect(recorded[0].table).toBe("credit_reservations");
    expect(recorded[0].detail).toMatchObject({
      reservationId: buildCreditReservationId(baseReserve()),
      idempotencyKey: buildCreditReservationIdempotencyKey(baseReserve()),
      reservationReference: "creative-success:42:job:888",
      userId: 7,
      campaignId: 42,
      workflowOperationId: "op-sha-1",
      workflowAttemptId: "attempt-sha-1",
      stageId: "creative_generation",
      artifactId: "artifact-1",
      packageId: "pack-9",
      agentType: "creative",
      model: "premium-v2-template",
      provider: "openai",
      reservedAmount: 150,
      settledAmount: null,
      state: "reserved",
      reason: "hold for creative generation",
      settleKey: null,
      releaseKey: null,
      releaseReason: null,
      settledAt: null,
      releasedAt: null,
    });
    expect((recorded[0].detail as { reservedAt: Date }).reservedAt.toISOString()).toBe(
      "2026-05-29T10:00:00.000Z"
    );
  });

  it("race: losing the insert race to the exact same reservation returns it idempotently", async () => {
    forbidGetDb();
    const { executor, recorded } = makeExecutorFake({
      selectQueue: [[reservationRow()]],
      failInsertWith: duplicateKeyError(),
    });

    const result = await reserveCreditReservation({ ...baseReserve(), executor });

    expect(result.duplicateClassification).toBe("idempotent_replay");
    expect(result.reservation.state).toBe("reserved");
    expect(result.reservation.attribution.workflowOperationId).toBe("op-sha-1");
    expect(recorded.map((entry) => entry.op)).toEqual(["insert", "select"]);
  });

  it("conflicting reserve fails closed on amount mismatch", async () => {
    forbidGetDb();
    const { executor } = makeExecutorFake({
      selectQueue: [[reservationRow({ reservedAmount: 200 })]],
      failInsertWith: duplicateKeyError(),
    });

    await expect(
      reserveCreditReservation({ ...baseReserve(), executor })
    ).rejects.toThrow(expect.objectContaining({ code: "RESERVATION_IDENTITY_CONFLICT" }));
  });

  it("conflicting reserve fails closed on attribution mismatch", async () => {
    forbidGetDb();
    const { executor } = makeExecutorFake({
      selectQueue: [[reservationRow({ agentType: "strategy" })]],
      failInsertWith: duplicateKeyError(),
    });

    await expect(
      reserveCreditReservation({ ...baseReserve(), executor })
    ).rejects.toThrow(expect.objectContaining({ code: "RESERVATION_IDENTITY_CONFLICT" }));
  });

  it("race: natural-reference reread finds a different reservation identity for the same user and reference -> fails closed", async () => {
    forbidGetDb();
    const { executor, recorded } = makeExecutorFake({
      // The committed winner claimed (userId 7, reference) under a different
      // reservation identity — exactly the window the old pre-read select
      // could not close.
      selectQueue: [[reservationRow({ reservationId: "different-identity-id" })]],
      failInsertWith: duplicateKeyError(),
    });

    await expect(
      reserveCreditReservation({ ...baseReserve(), executor })
    ).rejects.toThrow(expect.objectContaining({ code: "RESERVATION_IDENTITY_CONFLICT" }));
    expect(recorded.map((entry) => entry.op)).toEqual(["insert", "select"]);
  });

  it("race: natural-reference reread sees no row and the idempotency-key reread finds a different reservation -> fails closed", async () => {
    forbidGetDb();
    const { executor, recorded } = makeExecutorFake({
      selectQueue: [
        [], // natural reference: no committed row
        [reservationRow({ reservationId: "other-reservation-id", idempotencyKey: "charge-key-123" })],
      ],
      failInsertWith: duplicateKeyError(),
    });

    await expect(
      reserveCreditReservation({
        ...baseReserve({ externalIdempotencyKey: "charge-key-123" }),
        executor,
      })
    ).rejects.toThrow(expect.objectContaining({ code: "IDEMPOTENCY_KEY_CONFLICT" }));
    expect(recorded.map((entry) => entry.op)).toEqual(["insert", "select", "select"]);
  });

  it("reserve enforces the positive amount requirement before touching the database", async () => {
    forbidGetDb();
    const { executor, recorded } = makeExecutorFake({});

    await expect(
      reserveCreditReservation({ ...baseReserve({ amount: 0 }), executor })
    ).rejects.toThrow(expect.objectContaining({ code: "INVALID_RESERVATION_AMOUNT" }));
    expect(recorded).toEqual([]);
  });

  it("reserve rejects a blank reason before touching the database", async () => {
    forbidGetDb();
    const { executor, recorded } = makeExecutorFake({});

    await expect(
      reserveCreditReservation({ ...baseReserve({ reason: "  " }), executor })
    ).rejects.toThrow(expect.objectContaining({ code: "INVALID_RESERVATION_REASON" }));
    expect(recorded).toEqual([]);
  });
});

describe("durable settle", () => {
  it("settles a reserved row at the full amount via a guarded update", async () => {
    forbidGetDb();
    const { executor, recorded } = makeExecutorFake({
      selectQueue: [[reservationRow()]],
    });

    const result = await settleCreditReservation({
      reservationId: buildCreditReservationId(baseReserve()),
      settleKey: "settle-key-1",
      executor,
    });

    expect(result.duplicateClassification).toBe("none");
    expect(result.reservation.state).toBe("settled");
    expect(result.reservation.settledAmount).toBe(150);
    expect(recorded.map((entry) => entry.op)).toEqual(["select", "execute"]);
    const updateSql = recorded[1].detail as string;
    expect(updateSql).toContain("UPDATE credit_reservations");
    expect(updateSql).toContain("'settled'");
    expect(updateSql).toContain("state = 'reserved'");
    expect(updateSql).toContain("settleKey IS NULL");
  });

  it("settles a partial amount without exceeding the reservation", async () => {
    forbidGetDb();
    const { executor, recorded } = makeExecutorFake({
      selectQueue: [[reservationRow()]],
    });

    const result = await settleCreditReservation({
      reservationId: buildCreditReservationId(baseReserve()),
      settleKey: "settle-partial",
      settledAmount: 90,
      executor,
    });

    expect(result.reservation.settledAmount).toBe(90);
    expect(result.reservation.amount).toBe(150);
    expect(recorded[1].detail as string).toContain("settledAmount = ?");
    expect(recorded[1].params).toContain(90);
  });

  it("settle replay with the same key returns the existing terminal state without an update", async () => {
    forbidGetDb();
    const { executor, recorded } = makeExecutorFake({
      selectQueue: [[reservationRow({ state: "settled", settledAmount: 150, settleKey: "settle-key-1" })]],
    });

    const result = await settleCreditReservation({
      reservationId: buildCreditReservationId(baseReserve()),
      settleKey: "settle-key-1",
      executor,
    });

    expect(result.duplicateClassification).toBe("idempotent_replay");
    expect(result.reservation.state).toBe("settled");
    expect(result.reservation.settledAmount).toBe(150);
    expect(recorded.map((entry) => entry.op)).toEqual(["select"]);
  });

  it("settle with a different key on a settled row fails closed", async () => {
    forbidGetDb();
    const { executor, recorded } = makeExecutorFake({
      selectQueue: [[reservationRow({ state: "settled", settledAmount: 150, settleKey: "settle-key-1" })]],
    });

    await expect(
      settleCreditReservation({
        reservationId: buildCreditReservationId(baseReserve()),
        settleKey: "settle-key-2",
        executor,
      })
    ).rejects.toThrow(expect.objectContaining({ code: "RESERVATION_TERMINAL_STATE" }));
    expect(recorded.map((entry) => entry.op)).toEqual(["select"]);
  });

  it("settle replay with a mismatched settled amount fails closed", async () => {
    forbidGetDb();
    const { executor } = makeExecutorFake({
      selectQueue: [[reservationRow({ state: "settled", settledAmount: 90, settleKey: "settle-key-1" })]],
    });

    await expect(
      settleCreditReservation({
        reservationId: buildCreditReservationId(baseReserve()),
        settleKey: "settle-key-1",
        settledAmount: 100,
        executor,
      })
    ).rejects.toThrow(expect.objectContaining({ code: "IDEMPOTENCY_KEY_CONFLICT" }));
  });

  it("settle on a released row fails closed (settle/release exclusivity)", async () => {
    forbidGetDb();
    const { executor, recorded } = makeExecutorFake({
      selectQueue: [[reservationRow({ state: "released", releaseKey: "release-key-1" })]],
    });

    await expect(
      settleCreditReservation({
        reservationId: buildCreditReservationId(baseReserve()),
        settleKey: "settle-after-release",
        executor,
      })
    ).rejects.toThrow(expect.objectContaining({ code: "RESERVATION_TERMINAL_STATE" }));
    expect(recorded.map((entry) => entry.op)).toEqual(["select"]);
  });

  it("settle above the reserved amount fails closed before any update", async () => {
    forbidGetDb();
    const { executor, recorded } = makeExecutorFake({
      selectQueue: [[reservationRow()]],
    });

    await expect(
      settleCreditReservation({
        reservationId: buildCreditReservationId(baseReserve()),
        settleKey: "settle-over",
        settledAmount: 151,
        executor,
      })
    ).rejects.toThrow(expect.objectContaining({ code: "INVALID_SETTLEMENT_AMOUNT" }));
    expect(recorded.map((entry) => entry.op)).toEqual(["select"]);
  });

  it("lost settle race rereads the winner and reports an idempotent replay", async () => {
    forbidGetDb();
    const { executor, recorded } = makeExecutorFake({
      selectQueue: [
        [reservationRow()],
        [reservationRow({ state: "settled", settledAmount: 150, settleKey: "settle-key-1" })],
      ],
      executeAffectedRows: 0,
    });

    const result = await settleCreditReservation({
      reservationId: buildCreditReservationId(baseReserve()),
      settleKey: "settle-key-1",
      executor,
    });

    expect(result.duplicateClassification).toBe("idempotent_replay");
    expect(result.reservation.state).toBe("settled");
    expect(recorded.map((entry) => entry.op)).toEqual(["select", "execute", "select"]);
  });

  it("lost settle race under a foreign key fails closed", async () => {
    forbidGetDb();
    const { executor } = makeExecutorFake({
      selectQueue: [
        [reservationRow()],
        [reservationRow({ state: "settled", settledAmount: 150, settleKey: "winner-key" })],
      ],
      executeAffectedRows: 0,
    });

    await expect(
      settleCreditReservation({
        reservationId: buildCreditReservationId(baseReserve()),
        settleKey: "settle-key-1",
        executor,
      })
    ).rejects.toThrow(expect.objectContaining({ code: "RESERVATION_TERMINAL_STATE" }));
  });
});

describe("durable release", () => {
  it("releases a reserved row returning the full held amount via a guarded update", async () => {
    forbidGetDb();
    const { executor, recorded } = makeExecutorFake({
      selectQueue: [[reservationRow()]],
    });

    const result = await releaseCreditReservation({
      reservationId: buildCreditReservationId(baseReserve()),
      releaseKey: "release-key-1",
      reason: "workflow_failed",
      executor,
    });

    expect(result.duplicateClassification).toBe("none");
    expect(result.reservation.state).toBe("released");
    expect(result.reservation.releasedAmount).toBe(150);
    expect(result.reservation.settledAmount).toBeNull();
    expect(recorded.map((entry) => entry.op)).toEqual(["select", "execute"]);
    const updateSql = recorded[1].detail as string;
    expect(updateSql).toContain("UPDATE credit_reservations");
    expect(updateSql).toContain("'released'");
    expect(updateSql).toContain("state = 'reserved'");
    expect(updateSql).toContain("releaseKey IS NULL");
  });

  it("release replay with the same key returns the existing terminal state without an update", async () => {
    forbidGetDb();
    const { executor, recorded } = makeExecutorFake({
      selectQueue: [[reservationRow({ state: "released", releaseKey: "release-key-1", releasedAt: new Date() })]],
    });

    const result = await releaseCreditReservation({
      reservationId: buildCreditReservationId(baseReserve()),
      releaseKey: "release-key-1",
      executor,
    });

    expect(result.duplicateClassification).toBe("idempotent_replay");
    expect(result.reservation.state).toBe("released");
    expect(result.reservation.releasedAmount).toBe(150);
    expect(recorded.map((entry) => entry.op)).toEqual(["select"]);
  });

  it("release with a different key on a released row fails closed", async () => {
    forbidGetDb();
    const { executor, recorded } = makeExecutorFake({
      selectQueue: [[reservationRow({ state: "released", releaseKey: "release-key-1", releasedAt: new Date() })]],
    });

    await expect(
      releaseCreditReservation({
        reservationId: buildCreditReservationId(baseReserve()),
        releaseKey: "release-key-2",
        executor,
      })
    ).rejects.toThrow(expect.objectContaining({ code: "RESERVATION_TERMINAL_STATE" }));
    expect(recorded.map((entry) => entry.op)).toEqual(["select"]);
  });

  it("release on a settled row fails closed (settle/release exclusivity)", async () => {
    forbidGetDb();
    const { executor, recorded } = makeExecutorFake({
      selectQueue: [[reservationRow({ state: "settled", settledAmount: 150, settleKey: "settle-key-1" })]],
    });

    await expect(
      releaseCreditReservation({
        reservationId: buildCreditReservationId(baseReserve()),
        releaseKey: "release-after-settle",
        executor,
      })
    ).rejects.toThrow(expect.objectContaining({ code: "RESERVATION_TERMINAL_STATE" }));
    expect(recorded.map((entry) => entry.op)).toEqual(["select"]);
  });

  it("lost release race under a foreign key fails closed", async () => {
    forbidGetDb();
    const { executor } = makeExecutorFake({
      selectQueue: [
        [reservationRow()],
        [reservationRow({ state: "released", releaseKey: "winner-key", releasedAt: new Date() })],
      ],
      executeAffectedRows: 0,
    });

    await expect(
      releaseCreditReservation({
        reservationId: buildCreditReservationId(baseReserve()),
        releaseKey: "release-key-1",
        executor,
      })
    ).rejects.toThrow(expect.objectContaining({ code: "RESERVATION_TERMINAL_STATE" }));
  });
});

describe("getCreditReservation", () => {
  it("returns the persisted record with full correlation attribution", async () => {
    forbidGetDb();
    const { executor } = makeExecutorFake({
      selectQueue: [[reservationRow({ settledAmount: 90, state: "settled", settleKey: "settle-key-1", settledAt: new Date("2026-05-29T10:05:00.000Z") })]],
    });

    const reservation = await getCreditReservation(
      buildCreditReservationId(baseReserve()),
      executor
    );

    expect(reservation).not.toBeNull();
    expect(reservation?.state).toBe("settled");
    expect(reservation?.amount).toBe(150);
    expect(reservation?.settledAmount).toBe(90);
    expect(reservation?.settledAt).toBe("2026-05-29T10:05:00.000Z");
    expect(reservation?.attribution).toEqual({
      userId: 7,
      campaignId: 42,
      workflowOperationId: "op-sha-1",
      workflowAttemptId: "attempt-sha-1",
      stageId: "creative_generation",
      artifactId: "artifact-1",
      packageId: "pack-9",
      agentType: "creative",
      model: "premium-v2-template",
      provider: "openai",
    });
  });

  it("returns null for an unknown reservation id", async () => {
    forbidGetDb();
    const { executor } = makeExecutorFake({ selectQueue: [[]] });

    await expect(getCreditReservation("missing-id", executor)).resolves.toBeNull();
  });
});

describe("executor seam and wallet safety", () => {
  it("a full reserve -> settle -> get flow never calls getDb and never touches wallets", async () => {
    const getDbSpy = forbidGetDb();
    const { executor, recorded } = makeExecutorFake({
      selectQueue: [
        [reservationRow()], // settle select
        [reservationRow({ state: "settled", settledAmount: 150, settleKey: "settle-key-1", settledAt: new Date() })], // get
      ],
    });

    const reservationId = buildCreditReservationId(baseReserve());
    const reserved = await reserveCreditReservation({ ...baseReserve(), executor });
    expect(reserved.duplicateClassification).toBe("none");

    const settled = await settleCreditReservation({
      reservationId,
      settleKey: "settle-key-1",
      executor,
    });
    expect(settled.reservation.state).toBe("settled");

    const fetched = await getCreditReservation(reservationId, executor);
    expect(fetched?.state).toBe("settled");

    expect(getDbSpy).not.toHaveBeenCalled();
    for (const entry of recorded) {
      if (entry.op === "insert") {
        expect(entry.table).toBe("credit_reservations");
      }
      if (entry.op === "execute") {
        expect(entry.detail as string).not.toMatch(/credit_wallets/);
        expect(entry.detail as string).toContain("credit_reservations");
      }
    }
    expect(recorded.some((entry) => entry.op === "insert" && entry.table === "credit_wallets")).toBe(
      false
    );
  });

  it("a full reserve -> release flow writes only credit_reservations rows", async () => {
    forbidGetDb();
    const { executor, recorded } = makeExecutorFake({
      selectQueue: [
        [reservationRow()], // release select
      ],
    });

    const reservationId = buildCreditReservationId(baseReserve());
    await reserveCreditReservation({ ...baseReserve(), executor });
    const released = await releaseCreditReservation({
      reservationId,
      releaseKey: "release-key-1",
      reason: "workflow_failed",
      executor,
    });

    expect(released.reservation.state).toBe("released");
    expect(released.reservation.releasedAmount).toBe(150);
    const inserts = recorded.filter((entry) => entry.op === "insert");
    expect(inserts).toHaveLength(1);
    expect(inserts[0].table).toBe("credit_reservations");
    expect(recorded.filter((entry) => entry.op === "execute")).toHaveLength(1);
    expect(recorded.find((entry) => entry.op === "execute")?.detail as string).not.toMatch(
      /credit_wallets/
    );
  });
});
