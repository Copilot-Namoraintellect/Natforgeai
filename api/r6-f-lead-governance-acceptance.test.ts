/**
 * R6-F9 — LEAD GOVERNANCE ACCEPTANCE HARNESS
 *
 * Deterministic connected proof of the 26 charter checks:
 *   fixture states → operations projection → blocker classification →
 *   operator read → governed recovery (where allowed) → audit →
 *   updated projection.
 *
 * Checks 2–8 (identity / scoring / qualification / nurture / handoff /
 * conversion visibility) run through the pure derivation seam that R6-X
 * activates when each stream registers durable evidence — honest
 * `supported:false` at runtime today, classification proven over explicit
 * evidence fixtures. No stream state is invented.
 *
 * No live MySQL/Redis/providers: the canonical connection module is mocked
 * and the real governed authorities (privacy store, audit ledger,
 * projection) run against the in-memory drizzle evaluator.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./queries/connection", () => ({
  getDb: vi.fn(() => {
    throw new Error("getDb must not fall back to a real connection in R6-F acceptance tests");
  }),
}));

vi.mock("./lib/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

import { getDb } from "./queries/connection";
import { createFakeDb, buildCtx } from "./r5-test-support";
import { leadGovernanceRouter } from "./lead-governance-router";
import {
  deriveLeadBlockers,
  deriveLeadOperationalState,
  LEAD_SAFE_NEXT_ACTIONS,
  type LeadOperationsEvidence,
} from "./lib/governance/lead-operations-projection";
import type { LeadPrivacyEvidence } from "./lib/governance/lead-privacy-store";

const ADMIN = { id: 7, role: "admin" };
const OTHER_USER = { id: 8, role: "user" };
const RECOVERY_ENV = "R6_LEAD_RECOVERY_ADMIN_ENABLED";
const ORIGINAL_ENV = process.env[RECOVERY_ENV];
const REAL_NOW = new Date();
const PAST_DEADLINE = new Date(Date.now() - 24 * 60 * 60 * 1000);

const PII_CANARIES = [
  "alice.canary@example.com",
  "+15550199CANARY",
  "Alice Canary",
  "Canary Industries",
];

type Seed = Record<string, Record<string, unknown>[]>;

function leadFixture(id: number, businessId: number, userId: number, status = "new") {
  return {
    id,
    userId,
    businessId,
    campaignId: 101,
    name: "Alice Canary",
    email: "alice.canary@example.com",
    phone: "+15550199CANARY",
    company: "Canary Industries",
    status,
    score: 0,
    createdAt: REAL_NOW,
    updatedAt: REAL_NOW,
    lastContact: null,
    nextFollowUp: null,
  };
}

function privacyFixture(id: number, leadId: number, privacyState: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    leadId,
    userId: 7,
    businessId: 10,
    privacyState,
    previousState: null,
    reason: null,
    retentionDeadlineAt: null,
    source: "operator",
    actorUserId: 7,
    createdAt: REAL_NOW,
    updatedAt: REAL_NOW,
    ...extra,
  };
}

function buildSeed(): Seed {
  return {
    businesses: [
      { id: 10, userId: 7, name: "Acme" },
      { id: 20, userId: 8, name: "Other Tenant Co" },
    ],
    leads: [
      leadFixture(5, 10, 7),
      leadFixture(6, 10, 7),
      leadFixture(7, 10, 7),
      leadFixture(8, 20, 8),
    ],
    lead_activities: [{ id: 1, leadId: 5, type: "status_change", description: "moved", createdBy: 7, createdAt: REAL_NOW }],
    lead_privacy_states: [privacyFixture(1, 6, "SUPPRESSED", { reason: "opt-out" })],
    audit_events: [],
  };
}

function useSeed(seed: Seed, options?: { failAuditInsert?: Error }) {
  const fake = createFakeDb(seed, options);
  vi.mocked(fake.db.execute).mockResolvedValue([[{ c: 1 }]] as never);
  vi.mocked(getDb).mockReturnValue(fake.db as never);
  return fake;
}

// ─── fixtures for the pure-derivation checks (2–8) ───

function baseEvidence(): LeadOperationsEvidence {
  const privacy: LeadPrivacyEvidence = {
    available: true,
    state: "ACTIVE",
    explicit: true,
    retentionDeadlineAt: null,
    previousState: null,
    source: "operator",
    actorUserId: 7,
    updatedAt: REAL_NOW,
  };
  return {
    leadFound: true,
    lead: { id: 5, userId: 7, businessId: 10, campaignId: 101, status: "new", score: 0, createdAt: REAL_NOW, updatedAt: REAL_NOW, lastContact: null, nextFollowUp: null },
    areasUnavailable: [],
    identity: { supported: false, status: "unavailable", unavailableReason: "stream_not_integrated", identityStatus: null, identityConfidence: null },
    scoring: { supported: false, status: "unavailable", unavailableReason: "stream_not_integrated", latestScore: null, scoreStatus: null, legacyScore: 0 },
    qualification: { supported: false, status: "unavailable", unavailableReason: "stream_not_integrated", qualificationStatus: null },
    nurture: { supported: false, status: "unavailable", unavailableReason: "stream_not_integrated", allowed: true, blockedByPrivacy: false },
    salesHandoff: { supported: false, status: "unavailable", unavailableReason: "stream_not_integrated", handoffStatus: null },
    conversion: { supported: false, status: "unavailable", unavailableReason: "stream_not_integrated", conversionStatus: null, conversionLinked: null },
    privacy,
    activity: { lastActivityAt: REAL_NOW, lastSuccessfulTransitionAt: REAL_NOW, statusChangeCount: 1 },
  };
}

describe("R6-F9 lead governance acceptance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env[RECOVERY_ENV] = "true";
  });

  afterAll(() => {
    if (ORIGINAL_ENV === undefined) delete process.env[RECOVERY_ENV];
    else process.env[RECOVERY_ENV] = ORIGINAL_ENV;
  });

  // F9.1 — healthy lead projection
  it("F9.1 healthy lead projects HEALTHY with no blockers and no operator action", async () => {
    const fake = useSeed(buildSeed());
    const caller = leadGovernanceRouter.createCaller(buildCtx(ADMIN));
    const p = await caller.getLeadOperations({ leadId: 5 });
    expect(p.health).toBe("HEALTHY");
    expect(p.blockers).toHaveLength(0);
    expect(p.operatorActionRequired).toBe(false);
    expect(p.privacy.status).toBe("ACTIVE");
    expect(p.suppression.suppressed).toBe(false);
    expect(p.lastSuccessfulTransitionAt).not.toBeNull();
    expect(fake.seed.audit_events).toHaveLength(0); // reads never audit
  });

  // F9.2–F9.8 — stream blockers visible through the X-convergence seam
  it("F9.2 identity conflict is classified when identity evidence registers", () => {
    const e = baseEvidence();
    e.identity = { supported: true, status: "conflicting", identityStatus: "conflicting", identityConfidence: "HIGH" };
    const blockers = deriveLeadBlockers(e);
    expect(blockers.map((b) => b.blockerClass)).toContain("IDENTITY_CONFLICT");
    const d = deriveLeadOperationalState(e, blockers, REAL_NOW);
    expect(d.health).toBe("BLOCKED_OPERATOR");
    expect(d.safeNextAction).toBe("review_identity_conflict");
  });

  it("F9.3 unresolved identity is classified with auto-recover semantics", () => {
    const e = baseEvidence();
    e.identity = { supported: true, status: "unresolved", identityStatus: "unresolved", identityConfidence: "LOW" };
    const blockers = deriveLeadBlockers(e);
    expect(blockers.map((b) => b.blockerClass)).toEqual(["IDENTITY_INSUFFICIENT_EVIDENCE"]);
    expect(blockers[0].recoveryClass).toBe("AUTO_RECOVER");
    expect(deriveLeadOperationalState(e, blockers, REAL_NOW).health).toBe("AUTO_RECOVERING");
  });

  it("F9.4 stale score is classified when scoring evidence registers", () => {
    const e = baseEvidence();
    e.scoring = { supported: true, status: "stale", latestScore: 55, scoreStatus: "stale", legacyScore: 55 };
    const blockers = deriveLeadBlockers(e);
    expect(blockers.map((b) => b.blockerClass)).toEqual(["SCORE_STALE"]);
    expect(blockers[0]).toMatchObject({ recoveryClass: "AUTO_RECOVER", safeNextAction: "recompute_stale_score" });
  });

  it("F9.5 qualification blocker is classified when qualification evidence registers", () => {
    const e = baseEvidence();
    e.qualification = { supported: true, status: "blocked", qualificationStatus: "blocked" };
    const blockers = deriveLeadBlockers(e);
    expect(blockers.map((b) => b.blockerClass)).toEqual(["QUALIFICATION_BLOCKED"]);
    expect(blockers[0]).toMatchObject({ recoveryClass: "GOVERNANCE_APPROVAL", safeNextAction: "resolve_qualification_block" });
  });

  it("F9.6 nurture policy blocker is classified when nurture evidence registers", () => {
    const e = baseEvidence();
    e.nurture = { supported: true, status: "policy_blocked", allowed: false, blockedByPrivacy: false };
    const blockers = deriveLeadBlockers(e);
    expect(blockers.map((b) => b.blockerClass)).toEqual(["NURTURE_POLICY_BLOCKED"]);
    expect(blockers[0].recoveryClass).toBe("GOVERNANCE_APPROVAL");
  });

  it("F9.7 handoff failure is classified when handoff evidence registers", () => {
    const e = baseEvidence();
    e.salesHandoff = { supported: true, status: "failed", handoffStatus: "failed" };
    const blockers = deriveLeadBlockers(e);
    expect(blockers.map((b) => b.blockerClass)).toEqual(["SALES_HANDOFF_FAILED"]);
    expect(blockers[0]).toMatchObject({ recoveryClass: "AUTO_RECOVER", safeNextAction: "retry_sales_handoff" });
  });

  it("F9.8 conversion-linkage issue is classified when conversion evidence registers", () => {
    const e = baseEvidence();
    e.conversion = { supported: true, status: "linkage_unresolved", conversionStatus: "linkage_unresolved", conversionLinked: false };
    const blockers = deriveLeadBlockers(e);
    expect(blockers.map((b) => b.blockerClass)).toEqual(["CONVERSION_LINKAGE_UNRESOLVED"]);
    expect(blockers[0].safeNextAction).toBe("review_conversion_linkage");
  });

  // F9.9 — privacy suppression visible
  it("F9.9 suppressed lead shows suppression state, blocker and closed nurture gate", async () => {
    useSeed(buildSeed());
    const caller = leadGovernanceRouter.createCaller(buildCtx(ADMIN));
    const p = await caller.getLeadOperations({ leadId: 6 });
    expect(p.privacy.status).toBe("SUPPRESSED");
    expect(p.suppression.suppressed).toBe(true);
    expect(p.nurture.allowed).toBe(false);
    expect(p.blockers[0]).toMatchObject({ blockerClass: "PRIVACY_SUPPRESSED", recoveryClass: "GOVERNANCE_APPROVAL" });
    expect(p.health).toBe("BLOCKED_OPERATOR");
  });

  // F9.10 — retention-expired state visible (via governed recovery → updated projection)
  it("F9.10 retention-expired state is visible after the governed sweep updates the projection", async () => {
    const seed = buildSeed();
    seed.lead_privacy_states.push(
      privacyFixture(2, 7, "RETENTION_PENDING", { retentionDeadlineAt: PAST_DEADLINE })
    );
    useSeed(seed);
    const caller = leadGovernanceRouter.createCaller(buildCtx(ADMIN));

    const before = await caller.getLeadOperations({ leadId: 7 });
    expect(before.privacy.status).toBe("RETENTION_PENDING");
    expect(before.health).toBe("HEALTHY");

    await caller.retryOperation({ operationKind: "retention_sweep", operationId: 10, expectedDueCount: 1 });

    const after = await caller.getLeadOperations({ leadId: 7 });
    expect(after.privacy.status).toBe("RETENTION_EXPIRED");
    expect(after.health).toBe("BLOCKED_OPERATOR");
    expect(after.blockers[0].blockerClass).toBe("RETENTION_EXPIRED");
    expect(after.operatorActionRequired).toBe(true);
  });

  // F9.11 — unauthorized operator rejected
  it("F9.11 unauthenticated and non-admin operators are rejected on reads and mutations", async () => {
    useSeed(buildSeed());
    const anon = leadGovernanceRouter.createCaller(buildCtx(null));
    await expect(anon.getLeadOperations({ leadId: 5 })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      anon.setPrivacyState({ leadId: 5, targetState: "SUPPRESSED", reason: "x" })
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    const user = leadGovernanceRouter.createCaller(buildCtx(OTHER_USER));
    await expect(user.getLeadOperations({ leadId: 5 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      user.retryOperation({ operationKind: "retention_sweep", operationId: 10 })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  // F9.12 — cross-business access rejected
  it("F9.12 cross-business access is rejected; forged business ids fail closed", async () => {
    useSeed(buildSeed());
    const ownerTenantA = leadGovernanceRouter.createCaller(buildCtx({ id: 7, role: "user" }));
    await expect(ownerTenantA.getLeadOperations({ leadId: 8 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const admin = leadGovernanceRouter.createCaller(buildCtx(ADMIN));
    await expect(
      admin.retryOperation({ operationKind: "retention_sweep", operationId: 4242 })
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "business not found" });
    await expect(
      admin.setPrivacyState({ leadId: 4242, targetState: "SUPPRESSED", reason: "x" })
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "lead not found" });
  });

  // F9.13 — admin access works where intended
  it("F9.13 verified admin can read across businesses (operator visibility by design)", async () => {
    useSeed(buildSeed());
    const admin = leadGovernanceRouter.createCaller(buildCtx(ADMIN));
    const crossTenant = await admin.getLeadOperations({ leadId: 8 });
    expect(crossTenant.leadId).toBe(8);
    expect(crossTenant.businessId).toBe(20);
    const listing = await admin.listLeadOperationalStates({ businessId: 20 });
    expect(listing.total).toBe(1);
  });

  // F9.14 — stale recovery rejected
  it("F9.14 stale recovery and stale privacy assertions are rejected with CONFLICT", async () => {
    const seed = buildSeed();
    seed.lead_privacy_states.push(
      privacyFixture(2, 7, "RETENTION_PENDING", { retentionDeadlineAt: PAST_DEADLINE })
    );
    useSeed(seed);
    const admin = leadGovernanceRouter.createCaller(buildCtx(ADMIN));
    await expect(
      admin.retryOperation({ operationKind: "retention_sweep", operationId: 10, expectedDueCount: 9 })
    ).rejects.toMatchObject({ code: "CONFLICT", message: "stale sweep state: expected 9 due, current 1" });
    await expect(
      admin.setPrivacyState({ leadId: 5, targetState: "SUPPRESSED", reason: "x", expectedStatus: "SUPPRESSED" })
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  // F9.15 — duplicate recovery converges
  it("F9.15 duplicate recovery converges with a single audit event", async () => {
    const seed = buildSeed();
    seed.lead_privacy_states.push(
      privacyFixture(2, 7, "RETENTION_PENDING", { retentionDeadlineAt: PAST_DEADLINE })
    );
    const fake = useSeed(seed);
    const admin = leadGovernanceRouter.createCaller(buildCtx(ADMIN));
    const first = await admin.retryOperation({ operationKind: "retention_sweep", operationId: 10 });
    const second = await admin.retryOperation({ operationKind: "retention_sweep", operationId: 10 });
    expect(first).toMatchObject({ outcome: "expired", expiredCount: 1 });
    expect(second).toMatchObject({ outcome: "converged", expiredCount: 0 });
    expect(fake.seed.audit_events).toHaveLength(1);
  });

  // F9.16 — concurrent recovery converges
  it("F9.16 concurrent recoveries converge on CAS guards with at most one mutation", async () => {
    const seed = buildSeed();
    seed.lead_privacy_states.push(
      privacyFixture(2, 7, "RETENTION_PENDING", { retentionDeadlineAt: PAST_DEADLINE })
    );
    const fake = useSeed(seed);
    const admin = leadGovernanceRouter.createCaller(buildCtx(ADMIN));
    const [a, b] = await Promise.all([
      admin.retryOperation({ operationKind: "retention_sweep", operationId: 10 }),
      admin.retryOperation({ operationKind: "retention_sweep", operationId: 10 }),
    ]);
    expect(a.expiredCount + b.expiredCount).toBe(1);
    const row = fake.seed.lead_privacy_states.find((r) => r.leadId === 7);
    expect(row).toMatchObject({ privacyState: "RETENTION_EXPIRED" });
    expect(fake.seed.audit_events.length).toBeLessThanOrEqual(1);
  });

  // F9.17 — audit written for privileged mutation
  it("F9.17 every privileged mutation writes exactly one canonical admin audit event", async () => {
    const fake = useSeed(buildSeed());
    const admin = leadGovernanceRouter.createCaller(buildCtx(ADMIN));
    await admin.setPrivacyState({ leadId: 5, targetState: "SUPPRESSED", reason: "opt-out requested" });
    expect(fake.seed.audit_events).toHaveLength(1);
    expect(fake.seed.audit_events[0]).toMatchObject({
      eventType: "admin_mutation",
      source: "admin",
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
    // Stable mutation identity: event fingerprint exists and is unique.
    expect(typeof fake.seed.audit_events[0].eventFingerprint).toBe("string");
    expect(fake.seed.audit_events[0].eventFingerprint).toHaveLength(64);
  });

  // F9.18 — audit failure prevents unsafe mutation
  it("F9.18 audit failure rolls back the mutation — no unaudited mutation persists", async () => {
    const fake = useSeed(buildSeed(), { failAuditInsert: new Error("audit ledger unavailable") });
    const admin = leadGovernanceRouter.createCaller(buildCtx(ADMIN));
    await expect(
      admin.setPrivacyState({ leadId: 5, targetState: "SUPPRESSED", reason: "opt-out" })
    ).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    expect(fake.seed.lead_privacy_states.filter((r) => r.leadId === 5)).toHaveLength(0);
    expect(fake.seed.audit_events).toHaveLength(0);
  });

  // F9.19 — secret fields absent
  it("F9.19 no secret/credential-shaped fields appear anywhere on the surface", async () => {
    const fake = useSeed(buildSeed());
    const admin = leadGovernanceRouter.createCaller(buildCtx(ADMIN));
    const p = await admin.getLeadOperations({ leadId: 5 });
    await admin.setPrivacyState({ leadId: 5, targetState: "SUPPRESSED", reason: "opt-out" });
    const summary = await admin.getLeadGovernanceSummary();
    const listing = await admin.listLeadOperationalStates({ businessId: 10 });
    const haystacks = [p, summary, listing, ...fake.seed.audit_events].map((x) => JSON.stringify(x));
    for (const text of haystacks) {
      expect(text).not.toMatch(/accessToken|refreshToken|password|passwd|authorization|secret|credential|api[-_]?key|session|cookie|Bearer|contentText/i);
    }
  });

  // F9.20 — raw PII minimized
  it("F9.20 raw PII (name/email/phone/company/activity text) never reaches operator surfaces", async () => {
    const fake = useSeed(buildSeed());
    const admin = leadGovernanceRouter.createCaller(buildCtx(ADMIN));
    const p = await admin.getLeadOperations({ leadId: 5 });
    await admin.setPrivacyState({ leadId: 5, targetState: "SUPPRESSED", reason: "opt-out" });
    const haystacks = [JSON.stringify(p), JSON.stringify(fake.seed.audit_events)];
    for (const canary of PII_CANARIES) {
      for (const text of haystacks) expect(text).not.toContain(canary);
    }
    // Activity descriptions are never projected (only timestamps/counts).
    expect(JSON.stringify(p)).not.toContain("moved");
  });

  // F9.21–F9.24 — force-* impossible
  it("F9.21–F9.24 no force-merge / force-score / force-qualify / force-convert path exists", async () => {
    useSeed(buildSeed());
    const procedures = Object.keys((leadGovernanceRouter as any)._def.procedures).sort();
    expect(procedures).toEqual(
      ["getLeadGovernanceSummary", "getLeadOperations", "listLeadOperationalStates", "retryOperation", "setPrivacyState"].sort()
    );
    for (const name of procedures) {
      expect(name).not.toMatch(/force|override|merge|score|qualify|convert|setStatus|setState/i);
    }
    // The CRM lifecycle router is unchanged: leads.status authority stays there.
    const { leadRouter } = await import("./lead-router");
    const leadProcedures = Object.keys((leadRouter as any)._def.procedures).sort();
    expect(leadProcedures).toEqual(
      ["activities", "addActivity", "autoScore", "bulkAutoScore", "create", "delete", "get", "list", "update"]
    );
    for (const name of leadProcedures) {
      expect(name).not.toMatch(/force|override/i);
    }
  });

  // F9.25 — terminal/restricted state cannot be reopened arbitrarily
  it("F9.25 ARCHIVED terminal state and restricted transitions cannot be reopened", async () => {
    const seed = buildSeed();
    seed.lead_privacy_states.push(privacyFixture(3, 5, "ARCHIVED"));
    useSeed(seed);
    const admin = leadGovernanceRouter.createCaller(buildCtx(ADMIN));
    await expect(
      admin.setPrivacyState({ leadId: 5, targetState: "ACTIVE", reason: "attempted reopen" })
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    // Direct forbidden transition is equally rejected at the store level
    // (SUPPRESSED → RETENTION_EXPIRED is not an allowed governance edge).
    const { transitionLeadPrivacyState } = await import("./lib/governance/lead-privacy-store");
    const fake = useSeed(buildSeed());
    await expect(
      transitionLeadPrivacyState(fake.db as never, {
        leadId: 6,
        userId: 7,
        businessId: 10,
        targetState: "RETENTION_EXPIRED",
        source: "operator",
        actorUserId: 7,
        now: new Date(),
      })
    ).rejects.toMatchObject({ code: "LEAD_PRIVACY_TRANSITION_FORBIDDEN" });
  });

  // F9.26 — operator can identify next action without developer tools
  it("F9.26 operator identifies the next action from the read model alone", async () => {
    useSeed(buildSeed());
    const admin = leadGovernanceRouter.createCaller(buildCtx(ADMIN));
    const suppressed = await admin.getLeadOperations({ leadId: 6 });
    // Closed-vocabulary next action + blocker detail, no SQL/CLI/source needed.
    expect(LEAD_SAFE_NEXT_ACTIONS).toContain(suppressed.safeNextAction);
    expect(suppressed.safeNextAction).toBe("review_privacy_suppression");
    expect(suppressed.blockers[0].evidence.length).toBeGreaterThan(0);
    expect(suppressed.operatorActionRequired).toBe(true);

    const listing = await admin.listLeadOperationalStates({ businessId: 10, health: "BLOCKED_OPERATOR" });
    expect(listing.items[0].safeNextAction).toBe("review_privacy_suppression");
    const summary = await admin.getLeadGovernanceSummary();
    expect(summary.operatorActionRequired).toBe(1);
  });
});
