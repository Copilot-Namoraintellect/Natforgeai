// ─── R8-B Business Change Intelligence — upstream new-state seam ───
//
// Loads the newly observed authoritative internal state, server-side only.
// The client names (sourceAuthority, sourceIdentity); every authority field
// is resolved here from durable rows: unknown source, cross-tenant /
// cross-business evidence, and stale/unsupported contract versions all fail
// closed. Loading reuses the upstream authorities' own read paths where they
// exist (R7-C learning store integrity assertion); snapshot tables not
// exposed through a projection surface are read directly with tenant +
// business ownership re-verified (house seam pattern, as R8-A does for DNA /
// strategy snapshots). R8-B never writes any upstream table.
//
// Supported coordinate forms per source:
//   business_dna        bdna_<id> snapshot identity (verbatim snapshotId)
//   strategy_snapshot   ssnap_<id> snapshot identity
//   r7_budget_portfolio psn1:<sha256> explicit snapshot, or the bounded
//                       coordinate "latest" resolved to the newest snapshot
//                       (by capturedAt, then createdAt) for the business
//   r7_learning         lrn1:<sha256> learning identity
//   r7_governance       ogd1:<sha256> governance decision identity

import { and, desc, eq } from "drizzle-orm";
import { businessDnaSnapshots, budgetPortfolioSnapshots, optimisationGovernanceDecisions, strategySnapshots } from "@db/schema";
import {
  BUSINESS_CHANGE_SOURCE_VERSIONS,
  BusinessChangeInputError,
  BusinessChangeOwnershipError,
  type BusinessChangeSourceAuthority,
  type BusinessChangeSubjectType,
} from "./business-change-contract";
import {
  buildAudienceSetStateView,
  buildBudgetEnvelopeStateView,
  buildConstraintStateView,
  buildLearningStateView,
  buildProductSetStateView,
  buildProviderCapabilityStateView,
  buildRiskPostureStateView,
  buildStrategyStateView,
  type ChangeStateView,
} from "./business-change-detection";
import { deriveConfidenceFromLearningConfidence } from "./business-change-significance";
import type { BusinessChangeConfidenceClass } from "./business-change-contract";
import { getLearningByLearningId } from "../business-learning/business-learning-store";
import type { BusinessChangeStoreExecutor } from "./business-change-store";

/** The consumed new-state material for one evaluation (server-loaded only). */
export interface ConsumedChangeState {
  sourceAuthority: Exclude<BusinessChangeSourceAuthority, "operator_attestation">;
  sourceIdentity: string;
  sourceVersion: string;
  subjectType: BusinessChangeSubjectType;
  subjectId: string;
  view: ChangeStateView;
  observedAt: string;
  evidenceRefs: string[];
  confidenceClass: BusinessChangeConfidenceClass;
  /** Upstream row is terminal-negative (e.g. contradicted learning). */
  upstreamTerminalNegative: boolean;
}

const DNA_SNAPSHOT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_\-]{1,127}$/;
const STRATEGY_SNAPSHOT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_\-]{1,127}$/;
const SNAPSHOT_ID_PATTERN = /^psn1:[a-f0-9]{64}$/;
const LEARNING_ID_PATTERN = /^lrn1:[a-f0-9]{64}$/;
const GOVERNANCE_ID_PATTERN = /^ogd1[:_][A-Za-z0-9]{1,64}$/;

function assertOwnership(rowUserId: number, rowBusinessId: number, userId: number, businessId: number, what: string): void {
  if (rowUserId !== userId) {
    throw new BusinessChangeOwnershipError("CHANGE_CROSS_TENANT_SOURCE", `${what} belongs to a different tenant.`);
  }
  if (rowBusinessId !== businessId) {
    throw new BusinessChangeOwnershipError(
      "CHANGE_CROSS_BUSINESS_SOURCE",
      `${what} belongs to business ${rowBusinessId}, not ${businessId}. Cross-business evidence is rejected.`
    );
  }
}

function toIsoString(value: string | Date): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? value : new Date(parsed).toISOString();
}

// ─── business_dna (PRODUCT_SET / AUDIENCE_SET) ───

