import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyImageRenderRecovery,
  type ImageRenderRecoveryClassification,
  type ImageRenderRecoveryEvidence,
} from "./image-render-recovery-classifier";

// ─── Pure deterministic classifier tests ───
//
// No database, timers, network, filesystem mutation, or global state. The
// source-purity scan below enforces the module boundary.

const here = path.dirname(fileURLToPath(import.meta.url));
const classifierSource = readFileSync(
  path.resolve(here, "./image-render-recovery-classifier.ts"),
  "utf8"
);

function runningClaim(
  leaseState: "active" | "stale" | "missing",
  deductionRecorded = false
): ImageRenderRecoveryEvidence["claim"] {
  return { found: true, status: "running", leaseState, deductionRecorded };
}

function failedClaim(deductionRecorded = false): ImageRenderRecoveryEvidence["claim"] {
  return { found: true, status: "failed", leaseState: "missing", deductionRecorded };
}

function completedClaim(deductionRecorded = false): ImageRenderRecoveryEvidence["claim"] {
  return { found: true, status: "completed", leaseState: "missing", deductionRecorded };
}

const NOT_CHECKED: ImageRenderRecoveryEvidence["completedResult"] = { kind: "not_checked" };

function evidence(overrides: Partial<ImageRenderRecoveryEvidence> = {}): ImageRenderRecoveryEvidence {
  return {
    claim: { found: false },
    deduction: "absent",
    completedResult: NOT_CHECKED,
    ...overrides,
  };
}

const CASES: Array<[string, ImageRenderRecoveryEvidence, ImageRenderRecoveryClassification]> = [
  // Running — active lease.
  ["running active + no deduction", evidence({ claim: runningClaim("active") }), "healthy_running"],
  ["running active + deduction row", evidence({ claim: runningClaim("active"), deduction: "present" }), "running_with_deduction_evidence"],
  ["running active + deductionRecorded", evidence({ claim: runningClaim("active", true) }), "running_with_deduction_evidence"],
  // Running — stale lease.
  ["running stale + no deduction", evidence({ claim: runningClaim("stale") }), "stale_no_deduction_evidence"],
  ["running stale + deduction row", evidence({ claim: runningClaim("stale"), deduction: "present" }), "stale_with_deduction_evidence"],
  ["running stale + deductionRecorded", evidence({ claim: runningClaim("stale", true) }), "stale_with_deduction_evidence"],
  // Running — missing lease.
  ["running missing lease", evidence({ claim: runningClaim("missing") }), "operator_review_required"],
  // Failed.
  ["failed + no deduction", evidence({ claim: failedClaim() }), "failed_rearmable"],
  ["failed + deduction row", evidence({ claim: failedClaim(), deduction: "present" }), "failed_with_deduction_evidence"],
  ["failed + deductionRecorded", evidence({ claim: failedClaim(true) }), "failed_with_deduction_evidence"],
  // Completed — verified replay.
  [
    "completed + replayable + zero credits + no deduction",
    evidence({ claim: completedClaim(), completedResult: { kind: "replayable", creditsCharged: 0 } }),
    "completed_replayable",
  ],
  [
    "completed + replayable + paid + matching row and marker",
    evidence({
      claim: completedClaim(true),
      deduction: "present",
      completedResult: { kind: "replayable", creditsCharged: 12 },
    }),
    "completed_replayable",
  ],
  [
    "completed + replayable paid + missing row",
    evidence({
      claim: completedClaim(true),
      deduction: "absent",
      completedResult: { kind: "replayable", creditsCharged: 12 },
    }),
    "integrity_blocked",
  ],
  [
    "completed + replayable paid + missing marker",
    evidence({
      claim: completedClaim(false),
      deduction: "present",
      completedResult: { kind: "replayable", creditsCharged: 12 },
    }),
    "integrity_blocked",
  ],
  [
    "completed + replayable zero-credit + deduction row",
    evidence({
      claim: completedClaim(false),
      deduction: "present",
      completedResult: { kind: "replayable", creditsCharged: 0 },
    }),
    "integrity_blocked",
  ],
  [
    "completed + replayable zero-credit + marker",
    evidence({
      claim: completedClaim(true),
      deduction: "absent",
      completedResult: { kind: "replayable", creditsCharged: 0 },
    }),
    "integrity_blocked",
  ],
  // Completed — result failure reasons.
  [
    "completed + completed_without_result",
    evidence({
      claim: completedClaim(),
      completedResult: { kind: "blocked", reason: "completed_without_result" },
    }),
    "completed_without_result",
  ],
  [
    "completed + linked_result_missing_or_mismatched",
    evidence({
      claim: completedClaim(),
      completedResult: { kind: "blocked", reason: "linked_result_missing_or_mismatched" },
    }),
    "linked_result_invalid",
  ],
  [
    "completed + intent_conflict",
    evidence({
      claim: completedClaim(),
      completedResult: { kind: "blocked", reason: "intent_conflict" },
    }),
    "integrity_blocked",
  ],
  [
    "completed + not_completed_or_not_found",
    evidence({
      claim: completedClaim(),
      completedResult: { kind: "blocked", reason: "not_completed_or_not_found" },
    }),
    "integrity_blocked",
  ],
  [
    "completed + not_checked",
    evidence({ claim: completedClaim(), completedResult: NOT_CHECKED }),
    "operator_review_required",
  ],
  // Missing claim / lookup failures.
  ["claim missing", evidence(), "integrity_blocked"],
  [
    "deduction lookup failed",
    evidence({ claim: runningClaim("active"), deduction: "lookup_failed" }),
    "operator_review_required",
  ],
  [
    "completed-result lookup failed",
    evidence({
      claim: completedClaim(),
      completedResult: { kind: "lookup_failed" },
    }),
    "operator_review_required",
  ],
  // Contradictions fail closed.
  [
    "running + replayable result",
    evidence({
      claim: runningClaim("active"),
      completedResult: { kind: "replayable", creditsCharged: 0 },
    }),
    "integrity_blocked",
  ],
  [
    "failed + replayable result",
    evidence({
      claim: failedClaim(),
      completedResult: { kind: "replayable", creditsCharged: 0 },
    }),
    "integrity_blocked",
  ],
  [
    "running + blocked completed-result evidence",
    evidence({
      claim: runningClaim("active"),
      completedResult: { kind: "blocked", reason: "completed_without_result" },
    }),
    "integrity_blocked",
  ],
  [
    "failed + blocked completed-result evidence",
    evidence({
      claim: failedClaim(),
      completedResult: { kind: "blocked", reason: "completed_without_result" },
    }),
    "integrity_blocked",
  ],
  [
    "non-finite creditsCharged",
    evidence({
      claim: completedClaim(true),
      deduction: "present",
      completedResult: { kind: "replayable", creditsCharged: Number.NaN },
    }),
    "integrity_blocked",
  ],
  [
    "negative creditsCharged",
    evidence({
      claim: completedClaim(true),
      deduction: "present",
      completedResult: { kind: "replayable", creditsCharged: -5 },
    }),
    "integrity_blocked",
  ],
];

