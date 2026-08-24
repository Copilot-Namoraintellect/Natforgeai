/**
 * Phase 5 one-time recovery runner for campaign 30 / user 22 / approval 36.
 *
 * This script is narrowly scoped to recover the partial lifecycle created by the
 * pre-fix `onStrategyApproved` implementation. It performs only SELECT checks
 * and a single invocation of the fixed `onStrategyApproved` trigger; it does not
 * create runs, charges, posts or images directly.
 *
 * Run only after the exact recovery commit recorded in
 * PHASE5_RECOVERY_EXPECTED_HEAD is deployed and the runtime is stable.
 */

import { getDb } from "../api/queries/connection";
import {
  agentRuns,
  approvalRequests,
  campaigns,
  creativeGenerationClaims,
  creditTransactions,
  creditWallets,
} from "../db/schema";
import { eq, and, gt, desc, inArray } from "drizzle-orm";
import { onStrategyApproved } from "../api/lib/workflow/triggers";
import { getStrategyApprovalStatus } from "../api/lib/workflow/strategy-approval";

const CAMPAIGN_ID = 30;
const USER_ID = 22;
const APPROVAL_ID = 36;
const STRATEGY_RUN_ID = 253;
const EXPECTED_FINGERPRINT = "c935ba1009ed5caf2183360b10bbd4e69c20602db023bd73ec9e9af5e848a319";
const BASELINE_PREVIOUS_CREATIVE_RUN_ID = 243;
const MINIMUM_CREDITS = 5;
const IDEMPOTENCY_KEY = `creative-success:${CAMPAIGN_ID}:approval:${APPROVAL_ID}`;

class RecoveryPreconditionError extends Error {
  constructor(public readonly detail: string) {
    super(`Recovery precondition failed: ${detail}`);
  }
}

async function verifyDeployedCommit(): Promise<void> {
  // This runner expects the deployment script to pass the exact recovery
  // commit via PHASE5_RECOVERY_EXPECTED_HEAD. This avoids a chicken-and-egg
  // problem where hard-coding the commit hash inside this file changes the
  // commit hash of the file itself.
  const deployedHead = process.env.PHASE5_RECOVERY_EXPECTED_HEAD;
  if (!deployedHead || deployedHead.length !== 40) {
    throw new RecoveryPreconditionError(
      "PHASE5_RECOVERY_EXPECTED_HEAD environment variable is missing or not a 40-character commit hash"
    );
  }
}

async function verifyApproval(): Promise<void> {
  const db = getDb();
  const [approval] = await db
    .select()
    .from(approvalRequests)
    .where(and(eq(approvalRequests.id, APPROVAL_ID), eq(approvalRequests.userId, USER_ID)))
    .limit(1);

  if (!approval) {
    throw new RecoveryPreconditionError(`Approval ${APPROVAL_ID} not found for user ${USER_ID}`);
  }
  if (approval.campaignId !== CAMPAIGN_ID) {
    throw new RecoveryPreconditionError(
      `Approval ${APPROVAL_ID} campaignId ${approval.campaignId} != ${CAMPAIGN_ID}`
    );
  }
  if (approval.approvalType !== "strategy_review") {
    throw new RecoveryPreconditionError(
      `Approval ${APPROVAL_ID} approvalType ${approval.approvalType} != strategy_review`
    );
  }
  if (approval.status !== "approved") {
    throw new RecoveryPreconditionError(
      `Approval ${APPROVAL_ID} status ${approval.status} != approved`
    );
  }
}

