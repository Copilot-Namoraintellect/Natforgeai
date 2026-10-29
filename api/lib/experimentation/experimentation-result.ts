// ─── R7-D Experimentation Engine — deterministic result calculation (D7) ───
//
// PURE module. Results are deterministic, versioned and reproducible from
// durable evidence rows + seam reads. No model is in the result path; no
// client may supply a result. Uncertainty and limitations are preserved;
// causality is never claimed beyond the governed experiment design. The
// calculation is deliberately simple and documented — it does not
// over-engineer statistical sophistication unsupported by the available
// evidence.

import {
  EXPERIMENT_RESULT_CALCULATION_VERSION,
  EXPERIMENT_TERMINAL_OUTCOME_STATUS_SET,
  EXPERIMENT_REVERSAL_OUTCOME_TYPE_SET,
  type ExperimentMetricSpec,
  type ResultVerdict,
  type ResultConfidenceClass,
} from "./experimentation-contract";

export const RESULT_CALCULATION_VERSION = EXPERIMENT_RESULT_CALCULATION_VERSION;

/** One bound evidence row, normalized for calculation. */
export interface EvidenceView {
  readonly evidenceId: string;
  readonly armIndex: number;
  readonly subjectKey: string;
  readonly outcomeType: string;
  readonly outcomeStatus: string;
  readonly valueType: string;
  readonly amountMinor: number | null;
  readonly occurredAt: string;
}

export interface ArmSummary {
  readonly armIndex: number;
  readonly subjects: number;
  readonly evidenceCount: number;
  readonly positiveCount: number;
  readonly reversalCount: number;
  readonly revenueMinor: number;
  readonly metricValue: number;
}

export interface ResultComputation {
  readonly calculationVersion: string;
  readonly verdict: ResultVerdict;
  readonly confidenceClass: ResultConfidenceClass;
  readonly armSummaries: ArmSummary[];
  readonly controlSummary: ArmSummary | null;
  readonly treatmentSummaries: ArmSummary[];
  /** treatment armIndex → signed relative difference vs control, in bps of control value. */
  readonly comparisons: { readonly armIndex: number; readonly diffBps: number }[];
  readonly evidenceCounts: { readonly total: number; readonly perArm: Record<number, number> };
  readonly meaningfulDiffThresholdBps: number;
}

/** A positive outcome is a non-terminal, non-reversal-type outcome. */
function isPositive(e: EvidenceView): boolean {
  return (
    !EXPERIMENT_TERMINAL_OUTCOME_STATUS_SET.has(e.outcomeStatus) &&
    !EXPERIMENT_REVERSAL_OUTCOME_TYPE_SET.has(e.outcomeType)
  );
}

function isReversalEvidence(e: EvidenceView): boolean {
  return (
    EXPERIMENT_TERMINAL_OUTCOME_STATUS_SET.has(e.outcomeStatus) ||
    EXPERIMENT_REVERSAL_OUTCOME_TYPE_SET.has(e.outcomeType)
  );
}

function metricValueFor(
  metric: ExperimentMetricSpec,
  subjects: number,
  evidenceCount: number,
  positiveCount: number,
  revenueMinor: number
): number {
  switch (metric.metric) {
    case "CONVERSION_COUNT_PER_SUBJECT":
      return subjects > 0 ? positiveCount / subjects : 0;
    case "OUTCOME_COUNT_PER_SUBJECT":
      return subjects > 0 ? evidenceCount / subjects : 0;
    case "REVENUE_MINOR_PER_SUBJECT":
      return subjects > 0 ? revenueMinor / subjects : 0;
    case "POSITIVE_OUTCOME_RATE":
      return evidenceCount > 0 ? positiveCount / evidenceCount : 0;
    default:
      return 0;
  }
}

/**
 * Deterministic result calculation over bound in-window evidence.
 *
 * Per arm: subjects = distinct assigned subjects with >= 1 bound evidence;
 * positive outcomes count as success; reversed/cancelled/superseded outcomes
 * and reversal-type outcomes count as negative evidence (never positive
 * success); revenue nets reversals. The verdict classification is the closed
 * order documented in the contract §10.
 */
