/**
 * Phase 5 claim-15 historical correction runner.
 *
 * The pre-fix `onStrategyApproved` implementation incorrectly released claim 15
 * as `completed` when no creative run or charge occurred. This runner evaluates
 * whether claim 15 can be safely marked `failed` and annotated with a recovery
 * reason using an existing schema field.
 *
 * The `creative_generation_claims` table in the current schema has no
 * `error`, `reason`, `metadata`, or `context` column. Therefore this runner
 * preserves claim 15 unchanged and reports the limitation. It does not invent
 * columns or run migrations.
 */

import { getDb } from "../api/queries/connection";
import {
  creativeGenerationClaims,
  agentRuns,
  creditTransactions,
} from "../db/schema";
import { eq, and, gt } from "drizzle-orm";

const CAMPAIGN_ID = 30;
const USER_ID = 22;
const APPROVAL_ID = 36;
const CLAIM_ID = 15;
const STRATEGY_RUN_ID = 253;
const BASELINE_PREVIOUS_CREATIVE_RUN_ID = 243;
const IDEMPOTENCY_KEY = `creative-success:${CAMPAIGN_ID}:approval:${APPROVAL_ID}`;

class CorrectionPreconditionError extends Error {
  constructor(public readonly detail: string) {
    super(`Claim 15 correction precondition failed: ${detail}`);
  }
}

async function verifySchemaSupportsReason(): Promise<boolean> {
  const db = getDb();
  const [column] = await db.execute(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'creative_generation_claims'
       AND COLUMN_NAME IN ('error', 'reason', 'metadata', 'context')
     LIMIT 1`
  ) as unknown as [{ COLUMN_NAME?: string }[]];

  return column && column.length > 0 && Boolean(column[0].COLUMN_NAME);
}

async function main() {
  console.log("[Phase5Claim15Correction] Starting historical correction evaluation");

  const db = getDb();

  // 1. Schema support check (informational only)
  const schemaSupportsReason = await verifySchemaSupportsReason();
  if (!schemaSupportsReason) {
    console.log(
      "[Phase5Claim15Correction] SCHEMA_LIMITATION_FOR_REASON: creative_generation_claims has no error/reason/metadata/context column. Recovery reason will not be persisted, but the guarded status correction still proceeds."
    );
  }

  // 2. Load claim 15
  const [claim] = await db
    .select()
    .from(creativeGenerationClaims)
    .where(eq(creativeGenerationClaims.id, CLAIM_ID))
    .limit(1);

  if (!claim) {
    console.log(
      `[Phase5Claim15Correction] CLAIM_15_ALREADY_ABSENT: claim ${CLAIM_ID} does not exist; no historical correction is required.`
    );
    return;
  }

  // 3. Exact precondition check
  if (claim.userId !== USER_ID) {
    throw new CorrectionPreconditionError(
      `Claim ${CLAIM_ID} userId ${claim.userId} != ${USER_ID}`
    );
  }
  if (claim.campaignId !== CAMPAIGN_ID) {
    throw new CorrectionPreconditionError(
      `Claim ${CLAIM_ID} campaignId ${claim.campaignId} != ${CAMPAIGN_ID}`
    );
  }
  if (claim.operationSource !== "approval") {
    throw new CorrectionPreconditionError(
      `Claim ${CLAIM_ID} operationSource ${claim.operationSource} != approval`
    );
  }
  if (claim.operationReferenceId !== APPROVAL_ID) {
    throw new CorrectionPreconditionError(
      `Claim ${CLAIM_ID} operationReferenceId ${claim.operationReferenceId} != ${APPROVAL_ID}`
    );
  }
  if (claim.status !== "completed") {
    throw new CorrectionPreconditionError(
      `Claim ${CLAIM_ID} status ${claim.status} != completed`
    );
  }
  if (claim.activeClaimKey !== null) {
    throw new CorrectionPreconditionError(
      `Claim ${CLAIM_ID} activeClaimKey is not null: ${claim.activeClaimKey}`
    );
  }

  // 4. No correlated creative run
  const newerRun = await db
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

  if (newerRun.length > 0) {
    throw new CorrectionPreconditionError(
      `Creative run after baseline ${BASELINE_PREVIOUS_CREATIVE_RUN_ID} exists: ${newerRun[0].id}`
    );
  }

  // 5. No existing creative-success charge
  const existingCharge = await db
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

  if (existingCharge.length > 0) {
    throw new CorrectionPreconditionError(
      `Existing creative charge found: ${existingCharge[0].id}`
    );
  }

  // 6. Mark claim failed and clear activeClaimKey so the claim can be safely
  // re-armed by the fixed onStrategyApproved.  The reason is not persisted
  // because the current schema has no error/reason/metadata/context column.
  console.log(
    `[Phase5Claim15Correction] Marking claim ${CLAIM_ID} as failed/inactive.`
  );
  await db
    .update(creativeGenerationClaims)
    .set({
      status: "failed",
      activeClaimKey: null,
    } as any)
    .where(eq(creativeGenerationClaims.id, CLAIM_ID));
  console.log(`[Phase5Claim15Correction] Claim ${CLAIM_ID} marked as failed.`);
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error("[Phase5Claim15Correction] FAILED:", err.message);
    process.exit(1);
  });
