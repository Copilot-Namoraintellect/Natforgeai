/**
 * WBS-R5-E2/E3/E7 — Policy store acceptance (pure-fake executor).
 *
 * Every test installs executor fakes; no real database is ever touched.
 * getDb() default routes are never exercised because every call passes an
 * explicit executor.
 */
import { describe, it, expect } from "vitest";
import { getTableName } from "drizzle-orm";
import { businessPolicies, policyDecisions } from "@db/schema";
import {
  getActivePolicy,
  getPolicyByVersion,
  activatePolicyVersion,
  adoptDefaultPolicy,
  PolicyStoreError,
} from "./policy-store";
import {
  recordPolicyDecision,
  getDecisionById,
  getDecisionByScope,
  listDecisions,
  countExecutableDecisionsSince,
  countChannelDecisionsSince,
  sumAutonomousCreditsSince,
  PolicyDecisionStoreError,
} from "./policy-decision-store";
import { buildDefaultPolicyConfig, buildBusinessPolicyConfig } from "./policy-model";
import { evaluateMarketingActionPolicy, type PolicyDecision } from "./decision-engine";
import { buildMarketingActionRequest, type MarketingActionRequestInput } from "./action-request";
import type { AuthoritativeIntelligence } from "./risk-classification";
import type { CostAuthoritySnapshot, VolumeAuthoritySnapshot } from "./cost-governance";

// ─── Compact drizzle fake: in-memory tables + eq-condition filtering ───

function evalCond(cond: any, row: any): boolean {
  const chunks: any[] = cond?.queryChunks ?? [];
  if (chunks.length === 0) return true;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (chunk && Array.isArray(chunk.queryChunks)) {
      if (!evalCond(chunk, row)) return false;
      continue;
    }
    if (chunk && typeof chunk === "object" && typeof chunk.name === "string") {
      // drizzle condition: column, operator, param
      const op = chunks[i + 1];
      const param = chunks[i + 2];
      const value = param && typeof param === "object" && "value" in param ? param.value : param;
      const rowValue = row[chunk.name];
      const opName = typeof op?.operator === "string" ? op.operator : typeof op === "string" ? op : "=";
      if (opName.includes("=") && !opName.includes(">") && !opName.includes("<")) {
        if (Array.isArray(value) ? !value.includes(rowValue) : rowValue !== value) return false;
      } else if (opName.includes(">") && !(rowValue >= value)) {
        return false;
      } else if (opName.includes("<") && !(rowValue <= value)) {
        return false;
      }
      i += 2;
    }
  }
  return true;
}

