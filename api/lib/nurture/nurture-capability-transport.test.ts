// WBS-R6-D — provider capability truth + execution seam acceptance (contract §10–§11).
import { describe, it, expect } from "vitest";
import {
  resolveNurtureCapability,
  assertCapabilityDispatchable,
  capabilityReasonCode,
  FAKE_TEST_PROVIDER,
  NURTURE_CAPABILITY_VIEW_VERSION,
} from "./nurture-provider-capability";
import {
  createFakeNurtureTransport,
  FAKE_TRANSPORT_ACK,
  type HandoffDispatchCommand,
} from "./nurture-transport";
import { deriveExecutionIdentity } from "./nurture-identity";
import { validateNurtureDraft, buildDispatchContent } from "./nurture-content-boundary";
import { NurtureError } from "./nurture-contract";

describe("truthful capability matrix (no parallel matrix, no simulation)", () => {
  it("real providers: email REQUIRES_CONFIGURATION, whatsapp/sms/crm UNSUPPORTED", () => {
    expect(resolveNurtureCapability({ channel: "email", provider: "sendgrid" }).state).toBe(
      "REQUIRES_CONFIGURATION"
    );
    expect(resolveNurtureCapability({ channel: "whatsapp" }).state).toBe("UNSUPPORTED");
    expect(resolveNurtureCapability({ channel: "sms" }).state).toBe("UNSUPPORTED");
    expect(resolveNurtureCapability({ channel: "crm", provider: "salesforce" }).state).toBe(
      "UNSUPPORTED"
    );
    expect(resolveNurtureCapability({ channel: "email", provider: "unknown-x" }).state).toBe(
      "REQUIRES_CONFIGURATION"
    );
  });

  it("the fake_test provider is SUPPORTED for every channel and self-describes", () => {
    for (const channel of ["email", "whatsapp", "sms", "crm"] as const) {
      const d = resolveNurtureCapability({ channel, provider: FAKE_TEST_PROVIDER });
      expect(d.state).toBe("SUPPORTED");
      expect(d.reason).toMatch(/fake/i);
    }
    expect(NURTURE_CAPABILITY_VIEW_VERSION).toBe("nurture-capability-view/v1");
  });

  it("fail-closed gate: only SUPPORTED dispatches (case 26)", () => {
    expect(() =>
      assertCapabilityDispatchable(resolveNurtureCapability({ channel: "crm", provider: "salesforce" }))
    ).toThrow(NurtureError);
    expect(() =>
      assertCapabilityDispatchable(resolveNurtureCapability({ channel: "email", provider: "sendgrid" }))
    ).toThrow(/CAPABILITY_UNSUPPORTED/);
    expect(() =>
      assertCapabilityDispatchable(resolveNurtureCapability({ channel: "email", provider: FAKE_TEST_PROVIDER }))
    ).not.toThrow();
  });

  it("reason-code family mapping", () => {
    expect(
      capabilityReasonCode(resolveNurtureCapability({ channel: "whatsapp" }))
    ).toBe("CAPABILITY_UNSUPPORTED");
    expect(
      capabilityReasonCode(resolveNurtureCapability({ channel: "email", provider: "sendgrid" }))
    ).toBe("CAPABILITY_REQUIRES_CONFIGURATION");
  });
});

function fakeCommand(executionIdentity: string): HandoffDispatchCommand {
  const draft = validateNurtureDraft({
    channel: "email",
    subject: "Handoff summary",
    body: "The qualified lead is ready for sales follow-up.",
  });
  return {
    executionIdentity,
    handoffId: "sh1:" + "a".repeat(64),
    userId: 7,
    businessId: 42,
    leadId: "lid1:" + "b".repeat(64),
    channel: "email",
    content: buildDispatchContent(draft),
  };
}

describe("fake/test-only transport (contract §11, cases 27–29)", () => {
  it("is explicitly fake: accepted ack self-describes, no network I/O exists", () => {
    const t = createFakeNurtureTransport({ now: "2026-06-28T12:00:00.000Z" });
    expect(t.attempts.length).toBe(0);
    return t.dispatch(fakeCommand("hd1:" + "c".repeat(64))).then((r) => {
      expect(r.outcome).toBe("ACCEPTED");
      expect(r.providerAck).toBe(FAKE_TRANSPORT_ACK);
      expect(r.providerAck).toMatch(/fake/i);
      expect(r.occurredAt).toBe("2026-06-28T12:00:00.000Z");
    });
  });

  it("replay of the same executionIdentity converges to the FIRST outcome — no duplicate effect", async () => {
    const t = createFakeNurtureTransport();
    const cmd = fakeCommand("hd1:" + "d".repeat(64));
    const r1 = await t.dispatch(cmd);
    const r2 = await t.dispatch(cmd);
    expect(r2).toBe(r1);
    expect(t.attempts.length).toBe(2); // both attempts recorded...
    expect(t.outcomes.size).toBe(1); // ...but one external effect
  });

  it("failed attempts can reconcile: distinct attemptSeq = distinct identity", async () => {
    const t = createFakeNurtureTransport({ failFirstAttempts: 1 });
    const h = "sh1:" + "e".repeat(64);
    const r1 = await t.dispatch(fakeCommandDerived(t, h, 1));
    expect(r1.outcome).toBe("FAILURE");
    const r2 = await t.dispatch(fakeCommandDerived(t, h, 2));
    expect(r2.outcome).toBe("ACCEPTED");
    expect(t.outcomes.size).toBe(2);
  });

  it("rejectAll simulates provider-side rejection honestly (never fakes success)", async () => {
    const t = createFakeNurtureTransport({ rejectAll: true });
    const r = await t.dispatch(fakeCommand("hd1:" + "f".repeat(64)));
    expect(r.outcome).toBe("REJECTED");
    expect(r.providerAck).toBeNull();
  });
});

// helper that derives a stable execution identity per attempt for the reconcile test
function fakeCommandDerived(
  _t: unknown,
  handoffId: string,
  attemptSeq: number
): HandoffDispatchCommand {
  const cmd = fakeCommand(deriveExecutionIdentity(handoffId, attemptSeq));
  return { ...cmd, handoffId };
}