async function loadDnaState(
  userId: number,
  businessId: number,
  subjectType: BusinessChangeSubjectType,
  sourceIdentity: string,
  db: BusinessChangeStoreExecutor
): Promise<ConsumedChangeState> {
  if (!DNA_SNAPSHOT_ID_PATTERN.test(sourceIdentity)) {
    throw new BusinessChangeInputError("CHANGE_SOURCE_UNKNOWN", `sourceIdentity ${sourceIdentity} is not a business DNA snapshot id.`);
  }
  const [row] = (await db
    .select()
    .from(businessDnaSnapshots)
    .where(eq(businessDnaSnapshots.snapshotId, sourceIdentity))
    .limit(1)) as unknown as Array<Record<string, unknown>>;
  if (!row) {
    throw new BusinessChangeInputError("CHANGE_SOURCE_UNKNOWN", `business DNA snapshot ${sourceIdentity} not found.`);
  }
  assertOwnership(Number(row.userId), Number(row.businessId), userId, businessId, `Business DNA snapshot ${sourceIdentity}`);
  const payload = (row.snapshot ?? {}) as Record<string, unknown>;
  const view =
    subjectType === "AUDIENCE_SET"
      ? buildAudienceSetStateView({ targetCustomerSegments: payload.targetCustomerSegments })
      : buildProductSetStateView({
          primaryOffering: row.primaryOffering ?? payload.primaryOffering,
          productsAndServices: payload.productsAndServices,
        });
  const capturedAt = toIsoString(row.capturedAt as string | Date);
  return {
    sourceAuthority: "business_dna",
    sourceIdentity,
    sourceVersion: BUSINESS_CHANGE_SOURCE_VERSIONS.business_dna,
    subjectType,
    subjectId: subjectType === "AUDIENCE_SET" ? `audience-set:business:${businessId}` : `product-set:business:${businessId}`,
    view,
    observedAt: capturedAt,
    evidenceRefs: [String(row.snapshotId)],
    confidenceClass: "AUTHORITATIVE",
    upstreamTerminalNegative: false,
  };
}

// ─── strategy_snapshot (STRATEGY) ───

async function loadStrategyState(
  userId: number,
  businessId: number,
  subjectType: BusinessChangeSubjectType,
  sourceIdentity: string,
  db: BusinessChangeStoreExecutor
): Promise<ConsumedChangeState> {
  if (!STRATEGY_SNAPSHOT_ID_PATTERN.test(sourceIdentity)) {
    throw new BusinessChangeInputError("CHANGE_SOURCE_UNKNOWN", `sourceIdentity ${sourceIdentity} is not a strategy snapshot id.`);
  }
  const [row] = (await db
    .select()
    .from(strategySnapshots)
    .where(eq(strategySnapshots.snapshotId, sourceIdentity))
    .limit(1)) as unknown as Array<Record<string, unknown>>;
  if (!row) {
    throw new BusinessChangeInputError("CHANGE_SOURCE_UNKNOWN", `strategy snapshot ${sourceIdentity} not found.`);
  }
  assertOwnership(Number(row.userId), Number(row.businessId), userId, businessId, `Strategy snapshot ${sourceIdentity}`);
  const capturedAt = toIsoString(row.capturedAt as string | Date);
  return {
    sourceAuthority: "strategy_snapshot",
    sourceIdentity,
    sourceVersion: BUSINESS_CHANGE_SOURCE_VERSIONS.strategy_snapshot,
    subjectType,
    subjectId: `strategy:campaign:${Number(row.campaignId)}`,
    view: buildStrategyStateView({ strategyHashSha256: row.strategyHashSha256 }),
    observedAt: capturedAt,
    evidenceRefs: [String(row.snapshotId), `campaign:${Number(row.campaignId)}`],
    confidenceClass: "AUTHORITATIVE",
    upstreamTerminalNegative: false,
  };
}

// ─── r7_budget_portfolio (BUDGET_ENVELOPE / PROVIDER_CAPABILITY) ───

