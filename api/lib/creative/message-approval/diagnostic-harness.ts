import { evaluateMessageCandidate } from "./evaluator";
import { createApprovedMessagePack } from "./approve";
import { adaptApprovedToCampaignMessagePack } from "./compatibility-adapter";
import { adaptLegacyMessagePack } from "./legacy-adapter";
import { buildMessageApprovalContextLock } from "./context-lock";
import { verifyCanaryApprovalProof } from "./canary-proof";
import {
  computeSha256FromPayload,
  serializeCanonicalCopy,
} from "./hash";
import { randomUUID } from "node:crypto";
import type {
  CandidateSource,
  MessageAssessment,
} from "./contracts";
import type { CampaignMessagePack } from "../campaign-message-architect";
import type { DiagnosticFixtureCase } from "./diagnostic-fixture";
import { buildDiagnosticLoadedContext, getDiagnosticPack } from "./diagnostic-fixture";

export type DiagnosticProductionMode =
  | "off"
  | "shadow"
  | "canary"
  | "active"
  | "unknown";

export interface DiagnosticAuthorityInput {
  readonly executionId: string;
  readonly fixtureCase: DiagnosticFixtureCase;
  readonly productionMode: DiagnosticProductionMode;
}

export interface DiagnosticAuthorityResult {
  readonly executionId: string;
  readonly timestamp: string;

  readonly productionMode: DiagnosticProductionMode;
  readonly executionMode: "diagnostic_authority";
  readonly authorityPathExercised: true;
  readonly productionCanarySelected: false;

  readonly contextLockId: string;
  readonly evidenceHash: string;
  readonly strategyHash: string;
  readonly policyHash: string;

  readonly candidateId: string;
  readonly candidateSource: CandidateSource;
  readonly copyHash: string;

  readonly assessmentId: string;
  readonly assessmentHash: string;
  readonly decision: "approved" | "rejected";
  readonly score: number;
  readonly hardIssueCodes: readonly string[];
  readonly warningCodes: readonly string[];

  readonly approvalId: string | null;
  readonly approvedCopyHash: string | null;

  readonly adapterSemanticCopyHash: string | null;
  readonly adapterMatchesApprovedCopy: boolean | null;

  /**
   * These counters represent mutation operations initiated by the isolated
   * diagnostic authority execution itself. They are not observations of global
   * production database deltas. They remain zero because the pure diagnostic
   * harness has no billing, persistence, queue, workflow, publishing,
   * filesystem, or external-service mutation capability. Production state is
   * verified independently by the operator runbook.
   */
  readonly billingMutationCount: number;
  readonly artifactMutationCount: number;
  readonly publishingMutationCount: number;

  readonly legacyFallbackUsed: false;

