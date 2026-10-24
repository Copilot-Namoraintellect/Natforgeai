/**
 * Policy Decision Store (WBS-R5-E3/E7/E8).
 *
 * Durable persistence for immutable policy decisions. The deterministic
 * policyDecisionId + unique decisionScopeKey are the convergence anchors:
 * duplicate submissions and concurrent evaluations of the same action
 * request under the same policy version resolve to exactly one durable row
 * (idempotent replay); any conflicting reuse of the identity fails closed.
 *
 * Volume/spend aggregates feed the E5 authority snapshots with documented
 * semantics: an "action" counts a distinct governed action decision with an
 * executable disposition (ALLOW_AUTONOMOUS | REQUIRE_APPROVAL) in the UTC
 * period; autonomous spend sums derived estimates of ALLOW_AUTONOMOUS
 * decisions in the period. Retries converge to one row, so caps cannot be
 * inflated by replay.
 */

import { eq, and, gte, desc, sql, type SQL } from "drizzle-orm";
import { getDb } from "../../queries/connection";
import { policyDecisions, type PolicyDecisionRow } from "@db/schema";
import type { PolicyDecision } from "./decision-engine";
import type { PolicyDecisionOutcome } from "./policy-types";

type Db = ReturnType<typeof getDb>;

export interface PolicyDecisionStoreExecutor {
  select: Db["select"];
  insert: Db["insert"];
}

export type PolicyDecisionDuplicateClassification = "none" | "idempotent_replay" | "decision_identity_conflict";

export class PolicyDecisionStoreError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "PolicyDecisionStoreError";
    this.code = code;
  }
}

function buildScopeKey(actionRequestId: string, policyVersion: string | null): string {
  return `${actionRequestId}|${policyVersion ?? "NO_POLICY"}`;
}

function toIsoZ(value: string): string {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new PolicyDecisionStoreError("INVALID_DECISION_ROW", `Unparseable evaluatedAt ${value}.`);
  }
  return new Date(ms).toISOString();
}

function isDuplicateKeyError(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  const message = (err as { message?: string })?.message ?? "";
  return code === "ER_DUP_ENTRY" || /Duplicate entry/i.test(message);
}

/** Reconstruct the frozen decision shape from a durable row (read path). */
export function policyDecisionRowToDecision(row: PolicyDecisionRow): PolicyDecision {
  return Object.freeze({
    policyDecisionId: row.policyDecisionId,
    policyId: row.policyId,
    policyVersion: row.policyVersion,
    businessId: Number(row.businessId),
    userId: Number(row.userId),
    actionRequestId: row.actionRequestId,
    sourceSignalId: row.sourceSignalId,
    sourceInterpretationId: row.sourceInterpretationId,
    intelligenceVersion: row.intelligenceVersion,
    actionType: row.actionType,
    platform: row.platform,
    campaignId: row.campaignId === null ? null : Number(row.campaignId),
    decision: row.decision as PolicyDecisionOutcome,
    reasonCodes: Object.freeze(row.reasonCodes as string[]) as PolicyDecision["reasonCodes"],
    riskClass: row.riskClass as PolicyDecision["riskClass"],
    approvalRequired: row.approvalRequired,
    costEligible: row.costEligible,
    rateEligible: row.rateEligible,
    providerEligible: row.providerEligible,
    estimatedCostClass: row.estimatedCostClass as PolicyDecision["estimatedCostClass"],
    estimatedCredits: row.estimatedCredits,
    billingIdentity: row.billingIdentity,
    approvalBinding: (row.approvalBinding as PolicyDecision["approvalBinding"]) ?? null,
    thresholds: Object.freeze((row.thresholds as Record<string, number>) ?? {}),
    expiresAt: row.expiresAt ? new Date(row.expiresAt as unknown as string).toISOString() : null,
    evaluatedAt: row.evaluatedAt,
    evaluationFingerprint: row.evaluationFingerprint,
  });
}

/**
 * Persist a decision. Concurrent/duplicate evaluations of the same action
 * request under the same policy version converge: the unique scope key makes
 * exactly one insert win; losers reread and return the winner
 * (idempotent_replay). A stored row whose fingerprint disagrees with the
 * replayed decision is an identity conflict and fails closed.
 */
