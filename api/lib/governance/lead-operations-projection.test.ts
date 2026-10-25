import { describe, expect, it } from "vitest";
import {
  deriveLeadBlockers,
  deriveLeadOperationalState,
  LEAD_OPERATIONAL_HEALTH,
  LEAD_SAFE_NEXT_ACTIONS,
  LEAD_STALENESS_THRESHOLDS,
  type LeadOperationsEvidence,
} from "./lead-operations-projection";
import type { LeadPrivacyEvidence } from "./lead-privacy-store";

const NOW = new Date("2026-06-28T12:00:00.000Z");
const HOUR_AGO = new Date(NOW.getTime() - 60 * 60 * 1000);
const FORTY_DAYS_AGO = new Date(NOW.getTime() - 40 * 24 * 60 * 60 * 1000);

function privacy(overrides: Partial<LeadPrivacyEvidence> = {}): LeadPrivacyEvidence {
  return {
    available: true,
    state: "ACTIVE",
    explicit: true,
    retentionDeadlineAt: null,
    previousState: null,
    source: "operator",
    actorUserId: 7,
    updatedAt: HOUR_AGO,
    ...overrides,
  };
}

function evidence(overrides: Partial<LeadOperationsEvidence> = {}): LeadOperationsEvidence {
  return {
    leadFound: true,
    lead: {
      id: 5,
      userId: 7,
      businessId: 10,
      campaignId: 101,
      status: "new",
      score: 0,
      createdAt: HOUR_AGO,
      updatedAt: HOUR_AGO,
      lastContact: null,
      nextFollowUp: null,
    },
    areasUnavailable: [],
    identity: { supported: false, status: "unavailable", unavailableReason: "stream_not_integrated", identityStatus: null, identityConfidence: null },
    scoring: { supported: false, status: "unavailable", unavailableReason: "stream_not_integrated", latestScore: null, scoreStatus: null, legacyScore: 0 },
    qualification: { supported: false, status: "unavailable", unavailableReason: "stream_not_integrated", qualificationStatus: null },
    nurture: { supported: false, status: "unavailable", unavailableReason: "stream_not_integrated", allowed: true, blockedByPrivacy: false },
    salesHandoff: { supported: false, status: "unavailable", unavailableReason: "stream_not_integrated", handoffStatus: null },
    conversion: { supported: false, status: "unavailable", unavailableReason: "stream_not_integrated", conversionStatus: null, conversionLinked: null },
    privacy: privacy(),
    activity: { lastActivityAt: HOUR_AGO, lastSuccessfulTransitionAt: null, statusChangeCount: 0 },
    ...overrides,
  };
}

