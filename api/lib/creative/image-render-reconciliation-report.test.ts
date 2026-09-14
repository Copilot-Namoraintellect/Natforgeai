import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  composeImageRenderReconciliationReport,
  type ImageRenderReconciliationOperatorReport,
  type ImageRenderReconciliationReportInput,
} from "./image-render-reconciliation-report";
import * as recoveryModule from "./image-render-recovery-classifier";
import * as reconciliationModule from "./image-render-reconciliation-classifier";
import type { ImageRenderRecoveryEvidence } from "./image-render-recovery-classifier";
import type {
  ImageRenderReconciliationEvidenceCollectionResult,
  ImageRenderReconciliationEvidenceInput,
} from "./image-render-reconciliation-evidence";
import type { ImageRenderReconciliationEvidence } from "./image-render-reconciliation-classifier";
import { deriveImageRenderAttemptIdentity } from "./image-render-claim";
import { getDb } from "../../queries/connection";

// ─── Deterministic dormant report composer tests ───
//
// C2 and C4A run for REAL throughout (counting wrappers only instrument
// order/count and always call the real implementation). C4B is the injected
// dependency. No database, filesystem mutation, network, timers, or global
// state.

const viMock = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock("../../queries/connection", () => ({ getDb: viMock.getDb }));

const here = path.dirname(fileURLToPath(import.meta.url));
const reportSource = readFileSync(
  path.resolve(here, "./image-render-reconciliation-report.ts"),
  "utf8"
);

const IDENTITY = deriveImageRenderAttemptIdentity({
  userId: 7,
  contentPostId: 13,
  attempt: { clientAttemptId: "attempt-token-1" },
});

function makeClaimIdentity() {
  return {
    claimId: 42,
    userId: 7,
    contentPostId: 13,
    requestAttemptKey: IDENTITY.requestAttemptKey,
    intentFingerprint: IDENTITY.intentFingerprint,
    deductionKey: IDENTITY.deductionKey,
  };
}

const HEALTHY_RECOVERY_EVIDENCE: ImageRenderRecoveryEvidence = {
  claim: { found: true, status: "running", leaseState: "active", deductionRecorded: false },
  deduction: "absent",
  completedResult: { kind: "not_checked" },
};

function makeReportInput(
  overrides: Partial<ImageRenderReconciliationReportInput> = {}
): ImageRenderReconciliationReportInput {
  return {
    recoveryEvidence: HEALTHY_RECOVERY_EVIDENCE,
    claimIdentity: makeClaimIdentity(),
    ...overrides,
  };
}

const VERIFIED_PAID_EVIDENCE: ImageRenderReconciliationEvidence = {
  upstream: "completed_replayable",
  resultCreditsCharged: 12,
  generatedImage: {
    kind: "present",
    matchesClaimGeneratedImageId: true,
    matchesUser: true,
    matchesContentPost: true,
    matchesClaimSnapshot: true,
  },
  contentPost: { kind: "matches_generated_image" },
  deduction: { kind: "present", exactAttemptKeyMatch: true, expectedCreditsMatch: true },
  usageObservation: "not_checked",
};

function collectedResult(
  evidence: ImageRenderReconciliationEvidence
): ImageRenderReconciliationEvidenceCollectionResult {
  return { status: "collected", evidence };
}

function makeCollectorDep(script: {
  result?: ImageRenderReconciliationEvidenceCollectionResult | Error;
}) {
  const calls: ImageRenderReconciliationEvidenceInput[] = [];
  const dep = {
    collectEvidence: vi.fn(
      async (input: ImageRenderReconciliationEvidenceInput) => {
        calls.push(input);
        if (script.result instanceof Error) throw script.result;
        return (
          script.result ??
          collectedResult({ ...VERIFIED_PAID_EVIDENCE, upstream: input.upstream })
        );
      }
    ),
  };
  return { dep, calls };
}

