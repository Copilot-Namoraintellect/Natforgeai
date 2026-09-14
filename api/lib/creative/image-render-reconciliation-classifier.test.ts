import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyImageRenderReconciliation,
  type ImageRenderReconciliationClassification,
  type ImageRenderReconciliationEvidence,
  type UpstreamRecoveryClassification,
} from "./image-render-reconciliation-classifier";

// ─── Pure deterministic reconciliation classifier tests ───
//
// No database, filesystem mutation, network, timers, or global state.

const here = path.dirname(fileURLToPath(import.meta.url));
const classifierSource = readFileSync(
  path.resolve(here, "./image-render-reconciliation-classifier.ts"),
  "utf8"
);

const EXACT_IMAGE: Extract<ImageRenderReconciliationEvidence["generatedImage"], { kind: "present" }> =
  {
    kind: "present",
    matchesClaimGeneratedImageId: true,
    matchesUser: true,
    matchesContentPost: true,
    matchesClaimSnapshot: true,
  };

const MATCHING_POST: ImageRenderReconciliationEvidence["contentPost"] = {
  kind: "matches_generated_image",
};

const NO_DEDUCTION: ImageRenderReconciliationEvidence["deduction"] = { kind: "absent" };

function evidence(
  overrides: Partial<ImageRenderReconciliationEvidence> & {
    upstream: UpstreamRecoveryClassification;
  }
): ImageRenderReconciliationEvidence {
  return {
    resultCreditsCharged: null,
    generatedImage: { kind: "not_checked" },
    contentPost: { kind: "not_checked" },
    deduction: NO_DEDUCTION,
    usageObservation: "not_checked",
    ...overrides,
  };
}

