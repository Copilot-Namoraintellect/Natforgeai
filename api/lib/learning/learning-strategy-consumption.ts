/**
 * Approved Learning promotion → future Strategy cycle consumption (WBS15.7).
 *
 * An approved promotion envelope is INPUT EVIDENCE for a FUTURE governed
 * decision cycle. It must never mutate an old Business DNA snapshot, Strategy
 * snapshot, Creative package or Learning record — a future cycle consumes it
 * and creates a NEW governed Strategy version/snapshot instead.
 *
 * Scope safety (section G): approved Learning may be consumed only within the
 * same durable business/account scope. A recommendation from Business A must
 * never influence Business B merely because the same user owns both.
 *
 *   - campaign.businessId present  → envelopes of every campaign of that
 *     business (same owner) are eligible, including the campaign itself;
 *   - campaign.businessId null     → fail closed to same-campaign reuse only.
 *
 * Every consumed item keeps its provenance class: the promoted adjustment is
 * an `approved_recommendation` (a human-approved recommendation), NEVER an
 * observed Business DNA fact. No causal inference is attached.
 *
 * Availability is fail-closed through getApprovedPromotionEnvelopes: pending
 * or rejected proposals, tampered contexts, unsealed approvals and drifted
 * learning authority are all excluded before they reach a Strategy cycle.
 */

import { and, asc, eq } from "drizzle-orm";
import { createHash } from "crypto";
import { campaigns } from "@db/schema";
import { getDb } from "../../queries/connection";
import type { JsonValue } from "../strategy/strategy-snapshot";
import type { StrategyLearningPromotionLineageEntry } from "./contracts/learning-cycle-contract";
import {
  getApprovedPromotionEnvelopes,
  type LearningPromotionDbExecutor,
} from "./promotion/promotion-service";
import type { ApprovedPromotionEnvelope } from "./promotion/promotion-envelope";

/** One approved promotion prepared as labelled Strategy input evidence. */
export interface ApprovedLearningStrategyInputItem {
  sourceCampaignId: number;
  learningRecordId: number;
  evaluationVersion: string;
  learningEngineVersion: string;
  recommendationId: string;
  targetEngine: string;
  adjustmentType: string;
  summary: string;
  rationale: string;
  evidenceRefs: string[];
  approvalRequestId: number;
  proposalFingerprint: string;
  decidedAt: string;
  /** Always "approved_recommendation"; never reclassified as a fact. */
  promotedProvenanceClass: "approved_recommendation";
}

export interface ApprovedLearningStrategyInput {
  /**
   * same-business: campaign carries a durable businessId and envelopes of
   * that business's campaigns were resolved. same-campaign: fail-closed
   * fallback for campaigns without a durable business scope.
   */
  scope: "same-business" | "same-campaign";
  businessId: number | null;
  promotions: ApprovedLearningStrategyInputItem[];
}

function toInputItem(envelope: ApprovedPromotionEnvelope): ApprovedLearningStrategyInputItem {
  return {
    sourceCampaignId: envelope.campaignId,
    learningRecordId: envelope.learningRecordId,
    evaluationVersion: envelope.evaluationVersion,
    learningEngineVersion: envelope.learningAuthority.engineVersion,
    recommendationId: envelope.promoted.recommendationId,
    targetEngine: envelope.promoted.targetEngine,
    adjustmentType: envelope.promoted.adjustmentType,
    summary: envelope.promoted.summary,
    rationale: envelope.promoted.rationale,
    evidenceRefs: [...envelope.promoted.evidenceRefs],
    approvalRequestId: envelope.approvalRequestId,
    proposalFingerprint: envelope.proposalFingerprint,
    decidedAt: envelope.decidedAt,
    promotedProvenanceClass: "approved_recommendation",
  };
}

/**
 * Resolves the approved Learning promotions a future Strategy cycle for
 * `campaignId` may consume, scoped to the same durable business/account.
 * Campaigns of other businesses owned by the same user are never consulted.
 */
