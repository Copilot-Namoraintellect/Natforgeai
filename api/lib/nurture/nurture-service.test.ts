// WBS-R6-D — durable store + governed service acceptance.
// Exercises the real store and service against the in-memory harness:
// exact-once convergence, conflicting replay fail-closed, CAS lifecycle,
// approval gate, capability fail-closed, conversion/privacy stops, audit.
import { describe, it, expect } from "vitest";
import {
  createNurtureHarness,
  makeIdentityFixture,
  makeQualificationFixture,
  HEX,
  type LeadFixtureIds,
} from "../../r6-d-test-support";
import {
  evaluateNurture,
  dispatchHandoff,
  dispatchNurtureTouch,
  reconcileHandoff,
  getLeadNurtureHandoffView,
  type NurtureServiceDeps,
} from "./nurture-service";
import { NurtureError } from "./nurture-contract";
import { buildDefaultNurturePolicyConfig, buildNurtureHandoffPolicy } from "./nurture-policy";
import { recordDecision } from "./nurture-store";

const NOW = "2026-06-28T12:00:00.000Z";

const IDS: LeadFixtureIds = {
  leadId: `lid1:${HEX("b")}`,
  qualificationId: `lqu1:${HEX("a")}`,
  businessId: 42,
  userId: 7,
};

function makeDeps(harness: ReturnType<typeof createNurtureHarness>): NurtureServiceDeps {
  return {
    ports: harness.ports,
    executor: harness.executor as unknown as NurtureServiceDeps["executor"],
    transport: harness.transport,
    now: () => new Date(NOW),
  };
}

function seedLead(harness: ReturnType<typeof createNurtureHarness>) {
  harness.setProjection(IDS.qualificationId, makeQualificationFixture(IDS));
  harness.setIdentity(IDS.leadId, makeIdentityFixture(IDS));
}