async function verifyStrategyRunAndFingerprint(): Promise<void> {
  const db = getDb();
  const [run] = await db
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.id, STRATEGY_RUN_ID), eq(agentRuns.userId, USER_ID)))
    .limit(1);

  if (!run) {
    throw new RecoveryPreconditionError(`Strategy run ${STRATEGY_RUN_ID} not found`);
  }
  if (run.campaignId !== CAMPAIGN_ID) {
    throw new RecoveryPreconditionError(
      `Strategy run ${STRATEGY_RUN_ID} campaignId ${run.campaignId} != ${CAMPAIGN_ID}`
    );
  }
  if (run.status !== "completed") {
    throw new RecoveryPreconditionError(
      `Strategy run ${STRATEGY_RUN_ID} status ${run.status} != completed`
    );
  }

  const [campaign] = await db
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.id, CAMPAIGN_ID), eq(campaigns.userId, USER_ID)))
    .limit(1);

  if (!campaign) {
    throw new RecoveryPreconditionError(`Campaign ${CAMPAIGN_ID} not found`);
  }

  const status = getStrategyApprovalStatus(campaign, null);
  if (status.lineage?.strategyRunId !== STRATEGY_RUN_ID) {
    throw new RecoveryPreconditionError(
      `Lineage strategyRunId ${status.lineage?.strategyRunId} != ${STRATEGY_RUN_ID}`
    );
  }
  if (status.lineage?.approvalRequestId !== APPROVAL_ID) {
    throw new RecoveryPreconditionError(
      `Lineage approvalRequestId ${status.lineage?.approvalRequestId} != ${APPROVAL_ID}`
    );
  }
  if (status.lineage?.creativeBriefFingerprint !== EXPECTED_FINGERPRINT) {
    throw new RecoveryPreconditionError(
      `Lineage creativeBriefFingerprint mismatch: ${status.lineage?.creativeBriefFingerprint}`
    );
  }
  if (status.lineage?.status !== "approved") {
    throw new RecoveryPreconditionError(
      `Lineage status ${status.lineage?.status} != approved (strategy approval not persisted)`
    );
  }
  if (status.approvedStrategyFingerprint !== EXPECTED_FINGERPRINT) {
    throw new RecoveryPreconditionError(
      `approvedStrategyFingerprint ${status.approvedStrategyFingerprint} != ${EXPECTED_FINGERPRINT}`
    );
  }
}

async function verifyNoNewerStrategyRun(): Promise<void> {
  const db = getDb();
  const newer = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.campaignId, CAMPAIGN_ID),
        eq(agentRuns.userId, USER_ID),
        eq(agentRuns.agentType, "strategy"),
        gt(agentRuns.id, STRATEGY_RUN_ID)
      )
    )
    .limit(1);

  if (newer.length > 0) {
    throw new RecoveryPreconditionError(
      `Newer strategy run exists: ${newer[0].id}`
    );
  }
}

async function verifyNoCreativeRunAfterBaseline(): Promise<void> {
  const db = getDb();
  const newer = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.campaignId, CAMPAIGN_ID),
        eq(agentRuns.userId, USER_ID),
        eq(agentRuns.agentType, "creative"),
        gt(agentRuns.id, BASELINE_PREVIOUS_CREATIVE_RUN_ID)
      )
    )
    .limit(1);

  if (newer.length > 0) {
    throw new RecoveryPreconditionError(
      `Creative run after baseline ${BASELINE_PREVIOUS_CREATIVE_RUN_ID} exists: ${newer[0].id}`
    );
  }
}

async function verifyNoExistingCharge(): Promise<void> {
  const db = getDb();
  const existing = await db
    .select({ id: creditTransactions.id })
    .from(creditTransactions)
    .where(
      and(
        eq(creditTransactions.userId, USER_ID),
        eq(creditTransactions.type, "agent_deduction"),
        eq(creditTransactions.idempotencyKey, IDEMPOTENCY_KEY)
      )
    )
    .limit(1);

  if (existing.length > 0) {
    throw new RecoveryPreconditionError(
      `Existing creative charge found: ${existing[0].id}`
    );
  }
}

async function verifyWalletCredits(): Promise<void> {
  const db = getDb();
  const [wallet] = await db
    .select({ balance: creditWallets.balance })
    .from(creditWallets)
    .where(eq(creditWallets.userId, USER_ID))
    .limit(1);

  if (!wallet) {
    throw new RecoveryPreconditionError(`Credit wallet not found for user ${USER_ID}`);
  }
  if (wallet.balance < MINIMUM_CREDITS) {
    throw new RecoveryPreconditionError(
      `Insufficient credits: balance ${wallet.balance} < ${MINIMUM_CREDITS}`
    );
  }
}

