import { describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { buildBusinessDNASnapshot, type BusinessDNASnapshot } from "./business-dna";
import {
  BusinessDnaSnapshotConflictError,
  getBusinessDnaSnapshotById,
  getBusinessDnaSnapshotBySnapshotId,
  getLatestBusinessDnaSnapshotForBusiness,
  persistBusinessDnaSnapshot,
  type BusinessDnaStoreDbExecutor,
} from "./business-dna-store";

// Pure-fake tests: no database required. The connection module is replaced
// with a throwing getDb, so any hidden real-DB escape fails by construction.
vi.mock("../queries/connection", () => ({
  getDb: vi.fn(() => {
    throw new Error("getDb must not be called in business-dna-store tests");
  }),
}));

const CAPTURED_AT_A = "2026-07-01T08:00:00.000Z";
const CAPTURED_AT_B = "2026-08-01T09:30:00.000Z";

const businessA = {
  id: 30,
  name: "NatForge Ops",
  industry: "Financial Operations",
  productOrService: "Payout automation",
  websiteEvidence: {
    productsServices: ["supplier disbursements", "reconciliation dashboard"],
    targetCustomers: ["operations managers"],
    location: "Johannesburg",
  },
  targetCustomer: "operations managers",
};

// Same business identity, materially changed website evidence.
const businessAChanged = {
  ...businessA,
  websiteEvidence: {
    ...businessA.websiteEvidence,
    productsServices: ["supplier disbursements", "collections workflow"],
  },
};

const campaignSignals = {
  goal: "Increase qualified demo demand",
  primaryOutcome: "consideration",
  targetBuyer: "operations managers",
  productOrService: "Supplier disbursements",
  mainPainPoint: "Manual reconciliation",
  keyOutcomes: ["faster settlements"],
};

const validationSignals = {
  businessName: "NatForge Ops",
  industry: "Financial Operations",
  productOrService: "Payout automation",
  targetCustomer: "operations managers",
  mainPainPoint: "Manual reconciliation",
};

function snapshotA(capturedAtIso: string = CAPTURED_AT_A) {
  return buildBusinessDNASnapshot({
    business: businessA,
    campaignSignals,
    validationSignals,
    capturedAtIso,
  });
}

function snapshotB(capturedAtIso: string = CAPTURED_AT_B) {
  return buildBusinessDNASnapshot({
    business: businessAChanged,
    campaignSignals,
    validationSignals,
    capturedAtIso,
  });
}

// ─── Stateful in-memory executor fake ───
// Compiles drizzle where/orderBy fragments via MySqlDialect (the same
// technique as the billing credit-engine fake) and applies them against an
// in-memory row map, so inserts, filters, ordering, and limits are honored.

interface StoredRow {
  id: number;
  snapshotId: string;
  businessId: number;
  userId: number;
  version: number;
  evidenceHashSha256: string;
  businessName: string;
  industry: string;
  primaryOffering: string;
  snapshot: unknown;
  capturedAt: Date;
  createdAt: Date;
}

function compileFragment(fragment: unknown): { sql: string; params: unknown[] } {
  return new MySqlDialect().sqlToQuery(fragment as never);
}

function rowMatches(row: StoredRow, cond: unknown): boolean {
  if (!cond) return true;
  const { sql, params } = compileFragment(cond);
  const clauses = sql.split(/\s+AND\s+/i);
  let paramIndex = 0;
  for (const clause of clauses) {
    const match = /`?([A-Za-z_]\w*)`?\s*=\s*\?/.exec(clause);
    if (!match) return false;
    const expected = params[paramIndex++];
    const record = row as unknown as Record<string, unknown>;
    const actual = record[match[1]];
    if (actual !== expected && String(actual) !== String(expected)) return false;
  }
  return true;
}

function compareRows(a: StoredRow, b: StoredRow, orderBys: unknown[]): number {
  for (const orderBy of orderBys) {
    const { sql } = compileFragment(orderBy);
    const match = /`?([A-Za-z_]\w*)`?\s+(desc|asc)$/i.exec(sql.trim());
    if (!match) continue;
    const direction = match[2].toLowerCase() === "desc" ? -1 : 1;
    const aRecord = a as unknown as Record<string, unknown>;
    const bRecord = b as unknown as Record<string, unknown>;
    const av = aRecord[match[1]];
    const bv = bRecord[match[1]];
    if (av instanceof Date && bv instanceof Date) {
      if (av.getTime() !== bv.getTime()) return av.getTime() < bv.getTime() ? -direction : direction;
    } else if (String(av) !== String(bv)) {
      return String(av) < String(bv) ? -direction : direction;
    }
  }
  return 0;
}

function buildStoredRow(values: Record<string, unknown>, id: number): StoredRow {
  return {
    id,
    snapshotId: values.snapshotId,
    businessId: values.businessId,
    userId: values.userId,
    version: values.version,
    evidenceHashSha256: values.evidenceHashSha256,
    businessName: values.businessName,
    industry: values.industry,
    primaryOffering: values.primaryOffering,
    snapshot: JSON.parse(JSON.stringify(values.snapshot)),
    capturedAt: values.capturedAt,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  } as StoredRow;
}

function makeStoreFake(config: {
  /** First insert attempt fails with this error (e.g. a duplicate-key race). */
  failFirstInsertWith?: Error;
  /**
   * Values committed by the concurrent winner; they become visible to selects
   * only after the failed insert, simulating winner-commit visibility.
   */
  revealWinner?: Record<string, unknown>;
} = {}) {
  const rows = new Map<number, StoredRow>();
  const recorded: { op: "select" | "insert"; detail?: unknown }[] = [];
  let nextId = 1;
  let firstInsertAttempted = false;
  let pendingWinner: Record<string, unknown> | undefined;

  function clone(row: StoredRow): StoredRow {
    return { ...row, snapshot: JSON.parse(JSON.stringify(row.snapshot)) };
  }

  function materializePendingWinner() {
    if (pendingWinner === undefined) return;
    const winner = pendingWinner;
    pendingWinner = undefined;
    const id = nextId++;
    rows.set(id, buildStoredRow(winner, id));
  }

  const executor = {
    select: vi.fn(() => {
      materializePendingWinner();
      recorded.push({ op: "select" });
      let cond: unknown;
      let orderBys: unknown[] = [];
      let limit: number | null = null;
      const chain: Record<string, unknown> = {
        from: () => chain,
        where: (c: unknown) => {
          cond = c;
          return chain;
        },
        orderBy: (...o: unknown[]) => {
          orderBys = o;
          return chain;
        },
        limit: (n: number) => {
          limit = n;
          return chain;
        },
        then: (resolve: (value: unknown) => unknown) => {
          const matched = [...rows.values()].filter((row) => rowMatches(row, cond));
          matched.sort((a, b) => compareRows(a, b, orderBys));
          const limited = limit === null ? matched : matched.slice(0, limit);
          return resolve(limited.map(clone));
        },
      };
      return chain;
    }),
    insert: vi.fn((_table: unknown) => ({
      values: async (values: Record<string, unknown>) => {
        recorded.push({ op: "insert", detail: values });
        if (!firstInsertAttempted && config.failFirstInsertWith) {
          firstInsertAttempted = true;
          pendingWinner = config.revealWinner;
          throw config.failFirstInsertWith;
        }
        const id = nextId++;
        const row = buildStoredRow(values, id);
        rows.set(id, row);
        return [{ insertId: id, affectedRows: 1 }];
      },
    })),
  };

  return {
    executor: executor as unknown as BusinessDnaStoreDbExecutor,
    rows,
    recorded,
  };
}

function duplicateKeyError(): Error {
  const error = new Error(
    "Duplicate entry 'shadow-bdna-30-c90f656040da18ba' for key 'business_dna_snapshots.snapshotId'"
  );
  (error as { code?: string }).code = "ER_DUP_ENTRY";
  (error as { errno?: number }).errno = 1062;
  (error as { sqlState?: string }).sqlState = "23000";
  return error;
}

function winnerRowFromSnapshot(
  snapshot: BusinessDNASnapshot,
  userId: number
): Record<string, unknown> {
  return {
    snapshotId: snapshot.snapshotId,
    businessId: snapshot.businessId,
    userId,
    version: snapshot.version,
    evidenceHashSha256: snapshot.evidenceHashSha256,
    businessName: snapshot.businessName,
    industry: snapshot.industry,
    primaryOffering: snapshot.primaryOffering,
    snapshot,
    capturedAt: new Date(snapshot.capturedAtIso),
  };
}

function insertOps(recorded: { op: string; detail?: unknown }[]) {
  return recorded.filter((op) => op.op === "insert");
}

describe("business-dna-store", () => {
  it("inserts a canonical snapshot and reconstructs it exactly", async () => {
    const { executor, rows, recorded } = makeStoreFake();
    const snapshot = snapshotA();

    const result = await persistBusinessDnaSnapshot(
      { snapshot, userId: 7 },
      executor
    );

    expect(result.status).toBe("inserted");
    expect(result.snapshot).toEqual(snapshot);
    expect(rows.size).toBe(1);
    expect(insertOps(recorded)).toHaveLength(1);

    const inserted = insertOps(recorded)[0].detail as Record<string, unknown>;
    expect(inserted.snapshotId).toBe(snapshot.snapshotId);
    expect(inserted.businessId).toBe(snapshot.businessId);
    expect(inserted.userId).toBe(7);
    expect(inserted.version).toBe(snapshot.version);
    expect(inserted.evidenceHashSha256).toBe(snapshot.evidenceHashSha256);
    expect(inserted.businessName).toBe(snapshot.businessName);
    expect(inserted.industry).toBe(snapshot.industry);
    expect(inserted.primaryOffering).toBe(snapshot.primaryOffering);
    expect(inserted.capturedAt).toBeInstanceOf(Date);
    expect((inserted.capturedAt as Date).getTime()).toBe(
      Date.parse(snapshot.capturedAtIso)
    );

    const bySnapshotId = await getBusinessDnaSnapshotBySnapshotId(
      snapshot.snapshotId,
      executor
    );
    expect(bySnapshotId).toEqual(snapshot);

    const byId = await getBusinessDnaSnapshotById(result.row.id, executor);
    expect(byId).toEqual(snapshot);
  });

  it("replays the same canonical snapshot idempotently", async () => {
    const { executor, rows, recorded } = makeStoreFake();
    const first = await persistBusinessDnaSnapshot(
      { snapshot: snapshotA(), userId: 7 },
      executor
    );
    expect(first.status).toBe("inserted");

    const replay = await persistBusinessDnaSnapshot(
      { snapshot: snapshotA(), userId: 7 },
      executor
    );

    expect(replay.status).toBe("replayed");
    expect(replay.snapshot).toEqual(first.snapshot);
    expect(rows.size).toBe(1);
    expect(insertOps(recorded)).toHaveLength(1);
  });

  it("fails closed when the same snapshotId carries a different payload or hash", async () => {
    const { executor, rows, recorded } = makeStoreFake();
    const snapshot = snapshotA();
    await persistBusinessDnaSnapshot({ snapshot, userId: 7 }, executor);

    const differentHash = {
      ...snapshot,
      evidenceHashSha256: "0".repeat(64),
    };
    await expect(
      persistBusinessDnaSnapshot({ snapshot: differentHash, userId: 7 }, executor)
    ).rejects.toBeInstanceOf(BusinessDnaSnapshotConflictError);
    await expect(
      persistBusinessDnaSnapshot({ snapshot: differentHash, userId: 7 }, executor)
    ).rejects.toMatchObject({
      code: "BUSINESS_DNA_SNAPSHOT_CONFLICT",
      snapshotId: snapshot.snapshotId,
    });

    // Same hash, different governed payload (approvedClaims is outside the
    // evidence hash) must also fail closed.
    const differentPayloadSameHash = {
      ...snapshot,
      approvedClaims: ["injected claim"],
    };
    await expect(
      persistBusinessDnaSnapshot(
        { snapshot: differentPayloadSameHash, userId: 7 },
        executor
      )
    ).rejects.toBeInstanceOf(BusinessDnaSnapshotConflictError);

    // Same identity and hash but a different caller capture time is not a
    // replay of the identical canonical snapshot.
    const differentCapturedAt = snapshotA("2026-07-02T08:00:00.000Z");
    expect(differentCapturedAt.snapshotId).toBe(snapshot.snapshotId);
    await expect(
      persistBusinessDnaSnapshot(
        { snapshot: differentCapturedAt, userId: 7 },
        executor
      )
    ).rejects.toBeInstanceOf(BusinessDnaSnapshotConflictError);

    expect(rows.size).toBe(1);
    expect(insertOps(recorded)).toHaveLength(1);
  });

  it("keeps historical snapshots immutable while the business evidence changes", async () => {
    const { executor } = makeStoreFake();
    const historical = snapshotA();
    await persistBusinessDnaSnapshot({ snapshot: historical, userId: 7 }, executor);

    // The business row mutates; a new projection becomes the latest authority.
    const current = snapshotB();
    expect(current.snapshotId).not.toBe(historical.snapshotId);
    await persistBusinessDnaSnapshot({ snapshot: current, userId: 7 }, executor);

    const rereadHistorical = await getBusinessDnaSnapshotBySnapshotId(
      historical.snapshotId,
      executor
    );
    expect(rereadHistorical).toEqual(historical);
    expect(rereadHistorical?.evidenceHashSha256).toBe(
      historical.evidenceHashSha256
    );

    const latest = await getLatestBusinessDnaSnapshotForBusiness(30, executor);
    expect(latest).toEqual(current);
  });

  it("returns isolated copies so callers cannot mutate stored authority", async () => {
    const { executor } = makeStoreFake();
    const historical = snapshotA();
    await persistBusinessDnaSnapshot({ snapshot: historical, userId: 7 }, executor);

    const mutable = await getBusinessDnaSnapshotBySnapshotId(
      historical.snapshotId,
      executor
    );
    (mutable!.productsAndServices as string[]).push("injected");

    const reread = await getBusinessDnaSnapshotBySnapshotId(
      historical.snapshotId,
      executor
    );
    expect(reread).toEqual(historical);
  });

  it("resolves the latest snapshot by capturedAt with id tiebreak, per business", async () => {
    const { executor } = makeStoreFake();
    const older = snapshotA(CAPTURED_AT_A);
    // Same capturedAt as `older` but a different evidence projection, so it is
    // a distinct durable identity that wins the id tiebreak.
    const tieNewer = buildBusinessDNASnapshot({
      business: {
        ...businessA,
        websiteEvidence: {
          ...businessA.websiteEvidence,
          productsServices: ["supplier disbursements", "expense cards"],
        },
      },
      campaignSignals,
      validationSignals,
      capturedAtIso: CAPTURED_AT_A,
    });
    expect(tieNewer.snapshotId).not.toBe(older.snapshotId);

    await persistBusinessDnaSnapshot({ snapshot: older, userId: 7 }, executor);
    await persistBusinessDnaSnapshot({ snapshot: tieNewer, userId: 7 }, executor);
    expect(await getLatestBusinessDnaSnapshotForBusiness(30, executor)).toEqual(
      tieNewer
    );

    // A later capture becomes the latest authority.
    const newer = snapshotB(CAPTURED_AT_B);
    await persistBusinessDnaSnapshot({ snapshot: newer, userId: 7 }, executor);
    expect(await getLatestBusinessDnaSnapshotForBusiness(30, executor)).toEqual(
      newer
    );

    // Other businesses are excluded by the business filter.
    const otherBusiness = buildBusinessDNASnapshot({
      business: { ...businessA, id: 31 },
      campaignSignals,
      validationSignals,
      capturedAtIso: "2026-12-01T00:00:00.000Z",
    });
    await persistBusinessDnaSnapshot({ snapshot: otherBusiness, userId: 8 }, executor);
    expect(await getLatestBusinessDnaSnapshotForBusiness(30, executor)).toEqual(newer);
    expect(await getLatestBusinessDnaSnapshotForBusiness(31, executor)).toEqual(
      otherBusiness
    );
    expect(
      await getLatestBusinessDnaSnapshotForBusiness(999, executor)
    ).toBeNull();
  });

  it("gives changed evidence a different durable snapshot identity", async () => {
    const { executor } = makeStoreFake();
    const a = snapshotA();
    const b = snapshotB();

    expect(b.snapshotId).not.toBe(a.snapshotId);
    expect(b.evidenceHashSha256).not.toBe(a.evidenceHashSha256);

    await persistBusinessDnaSnapshot({ snapshot: a, userId: 7 }, executor);
    await persistBusinessDnaSnapshot({ snapshot: b, userId: 7 }, executor);

    expect(await getBusinessDnaSnapshotBySnapshotId(a.snapshotId, executor)).toEqual(a);
    expect(await getBusinessDnaSnapshotBySnapshotId(b.snapshotId, executor)).toEqual(b);
  });

  it("never invents capture time; capturedAt comes from the caller ISO authority", async () => {
    const { executor, recorded } = makeStoreFake();
    const snapshot = snapshotA("2024-02-29T23:59:59.000Z");

    await persistBusinessDnaSnapshot({ snapshot, userId: 7 }, executor);

    const inserted = insertOps(recorded)[0].detail as Record<string, unknown>;
    expect((inserted.capturedAt as Date).getTime()).toBe(
      Date.parse("2024-02-29T23:59:59.000Z")
    );

    const reconstructed = await getBusinessDnaSnapshotBySnapshotId(
      snapshot.snapshotId,
      executor
    );
    expect(reconstructed?.capturedAtIso).toBe("2024-02-29T23:59:59.000Z");
  });

  it("fails closed on invalid userId or malformed snapshots before touching the executor", async () => {
    const { executor, recorded } = makeStoreFake();
    const snapshot = snapshotA();

    await expect(
      persistBusinessDnaSnapshot({ snapshot, userId: 0 }, executor)
    ).rejects.toThrow(/userId/);
    await expect(
      persistBusinessDnaSnapshot({ snapshot, userId: Number.NaN }, executor)
    ).rejects.toThrow(/userId/);

    const malformed = { ...snapshot, productsAndServices: "not-an-array" };
    await expect(
      persistBusinessDnaSnapshot(
        { snapshot: malformed as never, userId: 7 },
        executor
      )
    ).rejects.toThrow(/productsAndServices/);

    expect(recorded).toHaveLength(0);
  });

  it("resolves getDb lazily and fails when no executor is supplied in tests", async () => {
    const snapshot = snapshotA();
    await expect(
      persistBusinessDnaSnapshot({ snapshot, userId: 7 })
    ).rejects.toThrow(/getDb/);
    await expect(getBusinessDnaSnapshotById(1)).rejects.toThrow(/getDb/);
    await expect(
      getLatestBusinessDnaSnapshotForBusiness(30)
    ).rejects.toThrow(/getDb/);
  });

  describe("concurrent insert race — unique constraint is the authority", () => {
    it("resolves the losing identical insert as an idempotent replay", async () => {
      const winner = snapshotA();
      const { executor, recorded } = makeStoreFake({
        failFirstInsertWith: duplicateKeyError(),
        revealWinner: winnerRowFromSnapshot(winner, 7),
      });

      const result = await persistBusinessDnaSnapshot(
        { snapshot: snapshotA(), userId: 7 },
        executor
      );

      expect(result.status).toBe("replayed");
      expect(result.snapshot).toEqual(winner);
      expect(insertOps(recorded)).toHaveLength(1);
    });

    it("fails closed when the concurrent winner committed a different evidence hash", async () => {
      const winner = snapshotA();
      const loser = { ...winner, evidenceHashSha256: "0".repeat(64) };
      const { executor, recorded } = makeStoreFake({
        failFirstInsertWith: duplicateKeyError(),
        revealWinner: winnerRowFromSnapshot(winner, 7),
      });

      await expect(
        persistBusinessDnaSnapshot({ snapshot: loser, userId: 7 }, executor)
      ).rejects.toBeInstanceOf(BusinessDnaSnapshotConflictError);
      expect(insertOps(recorded)).toHaveLength(1);
    });

    it("fails closed when the winner has the same hash but a different canonical payload", async () => {
      const winner = snapshotA();
      const loser = { ...winner, approvedClaims: ["injected claim"] };
      const { executor, recorded } = makeStoreFake({
        failFirstInsertWith: duplicateKeyError(),
        revealWinner: winnerRowFromSnapshot(winner, 7),
      });

      await expect(
        persistBusinessDnaSnapshot({ snapshot: loser, userId: 7 }, executor)
      ).rejects.toBeInstanceOf(BusinessDnaSnapshotConflictError);
      expect(insertOps(recorded)).toHaveLength(1);
    });

    it("fails closed when a duplicate is reported but no committed winner row loads", async () => {
      const { executor, recorded } = makeStoreFake({
        failFirstInsertWith: duplicateKeyError(),
        // No revealWinner: the winner's commit never becomes visible.
      });

      await expect(
        persistBusinessDnaSnapshot({ snapshot: snapshotA(), userId: 7 }, executor)
      ).rejects.toThrow(/duplicate key but no committed row/);
      expect(insertOps(recorded)).toHaveLength(1);
    });

    it("does not turn non-duplicate database errors into replay", async () => {
      const connectionError = new Error("connect ECONNREFUSED 127.0.0.1:3306");
      (connectionError as { code?: string }).code = "ECONNREFUSED";
      const { executor, recorded } = makeStoreFake({
        failFirstInsertWith: connectionError,
        revealWinner: winnerRowFromSnapshot(snapshotA(), 7),
      });

      await expect(
        persistBusinessDnaSnapshot({ snapshot: snapshotA(), userId: 7 }, executor)
      ).rejects.toBe(connectionError);
      // Only the pre-insert read ran; no winner-row reread was attempted.
      expect(recorded.filter((op) => op.op === "select")).toHaveLength(1);
      expect(insertOps(recorded)).toHaveLength(1);
    });
  });
});
