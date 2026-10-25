import { describe, expect, it } from "vitest";
import {
  LEAD_PRIVACY_STATE_VALUES,
  leadPrivacyEvidenceFromRow,
  leadPrivacyGateFor,
  resolvePrivacyGate,
} from "./qualification-governance-seam";

describe("leadPrivacyGateFor — R6-F mirror", () => {
  it("maps every closed state to the governed outcome", () => {
    expect(leadPrivacyGateFor("ACTIVE")).toEqual({ state: "ACTIVE", actionable: true, blockedReason: null });
    expect(leadPrivacyGateFor("RETENTION_PENDING")).toEqual({
      state: "RETENTION_PENDING",
      actionable: true,
      blockedReason: null,
    });
    expect(leadPrivacyGateFor("SUPPRESSED")).toEqual({
      state: "SUPPRESSED",
      actionable: false,
      blockedReason: "PRIVACY_SUPPRESSED",
    });
    expect(leadPrivacyGateFor("RESTRICTED")).toEqual({
      state: "RESTRICTED",
      actionable: false,
      blockedReason: "PRIVACY_SUPPRESSED",
    });
    expect(leadPrivacyGateFor("RETENTION_EXPIRED")).toEqual({
      state: "RETENTION_EXPIRED",
      actionable: false,
      blockedReason: "RETENTION_EXPIRED",
    });
    expect(leadPrivacyGateFor("ARCHIVED")).toEqual({
      state: "ARCHIVED",
      actionable: false,
      blockedReason: "RETENTION_EXPIRED",
    });
  });

  it("fails closed on an unknown state", () => {
    expect(() => leadPrivacyGateFor("DELETED")).toThrowError(
      expect.objectContaining({ name: "QualificationValidationError", code: "PRIVACY_STATE_INVALID" })
    );
  });
});

describe("resolvePrivacyGate", () => {
  it("degrades an absent row to ACTIVE (honest default)", () => {
    expect(resolvePrivacyGate(null)).toEqual({ state: "ACTIVE", actionable: true, blockedReason: null });
    expect(resolvePrivacyGate(undefined)).toEqual({
      state: "ACTIVE",
      actionable: true,
      blockedReason: null,
    });
  });

  it("resolves each governed state", () => {
    for (const state of LEAD_PRIVACY_STATE_VALUES) {
      const gate = resolvePrivacyGate({ state });
      expect(gate.state).toBe(state);
      if (state === "ACTIVE" || state === "RETENTION_PENDING") {
        expect(gate.actionable).toBe(true);
        expect(gate.blockedReason).toBeNull();
      } else if (state === "SUPPRESSED" || state === "RESTRICTED") {
        expect(gate.actionable).toBe(false);
        expect(gate.blockedReason).toBe("PRIVACY_SUPPRESSED");
      } else {
        expect(gate.actionable).toBe(false);
        expect(gate.blockedReason).toBe("RETENTION_EXPIRED");
      }
    }
  });

  it("honors an absent state only when the bridge reports the row unavailable", () => {
    expect(resolvePrivacyGate({ available: false })).toEqual({
      state: "ACTIVE",
      actionable: true,
      blockedReason: null,
    });
    expect(() => resolvePrivacyGate({ available: true })).toThrowError(
      expect.objectContaining({ code: "PRIVACY_STATE_INVALID" })
    );
    expect(() => resolvePrivacyGate({})).toThrowError(
      expect.objectContaining({ code: "PRIVACY_STATE_INVALID" })
    );
  });

  it("rejects a present-but-unknown state string", () => {
    expect(() => resolvePrivacyGate({ state: "GONE" })).toThrowError(
      expect.objectContaining({ name: "QualificationValidationError", code: "PRIVACY_STATE_INVALID" })
    );
    expect(() => resolvePrivacyGate({ state: 42 })).toThrowError(
      expect.objectContaining({ code: "PRIVACY_STATE_INVALID" })
    );
  });

  it("rejects keys outside the closed subset", () => {
    expect(() => resolvePrivacyGate({ state: "ACTIVE", forgedOutcome: "QUALIFIED" })).toThrowError(
      expect.objectContaining({ code: "PRIVACY_STATE_INVALID" })
    );
  });

  it("rejects non-object gate inputs", () => {
    for (const bad of ["SUPPRESSED", 7, ["ACTIVE"]]) {
      expect(() => resolvePrivacyGate(bad)).toThrowError(
        expect.objectContaining({ code: "PRIVACY_STATE_INVALID" })
      );
    }
  });

  it("re-validates the bounded governed fields", () => {
    expect(() => resolvePrivacyGate({ state: "ACTIVE", available: "yes" })).toThrowError(
      expect.objectContaining({ code: "PRIVACY_STATE_INVALID" })
    );
    expect(() => resolvePrivacyGate({ state: "ACTIVE", previousState: "GONE" })).toThrowError(
      expect.objectContaining({ code: "PRIVACY_STATE_INVALID" })
    );
    expect(() => resolvePrivacyGate({ state: "ACTIVE", actorUserId: -1 })).toThrowError(
      expect.objectContaining({ code: "PRIVACY_STATE_INVALID" })
    );
    expect(() =>
      resolvePrivacyGate({ state: "ACTIVE", retentionDeadlineAt: "not-a-date" })
    ).toThrowError(expect.objectContaining({ code: "PRIVACY_STATE_INVALID" }));
    expect(() =>
      resolvePrivacyGate({ state: "ACTIVE", source: "x".repeat(65) })
    ).toThrowError(expect.objectContaining({ code: "PRIVACY_STATE_INVALID" }));
    expect(() => resolvePrivacyGate({ state: "ACTIVE", updatedAt: 12345 })).toThrowError(
      expect.objectContaining({ code: "PRIVACY_STATE_INVALID" })
    );
  });

  it("accepts a fully-populated governed row", () => {
    const gate = resolvePrivacyGate({
      available: true,
      state: "SUPPRESSED",
      retentionDeadlineAt: "2027-01-01T00:00:00Z",
      previousState: "ACTIVE",
      source: "tenant_request",
      actorUserId: 7,
      updatedAt: "2026-06-28T10:00:00Z",
    });
    expect(gate).toEqual({ state: "SUPPRESSED", actionable: false, blockedReason: "PRIVACY_SUPPRESSED" });
  });
});

