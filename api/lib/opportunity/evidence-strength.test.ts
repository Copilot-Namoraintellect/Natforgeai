// Unit coverage for R5-D confidence/evidence strength (contract §6, D5)
// and lifecycle transitions (contract §4, §10, D8). Pure — no DB, explicit clocks.

import { describe, expect, it } from "vitest";
import {
  computeEvidenceStrength,
  computeConfidenceClass,
  recencyCap,
  isContradiction,
  type StrengthEvidenceInput,
} from "./evidence-strength";
import { canTransition, statusForStrength } from "./opportunity-lifecycle";
import {
  toValidatedEngagementReceipt,
  deriveReceiptHash,
} from "./engagement-evidence-seam";
import { ForgedEvidenceError } from "./opportunity-contract";

const HOUR = 60 * 60 * 1000;

function evidence(overrides: Partial<StrengthEvidenceInput> = {}): StrengthEvidenceInput {
  return {
    kind: "signal_interpretation",
    opportunityTypeAtEvaluation: "purchase_interest",
    intent: "purchase_interest",
    overallConfidence: "medium",
    relevance: "relevant",
    sentiment: "positive",
    urgency: "normal",
    contributesToStrength: true,
    ...overrides,
  };
}

describe("evidence strength (D5)", () => {
  it("single weak signal stays LOW (case 7)", () => {
    const result = computeEvidenceStrength([evidence({ overallConfidence: "low" })], "purchase_interest");
    expect(result.evidenceStrength).toBe("LOW");
  });

  it("single explicit medium signal is MEDIUM, not HIGH", () => {
    const result = computeEvidenceStrength([evidence()], "purchase_interest");
    expect(result.evidenceStrength).toBe("MEDIUM");
  });

  it("repeated explicit signals reach HIGH (no contradictions)", () => {
    const result = computeEvidenceStrength(
      [evidence({ overallConfidence: "high" }), evidence({ overallConfidence: "high" })],
      "purchase_interest"
    );
    expect(result.evidenceStrength).toBe("HIGH");
  });

  it("engagement receipt boosts medium single signal to MEDIUM via boost path", () => {
    const result = computeEvidenceStrength(
      [evidence(), evidence({ kind: "engagement_receipt" })],
      "purchase_interest"
    );
    expect(result.evidenceStrength).toBe("MEDIUM");
  });

  it("contradictions cap strength at LOW", () => {
    const result = computeEvidenceStrength(
      [evidence({ overallConfidence: "high" }), evidence({ overallConfidence: "high" }), evidence({ sentiment: "negative", intent: "objection" })],
      "purchase_interest"
    );
    expect(result.evidenceStrength).toBe("LOW");
    expect(result.contradictionCount).toBe(1);
  });

  it("no qualifying evidence is UNKNOWN", () => {
    const result = computeEvidenceStrength([], "purchase_interest");
    expect(result.evidenceStrength).toBe("UNKNOWN");
  });

  it("retention risk treats praise reversal as contradiction", () => {
    expect(isContradiction(evidence({ intent: "praise", sentiment: "positive" }), "retention_risk")).toBe(true);
    expect(isContradiction(evidence({ intent: "praise", sentiment: "positive" }), "purchase_interest")).toBe(false);
  });

  it("recency cap degrades with age; confidence is bounded honestly", () => {
    const now = Date.parse("2026-10-24T12:00:00.000Z");
    expect(recencyCap(now - 1 * HOUR, now, 168 * HOUR)).toBe("HIGH");
    expect(recencyCap(now - 120 * HOUR, now, 168 * HOUR)).toBe("MEDIUM");
    expect(computeConfidenceClass("HIGH", "MEDIUM")).toBe("MEDIUM");
    expect(computeConfidenceClass("LOW", "HIGH")).toBe("LOW");
  });
});

describe("lifecycle transitions (D8)", () => {
  it("create only mints candidate or weak", () => {
    expect(canTransition("create", "candidate")).toBe(true);
    expect(canTransition("create", "handed_off_to_r6")).toBe(false);
  });

  it("handoff is allowed from active statuses only and is terminal", () => {
    expect(canTransition("handoff", "candidate")).toBe(true);
    expect(canTransition("handoff", "weak")).toBe(true);
    expect(canTransition("handoff", "expired")).toBe(false);
    expect(canTransition("handoff", "handed_off_to_r6")).toBe(false);
  });

  it("suppressed requires unsuppress; unsuppress restores weak", () => {
    expect(canTransition("suppress", "candidate")).toBe(true);
    expect(canTransition("unsuppress", "suppressed")).toBe(true);
    expect(canTransition("unsuppress", "candidate")).toBe(false);
  });

  it("expiry applies to active statuses only; revive only from expired", () => {
    expect(canTransition("expire", "strengthening")).toBe(true);
    expect(canTransition("expire", "handed_off_to_r6")).toBe(false);
    expect(canTransition("revive", "expired")).toBe(true);
    expect(canTransition("revive", "candidate")).toBe(false);
  });

  it("statusForStrength maps bounded classes honestly", () => {
    expect(statusForStrength("HIGH", null)).toBe("candidate");
    expect(statusForStrength("LOW", null)).toBe("weak");
    expect(statusForStrength("UNKNOWN", null)).toBe("weak");
    expect(statusForStrength("MEDIUM", "weak")).toBe("strengthening");
    expect(statusForStrength("HIGH", "expired")).toBe("candidate");
    expect(statusForStrength("LOW", "expired")).toBe("weak");
  });
});

describe("engagement receipt seam (D7)", () => {
  const receiptBase = {
    engagementReceiptId: "rcpt-1",
    sourceInterpretationId: "int-1",
    sourceSignalId: "sig-1",
    businessId: 1,
    outcome: "positive_response" as const,
    providerReceiptRef: "meta:mid-1",
    occurredAt: "2026-10-24T11:00:00.000Z",
    recordedAt: "2026-10-24T11:00:05.000Z",
  };

  it("validates a correctly hashed receipt", () => {
    const receipt = {
      ...receiptBase,
      receiptHash: deriveReceiptHash({ ...receiptBase }),
    };
    expect(toValidatedEngagementReceipt(receipt).engagementReceiptId).toBe("rcpt-1");
  });

  it("rejects a forged receipt (hash mismatch) — case 20", () => {
    expect(() =>
      toValidatedEngagementReceipt({
        ...receiptBase,
        receiptHash: "0".repeat(64),
      })
    ).toThrow(ForgedEvidenceError);
  });

  it("rejects malformed receipts fail-closed", () => {
    expect(() => toValidatedEngagementReceipt({ ...receiptBase, outcome: "evil_outcome" })).toThrow(
      ForgedEvidenceError
    );
  });
});