export async function recordPolicyDecision(
  decision: PolicyDecision,
  executor: PolicyDecisionStoreExecutor = getDb()
): Promise<{ decision: PolicyDecision; duplicateClassification: PolicyDecisionDuplicateClassification }> {
  if (!decision || typeof decision.policyDecisionId !== "string") {
    throw new PolicyDecisionStoreError("INVALID_DECISION", "A validated PolicyDecision is required.");
  }
  const values = {
    policyDecisionId: decision.policyDecisionId,
    policyId: decision.policyId,
    policyVersion: decision.policyVersion,
    businessId: decision.businessId,
    userId: decision.userId,
    actionRequestId: decision.actionRequestId,
    decisionScopeKey: buildScopeKey(decision.actionRequestId, decision.policyVersion),
    actionType: decision.actionType,
    platform: decision.platform,
    campaignId: decision.campaignId,
    sourceSignalId: decision.sourceSignalId,
    sourceInterpretationId: decision.sourceInterpretationId,
    intelligenceVersion: decision.intelligenceVersion,
    decision: decision.decision,
    reasonCodes: [...decision.reasonCodes],
    riskClass: decision.riskClass,
    approvalRequired: decision.approvalRequired,
    costEligible: decision.costEligible,
    rateEligible: decision.rateEligible,
    providerEligible: decision.providerEligible,
    estimatedCostClass: decision.estimatedCostClass,
    estimatedCredits: decision.estimatedCredits,
    billingIdentity: decision.billingIdentity,
    approvalBinding: decision.approvalBinding,
    thresholds: { ...decision.thresholds },
    expiresAt: decision.expiresAt ? new Date(decision.expiresAt) : null,
    evaluatedAt: toIsoZ(decision.evaluatedAt),
    evaluationFingerprint: decision.evaluationFingerprint,
  };

  try {
    await executor.insert(policyDecisions).values(values);
    return { decision, duplicateClassification: "none" };
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    const existing = await getDecisionByScope(decision.actionRequestId, decision.policyVersion, executor);
    if (!existing) {
      throw new PolicyDecisionStoreError(
        "DECISION_REPLAY_UNRESOLVED",
        "Duplicate key rejected but the durable decision is unreadable; failing closed."
      );
    }
    if (existing.evaluationFingerprint !== decision.evaluationFingerprint) {
      throw new PolicyDecisionStoreError(
        "DECISION_IDENTITY_CONFLICT",
        `DECISION_IDENTITY_CONFLICT: action request ${decision.actionRequestId} was replayed with conflicting decision material under the same policy version.`
      );
    }
    return { decision: existing, duplicateClassification: "idempotent_replay" };
  }
}

export async function getDecisionById(
  policyDecisionId: string,
  executor: PolicyDecisionStoreExecutor = getDb()
): Promise<PolicyDecision | null> {
  const rows = await executor
    .select()
    .from(policyDecisions)
    .where(eq(policyDecisions.policyDecisionId, policyDecisionId))
    .limit(1);
  return rows[0] ? policyDecisionRowToDecision(rows[0]) : null;
}

export async function getDecisionByScope(
  actionRequestId: string,
  policyVersion: string | null,
  executor: PolicyDecisionStoreExecutor = getDb()
): Promise<PolicyDecision | null> {
  const rows = await executor
    .select()
    .from(policyDecisions)
    .where(eq(policyDecisions.decisionScopeKey, buildScopeKey(actionRequestId, policyVersion)))
    .limit(1);
  return rows[0] ? policyDecisionRowToDecision(rows[0]) : null;
}

export interface ListDecisionsFilter {
  businessId: number;
  decision?: PolicyDecisionOutcome;
  limit?: number;
}

export async function listDecisions(
  filter: ListDecisionsFilter,
  executor: PolicyDecisionStoreExecutor = getDb()
): Promise<PolicyDecision[]> {
  const conditions: SQL[] = [eq(policyDecisions.businessId, filter.businessId)];
  if (filter.decision) {
    conditions.push(eq(policyDecisions.decision, filter.decision));
  }
  const rows = await executor
    .select()
    .from(policyDecisions)
    .where(and(...conditions))
    .orderBy(desc(policyDecisions.evaluatedAt))
    .limit(Math.min(filter.limit ?? 100, 500));
  return rows.map(policyDecisionRowToDecision);
}

/**
 * Distinct governed action decisions with an executable disposition in the
 * UTC period (E5 volume authority snapshot).
 */
export async function countExecutableDecisionsSince(
  businessId: number,
  sinceIso: string,
  executor: PolicyDecisionStoreExecutor = getDb()
): Promise<number> {
  const [row] = await executor
    .select({ total: sql<number>`COUNT(*)` })
    .from(policyDecisions)
    .where(
      and(
        eq(policyDecisions.businessId, businessId),
        gte(policyDecisions.evaluatedAt, toIsoZ(sinceIso)),
        sql`${policyDecisions.decision} IN ('ALLOW_AUTONOMOUS','REQUIRE_APPROVAL')`
      )
    );
  return Number(row?.total ?? 0);
}

export async function countChannelDecisionsSince(
  businessId: number,
  platform: string,
  sinceIso: string,
  executor: PolicyDecisionStoreExecutor = getDb()
): Promise<number> {
  const [row] = await executor
    .select({ total: sql<number>`COUNT(*)` })
    .from(policyDecisions)
    .where(
      and(
        eq(policyDecisions.businessId, businessId),
        eq(policyDecisions.platform, platform),
        gte(policyDecisions.evaluatedAt, toIsoZ(sinceIso)),
        sql`${policyDecisions.decision} IN ('ALLOW_AUTONOMOUS','REQUIRE_APPROVAL')`
      )
    );
  return Number(row?.total ?? 0);
}

/** Derived credit estimate of ALLOW_AUTONOMOUS decisions in the UTC period. */
export async function sumAutonomousCreditsSince(
  businessId: number,
  sinceIso: string,
  executor: PolicyDecisionStoreExecutor = getDb()
): Promise<number> {
  const [row] = await executor
    .select({ total: sql<number>`COALESCE(SUM(${policyDecisions.estimatedCredits}), 0)` })
    .from(policyDecisions)
    .where(
      and(
        eq(policyDecisions.businessId, businessId),
        gte(policyDecisions.evaluatedAt, toIsoZ(sinceIso)),
        eq(policyDecisions.decision, "ALLOW_AUTONOMOUS")
      )
    );
  return Number(row?.total ?? 0);
}