function makeFakeDb(seed: Record<string, Record<string, unknown>[]> = {}) {
  const tables: Record<string, Record<string, unknown>[]> = {
    business_policies: [],
    policy_decisions: [],
    ...seed,
  };
  const inserts: { table: string; values: Record<string, unknown> }[] = [];
  const updates: { table: string; set: Record<string, unknown> }[] = [];
  let failInsertWith: Error | null = null;
  let autoId = 9000;

  function chain(table: string, cond: any) {
    const c: Record<string, unknown> = {};
    c.from = () => c;
    c.where = (w: any) => {
      cond = w;
      return c;
    };
    c.orderBy = () => c;
    c.limit = () => c;
    c.then = (resolve: (rows: unknown[]) => unknown, reject?: (e: unknown) => unknown) => {
      const name = table;
      const rows = (tables[name] ?? []).filter((r) => evalCond(cond, r));
      // Minimal orderBy support: desc(version) if requested is fine unsorted
      // for our assertions; callers use single-row limits.
      return Promise.resolve(resolve(rows));
    };
    return c;
  }

  const executor: any = {
    select: () => {
      let table = "";
      const c: Record<string, unknown> = {};
      c.from = (t: unknown) => {
        table = getTableName(t as never);
        return chain(table, undefined);
      };
      return c;
    },
    insert: (t: unknown) => ({
      values: async (values: Record<string, unknown>) => {
        const name = getTableName(t as never);
        if (failInsertWith) throw failInsertWith;
        const row: Record<string, unknown> = { id: ++autoId, ...values };
        const uniqueChecks: string[][] =
          name === "business_policies" ? [["policyId", "version"]] : [["policyDecisionId"], ["decisionScopeKey"]];
        for (const keys of uniqueChecks) {
          const conflict = (tables[name] ?? []).some((r) => keys.every((k) => r[k] === row[k]));
          if (conflict) {
            const err = new Error("Duplicate entry") as Error & { code: string };
            err.code = "ER_DUP_ENTRY";
            throw err;
          }
        }
        tables[name].push(row);
        inserts.push({ table: name, values: row });
        return [{ insertId: row.id }];
      },
    }),
    update: (t: unknown) => {
      const name = getTableName(t as never);
      return {
        set: (setValues: Record<string, unknown>) => {
          updates.push({ table: name, set: setValues });
          // Apply eq-only conditions against stored rows for realism.
          return {
            where: (cond: any) => {
              for (const row of tables[name] ?? []) {
                if (evalCond(cond, row)) Object.assign(row, setValues);
              }
              return Promise.resolve([{ affectedRows: 1 }]);
            },
          };
        },
      };
    },
    _tables: tables,
    _inserts: inserts,
    _updates: updates,
    _failInsertWith: (e: Error | null) => {
      failInsertWith = e;
    },
  };
  return executor;
}

type FakeDb = ReturnType<typeof makeFakeDb>;

// ─── Decision fixtures ───

const NOW = "2026-06-28T12:00:00.000Z";

function makeDecision(overrides: Partial<MarketingActionRequestInput> = {}): PolicyDecision {
  const request = buildMarketingActionRequest({
    actionRequestId: "ar1:c-1",
    businessId: 10,
    sourceSignalId: "sig-1",
    sourceInterpretationId: "interp-1",
    actionType: "reply_publicly",
    platform: "instagram",
    providerAccountBinding: { integrationId: 4, platform: "instagram", externalAccountRef: "p1" },
    campaignId: 55,
    publicationId: null,
    estimatedCostClass: "low",
    requestedAt: NOW,
    contextVersion: "ctx:1",
    ...overrides,
  });
  const intelligence: AuthoritativeIntelligence = {
    sourceInterpretationId: "interp-1",
    intelligenceVersion: "iv-1",
    sentiment: "positive",
    intentClass: "praise",
    confidence: 0.95,
    containsPersonalData: false,
    injectionSuspected: false,
  };
  const cost: CostAuthoritySnapshot = {
    walletBalance: 100,
    openReservationCredits: 0,
    dailySpend: 0,
    monthlySpend: 0,
    dailySystemLimit: 1000,
    monthlySystemLimit: 10000,
    walletSpendLimit: null,
    periodAutonomousSpend: 0,
  };
  const volume: VolumeAuthoritySnapshot = { actionsExecutedToday: 0, channelActionsToday: {} };
  return evaluateMarketingActionPolicy({
    request,
    userId: 7,
    policy: {
      policyId: "pol_x",
      businessId: 10,
      version: 1,
      policyVersion: "v1-test",
      config: buildBusinessPolicyConfig({
        ...buildDefaultPolicyConfig(),
        actions: { autonomous: ["reply_publicly"], requireApproval: [], prohibited: [] },
      } as never),
    },
    intelligence,
    cost,
    volume,
    providerRate: { rateLimited: false },
    providerCapability: { bindingVerified: true, capabilityAvailable: true },
    now: NOW,
  });
}

