/**
 * Governed Learning cycle service (WBS15.7) — the production entrypoint that
 * closes the six-engine loop.
 *
 *   canonical CampaignPerformanceDataset (Stream 1)
 *     → fail closed when required Strategy authority is missing
 *     → Strategy-bound KPI evaluation (Stream 2)
 *     → governed platform variant analysis (Stream 3)
 *     → governed derivation (learning-v2 recommendations)
 *     → persisted, versioned learning record with bound WBS15 lineage
 *
 * Guarantees:
 * - Fail closed: no Strategy snapshot authority ⇒ no record is fabricated;
 *   no factual observations ⇒ no record is fabricated.
 * - Idempotency: one record per (campaignId, LEARNING_CYCLE_EVALUATION_VERSION,
 *   windowStart, windowEnd). The idempotency key has a unique index; a replay
 *   re-reads the persisted record and a concurrent duplicate insert resolves
 *   by re-reading the winner. Worker/scheduler restarts are therefore safe.
 * - Phase 1 compatibility: learning-v1 records are historical authority and
 *   are never rewritten; list/get keep reading every version.
 * - No uncontrolled self-modification: the only write target of this module
 *   is learning_records. No Strategy, Business DNA, Creative or Distribution
 *   state is touched — approved promotions flow exclusively through
 *   promotion proposals → human approval → sealed envelopes → a NEW governed
 *   Strategy cycle (see learning-strategy-consumption.ts).
 * - No provider/network side effects: the orchestration path is pure/DB only.
 */

import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import { campaigns, learningRecords } from "@db/schema";
import { getDb } from "../../queries/connection";
import { isMySqlDuplicateKeyError } from "../billing/credit-engine";
import {
  LEARNING_CYCLE_EVALUATION_VERSION,
  LEARNING_ENGINE_NAME,
} from "./contracts/learning-config";
import type { LearningCycleAuthorityProvenance } from "./contracts/learning-cycle-contract";
import type { PerformanceObservation } from "./contracts/observation";
import { evaluateStrategyKpiPerformance } from "./kpi/strategy-kpi-assessment";
import { analyzeVariantPerformance } from "./analysis/variant-analyzer";
import { loadCampaignPerformanceDataset } from "./performance/loader";
import type {
  CampaignPerformanceDataset,
  DatasetIssue,
  DatasetReadinessStatus,
} from "./performance/dataset";
import {
  SKIPPED_VARIANT_DIMENSIONS,
  buildPlatformVariantAnalysisInput,
  buildStrategyKpiAuthorityFromDataset,
  deriveLearningCycle,
  resolveCycleObjectiveMetric,
} from "./learning-cycle-pipeline";
import {
  buildInputDigest,
  type LearningRecordView,
} from "./learning-service";
import { computeRecordFingerprint } from "./learning-record-authority";

export type {
  CampaignPerformanceDataset,
  DatasetIssue,
  DatasetReadinessStatus,
};

/** Structural seam so tests can substitute the Stream 1 loader. */
export interface LearningCycleDatasetLoader {
  loadCampaignPerformanceDataset(input: {
    userId: number;
    campaignId: number;
    windowStart?: string;
    windowEnd?: string;
  }): Promise<CampaignPerformanceDataset>;
}

export interface GovernedLearningCycleDeps {
  loadDataset?: LearningCycleDatasetLoader;
  now?: () => Date;
}

export type GovernedLearningCycleResult =
  | {
      status: "recorded";
      idempotentReplay: boolean;
      record: LearningRecordView;
    }
  | {
      status: "insufficient_data";
      reason: string;
      observationCount: number;
      campaignId: number;
      windowStart: string | null;
      windowEnd: string | null;
    }
  | {
      /** Fail closed: required Strategy authority missing; nothing persisted. */
      status: "authority_missing";
      reason: string;
      campaignId: number;
      readinessStatus: DatasetReadinessStatus;
      requiredIssues: DatasetIssue[];
    };

