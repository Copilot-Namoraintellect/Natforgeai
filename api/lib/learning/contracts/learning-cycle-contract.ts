/**
 * Governed Learning cycle contracts (WBS15.7).
 *
 * The WBS15 cycle (`learning-v2`) closes the six-engine loop:
 *
 *   BI → Strategy → Creative → Distribution → Engagement → Learning
 *     → approved Learning promotion → NEXT governed Strategy cycle
 *
 * These types define the immutable authority lineage the cycle binds into the
 * persisted learning record so the record is fully reconstructable from
 * durable coordinates alone:
 *
 * - canonical performance dataset fingerprint (Stream 1),
 * - Strategy snapshot/version/hash/approval coordinates (WBS11 authority),
 * - Strategy-bound KPI evaluation result lineage (Stream 2),
 * - governed variant-analysis version/result lineage (Stream 3),
 * - source observation identities,
 * - the Learning evaluation version, and
 * - the deterministic Learning record fingerprint (Stream 4 authority).
 *
 * Pure types only: no database access, no provider calls, no engine mutation.
 */

import type { JsonValue } from "../../strategy/strategy-snapshot";
import type { StrategyKpiStatus } from "../kpi/strategy-kpi-assessment";

/** One Strategy-bound KPI result as bound into the cycle lineage. */
export interface LearningCycleKpiResultLineage {
  metricRefId: string;
  metric: string | null;
  rawLabel: string;
  status: StrategyKpiStatus;
  unit: "count" | "rate" | null;
  target: number | null;
  actual: number | null;
  /** strategy_target | engine_band | budget_assumption | null (not_measurable). */
  targetBasis: string | null;
  observationCount: number;
}

/** Variant-analysis lineage for the dimensions the cycle attempted. */
export interface LearningCycleVariantAnalysisLineage {
  analysisVersion: string;
  dimension: string | null;
  comparability: "comparable" | "non_comparable";
  confidence: string;
  /** Deterministic finding identities bound at evaluation time. */
  findingIds: string[];
  comparabilityReasons: string[];
}

/** Dimensions NOT attempted because no durable observation attribution exists. */
export interface LearningCycleVariantDimensionSkip {
  dimension: string;
  reason: string;
}

/** The WBS15 authority block persisted inside `learning_records.provenance`. */
export interface LearningCycleAuthorityProvenance {
  /** Canonical CampaignPerformanceDataset fingerprint (Stream 1). */
  datasetFingerprint: string;
  datasetSchemaVersion: number;
  /** Immutable Strategy snapshot coordinates the dataset cited. */
  strategyAuthority: {
    snapshotId: string;
    strategyRunId: number;
    strategyVersion: number;
    strategyHashSha256: string;
    businessDnaSnapshotId: string;
    creativeBriefFingerprint: string;
    approvalRequestId: number | null;
    lineageStatus: string | null;
  };
  /** Strategy-bound KPI evaluation lineage (Stream 2). */
  strategyKpiEvaluation: {
    overallStatus: StrategyKpiStatus;
    summary: string;
    results: LearningCycleKpiResultLineage[];
  };
  /** Governed variant analysis lineage (Stream 3). */
  variantAnalysis: LearningCycleVariantAnalysisLineage;
  variantDimensionsSkipped: LearningCycleVariantDimensionSkip[];
  /** Deterministic record fingerprint over the canonical record authority. */
  recordFingerprint: string;
}

/** Persisted governance pins for a learning-v2 record. */
export interface LearningCycleGovernance {
  autoApply: false;
  requiresApproval: true;
  phase: 2;
}

/**
 * Explicit lineage persisted into a NEW Strategy snapshot/version created by
 * a future cycle that consumed approved Learning promotions (WBS15.7).
 * Every entry is INPUT EVIDENCE labelled `approved_recommendation` — never an
 * observed BI fact — and is fingerprint-bound to its promotion proposal.
 */
export interface StrategyLearningPromotionLineageEntry {
  /** Promotion approval request (Approval Centre decision row). */
  approvalRequestId: number;
  /** Exact proposal fingerprint bound at proposal time (fail-closed check). */
  proposalFingerprint: string;
  /** Source learning record that carried the recommendation. */
  learningRecordId: number;
  /** Campaign the learning record belongs to. */
  campaignId: number;
  /** Learning evaluation version that produced the recommendation. */
  evaluationVersion: string;
  /** Learning engine version bound by the envelope. */
  learningEngineVersion: string;
  recommendationId: string;
  targetEngine: string;
  adjustmentType: string;
  /** Always "approved_recommendation"; the promoted item is never a "fact". */
  promotedProvenanceClass: "approved_recommendation";
}

/** JSON-safe form of one lineage entry, as embedded in the Strategy snapshot. */
export type StrategyLearningPromotionLineageJson = JsonValue;