const CASES: Array<[string, ImageRenderReconciliationEvidence, ImageRenderReconciliationClassification, boolean]> = [
  // Safe non-C4 states.
  ["healthy running", evidence({ upstream: "healthy_running" }), "live_attempt_no_action", false],
  ["failed rearmable", evidence({ upstream: "failed_rearmable" }), "pre_deduction_state_outside_c4", false],
  ["stale no deduction", evidence({ upstream: "stale_no_deduction_evidence" }), "pre_deduction_state_outside_c4", false],
  // Deduction evidence on claims.
  ["running with deduction", evidence({ upstream: "running_with_deduction_evidence" }), "active_claim_with_deduction_evidence", true],
  ["stale with deduction", evidence({ upstream: "stale_with_deduction_evidence" }), "blocked_claim_with_deduction_evidence", true],
  ["failed with deduction", evidence({ upstream: "failed_with_deduction_evidence" }), "blocked_claim_with_deduction_evidence", true],
  // Verified committed success.
  [
    "completed replayable zero-credit + exact links + no deduction",
    evidence({
      upstream: "completed_replayable",
      resultCreditsCharged: 0,
      generatedImage: EXACT_IMAGE,
      contentPost: MATCHING_POST,
      deduction: NO_DEDUCTION,
    }),
    "verified_committed_success",
    false,
  ],
  [
    "completed replayable paid + exact links + exact matching deduction",
    evidence({
      upstream: "completed_replayable",
      resultCreditsCharged: 12,
      generatedImage: EXACT_IMAGE,
      contentPost: MATCHING_POST,
      deduction: { kind: "present", exactAttemptKeyMatch: true, expectedCreditsMatch: true },
    }),
    "verified_committed_success",
    false,
  ],
  // Missing / inconsistent deduction for verified results.
  [
    "paid verified result + no deduction",
    evidence({
      upstream: "completed_replayable",
      resultCreditsCharged: 12,
      generatedImage: EXACT_IMAGE,
      contentPost: MATCHING_POST,
      deduction: NO_DEDUCTION,
    }),
    "verified_result_without_expected_deduction",
    true,
  ],
  [
    "paid verified result + wrong credit amount",
    evidence({
      upstream: "completed_replayable",
      resultCreditsCharged: 12,
      generatedImage: EXACT_IMAGE,
      contentPost: MATCHING_POST,
      deduction: { kind: "present", exactAttemptKeyMatch: true, expectedCreditsMatch: false },
    }),
    "integrity_review_required",
    true,
  ],
  [
    "exact deduction + no generated image",
    evidence({
      upstream: "completed_replayable",
      resultCreditsCharged: 12,
      generatedImage: { kind: "absent" },
      contentPost: MATCHING_POST,
      deduction: { kind: "present", exactAttemptKeyMatch: true, expectedCreditsMatch: true },
    }),
    "deduction_without_verified_result",
    true,
  ],
  // Completed-without-result with/without deduction.
  [
    "completed_without_result + deduction",
    evidence({
      upstream: "completed_without_result",
      deduction: { kind: "present", exactAttemptKeyMatch: true, expectedCreditsMatch: "unknown" },
    }),
    "deduction_without_verified_result",
    true,
  ],
  [
    "completed_without_result without deduction",
    evidence({ upstream: "completed_without_result" }),
    "integrity_review_required",
    true,
  ],
  // Generated-image mismatches.
  [
    "generated-image id mismatch",
    evidence({
      upstream: "completed_replayable",
      resultCreditsCharged: 0,
      generatedImage: { ...EXACT_IMAGE, matchesClaimGeneratedImageId: false },
      contentPost: MATCHING_POST,
    }),
    "claim_result_linkage_mismatch",
    true,
  ],
  [
    "generated-image user mismatch",
    evidence({
      upstream: "completed_replayable",
      resultCreditsCharged: 0,
      generatedImage: { ...EXACT_IMAGE, matchesUser: false },
      contentPost: MATCHING_POST,
    }),
    "claim_result_linkage_mismatch",
    true,
  ],
  [
    "generated-image post mismatch",
    evidence({
      upstream: "completed_replayable",
      resultCreditsCharged: 0,
      generatedImage: { ...EXACT_IMAGE, matchesContentPost: false },
      contentPost: MATCHING_POST,
    }),
    "claim_result_linkage_mismatch",
    true,
  ],
  [
    "generated-image snapshot mismatch",
    evidence({
      upstream: "completed_replayable",
      resultCreditsCharged: 0,
      generatedImage: { ...EXACT_IMAGE, matchesClaimSnapshot: false },
      contentPost: MATCHING_POST,
    }),
    "claim_result_linkage_mismatch",
    true,
  ],
  // Content-post linkage.
  [
    "exact claim/image but post mismatch",
    evidence({
      upstream: "completed_replayable",
      resultCreditsCharged: 0,
      generatedImage: EXACT_IMAGE,
      contentPost: { kind: "mismatch" },
    }),
    "content_post_linkage_mismatch",
    true,
  ],
  [
    "exact claim/image but post has no link",
    evidence({
      upstream: "completed_replayable",
      resultCreditsCharged: 0,
      generatedImage: EXACT_IMAGE,
      contentPost: { kind: "no_generated_image_link" },
    }),
    "content_post_linkage_mismatch",
    true,
  ],
  // Linked-result-invalid upstream.
  [
    "linked_result_invalid + concrete mismatch",
    evidence({
      upstream: "linked_result_invalid",
      generatedImage: { ...EXACT_IMAGE, matchesClaimSnapshot: false },
    }),
    "claim_result_linkage_mismatch",
    true,
  ],
  [
    "linked_result_invalid without authoritative linkage evidence",
    evidence({ upstream: "linked_result_invalid" }),
    "integrity_review_required",
    true,
  ],
  // Authoritative lookup failures.
  [
    "deduction lookup failure",
    evidence({
      upstream: "integrity_blocked",
      generatedImage: EXACT_IMAGE,
      contentPost: MATCHING_POST,
      deduction: { kind: "lookup_failed" },
    }),
    "authoritative_evidence_unavailable",
    true,
  ],
  [
    "generated-image lookup failure",
    evidence({
      upstream: "completed_replayable",
      resultCreditsCharged: 0,
      generatedImage: { kind: "lookup_failed" },
      contentPost: MATCHING_POST,
    }),
    "authoritative_evidence_unavailable",
    true,
  ],
  [
    "post lookup failure",
    evidence({
      upstream: "completed_replayable",
      resultCreditsCharged: 0,
      generatedImage: EXACT_IMAGE,
      contentPost: { kind: "lookup_failed" },
    }),
    "authoritative_evidence_unavailable",
    true,
  ],
  // Contradictions.
  [
    "not-checked authoritative evidence never becomes verified success",
    evidence({
      upstream: "completed_replayable",
      resultCreditsCharged: 0,
      generatedImage: { kind: "not_checked" },
      contentPost: MATCHING_POST,
    }),
    "integrity_review_required",
    true,
  ],
  [
    "negative credits",
    evidence({
      upstream: "completed_replayable",
      resultCreditsCharged: -1,
      generatedImage: EXACT_IMAGE,
      contentPost: MATCHING_POST,
    }),
    "integrity_review_required",
    true,
  ],
  [
    "non-finite credits",
    evidence({
      upstream: "completed_replayable",
      resultCreditsCharged: Number.POSITIVE_INFINITY,
      generatedImage: EXACT_IMAGE,
      contentPost: MATCHING_POST,
    }),
    "integrity_review_required",
    true,
  ],
  [
    "deduction present without exact attempt key match",
    evidence({
      upstream: "stale_with_deduction_evidence",
      deduction: { kind: "present", exactAttemptKeyMatch: false, expectedCreditsMatch: true },
    }),
    "integrity_review_required",
    true,
  ],
];

