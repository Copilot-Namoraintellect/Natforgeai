// ─── R7-D Experimentation Engine — projections (read-only) ───
//
// PURE module. Builds the read-only experiment view and the frozen
// downstream result handoff projection consumed by R7-C (learning handback)
// and R7-E (optimisation input) per
// docs/contracts/experiment-result-to-learning-optimisation-contract.md.
// Downstream consumers may read and must never mutate; an experiment result
// never authorizes budget change and never mutates learning.

import {
  EXPERIMENT_RESULT_PROJECTION_VERSION,
  type ExperimentStatus,
} from "./experimentation-contract";
import type { ExperimentRow, ExperimentResultRow } from "@db/schema";

export const RESULT_HANDOFF_PROJECTION_KEYS = [
  "contractVersion",
  "experimentId",
  "hypothesisId",
  "learningId",
  "businessId",
  "design",
  "resultStatus",
  "controlMetrics",
  "treatmentMetrics",
  "evidenceCount",
  "confidenceClass",
  "limitations",
  "governanceReferences",
  "freshness",
  "resultVersion",
  "calculationVersion",
  "conclusion",
  "scopedCausalEvidence",
  "causationClaimed",
] as const;

export const SCOPED_CAUSAL_EVIDENCE_CLAIM =
  "Within this governed experiment and its design assumptions, the recorded arm difference is experimental causal evidence. It does not generalise beyond the design, population, window and governance bound recorded here." as const;

function jsonColumn<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

export interface ExperimentView {
  readonly experimentId: string;
  readonly hypothesisId: string;
  readonly learningId: string;
  readonly businessId: number;
  readonly statement: string;
  readonly designType: string;
  readonly dimension: string;
  readonly status: ExperimentStatus;
  readonly startAt: string | null;
  readonly endAt: string | null;
  readonly assignmentVersion: string | null;
  readonly minimumSamplePerArm: number;
  readonly durationDays: number;
  readonly governanceDecisionId: string | null;
  readonly approvalReference: string | null;
  readonly resultId: string | null;
  readonly designHash: string;
  readonly createdAt: unknown;
}

export function buildExperimentView(row: ExperimentRow): ExperimentView {
  return {
    experimentId: row.experimentId,
    hypothesisId: row.hypothesisId,
    learningId: row.learningId,
    businessId: row.businessId,
    statement: row.statement,
    designType: row.designType,
    dimension: row.dimension,
    status: row.status as ExperimentStatus,
    startAt: row.startAt,
    endAt: row.endAt,
    assignmentVersion: row.assignmentVersion,
    minimumSamplePerArm: row.minimumSamplePerArm,
    durationDays: row.durationDays,
    governanceDecisionId: row.governanceDecisionId,
    approvalReference: row.approvalReference,
    resultId: row.resultId,
    designHash: row.designHash,
    createdAt: row.createdAt,
  };
}

export interface ResultHandoffProjection {
  readonly contractVersion: typeof EXPERIMENT_RESULT_PROJECTION_VERSION;
  readonly experimentId: string;
  readonly hypothesisId: string;
  readonly learningId: string;
  readonly businessId: number;
  readonly design: {
    readonly designType: string;
    readonly dimension: string;
    readonly primaryMetric: unknown;
    readonly controlDefinition: unknown;
    readonly treatmentDefinitions: unknown;
    readonly allocationPolicy: unknown;
  };
  readonly resultStatus: string;
  readonly controlMetrics: unknown;
  readonly treatmentMetrics: unknown;
  readonly evidenceCount: number;
  readonly confidenceClass: string;
  readonly limitations: readonly string[];
  readonly governanceReferences: {
    readonly governanceDecisionId: string | null;
    readonly approvalReference: string | null;
    readonly policyVersion: string | null;
  };
  readonly freshness: {
    readonly resultCalculatedAt: string;
    readonly experimentStatus: string;
    readonly terminal: boolean;
  };
  readonly resultVersion: string;
  readonly calculationVersion: string;
  readonly conclusion: string;
  readonly scopedCausalEvidence: { readonly claim: string; readonly withinDesignAssumptions: true };
  readonly causationClaimed: false;
}

/** Frozen result → learning/optimisation projection. Read-only downstream. */
export function buildResultHandoffProjection(input: {
  experiment: ExperimentRow;
  result: ExperimentResultRow | null;
}): ResultHandoffProjection {
  const { experiment, result } = input;
  const armSummaries = jsonColumn(result?.armSummaries ?? [], [] as {
    armIndex: number;
    subjects: number;
    evidenceCount: number;
    positiveCount: number;
    reversalCount: number;
    revenueMinor: number;
    metricValue: number;
  }[]);
  const controlMetrics = armSummaries.find((a) => a.armIndex === 0) ?? null;
  const treatmentMetrics = armSummaries.filter((a) => a.armIndex !== 0);
  const terminal = ["COMPLETED", "INVALIDATED", "CANCELLED"].includes(experiment.status);

  return {
    contractVersion: EXPERIMENT_RESULT_PROJECTION_VERSION,
    experimentId: experiment.experimentId,
    hypothesisId: experiment.hypothesisId,
    learningId: experiment.learningId,
    businessId: experiment.businessId,
    design: {
      designType: experiment.designType,
      dimension: experiment.dimension,
      primaryMetric: jsonColumn(experiment.primaryMetric, {}),
      controlDefinition: jsonColumn(experiment.controlDefinition, {}),
      treatmentDefinitions: jsonColumn(experiment.treatmentDefinitions, []),
      allocationPolicy: jsonColumn(experiment.allocationPolicy, {}),
    },
    resultStatus: result?.verdict ?? "NO_RESULT",
    controlMetrics,
    treatmentMetrics,
    evidenceCount: result ? jsonColumn(result.evidenceCounts, { total: 0 } as { total: number }).total : 0,
    confidenceClass: result?.confidenceClass ?? "INSUFFICIENT_EVIDENCE",
    limitations: jsonColumn(result?.limitations ?? [], [] as string[]),
    governanceReferences: {
      governanceDecisionId: experiment.governanceDecisionId,
      approvalReference: experiment.approvalReference,
      policyVersion: null,
    },
    freshness: {
      resultCalculatedAt: result?.calculatedAt ?? "",
      experimentStatus: experiment.status,
      terminal,
    },
    resultVersion: result?.resultId ?? "",
    calculationVersion: result?.calculationVersion ?? "",
    conclusion: result?.conclusion ?? "",
    scopedCausalEvidence: { claim: SCOPED_CAUSAL_EVIDENCE_CLAIM, withinDesignAssumptions: true },
    causationClaimed: false,
  };
}
