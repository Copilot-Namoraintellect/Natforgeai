import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./queries/connection", () => ({
  getDb: vi.fn(() => {
    throw new Error("getDb must not fall back to a real connection in admin audit ledger tests");
  }),
}));

import { getDb } from "./queries/connection";
import { adminRouter } from "./admin-router";

function tableName(table: unknown): string {
  return (table as Record<symbol, string>)[Symbol.for("drizzle:Name")] ?? "unknown";
}

interface FakeDbOptions {
  users?: Record<string, unknown>[];
  payments?: Record<string, unknown>[];
  tiers?: Record<string, unknown>[];
}

/**
 * Minimal drizzle-shaped fake with transaction op logging. Work performed
 * inside transaction(cb) lands in `committed` only when cb resolves; a throw
 * rolls everything back. Non-transactional work lands immediately.
 */
function createFakeDb(opts: FakeDbOptions = {}) {
  const tables: Record<string, Record<string, unknown>[]> = {
    users: opts.users ?? [],
    payments: opts.payments ?? [],
    subscription_tiers: opts.tiers ?? [],
    audit_events: [],
  };
  const committed: { inserts: { table: string; values: Record<string, unknown> }[] } = {
    inserts: [],
  };
  const txLog: string[] = [];
  let nextInsertId = 500;

  function makeClient(prefix: string, staging: { inserts: { table: string; values: Record<string, unknown> }[] } | null) {
    const record = (kind: string, table: string) => {
      txLog.push(`${prefix}${kind}:${table}`);
    };
    const client = {
      select: () => ({
        from: (table: unknown) => {
          const name = tableName(table);
          const chain: Record<string, unknown> = {
            where: () => chain,
            orderBy: () => chain,
            limit: async () => {
              record("select", name);
              return tables[name] ?? [];
            },
          };
          return chain;
        },
      }),
      insert: (table: unknown) => ({
        values: async (values: Record<string, unknown>) => {
          const name = tableName(table);
          record("insert", name);
          const insertId = nextInsertId++;
          (staging ?? committed).inserts.push({ table: name, values });
          return [{ insertId }];
        },
      }),
      update: (table: unknown) => ({
        set: (_values: Record<string, unknown>) => ({
          where: () => {
            record("update", tableName(table));
            return Promise.resolve([{ affectedRows: 1 }]);
          },
        }),
      }),
      delete: (table: unknown) => ({
        where: () => {
          record("delete", tableName(table));
          return Promise.resolve([{ affectedRows: 1 }]);
        },
      }),
    };
    return client;
  }

  const db = {
    ...makeClient("", null),
    transaction: async (cb: (tx: unknown) => Promise<unknown>) => {
      txLog.push("tx:begin");
      const staging: { inserts: { table: string; values: Record<string, unknown> }[] } = { inserts: [] };
      try {
        const result = await cb(makeClient("tx:", staging));
        committed.inserts.push(...staging.inserts);
        txLog.push("tx:commit");
        return result;
      } catch (err) {
        txLog.push("tx:rollback");
        throw err;
      }
    },
  };

  return { db, committed, txLog };
}

function buildCtx(overrides: Record<string, unknown> = {}) {
  return {
    req: new Request("http://localhost/api/trpc", { headers: { "x-request-id": "req-ledger-1" } }),
    resHeaders: new Headers(),
    user: { id: 7, role: "admin", username: "operator" },
    session: { userId: 7, type: "local", verified: true },
    ...overrides,
  } as never;
}

function auditInserts(committed: { inserts: { table: string; values: Record<string, unknown> }[] }) {
  return committed.inserts.filter((i) => i.table === "audit_events").map((i) => i.values);
}