export async function resolveApprovedLearningPromotionsForStrategy(input: {
  userId: number;
  campaignId: number;
  executor?: LearningPromotionDbExecutor;
}): Promise<ApprovedLearningStrategyInput> {
  const executor = input.executor ?? getDb();

  const [campaign] = await executor
    .select({
      id: campaigns.id,
      businessId: campaigns.businessId,
    })
    .from(campaigns)
    .where(and(eq(campaigns.id, input.campaignId), eq(campaigns.userId, input.userId)))
    .limit(1);

  if (!campaign) {
    return { scope: "same-campaign", businessId: null, promotions: [] };
  }

  const businessId =
    typeof campaign.businessId === "number" && Number.isInteger(campaign.businessId) && campaign.businessId > 0
      ? campaign.businessId
      : null;

  // Fail closed to same-campaign reuse when no durable business scope exists.
  let candidateCampaignIds: number[] = [input.campaignId];
  let scope: ApprovedLearningStrategyInput["scope"] = "same-campaign";
  if (businessId !== null) {
    const siblings = await executor
      .select({ id: campaigns.id })
      .from(campaigns)
      .where(and(eq(campaigns.userId, input.userId), eq(campaigns.businessId, businessId)))
      .orderBy(asc(campaigns.id));
    candidateCampaignIds = [
      ...new Set([input.campaignId, ...siblings.map((row) => row.id)]),
    ].sort((a, b) => a - b);
    scope = "same-business";
  }

  const promotions: ApprovedLearningStrategyInputItem[] = [];
  for (const candidateId of candidateCampaignIds) {
    const envelopes = await getApprovedPromotionEnvelopes({
      userId: input.userId,
      campaignId: candidateId,
      executor,
    });
    for (const envelope of envelopes) {
      promotions.push(toInputItem(envelope));
    }
  }

  // Deterministic order: stable sort by source campaign, then approval request.
  promotions.sort(
    (a, b) =>
      a.sourceCampaignId - b.sourceCampaignId ||
      a.approvalRequestId - b.approvalRequestId ||
      a.proposalFingerprint.localeCompare(b.proposalFingerprint)
  );

  return { scope, businessId, promotions };
}

/**
 * Builds the labelled prompt section for the Strategy agent. Returns null
 * when there is nothing to consume — Learning context is then simply absent
 * from the cycle rather than fabricated.
 */
export function buildApprovedLearningPromotionPromptSection(
  input: ApprovedLearningStrategyInput
): string | null {
  if (input.promotions.length === 0) return null;

  const items = input.promotions
    .map((promotion, index) => {
      const evidence =
        promotion.evidenceRefs.length > 0
          ? promotion.evidenceRefs.join(", ")
          : "no concrete evidence refs (explicit insufficient-evidence recommendation)";
      return [
        `--- Approved Learning Promotion ${index + 1} (provenanceClass: ${promotion.promotedProvenanceClass}) ---`,
        `Learning record: ${promotion.learningRecordId} (evaluation ${promotion.evaluationVersion}) of campaign ${promotion.sourceCampaignId}; promotion approval request ${promotion.approvalRequestId}; proposal fingerprint ${promotion.proposalFingerprint}.`,
        `Target engine: ${promotion.targetEngine} | adjustment: ${promotion.adjustmentType}`,
        `Summary: ${promotion.summary}`,
        `Rationale: ${promotion.rationale}`,
        `Supporting evidence refs: ${evidence}`,
      ].join("\n");
    })
    .join("\n\n");

  return `
APPROVED LEARNING PROMOTIONS FROM GOVERNED LEARNING EVALUATIONS — HUMAN-APPROVED RECOMMENDATIONS, NOT OBSERVED FACTS:
The following recommendations were derived from past campaign performance, reviewed and explicitly approved by a human. Treat them as labelled optimisation input evidence (provenanceClass: approved_recommendation). They are NOT observed Business DNA facts and assert no causal relationship. Where they conflict with the campaign brief above, the brief remains authoritative.
${items}
`;
}