describe("classifyImageRenderReconciliation — classification matrix", () => {
  it.each(CASES.map(([label, input, expected, review]) => [label, input, expected, review] as const))(
    "%s",
    (_label, input, expected, review) => {
      const result = classifyImageRenderReconciliation(input);
      expect(result.classification).toBe(expected);
      expect(result.operatorReviewRequired).toBe(review);
    }
  );

  it("every result has mutationAuthorized === false, is frozen, and has exactly three keys", () => {
    for (const [, input] of CASES) {
      const result = classifyImageRenderReconciliation(input);
      expect(result.mutationAuthorized).toBe(false);
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.keys(result).sort()).toEqual([
        "classification",
        "mutationAuthorized",
        "operatorReviewRequired",
      ]);
    }
  });

  it("supports exactly the eleven documented classifications", () => {
    const supported = new Set(CASES.map(([, , expected]) => expected));
    expect(supported.size).toBe(11);
  });
});

describe("classifyImageRenderReconciliation — AI usage is never authority", () => {
  const authoritativeInputs: ImageRenderReconciliationEvidence[] = [
    evidence({ upstream: "healthy_running" }),
    evidence({ upstream: "stale_with_deduction_evidence" }),
    evidence({
      upstream: "completed_replayable",
      resultCreditsCharged: 12,
      generatedImage: EXACT_IMAGE,
      contentPost: MATCHING_POST,
      deduction: { kind: "present", exactAttemptKeyMatch: true, expectedCreditsMatch: true },
    }),
    evidence({
      upstream: "completed_replayable",
      resultCreditsCharged: 0,
      generatedImage: EXACT_IMAGE,
      contentPost: MATCHING_POST,
      deduction: { kind: "lookup_failed" },
    }),
  ];

  it.each(authoritativeInputs.map((input, index) => [`authoritative case ${index + 1}`, input] as const))(
    "%s produces identical results for every usage observation",
    (_label, input) => {
      const results = (["not_checked", "present", "absent", "lookup_failed"] as const).map(
        (usageObservation) =>
          classifyImageRenderReconciliation({ ...input, usageObservation })
      );
      for (const result of results) {
        expect(result).toEqual(results[0]);
      }
    }
  );

  it("usage lookup failure alone does not trigger authoritative_evidence_unavailable", () => {
    const result = classifyImageRenderReconciliation(
      evidence({ upstream: "healthy_running", usageObservation: "lookup_failed" })
    );
    expect(result.classification).toBe("live_attempt_no_action");
  });

  it("usage presence does not upgrade unverifiable evidence", () => {
    const result = classifyImageRenderReconciliation(
      evidence({
        upstream: "completed_replayable",
        resultCreditsCharged: 0,
        generatedImage: { kind: "not_checked" },
        contentPost: MATCHING_POST,
        usageObservation: "present",
      })
    );
    expect(result.classification).toBe("integrity_review_required");
  });
});

describe("classifyImageRenderReconciliation — input-shape validation", () => {
  it.each([
    ["null evidence", null],
    ["unknown upstream", { ...evidence({ upstream: "healthy_running" }), upstream: "bogus" }],
    ["non-number credits", { ...evidence({ upstream: "healthy_running" }), resultCreditsCharged: "12" }],
    ["malformed image evidence", { ...evidence({ upstream: "healthy_running" }), generatedImage: { kind: "bogus" } }],
    ["present image without flags", { ...evidence({ upstream: "healthy_running" }), generatedImage: { kind: "present" } }],
    ["malformed post evidence", { ...evidence({ upstream: "healthy_running" }), contentPost: { kind: "bogus" } }],
    ["malformed deduction evidence", { ...evidence({ upstream: "healthy_running" }), deduction: { kind: "bogus" } }],
    ["malformed usage observation", { ...evidence({ upstream: "healthy_running" }), usageObservation: "bogus" }],
  ])("throws TypeError for programmer-invalid shape: %s", (_label, input) => {
    expect(() => classifyImageRenderReconciliation(input as never)).toThrow(TypeError);
  });
});

describe("classifyImageRenderReconciliation — purity and security boundary", () => {
  it("module source has no mutation, I/O, timer, environment or logging surface", () => {
    for (const forbidden of [
      "getDb",
      "drizzle",
      "@db/schema",
      "insert(",
      "update(",
      "delete(",
      "deductCredits",
      "refundCredits",
      "recordAiUsage",
      "rearmFailedImageRenderClaim",
      "terminalizeStaleImageRenderClaim",
      "completeImageRenderClaimWithResult",
      "fetch(",
      "setTimeout",
      "setInterval",
      "console.",
      "process.env",
    ]) {
      expect(classifierSource).not.toContain(forbidden);
    }
  });

  it("serialized results never contain identities, keys, tokens, ids or URLs", () => {
    const forbiddenFields = [
      "ownerToken",
      "requestAttemptKey",
      "intentFingerprint",
      "deductionKey",
      "claimId",
      "generatedImageId",
      "imageUrl",
    ];
    for (const [, input] of CASES) {
      const serialized = JSON.stringify(classifyImageRenderReconciliation(input));
      for (const field of forbiddenFields) {
        expect(serialized).not.toContain(field);
      }
    }
  });
});
