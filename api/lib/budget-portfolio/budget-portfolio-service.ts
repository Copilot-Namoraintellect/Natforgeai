// ─── R7-E Budget & Portfolio Optimisation — service authority (E7) ───
//
// Orchestrates the full target flow: server-assembled portfolio snapshot →
// deterministic evidence scoring → bounded solve → stability controls →
// R7-F governance evaluation (through the frozen seam; NEVER re-derived,
// never modified) → exactly-once proposal persistence → explainable
// proposal / read-only authorised instruction / read-only strategy handoff.
//
// This stream emits optimisation instructions only. It never executes
// billing, payments, provider spend, campaign mutation or strategy mutation.
// Exactly one audit event per durable effect; convergence paths emit zero.

import {
  BUDGET_PORTFOLIO_ALGORITHM_VERSION,
  BUDGET_PORTFOLIO_CONSTRAINT_VERSION,
  BUDGET_PORTFOLIO_CONTRACT_VERSION,
  BudgetPortfolioError,
  BudgetPortfolioOwnershipError,
  BudgetPortfolioValidationError,
  sha256Hex,
  campaignIdFromAllocationKey,
  deriveEvidenceBundleHash,
  deriveOptimisationId,
  deriveProposalContentHash,
  type OptimisationObjective,
  type OptimisationProposalStatus,
  type OptimisationReasonCode,
} from "./budget-portfolio-contract";
import {
  assertSnapshotFresh,
  buildPortfolioSnapshot,
  validatePortfolioAuthorityMaterial,
  type PortfolioSnapshot,
} from "./portfolio-snapshot";
import {
  evaluateEvidence,
  type EvidenceAttributionProjection,
  type EvidenceBundle,
  type EvidenceLearningProjection,
  type EvidenceOutcomeProjection,
} from "./evidence-model";
import { assertBudgetInvariants, DEFAULT_OPTIMISATION_CONSTRAINTS, solvePortfolioAllocation } from "./allocation-solver";
import {
  applyStabilityHold,
  evaluateStability,
  type StabilityState,
} from "./stability-controls";
import {
  R7F_DEFAULT_POLICY,
  deriveR7FProposalFingerprint,
  normaliseGovernanceFinancialForFingerprint,
  validateGovernanceDecisionView,
  type GovernanceDecisionView,
  type OptimisationGovernancePort,
} from "./governance-seam";
import {
  findInstructionByOptimisationRow,
  findInstructionRow,
  findProposalRow,
  findSnapshotRow,
  insertInstruction,
  insertProposal,
  insertSnapshot,
  listProposalRows,
  listSnapshotRows,
  updateProposalStatus,
  type BudgetPortfolioInstructionRow,
  type BudgetPortfolioProposalRow,
  type BudgetPortfolioSnapshotRow,
  type BudgetPortfolioStoreExecutor,
} from "./budget-portfolio-store";
import { createAuditEvent } from "../audit/audit-event";
import { persistAuditEvent, type AuditDbExecutor } from "../audit/audit-store";

// ─── Injected provider seams (untrusted until re-validated at the boundary) ───

/** Server-side portfolio authority source (canonical campaigns/business rows). */
export interface PortfolioAuthorityProviderPort {
  /** Raw authority material for one business; throws/returns null business when absent. */
  getPortfolioAuthorityMaterial(businessId: number): Promise<unknown>;
}

export class PortfolioAuthorityBusinessNotFound extends Error {
  readonly kind = "business_not_found" as const;
  constructor(businessId: number) {
    super(`business not found: ${businessId}`);
    this.name = "PortfolioAuthorityBusinessNotFound";
  }
}

/** Read-only evidence source (R7-A/B/C projections at R7-X; fails closed until then). */
export interface BudgetPortfolioEvidenceProviderPort {
  getEvidenceBundle(input: {
    businessId: number;
    outcomeRefs?: readonly string[];
    attributionRefs?: readonly string[];
    learningRefs?: readonly string[];
  }): Promise<unknown>;
}

export interface BudgetPortfolioDeps {
  readonly authorityProvider: PortfolioAuthorityProviderPort;
  readonly evidenceProvider: BudgetPortfolioEvidenceProviderPort;
  readonly governance: OptimisationGovernancePort;
  /** Injected clock for determinism; defaults to wall time. */
  readonly now?: () => Date;
}

function resolveNow(deps: BudgetPortfolioDeps): Date {
  return deps.now ? deps.now() : new Date();
}

function asAuditExecutor(executor: BudgetPortfolioStoreExecutor): AuditDbExecutor {
  return executor as unknown as AuditDbExecutor;
}

