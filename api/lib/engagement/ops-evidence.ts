/**
 * R5 Operations Evidence bridge (WBS-R5-C → R5-F/R5-X seam).
 *
 * The frozen R5-F contract (`marketing-operations-governance-contract.md` §11)
 * lists the C area as "R4 engagement authorities today" because C did not
 * exist when F froze. This module is the DOCUMENTED INTEGRATION SEAM for
 * R5-X: it projects C's durable engagement state into the normalized,
 * read-only evidence shape F's `projectR5BusinessOperations` consumes.
 *
 * Rules (mirroring F invariants):
 * - READ-ONLY. Never writes, transitions, retries or "heals" anything.
 * - Deterministic pure derivation from durable rows (explicit clock input).
 * - Secret-free: only allow-listed columns; no tokens, no raw social text,
 *   no reply content (hashes/ids/statuses only).
 * - Actor-agnostic: the caller decides visibility; user surfaces stay
 *   owner-scoped, operator surfaces may read cross-business.
 *
 * R5-X integration: register `collectEngagementOperationsEvidence` alongside
 * the existing stream collectors in `api/lib/governance/r5-stream-evidence.ts`
 * and map the returned blocker classes through `R5_BLOCKER_CLASS_POLICY`
 * (classes below are already F vocabulary values).
 */

import { and, eq, desc, gte } from "drizzle-orm";
import { engagementExecutions, engagementReceipts } from "@db/schema";
import { getDb } from "../../queries/connection";
import type { EngagementStoreExecutor } from "./execution-store";

export const ENGAGEMENT_OPS_EVIDENCE_CONTRACT_VERSION = "engagement/ops-evidence@v1";

/** F blocker classes this evidence can produce (frozen F vocabulary). */
export type EngagementOpsBlockerClass =
  | "POLICY_REQUIRES_APPROVAL"
  | "RATE_LIMITED"
  | "UNSUPPORTED_PROVIDER_CAPABILITY"
  | "STALE_OPERATION"
  | "OWNERSHIP_MISMATCH"
  | "SECURITY_REJECTION"
  | "MODEL_TIMEOUT";

export interface EngagementExecutionEvidence {
  executionId: string;
  actionRequestId: string;
  businessId: number;
  status: string;
  actionType: string;
  platform: string;
  provider: string;
  policyDecisionId: string;
  approvalRequestId: number | null;
  attempt: number;
  failureClass: string | null;
  reconciliationState: string;
  lastError: string | null;
  updatedAt: string | Date | null;
}

export interface EngagementReceiptEvidence {
  engagementReceiptId: string;
  executionId: string;
  businessId: number;
  status: string;
  executedAt: string;
  providerOperationIdentity: string;
}

export interface EngagementOperationsEvidence {
  businessId: number;
  executions: EngagementExecutionEvidence[];
  receipts: EngagementReceiptEvidence[];
  openBlockers: Array<{
    blockerClass: EngagementOpsBlockerClass;
    recoveryClassHint: "AUTO_RECOVER" | "OPERATOR_ACTION" | "GOVERNANCE_APPROVAL" | "FAIL_CLOSED";
    executionId: string;
    detail: string;
  }>;
  counts: {
    pendingPolicy: number;
    pendingApproval: number;
    generating: number;
    executable: number;
    providerRetry: number;
    ambiguous: number;
    receiptConfirmed: number;
    unsupported: number;
    blockedConfiguration: number;
    securityRejection: number;
  };
}

const TERMINAL_STATUSES = new Set(["succeeded", "failed_terminal", "blocked", "never_execute", "internal_only"]);

/**
 * Derive the operations projection inputs for one business. Explicit-clock
 * pure read over durable rows; the returned counts are the C vocabulary the
 * F projection maps onto its own state model (F owns the state machine —
 * this module adds no second one).
 */
