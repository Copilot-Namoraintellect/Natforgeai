import { describe, expect, it } from "vitest";
import type { Pool } from "mysql2/promise";
import { disabled, type ActivationAudit } from "./autonomy-contract";
import { createMysqlActivationRepository } from "./autonomy-mysql-store";

const scope = {
  tenantId: 1,
  businessId: 10,
  capability: "planning",
  actionClass: "EXECUTE_STEP",
};
function fixture(auditFails = false) {
  const events: string[] = [];
  const original = disabled(scope);
  const connection = {
    async beginTransaction() {
      events.push("BEGIN");
    },
    async commit() {
      events.push("COMMIT");
    },
    async rollback() {
      events.push("ROLLBACK");
    },
    release() {
      events.push("RELEASE");
    },
    async execute(sql: string) {
      events.push(sql);
      if (sql.startsWith("SELECT version"))
        return [[{ version: 0, state_json: JSON.stringify(original) }]];
      if (sql.startsWith("INSERT INTO autonomy_activation_audit") && auditFails)
        throw new Error("AUDIT_DISK_FAILURE");
      if (sql.startsWith("SELECT action_id")) return [[]];
      return [{ affectedRows: 1 }];
    },
  };
  const pool = {
    async getConnection() {
      return connection;
    },
    async execute(sql: string) {
      events.push(sql);
      return [[]];
    },
  } as unknown as Pool;
  return { repository: createMysqlActivationRepository(pool), events };
}
describe("R10-H MySQL transaction boundary (offline protocol harness)", () => {
  it("unconfigured observation performs only SELECT and does not seed state", async () => {
    const h = fixture();
    expect(await h.repository.read(scope)).toEqual(disabled(scope));
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatch(/^SELECT/);
  });
  it("authority state and append-only audit precede a single commit", async () => {
    const h = fixture();
    await h.repository.transaction(scope, async tx => {
      await tx.save({ ...tx.current, version: 1 }, {
        version: 1,
      } as ActivationAudit);
    });
    expect(
      h.events.findIndex(x => x.startsWith("UPDATE autonomy_activations"))
    ).toBeLessThan(
      h.events.findIndex(x =>
        x.startsWith("INSERT INTO autonomy_activation_audit")
      )
    );
    expect(h.events.at(-2)).toBe("COMMIT");
    expect(h.events.at(-1)).toBe("RELEASE");
    expect(
      h.events.some(x => /UPDATE autonomy_activation_audit|DELETE/.test(x))
    ).toBe(false);
  });
  it("audit persistence failure rolls back rather than publishing changed authority", async () => {
    const h = fixture(true);
    await expect(
      h.repository.transaction(scope, async tx => {
        await tx.save({ ...tx.current, version: 1 }, {
          version: 1,
        } as ActivationAudit);
      })
    ).rejects.toThrow("AUDIT_DISK_FAILURE");
    expect(h.events).toContain("ROLLBACK");
    expect(h.events).not.toContain("COMMIT");
    expect(h.events.at(-1)).toBe("RELEASE");
  });
  it("canary reserves under the same scope lock", async () => {
    const h = fixture();
    await h.repository.transaction(scope, async tx => {
      expect(await tx.reserveCanary("action1", 2)).toBe(true);
    });
    expect(h.events.some(x => x.includes("FOR UPDATE"))).toBe(true);
    expect(
      h.events.some(x =>
        x.startsWith("INSERT INTO autonomy_canary_reservations")
      )
    ).toBe(true);
  });
  it("a denied callback rolls back and releases its lock", async () => {
    const h = fixture();
    await expect(
      h.repository.transaction(scope, async () => {
        throw new Error("DENIED");
      })
    ).rejects.toThrow("DENIED");
    expect(h.events.slice(-2)).toEqual(["ROLLBACK", "RELEASE"]);
  });
});
