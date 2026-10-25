import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "./queries/connection";
import { createFakeDb, buildCtx } from "./r5-test-support";
import { leadGovernanceRouter } from "./lead-governance-router";

vi.mock("./queries/connection", () => ({
  getDb: vi.fn(() => {
    throw new Error("getDb must not fall back to a real connection in R6-F lead governance tests");
  }),
}));

vi.mock("./lib/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
}));

const ADMIN = { id: 7, role: "admin" };
const USER = { id: 9, role: "user" };
const NOW = new Date("2026-06-28T12:00:00.000Z");

type Seed = Record<string, Record<string, unknown>[]>;

function leadRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 5,
    userId: 7,
    businessId: 10,
    campaignId: 101,
    name: "Canary RealName",
    email: "canary.real@example.com",
    phone: "+1555CANARY",
    company: "Canary Corp",
    status: "new",
    score: 0,
    createdAt: NOW,
    updatedAt: NOW,
    lastContact: null,
    nextFollowUp: null,
    ...overrides,
  };
}

function privacyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    leadId: 5,
    userId: 7,
    businessId: 10,
    privacyState: "ACTIVE",
    previousState: null,
    reason: null,
    retentionDeadlineAt: null,
    source: "operator",
    actorUserId: 7,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function baseSeed(): Seed {
  return {
    businesses: [{ id: 10, userId: 7, name: "Acme" }],
    leads: [leadRow()],
    lead_activities: [],
    lead_privacy_states: [],
    audit_events: [],
  };
}

function useSeed(seed: Seed) {
  const fake = createFakeDb(seed);
  vi.mocked(fake.db.execute).mockResolvedValue([[{ c: 1 }]] as never);
  vi.mocked(getDb).mockReturnValue(fake.db as never);
  return fake;
}

const PII_CANARIES = ["canary.real@example.com", "+1555CANARY", "Canary RealName", "Canary Corp"];

