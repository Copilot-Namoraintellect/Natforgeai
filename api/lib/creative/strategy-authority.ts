import { TRPCError } from "@trpc/server";

import {
  getStrategyApprovalStatus,
  type StrategyApprovalLineage,
} from "../workflow/strategy-approval";

/**
 * Exact immutable Strategy authority captured by Creative after the WBS11
 * approval/snapshot assertion succeeds.
 *
 * This is deliberately identity-only: Creative must carry these coordinates
 * through its job and artifact lifecycle instead of relying only on mutable
 * campaign projections.
 */
export interface CreativeStrategyAuthority {
  readonly strategySnapshotId: string;
  readonly strategyVersion: number;
  readonly businessDnaSnapshotId: string;
  readonly strategyHashSha256: string;
  readonly strategyRunId: number;
  readonly approvalRequestId: number;
  readonly creativeBriefFingerprint: string;
}

function failClosed(reason: string): never {
  throw new TRPCError({
    code: "PRECONDITION_FAILED",
    message:
      `Creative Strategy authority is incomplete or invalid (${reason}). ` +
      "Regenerate and approve the Strategy before creating content.",
  });
}

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    failClosed(field);
  }

  return value;
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value <= 0
  ) {
    failClosed(field);
  }

  return value;
}

/**
 * Converts an already-validated WBS11 approval lineage into Creative-owned
 * immutable authority coordinates.
 */
export function buildCreativeStrategyAuthority(
  lineage: StrategyApprovalLineage | null | undefined
): CreativeStrategyAuthority {
  if (!lineage || lineage.status !== "approved") {
    failClosed("approved lineage");
  }

  const strategyHashSha256 =
    requireNonEmpty(
      lineage.strategyHashSha256,
      "strategyHashSha256"
    ).toLowerCase();

  if (!/^[a-f0-9]{64}$/.test(strategyHashSha256)) {
    failClosed("strategyHashSha256");
  }

  return Object.freeze({
    strategySnapshotId: requireNonEmpty(
      lineage.strategySnapshotId,
      "strategySnapshotId"
    ),
    strategyVersion: requirePositiveInteger(
      lineage.strategyVersion,
      "strategyVersion"
    ),
    businessDnaSnapshotId: requireNonEmpty(
      lineage.businessDnaSnapshotId,
      "businessDnaSnapshotId"
    ),
    strategyHashSha256,
    strategyRunId: requirePositiveInteger(
      lineage.strategyRunId,
      "strategyRunId"
    ),
    approvalRequestId: requirePositiveInteger(
      lineage.approvalRequestId,
      "approvalRequestId"
    ),
    creativeBriefFingerprint: requireNonEmpty(
      lineage.creativeBriefFingerprint,
      "creativeBriefFingerprint"
    ),
  });
}

/**
 * Capture Creative's Strategy authority immediately after
 * assertApprovedStrategySemanticallyValid() has proven the campaign's WBS11
 * snapshot/approval authority.
 */
export function captureApprovedCreativeStrategyAuthority(
  campaign: unknown
): CreativeStrategyAuthority {
  const status =
    getStrategyApprovalStatus(campaign);

  return buildCreativeStrategyAuthority(
    status.lineage
  );
}
