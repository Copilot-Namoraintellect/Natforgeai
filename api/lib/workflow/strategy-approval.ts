import { buildGroundedCreativeBrief } from "../creative/brief-grounding";
import { validateStrategyOutputAgainstCampaign } from "../agents/strategy-agent";
import { getDb } from "../../queries/connection";
import { agentRuns } from "@db/schema";
import { eq, and } from "drizzle-orm";
import { TRPCError } from "@trpc/server";

export interface StrategyApprovalLineage {
  /** Fingerprint of the campaign brief that produced the linked strategy. */
  creativeBriefFingerprint: string;
  /** ID of the strategy agent run that produced the strategy. */
  strategyRunId: number;
  /** ID of the strategy_review approval request tied to that strategy run. */
  approvalRequestId: number;
  /** Terminal state of the lineage request. */
  status: "pending" | "approved" | "rejected" | "stale";
}

export interface StrategyApprovalStatus {
  /** Fingerprint of the currently persisted campaign brief. */
  currentFingerprint: string;
  /** Fingerprint stored when the latest strategy was generated. */
  strategyFingerprint: string | null;
  /** Fingerprint stored when the latest strategy was approved. */
  approvedStrategyFingerprint: string | null;
  /** True when an approved strategy exists and matches the current brief. */
  isCurrent: boolean;
  /** True when any approved-strategy fingerprint has been recorded. */
  hasApprovedStrategy: boolean;
  /** True when a strategy has been generated for the current brief. */
  strategyGeneratedForCurrentBrief: boolean;
  /** Active lineage entry, if any. */
  lineage: StrategyApprovalLineage | null;
}

export interface SemanticStrategyValidationResult {
  valid: boolean;
  reason?: string;
}

function readContextString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readLineage(ctx: Record<string, unknown> | null | undefined): StrategyApprovalLineage | null {
  const raw = ctx?.strategyApprovalLineage;
  if (!raw || typeof raw !== "object") return null;
  const l = raw as Record<string, unknown>;
  const creativeBriefFingerprint = readContextString(l.creativeBriefFingerprint);
  const strategyRunId = typeof l.strategyRunId === "number" && Number.isFinite(l.strategyRunId) ? l.strategyRunId : null;
  const approvalRequestId =
    typeof l.approvalRequestId === "number" && Number.isFinite(l.approvalRequestId) ? l.approvalRequestId : null;
  const status =
    typeof l.status === "string" && ["pending", "approved", "rejected", "stale"].includes(l.status)
      ? (l.status as StrategyApprovalLineage["status"])
      : null;

  if (!creativeBriefFingerprint || strategyRunId == null || approvalRequestId == null || !status) return null;
  return { creativeBriefFingerprint, strategyRunId, approvalRequestId, status };
}

/**
 * Resolve the strategy-approval fingerprint status for a campaign.
 *
 * Uses the existing structured `workflowContext` JSON column; no migration is
 * required. A strategy is considered current only when an approved-strategy
 * fingerprint exists and matches the fingerprint of the persisted campaign
 * brief.
 */
export function getStrategyApprovalStatus(campaign: unknown): StrategyApprovalStatus {
  const brief = buildGroundedCreativeBrief({ campaign });
  const ctx =
    campaign && typeof campaign === "object"
      ? ((campaign as Record<string, unknown>).workflowContext as Record<string, unknown> | null | undefined)
      : undefined;

  const strategyFingerprint = readContextString(ctx?.strategyFingerprint);
  const approvedStrategyFingerprint = readContextString(ctx?.approvedStrategyFingerprint);
  const lineage = readLineage(ctx);

  // Fail closed: an approved strategy is current only when the approved
  // fingerprint matches the current brief AND a durable lineage record exists
  // with status "approved" for the same brief. Missing fingerprint or lineage
  // evidence must be treated as stale, never current/approved.
  const hasApprovedLineage =
    lineage?.status === "approved" && lineage.creativeBriefFingerprint === brief.fingerprint;
  const isCurrent =
    !!approvedStrategyFingerprint &&
    approvedStrategyFingerprint === brief.fingerprint &&
    hasApprovedLineage;
  const hasApprovedStrategy = isCurrent;

  return {
    currentFingerprint: brief.fingerprint,
    strategyFingerprint,
    approvedStrategyFingerprint,
    isCurrent,
    hasApprovedStrategy,
    strategyGeneratedForCurrentBrief: !!strategyFingerprint && strategyFingerprint === brief.fingerprint,
    lineage,
  };
}

