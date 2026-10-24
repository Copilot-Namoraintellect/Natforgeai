/**
 * WBS-R5-E8 — Policy Acceptance Suite.
 *
 * Twenty-four adversarial acceptance cases over the connected harness:
 *
 *   intelligence fixture → action request → policy evaluation
 *   → risk/cost/rate/provider checks → allow/approval/deny/escalate
 *   → durable auditable decision
 *
 * The harness runs the REAL router + REAL policy/decision stores + REAL
 * approval decision flow against a pure in-memory fake database. Authority
 * snapshots are injected (resolver mocked). No real database, no provider,
 * no execution — by construction.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { getTableName } from "drizzle-orm";

vi.mock("./queries/connection", () => ({
  getDb: vi.fn(),
}));

vi.mock("./lib/workflow/triggers", () => ({
  onApprovalResolved: vi.fn(async () => {}),
}));

vi.mock("./lib/policy/policy-authority-resolver", () => ({
  resolveCostAuthoritySnapshot: vi.fn(),
  resolveVolumeAuthoritySnapshot: vi.fn(),
  resolvePeriodAutonomousSpend: vi.fn(),
  resolveProviderCapabilitySnapshot: vi.fn(),
  resolveProviderRateSnapshot: vi.fn(),
}));

import { getDb } from "./queries/connection";
import { policyRouter } from "./policy-router";
import { approvalRouter } from "./approval-router";
import {
  resolveCostAuthoritySnapshot,
  resolveVolumeAuthoritySnapshot,
  resolvePeriodAutonomousSpend,
  resolveProviderCapabilitySnapshot,
  resolveProviderRateSnapshot,
} from "./lib/policy/policy-authority-resolver";
import { assertMarketingActionExecutable } from "./lib/policy/marketing-action-approval";
import type { CostAuthoritySnapshot, VolumeAuthoritySnapshot } from "./lib/policy/cost-governance";

// ─── In-memory fake database ───

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
      const op = chunks[i + 1];
      const param = chunks[i + 2];
      const value = param && typeof param === "object" && "value" in param ? param.value : param;
      const rowValue = row[chunk.name];
      const opName = typeof op?.operator === "string" ? op.operator : typeof op === "string" ? op : "=";
      if (opName.includes(">") && !opName.includes("=")) {
        if (!(rowValue > value)) return false;
      } else if (opName.includes("<") && !opName.includes("=")) {
        if (!(rowValue < value)) return false;
      } else if (Array.isArray(value)) {
        if (!value.includes(rowValue)) return false;
      } else if (rowValue !== value) {
        return false;
      }
      i += 2;
    }
  }
  return true;
}

function makeFakeDb(seed: Record<string, Record<string, unknown>[]> = {}) {
  const tables: Record<string, Record<string, unknown>[]> = {
    businesses: [
      { id: 10, userId: 7 },
      { id: 11, userId: 8 },
    ],
    campaigns: [
      { id: 55, userId: 7, businessId: 10 },
      { id: 56, userId: 7, businessId: 11 },
    ],
    publishing_queue: [],
    approval_requests: [],
    audit_events: [],
    business_policies: [],
    policy_decisions: [],
    ...seed,
  };
  let autoId = 5000;
  const fake: any = {};

  function selectChain(table: string, cond: any) {
    const c: any = {};
    c.from = () => c;
    c.where = (w: any) => {
      cond = w;
      return c;
    };
    c.orderBy = (...cols: any[]) => {
      const col = cols[0]?.[0] ?? cols[0];
      const name = col?.name;
      if (name) {
        const dir = cols[0]?.[1] ?? cols[1];
        const descSort = typeof dir === "string" ? dir.toLowerCase().includes("desc") : false;
        (tables[table] ?? []).sort((a, b) => {
          const av: any = a[name];
          const bv: any = b[name];
          if (av === bv) return 0;
          const cmp = av > bv ? 1 : -1;
          return descSort ? -cmp : cmp;
        });
      }
      return c;
    };
    c.limit = () => c;
    c.then = (resolve: (rows: unknown[]) => unknown) =>
      Promise.resolve(resolve((tables[table] ?? []).filter((r) => evalCond(cond, r))));
    return c;
  }

  fake.select = () => {
    let table = "";
    const c: any = {};
    c.from = (t: unknown) => {
      table = getTableName(t as never);
      return selectChain(table, undefined);
    };
    return c;
  };
  fake.insert = (t: unknown) => ({
    values: async (values: Record<string, unknown>) => {
      const name = getTableName(t as never);
      const row: Record<string, unknown> = { id: ++autoId, ...values };
      const uniqueChecks: string[][] =
        name === "business_policies"
          ? [["policyId", "version"]]
          : name === "policy_decisions"
            ? [["policyDecisionId"], ["decisionScopeKey"]]
            : name === "approval_requests"
              ? [["idempotencyKey"]]
              : name === "audit_events"
                ? [["eventFingerprint"]]
                : [];
      for (const keys of uniqueChecks) {
        if (keys.some((k) => row[k] === undefined || row[k] === null)) continue;
        const conflict = (tables[name] ?? []).some((r) => keys.every((k) => r[k] === row[k]));
        if (conflict) {
          const err = new Error("Duplicate entry") as Error & { code: string };
          err.code = "ER_DUP_ENTRY";
          throw err;
        }
      }
      tables[name].push(row);
      return [{ insertId: row.id }];
    },
  });
  fake.update = (t: unknown) => {
    const name = getTableName(t as never);
    return {
      set: (setValues: Record<string, unknown>) => ({
        where: (cond: any) => {
          let affected = 0;
          for (const row of tables[name] ?? []) {
            if (evalCond(cond, row)) {
              Object.assign(row, setValues);
              affected++;
            }
          }
          return Promise.resolve([{ affectedRows: affected }]);
        },
      }),
    };
  };
  fake.transaction = async (fn: (tx: unknown) => unknown) => fn(fake);
  fake._tables = tables;
  return fake;
}

let fakeDb: ReturnType<typeof makeFakeDb>;

function buildCtx(user: { id: number; role?: string } | null) {
  return {
    req: new Request("http://localhost/trpc"),
    resHeaders: new Headers(),
    user: user ? ({ id: user.id, role: user.role ?? "user" } as never) : undefined,
    session: user ? ({ verified: true } as never) : undefined,
  };
}

const USER_A = { id: 7, role: "user" };
const USER_B = { id: 8, role: "user" };
const ADMIN = { id: 99, role: "admin" };

const BASE_COST: CostAuthoritySnapshot = {
  walletBalance: 100,
  openReservationCredits: 0,
  dailySpend: 0,
  monthlySpend: 0,
  dailySystemLimit: 1000,
  monthlySystemLimit: 10000,
  walletSpendLimit: null,
  periodAutonomousSpend: 0,
};
const EMPTY_VOLUME: VolumeAuthoritySnapshot = { actionsExecutedToday: 0, channelActionsToday: {} };

const PRAISE_INTEL = {
  sourceInterpretationId: "interp-1",
  intelligenceVersion: "iv-1",
  sentiment: "positive",
  intentClass: "praise",
  confidence: 0.95,
  containsPersonalData: false,
  injectionSuspected: false,
};

function actionRequest(overrides: Record<string, unknown> = {}) {
  return {
    actionRequestId: "ar1:c-1",
    businessId: 10,
    sourceSignalId: "sig-1",
    sourceInterpretationId: "interp-1",
    actionType: "reply_publicly",
    platform: "instagram",
    providerAccountBinding: { integrationId: 4, platform: "instagram", externalAccountRef: "page-1" },
    campaignId: 55,
    publicationId: null,
    estimatedCostClass: "low",
    requestedAt: "2026-06-28T12:00:00.000Z",
    contextVersion: "ctx:1",
    intelligence: { ...PRAISE_INTEL },
    ...overrides,
  };
}

/** Business policy with reply_publicly autonomous, nurture prohibited. */
const AUTONOMOUS_POLICY_CONFIG = {
  actions: {
    autonomous: ["reply_publicly", "react", "observe_only"],
    requireApproval: ["reply_privately", "schedule_follow_up"],
    prohibited: ["nurture_candidate"],
  },
  defaultActionDisposition: "require_approval",
  allowedPlatforms: null,
  prohibitedPlatforms: [],
  businessHours: null,
  riskDispositions: {
    low: "ALLOW_AUTONOMOUS",
    medium: "REQUIRE_APPROVAL",
    high: "ESCALATE",
    critical: "ESCALATE",
  },
  minAutonomousConfidence: 0.6,
  spend: { maxAutonomousCreditsPerDay: 20, maxActionCredits: 20 },
  volume: { maxActionsPerDay: 50, maxActionsPerChannelPerDay: 20 },
  executionTtlMinutes: 15,
};