describe("admin mutation audit ledger (R4-F1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("audits updateUserRole atomically with the role change", async () => {
    const { db, committed, txLog } = createFakeDb({ users: [{ id: 42, role: "user" }] });
    vi.mocked(getDb).mockReturnValue(db as never);

    await adminRouter.createCaller(buildCtx()).updateUserRole({ userId: 42, role: "admin" });

    expect(txLog).toEqual([
      "tx:begin",
      "tx:select:users",
      "tx:update:users",
      // persistAuditEvent: fingerprint pre-check, insert, durable re-read.
      "tx:select:audit_events",
      "tx:insert:audit_events",
      "tx:select:audit_events",
      "tx:commit",
    ]);
    const [audit] = auditInserts(committed);
    expect(audit).toMatchObject({
      eventType: "admin_mutation",
      source: "admin",
      userId: 7,
    });
    expect(audit?.metadata).toMatchObject({
      action: "admin.user_role_updated",
      targetType: "user",
      targetId: 42,
      beforeRole: "user",
      afterRole: "admin",
      requestId: "req-ledger-1",
    });
  });

  it("audits updatePaymentStatus with before/after status", async () => {
    const { db, committed } = createFakeDb({ payments: [{ id: 9, status: "pending" }] });
    vi.mocked(getDb).mockReturnValue(db as never);

    await adminRouter
      .createCaller(buildCtx())
      .updatePaymentStatus({ paymentId: 9, status: "completed" });

    const [audit] = auditInserts(committed);
    expect(audit?.metadata).toMatchObject({
      action: "admin.payment_status_updated",
      targetType: "payment",
      targetId: 9,
      beforeStatus: "pending",
      afterStatus: "completed",
    });
  });

  it("audits recordPayment against the inserted payment id", async () => {
    const { db, committed } = createFakeDb();
    vi.mocked(getDb).mockReturnValue(db as never);

    await adminRouter.createCaller(buildCtx()).recordPayment({
      userId: 42,
      amount: 2000,
      currency: "USD",
      paymentMethod: "bank_transfer",
      description: "manual bank transfer",
    });

    const paymentInsert = committed.inserts.find((i) => i.table === "payments");
    expect(paymentInsert?.values).toMatchObject({ userId: 42, amount: 2000, status: "completed" });
    const [audit] = auditInserts(committed);
    expect(audit?.metadata).toMatchObject({
      action: "admin.payment_recorded",
      targetType: "payment",
      amount: 2000,
      targetUserId: 42,
    });
    // The audit targets the id of the payment row inserted in the same tx.
    const metadata = audit?.metadata as Record<string, unknown>;
    expect(typeof metadata.targetId).toBe("number");
    expect(metadata.targetId as number).toBeGreaterThan(0);
  });

  it("audits deleteUser inside the same transaction as every delete", async () => {
    const { db, committed, txLog } = createFakeDb({
      users: [{ id: 5, role: "user", authType: "local", username: "victim" }],
    });
    vi.mocked(getDb).mockReturnValue(db as never);

    const result = await adminRouter.createCaller(buildCtx()).deleteUser({ userId: 5 });

    expect(result.success).toBe(true);
    const deletes = txLog.filter((op) => op.startsWith("tx:delete:"));
    expect(deletes.length).toBe(13);
    expect(txLog.slice(-4)).toEqual([
      "tx:select:audit_events",
      "tx:insert:audit_events",
      "tx:select:audit_events",
      "tx:commit",
    ]);
    const [audit] = auditInserts(committed);
    expect(audit?.metadata).toMatchObject({
      action: "admin.user_deleted",
      targetType: "user",
      targetId: 5,
      deletedUsername: "victim",
      deletedRole: "user",
    });
  });

  it("blocks self-deletion without auditing a mutation that never happened", async () => {
    const { db, committed, txLog } = createFakeDb({
      users: [{ id: 7, role: "admin", authType: "local", username: "operator" }],
    });
    vi.mocked(getDb).mockReturnValue(db as never);

    await expect(
      adminRouter.createCaller(buildCtx()).deleteUser({ userId: 7 })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(auditInserts(committed)).toHaveLength(0);
    expect(txLog.filter((op) => op.startsWith("tx:delete"))).toHaveLength(0);
  });

  it("audits createUser without ever referencing the plaintext password", async () => {
    const { db, committed } = createFakeDb({ tiers: [{ id: 1, slug: "free" }] });
    vi.mocked(getDb).mockReturnValue(db as never);

    const result = await adminRouter.createCaller(buildCtx()).createUser({
      name: "New User",
      username: "newuser",
      email: "new@example.com",
      password: "super-secret-plaintext",
      role: "user",
    });

    expect(result.success).toBe(true);
    const userInsert = committed.inserts.find((i) => i.table === "users");
    expect(userInsert?.values.passwordHash).toBeTruthy();
    expect(userInsert?.values.passwordHash).not.toBe("super-secret-plaintext");
    const [audit] = auditInserts(committed);
    expect(audit?.metadata).toMatchObject({
      action: "admin.user_created",
      targetType: "user",
      createdRole: "user",
    });
    expect(JSON.stringify(audit?.metadata)).not.toContain("super-secret-plaintext");
    expect(audit?.metadata).not.toHaveProperty("password");
  });

  it("rolls the mutation back when the audit insert fails — no silent bypass", async () => {
    const { db, committed, txLog } = createFakeDb({ users: [{ id: 42, role: "user" }] });
    const failingDb = {
      ...db,
      transaction: async (cb: (tx: unknown) => Promise<unknown>) => {
        // Same as the fake, but the audit insert throws inside the tx.
        const staging: { inserts: { table: string; values: Record<string, unknown> }[] } = { inserts: [] };
        try {
          const result = await cb({
            select: db.select,
            update: db.update,
            delete: db.delete,
            insert: (_table: unknown) => ({
              values: async (values: Record<string, unknown>) => {
                if (tableName(_table) === "audit_events") {
                  throw new Error("audit insert failed");
                }
                staging.inserts.push({ table: tableName(_table), values });
                return [{ insertId: 1 }];
              },
            }),
          });
          committed.inserts.push(...staging.inserts);
          return result;
        } catch (err) {
          txLog.push("tx:rollback");
          throw err;
        }
      },
    };
    vi.mocked(getDb).mockReturnValue(failingDb as never);

    await expect(
      adminRouter.createCaller(buildCtx()).updateUserRole({ userId: 42, role: "admin" })
    ).rejects.toThrow("audit insert failed");

    expect(txLog).toContain("tx:rollback");
    // The user update must not have committed without its audit evidence.
    expect(committed.inserts).toHaveLength(0);
  });

  it("fails closed for unauthenticated, unverified and non-admin callers", async () => {
    const { db, committed } = createFakeDb({ users: [{ id: 42, role: "user" }] });
    vi.mocked(getDb).mockReturnValue(db as never);

    await expect(
      adminRouter.createCaller(buildCtx({ user: undefined, session: undefined })).updateUserRole({ userId: 42, role: "admin" })
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    await expect(
      adminRouter.createCaller(buildCtx({ session: { userId: 7, type: "local", verified: false } })).updateUserRole({ userId: 42, role: "admin" })
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    await expect(
      adminRouter.createCaller(buildCtx({ user: { id: 8, role: "user" } })).updateUserRole({ userId: 42, role: "admin" })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(auditInserts(committed)).toHaveLength(0);
  });
});
