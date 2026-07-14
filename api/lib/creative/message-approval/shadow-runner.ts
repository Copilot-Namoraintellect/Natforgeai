import type {
  BusinessDNASnapshot,
  CampaignStrategySnapshot,
  CreativePipelineV2Mode,
  MessageQualityPolicy,
  ShadowEvaluationResult,
} from "./contracts";
import type { CampaignMessagePack } from "../campaign-message-architect";
import { adaptLegacyMessagePack } from "./legacy-adapter";
import { evaluateMessageCandidate } from "./evaluator";

const ALLOWED_MODES: ReadonlySet<string> = new Set(["off", "shadow", "canary", "active"]);

export function getCreativePipelineV2Mode(raw: string | null | undefined): CreativePipelineV2Mode {
  const value = (raw ?? "off").toLowerCase().trim();
  if (!ALLOWED_MODES.has(value)) return "off";
  return value as CreativePipelineV2Mode;
}

export interface RunShadowMessageApprovalInput {
  readonly mode: CreativePipelineV2Mode;
  readonly campaignId: number;
  readonly workflowRunId: string | null;
  readonly candidateId: string;
  readonly assessmentId: string;
  readonly legacyPack: CampaignMessagePack;
  readonly businessDna: BusinessDNASnapshot;
  readonly campaignStrategy: CampaignStrategySnapshot;
  readonly policy: MessageQualityPolicy;
  readonly contextDiagnostics: Pick<
    ShadowEvaluationResult,
    "contextSource" | "contextReadyForComparison" | "missingContextFields"
  >;
  readonly evaluate?: typeof evaluateMessageCandidate;
  readonly onWriteAttempt?: () => void;
  readonly now: () => number;
  readonly nowIso: () => string;
  readonly log: (result: ShadowEvaluationResult) => void;
}