describe("classifyImageRenderRecovery — classification matrix", () => {
  it.each(CASES.map(([label, input, expected]) => [label, input, expected] as const))(
    "%s",
    (_label, input, expected) => {
      const result = classifyImageRenderRecovery(input);
      expect(result.classification).toBe(expected);
    }
  );

  it("every classification returns mutationAuthorized === false and a frozen result", () => {
    for (const [, input] of CASES) {
      const result = classifyImageRenderRecovery(input);
      expect(result.mutationAuthorized).toBe(false);
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.keys(result).sort()).toEqual(["classification", "mutationAuthorized"]);
    }
  });

  it("supports exactly the eleven documented classifications", () => {
    const supported = new Set(CASES.map(([, , expected]) => expected));
    expect(supported.size).toBe(11);
    for (const name of [
      "healthy_running",
      "completed_replayable",
      "failed_rearmable",
      "stale_no_deduction_evidence",
      "stale_with_deduction_evidence",
      "running_with_deduction_evidence",
      "failed_with_deduction_evidence",
      "completed_without_result",
      "linked_result_invalid",
      "integrity_blocked",
      "operator_review_required",
    ]) {
      expect(supported.has(name as ImageRenderRecoveryClassification)).toBe(true);
    }
  });
});

describe("classifyImageRenderRecovery — input-shape validation", () => {
  it.each([
    ["null evidence", null],
    ["missing claim", { deduction: "absent", completedResult: NOT_CHECKED }],
    ["unknown claim status", evidence({ claim: { found: true, status: "bogus", leaseState: "active", deductionRecorded: false } as never })],
    ["unknown lease state", evidence({ claim: { found: true, status: "running", leaseState: "bogus", deductionRecorded: false } as never })],
    ["unknown deduction value", evidence({ claim: runningClaim("active"), deduction: "bogus" as never })],
    ["unknown result kind", evidence({ claim: completedClaim(), completedResult: { kind: "bogus" } as never })],
    ["unknown blocked reason", evidence({ claim: completedClaim(), completedResult: { kind: "blocked", reason: "bogus" } as never })],
  ])("throws TypeError for programmer-invalid shape: %s", (_label, input) => {
    expect(() => classifyImageRenderRecovery(input as never)).toThrow(TypeError);
  });
});

describe("classifyImageRenderRecovery — purity and security boundary", () => {
  it("module source contains no mutation, I/O, timer, or logging surface", () => {
    for (const forbidden of [
      "getDb(",
      "insert(",
      "update(",
      "delete(",
      "deductCredits",
      "recordAiUsage",
      "refund",
      "rearmFailedImageRenderClaim",
      "failImageRenderClaim",
      "completeImageRenderClaim",
      "acquireImageRenderClaim",
      "renewImageRenderClaim",
      "setTimeout",
      "setInterval",
      "fetch(",
      "console.",
    ]) {
      expect(classifierSource).not.toContain(forbidden);
    }
  });

  it("serialized results never contain identities, keys, tokens, or raw errors", () => {
    const forbiddenFields = [
      "ownerToken",
      "requestAttemptKey",
      "intentFingerprint",
      "deductionKey",
      "activeClaimKey",
      "claimId",
      "generatedImageId",
    ];
    for (const [, input] of CASES) {
      const serialized = JSON.stringify(classifyImageRenderRecovery(input));
      for (const field of forbiddenFields) {
        expect(serialized).not.toContain(field);
      }
    }
  });
});
