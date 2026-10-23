import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./queries/connection", () => ({
  getDb: vi.fn(() => {
    throw new Error("getDb must not fall back to a real connection in governance audit tests");
  }),
}));

vi.mock("./lib/billing/credit-engine", () => ({
  getWalletWithStats: vi.fn(),
  adminAdjustCredits: vi.fn(),
  getCreditsSpentThisMonth: vi.fn(),
  allocateMonthlyCredits: vi.fn(),
}));

vi.mock("./lib/alerts", () => ({
  createAlert: vi.fn(async () => ({ id: 1 })),
  listAlerts: vi.fn(async () => []),
  acknowledgeAlert: vi.fn(async () => ({ id: 1 })),
  resolveAlerts: vi.fn(async () => ({ resolved: 3 })),
  getAlertSummary: vi.fn(async () => ({})),
}));

import { getDb } from "./queries/connection";
import { bankingRouter } from "./banking-router";
import { billingRouter } from "./billing-router";
import { healthRouter } from "./health-router";
import { integrationRouter } from "./integration-router";
import { subscriptionRouter } from "./subscription-router";
import { adminRouter } from "./admin-router";
import { adminAdjustCredits } from "./lib/billing/credit-engine";

function tableName(table: unknown): string {
  return (table as Record<symbol, string>)[Symbol.for("drizzle:Name")] ?? "unknown";
}

function createFakeDb(seed: Record<string, Record<string, unknown>[]> = {}) {
  const tables: Record<string, Record<string, unknown>[]> = { audit_events: [], ...seed };
  const committed: { inserts: { table: string; values: Record<string, unknown> }[] } = { inserts: [] };
  const txLog: string[] = [];
  let nextInsertId = 900;

  const makeClient = (prefix: string, staging: typeof committed | null) => ({
    select: (fields?: Record<string, unknown>) => ({
      from: (table: unknown) => {
        const name = tableName(table);
        const fetchRows = () => {
          txLog.push(`${prefix}select:${name}`);
          const rows = tables[name] ?? [];
          if (!fields) return rows;
          return rows.map((r) => {
            const projected: Record<string, unknown> = {};
            for (const [alias, col] of Object.entries(fields)) {
              projected[alias] = r[(col as { name: string }).name];
            }
            return projected;
          });
        };
        const chain: Record<string, unknown> = {
          where: () => chain,
          orderBy: () => chain,
          limit: async () => fetchRows(),
        };
        // Drizzle builders are thenable: a query ending in orderBy() is
        // awaited directly.
        chain.then = (onFulfilled: unknown, onRejected: unknown) =>
          Promise.resolve(fetchRows()).then(onFulfilled as never, onRejected as never);
        return chain;
      },
    }),
    insert: (table: unknown) => ({
      values: async (values: Record<string, unknown>) => {
        const name = tableName(table);
        txLog.push(`${prefix}insert:${name}`);
        const insertId = nextInsertId++;
        (staging ?? committed).inserts.push({ table: name, values });
        return [{ insertId }];
      },
    }),
    update: (table: unknown) => ({
      set: () => ({
        where: () => {
          txLog.push(`${prefix}update:${tableName(table)}`);
          return Promise.resolve([{ affectedRows: 1 }]);
        },
      }),
    }),
    delete: (table: unknown) => ({
      where: () => {
        txLog.push(`${prefix}delete:${tableName(table)}`);
        return Promise.resolve([{ affectedRows: 1 }]);
      },
    }),
  });

  const db = {
    ...makeClient("", null),
    transaction: async (cb: (tx: unknown) => Promise<unknown>) => {
      txLog.push("tx:begin");
      const staging: typeof committed = { inserts: [] };
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

function buildCtx(user: Record<string, unknown>) {
  return {
    req: new Request("http://localhost/api/trpc"),
    resHeaders: new Headers(),
    user,
    session: { userId: user.id, type: "local", verified: true },
  } as never;
}

const ADMIN = { id: 7, role: "admin", username: "operator" };
const auditRows = (committed: { inserts: { table: string; values: Record<string, unknown> }[] }) =>
  committed.inserts.filter((i) => i.table === "audit_events").map((i) => i.values);

describe("banking mutation audit (R4-F1)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("create: mutation + audit in one tx; account numbers never reach the ledger", async () => {
    const fake = createFakeDb();
    vi.mocked(getDb).mockReturnValue(fake.db as never);

    const res = await bankingRouter
      .createCaller(buildCtx(ADMIN))
      .create({ accountName: "Ops", accountNumber: "秘密-123456", bankName: "Bank", isDefault: true });

    expect(res.success).toBe(true);
    expect(fake.txLog[0]).toBe("tx:begin");
    expect(fake.txLog[fake.txLog.length - 1]).toBe("tx:commit");
    const [audit] = auditRows(fake.committed);
    expect(audit?.metadata).toMatchObject({
      action: "admin.banking_detail_created",
      targetType: "banking_detail",
      methodKind: "bank_transfer",
      isDefault: true,
    });
    expect(JSON.stringify(audit?.metadata)).not.toContain("秘密-123456");
    expect(audit?.metadata).not.toHaveProperty("accountNumber");
  });

  it("update: audit records changed field NAMES only, never values", async () => {
    const fake = createFakeDb();
    vi.mocked(getDb).mockReturnValue(fake.db as never);

    await bankingRouter
      .createCaller(buildCtx(ADMIN))
      .update({ id: 4, accountNumber: "secret-value-999", swiftCode: "ABCXYZ" });

    const [audit] = auditRows(fake.committed);
    expect(audit?.metadata).toMatchObject({
      action: "admin.banking_detail_updated",
      targetId: 4,
      changedFields: ["accountNumber", "swiftCode"],
    });
    expect(JSON.stringify(audit?.metadata)).not.toContain("secret-value-999");
  });

  it("delete: mutation + audit in one tx", async () => {
    const fake = createFakeDb();
    vi.mocked(getDb).mockReturnValue(fake.db as never);

    await bankingRouter.createCaller(buildCtx(ADMIN)).delete({ id: 4 });

    const [audit] = auditRows(fake.committed);
    expect(audit?.metadata).toMatchObject({
      action: "admin.banking_detail_deleted",
      targetType: "banking_detail",
      targetId: 4,
    });
  });
});