/**
 * Builds the explicit lineage entries persisted into a NEW Strategy
 * snapshot/version produced by a cycle that consumed approved Learning. The
 * entry set is part of the immutable snapshot payload, so the new Strategy
 * version is reconstructable as:
 *   Business DNA + campaign objective + approved Learning promotions.
 */
export function buildStrategyLearningPromotionLineage(
  input: ApprovedLearningStrategyInput
): StrategyLearningPromotionLineageEntry[] {
  return input.promotions.map((promotion) => ({
    approvalRequestId: promotion.approvalRequestId,
    proposalFingerprint: promotion.proposalFingerprint,
    learningRecordId: promotion.learningRecordId,
    campaignId: promotion.sourceCampaignId,
    evaluationVersion: promotion.evaluationVersion,
    learningEngineVersion: promotion.learningEngineVersion,
    recommendationId: promotion.recommendationId,
    targetEngine: promotion.targetEngine,
    adjustmentType: promotion.adjustmentType,
    promotedProvenanceClass: "approved_recommendation",
  }));
}

/** JSON-safe embedding of the lineage entries into the Strategy snapshot. */
export function strategyLearningPromotionLineageToJson(
  entries: StrategyLearningPromotionLineageEntry[]
): JsonValue {
  return JSON.parse(JSON.stringify(entries)) as JsonValue;
}

/**
 * Next-cycle identity + instruction contract (WBS-R1.2A) — pure, side-effect
 * free.
 *
 * When a future governed Strategy cycle consumes approved Learning promotions
 * (section above), the new cycle needs a durable, deterministic IDENTITY for
 * the instruction set it was seeded from, and a strict, fail-closed contract
 * for the instruction envelope a dispatcher may later act on.
 *
 * Identity model:
 * - The next-cycle identity is a deterministic SHA-256 over the canonical
 *   (key-sorted) material: the target campaign, the Strategy snapshot hash
 *   the cycle starts from, and the sorted set of approved proposal
 *   fingerprints it consumes. No timestamps: identity is material-only, so
 *   the same campaign + strategy hash + fingerprint set always yields the
 *   same identity regardless of when the cycle is prepared.
 * - Proposal fingerprints are canonicalised by sorting, so equivalent input
 *   order produces an identical identity. Duplicates are rejected: a
 *   fingerprint set is a SET, not a list.
 * - The fingerprint set must be non-empty and every fingerprint must be a
 *   non-blank string — an empty or blank set would fabricate authority for
 *   a cycle that consumed nothing.
 *
 * Instruction model:
 * - A NextCycleInstruction is the minimal envelope a dispatcher consumes:
 *   an instructionId and a lifecycle status (ready | dispatched | failed).
 * - parseNextCycleInstruction is strict and fail-closed: it rejects
 *   malformed objects, unknown fields, blank instructionIds and unsupported
 *   statuses rather than guessing. Nothing here dispatches, persists or
 *   creates approvals — this is the contract only.
 */

/** Identity prefix for every next-cycle identity (versioned contract). */
export const NEXT_CYCLE_IDENTITY_PREFIX = "next-cycle:v1:";

/** Supported next-cycle instruction lifecycle statuses. */
export const NEXT_CYCLE_INSTRUCTION_STATUSES = [
  "ready",
  "dispatched",
  "failed",
] as const;

export type NextCycleInstructionStatus =
  (typeof NEXT_CYCLE_INSTRUCTION_STATUSES)[number];

/**
 * Minimal next-cycle instruction envelope a future dispatcher may consume.
 */
export interface NextCycleInstruction {
  instructionId: string;
  status: NextCycleInstructionStatus;
}