describe("leadPrivacyEvidenceFromRow", () => {
  it("maps a lead_privacy_states-shaped row to the gate input", () => {
    expect(
      leadPrivacyEvidenceFromRow({
        leadId: "lead-1",
        userId: 7,
        businessId: 3,
        privacyState: "SUPPRESSED",
        previousState: "ACTIVE",
        reason: "opt-out",
        retentionDeadlineAt: null,
        source: "tenant_request",
        actorUserId: 7,
        createdAt: "2026-06-01T00:00:00Z",
        updatedAt: "2026-06-28T00:00:00Z",
      })
    ).toEqual({ state: "SUPPRESSED" });
  });

  it("returns null for an absent row", () => {
    expect(leadPrivacyEvidenceFromRow(null)).toBeNull();
    expect(leadPrivacyEvidenceFromRow(undefined)).toBeNull();
    expect(resolvePrivacyGate(leadPrivacyEvidenceFromRow(null))).toEqual({
      state: "ACTIVE",
      actionable: true,
      blockedReason: null,
    });
  });

  it("round-trips through resolvePrivacyGate", () => {
    const row = {
      leadId: "lead-1",
      userId: 7,
      businessId: 3,
      privacyState: "RETENTION_EXPIRED",
      previousState: "RETENTION_PENDING",
      reason: null,
      retentionDeadlineAt: "2026-06-01T00:00:00Z",
      source: null,
      actorUserId: null,
      createdAt: "2026-06-01T00:00:00Z",
      updatedAt: "2026-06-01T00:00:00Z",
    };
    const gate = resolvePrivacyGate(leadPrivacyEvidenceFromRow(row));
    expect(gate).toEqual({ state: "RETENTION_EXPIRED", actionable: false, blockedReason: "RETENTION_EXPIRED" });
  });

  it("fails closed on a non-object row", () => {
    expect(() => leadPrivacyEvidenceFromRow("SUPPRESSED")).toThrowError(
      expect.objectContaining({ code: "PRIVACY_STATE_INVALID" })
    );
  });
});