describe("evaluate — governed decision + handoff preparation", () => {
  it("QUALIFIED lead: progression ⇒ SALES_HANDOFF + exact-once handoff + approval request + one audit", async () => {
    const h = createNurtureHarness({ now: NOW });
    seedLead(h);
    const r1 = await evaluateNurture(makeDeps(h), IDS.userId, { qualificationId: IDS.qualificationId });
    expect(r1.decision.decision).toBe("SALES_HANDOFF");
    expect(r1.decision.approvalRequired).toBe(true);
    expect(r1.handoff?.handoffStatus).toBe("APPROVAL_REQUIRED");
    expect(r1.decision.handoffId).toMatch(/^sh1:[a-f0-9]{64}$/);
    expect(r1.decision.approvalRequestId).toBeTypeOf("number");
    expect(h.table("approval_requests")).toHaveLength(1);
    expect(h.auditEvents()).toHaveLength(1);
    expect(h.auditEvents()[0].eventType).toBe("lead_nurture_decision");

    // First repeat sees the flipped world-state (handoff now exists) ⇒ a new
    // converged decision identity bound to the SAME handoff; a further repeat
    // of the unchanged world ⇒ idempotent replay (cases 15/16).
    const r2 = await evaluateNurture(makeDeps(h), IDS.userId, { qualificationId: IDS.qualificationId });
    expect(r2.decision.handoffId).toBe(r1.decision.handoffId);
    expect(h.table("approval_requests")).toHaveLength(1);
    expect(h.table("sales_handoffs")).toHaveLength(1);
    expect(h.table("nurture_handoff_decisions")).toHaveLength(2);

    const r3 = await evaluateNurture(makeDeps(h), IDS.userId, { qualificationId: IDS.qualificationId });
    expect(r3.duplicateClassification).toBe("idempotent_replay");
    expect(r3.decision.nurtureDecisionId).toBe(r2.decision.nurtureDecisionId);
    expect(h.table("approval_requests")).toHaveLength(1);
    expect(h.table("sales_handoffs")).toHaveLength(1);
    expect(h.table("nurture_handoff_decisions")).toHaveLength(2);
    expect(h.auditEvents()).toHaveLength(2); // one per inserted decision only
  });

  it("second evaluation after handoff exists produces the converged world-state decision (case 24)", async () => {
    const h = createNurtureHarness({ now: NOW });
    seedLead(h);
    const r1 = await evaluateNurture(makeDeps(h), IDS.userId, { qualificationId: IDS.qualificationId });
    const r2 = await evaluateNurture(makeDeps(h), IDS.userId, { qualificationId: IDS.qualificationId });
    // handoffExists flipped ⇒ different decision identity, same handoff.
    expect(r2.decision.nurtureDecisionId).not.toBe(r1.decision.nurtureDecisionId);
    expect(r2.decision.decision).toBe("SALES_HANDOFF");
    expect(h.table("sales_handoffs")).toHaveLength(1);
    expect(h.table("nurture_handoff_decisions")).toHaveLength(2);
  });

  it("QUALIFIED + channel ⇒ NURTURE; cadence-bounded touch executes exactly once through the fake transport", async () => {
    const h = createNurtureHarness({ now: NOW });
    seedLead(h);
    const r = await evaluateNurture(makeDeps(h), IDS.userId, {
      qualificationId: IDS.qualificationId,
      channel: "email",
    });
    expect(r.decision.decision).toBe("NURTURE");
    expect(r.handoff).toBeNull();

    const draft = { channel: "email", subject: "Hi", body: "Your plan is ready.", cta: "Reply" };
    const t1 = await dispatchNurtureTouch(makeDeps(h), IDS.userId, {
      nurtureDecisionId: r.decision.nurtureDecisionId,
      draft,
    });
    expect(t1.outcome).toBe("ACCEPTED");
    expect(t1.duplicateClassification).toBe("inserted");
    expect(h.table("nurture_touch_records")).toHaveLength(1);
    expect(h.auditEvents().map((e) => e.eventType)).toContain("lead_nurture_touch");

    // An identical repeat is a NEW attempt — the cadence gate blocks it, so a
    // successful touch can never double-send (exact-once by construction).
    await expect(
      dispatchNurtureTouch(makeDeps(h), IDS.userId, {
        nurtureDecisionId: r.decision.nurtureDecisionId,
        draft,
      })
    ).rejects.toMatchObject({ code: "DECISION_NOT_EXECUTABLE" });
    expect(h.table("nurture_touch_records")).toHaveLength(1);
  });

  it("cadence gate blocks a second touch inside the interval (case 18)", async () => {
    const h = createNurtureHarness({ now: NOW });
    seedLead(h);
    const r = await evaluateNurture(makeDeps(h), IDS.userId, {
      qualificationId: IDS.qualificationId,
      channel: "email",
    });
    await dispatchNurtureTouch(makeDeps(h), IDS.userId, {
      nurtureDecisionId: r.decision.nurtureDecisionId,
      draft: { channel: "email", body: "First touch." },
    });
    // Forge a second decision identity by ticking the clock past nothing —
    // the SAME decision remains valid, so a second touch hits the cadence gate.
    await expect(
      dispatchNurtureTouch(makeDeps(h), IDS.userId, {
        nurtureDecisionId: r.decision.nurtureDecisionId,
        draft: { channel: "email", body: "Second touch too soon." },
      })
    ).rejects.toMatchObject({ code: "DECISION_NOT_EXECUTABLE" });
    expect(h.table("nurture_touch_records")).toHaveLength(1);
  });
});