export interface BuildNextCycleIdentityInput {
  campaignId: number;
  /** SHA-256 hex digest of the Strategy snapshot the cycle starts from. */
  strategyHashSha256: string;
  /** Approved proposal fingerprints the cycle consumes (canonicalised). */
  proposalFingerprints: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function canonicalNextCycleJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number": {
      if (!Number.isFinite(value)) {
        throw new Error("next-cycle identity material contains a non-finite number");
      }
      return JSON.stringify(value);
    }
    case "boolean":
      return value ? "true" : "false";
  }
  if (Array.isArray(value)) {
    return `[${value.map(entry => canonicalNextCycleJson(entry)).join(",")}]`;
  }
  if (!isPlainObject(value)) {
    throw new Error("next-cycle identity material must be JSON-like");
  }
  const keys = Object.keys(value).sort();
  return `{${keys
    .map(key => `${JSON.stringify(key)}:${canonicalNextCycleJson(value[key])}`)
    .join(",")}}`;
}

/**
 * Deterministic next-cycle identity over the canonical cycle material.
 * Identical material always yields the same identity; fingerprint order is
 * canonicalised by sorting, so equivalent orders collapse onto one identity.
 */
export function buildNextCycleIdentity(
  input: BuildNextCycleIdentityInput
): string {
  if (!Number.isInteger(input.campaignId) || input.campaignId <= 0) {
    throw new Error("next-cycle identity: campaignId must be a positive integer");
  }
  if (
    typeof input.strategyHashSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(input.strategyHashSha256)
  ) {
    throw new Error(
      "next-cycle identity: strategyHashSha256 must be a 64-character lowercase hex SHA-256 digest"
    );
  }
  if (
    !Array.isArray(input.proposalFingerprints) ||
    input.proposalFingerprints.length === 0
  ) {
    throw new Error(
      "next-cycle identity: proposalFingerprints must be a non-empty array"
    );
  }
  for (const fingerprint of input.proposalFingerprints) {
    if (typeof fingerprint !== "string" || fingerprint.trim().length === 0) {
      throw new Error(
        "next-cycle identity: proposal fingerprints must be non-blank strings"
      );
    }
  }
  if (new Set(input.proposalFingerprints).size !== input.proposalFingerprints.length) {
    throw new Error(
      "next-cycle identity: proposal fingerprints must not contain duplicates"
    );
  }

  // Canonicalise the fingerprint set by sorting so equivalent input order
  // produces an identical identity.
  const canonicalFingerprints = [...input.proposalFingerprints].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0
  );

  const digest = createHash("sha256")
    .update(
      canonicalNextCycleJson({
        campaignId: input.campaignId,
        strategyHashSha256: input.strategyHashSha256,
        proposalFingerprints: canonicalFingerprints,
      }),
      "utf8"
    )
    .digest("hex");

  return `${NEXT_CYCLE_IDENTITY_PREFIX}${digest}`;
}

/**
 * Strict, fail-closed parser for a NextCycleInstruction. Throws on any
 * deviation from the contract instead of guessing — a dispatcher must never
 * act on a partially-valid instruction.
 */
export function parseNextCycleInstruction(value: unknown): NextCycleInstruction {
  if (!isPlainObject(value)) {
    throw new Error("next-cycle instruction: value must be a plain object");
  }
  for (const key of Object.keys(value)) {
    if (key !== "instructionId" && key !== "status") {
      throw new Error(`next-cycle instruction: unknown field "${key}"`);
    }
  }
  const instructionId = value.instructionId;
  if (typeof instructionId !== "string" || instructionId.trim().length === 0) {
    throw new Error(
      "next-cycle instruction: instructionId must be a non-blank string"
    );
  }
  const status = value.status;
  if (!NEXT_CYCLE_INSTRUCTION_STATUSES.includes(status as NextCycleInstructionStatus)) {
    throw new Error(
      `next-cycle instruction: status must be one of ${NEXT_CYCLE_INSTRUCTION_STATUSES.join(", ")}`
    );
  }
  return { instructionId, status: status as NextCycleInstructionStatus };
}