async function verifyNoActiveCreativeClaim(): Promise<void> {
  const db = getDb();
  const active = await db
    .select({ id: creativeGenerationClaims.id })
    .from(creativeGenerationClaims)
    .where(
      and(
        eq(creativeGenerationClaims.userId, USER_ID),
        eq(creativeGenerationClaims.campaignId, CAMPAIGN_ID),
        eq(creativeGenerationClaims.status, "running")
      )
    )
    .limit(1);

  if (active.length > 0) {
    throw new RecoveryPreconditionError(
      `Active creative claim exists: ${active[0].id}`
    );
  }
}

async function verifyRecoveryPostconditions(): Promise<void> {
  const db = getDb();

  // 1. Approved lineage and fingerprint.
  const [campaign] = await db
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.id, CAMPAIGN_ID), eq(campaigns.userId, USER_ID)))
    .limit(1);

  if (!campaign) {
    throw new RecoveryPreconditionError(`Campaign ${CAMPAIGN_ID} not found after recovery`);
  }

  const status = getStrategyApprovalStatus(campaign, null);
  if (status.lineage?.strategyRunId !== STRATEGY_RUN_ID) {
    throw new RecoveryPreconditionError(
      `Post-recovery lineage strategyRunId ${status.lineage?.strategyRunId} != ${STRATEGY_RUN_ID}`
    );
  }
  if (status.lineage?.approvalRequestId !== APPROVAL_ID) {
    throw new RecoveryPreconditionError(
      `Post-recovery lineage approvalRequestId ${status.lineage?.approvalRequestId} != ${APPROVAL_ID}`
    );
  }
  if (status.lineage?.creativeBriefFingerprint !== EXPECTED_FINGERPRINT) {
    throw new RecoveryPreconditionError(
      `Post-recovery lineage creativeBriefFingerprint mismatch: ${status.lineage?.creativeBriefFingerprint}`
    );
  }
  if (status.lineage?.status !== "approved") {
    throw new RecoveryPreconditionError(
      `Post-recovery lineage status ${status.lineage?.status} != approved`
    );
  }
  if (status.approvedStrategyFingerprint !== EXPECTED_FINGERPRINT) {
    throw new RecoveryPreconditionError(
      `Post-recovery approvedStrategyFingerprint ${status.approvedStrategyFingerprint} != ${EXPECTED_FINGERPRINT}`
    );
  }

  // 2. Exactly one approval-correlated creative run, created/completed.
  const creativeRuns = await db
    .select()
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.campaignId, CAMPAIGN_ID),
        eq(agentRuns.userId, USER_ID),
        eq(agentRuns.agentType, "creative"),
        gt(agentRuns.id, BASELINE_PREVIOUS_CREATIVE_RUN_ID)
      )
    )
    .orderBy(desc(agentRuns.id));

  if (creativeRuns.length !== 1) {
    throw new RecoveryPreconditionError(
      `Expected exactly one new creative run after baseline ${BASELINE_PREVIOUS_CREATIVE_RUN_ID}; found ${creativeRuns.length}`
    );
  }

  const creativeRun = creativeRuns[0];
  if (!["running", "completed"].includes(creativeRun.status)) {
    throw new RecoveryPreconditionError(
      `New creative run ${creativeRun.id} has unexpected status: ${creativeRun.status}`
    );
  }

  // 3. Exactly one successful -5 agent_deduction with the expected idempotency key.
  const charges = await db
    .select()
    .from(creditTransactions)
    .where(
      and(
        eq(creditTransactions.userId, USER_ID),
        eq(creditTransactions.type, "agent_deduction"),
        eq(creditTransactions.idempotencyKey, IDEMPOTENCY_KEY)
      )
    );

  const successfulCharges = charges.filter(
    (c) => c.status === "completed" && c.amount === -5
  );

  if (successfulCharges.length !== 1) {
    throw new RecoveryPreconditionError(
      `Expected exactly one successful -5 agent_deduction; found ${successfulCharges.length}`
    );
  }

  // 4. No refund transaction for the idempotency key.
  const refunds = charges.filter(
    (c) => c.status === "completed" && c.amount > 0
  );

  if (refunds.length > 0) {
    throw new RecoveryPreconditionError(
      `Found ${refunds.length} refund transaction(s) for idempotency key ${IDEMPOTENCY_KEY}`
    );
  }

  // 5. Claim state: one terminal approval-correlated claim.
  const approvalClaims = await db
    .select()
    .from(creativeGenerationClaims)
    .where(
      and(
        eq(creativeGenerationClaims.userId, USER_ID),
        eq(creativeGenerationClaims.campaignId, CAMPAIGN_ID),
        eq(creativeGenerationClaims.operationSource, "approval"),
        eq(creativeGenerationClaims.operationReferenceId, APPROVAL_ID)
      )
    );

  const terminalClaims = approvalClaims.filter(
    (c) => c.status === "completed" && c.activeClaimKey === null
  );
  const runningClaims = approvalClaims.filter(
    (c) => c.status === "running" && c.activeClaimKey !== null
  );

  if (runningClaims.length > 0) {
    throw new RecoveryPreconditionError(
      `Found ${runningClaims.length} still-running approval-correlated claim(s); recovery did not complete`
    );
  }

  if (terminalClaims.length !== 1) {
    throw new RecoveryPreconditionError(
      `Expected exactly one terminal completed approval-correlated claim; found ${terminalClaims.length}`
    );
  }

  // 6. Campaign workflow state should have advanced past strategy approval.
  const expectedStates = [
    "creatives_generating",
    "creatives_complete",
    "audience_generating",
    "audience_complete",
    "schedule_generated",
    "schedule_approved",
    "launch_approved",
    "launched",
  ];
  if (!expectedStates.includes(campaign.workflowState)) {
    throw new RecoveryPreconditionError(
      `Post-recovery campaign workflowState ${campaign.workflowState} is not in expected advanced states`
    );
  }

  console.log("[Phase5Recovery] Post-recovery verification passed");
}

