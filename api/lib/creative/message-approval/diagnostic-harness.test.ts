import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { runDiagnosticAuthority } from "./diagnostic-harness";
import { evaluateMessageCandidate } from "./evaluator";
import { createApprovedMessagePack } from "./approve";
import { verifyCanaryApprovalProof } from "./canary-proof";
import { buildMessageApprovalContextLock } from "./context-lock";
import { adaptLegacyMessagePack } from "./legacy-adapter";
import { adaptApprovedToCampaignMessagePack } from "./compatibility-adapter";
import { getDiagnosticPack, buildDiagnosticLoadedContext } from "./diagnostic-fixture";
import type { CampaignMessagePack } from "../campaign-message-architect";
import type { MessagePackCandidate } from "./contracts";

function buildFreshCandidate(fixtureCase: "approved" | "rejected_cta_mismatch"): {
  candidate: MessagePackCandidate;
  contextLock: ReturnType<typeof buildMessageApprovalContextLock>;
} {
  const loadedContext = buildDiagnosticLoadedContext();
  const contextLock = buildMessageApprovalContextLock({
    mode: "canary",
    campaignId: loadedContext.campaignId,
    loadedContext,
  });
  const legacyPack = getDiagnosticPack(fixtureCase);
  const candidate = adaptLegacyMessagePack({
    campaignId: contextLock.campaignId,
    candidateId: `test-candidate-${Date.now()}`,
    createdAtIso: new Date().toISOString(),
    businessDnaSnapshotId: contextLock.businessDnaSnapshotId,
    evidenceHashSha256: contextLock.evidenceHashSha256,
    campaignStrategySnapshotId: contextLock.campaignStrategySnapshotId,
    strategyHashSha256: contextLock.strategyHashSha256,
    qualityPolicyId: contextLock.policyId,
    qualityPolicyVersion: contextLock.policyVersion,
    policyHashSha256: contextLock.policyHashSha256,
    legacyPack,
    preferredSource: "diagnostic_fixture",
  });
  return { candidate, contextLock };
}

function runApproved() {
  return runDiagnosticAuthority({
    executionId: "00000000-0000-0000-0000-000000000001",
    fixtureCase: "approved",
    productionMode: "shadow",
  });
}

function runRejected() {
  return runDiagnosticAuthority({
    executionId: "00000000-0000-0000-0000-000000000002",
    fixtureCase: "rejected_cta_mismatch",
    productionMode: "shadow",
  });
}