describe("lead-operations projection derivation (F1)", () => {
  it("exposes closed health and safe-action vocabularies", () => {
    expect(LEAD_OPERATIONAL_HEALTH).toEqual([
      "HEALTHY",
      "DEGRADED",
      "BLOCKED_OPERATOR",
      "BLOCKED_CONFIGURATION",
      "AUTO_RECOVERING",
      "UNSUPPORTED",
      "FAIL_CLOSED",
    ]);
    expect(new Set(LEAD_SAFE_NEXT_ACTIONS).size).toBe(LEAD_SAFE_NEXT_ACTIONS.length);
  });

  describe("health classification", () => {
    it("healthy lead: no blockers, recent activity", () => {
      const e = evidence();
      const blockers = deriveLeadBlockers(e);
      const d = deriveLeadOperationalState(e, blockers, NOW);
      expect(d.health).toBe("HEALTHY");
      expect(d.blockers).toHaveLength(0);
      expect(d.safeNextAction).toBe("none");
      expect(d.operatorActionRequired).toBe(false);
      expect(d.isStale).toBe(false);
      expect(d.capabilitiesPresent).toBeGreaterThan(0);
    });

    it("missing lead ⇒ UNSUPPORTED, never guessed", () => {
      const e = evidence({
        leadFound: false,
        lead: null,
        privacy: privacy({ available: false, reason: "lead_not_found", explicit: false }),
      });
      const d = deriveLeadOperationalState(e, [], NOW);
      expect(d.health).toBe("UNSUPPORTED");
      expect(d.capabilitiesPresent).toBe(0);
    });

    it("stale activity is a warning, not a blocker", () => {
      const e = evidence({
        activity: { lastActivityAt: FORTY_DAYS_AGO, lastSuccessfulTransitionAt: null, statusChangeCount: 0 },
      });
      const d = deriveLeadOperationalState(e, [], NOW);
      expect(d.health).toBe("HEALTHY");
      expect(d.isStale).toBe(true);
      expect(d.staleness.lastActivityAgeMs).toBeGreaterThan(LEAD_STALENESS_THRESHOLDS.leadActivityMs);
      expect(d.notes.join(" ")).toContain("staleness");
    });
  });

  describe("blocker visibility", () => {
    it("suppressed lead ⇒ PRIVACY_SUPPRESSED, BLOCKED_OPERATOR, governance approval", () => {
      const e = evidence({ privacy: privacy({ state: "SUPPRESSED" }) });
      const blockers = deriveLeadBlockers(e);
      const d = deriveLeadOperationalState(e, blockers, NOW);
      expect(blockers).toHaveLength(1);
      expect(blockers[0]).toMatchObject({
        blockerClass: "PRIVACY_SUPPRESSED",
        recoveryClass: "GOVERNANCE_APPROVAL",
        healthImpact: "operator",
        area: "privacy",
        safeNextAction: "review_privacy_suppression",
      });
      expect(d.health).toBe("BLOCKED_OPERATOR");
      expect(d.operatorActionRequired).toBe(true);
      expect(d.safeNextAction).toBe("review_privacy_suppression");
    });

    it("restricted lead surfaces the same suppression-class blocker", () => {
      const blockers = deriveLeadBlockers(evidence({ privacy: privacy({ state: "RESTRICTED" }) }));
      expect(blockers.map((b) => b.blockerClass)).toEqual(["PRIVACY_SUPPRESSED"]);
    });

    it("retention-expired lead ⇒ RETENTION_EXPIRED blocker with disposition action", () => {
      const e = evidence({
        privacy: privacy({ state: "RETENTION_EXPIRED", retentionDeadlineAt: HOUR_AGO }),
      });
      const blockers = deriveLeadBlockers(e);
      const d = deriveLeadOperationalState(e, blockers, NOW);
      expect(blockers[0]).toMatchObject({
        blockerClass: "RETENTION_EXPIRED",
        recoveryClass: "OPERATOR_ACTION",
        safeNextAction: "dispose_retention_expired",
      });
      expect(d.health).toBe("BLOCKED_OPERATOR");
    });

    it("archived lead stays terminal-blocked (RETENTION_EXPIRED class)", () => {
      const blockers = deriveLeadBlockers(evidence({ privacy: privacy({ state: "ARCHIVED" }) }));
      expect(blockers.map((b) => b.blockerClass)).toEqual(["RETENTION_EXPIRED"]);
    });

    it("retention-pending lead is not blocked (actionable until deadline)", () => {
      const e = evidence({ privacy: privacy({ state: "RETENTION_PENDING", retentionDeadlineAt: HOUR_AGO }) });
      const d = deriveLeadOperationalState(e, deriveLeadBlockers(e), NOW);
      expect(d.health).toBe("HEALTHY");
      expect(d.blockers).toHaveLength(0);
    });

    it("never derives blockers from absent privacy authority", () => {
      const e = evidence({
        privacy: privacy({ available: false, reason: "privacy_table_absent", explicit: false }),
      });
      const d = deriveLeadOperationalState(e, deriveLeadBlockers(e), NOW);
      expect(d.blockers).toHaveLength(0);
      expect(d.health).toBe("HEALTHY");
    });

    it("never derives blockers from unintegrated stream areas", () => {
      const e = evidence();
      const d = deriveLeadOperationalState(e, deriveLeadBlockers(e), NOW);
      expect(e.identity.supported).toBe(false);
      expect(e.scoring.supported).toBe(false);
      expect(e.qualification.supported).toBe(false);
      expect(e.conversion.supported).toBe(false);
      expect(d.blockers).toHaveLength(0);
    });

    it("worst impact wins when multiple blockers exist", () => {
      const e = evidence({ privacy: privacy({ state: "SUPPRESSED" }) });
      const blockers: ReturnType<typeof deriveLeadBlockers> = [
        ...deriveLeadBlockers(e),
        {
          blockerClass: "SECURITY_REJECTION",
          recoveryClass: "FAIL_CLOSED",
          healthImpact: "fail_closed",
          area: "security",
          evidence: "explicit fail-closed fixture evidence",
          since: HOUR_AGO,
          safeNextAction: "review_fail_closed_evidence",
        },
      ];
      const d = deriveLeadOperationalState(e, blockers, NOW);
      expect(d.health).toBe("FAIL_CLOSED");
      expect(d.safeNextAction).toBe("review_fail_closed_evidence");
    });

    it("suppressed lead closes the nurture gate with privacy reason", () => {
      const e = evidence({
        privacy: privacy({ state: "SUPPRESSED" }),
        nurture: { supported: false, status: "unavailable", unavailableReason: "stream_not_integrated", allowed: false, blockedByPrivacy: true },
      });
      expect(e.nurture.allowed).toBe(false);
      expect(e.nurture.blockedByPrivacy).toBe(true);
    });
  });

  describe("stream convergence seam (explicit evidence only, gated on supported)", () => {
    it("identity conflict / unresolved classify when identity evidence is registered", () => {
      const conflicting = evidence({
        identity: { supported: true, status: "conflicting", identityStatus: "conflicting", identityConfidence: "HIGH" },
      });
      const blockers = deriveLeadBlockers(conflicting);
      expect(blockers.map((b) => b.blockerClass)).toEqual(["IDENTITY_CONFLICT"]);
      expect(blockers[0]).toMatchObject({ recoveryClass: "OPERATOR_ACTION", safeNextAction: "review_identity_conflict" });

      const unresolved = evidence({
        identity: { supported: true, status: "unresolved", identityStatus: "unresolved", identityConfidence: "LOW" },
      });
      const uBlockers = deriveLeadBlockers(unresolved);
      expect(uBlockers.map((b) => b.blockerClass)).toEqual(["IDENTITY_INSUFFICIENT_EVIDENCE"]);
      expect(uBlockers[0]).toMatchObject({ recoveryClass: "AUTO_RECOVER" });
    });

    it("stale / unavailable scores classify only with scoring support", () => {
      const stale = evidence({
        scoring: { supported: true, status: "stale", latestScore: 42, scoreStatus: "stale", legacyScore: 42 },
      });
      expect(deriveLeadBlockers(stale).map((b) => b.blockerClass)).toEqual(["SCORE_STALE"]);

      const unavailable = evidence({
        scoring: { supported: true, status: "unavailable", latestScore: null, scoreStatus: "unavailable", legacyScore: 10 },
      });
      const blockers = deriveLeadBlockers(unavailable);
      expect(blockers.map((b) => b.blockerClass)).toEqual(["SCORE_UNAVAILABLE"]);
      expect(blockers[0]).toMatchObject({ recoveryClass: "OPERATOR_ACTION" });
    });

    it("qualification review / blocked classify when qualification evidence is registered", () => {
      const review = evidence({
        qualification: { supported: true, status: "requires_review", qualificationStatus: "requires_review" },
      });
      expect(deriveLeadBlockers(review).map((b) => b.blockerClass)).toEqual(["QUALIFICATION_REQUIRES_REVIEW"]);

      const blocked = evidence({
        qualification: { supported: true, status: "blocked", qualificationStatus: "blocked" },
      });
      const blockers = deriveLeadBlockers(blocked);
      expect(blockers.map((b) => b.blockerClass)).toEqual(["QUALIFICATION_BLOCKED"]);
      expect(blockers[0]).toMatchObject({ recoveryClass: "GOVERNANCE_APPROVAL" });
    });

    it("nurture policy block, handoff failure and conversion linkage classify when registered", () => {
      const e = evidence({
        nurture: { supported: true, status: "policy_blocked", allowed: false, blockedByPrivacy: false },
        salesHandoff: { supported: true, status: "failed", handoffStatus: "failed" },
        conversion: { supported: true, status: "linkage_unresolved", conversionStatus: "linkage_unresolved", conversionLinked: false },
      });
      const classes = deriveLeadBlockers(e).map((b) => b.blockerClass).sort();
      expect(classes).toEqual(["CONVERSION_LINKAGE_UNRESOLVED", "NURTURE_POLICY_BLOCKED", "SALES_HANDOFF_FAILED"]);
    });

    it("unsupported areas never classify — not even with plausible status strings", () => {
      const e = evidence({
        identity: { supported: false, status: "unavailable", unavailableReason: "stream_not_integrated", identityStatus: null, identityConfidence: null },
        scoring: { supported: false, status: "unavailable", unavailableReason: "stream_not_integrated", latestScore: null, scoreStatus: null, legacyScore: 3 },
      });
      expect(deriveLeadBlockers(e)).toHaveLength(0);
    });
  });
});