  readonly durationMs: number;
  readonly errorStage: string | null;
  readonly errorCode: string | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeHardIssues(assessment: MessageAssessment): readonly string[] {
  return assessment.hardIssues.map((issue) => issue.code);
}

function normalizeWarnings(assessment: MessageAssessment): readonly string[] {
  return assessment.warnings.map((issue) => issue.code);
}

function computeAdapterSemanticCopyHash(pack: CampaignMessagePack): string {
  const compatibilityCopy = {
    copySchemaVersion: "v2.1",
    headline: pack.headline,
    subheadline: pack.subheadline,
    benefitBulletsOrdered: [...pack.benefitBullets],
    cta: pack.cta,
    footer: {
      phone: pack.footerContact?.phone ?? null,
      whatsapp: pack.footerContact?.whatsapp ?? null,
      email: pack.footerContact?.email ?? null,
      website: pack.footerContact?.website ?? null,
      location: pack.footerContact?.location ?? null,
    },
    proofPointsOrdered: Array.isArray(pack.proofPoints) ? [...pack.proofPoints] : [],
    platformCaptionsOrdered: Array.isArray(pack.platformCaptions)
      ? pack.platformCaptions.map((caption) => ({
          platform: caption.platform,
          caption: caption.caption,
          cta: caption.cta,
          hashtagsOrdered: Array.isArray(caption.hashtags) ? [...caption.hashtags] : [],
        }))
      : [],
  };

  const payload = serializeCanonicalCopy(compatibilityCopy);
  return computeSha256FromPayload(payload);
}

export function runDiagnosticAuthority(
  input: DiagnosticAuthorityInput
): DiagnosticAuthorityResult {
  const started = Date.now();
  const timestamp = nowIso();
  const candidateSource: CandidateSource = "diagnostic_fixture";
  const traceNonce = randomUUID();

  try {
    const loadedContext = buildDiagnosticLoadedContext();
    const contextLock = buildMessageApprovalContextLock({
      mode: "canary",
      campaignId: loadedContext.campaignId,
      loadedContext,
      traceNonce,
    });

    const legacyPack = getDiagnosticPack(input.fixtureCase);
    const candidate = adaptLegacyMessagePack({
      campaignId: contextLock.campaignId,
      candidateId: `diagnostic-candidate-${traceNonce}`,
      createdAtIso: timestamp,
      businessDnaSnapshotId: contextLock.businessDnaSnapshotId,
      evidenceHashSha256: contextLock.evidenceHashSha256,
      campaignStrategySnapshotId: contextLock.campaignStrategySnapshotId,
      strategyHashSha256: contextLock.strategyHashSha256,
      qualityPolicyId: contextLock.policyId,
      qualityPolicyVersion: contextLock.policyVersion,
      policyHashSha256: contextLock.policyHashSha256,
      legacyPack,
      preferredSource: candidateSource,
    });

    const assessment = evaluateMessageCandidate({
      assessmentId: `diagnostic-assessment-${traceNonce}`,
      evaluatedAtIso: timestamp,
      candidate,
      businessDna: contextLock.businessDna,
      campaignStrategy: contextLock.campaignStrategy,
      policy: contextLock.policy,
    });

    const hardIssueCodes = normalizeHardIssues(assessment);
    const warningCodes = normalizeWarnings(assessment);

    let approvalId: string | null = null;
    let approvedCopyHash: string | null = null;
    let adapterSemanticCopyHash: string | null = null;
    let adapterMatchesApprovedCopy: boolean | null = null;

    if (assessment.decision === "approved") {
      const approved = createApprovedMessagePack({
        approvedRevisionId: `diagnostic-approved-${traceNonce}`,
        approvedAtIso: timestamp,
        candidate,
        assessment,
        policy: contextLock.policy,
      });

      const adapted = adaptApprovedToCampaignMessagePack({
        approved,
        assessment,
        contextLock,
        candidateSource,
        specificityScore: (pack) => pack.specificityScore ?? 0,
      });

      adapterSemanticCopyHash = computeAdapterSemanticCopyHash(adapted.pack);
      adapterMatchesApprovedCopy = adapterSemanticCopyHash === approved.copyHashSha256;
      approvalId = approved.approvedRevisionId;
      approvedCopyHash = approved.copyHashSha256;

      verifyCanaryApprovalProof(adapted.pack, adapted.proof);

      if (!adapterMatchesApprovedCopy) {
        throw new Error("Diagnostic authority adapter semantic copy mismatch.");
      }
    }

    return {
      executionId: input.executionId,
      timestamp,
      productionMode: input.productionMode,
      executionMode: "diagnostic_authority",
      authorityPathExercised: true,
      productionCanarySelected: false,
      contextLockId: contextLock.contextLockId,
      evidenceHash: contextLock.evidenceHashSha256,
      strategyHash: contextLock.strategyHashSha256,
      policyHash: contextLock.policyHashSha256,
      candidateId: candidate.candidateId,
      candidateSource,
      copyHash: candidate.copyHashSha256,
      assessmentId: assessment.assessmentId,
      assessmentHash: assessment.assessmentHashSha256,
      decision: assessment.decision,
      score: assessment.score,
      hardIssueCodes,
      warningCodes,
      approvalId,
      approvedCopyHash,
      adapterSemanticCopyHash,
      adapterMatchesApprovedCopy,
      billingMutationCount: 0,
      artifactMutationCount: 0,
      publishingMutationCount: 0,
      legacyFallbackUsed: false,
      durationMs: Date.now() - started,
      errorStage: null,
      errorCode: null,
    };
  } catch (err: any) {
    const errorCode =
      typeof err?.code === "string" ? err.code : "DIAGNOSTIC_AUTHORITY_ERROR";

    return {
      executionId: input.executionId,
      timestamp,
      productionMode: input.productionMode,
      executionMode: "diagnostic_authority",
      authorityPathExercised: true,
      productionCanarySelected: false,
      contextLockId: "",
      evidenceHash: "",
      strategyHash: "",
      policyHash: "",
      candidateId: "",
      candidateSource,
      copyHash: "",
      assessmentId: "",
      assessmentHash: "",
      decision: "rejected",
      score: 0,
      hardIssueCodes: [],
      warningCodes: [],
      approvalId: null,
      approvedCopyHash: null,
      adapterSemanticCopyHash: null,
      adapterMatchesApprovedCopy: null,
      billingMutationCount: 0,
      artifactMutationCount: 0,
      publishingMutationCount: 0,
      legacyFallbackUsed: false,
      durationMs: Date.now() - started,
      errorStage: "diagnostic_authority_error",
      errorCode,
    };
  }
}
