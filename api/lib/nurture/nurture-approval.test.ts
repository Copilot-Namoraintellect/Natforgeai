// WBS-R6-D — sales-handoff approval binding acceptance (contract §9; cases 21–23).
import { describe, it, expect } from "vitest";
import {
  buildHandoffApprovalCommand,
  buildHandoffApprovalIdempotencyKey,
  readSalesHandoffApprovalBinding,
  assertHandoffApprovalExecutable,
  validateHandoffApprovalAuthorizable,
  SALES_HANDOFF_APPROVAL_TYPE,
  SALES_HANDOFF_APPROVAL_CONTRACT_VERSION,
  type SalesHandoffApprovalView,
} from "./nurture-approval";
import { NurtureError } from "./nurture-contract";

const HANDOFF_ID = "sh1:" + "a".repeat(64);
const NOW = "2026-06-28T12:00:00.000Z";
const LATER = "2026-06-29T00:00:00.000Z";

const HANDOFF = {
  handoffId: HANDOFF_ID,
  handoffPolicyVersion: "nurture-handoff-policy/v1",
  contentSnapshotHash: "c".repeat(64),
};

function command() {
  return buildHandoffApprovalCommand({
    handoffId: HANDOFF_ID,
    nurtureDecisionId: "nd1:" + "b".repeat(64),
    userId: 7,
    businessId: 42,
    leadId: "lid1:" + "d".repeat(64),
    qualificationId: "lqu1:" + "e".repeat(64),
    qualificationFingerprint: "f".repeat(64),
    handoffPolicyVersion: "nurture-handoff-policy/v1",
    contentSnapshotHash: "c".repeat(64),
    expiresAt: LATER,
    reasonCodes: ["APPROVAL_REQUIRED_BY_POLICY"],
  });
}

function approvedView(binding = command().context.salesHandoffBinding): SalesHandoffApprovalView {
  return { id: 9, status: "approved", context: { salesHandoffBinding: binding } };
}

describe("approval command construction", () => {
  it("uses the additive sales_handoff type with a deterministic idempotency key", () => {
    const cmd = command();
    expect(cmd.approvalType).toBe(SALES_HANDOFF_APPROVAL_TYPE);
    expect(cmd.userId).toBe(7);
    expect(cmd.campaignId).toBeNull();
    expect(cmd.riskLevel).toBe("high");
    expect(cmd.idempotencyKey).toBe(buildHandoffApprovalIdempotencyKey(HANDOFF_ID));
    expect(buildHandoffApprovalIdempotencyKey(HANDOFF_ID)).toBe(
      buildHandoffApprovalIdempotencyKey(HANDOFF_ID)
    );
    const other = buildHandoffApprovalIdempotencyKey("sh1:" + "0".repeat(64));
    expect(other).not.toBe(cmd.idempotencyKey);
    expect(cmd.idempotencyKey.startsWith("shf1:")).toBe(true);
  });

  it("binding pins identity + policy version + content snapshot + expiry", () => {
    const binding = command().context.salesHandoffBinding;
    expect(binding.contractVersion).toBe(SALES_HANDOFF_APPROVAL_CONTRACT_VERSION);
    expect(binding.handoffId).toBe(HANDOFF_ID);
    expect(binding.handoffPolicyVersion).toBe("nurture-handoff-policy/v1");
    expect(binding.contentSnapshotHash).toBe("c".repeat(64));
    expect(binding.expiresAt).toBe(LATER);
    expect(readSalesHandoffApprovalBinding({ salesHandoffBinding: binding })).toEqual(binding);
    expect(readSalesHandoffApprovalBinding({ unrelated: true })).toBeNull();
    expect(readSalesHandoffApprovalBinding(null)).toBeNull();
  });
});