function decisionRow(d: PolicyDecision) {
  return {
    policyDecisionId: d.policyDecisionId,
    policyId: d.policyId,
    policyVersion: d.policyVersion,
    businessId: d.businessId,
    userId: d.userId,
    actionRequestId: d.actionRequestId,
    decisionScopeKey: `${d.actionRequestId}|${d.policyVersion ?? "NO_POLICY"}`,
    actionType: d.actionType,
    platform: d.platform,
    campaignId: d.campaignId,
    sourceSignalId: d.sourceSignalId,
    sourceInterpretationId: d.sourceInterpretationId,
    intelligenceVersion: d.intelligenceVersion,
    decision: d.decision,
    reasonCodes: [...d.reasonCodes],
    riskClass: d.riskClass,
    approvalRequired: d.approvalRequired,
    costEligible: d.costEligible,
    rateEligible: d.rateEligible,
    providerEligible: d.providerEligible,
    estimatedCostClass: d.estimatedCostClass,
    estimatedCredits: d.estimatedCredits,
    billingIdentity: d.billingIdentity,
    approvalBinding: d.approvalBinding,
    thresholds: { ...d.thresholds },
    expiresAt: d.expiresAt,
    evaluatedAt: d.evaluatedAt,
    evaluationFingerprint: d.evaluationFingerprint,
  };
}

describe("policy-store", () => {
  it("returns null when no active policy exists", async () => {
    const db = makeFakeDb();
    expect(await getActivePolicy(10, db)).toBeNull();
  });

  it("activates the first version (v1) and persists the validated config", async () => {
    const db = makeFakeDb();
    const policy = await activatePolicyVersion({ userId: 7, businessId: 10, config: buildDefaultPolicyConfig(), executor: db });
    expect(policy.version).toBe(1);
    expect(policy.policyVersion).toMatch(/^v1-/);
    expect(db._inserts).toHaveLength(1);
    expect(db._inserts[0].table).toBe("business_policies");
    expect(db._inserts[0].values.isActive).toBe(true);
  });

  it("increments the version and deactivates the previous active row", async () => {
    const db = makeFakeDb();
    await activatePolicyVersion({ userId: 7, businessId: 10, config: buildDefaultPolicyConfig(), executor: db });
    const changed = buildBusinessPolicyConfig({
      ...buildDefaultPolicyConfig(),
      volume: { maxActionsPerDay: 99, maxActionsPerChannelPerDay: 20 },
    } as never);
    const v2 = await activatePolicyVersion({ userId: 7, businessId: 10, config: changed, executor: db });
    expect(v2.version).toBe(2);
    expect(v2.policyVersion).not.toBe((await getPolicyByVersion(10, 1, db))?.policyVersion);
    expect(db._updates.some((u: { table: string; set: Record<string, unknown> }) => u.table === "business_policies" && u.set.isActive === false)).toBe(true);
  });

  it("adoptDefaultPolicy is idempotent when the default is already active", async () => {
    const db = makeFakeDb();
    const first = await adoptDefaultPolicy({ userId: 7, businessId: 10, executor: db });
    const insertCount = db._inserts.length;
    const second = await adoptDefaultPolicy({ userId: 7, businessId: 10, executor: db });
    expect(second.policyVersion).toBe(first.policyVersion);
    expect(db._inserts.length).toBe(insertCount);
  });

  it("fails closed on invalid identity inputs", async () => {
    const db = makeFakeDb();
    await expect(
      activatePolicyVersion({ userId: 0, businessId: 10, config: buildDefaultPolicyConfig(), executor: db })
    ).rejects.toThrow(PolicyStoreError);
    await expect(getActivePolicy(0, db)).rejects.toThrow(PolicyStoreError);
  });
});

