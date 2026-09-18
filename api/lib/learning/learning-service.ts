/**
 * Learning service — the single authoritative Phase 1 Learning engine entry
 * point.
 *
 * Pipeline (per TARGET CONTRACT):
 *   campaign performance inputs (analytics rows + campaign facts)
 *   → normalised observations (contracts/observation.ts)
 *   → objective/KPI evaluation (contracts/kpi-assessment.ts)
 *   → evidence-backed learning (contracts/learning-derivation.ts)
 *   → persisted learning record (learning_records table)
 *   → governed recommendation output (autoApply always false)
 *
 * Guarantees:
 * - Grounded input only: observations are lossless transforms of persisted
 *   analytics rows; no LLM inference is used anywhere in the pipeline.
 * - Idempotency: one evaluation per (campaignId, evaluationVersion, window).
 *   The idempotency key has a unique index; re-execution replays the existing
 *   record instead of writing a duplicate, and a concurrent duplicate insert
 *   is resolved by re-reading the winner.
 * - Phase 1 isolation: this service never writes to Strategy, Creative or
 *   Distribution state. Its only write target is learning_records.
 */

import { createHash } from "crypto";
import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import { analytics, campaigns, learningRecords } from "@db/schema";
import { getDb } from "../../queries/connection";
import { isMySqlDuplicateKeyError } from "../billing/credit-engine";
import {
  LEARNING_ENGINE_NAME,
  LEARNING_EVALUATION_VERSION,
} from "./contracts/learning-config";
import {
  normaliseObservations,
  toISODate,
  type CampaignFacts,
  type NormaliseResult,
  type PerformanceObservation,
} from "./contracts/observation";
import {
  evaluateKpiAssessment,
  type KpiAssessment,
} from "./contracts/kpi-assessment";
import {
  deriveLearning,
  type ConfidenceLevel,
  type EvidenceItem,
  type Pattern,
  type PerformanceFact,
  type RecommendedAdjustment,
} from "./contracts/learning-derivation";

export interface LearningRecordView {
  id: number;
  userId: number;
  campaignId: number;
  evaluationVersion: string;
  windowStart: string;
  windowEnd: string;
  objectiveSummary: string;
  kpiAssessment: KpiAssessment;
  performanceFacts: PerformanceFact[];
  positivePatterns: Pattern[];
  negativePatterns: Pattern[];
  confidence: ConfidenceLevel;
  evidence: EvidenceItem[];
  recommendedAdjustments: RecommendedAdjustment[];
  governance: { autoApply: false; requiresApproval: true; phase: 1 };
  sourceObservations: PerformanceObservation[];
  normalisationIssues: NormaliseResult["issues"];
  provenance: {
    engine: string;
    engineVersion: string;
    trigger: "manual" | "api";
    inputDigest: string;
    evaluatedAt: string;
  };
  status: string;
  evaluatedAt: string;
  createdAt: string;
}