describe("assertHandoffApprovalExecutable — the single execution gate", () => {
  it("approved + matching binding + current policy ⇒ executable", () => {
    const v = assertHandoffApprovalExecutable({
      ...HANDOFF,
      approval: approvedView(),
      currentPolicyVersion: "nurture-handoff-policy/v1",
      now: NOW,
    });
    expect(v.executable).toBe(true);
    if (v.executable) {
      expect(v.authorization.approvalRequestId).toBe(9);
      expect(v.authorization.handoffId).toBe(HANDOFF_ID);
      expect(v.authorization.expiresAt).toBe(LATER);
    }
  });

  it("case 22: forged approval (binding mismatch) rejected", () => {
    const v = assertHandoffApprovalExecutable({
      ...HANDOFF,
      approval: approvedView({ ...command().context.salesHandoffBinding, handoffId: "sh1:" + "9".repeat(64) }),
      currentPolicyVersion: "nurture-handoff-policy/v1",
      now: NOW,
    });
    expect(v.executable).toBe(false);
    if (!v.executable) expect(v.reason).toBe("APPROVAL_BINDING_MISMATCH");
  });

  it("case 23: cross-lead / cross-business replay rejected (content snapshot + identity binding)", () => {
    // same approval row replayed against a different handoff/content snapshot
    const v = assertHandoffApprovalExecutable({
      ...HANDOFF,
      contentSnapshotHash: "0".repeat(64),
      approval: approvedView(),
      currentPolicyVersion: "nurture-handoff-policy/v1",
      now: NOW,
    });
    expect(v.executable).toBe(false);
    if (!v.executable) expect(v.reason).toBe("APPROVAL_BINDING_MISMATCH");
  });

  it("pending ⇒ not executable yet; rejected ⇒ permanent", () => {
    const pending = assertHandoffApprovalExecutable({
      ...HANDOFF,
      approval: { id: 9, status: "pending", context: command().context },
      currentPolicyVersion: "nurture-handoff-policy/v1",
      now: NOW,
    });
    expect(pending.executable).toBe(false);
    if (!pending.executable) expect(pending.reason).toBe("APPROVAL_PENDING");

    const rejected = assertHandoffApprovalExecutable({
      ...HANDOFF,
      approval: { id: 9, status: "rejected", context: command().context },
      currentPolicyVersion: "nurture-handoff-policy/v1",
      now: NOW,
    });
    expect(rejected.executable).toBe(false);
    if (!rejected.executable) {
      expect(rejected.reason).toBe("ACTION_REJECTED_BY_HUMAN");
      expect(rejected.permanent).toBe(true);
    }
  });

  it("stale policy version and expired bindings rejected (cases 6/9 gates)", () => {
    const stale = assertHandoffApprovalExecutable({
      ...HANDOFF,
      approval: approvedView(),
      currentPolicyVersion: "nurture-handoff-policy/v1+deadbeef",
      now: NOW,
    });
    expect(stale.executable).toBe(false);
    if (!stale.executable) expect(stale.reason).toBe("STALE_POLICY_VERSION");

    const expired = assertHandoffApprovalExecutable({
      ...HANDOFF,
      approval: approvedView(),
      currentPolicyVersion: "nurture-handoff-policy/v1",
      now: "2026-06-30T00:00:00.000Z",
    });
    expect(expired.executable).toBe(false);
    if (!expired.executable) expect(expired.reason).toBe("EXPIRED_DECISION");
  });

  it("null approval ⇒ APPROVAL_NOT_FOUND", () => {
    const v = assertHandoffApprovalExecutable({
      ...HANDOFF,
      approval: null,
      currentPolicyVersion: "nurture-handoff-policy/v1",
      now: NOW,
    });
    expect(v.executable).toBe(false);
    if (!v.executable) expect(v.reason).toBe("APPROVAL_NOT_FOUND");
  });
});

describe("validateHandoffApprovalAuthorizable — in-transaction gate", () => {
  it("accepts a fresh pending binding; rejects stale/expired/mismatched", () => {
    const pendingView: SalesHandoffApprovalView = { id: 9, status: "pending", context: command().context };
    expect(() =>
      validateHandoffApprovalAuthorizable({
        approval: pendingView,
        handoff: HANDOFF,
        currentPolicyVersion: "nurture-handoff-policy/v1",
        now: NOW,
      })
    ).not.toThrow();

    expect(() =>
      validateHandoffApprovalAuthorizable({
        approval: { ...pendingView, status: "approved" },
        handoff: HANDOFF,
        currentPolicyVersion: "nurture-handoff-policy/v1",
        now: NOW,
      })
    ).toThrow(NurtureError);

    expect(() =>
      validateHandoffApprovalAuthorizable({
        approval: pendingView,
        handoff: { ...HANDOFF, contentSnapshotHash: "0".repeat(64) },
        currentPolicyVersion: "nurture-handoff-policy/v1",
        now: NOW,
      })
    ).toThrow(/APPROVAL_BINDING_MISMATCH/);

    expect(() =>
      validateHandoffApprovalAuthorizable({
        approval: pendingView,
        handoff: HANDOFF,
        currentPolicyVersion: "nurture-handoff-policy/v1+deadbeef",
        now: NOW,
      })
    ).toThrow(/STALE_POLICY_VERSION/);

    expect(() =>
      validateHandoffApprovalAuthorizable({
        approval: pendingView,
        handoff: HANDOFF,
        currentPolicyVersion: "nurture-handoff-policy/v1",
        now: "2026-06-30T00:00:00.000Z",
      })
    ).toThrow(/EXPIRED_DECISION/);
  });
});