describe("leadGovernance router (F3/F5/F7)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("authorization", () => {
    it("unauthenticated operator is rejected", async () => {
      const fake = useSeed(baseSeed());
      const caller = leadGovernanceRouter.createCaller(buildCtx(null));
      await expect(caller.getLeadOperations({ leadId: 5 })).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });
      expect(fake.seed.audit_events).toHaveLength(0);
    });

    it("non-admin user is rejected on every procedure", async () => {
      useSeed(baseSeed());
      const caller = leadGovernanceRouter.createCaller(buildCtx(USER));
      await expect(caller.getLeadOperations({ leadId: 5 })).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      await expect(caller.listLeadOperationalStates({ businessId: 10 })).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      await expect(caller.getLeadGovernanceSummary()).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      await expect(
        caller.setPrivacyState({ leadId: 5, targetState: "SUPPRESSED", reason: "x" })
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("verified admin can read (operator visibility by design)", async () => {
      useSeed(baseSeed());
      const caller = leadGovernanceRouter.createCaller(buildCtx(ADMIN));
      const projection = await caller.getLeadOperations({ leadId: 5 });
      expect(projection.health).toBe("HEALTHY");
      expect(projection.crmStatus).toBe("new");
    });
  });

  describe("operator reads (F5)", () => {
    it("answers the ten operator questions for a healthy lead", async () => {
      useSeed(baseSeed());
      const caller = leadGovernanceRouter.createCaller(buildCtx(ADMIN));
      const p = await caller.getLeadOperations({ leadId: 5 });
      // 1 state / 2 identity / 3 scoring / 4 qualification / 5 nurture /
      // 6 handoff / 7 conversion / 8 privacy / 9 blocker / 10 next action
      expect(p.health).toBe("HEALTHY");
      expect(p.identity.supported).toBe(false);
      expect(p.scoring.supported).toBe(false);
      expect(p.scoring.legacyScore).toBe(0);
      expect(p.qualification.supported).toBe(false);
      expect(p.nurture.allowed).toBe(true);
      expect(p.salesHandoff.supported).toBe(false);
      expect(p.conversion.supported).toBe(false);
      expect(p.privacy.status).toBe("ACTIVE");
      expect(p.blockers).toHaveLength(0);
      expect(p.safeNextAction).toBe("none");
      expect(p.operatorActionRequired).toBe(false);
    });

    it("suppressed lead shows the privacy blocker and nurture gate closed", async () => {
      const seed = baseSeed();
      seed.lead_privacy_states.push(privacyRow({ privacyState: "SUPPRESSED", reason: "opt-out" }));
      useSeed(seed);
      const caller = leadGovernanceRouter.createCaller(buildCtx(ADMIN));
      const p = await caller.getLeadOperations({ leadId: 5 });
      expect(p.health).toBe("BLOCKED_OPERATOR");
      expect(p.privacy.status).toBe("SUPPRESSED");
      expect(p.suppression.suppressed).toBe(true);
      expect(p.nurture.allowed).toBe(false);
      expect(p.nurture.blockedByPrivacy).toBe(true);
      expect(p.blockers[0]).toMatchObject({
        blockerClass: "PRIVACY_SUPPRESSED",
        recoveryClass: "GOVERNANCE_APPROVAL",
      });
      expect(p.operatorActionRequired).toBe(true);
      expect(p.safeNextAction).toBe("review_privacy_suppression");
    });

    it("retention-expired lead shows the disposition blocker", async () => {
      const seed = baseSeed();
      seed.lead_privacy_states.push(
        privacyRow({ privacyState: "RETENTION_EXPIRED", previousState: "RETENTION_PENDING" })
      );
      useSeed(seed);
      const caller = leadGovernanceRouter.createCaller(buildCtx(ADMIN));
      const p = await caller.getLeadOperations({ leadId: 5 });
      expect(p.health).toBe("BLOCKED_OPERATOR");
      expect(p.blockers[0]).toMatchObject({
        blockerClass: "RETENTION_EXPIRED",
        recoveryClass: "OPERATOR_ACTION",
        safeNextAction: "dispose_retention_expired",
      });
    });

    it("missing lead ⇒ bounded NOT_FOUND", async () => {
      useSeed(baseSeed());
      const caller = leadGovernanceRouter.createCaller(buildCtx(ADMIN));
      await expect(caller.getLeadOperations({ leadId: 9999 })).rejects.toMatchObject({
        code: "NOT_FOUND",
        message: "lead not found",
      });
    });

    it("business listing scopes to the business and filters by health", async () => {
      const seed = baseSeed();
      seed.leads.push(leadRow({ id: 6, businessId: 10, status: "contacted" }));
      seed.lead_privacy_states.push(privacyRow({ id: 2, leadId: 6, privacyState: "SUPPRESSED" }));
      useSeed(seed);
      const caller = leadGovernanceRouter.createCaller(buildCtx(ADMIN));
      const all = await caller.listLeadOperationalStates({ businessId: 10 });
      expect(all.total).toBe(2);
      const blocked = await caller.listLeadOperationalStates({ businessId: 10, health: "BLOCKED_OPERATOR" });
      expect(blocked.total).toBe(1);
      expect(blocked.items[0].leadId).toBe(6);
      await expect(caller.listLeadOperationalStates({ businessId: 9999 })).rejects.toMatchObject({
        code: "NOT_FOUND",
        message: "business not found",
      });
    });

    it("summary rollups per business with minimized fields", async () => {
      const seed = baseSeed();
      seed.lead_privacy_states.push(privacyRow({ privacyState: "SUPPRESSED" }));
      useSeed(seed);
      const caller = leadGovernanceRouter.createCaller(buildCtx(ADMIN));
      const summary = await caller.getLeadGovernanceSummary();
      expect(summary.leadsEvaluated).toBe(1);
      expect(summary.byPrivacyState.SUPPRESSED).toBe(1);
      expect(summary.byHealth.BLOCKED_OPERATOR).toBe(1);
    });
  });

  describe("governed privacy mutations (F3/F6/F7)", () => {
    it("setPrivacyState transitions and writes exactly one audit event", async () => {
      const fake = useSeed(baseSeed());
      const caller = leadGovernanceRouter.createCaller(buildCtx(ADMIN));
      const result = await caller.setPrivacyState({
        leadId: 5,
        targetState: "SUPPRESSED",
        reason: "lead requested no contact",
      });
      expect(result).toMatchObject({ outcome: "transitioned", before: "ACTIVE", after: "SUPPRESSED" });
      expect(fake.seed.lead_privacy_states).toHaveLength(1);
      expect(fake.seed.audit_events).toHaveLength(1);
      expect(fake.seed.audit_events[0]).toMatchObject({
        eventType: "admin_mutation",
        userId: ADMIN.id,
        outcome: "succeeded",
        businessId: 10,
      });
      expect(fake.seed.audit_events[0].metadata).toMatchObject({
        action: "admin.lead_privacy_state_changed",
        targetType: "lead_privacy_state",
        targetId: 5,
        before: "ACTIVE",
        after: "SUPPRESSED",
      });
    });

    it("duplicate transition converges with zero additional audit events", async () => {
      const fake = useSeed(baseSeed());
      const caller = leadGovernanceRouter.createCaller(buildCtx(ADMIN));
      await caller.setPrivacyState({ leadId: 5, targetState: "SUPPRESSED", reason: "opt-out" });
      const again = await caller.setPrivacyState({ leadId: 5, targetState: "SUPPRESSED", reason: "opt-out" });
      expect(again.outcome).toBe("already_applied");
      expect(fake.seed.lead_privacy_states).toHaveLength(1);
      expect(fake.seed.audit_events).toHaveLength(1);
    });

    it("stale expectedStatus is rejected with CONFLICT", async () => {
      useSeed(baseSeed());
      const caller = leadGovernanceRouter.createCaller(buildCtx(ADMIN));
      await expect(
        caller.setPrivacyState({
          leadId: 5,
          targetState: "SUPPRESSED",
          reason: "opt-out",
          expectedStatus: "SUPPRESSED",
        })
      ).rejects.toMatchObject({
        code: "CONFLICT",
        message: "stale privacy state: expected SUPPRESSED, current ACTIVE",
      });
    });

    it("governance reason is required for suppression-class targets", async () => {
      useSeed(baseSeed());
      const caller = leadGovernanceRouter.createCaller(buildCtx(ADMIN));
      await expect(
        caller.setPrivacyState({ leadId: 5, targetState: "SUPPRESSED" })
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });

    it("forbidden transitions are rejected and terminal ARCHIVED cannot reopen", async () => {
      const seed = baseSeed();
      seed.lead_privacy_states.push(privacyRow({ privacyState: "ARCHIVED" }));
      useSeed(seed);
      const caller = leadGovernanceRouter.createCaller(buildCtx(ADMIN));
      await expect(
        caller.setPrivacyState({ leadId: 5, targetState: "ACTIVE", reason: "trying to reopen" })
      ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    });

    it("audit failure rolls back the mutation (no unaudited mutation persists)", async () => {
      const seed = baseSeed();
      const fake = createFakeDb(seed, { failAuditInsert: new Error("audit ledger unavailable") });
      vi.mocked(fake.db.execute).mockResolvedValue([[{ c: 1 }]] as never);
      vi.mocked(getDb).mockReturnValue(fake.db as never);
      const caller = leadGovernanceRouter.createCaller(buildCtx(ADMIN));
      await expect(
        caller.setPrivacyState({ leadId: 5, targetState: "SUPPRESSED", reason: "opt-out" })
      ).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
      expect(fake.seed.lead_privacy_states).toHaveLength(0);
      expect(fake.seed.audit_events).toHaveLength(0);
    });

    it("schema-absent environment fails closed with an honest error", async () => {
      const seed = baseSeed();
      const fake = createFakeDb(seed);
      vi.mocked(fake.db.execute).mockResolvedValue([[{ c: 0 }]] as never);
      vi.mocked(getDb).mockReturnValue(fake.db as never);
      const caller = leadGovernanceRouter.createCaller(buildCtx(ADMIN));
      await expect(
        caller.setPrivacyState({ leadId: 5, targetState: "SUPPRESSED", reason: "opt-out" })
      ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
      expect(fake.seed.lead_privacy_states).toHaveLength(0);
    });
  });

  describe("sensitive-data containment", () => {
    it("no PII canary appears in projections, listings or audit metadata", async () => {
      const seed = baseSeed();
      seed.lead_privacy_states.push(privacyRow({ privacyState: "SUPPRESSED" }));
      const fake = useSeed(seed);
      const caller = leadGovernanceRouter.createCaller(buildCtx(ADMIN));
      const p = await caller.getLeadOperations({ leadId: 5 });
      const listing = await caller.listLeadOperationalStates({ businessId: 10 });
      await caller.setPrivacyState({ leadId: 5, targetState: "ARCHIVED", reason: "dispose" });
      const haystacks = [JSON.stringify(p), JSON.stringify(listing), JSON.stringify(fake.seed.audit_events)];
      for (const canary of PII_CANARIES) {
        for (const text of haystacks) {
          expect(text).not.toContain(canary);
        }
      }
      // No secret-shaped fields either.
      for (const text of haystacks) {
        expect(text).not.toMatch(/accessToken|refreshToken|password|secret|Bearer|contentText/i);
      }
    });
  });

  describe("forbidden authority surface", () => {
    it("no force-merge / force-score / force-qualify / force-convert / generic state setter exists", () => {
      const procedures = Object.keys((leadGovernanceRouter as any)._def.procedures);
      expect(procedures.sort()).toEqual(
        [
          "getLeadGovernanceSummary",
          "getLeadOperations",
          "listLeadOperationalStates",
          "retryOperation",
          "setPrivacyState",
        ].sort()
      );
      for (const name of procedures) {
        expect(name).not.toMatch(/force|override|merge|score|qualify|convert|setStatus|setState/i);
      }
    });
  });
});