describe("approval gate (cases 21–23, 25)", () => {
  async function prepared() {
    const h = createNurtureHarness({ now: NOW });
    seedLead(h);
    const r = await evaluateNurture(makeDeps(h), IDS.userId, { qualificationId: IDS.qualificationId });
    return { h, r };
  }

  it("dispatch before human approval fails closed (no self-approval path)", async () => {
    const { h, r } = await prepared();
    await expect(
      dispatchHandoff(makeDeps(h), IDS.userId, { handoffId: r.decision.handoffId! })
    ).rejects.toMatchObject({ code: "APPROVAL_PENDING" });
    expect(h.table("handoff_dispatch_receipts")).toHaveLength(0);
  });

  it("human approval ⇒ dispatch ACCEPTED through the fake seam; retry converges (cases 28–29)", async () => {
    const { h, r } = await prepared();
    h.approve(r.decision.approvalRequestId!);
    const d1 = await dispatchHandoff(makeDeps(h), IDS.userId, { handoffId: r.decision.handoffId! });
    expect(d1.outcome).toBe("ACCEPTED");
    expect(d1.handoffStatus).toBe("DISPATCHED");
    expect(h.table("handoff_dispatch_receipts")).toHaveLength(1);
    expect(h.table("handoff_dispatch_receipts")[0].providerAck).toMatch(/fake/i); // test-only ack, honestly labeled

    // Duplicate dispatch of an already-DISPATCHED handoff fails closed on the
    // lifecycle claim — no duplicate external effect (case 29).
    await expect(
      dispatchHandoff(makeDeps(h), IDS.userId, { handoffId: r.decision.handoffId! })
    ).rejects.toMatchObject({ code: "HANDOFF_STATE_CONFLICT" });
    expect(h.table("handoff_dispatch_receipts")).toHaveLength(1);
    expect(h.table("sales_handoffs").map((s) => s.handoffStatus)).toEqual(["DISPATCHED"]);
  });

  it("human rejection permanently blocks the handoff identity", async () => {
    const { h, r } = await prepared();
    h.reject(r.decision.approvalRequestId!);
    await expect(
      dispatchHandoff(makeDeps(h), IDS.userId, { handoffId: r.decision.handoffId! })
    ).rejects.toMatchObject({ code: "ACTION_REJECTED_BY_HUMAN" });
  });

  it("forged approval replay (tampered binding) rejected at dispatch", async () => {
    const { h, r } = await prepared();
    h.approve(r.decision.approvalRequestId!);
    // Tamper with the durable binding: different handoff id in context.
    const approvalRow = h.table("approval_requests")[0];
    const context = approvalRow.context as { salesHandoffBinding: { handoffId: string } };
    context.salesHandoffBinding.handoffId = `sh1:${HEX("0")}`;
    await expect(
      dispatchHandoff(makeDeps(h), IDS.userId, { handoffId: r.decision.handoffId! })
    ).rejects.toMatchObject({ code: "APPROVAL_BINDING_MISMATCH" });
  });

  it("client cannot fabricate success: ACKNOWLEDGED is never client-settable", async () => {
    const { h, r } = await prepared();
    h.approve(r.decision.approvalRequestId!);
    const d = await dispatchHandoff(makeDeps(h), IDS.userId, { handoffId: r.decision.handoffId! });
    expect(d.handoffStatus).toBe("DISPATCHED"); // honest state; no client success anywhere
    const row = h.table("sales_handoffs")[0];
    expect(row.handoffStatus).not.toBe("ACKNOWLEDGED");
    expect(row.acknowledgedAt).toBeNull();
  });
});

describe("reconciliation (case 28)", () => {
  it("failed dispatch reconciles safely; duplicate reconcile converges", async () => {
    const h = createNurtureHarness({ now: NOW, failFirstTransportAttempts: 1 });
    seedLead(h);
    const r = await evaluateNurture(makeDeps(h), IDS.userId, { qualificationId: IDS.qualificationId });
    h.approve(r.decision.approvalRequestId!);

    const d1 = await dispatchHandoff(makeDeps(h), IDS.userId, { handoffId: r.decision.handoffId! });
    expect(d1.outcome).toBe("FAILURE");
    expect(d1.handoffStatus).toBe("FAILED");

    const rec = await reconcileHandoff(makeDeps(h), IDS.userId, { handoffId: r.decision.handoffId! });
    expect(rec.result?.outcome).toBe("ACCEPTED");
    expect(rec.handoffStatus).toBe("DISPATCHED");
    expect(h.table("handoff_dispatch_receipts")).toHaveLength(2); // two attempts, distinct identities

    const again = await reconcileHandoff(makeDeps(h), IDS.userId, { handoffId: r.decision.handoffId! });
    expect(again.converged).toBe(true);
    expect(again.result).toBeNull();
    expect(h.table("handoff_dispatch_receipts")).toHaveLength(2);
  });
});