describe("policy-decision-store", () => {
  it("persists a decision with the deterministic scope key", async () => {
    const db = makeFakeDb();
    const d = makeDecision();
    const result = await recordPolicyDecision(d, db);
    expect(result.duplicateClassification).toBe("none");
    expect(db._inserts).toHaveLength(1);
    expect(db._inserts[0].values.policyDecisionId).toBe(d.policyDecisionId);
    expect(db._inserts[0].values.decisionScopeKey).toBe(`${d.actionRequestId}|${d.policyVersion}`);
  });

  it("converges duplicate evaluations to one durable row (idempotent replay)", async () => {
    const db = makeFakeDb();
    const d = makeDecision();
    await recordPolicyDecision(d, db);
    db._failInsertWith(Object.assign(new Error("Duplicate entry"), { code: "ER_DUP_ENTRY" }));
    const replay = await recordPolicyDecision(d, db);
    expect(replay.duplicateClassification).toBe("idempotent_replay");
    expect(replay.decision.policyDecisionId).toBe(d.policyDecisionId);
    expect(replay.decision.evaluationFingerprint).toBe(d.evaluationFingerprint);
  });

  it("fails closed on replayed decision with conflicting material", async () => {
    const db = makeFakeDb();
    const d = makeDecision();
    await recordPolicyDecision(d, db);
    db._failInsertWith(Object.assign(new Error("Duplicate entry"), { code: "ER_DUP_ENTRY" }));
    const tampered = { ...d, evaluationFingerprint: "deadbeef".repeat(8), riskClass: "critical" as const };
    await expect(recordPolicyDecision(tampered, db)).rejects.toThrow(/DECISION_IDENTITY_CONFLICT/);
  });

  it("reads decisions by id and scope", async () => {
    const db = makeFakeDb();
    const d = makeDecision();
    await recordPolicyDecision(d, db);
    const byId = await getDecisionById(d.policyDecisionId, db);
    const byScope = await getDecisionByScope(d.actionRequestId, d.policyVersion, db);
    expect(byId?.decision).toBe("ALLOW_AUTONOMOUS");
    expect(byScope?.policyDecisionId).toBe(d.policyDecisionId);
    expect(byId?.reasonCodes).toContain("ACTION_ALLOWED_BY_POLICY");
  });

  it("scopes listDecisions by business", async () => {
    const db = makeFakeDb();
    await recordPolicyDecision(makeDecision(), db);
    await recordPolicyDecision(makeDecision({ actionRequestId: "ar1:c-2", contextVersion: "ctx:2" }), db);
    const other = makeDecision({ actionRequestId: "ar1:c-3", businessId: 11 });
    // Business 11 row seeded directly (decision engine uses business 10 policy;
    // row conversion is what matters here).
    db._tables.policy_decisions.push({ ...decisionRow(other), businessId: 11 });
    const list = await listDecisions({ businessId: 10 }, db);
    expect(list).toHaveLength(2);
    const filtered = await listDecisions({ businessId: 10, decision: "ALLOW_AUTONOMOUS" }, db);
    expect(filtered).toHaveLength(2);
    const denyList = await listDecisions({ businessId: 10, decision: "DENY" }, db);
    expect(denyList).toHaveLength(0);
  });

  it("aggregate selectors return numbers from the store", async () => {
    const db = makeFakeDb();
    const d = makeDecision();
    db._tables.policy_decisions.push({ ...decisionRow(d), evaluatedAt: d.evaluatedAt });
    // The compact fake does not compute SQL aggregates; assert the call
    // contract (returns a finite number) with a queue-shaped stub instead.
    const canned = {
      select: () => {
        const c: Record<string, unknown> = {};
        c.from = () => c;
        c.where = () => c;
        c.limit = () => c;
        c.orderBy = () => c;
        c.then = (resolve: (rows: unknown[]) => unknown) => Promise.resolve(resolve([{ total: 3 }]));
        return c;
      },
      insert: db.insert,
    } as any;
    expect(await countExecutableDecisionsSince(10, "2026-06-28T00:00:00.000Z", canned)).toBe(3);
    expect(await countChannelDecisionsSince(10, "instagram", "2026-06-28T00:00:00.000Z", canned)).toBe(3);
    expect(await sumAutonomousCreditsSince(10, "2026-06-28T00:00:00.000Z", canned)).toBe(3);
  });

  it("rejects invalid decision input", async () => {
    const db = makeFakeDb();
    await expect(recordPolicyDecision(null as never, db)).rejects.toThrow(PolicyDecisionStoreError);
  });
});