export function runShadowMessageApproval(
  input: RunShadowMessageApprovalInput
): ShadowEvaluationResult | null {
  if (input.mode !== "shadow") return null;

  const started = input.now();

  try {
    let candidate;
    try {
      candidate = adaptLegacyMessagePack({
        campaignId: input.campaignId,
        candidateId: input.candidateId,
        createdAtIso: input.nowIso(),
        businessDnaSnapshotId: input.businessDna.snapshotId,
        campaignStrategySnapshotId: input.campaignStrategy.snapshotId,
        qualityPolicyId: input.policy.policyId,
        qualityPolicyVersion: input.policy.policyVersion,
        legacyPack: input.legacyPack,
      });
    } catch {
      const result: ShadowEvaluationResult = {
        mode: input.mode,
        campaignId: input.campaignId,
        workflowRunId: input.workflowRunId,
        contextSource: input.contextDiagnostics.contextSource,
        contextReadyForComparison: input.contextDiagnostics.contextReadyForComparison,
        missingContextFields: input.contextDiagnostics.missingContextFields,
        candidateId: input.candidateId,
        candidateSource: "unknown",
        copyHashSha256: "",
        legacyDecision:
          input.legacyPack.validation?.passed && !input.legacyPack.isGeneric
            ? "approved"
            : "rejected",
        legacyIsGeneric:
          typeof input.legacyPack.isGeneric === "boolean"
            ? input.legacyPack.isGeneric
            : null,
        legacyScore:
          typeof input.legacyPack.validation?.score === "number"
            ? input.legacyPack.validation.score
            : null,
        v2Decision: null,
        v2HardIssueCodes: [],
        v2WarningCodes: [],
        v2Score: null,
        decisionMatched: null,
        durationMs: Math.max(0, input.now() - started),
        errorStage: "adapter",
        errorCode: "SHADOW_ADAPTER_FAILED",
      };
      input.log(result);
      return result;
    }

    let assessment;
    try {
      const evaluator = input.evaluate ?? evaluateMessageCandidate;
      assessment = evaluator({
        assessmentId: input.assessmentId,
        evaluatedAtIso: input.nowIso(),
        candidate,
        businessDna: input.businessDna,
        campaignStrategy: input.campaignStrategy,
        policy: input.policy,
      });
    } catch {
      const result: ShadowEvaluationResult = {
        mode: input.mode,
        campaignId: input.campaignId,
        workflowRunId: input.workflowRunId,
        contextSource: input.contextDiagnostics.contextSource,
        contextReadyForComparison: input.contextDiagnostics.contextReadyForComparison,
        missingContextFields: input.contextDiagnostics.missingContextFields,
        candidateId: candidate.candidateId,
        candidateSource: candidate.source,
        copyHashSha256: candidate.copyHashSha256,
        legacyDecision:
          input.legacyPack.validation?.passed && !input.legacyPack.isGeneric
            ? "approved"
            : "rejected",
        legacyIsGeneric:
          typeof input.legacyPack.isGeneric === "boolean"
            ? input.legacyPack.isGeneric
            : null,
        legacyScore:
          typeof input.legacyPack.validation?.score === "number"
            ? input.legacyPack.validation.score
            : null,
        v2Decision: null,
        v2HardIssueCodes: [],
        v2WarningCodes: [],
        v2Score: null,
        decisionMatched: null,
        durationMs: Math.max(0, input.now() - started),
        errorStage: "evaluation",
        errorCode: "SHADOW_EVALUATION_FAILED",
      };
      input.log(result);
      return result;
    }

    const legacyDecision = input.legacyPack.validation?.passed && !input.legacyPack.isGeneric ? "approved" : "rejected";
    const result: ShadowEvaluationResult = {
      mode: input.mode,
      campaignId: input.campaignId,
      workflowRunId: input.workflowRunId,
      contextSource: input.contextDiagnostics.contextSource,
      contextReadyForComparison: input.contextDiagnostics.contextReadyForComparison,
      missingContextFields: input.contextDiagnostics.missingContextFields,
      candidateId: candidate.candidateId,
      candidateSource: candidate.source,
      copyHashSha256: candidate.copyHashSha256,
      legacyDecision,
      legacyIsGeneric: typeof input.legacyPack.isGeneric === "boolean" ? input.legacyPack.isGeneric : null,
      legacyScore: typeof input.legacyPack.validation?.score === "number" ? input.legacyPack.validation.score : null,
      v2Decision: assessment.decision,
      v2HardIssueCodes: assessment.hardIssues.map((i) => i.code),
      v2WarningCodes: assessment.warnings.map((i) => i.code),
      v2Score: assessment.score,
      decisionMatched: legacyDecision === assessment.decision,
      durationMs: Math.max(0, input.now() - started),
      errorStage: null,
      errorCode: null,
    };

    input.log(result);
    return result;
  } catch {
    const result: ShadowEvaluationResult = {
      mode: input.mode,
      campaignId: input.campaignId,
      workflowRunId: input.workflowRunId,
      contextSource: input.contextDiagnostics.contextSource,
      contextReadyForComparison: input.contextDiagnostics.contextReadyForComparison,
      missingContextFields: input.contextDiagnostics.missingContextFields,
      candidateId: input.candidateId,
      candidateSource: "unknown",
      copyHashSha256: "",
      legacyDecision: input.legacyPack.validation?.passed && !input.legacyPack.isGeneric ? "approved" : "rejected",
      legacyIsGeneric: typeof input.legacyPack.isGeneric === "boolean" ? input.legacyPack.isGeneric : null,
      legacyScore: typeof input.legacyPack.validation?.score === "number" ? input.legacyPack.validation.score : null,
      v2Decision: null,
      v2HardIssueCodes: [],
      v2WarningCodes: [],
      v2Score: null,
      decisionMatched: null,
      durationMs: Math.max(0, input.now() - started),
      errorStage: "unknown",
      errorCode: "SHADOW_UNKNOWN_ERROR",
    };
    input.log(result);
    return result;
  }
}