/** Returns true when an approved strategy exists and matches the current brief. */
export function isApprovedStrategyCurrent(campaign: unknown): boolean {
  return getStrategyApprovalStatus(campaign).isCurrent;
}

/** Returns true when the latest generated strategy matches the current brief. */
export function isStrategyGeneratedForCurrentBrief(campaign: unknown): boolean {
  return getStrategyApprovalStatus(campaign).strategyGeneratedForCurrentBrief;
}

/**
 * Build a fresh strategy-approval lineage entry.
 */
export function buildStrategyApprovalLineage(
  creativeBriefFingerprint: string,
  strategyRunId: number,
  approvalRequestId: number,
  status: StrategyApprovalLineage["status"] = "pending"
): StrategyApprovalLineage {
  return { creativeBriefFingerprint, strategyRunId, approvalRequestId, status };
}

/**
 * Check whether the lineage recorded in workflowContext matches the current brief
 * and the supplied run/request IDs. This guards against approving a stale
 * request after the brief has been regenerated.
 */
export function isLineageAuthoritative(
  campaign: unknown,
  input: { strategyRunId?: number | null; approvalRequestId?: number | null }
): boolean {
  const status = getStrategyApprovalStatus(campaign);
  const lineage = status.lineage;
  if (!lineage) return false;
  if (lineage.creativeBriefFingerprint !== status.currentFingerprint) return false;
  if (input.strategyRunId != null && lineage.strategyRunId !== input.strategyRunId) return false;
  if (input.approvalRequestId != null && lineage.approvalRequestId !== input.approvalRequestId) return false;
  return true;
}

/**
 * Load the lineage-linked strategy run and validate its output against the
 * current persisted campaign brief. An existing run can be supplied to avoid a
 * duplicate database query when the caller has already loaded it.
 */
export async function validateStrategyRunForCampaign(
  campaign: unknown,
  userId: number,
  existingRun?: { status: string; output: unknown } | null
): Promise<SemanticStrategyValidationResult> {
  const status = getStrategyApprovalStatus(campaign);
  const lineage = status.lineage;
  if (!lineage) {
    return { valid: false, reason: "No strategy approval lineage recorded." };
  }

  let run = existingRun;
  if (!run) {
    const db = getDb();
    const campaignId = (campaign as Record<string, number> | null | undefined)?.id;
    if (campaignId == null) {
      return { valid: false, reason: "Campaign identifier is missing." };
    }
    const [dbRun] = await db
      .select()
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.id, lineage.strategyRunId),
          eq(agentRuns.campaignId, campaignId),
          eq(agentRuns.userId, userId),
          eq(agentRuns.agentType, "strategy")
        )
      )
      .limit(1);
    run = dbRun;
  }

  if (!run || run.status !== "completed") {
    return { valid: false, reason: "Linked strategy run is missing or not completed." };
  }

  return validateStrategyOutputAgainstCampaign(run.output, campaign);
}

/**
 * Shared impure assertion used by every campaign-linked creative generation
 * entry point. Throws PRECONDITION_FAILED if the approved strategy is missing,
 * fingerprint-stale, or semantically invalid for the current brief.
 */
export async function assertApprovedStrategySemanticallyValid(
  campaign: unknown,
  userId: number
): Promise<void> {
  const status = getStrategyApprovalStatus(campaign);
  if (!status.isCurrent) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "The approved strategy is stale or missing. Regenerate the strategy for approval before creating content.",
    });
  }

  const semantic = await validateStrategyRunForCampaign(campaign, userId);
  if (!semantic.valid) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `The approved strategy no longer matches the current campaign brief: ${semantic.reason}. Regenerate the strategy for approval before creating content.`,
    });
  }
}