describe("runDiagnosticAuthority", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it("approved fixture produces approved decision", () => {
    const result = runApproved();
    expect(result.decision).toBe("approved");
    expect(result.score).toBeGreaterThanOrEqual(80);
    expect(result.hardIssueCodes).toEqual([]);
    expect(result.legacyFallbackUsed).toBe(false);
  });

  it("rejected CTA fixture produces rejected decision with CTA_POLICY_MISMATCH", () => {
    const result = runRejected();
    expect(result.decision).toBe("rejected");
    expect(result.hardIssueCodes).toContain("CTA_POLICY_MISMATCH");
    expect(result.hardIssueCodes).toContain("PLATFORM_CAPTION_CTA_POLICY_MISMATCH");
    expect(result.legacyFallbackUsed).toBe(false);
  });

  it("returns correct execution metadata", () => {
    const result = runApproved();
    expect(result.executionMode).toBe("diagnostic_authority");
    expect(result.authorityPathExercised).toBe(true);
    expect(result.productionCanarySelected).toBe(false);
    expect(result.productionMode).toBe("shadow");
  });

  it("returns stable deterministic hashes and decision for identical fixture input", () => {
    const r1 = runApproved();
    const r2 = runApproved();

    expect(r1.decision).toBe(r2.decision);
    expect(r1.score).toBe(r2.score);
    expect(r1.evidenceHash).toBe(r2.evidenceHash);
    expect(r1.strategyHash).toBe(r2.strategyHash);
    expect(r1.policyHash).toBe(r2.policyHash);
    expect(r1.copyHash).toBe(r2.copyHash);
    expect(r1.hardIssueCodes).toEqual(r2.hardIssueCodes);
    expect(r1.warningCodes).toEqual(r2.warningCodes);
  });

  it("context lock hashes are present and non-empty", () => {
    const result = runApproved();
    expect(result.contextLockId).toMatch(/^ctx-/);
    expect(result.evidenceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.strategyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.policyHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("candidate and assessment hashes are present and non-empty", () => {
    const result = runApproved();
    expect(result.candidateId).toMatch(/^diagnostic-candidate-/);
    expect(result.candidateSource).toBe("diagnostic_fixture");
    expect(result.copyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.assessmentId).toMatch(/^diagnostic-assessment-/);
    expect(result.assessmentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("approval proof is valid and adapter matches approved copy", () => {
    const result = runApproved();
    expect(result.approvalId).toMatch(/^diagnostic-approved-/);
    expect(result.approvedCopyHash).toBe(result.copyHash);
    expect(result.adapterSemanticCopyHash).toBe(result.approvedCopyHash);
    expect(result.adapterMatchesApprovedCopy).toBe(true);
  });

  it("returns zero mutation counters", () => {
    const result = runApproved();
    expect(result.billingMutationCount).toBe(0);
    expect(result.artifactMutationCount).toBe(0);
    expect(result.publishingMutationCount).toBe(0);
  });

  it("result shape is sanitized and contains no PII/copy/raw errors", () => {
    const result = runApproved();
    const json = JSON.stringify(result);
    expect(json).not.toContain("NatForge Diagnostic");
    expect(json).not.toContain("diagnostic@natforgeai.test");
    expect(json).not.toContain("natforgeai-diagnostic.test");
    expect(json).not.toContain("Johannesburg");
    expect(json).not.toContain("payout automation");
    expect(json).not.toContain("Reduce payout delays");
    expect(json).not.toContain("Learn More");
    expect(json).not.toContain("Buy Now");
    expect(json).not.toContain("Error");
    expect(json).not.toContain("Stack");
  });

  it("repeated execution remains side-effect free and returns new ids", () => {
    const r1 = runApproved();
    const r2 = runApproved();
    expect(r1.contextLockId).not.toBe(r2.contextLockId);
    expect(r1.candidateId).not.toBe(r2.candidateId);
    expect(r1.assessmentId).not.toBe(r2.assessmentId);
    expect(r1.approvalId).not.toBe(r2.approvalId);
  });

  it("unknown production mode is handled safely", () => {
    const result = runDiagnosticAuthority({
      executionId: "00000000-0000-0000-0000-000000000003",
      fixtureCase: "approved",
      productionMode: "unknown",
    });
    expect(result.productionMode).toBe("unknown");
    expect(result.decision).toBe("approved");
  });
});

describe("V2 authority fail-closed behavior", () => {
  it("tampered business DNA snapshot id fails evaluation", () => {
    const { candidate, contextLock } = buildFreshCandidate("approved");
    const tamperedCandidate: MessagePackCandidate = {
      ...candidate,
      businessDnaSnapshotId: "tampered",
    };
    const assessment = evaluateMessageCandidate({
      assessmentId: "test-assessment",
      evaluatedAtIso: new Date().toISOString(),
      candidate: tamperedCandidate,
      businessDna: contextLock.businessDna,
      campaignStrategy: contextLock.campaignStrategy,
      policy: contextLock.policy,
    });
    expect(assessment.decision).toBe("rejected");
    expect(assessment.hardIssues.map((i) => i.code)).toContain("IDENTITY_MISMATCH_BUSINESS_DNA");
  });

  it("tampered copy hash fails evaluation", () => {
    const { candidate, contextLock } = buildFreshCandidate("approved");
    const tamperedCandidate: MessagePackCandidate = {
      ...candidate,
      copyHashSha256: "0000000000000000000000000000000000000000000000000000000000000000",
    };
    const assessment = evaluateMessageCandidate({
      assessmentId: "test-assessment",
      evaluatedAtIso: new Date().toISOString(),
      candidate: tamperedCandidate,
      businessDna: contextLock.businessDna,
      campaignStrategy: contextLock.campaignStrategy,
      policy: contextLock.policy,
    });
    expect(assessment.decision).toBe("rejected");
    expect(assessment.hardIssues.map((i) => i.code)).toContain("IDENTITY_MISMATCH_COPY_HASH");
  });

  it("tampered assessment decision cannot be approved", () => {
    const { candidate, contextLock } = buildFreshCandidate("approved");
    const assessment = evaluateMessageCandidate({
      assessmentId: "test-assessment",
      evaluatedAtIso: new Date().toISOString(),
      candidate,
      businessDna: contextLock.businessDna,
      campaignStrategy: contextLock.campaignStrategy,
      policy: contextLock.policy,
    });
    const tamperedAssessment = { ...assessment, decision: "rejected" as const };
    expect(() =>
      createApprovedMessagePack({
        approvedRevisionId: "test-revision",
        approvedAtIso: new Date().toISOString(),
        candidate,
        assessment: tamperedAssessment,
        policy: contextLock.policy,
      })
    ).toThrow();
  });

  it("stale envelope cannot bypass proof validation", () => {
    const { candidate, contextLock } = buildFreshCandidate("approved");
    const assessment = evaluateMessageCandidate({
      assessmentId: "test-assessment",
      evaluatedAtIso: new Date().toISOString(),
      candidate,
      businessDna: contextLock.businessDna,
      campaignStrategy: contextLock.campaignStrategy,
      policy: contextLock.policy,
    });
    if (assessment.decision !== "approved") {
      throw new Error("Expected approved assessment for this test");
    }
    const approved = createApprovedMessagePack({
      approvedRevisionId: "test-revision",
      approvedAtIso: new Date().toISOString(),
      candidate,
      assessment,
      policy: contextLock.policy,
    });
    const adapted = adaptApprovedToCampaignMessagePack({
      approved,
      assessment,
      contextLock,
      candidateSource: "diagnostic_fixture",
      specificityScore: (pack) => pack.specificityScore ?? 0,
    });

    const staleProof = {
      ...adapted.proof,
      envelope: {
        ...adapted.proof.envelope,
        assessmentHashSha256: "0000000000000000000000000000000000000000000000000000000000000000",
      },
    };

    expect(() => verifyCanaryApprovalProof(adapted.pack, staleProof)).toThrow();
  });
});

describe("diagnostic-harness dependency boundary", () => {
  const BASE_DIR = __dirname;
  const PURE_FILES = [
    "diagnostic-harness.ts",
    "canary-proof.ts",
    "context-lock.ts",
    "diagnostic-fixture.ts",
  ];

  const RUNTIME_FORBIDDEN_IMPORTS = [
    "../campaign-message-architect",
    "../../billing",
    "../../agents",
    "../../jobs",
    "../../queue",
    "../../workflow",
    "../../integrations",
    "../../queries/connection",
    "drizzle-orm",
    "@db/schema",
    "../../creative/service",
    "bullmq",
    "openai",
    "ai",
    "fs",
    "node:fs",
    "path",
    "node:path",
    "../../publishing-router",
    "../../schedule-router",
    "../../image-router",
    "../../video-router",
  ];

  function extractRuntimeImports(source: string): string[] {
    const imports: string[] = [];
    const importRegex = /import\s+(?:(?:\{[^}]*\}|[^'"]*)\s+from\s+)?['"]([^'"]+)['"];/g;
    let match: RegExpExecArray | null;
    while ((match = importRegex.exec(source)) !== null) {
      const statement = match[0];
      const path = match[1];
      if (statement.includes("import type")) continue;
      if (statement.includes("{ type ")) continue;
      imports.push(path);
    }
    return imports;
  }

  for (const file of PURE_FILES) {
    it(`${file} has no forbidden runtime imports`, () => {
      const source = readFileSync(join(BASE_DIR, file), "utf-8");
      const runtimeImports = extractRuntimeImports(source);
      for (const forbidden of RUNTIME_FORBIDDEN_IMPORTS) {
        const matches = runtimeImports.filter((imp) => imp.includes(forbidden));
        expect(matches).toEqual([]);
      }
    });
  }

  it("diagnostic-harness.ts does not runtime-import campaign-message-architect.ts", () => {
    const source = readFileSync(join(BASE_DIR, "diagnostic-harness.ts"), "utf-8");
    const runtimeImports = extractRuntimeImports(source);
    expect(runtimeImports).not.toContain("../campaign-message-architect");
  });

  it("canary-proof.ts only imports campaign-message-architect.ts as a type", () => {
    const source = readFileSync(join(BASE_DIR, "canary-proof.ts"), "utf-8");
    const lines = source.split("\n");
    const campaignArchitectLines = lines.filter((line) =>
      line.includes("../campaign-message-architect")
    );
    expect(campaignArchitectLines.length).toBeGreaterThan(0);
    for (const line of campaignArchitectLines) {
      expect(line.trim()).toMatch(/^import\s+type\s+/);
    }
  });
});