async function loadBudgetPortfolioState(
  userId: number,
  businessId: number,
  subjectType: BusinessChangeSubjectType,
  sourceIdentity: string,
  db: BusinessChangeStoreExecutor
): Promise<ConsumedChangeState> {
  let row: Record<string, unknown> | undefined;
  let resolvedIdentity = sourceIdentity;
  if (sourceIdentity === "latest") {
    const [latest] = (await db
      .select()
      .from(budgetPortfolioSnapshots)
      .where(and(eq(budgetPortfolioSnapshots.userId, userId), eq(budgetPortfolioSnapshots.businessId, businessId)))
      .orderBy(desc(budgetPortfolioSnapshots.capturedAt), desc(budgetPortfolioSnapshots.id))
      .limit(1)) as unknown as Array<Record<string, unknown>>;
    if (!latest) {
      throw new BusinessChangeInputError("CHANGE_SOURCE_UNKNOWN", `no budget portfolio snapshot exists for business ${businessId}.`);
    }
    row = latest;
    resolvedIdentity = String(latest.portfolioSnapshotId);
  } else {
    if (!SNAPSHOT_ID_PATTERN.test(sourceIdentity)) {
      throw new BusinessChangeInputError("CHANGE_SOURCE_UNKNOWN", `sourceIdentity ${sourceIdentity} is not a psn1: portfolio snapshot identity.`);
    }
    const [exact] = (await db
      .select()
      .from(budgetPortfolioSnapshots)
      .where(eq(budgetPortfolioSnapshots.portfolioSnapshotId, sourceIdentity))
      .limit(1)) as unknown as Array<Record<string, unknown>>;
    if (!exact) {
      throw new BusinessChangeInputError("CHANGE_SOURCE_UNKNOWN", `portfolio snapshot ${sourceIdentity} not found.`);
    }
    assertOwnership(Number(exact.userId), Number(exact.businessId), userId, businessId, `Portfolio snapshot ${sourceIdentity}`);
    row = exact;
  }
  const view =
    subjectType === "PROVIDER_CAPABILITY"
      ? buildProviderCapabilityStateView({ supportedProviders: row.supportedProviders })
      : buildBudgetEnvelopeStateView({ approvedTotalBudgetMinor: row.approvedTotalBudgetMinor, currency: row.currency });
  const capturedAt = toIsoString(row.capturedAt as string | Date);
  return {
    sourceAuthority: "r7_budget_portfolio",
    sourceIdentity: resolvedIdentity,
    sourceVersion: BUSINESS_CHANGE_SOURCE_VERSIONS.r7_budget_portfolio,
    subjectType,
    subjectId: subjectType === "PROVIDER_CAPABILITY" ? `provider-set:business:${businessId}` : `budget-envelope:business:${businessId}`,
    view,
    observedAt: capturedAt,
    evidenceRefs: [String(row.portfolioSnapshotId)],
    confidenceClass: "VERIFIED",
    upstreamTerminalNegative: false,
  };
}

// ─── r7_learning (LEARNING) ───

async function loadLearningState(
  userId: number,
  businessId: number,
  subjectType: BusinessChangeSubjectType,
  sourceIdentity: string,
  db: BusinessChangeStoreExecutor
): Promise<ConsumedChangeState> {
  if (!LEARNING_ID_PATTERN.test(sourceIdentity)) {
    throw new BusinessChangeInputError("CHANGE_SOURCE_UNKNOWN", `sourceIdentity ${sourceIdentity} is not an lrn1: learning identity.`);
  }
  const row = await getLearningByLearningId(userId, sourceIdentity, db as never);
  if (!row) {
    throw new BusinessChangeInputError("CHANGE_SOURCE_UNKNOWN", `learning ${sourceIdentity} not found for the authenticated tenant.`);
  }
  assertOwnership(Number(row.userId), Number(row.businessId), userId, businessId, `Learning ${sourceIdentity}`);
  return {
    sourceAuthority: "r7_learning",
    sourceIdentity,
    sourceVersion: BUSINESS_CHANGE_SOURCE_VERSIONS.r7_learning,
    subjectType,
    // The learning subject coordinate is the row's own subject anchor
    // (e.g. learning:campaign:500) — the change binds to the pattern family,
    // not to one lrn1: row identity.
    subjectId: `learning:${row.subjectId}`,
    view: buildLearningStateView({
      status: row.status,
      contradictionCount: row.contradictionCount,
      confidenceClass: row.confidenceClass,
      upstreamStateFingerprint: row.upstreamStateFingerprint,
    }),
    observedAt: row.derivedAt,
    evidenceRefs: [row.learningId],
    confidenceClass: deriveConfidenceFromLearningConfidence(row.confidenceClass),
    upstreamTerminalNegative: row.status === "CONTRADICTED",
  };
}

// ─── r7_governance (CONSTRAINT / RISK_POSTURE) ───