describe("privacy / conversion / staleness overrides (cases 7–9, 13–14, 6)", () => {
  it("suppressed after decision blocks execution (privacy re-read at execution)", async () => {
    const h = createNurtureHarness({ now: NOW });
    seedLead(h);
    const r = await evaluateNurture(makeDeps(h), IDS.userId, { qualificationId: IDS.qualificationId });
    h.approve(r.decision.approvalRequestId!);
    h.setPrivacyState(IDS.leadId, "SUPPRESSED");
    await expect(
      dispatchHandoff(makeDeps(h), IDS.userId, { handoffId: r.decision.handoffId! })
    ).rejects.toMatchObject({ code: "PRIVACY_STATE_UNAVAILABLE" });
  });

  it("fresh evaluation of a suppressed lead ⇒ BLOCKED PRIVACY_SUPPRESSED and F-compatible view", async () => {
    const h = createNurtureHarness({ now: NOW });
    seedLead(h);
    h.setPrivacyState(IDS.leadId, "SUPPRESSED");
    const r = await evaluateNurture(makeDeps(h), IDS.userId, { qualificationId: IDS.qualificationId });
    expect(r.decision.decision).toBe("BLOCKED");
    expect(r.decision.reasonCodes).toEqual(["PRIVACY_SUPPRESSED"]);
    const view = await getLeadNurtureHandoffView(makeDeps(h), IDS.userId, IDS.leadId);
    expect(view.nurtureStatus).toBe("blocked");
    expect(view.blockedReason).toBe("PRIVACY_SUPPRESSED");
  });

  it("authoritative conversion stops progression and blocks dispatch (case 14)", async () => {
    const h = createNurtureHarness({ now: NOW });
    seedLead(h);
    h.setConversions(IDS.leadId, [
      { conversionId: "cnv1:x", businessId: IDS.businessId, outcomeStatus: "CONFIRMED", sourceTrustClass: "VERIFIED_PAYMENT", occurredAt: NOW },
    ]);
    const r = await evaluateNurture(makeDeps(h), IDS.userId, { qualificationId: IDS.qualificationId });
    expect(r.decision.decision).toBe("NO_ACTION");
    expect(r.decision.reasonCodes).toEqual(["CONVERSION_STOP"]);
    expect(r.handoff).toBeNull();

    // A stale prepared handoff from before the conversion is blocked at dispatch.
    h.setConversions(IDS.leadId, []);
    const r2 = await evaluateNurture(makeDeps(h), IDS.userId, { qualificationId: IDS.qualificationId });
    h.approve(r2.decision.approvalRequestId!);
    h.setConversions(IDS.leadId, [
      { conversionId: "cnv1:y", businessId: IDS.businessId, outcomeStatus: "CONFIRMED", sourceTrustClass: "USER_REPORTED", occurredAt: NOW },
    ]);
    await expect(
      dispatchHandoff(makeDeps(h), IDS.userId, { handoffId: r2.decision.handoffId! })
    ).rejects.toMatchObject({ code: "HANDOFF_STATE_CONFLICT" });
  });

  it("stale qualification cannot progress (case 6)", async () => {
    const h = createNurtureHarness({ now: NOW });
    seedLead(h);
    const r = await evaluateNurture(makeDeps(h), IDS.userId, { qualificationId: IDS.qualificationId });
    h.approve(r.decision.approvalRequestId!);
    // The qualification decays (projection re-read at execution shows expiry).
    h.setProjection(
      IDS.qualificationId,
      makeQualificationFixture(IDS, { validUntil: "2026-06-01T00:00:00.000Z", mayProgress: false, progressBlockedReason: "STALE_DECISION" })
    );
    await expect(
      dispatchHandoff(makeDeps(h), IDS.userId, { handoffId: r.decision.handoffId! })
    ).rejects.toMatchObject({ code: "EXPIRED_DECISION" });
  });
});