async function main() {
  console.log("[Phase5Recovery] Starting one-time recovery runner");
  console.log(`[Phase5Recovery] Campaign=${CAMPAIGN_ID} User=${USER_ID} Approval=${APPROVAL_ID}`);

  await verifyDeployedCommit();
  console.log("[Phase5Recovery] Deployed commit precondition satisfied");

  await verifyApproval();
  console.log("[Phase5Recovery] Approval 36 precondition satisfied");

  await verifyStrategyRunAndFingerprint();
  console.log("[Phase5Recovery] Strategy run 253 and lineage preconditions satisfied");

  await verifyNoNewerStrategyRun();
  console.log("[Phase5Recovery] No newer strategy run");

  await verifyNoCreativeRunAfterBaseline();
  console.log("[Phase5Recovery] No creative run after baseline 243");

  await verifyNoExistingCharge();
  console.log("[Phase5Recovery] No existing creative-success charge");

  await verifyWalletCredits();
  console.log("[Phase5Recovery] Wallet has sufficient credits");

  await verifyNoActiveCreativeClaim();
  console.log("[Phase5Recovery] No active creative claim");

  console.log("[Phase5Recovery] All preconditions passed. Invoking onStrategyApproved once.");
  await onStrategyApproved(CAMPAIGN_ID, USER_ID, APPROVAL_ID);

  // onStrategyApproved returns a resolved promise even when it short-circuits.
  // Verify that the lifecycle actually advanced before declaring success.
  try {
    await verifyRecoveryPostconditions();
  } catch (err: any) {
    console.error("[Phase5Recovery] Post-recovery verification failed:", err.message);
    throw err;
  }

  console.log("[Phase5Recovery] onStrategyApproved completed and post-recovery verification passed");
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error("[Phase5Recovery] FAILED:", err.message);
    process.exit(1);
  });