export type LearningEvaluationResult =
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
    };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function assertValidId(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${name} must be a positive integer`,
    });
  }
}

function assertValidWindow(start: string, end: string): void {
  if (!DATE_RE.test(start) || !DATE_RE.test(end)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "windowStart/windowEnd must be YYYY-MM-DD",
    });
  }
  if (end < start) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "windowEnd must not be earlier than windowStart",
    });
  }
}

function buildIdempotencyKey(
  campaignId: number,
  evaluationVersion: string,
  windowStart: string,
  windowEnd: string
): string {
  return `lr:${campaignId}:${evaluationVersion}:${windowStart}:${windowEnd}`;
}

function buildInputDigest(input: {
  evaluationVersion: string;
  windowStart: string;
  windowEnd: string;
  observationIds: string[];
}): string {
  const hash = createHash("sha256");
  hash.update(
    JSON.stringify({
      v: input.evaluationVersion,
      ws: input.windowStart,
      we: input.windowEnd,
      obs: input.observationIds,
    })
  );
  return hash.digest("hex");
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

function toView(
  row: LearningRecordRow,
  normalisationIssues: NormaliseResult["issues"] = []
): LearningRecordView {
  return {
    id: row.id,
    userId: row.userId,
    campaignId: row.campaignId,
    evaluationVersion: row.evaluationVersion,
    windowStart: toISODate(row.windowStart),
    windowEnd: toISODate(row.windowEnd),
    objectiveSummary: row.objectiveSummary,
    kpiAssessment: parseJsonColumn(row.kpiAssessment, {} as KpiAssessment),
    performanceFacts: parseJsonColumn(row.performanceFacts, [] as PerformanceFact[]),
    positivePatterns: parseJsonColumn(row.positivePatterns, [] as Pattern[]),
    negativePatterns: parseJsonColumn(row.negativePatterns, [] as Pattern[]),
    confidence: row.confidence as ConfidenceLevel,
    evidence: parseJsonColumn(row.evidence, [] as EvidenceItem[]),
    recommendedAdjustments: parseJsonColumn(
      row.recommendedAdjustments,
      [] as RecommendedAdjustment[]
    ),
    governance: parseJsonColumn(row.governance, {
      autoApply: false,
      requiresApproval: true,
      phase: 1,
    }),
    sourceObservations: parseJsonColumn(
      row.sourceObservations,
      [] as PerformanceObservation[]
    ),
    normalisationIssues,
    provenance: parseJsonColumn(row.provenance, {
      engine: LEARNING_ENGINE_NAME,
      engineVersion: row.evaluationVersion,
      trigger: "manual" as const,
      inputDigest: "",
      evaluatedAt: toISODate(row.evaluatedAt),
    }),
    status: row.status,
    evaluatedAt:
      row.evaluatedAt instanceof Date
        ? row.evaluatedAt.toISOString()
        : String(row.evaluatedAt),
    createdAt:
      row.createdAt instanceof Date
        ? row.createdAt.toISOString()
        : String(row.createdAt),
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
 * Runs the Phase 1 learning pipeline for one campaign and evaluation window.
 * Idempotent: the same (campaignId, evaluationVersion, window) always returns
 * the originally persisted record with idempotentReplay=true on re-runs.
 */
export async function evaluateCampaignLearning(input: {
  userId: number;
  campaignId: number;
  windowStart?: string;
  windowEnd?: string;
  trigger?: "manual" | "api";
}): Promise<LearningEvaluationResult> {
  assertValidId(input.userId, "userId");
  assertValidId(input.campaignId, "campaignId");
  const trigger = input.trigger ?? "manual";
  const db = getDb();

  const [campaign] = await db
    .select()
    .from(campaigns)
    .where(
      and(
        eq(campaigns.id, input.campaignId),
        eq(campaigns.userId, input.userId)
      )
    )
    .limit(1);

  if (!campaign) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Campaign not found" });
  }

  const campaignFacts: CampaignFacts = {
    id: campaign.id,
    goal: campaign.goal,
    primaryOutcome: campaign.primaryOutcome,
    budget: campaign.budget,
    platforms: campaign.platforms,
    startDate: campaign.startDate,
    endDate: campaign.endDate,
  };

  const rows = await db
    .select()
    .from(analytics)
    .where(
      and(
        eq(analytics.campaignId, input.campaignId),
        eq(analytics.userId, input.userId)
      )
    );

  // Resolve the evaluation window deterministically: explicit input wins,
  // then campaign start/end, then the observed analytics span.
  let windowStart = input.windowStart ?? null;
  let windowEnd = input.windowEnd ?? null;
  if (windowStart && windowEnd) {
    assertValidWindow(windowStart, windowEnd);
  } else {
    const dates = rows.map((r) => toISODate(r.date)).sort();
    windowStart = windowStart ?? (campaign.startDate ? toISODate(campaign.startDate) : null) ?? dates[0] ?? null;
    windowEnd = windowEnd ?? (campaign.endDate ? toISODate(campaign.endDate) : null) ?? dates[dates.length - 1] ?? null;
    if (windowStart && windowEnd) assertValidWindow(windowStart, windowEnd);
  }

  if (!windowStart || !windowEnd) {
    return {
      status: "insufficient_data",
      reason: "No evaluation window could be resolved: the campaign has no dates and no analytics observations exist.",
      observationCount: 0,
      campaignId: input.campaignId,
      windowStart: null,
      windowEnd: null,
    };
  }

  const { observations, issues } = normaliseObservations(rows, windowStart, windowEnd);

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

  const idempotencyKey = buildIdempotencyKey(
    input.campaignId,
    LEARNING_EVALUATION_VERSION,
    windowStart,
    windowEnd
  );

  const existing = await loadExistingByKey(db, idempotencyKey);
  if (existing) {
    return { status: "recorded", idempotentReplay: true, record: toView(existing) };
  }

  const assessment = evaluateKpiAssessment({
    campaign: campaignFacts,
    observations,
    windowStart,
    windowEnd,
  });
  const derivation = deriveLearning({ assessment, observations });

  const provenance = {
    engine: LEARNING_ENGINE_NAME,
    engineVersion: LEARNING_EVALUATION_VERSION,
    trigger,
    inputDigest: buildInputDigest({
      evaluationVersion: LEARNING_EVALUATION_VERSION,
      windowStart,
      windowEnd,
      observationIds: observations.map((o) => o.id),
    }),
    evaluatedAt: new Date().toISOString(),
  };

  const governance = { autoApply: false as const, requiresApproval: true as const, phase: 1 as const };

  const insertValues = {
    userId: input.userId,
    campaignId: input.campaignId,
    evaluationVersion: LEARNING_EVALUATION_VERSION,
    windowStart: new Date(`${windowStart}T00:00:00Z`),
    windowEnd: new Date(`${windowEnd}T00:00:00Z`),
    idempotencyKey,
    objectiveSummary: derivation.objectiveSummary,
    kpiAssessment: assessment,
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
    const insertId = Array.isArray(result) && result[0] ? Number((result[0] as { insertId?: number }).insertId ?? 0) : 0;
    return {
      status: "recorded",
      idempotentReplay: false,
      record: toView(
        {
          id: insertId,
          createdAt: new Date(),
          evaluatedAt: new Date(),
          ...insertValues,
        } as unknown as LearningRecordRow,
        issues
      ),
    };
  } catch (err) {
    if (!isMySqlDuplicateKeyError(err)) throw err;
    // Concurrent evaluation won the unique key; replay the persisted record.
    const winner = await loadExistingByKey(db, idempotencyKey);
    if (!winner) throw err;
    return { status: "recorded", idempotentReplay: true, record: toView(winner) };
  }
}

/** Lists learning records for a campaign owned by the user, newest first. */
export async function listLearningRecords(input: {
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

  return rows.map((row) => toView(row));
}

/** Fetches one learning record owned by the user. */
export async function getLearningRecord(input: {
  userId: number;
  id: number;
}): Promise<LearningRecordView> {
  assertValidId(input.userId, "userId");
  assertValidId(input.id, "id");
  const db = getDb();

  const [row] = await db
    .select()
    .from(learningRecords)
    .where(
      and(eq(learningRecords.id, input.id), eq(learningRecords.userId, input.userId))
    )
    .limit(1);

  if (!row) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Learning record not found" });
  }
  return toView(row);
}