describe("cross-agent trust + tenant isolation (cases 10–13)", () => {
  it("cross-business lead rejected; forged lead rejected; forged qualification rejected", async () => {
    const h = createNurtureHarness({ now: NOW });
    seedLead(h);
    h.setIdentity(IDS.leadId, makeIdentityFixture({ ...IDS, businessId: 99 }));
    await expect(
      evaluateNurture(makeDeps(h), IDS.userId, { qualificationId: IDS.qualificationId })
    ).rejects.toMatchObject({ code: "OWNERSHIP_MISMATCH" });

    h.setIdentity(IDS.leadId, null);
    await expect(
      evaluateNurture(makeDeps(h), IDS.userId, { qualificationId: IDS.qualificationId })
    ).rejects.toMatchObject({ code: "OWNERSHIP_MISMATCH" });

    h.setIdentity(IDS.leadId, makeIdentityFixture(IDS));
    h.setProjection(IDS.qualificationId, null);
    await expect(
      evaluateNurture(makeDeps(h), IDS.userId, { qualificationId: IDS.qualificationId })
    ).rejects.toMatchObject({ code: "QUALIFICATION_NOT_FOUND" });
  });

  it("malformed/tampered projection fails closed with the mismatch code (case 12)", async () => {
    const h = createNurtureHarness({ now: NOW });
    seedLead(h);
    h.setProjection(IDS.qualificationId, { ...makeQualificationFixture(IDS), mayProgress: "yes" });
    await expect(
      evaluateNurture(makeDeps(h), IDS.userId, { qualificationId: IDS.qualificationId })
    ).rejects.toMatchObject({ code: "NURTURE_UPSTREAM_CONTRACT_MISMATCH" });
  });

  it("unsupported contract version rejected (stale upstream)", async () => {
    const h = createNurtureHarness({ now: NOW });
    seedLead(h);
    h.setProjection(IDS.qualificationId, makeQualificationFixture(IDS, { engineVersion: "lead-qualification/v99" }));
    await expect(
      evaluateNurture(makeDeps(h), IDS.userId, { qualificationId: IDS.qualificationId })
    ).rejects.toMatchObject({ code: "NURTURE_UPSTREAM_CONTRACT_MISMATCH" });
  });

  it("another tenant cannot read or replay this tenant's decisions/handoffs", async () => {
    const h = createNurtureHarness({ now: NOW });
    seedLead(h);
    const r = await evaluateNurture(makeDeps(h), IDS.userId, { qualificationId: IDS.qualificationId });
    const { getDecisionById, getHandoffById } = await import("./nurture-store");
    expect(await getDecisionById(999, r.decision.nurtureDecisionId, h.executor as never)).toBeNull();
    expect(await getHandoffById(999, r.decision.handoffId!, h.executor as never)).toBeNull();
  });
});

describe("capability fail-closed (cases 26–27)", () => {
  it("real CRM provider is UNSUPPORTED — dispatch fails closed, no fabrication", async () => {
    const h = createNurtureHarness({ now: NOW });
    seedLead(h);
    const r = await evaluateNurture(makeDeps(h), IDS.userId, { qualificationId: IDS.qualificationId });
    h.approve(r.decision.approvalRequestId!);
    const deps = { ...makeDeps(h), transport: Object.assign(h.transport, { providerId: "salesforce" }) };
    await expect(dispatchHandoff(deps, IDS.userId, { handoffId: r.decision.handoffId! })).rejects.toMatchObject({
      code: "CAPABILITY_UNSUPPORTED",
    });
    expect(h.table("handoff_dispatch_receipts")).toHaveLength(0);
  });

  it("no transport wired ⇒ dispatch fails closed", async () => {
    const h = createNurtureHarness({ now: NOW });
    seedLead(h);
    const r = await evaluateNurture(makeDeps(h), IDS.userId, { qualificationId: IDS.qualificationId });
    h.approve(r.decision.approvalRequestId!);
    const deps = makeDeps(h);
    delete deps.transport;
    await expect(dispatchHandoff(deps, IDS.userId, { handoffId: r.decision.handoffId! })).rejects.toMatchObject({
      code: "CAPABILITY_UNSUPPORTED",
    });
  });

  it("schema unavailable ⇒ every entry point fails closed", async () => {
    const h = createNurtureHarness({ now: NOW, availableTables: [] });
    seedLead(h);
    await expect(
      evaluateNurture(makeDeps(h), IDS.userId, { qualificationId: IDS.qualificationId })
    ).rejects.toMatchObject({ code: "NURTURE_SCHEMA_UNAVAILABLE" });
  });
});