function assertValidId(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${name} must be a positive integer`,
    });
  }
}

function buildCycleIdempotencyKey(
  campaignId: number,
  evaluationVersion: string,
  windowStart: string,
  windowEnd: string
): string {
  return `lr:${campaignId}:${evaluationVersion}:${windowStart}:${windowEnd}`;
}

type LearningRecordRow = typeof learningRecords.$inferSelect;

function parseJsonColumn<T>(value: unknown, fallback: T): T {
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

function toCycleView(
  row: LearningRecordRow,
  normalisationIssues: unknown[] = []
): LearningRecordView {
  const provenance = parseJsonColumn(row.provenance, {
    engine: LEARNING_ENGINE_NAME,
    engineVersion: row.evaluationVersion,
    trigger: "api" as const,
    inputDigest: "",
    evaluatedAt:
      row.evaluatedAt instanceof Date
        ? row.evaluatedAt.toISOString()
        : String(row.evaluatedAt),
  }) as LearningRecordView["provenance"];
  return {
    id: row.id,
    userId: row.userId,
    campaignId: row.campaignId,
    evaluationVersion: row.evaluationVersion,
    windowStart:
      row.windowStart instanceof Date
        ? row.windowStart.toISOString().slice(0, 10)
        : String(row.windowStart).slice(0, 10),
    windowEnd:
      row.windowEnd instanceof Date
        ? row.windowEnd.toISOString().slice(0, 10)
        : String(row.windowEnd).slice(0, 10),
    objectiveSummary: row.objectiveSummary,
    kpiAssessment: parseJsonColumn(row.kpiAssessment, {} as LearningRecordView["kpiAssessment"]),
    performanceFacts: parseJsonColumn(row.performanceFacts, []),
    positivePatterns: parseJsonColumn(row.positivePatterns, []),
    negativePatterns: parseJsonColumn(row.negativePatterns, []),
    confidence: row.confidence as LearningRecordView["confidence"],
    evidence: parseJsonColumn(row.evidence, []),
    recommendedAdjustments: parseJsonColumn(row.recommendedAdjustments, []),
    governance: parseJsonColumn(row.governance, {
      autoApply: false,
      requiresApproval: true,
      phase: 2,
    }),
    sourceObservations: parseJsonColumn(row.sourceObservations, [] as PerformanceObservation[]),
    normalisationIssues: normalisationIssues as LearningRecordView["normalisationIssues"],
    provenance,
    status: row.status,
    evaluatedAt:
      row.evaluatedAt instanceof Date
        ? row.evaluatedAt.toISOString()
        : String(row.evaluatedAt),
    createdAt:
      row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
  };
}

async function loadExistingByKey(
  db: ReturnType<typeof getDb>,
  idempotencyKey: string
): Promise<LearningRecordRow | null> {
  const [existing] = await db
    .select()
    .from(learningRecords)
    .where(eq(learningRecords.idempotencyKey, idempotencyKey))
    .limit(1);
  return existing ?? null;
}

/**
 * Runs the governed WBS15 Learning cycle for one campaign and window.
 * Idempotent and restart-safe: the same (campaign, evaluation version,
 * window) always replays the originally persisted record.
 */
export async function runGovernedLearningCycle(input: {
  userId: number;
  campaignId: number;
  windowStart?: string;
  windowEnd?: string;
  trigger?: "manual" | "api";
  deps?: GovernedLearningCycleDeps;
}): Promise<GovernedLearningCycleResult> {
  assertValidId(input.userId, "userId");
  assertValidId(input.campaignId, "campaignId");
  const trigger = input.trigger ?? "api";
  const db = getDb();

  const [campaign] = await db
    .select({
      id: campaigns.id,
      userId: campaigns.userId,
      budget: campaigns.budget,
    })
    .from(campaigns)
    .where(and(eq(campaigns.id, input.campaignId), eq(campaigns.userId, input.userId)))
    .limit(1);
  if (!campaign) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Campaign not found" });
  }

  const loader = input.deps?.loadDataset ?? {
    loadCampaignPerformanceDataset,
  };
  const dataset = await loader.loadCampaignPerformanceDataset({
    userId: input.userId,
    campaignId: input.campaignId,
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
  });

  // Fail closed: the canonical dataset requires approved Strategy authority.
  if (dataset.readiness.status === "authority_missing") {
    return {
      status: "authority_missing",
      reason: `Required Strategy authority is missing for campaign ${input.campaignId}: ` +
        dataset.readiness.issues
          .filter((issue) => issue.severity === "required")
          .map((issue) => issue.code)
          .join(", "),
      campaignId: input.campaignId,
      readinessStatus: dataset.readiness.status,
      requiredIssues: dataset.readiness.issues.filter((issue) => issue.severity === "required"),
    };
  }

  const observations = [...dataset.outcomes.observations];
  const { start: windowStart, end: windowEnd } = dataset.identity.window;

  if (observations.length === 0) {
    return {
      status: "insufficient_data",
      reason: `No factual observations exist for campaign ${input.campaignId} in window ${windowStart}..${windowEnd}.`,
      observationCount: 0,
      campaignId: input.campaignId,
      windowStart,
      windowEnd,
    };
  }

  const idempotencyKey = buildCycleIdempotencyKey(
    input.campaignId,
    LEARNING_CYCLE_EVALUATION_VERSION,
    windowStart,
    windowEnd
  );

  const existing = await loadExistingByKey(db, idempotencyKey);
  if (existing) {
    return { status: "recorded", idempotentReplay: true, record: toCycleView(existing) };
  }

  // Stream 2: Strategy-bound KPI evaluation against the factual dataset.
  const strategyAuthority = buildStrategyKpiAuthorityFromDataset(dataset);
  if (!strategyAuthority) {
    return {
      status: "authority_missing",
      reason: `Required Strategy authority is missing for campaign ${input.campaignId}: no immutable strategy snapshot coordinates in the canonical dataset.`,
      campaignId: input.campaignId,
      readinessStatus: dataset.readiness.status,
      requiredIssues: [],
    };
  }
  const strategyKpi = evaluateStrategyKpiPerformance({
    strategyAuthority,
    performanceFacts: observations,
    window: dataset.identity.window,
    campaignBudget: typeof campaign.budget === "number" ? campaign.budget : null,
  });

  // Stream 3: governed platform variant analysis (the only dimension with
  // durable observation attribution; other dimensions are skipped explicitly).
  const variantAnalysis = analyzeVariantPerformance(
    buildPlatformVariantAnalysisInput(dataset, resolveCycleObjectiveMetric(strategyAuthority))
  );

  const derivation = deriveLearningCycle({ dataset, strategyKpi, variantAnalysis });

  const now = input.deps?.now ?? (() => new Date());
  const evaluatedAtIso = now().toISOString();
  const inputDigest = buildInputDigest({
    evaluationVersion: LEARNING_CYCLE_EVALUATION_VERSION,
    windowStart,
    windowEnd,
    observationIds: observations.map((o) => o.id),
  });

  // Deterministic record fingerprint over the canonical governed record
  // authority (Stream 4). Computed before persistence; identical content
  // always recomputes to the same fingerprint.
  const recordFingerprint = computeRecordFingerprint({
    id: 0,
    userId: input.userId,
    campaignId: input.campaignId,
    evaluationVersion: LEARNING_CYCLE_EVALUATION_VERSION,
    windowStart,
    windowEnd,
    objectiveSummary: derivation.objectiveSummary,
    kpiAssessment: strategyKpi,
    performanceFacts: derivation.performanceFacts,
    positivePatterns: derivation.positivePatterns,
    negativePatterns: derivation.negativePatterns,
    confidence: derivation.confidence,
    evidence: derivation.evidence,
    recommendedAdjustments: derivation.recommendedAdjustments,
    governance: { autoApply: false, requiresApproval: true, phase: 2 },
    sourceObservations: observations,
    normalisationIssues: [],
    provenance: {
      engine: LEARNING_ENGINE_NAME,
      engineVersion: LEARNING_CYCLE_EVALUATION_VERSION,
      trigger,
      inputDigest,
      evaluatedAt: evaluatedAtIso,
    },
    status: "recorded",
    evaluatedAt: evaluatedAtIso,
    createdAt: evaluatedAtIso,
  } as LearningRecordView);

  const snapshot = dataset.strategyAuthority.snapshot!;
  const wbs15: LearningCycleAuthorityProvenance = {
    datasetFingerprint: dataset.identity.fingerprint,
    datasetSchemaVersion: dataset.identity.schemaVersion,
    strategyAuthority: {
      snapshotId: snapshot.snapshotId,
      strategyRunId: snapshot.strategyRunId,
      strategyVersion: snapshot.strategyVersion,
      strategyHashSha256: snapshot.strategyHashSha256,
      businessDnaSnapshotId: snapshot.businessDnaSnapshotId,
      creativeBriefFingerprint: snapshot.creativeBriefFingerprint,
      approvalRequestId: dataset.strategyAuthority.approval.approvalRequestId,
      lineageStatus: dataset.strategyAuthority.approval.lineageStatus,
    },
    strategyKpiEvaluation: {
      overallStatus: strategyKpi.overallStatus,
      summary: strategyKpi.summary,
      results: strategyKpi.results.map((result) => ({
        metricRefId: result.metricRefId,
        metric: result.metric,
        rawLabel: result.rawLabel,
        status: result.status,
        unit: result.unit,
        target: result.target,
        actual: result.actual,
        targetBasis: result.targetProvenance.basis,
        observationCount: result.actualProvenance.observationCount,
      })),
    },
    variantAnalysis: {
      analysisVersion: variantAnalysis.analysisVersion,
      dimension: variantAnalysis.dimension,
      comparability: variantAnalysis.comparability,
      confidence: variantAnalysis.confidence,
      findingIds: variantAnalysis.findings.map((finding) => finding.id),
      comparabilityReasons: [...variantAnalysis.comparabilityReasons],
    },
    variantDimensionsSkipped: SKIPPED_VARIANT_DIMENSIONS.map((skip) => ({ ...skip })),
    recordFingerprint,
  };

  const provenance = {
    engine: LEARNING_ENGINE_NAME,
    engineVersion: LEARNING_CYCLE_EVALUATION_VERSION,
    trigger,
    inputDigest,
    evaluatedAt: evaluatedAtIso,
    wbs15,
  };

  const governance = { autoApply: false as const, requiresApproval: true as const, phase: 2 as const };

  const insertValues = {
    userId: input.userId,
    campaignId: input.campaignId,
    evaluationVersion: LEARNING_CYCLE_EVALUATION_VERSION,
    windowStart: new Date(`${windowStart}T00:00:00Z`),
    windowEnd: new Date(`${windowEnd}T00:00:00Z`),
    idempotencyKey,
    objectiveSummary: derivation.objectiveSummary,
    kpiAssessment: strategyKpi,
    performanceFacts: derivation.performanceFacts,
    positivePatterns: derivation.positivePatterns,
    negativePatterns: derivation.negativePatterns,
    confidence: derivation.confidence,
    evidence: derivation.evidence,
    recommendedAdjustments: derivation.recommendedAdjustments,
    governance,
    sourceObservations: observations,
    provenance,
    status: "recorded" as const,
  };

  try {
    const result = await db.insert(learningRecords).values(insertValues);
    const insertId = Array.isArray(result) && result[0]
      ? Number((result[0] as { insertId?: number }).insertId ?? 0)
      : 0;
    return {
      status: "recorded",
      idempotentReplay: false,
      record: toCycleView(
        {
          id: insertId,
          createdAt: new Date(evaluatedAtIso),
          evaluatedAt: new Date(evaluatedAtIso),
          ...insertValues,
        } as unknown as LearningRecordRow,
        [...dataset.outcomes.normalisationIssues]
      ),
    };
  } catch (err) {
    if (!isMySqlDuplicateKeyError(err)) throw err;
    // Concurrent evaluation won the unique key; replay the persisted record.
    const winner = await loadExistingByKey(db, idempotencyKey);
    if (!winner) throw err;
    return { status: "recorded", idempotentReplay: true, record: toCycleView(winner) };
  }
}

/** Lists learning records of every version for a campaign, newest first. */
export async function listGovernedLearningRecords(input: {
  userId: number;
  campaignId: number;
}): Promise<LearningRecordView[]> {
  assertValidId(input.userId, "userId");
  assertValidId(input.campaignId, "campaignId");
  const db = getDb();

  const rows = await db
    .select()
    .from(learningRecords)
    .where(
      and(
        eq(learningRecords.campaignId, input.campaignId),
        eq(learningRecords.userId, input.userId)
      )
    )
    .orderBy(desc(learningRecords.windowStart), desc(learningRecords.id));

  return rows.map((row) => toCycleView(row));
}
