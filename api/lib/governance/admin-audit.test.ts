import { describe, it, expect } from "vitest";
import {
  ADMIN_AUDIT_ACTIONS,
  ADMIN_MUTATION_AUDIT_EVENT_TYPE,
  extractAdminRequestId,
  recordAdminMutationAudit,
} from "./admin-audit";
import type { AuditDbExecutor } from "../audit/audit-store";

/**
 * In-memory AuditDbExecutor. The where() clause is not interpreted; every
 * audit select returns all stored rows, which is sufficient because
 * persistAuditEvent re-verifies the fingerprint match itself.
 */
function createFakeAuditExecutor() {
  const rows: Record<string, unknown>[] = [];
  const stats = { inserts: 0, selects: 0 };
  const executor: AuditDbExecutor = {
    select: () =>
      ({
        from: () =>
          ({
            where: () => ({
              limit: async () => {
                stats.selects += 1;
                return rows;
              },
            }),
            limit: async () => {
              stats.selects += 1;
              return rows;
            },
          }) as never,
      }) as never,
    insert: () =>
      ({
        values: async (row: Record<string, unknown>) => {
          stats.inserts += 1;
          rows.push(row);
          return [];
        },
      }) as never,
  };
  return { executor, rows, stats };
}

const FIXED_TIME = new Date("2026-10-23T12:00:00.000Z");

describe("recordAdminMutationAudit", () => {
  it("records a canonical admin_mutation event with actor, action and target", async () => {
    const { executor, rows, stats } = createFakeAuditExecutor();

    const record = await recordAdminMutationAudit({
      actorUserId: 7,
      action: "admin.user_role_updated",
      targetType: "user",
      targetId: 42,
      reason: "operator promotion request",
      occurredAt: FIXED_TIME,
      metadata: { beforeRole: "user", afterRole: "admin" },
      executor,
    });

    expect(stats.inserts).toBe(1);
    expect(record.inserted).toBe(true);
    expect(record.event.eventType).toBe(ADMIN_MUTATION_AUDIT_EVENT_TYPE);
    expect(record.event.source).toBe("admin");
    expect(record.event.userId).toBe(7);
    expect(record.event.outcome).toBe("succeeded");
    expect(record.event.occurredAt).toBe("2026-10-23T12:00:00.000Z");

    const [row] = rows;
    expect(row).toMatchObject({
      eventType: "admin_mutation",
      source: "admin",
      userId: 7,
    });
    expect(row?.metadata).toMatchObject({
      action: "admin.user_role_updated",
      targetType: "user",
      targetId: 42,
      reason: "operator promotion request",
      beforeRole: "user",
      afterRole: "admin",
    });
  });

  it("strips secret-bearing metadata keys before persistence", async () => {
    const { executor, rows } = createFakeAuditExecutor();

    await recordAdminMutationAudit({
      actorUserId: 7,
      action: "admin.user_created",
      targetType: "user",
      targetId: 99,
      occurredAt: FIXED_TIME,
      // A careless call site must not be able to leak these even if it tried.
      metadata: { password: "hunter2-plaintext", note: "legit", apiKey: "abc123" },
      executor,
    });

    const [row] = rows;
    expect(row?.metadata).toEqual({ action: "admin.user_created", note: "legit", targetId: 99, targetType: "user" });
  });

  it.each([
    ["zero actor", { actorUserId: 0 }],
    ["negative actor", { actorUserId: -3 }],
    ["non-integer actor", { actorUserId: 1.5 }],
  ])("fails closed for %s instead of inventing an actor", async (_label, override) => {
    const { executor, stats } = createFakeAuditExecutor();
    await expect(
      recordAdminMutationAudit({
        action: "admin.user_deleted",
        targetType: "user",
        targetId: 5,
        occurredAt: FIXED_TIME,
        executor,
        ...(override as object),
      } as never)
    ).rejects.toMatchObject({ code: "INVALID_AUDIT_USER_ID" });
    expect(stats.inserts).toBe(0);
  });

  it("fails closed for an unknown action", async () => {
    const { executor, stats } = createFakeAuditExecutor();
    await expect(
      recordAdminMutationAudit({
        actorUserId: 7,
        action: "admin.make_everyone_admin",
        targetType: "user",
        targetId: 5,
        occurredAt: FIXED_TIME,
        executor,
      } as never)
    ).rejects.toMatchObject({ code: "INVALID_AUDIT_ACTION" });
    expect(stats.inserts).toBe(0);
  });

  it("fails closed for an unknown target type", async () => {
    const { executor, stats } = createFakeAuditExecutor();
    await expect(
      recordAdminMutationAudit({
        actorUserId: 7,
        action: "admin.user_deleted",
        targetType: "database",
        targetId: 5,
        occurredAt: FIXED_TIME,
        executor,
      } as never)
    ).rejects.toMatchObject({ code: "INVALID_AUDIT_TARGET_TYPE" });
    expect(stats.inserts).toBe(0);
  });

  it("treats an exact retry as an idempotent replay, not a second ledger row", async () => {
    const { executor, rows, stats } = createFakeAuditExecutor();
    const input = {
      actorUserId: 7,
      action: "admin.payment_recorded" as const,
      targetType: "payment" as const,
      targetId: 11,
      occurredAt: FIXED_TIME,
      metadata: { amount: 5000, currency: "USD" },
    };

    const first = await recordAdminMutationAudit({ ...input, executor });
    const second = await recordAdminMutationAudit({ ...input, executor });

    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.duplicateClassification).toBe("idempotent_replay");
    expect(stats.inserts).toBe(1);
    expect(rows).toHaveLength(1);
  });

  it("records a malformed request correlation id as absent, never trusted", async () => {
    const first = createFakeAuditExecutor();
    await recordAdminMutationAudit({
      actorUserId: 7,
      action: "admin.alert_acknowledged",
      targetType: "system_alert",
      targetId: 3,
      occurredAt: FIXED_TIME,
      requestId: "bad id; drop me <<script>>",
      executor: first.executor,
    });
    expect(first.rows[0]?.metadata).not.toHaveProperty("requestId");

    const second = createFakeAuditExecutor();
    await recordAdminMutationAudit({
      actorUserId: 7,
      action: "admin.alert_acknowledged",
      targetType: "system_alert",
      targetId: 4,
      occurredAt: FIXED_TIME,
      requestId: "req-abc_123",
      executor: second.executor,
    });
    expect(second.rows[0]?.metadata).toMatchObject({ requestId: "req-abc_123" });
  });

  it("exposes only closed-vocabulary actions", () => {
    expect(ADMIN_AUDIT_ACTIONS).toContain("admin.user_role_updated");
    expect(new Set(ADMIN_AUDIT_ACTIONS).size).toBe(ADMIN_AUDIT_ACTIONS.length);
  });
});

describe("extractAdminRequestId", () => {
  it("returns the header value when well-formed", () => {
    const req = new Request("http://localhost/api/trpc", {
      headers: { "x-request-id": "req-1aB_2" },
    });
    expect(extractAdminRequestId(req)).toBe("req-1aB_2");
  });

  it("returns null when the header is absent or malformed", () => {
    expect(extractAdminRequestId(new Request("http://localhost/api/trpc"))).toBeNull();
    const bad = new Request("http://localhost/api/trpc", {
      headers: { "x-request-id": "no spaces or; punctuation allowed!!" },
    });
    expect(extractAdminRequestId(bad)).toBeNull();
    expect(extractAdminRequestId(null)).toBeNull();
    expect(extractAdminRequestId({})).toBeNull();
  });
});