describe("store — conflicting replay fails closed (case 17)", () => {
  it("same decision identity with different material ⇒ NURTURE_REPLAY_CONFLICT", async () => {
    const h = createNurtureHarness({ now: NOW });
    seedLead(h);
    const r = await evaluateNurture(makeDeps(h), IDS.userId, { qualificationId: IDS.qualificationId });
    const { getDecisionById } = await import("./nurture-store");
    const row = await getDecisionById(IDS.userId, r.decision.nurtureDecisionId, h.executor as never);
    expect(row).not.toBeNull();
    const tampered = { ...row!, decision: "NURTURE", channel: "email" as const };
    await expect(recordDecision(tampered as never, h.executor as never)).rejects.toMatchObject({
      code: "NURTURE_REPLAY_CONFLICT",
    });
  });
});

describe("policy version staleness (case 6 gates)", () => {
  it("dispatch under a changed policy version ⇒ STALE_POLICY_VERSION", async () => {
    const h = createNurtureHarness({ now: NOW });
    seedLead(h);
    const r = await evaluateNurture(makeDeps(h), IDS.userId, { qualificationId: IDS.qualificationId });
    h.approve(r.decision.approvalRequestId!);
    const changed = buildNurtureHandoffPolicy({ ...buildDefaultNurturePolicyConfig(), decisionTtlHours: 48 });
    const deps = { ...makeDeps(h), resolvePolicy: async () => changed };
    await expect(dispatchHandoff(deps, IDS.userId, { handoffId: r.decision.handoffId! })).rejects.toMatchObject({
      code: "STALE_POLICY_VERSION",
    });
  });
});

describe("audit discipline (case 30)", () => {
  it("exactly one audit event per material effect; replays emit nothing", async () => {
    const h = createNurtureHarness({ now: NOW });
    seedLead(h);
    const r = await evaluateNurture(makeDeps(h), IDS.userId, { qualificationId: IDS.qualificationId });
    h.approve(r.decision.approvalRequestId!);
    await dispatchHandoff(makeDeps(h), IDS.userId, { handoffId: r.decision.handoffId! });
    const types = h.auditEvents().map((e) => e.eventType);
    expect(types.filter((t) => t === "lead_nurture_decision")).toHaveLength(1);
    expect(types.filter((t) => t === "sales_handoff_dispatch")).toHaveLength(1);

    await expect(
      dispatchHandoff(makeDeps(h), IDS.userId, { handoffId: r.decision.handoffId! })
    ).rejects.toMatchObject({ code: "HANDOFF_STATE_CONFLICT" });
    expect(h.auditEvents().filter((e) => e.eventType === "sales_handoff_dispatch")).toHaveLength(1);
  });

  it("audit metadata carries ids/labels only — no PII or message text (scan)", async () => {
    const h = createNurtureHarness({ now: NOW });
    seedLead(h);
    const r = await evaluateNurture(makeDeps(h), IDS.userId, { qualificationId: IDS.qualificationId });
    h.approve(r.decision.approvalRequestId!);
    await dispatchHandoff(makeDeps(h), IDS.userId, { handoffId: r.decision.handoffId! });
    await dispatchNurtureTouch(makeDeps(h), IDS.userId, {
      nurtureDecisionId: (
        await evaluateNurture(makeDeps(h), IDS.userId, { qualificationId: IDS.qualificationId, channel: "email" })
      ).decision.nurtureDecisionId,
      draft: { channel: "email", body: "Hello there — your plan is ready." },
    });
    for (const event of h.auditEvents()) {
      const serialized = JSON.stringify(event.metadata ?? {});
      expect(serialized).not.toMatch(/hello there|your plan is ready|@|\+27|test-lead/i);
      expect(serialized.length).toBeLessThan(2000);
    }
  });
});