async function loadGovernanceState(
  userId: number,
  businessId: number,
  subjectType: BusinessChangeSubjectType,
  sourceIdentity: string,
  db: BusinessChangeStoreExecutor
): Promise<ConsumedChangeState> {
  if (!GOVERNANCE_ID_PATTERN.test(sourceIdentity)) {
    throw new BusinessChangeInputError("CHANGE_SOURCE_UNKNOWN", `sourceIdentity ${sourceIdentity} is not an ogd1: governance decision identity.`);
  }
  const [row] = (await db
    .select()
    .from(optimisationGovernanceDecisions)
    .where(eq(optimisationGovernanceDecisions.governanceDecisionId, sourceIdentity))
    .limit(1)) as unknown as Array<Record<string, unknown>>;
  if (!row) {
    throw new BusinessChangeInputError("CHANGE_SOURCE_UNKNOWN", `governance decision ${sourceIdentity} not found.`);
  }
  assertOwnership(Number(row.userId), Number(row.businessId), userId, businessId, `Governance decision ${sourceIdentity}`);
  if (row.contractVersion !== BUSINESS_CHANGE_SOURCE_VERSIONS.r7_governance) {
    throw new BusinessChangeInputError(
      "CHANGE_SOURCE_VERSION_UNSUPPORTED",
      `governance decision contract version ${String(row.contractVersion)} is not the frozen ${BUSINESS_CHANGE_SOURCE_VERSIONS.r7_governance}.`
    );
  }
  const view =
    subjectType === "RISK_POSTURE"
      ? buildRiskPostureStateView({ riskClass: row.riskClass })
      : buildConstraintStateView({ decision: row.decision, policyVersion: row.policyVersion });
  return {
    sourceAuthority: "r7_governance",
    sourceIdentity,
    sourceVersion: BUSINESS_CHANGE_SOURCE_VERSIONS.r7_governance,
    subjectType,
    subjectId: subjectType === "RISK_POSTURE" ? `risk-posture:business:${businessId}` : `constraint:${sourceIdentity}`,
    view,
    observedAt: String(row.evaluatedAt),
    evidenceRefs: [String(row.governanceDecisionId)],
    confidenceClass: "VERIFIED",
    upstreamTerminalNegative: false,
  };
}

// ─── dispatch ───

/**
 * Load and validate the authoritative new state for one evaluation.
 * Fail-closed on unknown source, cross-tenant/cross-business evidence and
 * stale contract versions. Never writes upstream.
 */
export async function loadNewChangeState(
  userId: number,
  businessId: number,
  subjectType: BusinessChangeSubjectType,
  sourceAuthority: BusinessChangeSourceAuthority,
  sourceIdentity: string,
  db: BusinessChangeStoreExecutor
): Promise<ConsumedChangeState> {
  switch (sourceAuthority) {
    case "business_dna":
      return loadDnaState(userId, businessId, subjectType, sourceIdentity, db);
    case "strategy_snapshot":
      return loadStrategyState(userId, businessId, subjectType, sourceIdentity, db);
    case "r7_budget_portfolio":
      return loadBudgetPortfolioState(userId, businessId, subjectType, sourceIdentity, db);
    case "r7_learning":
      return loadLearningState(userId, businessId, subjectType, sourceIdentity, db);
    case "r7_governance":
      return loadGovernanceState(userId, businessId, subjectType, sourceIdentity, db);
    default:
      throw new BusinessChangeInputError(
        "CHANGE_SOURCE_UNKNOWN",
        `sourceAuthority ${String(sourceAuthority)} cannot supply change state.`
      );
  }
}

/**
 * Resolve the previous-state pointer: given the memory-bound source
 * authority + identity, load the durable upstream row it references and build
 * the same closed state view. Upstream rows are immutable by house
 * convention; a vanished row is a fail-closed comparison failure, never a
 * fabricated state.
 */
export async function loadPreviousChangeState(
  userId: number,
  businessId: number,
  subjectType: BusinessChangeSubjectType,
  memorySourceAuthority: string,
  memorySourceIdentity: string,
  db: BusinessChangeStoreExecutor
): Promise<ConsumedChangeState> {
  const authority = memorySourceAuthority as BusinessChangeSourceAuthority;
  if (authority === "operator_attestation") {
    throw new BusinessChangeInputError(
      "CHANGE_COMPARISON_STATE_MISSING",
      "Operator-attested memory has no upstream pointer row; the previous state must be built from the memory statement."
    );
  }
  return loadNewChangeState(userId, businessId, subjectType, authority, memorySourceIdentity, db);
}
