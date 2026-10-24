/**
 * Engagement Approval Continuation (WBS-R5-C4).
 *
 * Resume authority for marketing_action approvals:
 *
 * - an APPROVED marketing_action approval resumes the bound engagement
 *   action automatically through the full gated execution path (the R5-E
 *   gate re-validates policy version + context binding + approval binding at
 *   execution time — approval never skips the gate);
 * - a REJECTED approval permanently blocks the action identity: matching
 *   executions are marked never_execute (the gate would independently return
 *   ACTION_REJECTED_BY_HUMAN; this makes the block immediate and visible);
 * - duplicate callbacks and boot-time sweeps converge through the durable
 *   disposition resolver — no developer command is ever required;
 * - failures are logged loud and never break the approval decision flow.
 */

import { eq } from "drizzle-orm";
import { getDb } from "../../queries/connection";
import { approvalRequests, engagementExecutions } from "@db/schema";
import { MARKETING_ACTION_APPROVAL_TYPE } from "../policy/marketing-action-approval";
import {
  executeEngagementAction,
  type EngagementExecutionDeps,
} from "./execution";
import {
  updateEngagementExecutionState,
  type EngagementExecutionRecord,
  type EngagementStoreExecutor,
} from "./execution-store";
export const ENGAGEMENT_CONTINUATION_CONTRACT_VERSION = "engagement/continuation@v1";

export interface EngagementContinuationDeps extends EngagementExecutionDeps {
  executor?: EngagementStoreExecutor;
}

export type ContinuationOutcome =
  | { kind: "resumed"; executionId: string; result: string }
  | { kind: "blocked_rejected"; executionId: string }
  | { kind: "no_execution" }
  | { kind: "not_marketing_action" };

/**
 * Drive the continuation for one resolved marketing_action approval.
 * Idempotent: safe under duplicate callbacks and crash-window sweeps.
 */
export async function resumeEngagementContinuationForApproval(
  input: { approvalRequestId: number; userId: number; decision: "approved" | "rejected" },
  deps?: EngagementContinuationDeps
): Promise<ContinuationOutcome> {
  const executor = deps?.executor ?? (getDb() as unknown as EngagementStoreExecutor);

  const [approval] = (await executor
    .select()
    .from(approvalRequests)
    .where(eq(approvalRequests.id, input.approvalRequestId))
    .limit(1)) as Array<{ id: number; userId: number; approvalType: string; status: string }>;

  if (!approval || approval.approvalType !== MARKETING_ACTION_APPROVAL_TYPE) {
    return { kind: "not_marketing_action" };
  }

  const executions = (await executor
    .select()
    .from(engagementExecutions)
    .where(eq(engagementExecutions.approvalRequestId, input.approvalRequestId))
    .limit(10)) as EngagementExecutionRecord[];

  if (executions.length === 0) {
    return { kind: "no_execution" };
  }

  const outcomes: ContinuationOutcome[] = [];
  for (const execution of executions) {
    if (input.decision === "rejected") {
      const { updated } = await updateEngagementExecutionState(
        {
          executionId: execution.executionId,
          patch: {
            status: "never_execute",
            failureClass: "governance",
            lastError: "ACTION_REJECTED_BY_HUMAN (permanent): approval rejected by human operator.",
          },
        },
        executor
      );
      outcomes.push({
        kind: "blocked_rejected",
        executionId: execution.executionId,
      });
      void updated;
      continue;
    }

    // Approved: resume through the full gated path. The R5-E gate
    // re-asserts the exact binding (policy version, context, approval) —
    // a stale or tampered approval still fails closed inside.
    const outcome = await executeEngagementAction(
      { actionRequestId: execution.actionRequestId },
      deps
    );
    outcomes.push({ kind: "resumed", executionId: execution.executionId, result: outcome.kind });
  }

  return outcomes[0];
}

/**
 * Boot sweep: re-drive dangling approved marketing_action continuations
 * (crash between the approval commit and the async callback) and enforce
 * rejected blocks. Converges through durable guards; error-isolated.
 */
export async function runEngagementContinuationSweep(
  input: { limit?: number },
  deps?: EngagementContinuationDeps
): Promise<{ scanned: number; resumed: number; blocked: number; failed: number }> {
  const executor = deps?.executor ?? (getDb() as unknown as EngagementStoreExecutor);
  const limit = input.limit ?? 50;

  const approvals = (await executor
    .select()
    .from(approvalRequests)
    .where(eq(approvalRequests.approvalType, MARKETING_ACTION_APPROVAL_TYPE))
    .limit(limit)) as Array<{ id: number; userId: number; status: string }>;

  let resumed = 0;
  let blocked = 0;
  let failed = 0;

  for (const approval of approvals) {
    try {
      const executions = (await executor
        .select()
        .from(engagementExecutions)
        .where(eq(engagementExecutions.approvalRequestId, approval.id))
        .limit(10)) as EngagementExecutionRecord[];

      for (const execution of executions) {
        if (approval.status === "approved" && ["pending_claim", "pending_retry", "failed_retryable", "ambiguous"].includes(execution.status)) {
          const outcome = await executeEngagementAction(
            { actionRequestId: execution.actionRequestId },
            deps
          );
          if (outcome.kind === "executed") resumed += 1;
        } else if (approval.status === "rejected" && !["never_execute", "succeeded"].includes(execution.status)) {
          await updateEngagementExecutionState(
            {
              executionId: execution.executionId,
              patch: {
                status: "never_execute",
                failureClass: "governance",
                lastError: "ACTION_REJECTED_BY_HUMAN (permanent): approval rejected by human operator.",
              },
            },
            executor
          );
          blocked += 1;
        }
      }
    } catch (err) {
      failed += 1;
      console.error(
        `[Engagement] Continuation sweep failed for approval ${approval.id}:`,
        (err as Error)?.message
      );
    }
  }

  return { scanned: approvals.length, resumed, blocked, failed };
}