async function seedPolicy(user: { id: number }, businessId: number, config = AUTONOMOUS_POLICY_CONFIG) {
  const caller = policyRouter.createCaller(buildCtx(user));
  return caller.setPolicy({ businessId, config: config as Record<string, unknown> });
}

beforeEach(() => {
  fakeDb = makeFakeDb();
  vi.mocked(getDb).mockReturnValue(fakeDb as never);
  vi.mocked(resolveCostAuthoritySnapshot).mockResolvedValue({ ...BASE_COST });
  vi.mocked(resolveVolumeAuthoritySnapshot).mockResolvedValue({ ...EMPTY_VOLUME, channelActionsToday: {} });
  vi.mocked(resolvePeriodAutonomousSpend).mockResolvedValue(0);
  vi.mocked(resolveProviderCapabilitySnapshot).mockResolvedValue({ bindingVerified: true, capabilityAvailable: true });
  vi.mocked(resolveProviderRateSnapshot).mockResolvedValue({ rateLimited: false, rateLimitReason: null });
});

describe("E8 policy acceptance", () => {
  it("1. low-risk allowed autonomous reply", async () => {
    await seedPolicy(USER_A, 10);
    const caller = policyRouter.createCaller(buildCtx(USER_A));
    const { decision, approvalRequestId } = await caller.evaluateActionRequest(actionRequest() as never);
    expect(decision.decision).toBe("ALLOW_AUTONOMOUS");
    expect(decision.riskClass).toBe("low");
    expect(decision.billingIdentity).toMatch(/^bill_/);
    expect(approvalRequestId).toBeNull();
  });

  it("2. medium-risk approval requirement", async () => {
    await seedPolicy(USER_A, 10);
    const caller = policyRouter.createCaller(buildCtx(USER_A));
    const { decision, approvalRequestId } = await caller.evaluateActionRequest(
      actionRequest({
        intelligence: { ...PRAISE_INTEL, intentClass: "product_objection", confidence: 0.9 },
      }) as never
    );
    expect(decision.decision).toBe("REQUIRE_APPROVAL");
    expect(decision.approvalRequired).toBe(true);
    expect(approvalRequestId).not.toBeNull();
    const approval = fakeDb._tables.approval_requests.find((r: any) => r.id === approvalRequestId);
    expect(approval.approvalType).toBe("marketing_action");
    expect(approval.context.marketingActionBinding.mode).toBe("approval");
  });

  it("3. high-risk escalation", async () => {
    await seedPolicy(USER_A, 10);
    const caller = policyRouter.createCaller(buildCtx(USER_A));
    const { decision, approvalRequestId } = await caller.evaluateActionRequest(
      actionRequest({ intelligence: { ...PRAISE_INTEL, intentClass: "severe_complaint" } }) as never
    );
    expect(decision.decision).toBe("ESCALATE");
    const approval = fakeDb._tables.approval_requests.find((r: any) => r.id === approvalRequestId);
    expect(approval.context.marketingActionBinding.mode).toBe("escalation");
  });

  it("4. prohibited action denied", async () => {
    await seedPolicy(USER_A, 10);
    const caller = policyRouter.createCaller(buildCtx(USER_A));
    const { decision } = await caller.evaluateActionRequest(
      actionRequest({
        actionRequestId: "ar1:n-1",
        actionType: "nurture_candidate",
        estimatedCostClass: "standard",
        intelligence: { ...PRAISE_INTEL, intentClass: "product_objection", confidence: 0.9 },
      }) as never
    );
    expect(decision.decision).toBe("DENY");
    expect(decision.reasonCodes).toContain("ACTION_PROHIBITED_BY_POLICY");
  });

  it("5. missing policy fails closed", async () => {
    const caller = policyRouter.createCaller(buildCtx(USER_A));
    const { decision } = await caller.evaluateActionRequest(actionRequest() as never);
    expect(decision.decision).toBe("DENY");
    expect(decision.reasonCodes).toEqual(["POLICY_MISSING"]);
    expect(decision.policyVersion).toBeNull();
  });

  it("6. unknown action type fails closed (boundary and engine)", async () => {
    await seedPolicy(USER_A, 10);
    const caller = policyRouter.createCaller(buildCtx(USER_A));
    await expect(
      caller.evaluateActionRequest(actionRequest({ actionType: "launch_rockets" }) as never)
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("7. unsupported provider denied", async () => {
    await seedPolicy(USER_A, 10);
    vi.mocked(resolveProviderCapabilitySnapshot).mockResolvedValue({ bindingVerified: false, capabilityAvailable: false });
    const caller = policyRouter.createCaller(buildCtx(USER_A));
    const { decision } = await caller.evaluateActionRequest(actionRequest() as never);
    expect(decision.decision).toBe("DENY");
    expect(decision.reasonCodes).toContain("PROVIDER_BINDING_MISMATCH");
  });

  it("8. cross-business request rejected (ownership)", async () => {
    await seedPolicy(USER_A, 10);
    const callerA = policyRouter.createCaller(buildCtx(USER_A));
    // User B cannot act on business 10.
    const callerB = policyRouter.createCaller(buildCtx(USER_B));
    await expect(callerB.evaluateActionRequest(actionRequest() as never)).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Campaign from a different business fails closed.
    await expect(
      callerA.evaluateActionRequest(actionRequest({ campaignId: 56 }) as never)
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Cross-tenant decision reads are NOT_FOUND.
    const { decision } = await callerA.evaluateActionRequest(actionRequest() as never);
    await expect(callerB.getDecision({ policyDecisionId: decision.policyDecisionId } as never)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("9. forged risk rejected", async () => {
    await seedPolicy(USER_A, 10);
    const caller = policyRouter.createCaller(buildCtx(USER_A));
    await expect(
      caller.evaluateActionRequest(
        actionRequest({ intelligence: { ...PRAISE_INTEL, riskLevel: "low" } }) as never
      )
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("10. forged approval/decision fields rejected", async () => {
    await seedPolicy(USER_A, 10);
    const caller = policyRouter.createCaller(buildCtx(USER_A));
    for (const forged of [{ decision: "ALLOW_AUTONOMOUS" }, { approvalStatus: "approved" }, { authorized: true }]) {
      await expect(caller.evaluateActionRequest(actionRequest(forged) as never)).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    }
  });

  it("11. stale policy version rejected at the execution gate", async () => {
    const policyV1 = await seedPolicy(USER_A, 10);
    const caller = policyRouter.createCaller(buildCtx(USER_A));
    const { decision } = await caller.evaluateActionRequest(actionRequest() as never);
    // Policy changes to v2; the v1 decision is stale authority.
    await caller.setPolicy({
      businessId: 10,
      config: { ...AUTONOMOUS_POLICY_CONFIG, volume: { maxActionsPerDay: 60, maxActionsPerChannelPerDay: 20 } } as Record<string, unknown>,
    });
    const verdict = assertMarketingActionExecutable({
      decision,
      approval: null,
      currentPolicyVersion: (await caller.getPolicy({ businessId: 10 })).policy!.policyVersion,
      now: "2026-06-28T12:05:00.000Z",
    });
    expect(verdict.executable).toBe(false);
    expect(verdict).toMatchObject({ reason: "STALE_POLICY_VERSION" });
    expect(policyV1.policyVersion).not.toBe((await caller.getPolicy({ businessId: 10 })).policy!.policyVersion);
  });

  it("12. duplicate policy evaluation converges", async () => {
    await seedPolicy(USER_A, 10);
    const caller = policyRouter.createCaller(buildCtx(USER_A));
    const first = await caller.evaluateActionRequest(actionRequest() as never);
    const second = await caller.evaluateActionRequest(actionRequest() as never);
    expect(second.decision.policyDecisionId).toBe(first.decision.policyDecisionId);
    expect(second.duplicateClassification).toBe("idempotent_replay");
    expect(fakeDb._tables.policy_decisions).toHaveLength(1);
  });

  it("13. concurrent evaluation converges", async () => {
    await seedPolicy(USER_A, 10);
    const caller = policyRouter.createCaller(buildCtx(USER_A));
    const [a, b] = await Promise.all([
      caller.evaluateActionRequest(actionRequest() as never),
      caller.evaluateActionRequest(actionRequest() as never),
    ]);
    expect(a.decision.policyDecisionId).toBe(b.decision.policyDecisionId);
    expect(fakeDb._tables.policy_decisions).toHaveLength(1);
    expect(fakeDb._tables.approval_requests).toHaveLength(0);
  });

  it("14. budget exhausted denies", async () => {
    await seedPolicy(USER_A, 10);
    vi.mocked(resolveCostAuthoritySnapshot).mockResolvedValue({ ...BASE_COST, walletBalance: 0 });
    const caller = policyRouter.createCaller(buildCtx(USER_A));
    const { decision } = await caller.evaluateActionRequest(actionRequest() as never);
    expect(decision.decision).toBe("DENY");
    expect(decision.reasonCodes).toContain("BUDGET_INSUFFICIENT_BALANCE");
  });

  it("15. quota exhausted denies", async () => {
    await seedPolicy(USER_A, 10);
    vi.mocked(resolveVolumeAuthoritySnapshot).mockResolvedValue({ actionsExecutedToday: 50, channelActionsToday: {} });
    const caller = policyRouter.createCaller(buildCtx(USER_A));
    const { decision } = await caller.evaluateActionRequest(actionRequest() as never);
    expect(decision.decision).toBe("DENY");
    expect(decision.reasonCodes).toContain("QUOTA_DAILY_ACTION_CAP");
  });

  it("16. rate limit reached denies", async () => {
    await seedPolicy(USER_A, 10);
    vi.mocked(resolveProviderRateSnapshot).mockResolvedValue({ rateLimited: true, rateLimitReason: "429" });
    const caller = policyRouter.createCaller(buildCtx(USER_A));
    const { decision } = await caller.evaluateActionRequest(actionRequest() as never);
    expect(decision.decision).toBe("DENY");
    expect(decision.reasonCodes).toContain("RATE_LIMIT_PROVIDER");
  });

  it("17. denied action is non-billable", async () => {
    await seedPolicy(USER_A, 10);
    vi.mocked(resolveCostAuthoritySnapshot).mockResolvedValue({ ...BASE_COST, walletBalance: 0 });
    const caller = policyRouter.createCaller(buildCtx(USER_A));
    const { decision } = await caller.evaluateActionRequest(actionRequest() as never);
    expect(decision.decision).toBe("DENY");
    expect(decision.billingIdentity).toBeNull();
    expect(decision.estimatedCredits).toBe(0);
    // No charge records exist anywhere.
    expect(fakeDb._tables.audit_events.filter((e: any) => e.eventType === "billing_deduction")).toHaveLength(0);
  });

  it("18. approved billable action is exact-once", async () => {
    await seedPolicy(USER_A, 10);
    const caller = policyRouter.createCaller(buildCtx(USER_A));
    const { decision, approvalRequestId } = await caller.evaluateActionRequest(
      actionRequest({ intelligence: { ...PRAISE_INTEL, intentClass: "product_objection", confidence: 0.9 } }) as never
    );
    const approvalCaller = approvalRouter.createCaller(buildCtx(USER_A));
    const approved = await approvalCaller.approveAction({ approvalId: approvalRequestId! } as never);
    expect(approved.success).toBe(true);
    // Duplicate callback: already terminal, no duplicated effect.
    await expect(approvalCaller.approveAction({ approvalId: approvalRequestId! } as never)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    // Stable billing identity across the decision and the approval binding.
    const approval = fakeDb._tables.approval_requests.find((r: any) => r.id === approvalRequestId);
    expect(approval.context.marketingActionBinding.billingIdentity).toBe(decision.billingIdentity);
    // Exactly one billing identity for the logical action.
    const identities = new Set(fakeDb._tables.policy_decisions.map((d: any) => d.billingIdentity));
    expect(identities.size).toBe(1);
  });

  it("19. prompt-injection content cannot alter policy", async () => {
    await seedPolicy(USER_A, 10);
    const caller = policyRouter.createCaller(buildCtx(USER_A));
    const { decision } = await caller.evaluateActionRequest(
      actionRequest({
        contextVersion: "ctx:evil",
        intelligence: { ...PRAISE_INTEL, injectionSuspected: true },
      }) as never
    );
    // Injection can only reduce autonomy, never widen it.
    expect(decision.decision).not.toBe("ALLOW_AUTONOMOUS");
    expect(decision.riskClass).toBe("high");
    expect(decision.reasonCodes).toContain("INJECTION_SUSPECTED");
    // The request schema has no content channel: no instruction-bearing field
    // reaches the engine (strict boundary proved by case 10).
  });

  it("20. policy change creates a new versioned decision", async () => {
    await seedPolicy(USER_A, 10);
    const caller = policyRouter.createCaller(buildCtx(USER_A));
    const v1 = await caller.evaluateActionRequest(actionRequest() as never);
    await caller.setPolicy({
      businessId: 10,
      config: { ...AUTONOMOUS_POLICY_CONFIG, volume: { maxActionsPerDay: 60, maxActionsPerChannelPerDay: 20 } } as Record<string, unknown>,
    });
    const v2 = await caller.evaluateActionRequest(actionRequest() as never);
    expect(v2.decision.policyDecisionId).not.toBe(v1.decision.policyDecisionId);
    expect(v2.decision.policyVersion).not.toBe(v1.decision.policyVersion);
    expect(fakeDb._tables.policy_decisions).toHaveLength(2);
  });

  it("21. stale approval after policy change fails closed", async () => {
    await seedPolicy(USER_A, 10);
    const caller = policyRouter.createCaller(buildCtx(USER_A));
    const { approvalRequestId } = await caller.evaluateActionRequest(
      actionRequest({ intelligence: { ...PRAISE_INTEL, intentClass: "product_objection", confidence: 0.9 } }) as never
    );
    await caller.setPolicy({
      businessId: 10,
      config: { ...AUTONOMOUS_POLICY_CONFIG, volume: { maxActionsPerDay: 60, maxActionsPerChannelPerDay: 20 } } as Record<string, unknown>,
    });
    const approvalCaller = approvalRouter.createCaller(buildCtx(USER_A));
    await expect(approvalCaller.approveAction({ approvalId: approvalRequestId! } as never)).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    // The approval remains pending — never silently resolved.
    const approval = fakeDb._tables.approval_requests.find((r: any) => r.id === approvalRequestId);
    expect(approval.status).toBe("pending");
  });

  it("22. action cap enforced per channel", async () => {
    await seedPolicy(USER_A, 10);
    vi.mocked(resolveVolumeAuthoritySnapshot).mockResolvedValue({
      actionsExecutedToday: 0,
      channelActionsToday: { instagram: 20 },
    });
    const caller = policyRouter.createCaller(buildCtx(USER_A));
    const { decision } = await caller.evaluateActionRequest(actionRequest() as never);
    expect(decision.decision).toBe("DENY");
    expect(decision.reasonCodes).toContain("QUOTA_CHANNEL_DAILY_CAP");
  });

  it("23. escalation creates operator-visible blocker state", async () => {
    await seedPolicy(USER_A, 10);
    const caller = policyRouter.createCaller(buildCtx(USER_A));
    const { approvalRequestId } = await caller.evaluateActionRequest(
      actionRequest({ intelligence: { ...PRAISE_INTEL, intentClass: "severe_complaint" } }) as never
    );
    const approval = fakeDb._tables.approval_requests.find((r: any) => r.id === approvalRequestId);
    expect(approval).toBeDefined();
    expect(approval.riskLevel).toBe("high");
    expect(approval.status).toBe("pending");
    expect(approval.title).toMatch(/Escalated Marketing Action/);
    // Operator (admin) can see it.
    const adminCaller = policyRouter.createCaller(buildCtx(ADMIN));
    const rows = await adminCaller.adminListDecisions({ decision: "ESCALATE" } as never);
    expect(rows.length).toBe(1);
  });

  it("24. audit evidence contains no sensitive data", async () => {
    await seedPolicy(USER_A, 10);
    const caller = policyRouter.createCaller(buildCtx(USER_A));
    await caller.evaluateActionRequest(
      actionRequest({ intelligence: { ...PRAISE_INTEL, intentClass: "product_objection", confidence: 0.9 } }) as never
    );
    const events = fakeDb._tables.audit_events.filter((e: any) => e.eventType === "policy_decision");
    expect(events.length).toBe(1);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toMatch(/password|token|secret|credential|api[-_]?key|accessToken/i);
    expect(serialized).not.toMatch(/messageText|rawContent|socialText/i);
    const md = events[0].metadata;
    expect(md.reasonCodes).toBeDefined();
    expect(md.policyVersion).toBeDefined();
    expect(md.thresholds).toBeDefined();
    // No chain-of-thought style reasoning: only codes + bounded fields.
    expect(Object.keys(md)).not.toContain("reasoning");
  });
});