describe("billing / health / integration mutation audit (R4-F1)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("adminAdjustCredits records the operator action after the governed adjustment", async () => {
    const fake = createFakeDb();
    vi.mocked(getDb).mockReturnValue(fake.db as never);
    vi.mocked(adminAdjustCredits).mockResolvedValue({ newBalance: 1250 } as never);

    const res = await billingRouter
      .createCaller(buildCtx(ADMIN))
      .adminAdjustCredits({ userId: 55, amount: 500, description: "goodwill credit" });

    expect(res.newBalance).toBe(1250);
    const [audit] = auditRows(fake.committed);
    expect(audit?.metadata).toMatchObject({
      action: "admin.credit_adjustment",
      targetType: "credit_wallet",
      targetId: 55,
      amount: 500,
      newBalance: 1250,
    });
  });

  it("alert acknowledge and category resolve are audited", async () => {
    const fake = createFakeDb();
    vi.mocked(getDb).mockReturnValue(fake.db as never);

    await healthRouter.createCaller(buildCtx(ADMIN)).acknowledgeAlert({ alertId: 12 });
    await healthRouter.createCaller(buildCtx(ADMIN)).resolveAlertCategory({ category: "queue" });

    const rows = auditRows(fake.committed);
    expect(rows).toHaveLength(2);
    expect(rows[0].metadata).toMatchObject({ action: "admin.alert_acknowledged", targetId: 12 });
    expect(rows[1].metadata).toMatchObject({
      action: "admin.alert_category_resolved",
      category: "queue",
      resolved: 3,
    });
  });

  it("integration business assignment fails closed cross-user and audits the owner path", async () => {
    const otherUserFake = createFakeDb({
      social_integrations: [{ id: 3, userId: 8, businessId: null }],
    });
    vi.mocked(getDb).mockReturnValue(otherUserFake.db as never);

    // User A (admin id 7) cannot assign an integration owned by user 8.
    await expect(
      integrationRouter.createCaller(buildCtx(ADMIN)).assignIntegrationBusiness({ id: 3, businessId: 9 })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(auditRows(otherUserFake.committed)).toHaveLength(0);

    // Owner path mutates + audits inside one transaction.
    const ownerFake = createFakeDb({
      social_integrations: [{ id: 3, userId: 7, businessId: 2 }],
    });
    vi.mocked(getDb).mockReturnValue(ownerFake.db as never);
    await integrationRouter
      .createCaller(buildCtx(ADMIN))
      .assignIntegrationBusiness({ id: 3, businessId: 9 });
    const [audit] = auditRows(ownerFake.committed);
    expect(audit?.metadata).toMatchObject({
      action: "admin.integration_business_assigned",
      targetId: 3,
      beforeBusinessId: 2,
      afterBusinessId: 9,
    });
  });
});

