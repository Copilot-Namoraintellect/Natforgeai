import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "../../r5-test-support";
import {
  isLeadPrivacyTransitionAllowed,
  leadPrivacyGateFor,
  sweepLeadRetention,
  transitionLeadPrivacyState,
  LeadPrivacyGovernanceError,
  LEAD_PRIVACY_STATES,
  LEAD_PRIVACY_TRANSITIONS,
} from "./lead-privacy-store";

const NOW = new Date("2026-06-28T12:00:00.000Z");
const FUTURE = new Date("2026-07-28T12:00:00.000Z");
const PAST = new Date("2026-06-01T12:00:00.000Z");

type Seed = Record<string, Record<string, unknown>[]>;

function seedWithPrivacy(rows: Record<string, unknown>[] = []): Seed {
  return { lead_privacy_states: rows.map((r) => ({ ...r })) };
}

function tablePresent(fake: ReturnType<typeof createFakeDb>) {
  vi.mocked(fake.db.execute).mockResolvedValue([[{ c: 1 }]] as never);
}

function tableAbsent(fake: ReturnType<typeof createFakeDb>) {
  vi.mocked(fake.db.execute).mockResolvedValue([[{ c: 0 }]] as never);
}

describe("lead privacy governance store (F3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("schema guard (unexecuted migration)", () => {
    it("reads degrade to unavailable when the table is absent", async () => {
      const fake = createFakeDb(seedWithPrivacy());
      tableAbsent(fake);
      const { readLeadPrivacyEvidence } = await import("./lead-privacy-store");
      const evidence = await readLeadPrivacyEvidence(fake.db as never, 5);
      expect(evidence.available).toBe(false);
      expect(evidence.reason).toBe("privacy_table_absent");
      expect(evidence.state).toBe("ACTIVE");
    });

    it("mutations fail closed when the table is absent", async () => {
      const fake = createFakeDb(seedWithPrivacy());
      tableAbsent(fake);
      await expect(
        transitionLeadPrivacyState(fake.db as never, {
          leadId: 5,
          userId: 7,
          businessId: 10,
          targetState: "SUPPRESSED",
          reason: "operator request",
          source: "operator",
          actorUserId: 7,
          now: NOW,
        })
      ).rejects.toMatchObject({ code: "LEAD_PRIVACY_SCHEMA_UNAVAILABLE" });
      await expect(
        sweepLeadRetention(fake.db as never, { businessId: 10, now: NOW })
      ).rejects.toMatchObject({ code: "LEAD_PRIVACY_SCHEMA_UNAVAILABLE" });
    });
  });

  describe("transitions", () => {
    it("no row ⇒ implicit ACTIVE; first transition inserts with provenance", async () => {
      const fake = createFakeDb(seedWithPrivacy());
      tablePresent(fake);
      const result = await transitionLeadPrivacyState(fake.db as never, {
        leadId: 5,
        userId: 7,
        businessId: 10,
        targetState: "SUPPRESSED",
        reason: "lead requested no contact",
        source: "operator",
        actorUserId: 7,
        now: NOW,
      });
      expect(result).toMatchObject({ outcome: "transitioned", before: "ACTIVE", after: "SUPPRESSED" });
      expect(fake.seed.lead_privacy_states).toHaveLength(1);
      expect(fake.seed.lead_privacy_states[0]).toMatchObject({
        leadId: 5,
        userId: 7,
        businessId: 10,
        privacyState: "SUPPRESSED",
        previousState: "ACTIVE",
        actorUserId: 7,
      });
    });

    it("duplicate transition converges to already_applied without writing", async () => {
      const fake = createFakeDb(seedWithPrivacy());
      tablePresent(fake);
      const input = {
        leadId: 5, userId: 7, businessId: 10,
        targetState: "SUPPRESSED" as const,
        reason: "dup", source: "operator", actorUserId: 7, now: NOW,
      };
      await transitionLeadPrivacyState(fake.db as never, input);
      const again = await transitionLeadPrivacyState(fake.db as never, input);
      expect(again.outcome).toBe("already_applied");
      expect(fake.seed.lead_privacy_states).toHaveLength(1);
    });

    it("forbidden and terminal transitions are rejected", async () => {
      const fake = createFakeDb(
        seedWithPrivacy([
          { leadId: 5, userId: 7, businessId: 10, privacyState: "RETENTION_EXPIRED" },
        ])
      );
      tablePresent(fake);
      await expect(
        transitionLeadPrivacyState(fake.db as never, {
          leadId: 5, userId: 7, businessId: 10,
          targetState: "ACTIVE", source: "operator", actorUserId: 7, now: NOW,
        })
      ).rejects.toMatchObject({ code: "LEAD_PRIVACY_TRANSITION_FORBIDDEN" });

      const fake2 = createFakeDb(
        seedWithPrivacy([{ leadId: 6, userId: 7, businessId: 10, privacyState: "ARCHIVED" }])
      );
      tablePresent(fake2);
      await expect(
        transitionLeadPrivacyState(fake2.db as never, {
          leadId: 6, userId: 7, businessId: 10,
          targetState: "ACTIVE", source: "operator", actorUserId: 7, now: NOW,
        })
      ).rejects.toMatchObject({ code: "LEAD_PRIVACY_TRANSITION_FORBIDDEN" });
    });

    it("concurrent first-writer-wins: raced insert converges without a second row", async () => {
      const fake = createFakeDb(seedWithPrivacy());
      tablePresent(fake);
      const base = {
        leadId: 5, userId: 7, businessId: 10,
        reason: "race", source: "operator", actorUserId: 7, now: NOW,
      };
      const [a, b] = await Promise.all([
        transitionLeadPrivacyState(fake.db as never, { ...base, targetState: "SUPPRESSED" }),
        transitionLeadPrivacyState(fake.db as never, { ...base, targetState: "SUPPRESSED" }),
      ]);
      expect(fake.seed.lead_privacy_states).toHaveLength(1);
      expect(fake.seed.lead_privacy_states[0]).toMatchObject({ privacyState: "SUPPRESSED" });
      const outcomes = [a.outcome, b.outcome].sort();
      expect(outcomes).toEqual(["already_applied", "transitioned"]);
    });

    it("RETENTION_PENDING requires a future deadline", async () => {
      const fake = createFakeDb(seedWithPrivacy());
      tablePresent(fake);
      await expect(
        transitionLeadPrivacyState(fake.db as never, {
          leadId: 5, userId: 7, businessId: 10,
          targetState: "RETENTION_PENDING", source: "operator", actorUserId: 7, now: NOW,
        })
      ).rejects.toMatchObject({ code: "LEAD_PRIVACY_VALIDATION" });
      await expect(
        transitionLeadPrivacyState(fake.db as never, {
          leadId: 5, userId: 7, businessId: 10,
          targetState: "RETENTION_PENDING", retentionDeadlineAt: PAST,
          source: "operator", actorUserId: 7, now: NOW,
        })
      ).rejects.toMatchObject({ code: "LEAD_PRIVACY_VALIDATION" });
      const ok = await transitionLeadPrivacyState(fake.db as never, {
        leadId: 5, userId: 7, businessId: 10,
        targetState: "RETENTION_PENDING", retentionDeadlineAt: FUTURE,
        source: "operator", actorUserId: 7, now: NOW,
      });
      expect(ok.outcome).toBe("transitioned");
      expect(fake.seed.lead_privacy_states[0]).toMatchObject({
        privacyState: "RETENTION_PENDING",
        retentionDeadlineAt: FUTURE,
      });
    });

    it("leaving pending clears the deadline", async () => {
      const fake = createFakeDb(
        seedWithPrivacy([
          { leadId: 5, userId: 7, businessId: 10, privacyState: "RETENTION_PENDING", retentionDeadlineAt: FUTURE },
        ])
      );
      tablePresent(fake);
      const result = await transitionLeadPrivacyState(fake.db as never, {
        leadId: 5, userId: 7, businessId: 10,
        targetState: "ACTIVE", source: "operator", actorUserId: 7, now: NOW,
      });
      expect(result.outcome).toBe("transitioned");
      expect(fake.seed.lead_privacy_states[0]).toMatchObject({
        privacyState: "ACTIVE",
        retentionDeadlineAt: null,
        previousState: "RETENTION_PENDING",
      });
    });
  });

  describe("retention sweep (F6 deterministic reconciliation)", () => {
    it("expires only due RETENTION_PENDING leads for the bound business", async () => {
      const fake = createFakeDb(
        seedWithPrivacy([
          { leadId: 1, userId: 7, businessId: 10, privacyState: "RETENTION_PENDING", retentionDeadlineAt: PAST },
          { leadId: 2, userId: 7, businessId: 10, privacyState: "RETENTION_PENDING", retentionDeadlineAt: FUTURE },
          { leadId: 3, userId: 7, businessId: 10, privacyState: "ACTIVE" },
          { leadId: 4, userId: 8, businessId: 99, privacyState: "RETENTION_PENDING", retentionDeadlineAt: PAST },
        ])
      );
      tablePresent(fake);
      const result = await sweepLeadRetention(fake.db as never, { businessId: 10, now: NOW });
      expect(result).toMatchObject({ evaluatedCount: 2, expiredCount: 1, converged: false });
      const row = (id: number) => fake.seed.lead_privacy_states.find((r) => r.leadId === id);
      expect(row(1)).toMatchObject({ privacyState: "RETENTION_EXPIRED", previousState: "RETENTION_PENDING" });
      expect(row(2)).toMatchObject({ privacyState: "RETENTION_PENDING" });
      expect(row(4)).toMatchObject({ privacyState: "RETENTION_PENDING" });
    });

    it("re-run converges with zero expirations", async () => {
      const fake = createFakeDb(
        seedWithPrivacy([
          { leadId: 1, userId: 7, businessId: 10, privacyState: "RETENTION_PENDING", retentionDeadlineAt: PAST },
        ])
      );
      tablePresent(fake);
      await sweepLeadRetention(fake.db as never, { businessId: 10, now: NOW });
      const again = await sweepLeadRetention(fake.db as never, { businessId: 10, now: NOW });
      expect(again).toMatchObject({ evaluatedCount: 0, expiredCount: 0, converged: true });
    });
  });

  describe("privacy gate", () => {
    it("suppressed / restricted / expired / archived leads are not actionable", () => {
      for (const state of ["SUPPRESSED", "RESTRICTED", "RETENTION_EXPIRED", "ARCHIVED"] as const) {
        const gate = leadPrivacyGateFor(state);
        expect(gate.nurtureAllowed, state).toBe(false);
        expect(gate.contactAllowed, state).toBe(false);
        expect(gate.actionable, state).toBe(false);
      }
      expect(leadPrivacyGateFor("SUPPRESSED").blockedReason).toBe("PRIVACY_SUPPRESSED");
      expect(leadPrivacyGateFor("RETENTION_EXPIRED").blockedReason).toBe("RETENTION_EXPIRED");
    });

    it("active and retention-pending leads stay actionable", () => {
      expect(leadPrivacyGateFor("ACTIVE").actionable).toBe(true);
      const pending = leadPrivacyGateFor("RETENTION_PENDING");
      expect(pending.actionable).toBe(true);
      expect(pending.nurtureAllowed).toBe(true);
      expect(pending.blockedReason).toBeNull();
    });
  });

  describe("transition graph", () => {
    it("has no cycles out of ARCHIVED and no direct ACTIVE→RETENTION_EXPIRED shortcut", () => {
      expect(LEAD_PRIVACY_TRANSITIONS.ARCHIVED).toHaveLength(0);
      expect(isLeadPrivacyTransitionAllowed("ACTIVE", "RETENTION_EXPIRED")).toBe(false);
      for (const state of LEAD_PRIVACY_STATES) {
        expect(LEAD_PRIVACY_TRANSITIONS[state]).toBeDefined();
      }
    });
  });
});