export function computeExperimentResult(input: {
  metric: ExperimentMetricSpec;
  minimumSamplePerArm: number;
  armCount: number;
  evidence: readonly EvidenceView[];
  /** Guardrail: minimum absolute control→treatment difference to be meaningful, in bps of control. Default 0. */
  meaningfulDiffThresholdBps?: number;
  /** Experiment status — INVALIDATED experiments can only yield INVALID_EXPERIMENT. */
  experimentStatus: string;
}): ResultComputation {
  const threshold = input.meaningfulDiffThresholdBps ?? 0;
  const perArm = new Map<number, {
    subjects: Set<string>;
    evidenceCount: number;
    positiveCount: number;
    reversalCount: number;
    revenueMinor: number;
  }>();

  for (let i = 0; i < input.armCount; i++) {
    perArm.set(i, {
      subjects: new Set(),
      evidenceCount: 0,
      positiveCount: 0,
      reversalCount: 0,
      revenueMinor: 0,
    });
  }

  for (const e of input.evidence) {
    const arm = perArm.get(e.armIndex);
    if (!arm) continue; // evidence bound to an arm outside the design — ignore defensively
    arm.evidenceCount += 1;
    arm.subjects.add(e.subjectKey);
    if (isPositive(e)) {
      arm.positiveCount += 1;
      if (e.valueType === "MONETARY" && typeof e.amountMinor === "number") {
        arm.revenueMinor += e.amountMinor;
      }
    } else if (isReversalEvidence(e)) {
      arm.reversalCount += 1;
      if (e.valueType === "MONETARY" && typeof e.amountMinor === "number") {
        arm.revenueMinor -= Math.abs(e.amountMinor);
      }
    }
  }

  const armSummaries: ArmSummary[] = [];
  for (let i = 0; i < input.armCount; i++) {
    const arm = perArm.get(i)!;
    armSummaries.push({
      armIndex: i,
      subjects: arm.subjects.size,
      evidenceCount: arm.evidenceCount,
      positiveCount: arm.positiveCount,
      reversalCount: arm.reversalCount,
      revenueMinor: arm.revenueMinor,
      metricValue: metricValueFor(
        input.metric,
        arm.subjects.size,
        arm.evidenceCount,
        arm.positiveCount,
        arm.revenueMinor
      ),
    });
  }

  const totalEvidence = armSummaries.reduce((s, a) => s + a.evidenceCount, 0);
  const evidenceCounts = {
    total: totalEvidence,
    perArm: Object.fromEntries(armSummaries.map((a) => [a.armIndex, a.evidenceCount])),
  };

  if (input.experimentStatus === "INVALIDATED") {
    return {
      calculationVersion: RESULT_CALCULATION_VERSION,
      verdict: "INVALID_EXPERIMENT",
      confidenceClass: "INSUFFICIENT_EVIDENCE",
      armSummaries,
      controlSummary: armSummaries[0] ?? null,
      treatmentSummaries: armSummaries.slice(1),
      comparisons: [],
      evidenceCounts,
      meaningfulDiffThresholdBps: threshold,
    };
  }

  const minSample = input.minimumSamplePerArm;
  const insufficient =
    totalEvidence === 0 || armSummaries.some((a) => a.subjects < minSample);

  if (insufficient) {
    return {
      calculationVersion: RESULT_CALCULATION_VERSION,
      verdict: "INSUFFICIENT_EVIDENCE",
      confidenceClass: "INSUFFICIENT_EVIDENCE",
      armSummaries,
      controlSummary: armSummaries[0] ?? null,
      treatmentSummaries: armSummaries.slice(1),
      comparisons: [],
      evidenceCounts,
      meaningfulDiffThresholdBps: threshold,
    };
  }

  const control = armSummaries[0];
  const treatments = armSummaries.slice(1);
  const comparisons = treatments.map((t) => {
    const base = control.metricValue;
    const diffBps =
      base === 0
        ? t.metricValue === 0
          ? 0
          : 10000 // from-zero improvement reported at ceiling; documented limitation
        : Math.round(((t.metricValue - base) / Math.abs(base)) * 10000);
    return { armIndex: t.armIndex, diffBps };
  });

  // Meaningful-difference guardrail (default 0 bps → any nonzero difference is
  // meaningful; an exactly-zero difference is always NO_MEANINGFUL_DIFFERENCE).
  const allBelowThreshold = comparisons.every((c) => Math.abs(c.diffBps) <= threshold);
  if (allBelowThreshold) {
    return {
      calculationVersion: RESULT_CALCULATION_VERSION,
      verdict: "NO_MEANINGFUL_DIFFERENCE",
      confidenceClass: "MODERATE",
      armSummaries,
      controlSummary: control,
      treatmentSummaries: treatments,
      comparisons,
      evidenceCounts,
      meaningfulDiffThresholdBps: threshold,
    };
  }

  // SUPPORTED_DIFFERENCE requires every arm at/above minimum sample with at
  // least 2 distinct subjects; otherwise DIRECTIONAL_SIGNAL.
  const supported = treatments.every((t) => t.subjects >= Math.max(2, minSample));
  const verdict: ResultVerdict = supported ? "SUPPORTED_DIFFERENCE" : "DIRECTIONAL_SIGNAL";
  const maxSubjects = Math.max(...armSummaries.map((a) => a.subjects));
  const confidenceClass: ResultConfidenceClass =
    verdict === "SUPPORTED_DIFFERENCE"
      ? maxSubjects >= 10
        ? "STRONG"
        : "MODERATE"
      : "WEAK";

  return {
    calculationVersion: RESULT_CALCULATION_VERSION,
    verdict,
    confidenceClass,
    armSummaries,
    controlSummary: control,
    treatmentSummaries: treatments,
    comparisons,
    evidenceCounts,
    meaningfulDiffThresholdBps: threshold,
  };
}

/** Bounded conclusion template — the strongest permitted causal framing. */
export function renderConclusion(input: {
  verdict: ResultVerdict;
  metricLabel: string;
  experimentId: string;
}): string {
  const scope =
    "Within this governed experiment and its design assumptions, ";
  switch (input.verdict) {
    case "SUPPORTED_DIFFERENCE":
      return `${scope}the treatment arm(s) showed a supported difference on ${input.metricLabel} relative to control.`;
    case "DIRECTIONAL_SIGNAL":
      return `${scope}the treatment arm(s) showed a directional signal on ${input.metricLabel} relative to control; evidence is not yet conclusive.`;
    case "NO_MEANINGFUL_DIFFERENCE":
      return `${scope}no meaningful difference was detected on ${input.metricLabel} between treatment and control.`;
    case "INSUFFICIENT_EVIDENCE":
      return `Evidence is insufficient to conclude anything about ${input.metricLabel} within this governed experiment; the experiment remains inconclusive.`;
    case "INVALID_EXPERIMENT":
      return `This experiment was invalidated; no result on ${input.metricLabel} may be concluded and history is preserved.`;
  }
}

export const RESULT_LIMITATIONS: readonly string[] = [
  "scoped_causal_evidence_only",
  "assignment_not_attribution",
  "bounded_population",
  "reversals_counted_negative",
  "no_business_outcome_authority",
  "governance_bound",
] as const;