describe("subscription self-grant backdoor closure (security)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects paid-tier activation even with a caller-supplied 'confirmed' flag", async () => {
    const fake = createFakeDb({
      subscription_tiers: [
        { id: 2, slug: "startup", priceUsd: 20, name: "Startup", billingCycle: "monthly", monthlyCredits: 0 },
      ],
    });
    vi.mocked(getDb).mockReturnValue(fake.db as never);

    // Legacy/malicious callers may still SEND the old flag; zod strips it
    // and the paid-tier gate fails closed regardless.
    await expect(
      subscriptionRouter
        .createCaller(buildCtx({ id: 30, role: "user" }))
        .subscribe({ tierId: 2, confirmedByWebhook: true } as never)
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const inserts = fake.committed.inserts.map((i) => i.table);
    expect(inserts).not.toContain("subscriptions");
    expect(inserts).not.toContain("payments");
  });

  it("still serves free-tier self-serve subscriptions without recording payments", async () => {
    const fake = createFakeDb({
      subscription_tiers: [
        { id: 1, slug: "free", priceUsd: 0, name: "Free", billingCycle: "monthly", monthlyCredits: 0 },
      ],
    });
    vi.mocked(getDb).mockReturnValue(fake.db as never);

    const res = await subscriptionRouter
      .createCaller(buildCtx({ id: 30, role: "user" }))
      .subscribe({ tierId: 1 });

    expect(res.id).toBeGreaterThan(0);
    expect(fake.committed.inserts.some((i) => i.table === "subscriptions")).toBe(true);
    expect(fake.committed.inserts.some((i) => i.table === "payments")).toBe(false);
  });
});

describe("admin.users credential projection (security)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("never returns password hashes or provider linkage fields", async () => {
    const fake = createFakeDb({
      users: [
        {
          id: 1,
          username: "victim",
          email: "victim@example.com",
          name: "Victim",
          role: "user",
          authType: "local",
          passwordHash: "$2b$12$hashedsecretmaterial",
          firebaseUid: "firebase-secret-uid",
          googleId: "google-secret-id",
          lastSignInAt: new Date("2026-01-01"),
          createdAt: new Date("2026-01-01"),
        },
      ],
    });
    vi.mocked(getDb).mockReturnValue(fake.db as never);

    const users = await adminRouter.createCaller(buildCtx(ADMIN)).users({});

    expect(users).toHaveLength(1);
    const row = users[0] as Record<string, unknown>;
    expect(row).toMatchObject({ id: 1, username: "victim", role: "user", authType: "local" });
    expect(row).not.toHaveProperty("passwordHash");
    expect(row).not.toHaveProperty("firebaseUid");
    expect(row).not.toHaveProperty("googleId");
  });
});