function instrumentRealClassifiers(events: string[]) {
  const realC2 = recoveryModule.classifyImageRenderRecovery;
  const realC4A = reconciliationModule.classifyImageRenderReconciliation;
  const c2Spy = vi
    .spyOn(recoveryModule, "classifyImageRenderRecovery")
    .mockImplementation((evidence) => {
      events.push("c2");
      return realC2(evidence);
    });
  const c4aSpy = vi
    .spyOn(reconciliationModule, "classifyImageRenderReconciliation")
    .mockImplementation((evidence) => {
      events.push("c4a");
      return realC4A(evidence);
    });
  return { c2Spy, c4aSpy };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("composeImageRenderReconciliationReport — composition", () => {
  it("evaluates C2 before C4B and feeds C2's classification plus exact identity to a single C4B call", async () => {
    const events: string[] = [];
    const { c2Spy } = instrumentRealClassifiers(events);
    const { dep, calls } = makeCollectorDep({});
    const input = makeReportInput({
      recoveryEvidence: {
        claim: { found: true, status: "running", leaseState: "stale", deductionRecorded: false },
        deduction: "absent",
        completedResult: { kind: "not_checked" },
      },
    });

    await composeImageRenderReconciliationReport(input, dep);

    expect(c2Spy).toHaveBeenCalledTimes(1);
    expect(dep.collectEvidence).toHaveBeenCalledTimes(1);
    expect(events[0]).toBe("c2");
    // C4B receives exactly C2's returned classification and the exact identity.
    expect(calls).toEqual([
      {
        upstream: "stale_no_deduction_evidence",
        ...makeClaimIdentity(),
      },
    ]);
  });

  it("invokes C4A exactly once with the exact C4B evidence object when collected", async () => {
    const events: string[] = [];
    const { c4aSpy } = instrumentRealClassifiers(events);
    const evidence = {
      ...VERIFIED_PAID_EVIDENCE,
      upstream: "completed_replayable" as const,
    };
    const { dep } = makeCollectorDep({ result: collectedResult(evidence) });

    await composeImageRenderReconciliationReport(
      makeReportInput({
        recoveryEvidence: {
          claim: { found: true, status: "completed", leaseState: "missing", deductionRecorded: true },
          deduction: "present",
          completedResult: { kind: "replayable", creditsCharged: 12 },
        },
      }),
      dep
    );

    expect(c4aSpy).toHaveBeenCalledTimes(1);
    expect(c4aSpy.mock.calls[0][0]).toBe(evidence);
    expect(events.filter((name) => name === "c4a")).toHaveLength(1);
  });

  it("never invokes C4A when C4B blocks", async () => {
    const { c4aSpy } = instrumentRealClassifiers([]);
    for (const reason of [
      "claim_lookup_failed",
      "claim_not_found_or_identity_mismatch",
    ] as const) {
      const { dep } = makeCollectorDep({
        result: { status: "blocked", reason },
      });
      const report = await composeImageRenderReconciliationReport(
        makeReportInput(),
        dep
      );
      expect(report.status).toBe("blocked");
    }
    expect(c4aSpy).not.toHaveBeenCalled();
  });
});

describe("composeImageRenderReconciliationReport — blocked reports", () => {
  it.each([
    ["claim_lookup_failed", "claim_lookup_failed"],
    ["claim_not_found_or_identity_mismatch", "claim_not_found_or_identity_mismatch"],
  ] as const)("%s produces the exact blocked report shape", async (_label, reason) => {
    const { dep } = makeCollectorDep({ result: { status: "blocked", reason } });
    const report = await composeImageRenderReconciliationReport(makeReportInput(), dep);

    expect(report).toEqual({
      status: "blocked",
      recoveryClassification: "healthy_running",
      reconciliationClassification: null,
      operatorReviewRequired: true,
      reason,
      mutationAuthorized: false,
    });
    expect(Object.isFrozen(report)).toBe(true);
  });
});

describe("composeImageRenderReconciliationReport — classified reports (real C2 + real C4A)", () => {
  const CASES: Array<[
    string,
    ImageRenderRecoveryEvidence,
    ImageRenderReconciliationEvidence,
    string,
    boolean,
  ]> = [
    [
      "healthy running → live_attempt_no_action",
      HEALTHY_RECOVERY_EVIDENCE,
      { ...VERIFIED_PAID_EVIDENCE, upstream: "healthy_running" },
      "live_attempt_no_action",
      false,
    ],
    [
      "verified committed success",
      {
        claim: { found: true, status: "completed", leaseState: "missing", deductionRecorded: true },
        deduction: "present",
        completedResult: { kind: "replayable", creditsCharged: 12 },
      },
      VERIFIED_PAID_EVIDENCE,
      "verified_committed_success",
      false,
    ],
    [
      "deduction without verified result",
      {
        claim: { found: true, status: "completed", leaseState: "missing", deductionRecorded: true },
        deduction: "present",
        completedResult: { kind: "replayable", creditsCharged: 12 },
      },
      {
        ...VERIFIED_PAID_EVIDENCE,
        generatedImage: { kind: "absent" },
        contentPost: { kind: "no_generated_image_link" },
      },
      "deduction_without_verified_result",
      true,
    ],
    [
      "verified result without expected deduction",
      {
        claim: { found: true, status: "completed", leaseState: "missing", deductionRecorded: false },
        deduction: "absent",
        completedResult: { kind: "replayable", creditsCharged: 12 },
      },
      {
        ...VERIFIED_PAID_EVIDENCE,
        deduction: { kind: "absent" },
      },
      "verified_result_without_expected_deduction",
      true,
    ],
    [
      "post-linkage mismatch",
      {
        claim: { found: true, status: "completed", leaseState: "missing", deductionRecorded: true },
        deduction: "present",
        completedResult: { kind: "replayable", creditsCharged: 12 },
      },
      { ...VERIFIED_PAID_EVIDENCE, contentPost: { kind: "mismatch" } },
      "content_post_linkage_mismatch",
      true,
    ],
    [
      "image-linkage mismatch",
      {
        claim: { found: true, status: "completed", leaseState: "missing", deductionRecorded: true },
        deduction: "present",
        completedResult: { kind: "replayable", creditsCharged: 12 },
      },
      {
        ...VERIFIED_PAID_EVIDENCE,
        generatedImage: {
          kind: "present",
          matchesClaimGeneratedImageId: false,
          matchesUser: true,
          matchesContentPost: true,
          matchesClaimSnapshot: true,
        },
      },
      "claim_result_linkage_mismatch",
      true,
    ],
    [
      "authoritative evidence unavailable",
      {
        claim: { found: true, status: "completed", leaseState: "missing", deductionRecorded: true },
        deduction: "present",
        completedResult: { kind: "replayable", creditsCharged: 12 },
      },
      { ...VERIFIED_PAID_EVIDENCE, deduction: { kind: "lookup_failed" } },
      "authoritative_evidence_unavailable",
      true,
    ],
    [
      "integrity review",
      {
        claim: { found: true, status: "completed", leaseState: "missing", deductionRecorded: true },
        deduction: "present",
        completedResult: { kind: "replayable", creditsCharged: 12 },
      },
      {
        ...VERIFIED_PAID_EVIDENCE,
        deduction: { kind: "present", exactAttemptKeyMatch: true, expectedCreditsMatch: false },
      },
      "integrity_review_required",
      true,
    ],
  ];

  it.each(CASES.map(([label, recovery, evidence, expected, review]) => [label, recovery, evidence, expected, review] as const))(
    "%s",
    async (_label, recoveryEvidence, collected, expected, review) => {
      // C4B stamps the upstream with C2's actual classification; mirror that.
      const upstream = recoveryModule.classifyImageRenderRecovery(recoveryEvidence).classification;
      const { dep } = makeCollectorDep({
        result: collectedResult({ ...collected, upstream }),
      });
      const report = await composeImageRenderReconciliationReport(
        makeReportInput({ recoveryEvidence }),
        dep
      );

      if (report.status !== "classified") throw new Error("expected classified");
      expect(report.reconciliationClassification).toBe(expected);
      expect(report.operatorReviewRequired).toBe(review);
      expect(report.mutationAuthorized).toBe(false);
      expect(Object.isFrozen(report)).toBe(true);
      expect(Object.isFrozen(report.evidence)).toBe(true);
    }
  );
});

describe("composeImageRenderReconciliationReport — evidence summary", () => {
  it("copies only the evidence kinds, never detailed values", async () => {
    const evidence: ImageRenderReconciliationEvidence = {
      upstream: "completed_replayable",
      resultCreditsCharged: 12,
      generatedImage: {
        kind: "present",
        matchesClaimGeneratedImageId: true,
        matchesUser: true,
        matchesContentPost: true,
        matchesClaimSnapshot: false,
      },
      contentPost: { kind: "no_generated_image_link" },
      deduction: { kind: "present", exactAttemptKeyMatch: true, expectedCreditsMatch: "unknown" },
      usageObservation: "not_checked",
    };
    const { dep } = makeCollectorDep({ result: collectedResult(evidence) });
    const report = await composeImageRenderReconciliationReport(makeReportInput(), dep);

    if (report.status !== "classified") throw new Error("expected classified");
    expect(report.evidence).toEqual({
      generatedImage: "present",
      contentPost: "no_generated_image_link",
      deduction: "present",
      usageObservation: "not_checked",
    });
    const serialized = JSON.stringify(report);
    for (const forbidden of [
      "matchesClaimGeneratedImageId",
      "matchesUser",
      "matchesContentPost",
      "matchesClaimSnapshot",
      "resultCreditsCharged",
      "expectedCreditsMatch",
      "exactAttemptKeyMatch",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

describe("composeImageRenderReconciliationReport — security and immutability", () => {
  it("serialized reports contain no identities, sensitive fields, or raw errors", async () => {
    const { dep } = makeCollectorDep({
      result: new Error(`ER_ACCESS_DENIED mysql://u:p@h/db ${IDENTITY.requestAttemptKey}`),
    });
    const input = makeReportInput();
    await expect(
      composeImageRenderReconciliationReport(input, dep)
    ).rejects.toThrow();

    const { dep: okDep } = makeCollectorDep({});
    const report = await composeImageRenderReconciliationReport(input, okDep);
    const serialized = JSON.stringify(report);
    const identity = makeClaimIdentity();
    for (const forbidden of [
      identity.claimId.toString(),
      identity.userId.toString(),
      identity.contentPostId.toString(),
      identity.requestAttemptKey,
      identity.intentFingerprint,
      identity.deductionKey,
      "ownerToken",
      "activeClaimKey",
      "claimId",
      "userId",
      "contentPostId",
      "generatedImageId",
      "imageUrl",
      "resultImageUrl",
      "providerJobId",
      "idempotencyKey",
      "ER_ACCESS_DENIED",
      "mysql://",
      "SELECT",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(report).not.toBe(input);
  });
});

describe("composeImageRenderReconciliationReport — error behaviour", () => {
  it("propagates invalid C2 evidence without calling C4B", async () => {
    const { dep, calls } = makeCollectorDep({});
    await expect(
      composeImageRenderReconciliationReport(
        makeReportInput({ recoveryEvidence: { claim: { found: true } } as never }),
        dep
      )
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("lets the REAL C4B reject an invalid immutable identity before any read", async () => {
    const input = makeReportInput({
      claimIdentity: { ...makeClaimIdentity(), claimId: 0 },
    });
    await expect(
      composeImageRenderReconciliationReport(input)
    ).rejects.toThrow(/Invalid claimId/);
    expect(viMock.getDb).not.toHaveBeenCalled();
  });

  it("propagates an unexpected C4B dependency rejection without retry", async () => {
    const { dep, calls } = makeCollectorDep({ result: new Error("dep exploded") });
    await expect(
      composeImageRenderReconciliationReport(makeReportInput(), dep)
    ).rejects.toThrow("dep exploded");
    expect(calls).toHaveLength(1);
  });

  it("propagates a C4A programming error rather than reclassifying", async () => {
    const realC4A = reconciliationModule.classifyImageRenderReconciliation;
    vi.spyOn(reconciliationModule, "classifyImageRenderReconciliation").mockImplementation(
      (evidence) => {
        if (evidence.generatedImage.kind === "absent") {
          throw new Error("c4a internal bug");
        }
        return realC4A(evidence);
      }
    );
    const { dep } = makeCollectorDep({
      result: collectedResult({ ...VERIFIED_PAID_EVIDENCE, generatedImage: { kind: "absent" } }),
    });
    await expect(
      composeImageRenderReconciliationReport(makeReportInput(), dep)
    ).rejects.toThrow("c4a internal bug");
  });
});

describe("composeImageRenderReconciliationReport — dormancy and capability boundary", () => {
  it("production source has no database, mutation, timer, environment, logging, or filesystem capability", () => {
    for (const forbidden of [
      "getDb",
      "drizzle",
      "@db/schema",
      ".insert(",
      ".update(",
      ".delete(",
      ".transaction(",
      "deductCredits",
      "refundCredits",
      "recordAiUsage",
      "rearmFailedImageRenderClaim",
      "terminalizeStaleImageRenderClaim",
      "completeImageRenderClaimWithResult",
      "failImageRenderClaim",
      "generateImage",
      "storeImageBuffer",
      "setTimeout",
      "setInterval",
      "console.",
      "process.env",
      "node:fs",
      'from "fs"',
      "require(",
      "createRoute",
      "adminRouter",
      "new Cron",
      "BullMQ",
      "Worker(",
    ]) {
      expect(reportSource).not.toContain(forbidden);
    }
  });

  it("importing the module performs zero database work", () => {
    expect(viMock.getDb).not.toHaveBeenCalled();
  });
});

describe("composeImageRenderReconciliationReport — real component compatibility", () => {
  it("a valid C2 fixture feeds its actual recovery classification into C4B", async () => {
    const { dep, calls } = makeCollectorDep({});
    await composeImageRenderReconciliationReport(
      makeReportInput({
        recoveryEvidence: {
          claim: { found: true, status: "failed", leaseState: "missing", deductionRecorded: false },
          deduction: "absent",
          completedResult: { kind: "not_checked" },
        },
      }),
      dep
    );
    expect(calls[0].upstream).toBe("failed_rearmable");
  });

  it("every real composed result still has mutationAuthorized === false", async () => {
    const scenarios: Array<[ImageRenderRecoveryEvidence, ImageRenderReconciliationEvidence]> = [
      [HEALTHY_RECOVERY_EVIDENCE, { ...VERIFIED_PAID_EVIDENCE, upstream: "healthy_running" }],
      [
        {
          claim: { found: true, status: "completed", leaseState: "missing", deductionRecorded: true },
          deduction: "present",
          completedResult: { kind: "replayable", creditsCharged: 12 },
        },
        VERIFIED_PAID_EVIDENCE,
      ],
    ];
    for (const [recoveryEvidence, evidence] of scenarios) {
      const { dep } = makeCollectorDep({
        result: collectedResult({ ...evidence, upstream: "completed_replayable" }),
      });
      const report = await composeImageRenderReconciliationReport(
        makeReportInput({ recoveryEvidence }),
        dep
      );
      expect(report.mutationAuthorized).toBe(false);
    }
  });
});
