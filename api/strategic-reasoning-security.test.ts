/**
 * R8-D — Rogue-Agent Security Acceptance (adversarial suite).
 *
 * Assumes a compromised strategic-reasoning client/agent and proves the
 * containment boundaries: no fabricated evidence, no trust/confidence
 * elevation, no suppressed contradiction, no invented causation, no lowered
 * risk, no self-approval, no governance substitution, no policy alteration,
 * no secret access, no tool execution, no execution authority of any kind.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./queries/connection", () => ({
  getDb: vi.fn(() => {
    throw new Error("getDb must not fall back to a real connection in the R8-D security suite");
  }),
}));

import { createFakeDb, buildCtx } from "./r5-test-support";
import { strategicReasoningRouter } from "./strategic-reasoning-router";
import { evaluateStrategicReasoning } from "./lib/strategic-reasoning/strategic-reasoning-service";
import { bindStrategicReasoningStoreExecutor } from "./lib/strategic-reasoning/strategic-reasoning-store";
import {
  createInMemoryEvidenceAuthority,
  type FakeEvidenceRow,
} from "./lib/strategic-reasoning/strategic-reasoning-evidence-seam";
import {
  clearStrategicGovernanceEnginePort,
  createInMemoryApprovalReadPort,
  registerStrategicGovernanceEnginePort,
  type StrategicApprovalRowView,
} from "./lib/strategic-reasoning/strategic-reasoning-governance-seam";
import {
  assertNoClientAuthorityFields,
  EvaluateStrategicReasoningInputSchema,
  StrategicReasoningError,
} from "./lib/strategic-reasoning/strategic-reasoning-contract";
import { createHash } from "crypto";

const hex = (n: number) => String(n).padStart(64, "0");
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const NOW = new Date("2026-11-10T00:00:00.000Z");
const RECENT = new Date(NOW.getTime() - 2 * 24 * 3600_000).toISOString();

let seq = 1000;
const nextRef = (p: "mem1:" | "chg1:" | "xsig1:") => `${p}${hex(++seq)}`;

function chgRaw(ref: string, over: Record<string, unknown> = {}) {
  return {
    changeId: ref,
    changeDomain: "PORTFOLIO_PERFORMANCE",
    changeType: "LEARNING_PATTERN_CONTRADICTED",
    subjectType: "LEARNING",
    subjectId: "learning:campaign:500",
    significanceClass: "HIGH",
    confidenceClass: "VERIFIED",
    status: "CONFIRMED",
    sourceAuthority: "r7_learning",
    sourceVersion: "business-learning-to-experiment-optimisation/v1",
    detectedAt: RECENT,
    effectiveAt: RECENT,
    recordedAt: RECENT,
    validUntil: null,
    supersedesChangeId: null,
    evidenceHash: hex(12),
    ...over,
  };
}

function boot() {
  const env = createFakeDb({
    businesses: [{ id: 10, userId: 1, isActive: true }],
    campaigns: [],
    strategic_reasoning_bundles: [],
    strategic_reasoning_records: [],
    strategic_reasoning_lifecycle_events: [],
    approval_requests: [],
    audit_events: [],
  });
  const evidence: FakeEvidenceRow[] = [];
  const approvals: StrategicApprovalRowView[] = [];
  const deps = {
    evidence: createInMemoryEvidenceAuthority(evidence),
    approvals: createInMemoryApprovalReadPort(approvals),
    now: () => NOW,
  };
  return { env, evidence, approvals, deps, executor: bindStrategicReasoningStoreExecutor(env.db as never) };
}

beforeEach(() => {
  clearStrategicGovernanceEnginePort();
});

describe("R8-D rogue-agent security — client authority smuggling", () => {
  it("rejects every client-supplied authority field at the zod boundary", () => {
    const forbidden = [
      { decision: "ALLOW_RECOMMENDATION" },
      { confidenceClass: "HIGH" },
      { uncertaintyClasses: ["WEAK_EVIDENCE"] },
      { strategicRiskClass: "LOW" },
      { status: "APPROVED_RECOMMENDATION" },
      { approvalStatus: "approved" },
      { approved: true },
      { executable: true },
      { governanceDecisionId: `sgd1:${hex(1)}` },
      { evidenceFingerprint: hex(1) },
      { reasoningFingerprint: hex(1) },
      { policyVersion: "strategic-governance-policy/v1" },
      { evidenceBundle: { tampered: true } },
      { reasoningGraph: { nodes: [], edges: [] } },
      { reasonCodes: ["FORGED"] },
      { sourceTrustClass: "VERIFIED_EXTERNAL" },
      { forceAllow: true },
      { forceApprove: true },
      { raiseConfidence: true },
      { lowerRisk: true },
      { promoteTrust: true },
      { setTrusted: true },
      { suppressContradiction: true },
      { overridePolicy: true },
    ];
    for (const field of forbidden) {
      const parsed = EvaluateStrategicReasoningInputSchema.safeParse({
        businessId: 10,
        memoryRefs: [],
        changeRefs: [],
        externalSignalRefs: [],
        ...field,
      });
      expect(parsed.success, `field ${JSON.stringify(field)} must be rejected`).toBe(false);
    }
  });

  it("assertNoClientAuthorityFields rejects direct smuggling attempts", () => {
    expect(() => assertNoClientAuthorityFields({ confidence: "HIGH" })).toThrow(StrategicReasoningError);
    expect(() => assertNoClientAuthorityFields({ businessId: 10, memoryRefs: [] })).not.toThrow();
  });

  it("rejects unknown model-candidate hypothesis strings", () => {
    const parsed = EvaluateStrategicReasoningInputSchema.safeParse({
      businessId: 10,
      modelAssistance: { candidateHypothesisTypes: ["LAUNCH_CAMPAIGN"] },
    });
    expect(parsed.success).toBe(false);
  });

  it("unauthenticated callers are rejected by the authed router", async () => {
    const caller = strategicReasoningRouter.createCaller(buildCtx(null));
    await expect(
      caller.evaluate({ businessId: 10, memoryRefs: [], changeRefs: [], externalSignalRefs: [] })
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

describe("R8-D rogue-agent security — governance substitution & tampering", () => {
  it("absent R8-F authority fails closed — no guessed governance", async () => {
    const w = boot();
    const chg = nextRef("chg1:");
    w.evidence.push({ table: "business_change_events", row: chgRaw(chg), userId: 1, businessId: 10 });
    await expect(
      evaluateStrategicReasoning(
        { userId: 1, businessId: 10, memoryRefs: [], changeRefs: [chg], externalSignalRefs: [] },
        w.deps,
        w.executor
      )
    ).rejects.toMatchObject({ code: "STRATEGIC_GOVERNANCE_AUTHORITY_UNAVAILABLE" });
  });

  it("malformed engine decision payloads are rejected", async () => {
    const w = boot();
    registerStrategicGovernanceEnginePort({
      async evaluateProposal() {
        return { governanceDecisionId: "not-an-id", decision: "ALLOW_RECOMMENDATION" };
      },
    });
    const chg = nextRef("chg1:");
    w.evidence.push({ table: "business_change_events", row: chgRaw(chg), userId: 1, businessId: 10 });
    await expect(
      evaluateStrategicReasoning(
        { userId: 1, businessId: 10, memoryRefs: [], changeRefs: [chg], externalSignalRefs: [] },
        w.deps,
        w.executor
      )
    ).rejects.toMatchObject({ code: "GOVERNANCE_DECISION_MALFORMED" });
  });

  it("engine decision bound to a different business/proposal is rejected (cross-agent trust)", async () => {
    const w = boot();
    registerStrategicGovernanceEnginePort({
      async evaluateProposal({ proposal }: { userId: number; businessId: number; proposal: unknown }) {
        const p = proposal as Record<string, unknown>;
        return {
          governanceDecisionId: `sgd1:${sha("rogue")}`,
          proposalId: p.proposalId,
          businessId: 999, // cross-business decision smuggling
          recommendationType: p.recommendationType,
          decision: "ALLOW_RECOMMENDATION",
          policyVersion: "strategic-governance-policy/v1",
          evidenceFingerprint: sha("e"),
          proposalFingerprint: sha("p"),
          strategicRiskClass: "LOW",
          confidenceClass: p.claimedConfidence,
          sourceTrustClass: "AUTHORITATIVE_INTERNAL",
          approvalRequired: false,
          reasonCodes: ["ROGUE"],
          validUntil: null,
        };
      },
    });
    const chg = nextRef("chg1:");
    w.evidence.push({ table: "business_change_events", row: chgRaw(chg), userId: 1, businessId: 10 });
    await expect(
      evaluateStrategicReasoning(
        { userId: 1, businessId: 10, memoryRefs: [], changeRefs: [chg], externalSignalRefs: [] },
        w.deps,
        w.executor
      )
    ).rejects.toMatchObject({ code: "GOVERNANCE_DECISION_MALFORMED" });
  });

  it("risk class can never be lowered by the caller — it is carried from the decision only", async () => {
    const w = boot();
    registerStrategicGovernanceEnginePort({
      async evaluateProposal({ proposal }: { userId: number; businessId: number; proposal: unknown }) {
        const p = proposal as Record<string, unknown>;
        return {
          governanceDecisionId: `sgd1:${sha("risk")}`,
          proposalId: p.proposalId,
          businessId: p.businessId,
          recommendationType: p.recommendationType,
          decision: "ALLOW_RECOMMENDATION",
          policyVersion: "strategic-governance-policy/v1",
          evidenceFingerprint: sha("e"),
          proposalFingerprint: sha("p"),
          strategicRiskClass: "HIGH",
          confidenceClass: p.claimedConfidence,
          sourceTrustClass: "AUTHORITATIVE_INTERNAL",
          approvalRequired: false,
          reasonCodes: ["RISK_HIGH"],
          validUntil: null,
        };
      },
    });
    const chg = nextRef("chg1:");
    w.evidence.push({ table: "business_change_events", row: chgRaw(chg), userId: 1, businessId: 10 });
    const res = await evaluateStrategicReasoning(
      { userId: 1, businessId: 10, memoryRefs: [], changeRefs: [chg], externalSignalRefs: [] },
      w.deps,
      w.executor
    );
    expect(res.reasoning.strategicRiskClass).toBe("HIGH");
    // No input surface exists to lower it.
    const parsed = EvaluateStrategicReasoningInputSchema.safeParse({ businessId: 10, strategicRiskClass: "LOW" });
    expect(parsed.success).toBe(false);
  });
});

describe("R8-D rogue-agent security — approval integrity", () => {
  async function voicedReviewWorld() {
    const w = boot();
    registerStrategicGovernanceEnginePort({
      async evaluateProposal({ proposal }: { userId: number; businessId: number; proposal: unknown }) {
        const p = proposal as Record<string, unknown>;
        return {
          governanceDecisionId: `sgd1:${sha("review")}`,
          proposalId: p.proposalId,
          businessId: p.businessId,
          recommendationType: p.recommendationType,
          decision: "REVIEW_REQUIRED",
          policyVersion: "strategic-governance-policy/v1",
          evidenceFingerprint: sha("ev"),
          proposalFingerprint: sha("pf"),
          strategicRiskClass: "MEDIUM",
          confidenceClass: p.claimedConfidence,
          sourceTrustClass: "AUTHORITATIVE_INTERNAL",
          approvalRequired: true,
          reasonCodes: ["HUMAN_REVIEW"],
          validUntil: null,
        };
      },
    });
    const chg = nextRef("chg1:");
    w.evidence.push({ table: "business_change_events", row: chgRaw(chg), userId: 1, businessId: 10 });
    const res = await evaluateStrategicReasoning(
      { userId: 1, businessId: 10, memoryRefs: [], changeRefs: [chg], externalSignalRefs: [] },
      w.deps,
      w.executor
    );
    return { w, res };
  }

  it("tenant JWT alone can never self-approve (read-only ledger, binding-validated)", async () => {
    const { w, res } = await voicedReviewWorld();
    expect(res.reasoning.status).toBe("REVIEW_REQUIRED");
    // No approval-writing procedure exists on the router.
    const procedures = Object.keys(strategicReasoningRouter._def.procedures);
    expect(procedures).toEqual(
      expect.arrayContaining(["evaluate", "get", "list", "listLifecycle", "reevaluate", "getHandoffProjections"])
    );
    expect(procedures.some((p) => p.toLowerCase().includes("approv"))).toBe(false);
    void w;
  });

  it("cross-proposal approval replay is rejected", async () => {
    const { w, res } = await voicedReviewWorld();
    const decision = res.governanceDecision!;
    w.approvals.push({
      id: 1,
      status: "approved",
      binding: {
        governanceDecisionId: decision.governanceDecisionId,
        policyVersion: decision.policyVersion,
        proposalFingerprint: sha("a-different-proposal"), // replayed from another proposal
        evidenceFingerprint: decision.evidenceFingerprint,
        approvalBindingHash: deriveWrongHash(decision.governanceDecisionId, decision.policyVersion),
      },
    });
    await expect(
      (await import("./lib/strategic-reasoning/strategic-reasoning-service")).getStrategicReasoningForUser({
        userId: 1,
        reasoningId: res.reasoning.reasoningId,
        deps: w.deps,
        executor: w.executor,
      })
    ).rejects.toMatchObject({ code: "APPROVAL_BINDING_MISMATCH" });
  });
});

function deriveWrongHash(governanceDecisionId: string, policyVersion: string): string {
  // A binding hash that validates formally but binds different proposal
  // material — cross-proposal replay must still fail the fingerprint checks.
  return sha(
    JSON.stringify({
      v: 1,
      governanceDecisionId,
      policyVersion,
      proposalFingerprint: sha("a-different-proposal"),
      evidenceFingerprint: sha("ev"),
    })
  );
}

describe("R8-D rogue-agent security — evidence integrity", () => {
  it("malformed upstream rows (tampered hash) fail closed", async () => {
    const w = boot();
    const chg = nextRef("chg1:");
    w.evidence.push({
      table: "business_change_events",
      row: chgRaw(chg, { evidenceHash: "not-a-hash" }),
      userId: 1,
      businessId: 10,
    });
    await expect(
      evaluateStrategicReasoning(
        { userId: 1, businessId: 10, memoryRefs: [], changeRefs: [chg], externalSignalRefs: [] },
        w.deps,
        w.executor
      )
    ).rejects.toMatchObject({ code: "MALFORMED_EVIDENCE" });
  });

  it("tampered bundle fingerprint conflict fails closed", async () => {
    const w = boot();
    const chg = nextRef("chg1:");
    w.evidence.push({ table: "business_change_events", row: chgRaw(chg), userId: 1, businessId: 10 });
    // Pre-plant a bundle row under the deterministic id the evaluation will
    // derive, with a tampered fingerprint.
    const { deriveEvidenceBundleId } = await import("./lib/strategic-reasoning/strategic-reasoning-identity");
    const item = {
      ref: chg,
      evidenceClass: "INTERNAL_CHANGE" as const,
      sourceVersion: "business-learning-to-experiment-optimisation/v1",
      status: "CONFIRMED",
      observedAt: RECENT,
      recordedAt: RECENT,
    };
    const bundleId = deriveEvidenceBundleId({ businessId: 10, items: [item] });
    w.env.seed.strategic_reasoning_bundles.push({
      bundleId,
      userId: 1,
      businessId: 10,
      evidenceRefs: {},
      evidenceFingerprint: hex(777), // tampered
      reasoningGraph: { nodes: [], edges: [] },
      sourceVersions: {},
    });
    await expect(
      evaluateStrategicReasoning(
        { userId: 1, businessId: 10, memoryRefs: [], changeRefs: [chg], externalSignalRefs: [] },
        w.deps,
        w.executor
      )
    ).rejects.toMatchObject({ code: "EVIDENCE_FINGERPRINT_MISMATCH" });
  });

  it("secret isolation — no env/secret access anywhere in the stream", async () => {
    const fs = await import("fs");
    const files = [
      "api/lib/strategic-reasoning/strategic-reasoning-service.ts",
      "api/lib/strategic-reasoning/strategic-reasoning-evidence-seam.ts",
      "api/lib/strategic-reasoning/strategic-reasoning-governance-seam.ts",
      "api/lib/strategic-reasoning/strategic-reasoning-synthesis.ts",
      "api/lib/strategic-reasoning/strategic-reasoning-store.ts",
      "api/lib/strategic-reasoning/strategic-reasoning-projection.ts",
      "api/strategic-reasoning-router.ts",
    ];
    for (const file of files) {
      const src = fs.readFileSync(file, "utf8");
      expect(src).not.toContain("process.env");
      expect(src).not.toContain("secrets");
      expect(src).not.toContain("FIREBASE_SERVICE_ACCOUNT");
    }
  });
});
