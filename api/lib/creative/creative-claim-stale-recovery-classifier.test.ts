import { describe, it, expect } from "vitest";
import {
  classifyCreativeClaimStaleRecovery,
  type CreativeClaimStaleRecoveryClaimEvidence,
} from "./creative-claim-stale-recovery-classifier";

// ─── Pure stale recovery classifier tests ───
//
// Deterministic evidence-in/classification-out proofs. No database, no
// timers, no providers, no environment mutation.

function foundEvidence(
  overrides: Partial<Extract<CreativeClaimStaleRecoveryClaimEvidence, { found: true }>> = {}
): CreativeClaimStaleRecoveryClaimEvidence {
  return {
    found: true,
    status: "running",
    leaseState: "stale",
    agedPastThreshold: true,
    ...overrides,
  };
}

describe("classifyCreativeClaimStaleRecovery", () => {
  it("classifies a missing claim row as an integrity fault (non-recoverable)", () => {
    const result = classifyCreativeClaimStaleRecovery({ claim: { found: false } });

    expect(result).toEqual({
      classification: "integrity_blocked",
      recoverable: false,
    });
  });

  it("classifies a running claim with an active lease as healthy (non-recoverable)", () => {
    const result = classifyCreativeClaimStaleRecovery({
      claim: foundEvidence({ leaseState: "active" }),
    });

    expect(result).toEqual({
      classification: "healthy_running",
      recoverable: false,
    });
  });

  it("classifies a running claim with an expired lease as recoverable", () => {
    const result = classifyCreativeClaimStaleRecovery({
      claim: foundEvidence({ leaseState: "stale" }),
    });

    expect(result).toEqual({
      classification: "stale_recoverable",
      recoverable: true,
    });
  });

  it("classifies an aged unleased running claim as recoverable", () => {
    const result = classifyCreativeClaimStaleRecovery({
      claim: foundEvidence({ leaseState: "missing", agedPastThreshold: true }),
    });

    expect(result).toEqual({
      classification: "legacy_unleased_recoverable",
      recoverable: true,
    });
  });

  it("classifies a recent unleased running claim as ambiguous (non-recoverable)", () => {
    const result = classifyCreativeClaimStaleRecovery({
      claim: foundEvidence({ leaseState: "missing", agedPastThreshold: false }),
    });

    expect(result).toEqual({
      classification: "unleased_recent_ambiguous",
      recoverable: false,
    });
  });

  it.each(["completed", "failed"] as const)(
    "classifies a %s claim as already closed even with a stale lease",
    (status) => {
      const result = classifyCreativeClaimStaleRecovery({
        claim: foundEvidence({ status, leaseState: "stale" }),
      });

      expect(result).toEqual({
        classification: "terminal_closed",
        recoverable: false,
      });
    }
  );

  it("treats an aged unleased completed claim as terminal, never recoverable", () => {
    const result = classifyCreativeClaimStaleRecovery({
      claim: foundEvidence({
        status: "completed",
        leaseState: "missing",
        agedPastThreshold: true,
      }),
    });

    expect(result.recoverable).toBe(false);
    expect(result.classification).toBe("terminal_closed");
  });

  it("returns frozen results", () => {
    const result = classifyCreativeClaimStaleRecovery({
      claim: foundEvidence(),
    });

    expect(Object.isFrozen(result)).toBe(true);
  });

  it.each([
    ["non-object evidence", null],
    ["missing claim", {}],
    ["malformed claim", { claim: { found: "yes" } }],
    [
      "unknown status",
      { claim: foundEvidence({ status: "paused" as never }) },
    ],
    [
      "unknown lease state",
      { claim: foundEvidence({ leaseState: "expired" as never }) },
    ],
    [
      "non-boolean agedPastThreshold",
      { claim: { ...foundEvidence(), agedPastThreshold: "yes" } },
    ],
  ])("rejects %s", (_label, evidence) => {
    expect(() =>
      classifyCreativeClaimStaleRecovery(
        evidence as never
      )
    ).toThrow(TypeError);
  });
});