function isoOf(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

// ─── Snapshot row ↔ snapshot view ───

export function snapshotFromRow(row: BudgetPortfolioSnapshotRow): PortfolioSnapshot {
  return Object.freeze({
    portfolioSnapshotId: row.portfolioSnapshotId,
    userId: Number(row.userId),
    businessId: Number(row.businessId),
    budgetPeriod: row.budgetPeriod,
    currency: row.currency,
    approvedTotalBudgetMinor: Number(row.approvedTotalBudgetMinor),
    committedMinor: Number(row.committedMinor),
    reservedMinor: Number(row.reservedMinor),
    availableReallocatableMinor: Number(row.availableReallocatableMinor),
    currentAllocations: Object.freeze(
      ((row.currentAllocations as { allocationKey: string; campaignId: number; provider: string | null; amountMinor: number }[]) ?? []).map(
        (e) => Object.freeze({ ...e, amountMinor: Number(e.amountMinor) })
      )
    ),
    supportedProviders: Object.freeze([...(row.supportedProviders as string[])]),
    lockedAllocationKeys: Object.freeze([...(row.lockedAllocationKeys as string[])]),
    disabledAllocationKeys: Object.freeze([...(row.disabledAllocationKeys as string[])]),
    capturedAt: row.capturedAt,
  });
}

function snapshotToRow(snapshot: PortfolioSnapshot, createdAt: string): BudgetPortfolioSnapshotRow {
  return {
    portfolioSnapshotId: snapshot.portfolioSnapshotId,
    userId: snapshot.userId,
    businessId: snapshot.businessId,
    budgetPeriod: snapshot.budgetPeriod,
    currency: snapshot.currency,
    approvedTotalBudgetMinor: snapshot.approvedTotalBudgetMinor,
    committedMinor: snapshot.committedMinor,
    reservedMinor: snapshot.reservedMinor,
    availableReallocatableMinor: snapshot.availableReallocatableMinor,
    currentAllocations: snapshot.currentAllocations.map((e) => ({ ...e })),
    supportedProviders: [...snapshot.supportedProviders],
    lockedAllocationKeys: [...snapshot.lockedAllocationKeys],
    disabledAllocationKeys: [...snapshot.disabledAllocationKeys],
    capturedAt: snapshot.capturedAt,
    createdAt,
  };
}

// ─── Evidence bundle boundary validation ───

export function parseEvidenceBundle(raw: unknown): EvidenceBundle {
  function fail(message: string): never {
    throw new BudgetPortfolioValidationError("EVIDENCE_VALIDATION_FAILED", `evidence bundle failed validation: ${message}`);
  }
  if (typeof raw !== "object" || raw === null) fail("bundle must be an object");
  const r = raw as Record<string, unknown>;
  const outcomes: EvidenceOutcomeProjection[] = [];
  const attributions: EvidenceAttributionProjection[] = [];
  const learnings: EvidenceLearningProjection[] = [];

  if (!Array.isArray(r.outcomes)) fail("outcomes must be an array");
  for (const o of r.outcomes) {
    const row = o as Record<string, unknown>;
    if (typeof row.outcomeId !== "string" || typeof row.businessId !== "number") fail("outcome shape invalid");
    if (typeof row.outcomeStatus !== "string" || typeof row.occurredAt !== "string") fail("outcome shape invalid");
    if (row.valueType !== "MONETARY" && row.valueType !== "NON_MONETARY") fail("outcome valueType invalid");
    outcomes.push({
      outcomeId: row.outcomeId,
      businessId: row.businessId,
      outcomeStatus: row.outcomeStatus,
      valueType: row.valueType,
      amountMinor: typeof row.amountMinor === "number" && row.amountMinor !== null ? row.amountMinor : null,
      occurredAt: row.occurredAt,
    });
  }
  if (!Array.isArray(r.attributions)) fail("attributions must be an array");
  for (const a of r.attributions) {
    const row = a as Record<string, unknown>;
    if (typeof row.attributionId !== "string" || typeof row.businessId !== "number") fail("attribution shape invalid");
    if (typeof row.outcomeId !== "string" || typeof row.outcomeStatus !== "string") fail("attribution shape invalid");
    if (typeof row.confidenceClass !== "string" || typeof row.evidenceClass !== "string") fail("attribution shape invalid");
    if (!Array.isArray(row.touchpoints)) fail("attribution touchpoints must be an array");
    const touchpoints = (row.touchpoints as Record<string, unknown>[]).map((t) => {
      if (typeof t.type !== "string" || typeof t.sourceIdentity !== "string") fail("touchpoint shape invalid");
      const creditBps = Number(t.creditBps);
      if (!Number.isInteger(creditBps) || creditBps < 0) fail("touchpoint creditBps invalid");
      return { type: t.type, sourceIdentity: t.sourceIdentity, creditBps };
    });
    attributions.push({
      attributionId: row.attributionId,
      businessId: row.businessId,
      outcomeId: row.outcomeId,
      outcomeStatus: row.outcomeStatus,
      confidenceClass: row.confidenceClass,
      evidenceClass: row.evidenceClass,
      touchpoints: Object.freeze(touchpoints),
    });
  }
  if (!Array.isArray(r.learnings)) fail("learnings must be an array");
  for (const l of r.learnings) {
    const row = l as Record<string, unknown>;
    if (typeof row.learningId !== "string" || typeof row.businessId !== "number") fail("learning shape invalid");
    if (typeof row.subjectType !== "string" || typeof row.subjectId !== "string") fail("learning shape invalid");
    if (typeof row.status !== "string" || typeof row.confidenceClass !== "string") fail("learning shape invalid");
    const supportCount = Number(row.supportCount);
    const contradictionCount = Number(row.contradictionCount);
    const freshness = row.freshness as Record<string, unknown> | undefined;
    learnings.push({
      learningId: row.learningId,
      businessId: row.businessId,
      subjectType: row.subjectType,
      subjectId: row.subjectId,
      status: row.status,
      confidenceClass: row.confidenceClass,
      supportCount: Number.isInteger(supportCount) ? supportCount : 0,
      contradictionCount: Number.isInteger(contradictionCount) ? contradictionCount : 0,
      freshness: Object.freeze({
        stale: freshness?.stale === true,
        contradictionUnresolved: freshness?.contradictionUnresolved === true,
      }),
      derivedAt: typeof row.derivedAt === "string" ? row.derivedAt : isoOf(row.derivedAt),
    });
  }
  return {
    outcomes: Object.freeze(outcomes),
    attributions: Object.freeze(attributions),
    learnings: Object.freeze(learnings),
  };
}

// ─── Proposal material ↔ governance proposal (E6 mapping) ───

export interface ProposalAllocationView {
  readonly allocationKey: string;
  readonly campaignId: number | null;
  readonly provider: string | null;
  readonly amountMinor: number;
}

function buildGovernanceProposalMaterial(input: {
  optimisationId: string;
  businessId: number;
  currency: string;
  snapshot: PortfolioSnapshot;
  deltaByKey: Readonly<Record<string, number>>;
  proposedByKey: Readonly<Record<string, number>>;
  evidenceBundleHash: string;
  learningReference: { learningVersion: string; computedAt: string } | null;
  requestedAt: string;
}): Record<string, unknown> {
  const providerByKey = new Map(input.snapshot.currentAllocations.map((e) => [e.allocationKey, e.provider]));
  const deltas = Object.entries(input.deltaByKey)
    .filter(([, delta]) => delta !== 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([allocationKey, deltaMinor]) => ({
      allocationKey,
      campaignId: campaignIdFromAllocationKey(allocationKey),
      provider: providerByKey.get(allocationKey) ?? null,
      deltaMinor,
    }));
  return {
    proposalId: input.optimisationId,
    businessId: input.businessId,
    proposalType: "BUDGET_REALLOCATE",
    campaignId: null,
    financial: {
      currency: input.currency,
      allocationDeltas: deltas,
    },
    experiment: null,
    portfolio: { resultingAllocations: { ...input.proposedByKey } },
    learningReference: input.learningReference,
    evidenceHash: input.evidenceBundleHash,
    requestedAt: input.requestedAt,
  };
}

// ─── Public views ───

export interface PortfolioSnapshotView {
  readonly snapshot: PortfolioSnapshot;
  readonly duplicateClassification: "none" | "idempotent_replay";
}

export interface OptimisationProposalView {
  readonly proposal: BudgetPortfolioProposalRow;
  readonly governanceDecision: GovernanceDecisionView | null;
  readonly duplicateClassification: "none" | "idempotent_replay";
}

// ─── createPortfolioSnapshot ───

export async function createPortfolioSnapshot(
  input: { userId: number; businessId: number },
  deps: BudgetPortfolioDeps,
  executor: BudgetPortfolioStoreExecutor
): Promise<PortfolioSnapshotView> {
  const now = resolveNow(deps).toISOString();
  let raw: unknown;
  try {
    raw = await deps.authorityProvider.getPortfolioAuthorityMaterial(input.businessId);
  } catch (err) {
    if (err instanceof PortfolioAuthorityBusinessNotFound) {
      throw new BudgetPortfolioOwnershipError(
        "OWNERSHIP_MISMATCH",
        `business ${input.businessId} not found for this tenant`
      );
    }
    throw err;
  }
  const material = validatePortfolioAuthorityMaterial(raw, input.userId, input.businessId);
  const snapshot = buildPortfolioSnapshot(material, now);
  const row = snapshotToRow(snapshot, now);
  const write = await insertSnapshot(row, executor);
  if (write.inserted) {
    const event = createAuditEvent({
      eventType: "portfolio_snapshot_created",
      source: "system",
      outcome: "succeeded",
      occurredAt: now,
      userId: input.userId,
      businessId: input.businessId,
      metadata: {
        portfolioSnapshotId: snapshot.portfolioSnapshotId,
        businessId: snapshot.businessId,
        budgetPeriod: snapshot.budgetPeriod,
        approvedTotalBudgetMinor: snapshot.approvedTotalBudgetMinor,
        committedMinor: snapshot.committedMinor,
        reservedMinor: snapshot.reservedMinor,
        allocationKeys: snapshot.currentAllocations.length,
        contractVersion: BUDGET_PORTFOLIO_CONTRACT_VERSION,
      },
    });
    await persistAuditEvent(event, asAuditExecutor(executor));
  }
  return { snapshot, duplicateClassification: write.duplicateClassification };
}

// ─── Stability memory from prior AUTHORIZED instructions ───

async function loadStabilityState(
  userId: number,
  businessId: number,
  executor: BudgetPortfolioStoreExecutor
): Promise<StabilityState> {
  const authorised = await listProposalRows(userId, businessId, "AUTHORIZED", 1, executor);
  if (authorised.length === 0) {
    return { lastReallocationAtByKey: Object.freeze({}), previousDeltaByKey: Object.freeze({}) };
  }
  const latest = authorised[0];
  const instruction = await findInstructionByOptimisationRow(userId, latest.optimisationId, executor);
  const lastReallocationAtByKey: Record<string, string> = {};
  if (instruction) {
    for (const entry of instruction.allocations as { allocationKey: string }[]) {
      lastReallocationAtByKey[entry.allocationKey] = isoOf(instruction.authorisedAt);
    }
  }
  const previousDeltaByKey: Record<string, number> = {};
  for (const entry of latest.deltaAllocations as { allocationKey: string; deltaMinor: number }[]) {
    previousDeltaByKey[entry.allocationKey] = Number(entry.deltaMinor);
  }
  return {
    lastReallocationAtByKey: Object.freeze(lastReallocationAtByKey),
    previousDeltaByKey: Object.freeze(previousDeltaByKey),
  };
}

// ─── proposeOptimisation ───

export async function proposeOptimisation(
  input: {
    userId: number;
    businessId: number;
    portfolioSnapshotId?: string;
    objective?: OptimisationObjective;
    evidenceRefs?: {
      outcomeRefs?: readonly string[];
      attributionRefs?: readonly string[];
      learningRefs?: readonly string[];
    };
  },
  deps: BudgetPortfolioDeps,
  executor: BudgetPortfolioStoreExecutor
): Promise<OptimisationProposalView> {
  const now = resolveNow(deps).toISOString();
  const objective: OptimisationObjective = input.objective ?? "MAXIMISE_EVIDENCE_WEIGHTED_VALUE";
  const staleHorizonMs = R7F_DEFAULT_POLICY.financial.staleBudgetStateMs;

  // 1. Resolve the snapshot (fresh by construction, or the durable row).
  let snapshot: PortfolioSnapshot;
  if (input.portfolioSnapshotId !== undefined) {
    const row = await findSnapshotRow(input.userId, input.portfolioSnapshotId, executor);
    if (!row) {
      throw new BudgetPortfolioValidationError("SNAPSHOT_NOT_FOUND", `snapshot ${input.portfolioSnapshotId} not found`);
    }
    snapshot = snapshotFromRow(row);
    assertSnapshotFresh(snapshot, now, staleHorizonMs);
  } else {
    const created = await createPortfolioSnapshot(
      { userId: input.userId, businessId: input.businessId },
      deps,
      executor
    );
    snapshot = created.snapshot;
  }

  // 2. Resolve the evidence bundle (read-only upstream projections).
  const outcomeRefs = input.evidenceRefs?.outcomeRefs ?? [];
  const attributionRefs = input.evidenceRefs?.attributionRefs ?? [];
  const learningRefs = input.evidenceRefs?.learningRefs ?? [];
  const evidenceBundleHash = deriveEvidenceBundleHash({ outcomeRefs, attributionRefs, learningRefs });

  const rawBundle = await deps.evidenceProvider.getEvidenceBundle({
    businessId: input.businessId,
    outcomeRefs,
    attributionRefs,
    learningRefs,
  });
  const bundle = parseEvidenceBundle(rawBundle);
  const evidence = evaluateEvidence({
    businessId: input.businessId,
    bundle,
    allocatableKeys: snapshot.currentAllocations.map((e) => e.allocationKey),
    now,
  });

  // 3. Solve + stabilise.
  const solved = solvePortfolioAllocation({ snapshot, evidence, objective });
  const stability = evaluateStability({
    solved,
    state: await loadStabilityState(input.userId, input.businessId, executor),
    currentByKey: Object.fromEntries(snapshot.currentAllocations.map((e) => [e.allocationKey, e.amountMinor])),
    now,
  });
  const finalSolved = applyStabilityHold(solved, stability);

  // 4. Materialise the proposal record.
  const currentAllocations: ProposalAllocationView[] = snapshot.currentAllocations.map((e) => ({
    allocationKey: e.allocationKey,
    campaignId: e.campaignId,
    provider: e.provider,
    amountMinor: e.amountMinor,
  }));
  const proposedAllocations: ProposalAllocationView[] = snapshot.currentAllocations.map((e) => ({
    allocationKey: e.allocationKey,
    campaignId: e.campaignId,
    provider: e.provider,
    amountMinor: finalSolved.proposedByKey[e.allocationKey] ?? e.amountMinor,
  }));
  const deltaAllocations = Object.entries(finalSolved.deltaByKey)
    .filter(([, d]) => d !== 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([allocationKey, deltaMinor]) => ({ allocationKey, deltaMinor }));

  if (finalSolved.changed) {
    assertBudgetInvariants({
      snapshot,
      proposedByKey: Object.fromEntries(proposedAllocations.map((e) => [e.allocationKey, e.amountMinor])),
    });
  }

  const reasonCodes: OptimisationReasonCode[] = [
    ...evidence.reasonCodes,
    ...finalSolved.reasonCodes,
    ...stability.reasonCodes,
  ];
  const currentTotalBudgetMinor = currentAllocations.reduce((s, e) => s + e.amountMinor, 0);
  const evidenceRefsAll = [...outcomeRefs, ...attributionRefs, ...learningRefs].sort();

  const optimisationId = deriveOptimisationId({
    userId: input.userId,
    businessId: input.businessId,
    portfolioSnapshotId: snapshot.portfolioSnapshotId,
    objective,
    algorithmVersion: BUDGET_PORTFOLIO_ALGORITHM_VERSION,
    constraintVersion: BUDGET_PORTFOLIO_CONSTRAINT_VERSION,
    evidenceBundleHash,
  });

  let status: OptimisationProposalStatus;
  let governanceDecisionId: string | null = null;
  let governanceDecision: GovernanceDecisionView | null = null;
  let approvalRequired = false;
  let validUntil: string | null = null;

  if (!finalSolved.changed) {
    status = "NO_CHANGE";
  } else {
    const strongestLearning =
      bundle.learnings.length > 0
        ? {
            learningVersion: "business-learning-to-experiment-optimisation/v1",
            computedAt: now,
          }
        : null;
    const material = buildGovernanceProposalMaterial({
      optimisationId,
      businessId: input.businessId,
      currency: snapshot.currency,
      snapshot,
      deltaByKey: finalSolved.deltaByKey,
      proposedByKey: finalSolved.proposedByKey,
      evidenceBundleHash,
      learningReference: strongestLearning,
      requestedAt: now,
    });
    let rawDecision: unknown;
    try {
      rawDecision = (await deps.governance.evaluateProposal({ userId: input.userId, proposal: material })).decision;
    } catch (err) {
      if (err instanceof BudgetPortfolioError) throw err;
      throw new BudgetPortfolioError(
        "GOVERNANCE_UNAVAILABLE",
        `governance evaluation failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    governanceDecision = validateGovernanceDecisionView(rawDecision);
    governanceDecisionId = governanceDecision.governanceDecisionId;
    approvalRequired = governanceDecision.approvalRequired;
    validUntil = governanceDecision.validUntil;
    if (governanceDecision.decision === "ALLOW") {
      status = "ALLOWED";
      reasonCodes.push("GOVERNANCE_ALLOWED");
    } else if (governanceDecision.decision === "REVIEW_REQUIRED") {
      status = "REVIEW_REQUIRED";
      reasonCodes.push("GOVERNANCE_REVIEW_REQUIRED");
    } else {
      status = "BLOCKED";
      reasonCodes.push("GOVERNANCE_BLOCKED");
    }
  }

  const dedupedReasons = [...new Set(reasonCodes)].slice(0, 8) as OptimisationReasonCode[];
  const contentHash = deriveProposalContentHash({
    optimisationId,
    currentAllocations,
    proposedAllocations,
    deltaAllocations,
    confidenceClass: evidence.confidenceClass,
    reasonCodes: dedupedReasons,
  });

  const row: BudgetPortfolioProposalRow = {
    optimisationId,
    userId: input.userId,
    businessId: input.businessId,
    portfolioSnapshotId: snapshot.portfolioSnapshotId,
    budgetPeriod: snapshot.budgetPeriod,
    currency: snapshot.currency,
    currentTotalBudgetMinor,
    currentAllocations,
    proposedAllocations,
    deltaAllocations,
    evidenceRefs: evidenceRefsAll,
    learningRefs: [...learningRefs].sort(),
    attributionRefs: [...attributionRefs].sort(),
    outcomeRefs: [...outcomeRefs].sort(),
    objective,
    algorithmVersion: BUDGET_PORTFOLIO_ALGORITHM_VERSION,
    constraintVersion: BUDGET_PORTFOLIO_CONSTRAINT_VERSION,
    evidenceBundleHash,
    confidenceClass: evidence.confidenceClass,
    reasonCodes: dedupedReasons,
    governanceDecisionId,
    governanceDecision: governanceDecision as unknown as Record<string, unknown> | null,
    approvalRequired,
    status,
    proposalContentHash: contentHash,
    createdAt: now,
    validUntil,
  };

  const write = await insertProposal(row, executor);
  if (write.inserted) {
    const event = createAuditEvent({
      eventType: "optimisation_proposal_created",
      source: "system",
      outcome: status === "BLOCKED" ? "failed" : "succeeded",
      occurredAt: now,
      userId: input.userId,
      businessId: input.businessId,
      metadata: {
        optimisationId,
        portfolioSnapshotId: snapshot.portfolioSnapshotId,
        businessId: input.businessId,
        objective,
        status,
        confidenceClass: evidence.confidenceClass,
        reasonCodes: dedupedReasons,
        deltaCount: deltaAllocations.length,
        governanceDecisionId,
        approvalRequired,
        algorithmVersion: BUDGET_PORTFOLIO_ALGORITHM_VERSION,
        constraintVersion: BUDGET_PORTFOLIO_CONSTRAINT_VERSION,
        contractVersion: BUDGET_PORTFOLIO_CONTRACT_VERSION,
      },
    });
    await persistAuditEvent(event, asAuditExecutor(executor));
  } else {
    const existing = await findProposalRow(input.userId, optimisationId, executor);
    if (existing) {
      return {
        proposal: existing,
        governanceDecision: existing.governanceDecision
          ? validateGovernanceDecisionView(existing.governanceDecision)
          : null,
        duplicateClassification: "idempotent_replay",
      };
    }
  }
  return { proposal: row, governanceDecision, duplicateClassification: write.duplicateClassification };
}

// ─── Reads ───

export async function getPortfolioSnapshotForUser(
  input: { userId: number; portfolioSnapshotId: string },
  executor: BudgetPortfolioStoreExecutor
): Promise<PortfolioSnapshot> {
  const row = await findSnapshotRow(input.userId, input.portfolioSnapshotId, executor);
  if (!row) {
    throw new BudgetPortfolioValidationError("SNAPSHOT_NOT_FOUND", `snapshot ${input.portfolioSnapshotId} not found`);
  }
  return snapshotFromRow(row);
}

export async function listPortfolioSnapshotsForUser(
  input: { userId: number; businessId: number; limit?: number },
  executor: BudgetPortfolioStoreExecutor
): Promise<PortfolioSnapshot[]> {
  const rows = await listSnapshotRows(input.userId, input.businessId, input.limit ?? 50, executor);
  return rows.map(snapshotFromRow);
}

export function verifyProposalIntegrity(row: BudgetPortfolioProposalRow): void {
  const contentHash = deriveProposalContentHash({
    optimisationId: row.optimisationId,
    currentAllocations: row.currentAllocations as readonly unknown[],
    proposedAllocations: row.proposedAllocations as readonly unknown[],
    deltaAllocations: row.deltaAllocations as readonly unknown[],
    confidenceClass: row.confidenceClass,
    reasonCodes: row.reasonCodes as readonly string[],
  });
  if (contentHash !== row.proposalContentHash) {
    throw new BudgetPortfolioValidationError(
      "OPTIMISATION_EVIDENCE_CONFLICT",
      `proposal ${row.optimisationId} failed content-hash re-verification (tampering fails closed)`
    );
  }
}

export async function getOptimisationProposalForUser(
  input: { userId: number; optimisationId: string },
  executor: BudgetPortfolioStoreExecutor
): Promise<OptimisationProposalView> {
  const row = await findProposalRow(input.userId, input.optimisationId, executor);
  if (!row) {
    throw new BudgetPortfolioValidationError("OPTIMISATION_NOT_FOUND", `proposal ${input.optimisationId} not found`);
  }
  verifyProposalIntegrity(row);
  return {
    proposal: row,
    governanceDecision: row.governanceDecision ? validateGovernanceDecisionView(row.governanceDecision) : null,
    duplicateClassification: "none",
  };
}

export async function listOptimisationProposalsForUser(
  input: { userId: number; businessId: number; status?: OptimisationProposalStatus; limit?: number },
  executor: BudgetPortfolioStoreExecutor
): Promise<BudgetPortfolioProposalRow[]> {
  const rows = await listProposalRows(input.userId, input.businessId, input.status, input.limit ?? 50, executor);
  for (const row of rows) verifyProposalIntegrity(row);
  return rows;
}

// ─── Authorised instruction (E7 execution boundary) ───

export interface AuthorisedInstructionView {
  readonly instruction: BudgetPortfolioInstructionRow;
  readonly authorisation: {
    readonly governanceDecisionId: string;
    readonly proposalId: string;
    readonly decision: "ALLOW" | "REVIEW_REQUIRED";
    readonly approvalRequestId: number | null;
    readonly policyVersion: string;
    readonly authorisedAt: string;
    readonly expiresAt: string;
  };
}

/**
 * Convert one governance-authorized proposal into the durable, read-only
 * authorised optimisation instruction. Revalidates governance immediately
 * before the transition (fresh policy version + approval binding + decision
 * validity) and binds the EXACT evaluated proposal material — a modified
 * proposal invalidates the binding. R7-E never approves and never executes:
 * the instruction is planning material for downstream (human + R8) consumers.
 */
export async function getAuthorisedInstruction(
  input: { userId: number; optimisationId: string },
  deps: BudgetPortfolioDeps,
  executor: BudgetPortfolioStoreExecutor
): Promise<AuthorisedInstructionView> {
  const now = resolveNow(deps).toISOString();
  const row = await findProposalRow(input.userId, input.optimisationId, executor);
  if (!row) {
    throw new BudgetPortfolioValidationError("OPTIMISATION_NOT_FOUND", `proposal ${input.optimisationId} not found`);
  }
  verifyProposalIntegrity(row);
  if (row.status === "NO_CHANGE") {
    throw new BudgetPortfolioError("NOT_EXECUTABLE", "NO_CHANGE proposals carry no instruction");
  }
  if (row.status === "BLOCKED" || row.status === "REJECTED") {
    throw new BudgetPortfolioError("NOT_EXECUTABLE", `proposal is ${row.status}`);
  }
  if (!row.governanceDecision || !row.governanceDecisionId) {
    throw new BudgetPortfolioError("GOVERNANCE_UNAVAILABLE", "proposal carries no governance decision");
  }
  const decision = validateGovernanceDecisionView(row.governanceDecision);

  // Binding: the stored decision must be for exactly this proposal material.
  // Recompute the R7-F proposal fingerprint from the durable proposal row; a
  // modified proposal no longer matches its decision/approval binding (AC29).
  if (decision.proposalId !== row.optimisationId || decision.businessId !== row.businessId) {
    throw new BudgetPortfolioError(
      "GOVERNANCE_DECISION_BINDING_MISMATCH",
      "governance decision coordinates do not match this proposal"
    );
  }
  const recomputedFingerprint = deriveR7FProposalFingerprint({
    proposalId: row.optimisationId,
    businessId: row.businessId,
    proposalType: "BUDGET_REALLOCATE",
    financial: normaliseGovernanceFinancialForFingerprint({
      currency: row.currency,
      allocationDeltas: (row.deltaAllocations as { allocationKey: string; deltaMinor: number }[]).map(
        (d) => ({
          allocationKey: d.allocationKey,
          campaignId: campaignIdFromAllocationKey(d.allocationKey),
          provider:
            (row.currentAllocations as ProposalAllocationView[]).find(
              (e) => e.allocationKey === d.allocationKey
            )?.provider ?? null,
          deltaMinor: d.deltaMinor,
        })
      ),
    }),
    experiment: null,
    portfolio: {
      resultingAllocations: Object.fromEntries(
        (row.proposedAllocations as ProposalAllocationView[]).map((e) => [e.allocationKey, e.amountMinor])
      ),
    },
    learningReference:
      (row.learningRefs as string[]).length > 0
        ? { learningVersion: "business-learning-to-experiment-optimisation/v1", computedAt: row.createdAt }
        : null,
    campaignId: null,
    evidenceHash: row.evidenceBundleHash,
  });
  if (recomputedFingerprint !== decision.proposalFingerprint) {
    throw new BudgetPortfolioError(
      "GOVERNANCE_DECISION_BINDING_MISMATCH",
      "proposal material changed since governance evaluation; the approval binding no longer matches"
    );
  }

  const approval = decision.approvalRequired
    ? await deps.governance.getApprovalForDecision({
        userId: input.userId,
        governanceDecisionId: decision.governanceDecisionId,
      })
    : null;

  const verdict = deps.governance.assertActionExecutable({
    decision,
    approval,
    currentPolicyVersion: deps.governance.getCurrentPolicyVersion(),
    now,
  });

  if (!verdict.executable) {
    if (verdict.permanent) {
      await updateProposalStatus(input.userId, input.optimisationId, "REJECTED", executor);
    } else if (verdict.reason === "EXPIRED_APPROVAL" || verdict.reason === "EXPIRED_DECISION") {
      await updateProposalStatus(input.userId, input.optimisationId, "EXPIRED", executor);
    }
    throw new BudgetPortfolioError("NOT_EXECUTABLE", `governance gate denied execution: ${verdict.reason}`);
  }

  const instructionId = `ins1:${sha256Hex(`${row.optimisationId}:${decision.governanceDecisionId}`)}`;
  const instructionRow: BudgetPortfolioInstructionRow = {
    instructionId,
    userId: input.userId,
    optimisationId: row.optimisationId,
    governanceDecisionId: decision.governanceDecisionId,
    approvalRequestId: verdict.authorization.approvalRequestId,
    policyVersion: verdict.authorization.policyVersion,
    authorisedAt: now,
    expiresAt: verdict.authorization.expiresAt,
    allocations: (row.proposedAllocations as ProposalAllocationView[]).map((e) => ({
      allocationKey: e.allocationKey,
      amountMinor: e.amountMinor,
    })),
    createdAt: now,
  };
  const write = await insertInstruction(instructionRow, executor);
  await updateProposalStatus(input.userId, input.optimisationId, "AUTHORIZED", executor);
  if (write.inserted) {
    const event = createAuditEvent({
      eventType: "optimisation_instruction_authorized",
      source: "system",
      outcome: "succeeded",
      occurredAt: now,
      userId: input.userId,
      businessId: row.businessId,
      metadata: {
        instructionId,
        optimisationId: row.optimisationId,
        governanceDecisionId: decision.governanceDecisionId,
        approvalRequestId: verdict.authorization.approvalRequestId,
        policyVersion: verdict.authorization.policyVersion,
        authorisedAt: now,
        expiresAt: verdict.authorization.expiresAt,
        contractVersion: BUDGET_PORTFOLIO_CONTRACT_VERSION,
      },
    });
    await persistAuditEvent(event, asAuditExecutor(executor));
  }
  return {
    instruction: instructionRow,
    authorisation: {
      governanceDecisionId: verdict.authorization.governanceDecisionId,
      proposalId: verdict.authorization.proposalId,
      decision: verdict.authorization.decision,
      approvalRequestId: verdict.authorization.approvalRequestId,
      policyVersion: verdict.authorization.policyVersion,
      authorisedAt: verdict.authorization.authorizedAt,
      expiresAt: verdict.authorization.expiresAt,
    },
  };
}

export async function getInstructionForUser(
  input: { userId: number; instructionId: string },
  executor: BudgetPortfolioStoreExecutor
): Promise<BudgetPortfolioInstructionRow | null> {
  return findInstructionRow(input.userId, input.instructionId, executor);
}

export async function getInstructionByOptimisationForUser(
  input: { userId: number; optimisationId: string },
  executor: BudgetPortfolioStoreExecutor
): Promise<BudgetPortfolioInstructionRow | null> {
  return findInstructionByOptimisationRow(input.userId, input.optimisationId, executor);
}

// ─── Strategy handoff projection (E8 — read-only downstream contract) ───

/**
 * The frozen read-only projection through which future R8 strategic
 * intelligence/planning consumes optimisation output. Built purely from the
 * durable proposal + bound governance decision; never mutates strategy and
 * carries no execution permission of any kind.
 */
export interface OptimisationStrategyHandoff {
  readonly contractVersion: "business-optimisation-to-strategy/v1";
  readonly optimisationId: string;
  readonly businessId: number;
  readonly budgetPeriod: string;
  readonly currency: string;
  readonly objective: string;
  readonly status: string;
  readonly currentAllocations: readonly ProposalAllocationView[];
  readonly proposedAllocations: readonly ProposalAllocationView[];
  readonly deltaAllocations: readonly { allocationKey: string; deltaMinor: number }[];
  readonly evidenceRefs: readonly string[];
  readonly confidenceClass: string;
  readonly reasonCodes: readonly string[];
  readonly constraints: {
    readonly constraintVersion: string;
    readonly concentrationCeilingBps: number;
    readonly maxShiftPerCycleBps: number;
    readonly maxShiftPerCycleMinor: number;
    readonly minAllocationMinor: number;
    readonly minChangeThresholdMinor: number;
  };
  readonly governance: {
    readonly governanceDecisionId: string | null;
    readonly decision: string | null;
    readonly approvalRequired: boolean;
    readonly policyVersion: string | null;
    readonly riskClass: string | null;
  } | null;
  readonly authorisation: {
    readonly instructionId: string;
    readonly approvalRequestId: number | null;
    readonly authorisedAt: string;
    readonly expiresAt: string;
  } | null;
  readonly algorithmVersion: string;
  readonly createdAt: string;
  readonly validUntil: string | null;
  readonly causationClaimed: false;
  readonly causationDisclaimer: string;
  readonly attributionClaimed: false;
  readonly attributionDisclaimer: string;
}

export const OPTIMISATION_CAUSATION_DISCLAIMER =
  "Optimisation allocations are evidence-bounded proposals derived from governed outcomes, attribution and learning. This projection does not assert that any allocation caused any business outcome." as const;
export const OPTIMISATION_ATTRIBUTION_DISCLAIMER =
  "Attribution credit consumed by optimisation is association evidence, not causal proof. Credit allocation, causal scores and channel weights remain R7-B derivations on their own authority." as const;

export const OPTIMISATION_STRATEGY_HANDOFF_FIELD_KEYS = [
  "contractVersion",
  "optimisationId",
  "businessId",
  "budgetPeriod",
  "currency",
  "objective",
  "status",
  "currentAllocations",
  "proposedAllocations",
  "deltaAllocations",
  "evidenceRefs",
  "confidenceClass",
  "reasonCodes",
  "constraints",
  "governance",
  "authorisation",
  "algorithmVersion",
  "createdAt",
  "validUntil",
  "causationClaimed",
  "causationDisclaimer",
  "attributionClaimed",
  "attributionDisclaimer",
] as const;

export async function getStrategyHandoffProjection(
  input: { userId: number; optimisationId: string },
  executor: BudgetPortfolioStoreExecutor
): Promise<OptimisationStrategyHandoff> {
  const row = await findProposalRow(input.userId, input.optimisationId, executor);
  if (!row) {
    throw new BudgetPortfolioValidationError("OPTIMISATION_NOT_FOUND", `proposal ${input.optimisationId} not found`);
  }
  verifyProposalIntegrity(row);
  const decision = row.governanceDecision ? validateGovernanceDecisionView(row.governanceDecision) : null;
  const instruction = await findInstructionByOptimisationRow(input.userId, row.optimisationId, executor);
  return Object.freeze({
    contractVersion: "business-optimisation-to-strategy/v1",
    optimisationId: row.optimisationId,
    businessId: row.businessId,
    budgetPeriod: row.budgetPeriod,
    currency: row.currency,
    objective: row.objective,
    status: row.status,
    currentAllocations: Object.freeze(row.currentAllocations as ProposalAllocationView[]),
    proposedAllocations: Object.freeze(row.proposedAllocations as ProposalAllocationView[]),
    deltaAllocations: Object.freeze(row.deltaAllocations as { allocationKey: string; deltaMinor: number }[]),
    evidenceRefs: Object.freeze(row.evidenceRefs as string[]),
    confidenceClass: row.confidenceClass,
    reasonCodes: Object.freeze(row.reasonCodes as string[]),
    constraints: Object.freeze({
      constraintVersion: row.constraintVersion,
      concentrationCeilingBps: DEFAULT_OPTIMISATION_CONSTRAINTS.concentrationCeilingBps,
      maxShiftPerCycleBps: DEFAULT_OPTIMISATION_CONSTRAINTS.maxShiftPerCycleBps,
      maxShiftPerCycleMinor: DEFAULT_OPTIMISATION_CONSTRAINTS.maxShiftPerCycleMinor,
      minAllocationMinor: DEFAULT_OPTIMISATION_CONSTRAINTS.minAllocationMinor,
      minChangeThresholdMinor: DEFAULT_OPTIMISATION_CONSTRAINTS.minChangeThresholdMinor,
    }),
    governance: decision
      ? Object.freeze({
          governanceDecisionId: decision.governanceDecisionId,
          decision: decision.decision,
          approvalRequired: decision.approvalRequired,
          policyVersion: decision.policyVersion,
          riskClass: decision.riskClass,
        })
      : null,
    authorisation: instruction
      ? Object.freeze({
          instructionId: instruction.instructionId,
          approvalRequestId: instruction.approvalRequestId,
          authorisedAt: isoOf(instruction.authorisedAt),
          expiresAt: isoOf(instruction.expiresAt),
        })
      : null,
    algorithmVersion: row.algorithmVersion,
    createdAt: isoOf(row.createdAt),
    validUntil: row.validUntil,
    causationClaimed: false,
    causationDisclaimer: OPTIMISATION_CAUSATION_DISCLAIMER,
    attributionClaimed: false,
    attributionDisclaimer: OPTIMISATION_ATTRIBUTION_DISCLAIMER,
  });
}
