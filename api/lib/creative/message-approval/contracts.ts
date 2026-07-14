export type CreativePipelineV2Mode = "off" | "shadow" | "canary" | "active";

export type CandidateSource =
  | "ai_refined"
  | "deterministic_fallback"
  | "user_structured"
  | "existing_approved"
  | "manual_restore"
  | "unknown";

export interface BusinessDNASnapshot {
  readonly snapshotId: string;
  readonly businessId: number;
  readonly version: number;
  readonly evidenceHashSha256: string;
  readonly capturedAtIso: string;
  readonly businessName: string;
  readonly industry: string;
  readonly primaryOffering: string;
  readonly productsAndServices: readonly string[];
  readonly verifiedUseCases: readonly string[];
  readonly targetCustomerSegments: readonly string[];
  readonly customerPainPoints: readonly string[];
  readonly supportedOutcomes: readonly string[];
  readonly capabilities: readonly string[];
  readonly approvedClaims: readonly string[];
  readonly prohibitedClaims: readonly string[];
  readonly brandLanguageConstraints: readonly string[];
  readonly evidenceReferences: readonly string[];
}

export type CtaPolicy =
  | {
      readonly mode: "exact";
      readonly requiredCta: string;
    }
  | {
      readonly mode: "allowed_set";
      readonly allowedCtas: readonly string[];
    }
  | {
      readonly mode: "semantic_intent";
      readonly requiredIntent: string;
      readonly intentKeywords: readonly string[];
    };

export interface CampaignStrategySnapshot {
  readonly snapshotId: string;
  readonly campaignId: number;
  readonly version: number;
  readonly strategyHashSha256: string;
  readonly capturedAtIso: string;
  readonly objective: string;
  readonly funnelStage: string;
  readonly primaryAudience: string;
  readonly messageIntent: string;
  readonly centralPromise: string;
  readonly requiredBenefits: readonly string[];
  readonly offer: string;
  readonly ctaPolicy: CtaPolicy;
  readonly constraints: readonly string[];
  readonly prohibitedClaims: readonly string[];
}

export interface CanonicalFooter {
  readonly phone: string | null;
  readonly whatsapp: string | null;
  readonly email: string | null;
  readonly website: string | null;
  readonly location: string | null;
}

export interface CanonicalMessagePackCopy {
  readonly copySchemaVersion: string;
  readonly headline: string;
  readonly subheadline: string;
  readonly benefitBulletsOrdered: readonly string[];
  readonly cta: string;
  readonly footer: CanonicalFooter | null;
}

export interface MessageQualityIssue {
  readonly code: string;
  readonly message: string;
}

export type RuleClassification = "hard" | "warning";

export interface MessageQualityPolicy {
  readonly policyId: string;
  readonly policyVersion: number;
  readonly copySchemaVersion: string;
  readonly minScoreForApproval: number;
  readonly ruleClassifications: Readonly<Record<string, RuleClassification>>;
  readonly scoreWeights: Readonly<Record<string, number>>;
  readonly scoreMin: number;
  readonly scoreMax: number;
}

export interface MessagePackCandidateProvenance {
  readonly adaptedFromLegacy: boolean;
  readonly originSource: string;
  readonly modelName: string | null;
  readonly diagnostics: {
    readonly legacyIsGeneric: boolean | null;
    readonly legacyValidationPassed: boolean | null;
    readonly legacyValidationScore: number | null;
    readonly legacyValidationRejections: readonly string[];
  };
}

export interface MessagePackCandidate {
  readonly candidateId: string;
  readonly campaignId: number;
  readonly createdAtIso: string;
  readonly source: CandidateSource;
  readonly copy: CanonicalMessagePackCopy;
  readonly copyHashSha256: string;
  readonly businessDnaSnapshotId: string;
  readonly campaignStrategySnapshotId: string;
  readonly qualityPolicyId: string;
  readonly qualityPolicyVersion: number;
  readonly provenance: MessagePackCandidateProvenance;
}

export type AssessmentDecision = "approved" | "rejected";

export interface MessageAssessment {
  readonly assessmentId: string;
  readonly candidateId: string;
  readonly copyHashSha256: string;
  readonly businessDnaSnapshotId: string;
  readonly campaignStrategySnapshotId: string;
  readonly policyId: string;
  readonly policyVersion: number;
  readonly decision: AssessmentDecision;
  readonly hardIssues: readonly MessageQualityIssue[];
  readonly warnings: readonly MessageQualityIssue[];
  readonly score: number;
  readonly evaluatedAtIso: string;
}

export interface ApprovedMessagePack {
  readonly approvedRevisionId: string;
  readonly candidateId: string;
  readonly assessmentId: string;
  readonly copyHashSha256: string;
  readonly businessDnaSnapshotId: string;
  readonly campaignStrategySnapshotId: string;
  readonly policyId: string;
  readonly policyVersion: number;
  readonly approvedAtIso: string;
  readonly copy: CanonicalMessagePackCopy;
  readonly sourceProvenance: MessagePackCandidateProvenance;
}

export interface ShadowEvaluationResult {
  readonly mode: CreativePipelineV2Mode;
  readonly campaignId: number;
  readonly workflowRunId: string | null;
  readonly contextSource: "legacy_loaded_context";
  readonly contextReadyForComparison: boolean;
  readonly missingContextFields: readonly string[];
  readonly candidateId: string;
  readonly candidateSource: CandidateSource;
  readonly copyHashSha256: string;
  readonly legacyDecision: "approved" | "rejected";
  readonly legacyIsGeneric: boolean | null;
  readonly legacyScore: number | null;
  readonly v2Decision: AssessmentDecision | null;
  readonly v2HardIssueCodes: readonly string[];
  readonly v2WarningCodes: readonly string[];
  readonly v2Score: number | null;
  readonly decisionMatched: boolean | null;
  readonly durationMs: number;
  readonly errorStage: string | null;
  readonly errorCode: string | null;
}

export type ReadonlyDeep<T> = T extends (...args: unknown[]) => unknown
  ? T
  : T extends object
  ? { readonly [K in keyof T]: ReadonlyDeep<T[K]> }
  : T;