export async function collectEngagementOperationsEvidence(
  input: { businessId: number; since?: Date },
  executor?: EngagementStoreExecutor
): Promise<EngagementOperationsEvidence> {
  const db = executor ?? (getDb() as unknown as EngagementStoreExecutor);
  const since = input.since ?? new Date(0);

  const executions = (await db
    .select({
      executionId: engagementExecutions.executionId,
      actionRequestId: engagementExecutions.actionRequestId,
      businessId: engagementExecutions.businessId,
      status: engagementExecutions.status,
      actionType: engagementExecutions.actionType,
      platform: engagementExecutions.platform,
      provider: engagementExecutions.provider,
      policyDecisionId: engagementExecutions.policyDecisionId,
      approvalRequestId: engagementExecutions.approvalRequestId,
      attempt: engagementExecutions.attempt,
      failureClass: engagementExecutions.failureClass,
      reconciliationState: engagementExecutions.reconciliationState,
      lastError: engagementExecutions.lastError,
      updatedAt: engagementExecutions.updatedAt,
    })
    .from(engagementExecutions)
    .where(
      and(
        eq(engagementExecutions.businessId, input.businessId),
        gte(engagementExecutions.updatedAt, since)
      )
    )
    .orderBy(desc(engagementExecutions.updatedAt))
    .limit(500)) as unknown as EngagementExecutionEvidence[];

  const receipts = (await db
    .select({
      engagementReceiptId: engagementReceipts.engagementReceiptId,
      executionId: engagementReceipts.executionId,
      businessId: engagementReceipts.businessId,
      status: engagementReceipts.status,
      executedAt: engagementReceipts.executedAt,
      providerOperationIdentity: engagementReceipts.providerOperationIdentity,
    })
    .from(engagementReceipts)
    .where(eq(engagementReceipts.businessId, input.businessId))
    .limit(500)) as unknown as EngagementReceiptEvidence[];

  const counts: EngagementOperationsEvidence["counts"] = {
    pendingPolicy: 0,
    pendingApproval: 0,
    generating: 0,
    executable: 0,
    providerRetry: 0,
    ambiguous: 0,
    receiptConfirmed: receipts.length,
    unsupported: 0,
    blockedConfiguration: 0,
    securityRejection: 0,
  };
  const openBlockers: EngagementOperationsEvidence["openBlockers"] = [];

  for (const execution of executions) {
    if (TERMINAL_STATUSES.has(execution.status)) {
      if (execution.status === "blocked" && execution.failureClass === "unsupported") {
        counts.unsupported += 1;
        openBlockers.push({
          blockerClass: "UNSUPPORTED_PROVIDER_CAPABILITY",
          recoveryClassHint: "OPERATOR_ACTION",
          executionId: execution.executionId,
          detail: execution.lastError ?? "unsupported provider capability",
        });
      } else if (execution.status === "blocked") {
        counts.blockedConfiguration += 1;
      } else if (execution.status === "never_execute" && execution.failureClass === "governance") {
        counts.securityRejection += 1;
        openBlockers.push({
          blockerClass: "SECURITY_REJECTION",
          recoveryClassHint: "FAIL_CLOSED",
          executionId: execution.executionId,
          detail: execution.lastError ?? "governance rejection",
        });
      }
      continue;
    }

    switch (execution.status) {
      case "executing":
      case "pending_claim":
        counts.executable += 1;
        break;
      case "pending_retry":
      case "failed_retryable":
        counts.providerRetry += 1;
        openBlockers.push({
          blockerClass: "RATE_LIMITED",
          recoveryClassHint: "AUTO_RECOVER",
          executionId: execution.executionId,
          detail: "provider retry in progress",
        });
        break;
      case "ambiguous":
        counts.ambiguous += 1;
        openBlockers.push({
          blockerClass: "STALE_OPERATION",
          recoveryClassHint: "AUTO_RECOVER",
          executionId: execution.executionId,
          detail: "ambiguous provider outcome under reconciliation",
        });
        break;
    }
    if (execution.approvalRequestId != null) {
      counts.pendingApproval += 1;
      openBlockers.push({
        blockerClass: "POLICY_REQUIRES_APPROVAL",
        recoveryClassHint: "GOVERNANCE_APPROVAL",
        executionId: execution.executionId,
        detail: "human approval required before execution",
      });
    }
  }

  return { businessId: input.businessId, executions, receipts, openBlockers, counts };
}
