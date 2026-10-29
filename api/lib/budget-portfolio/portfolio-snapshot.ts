// ─── R7-E Budget & Portfolio Optimisation — portfolio snapshot (E2) ───
//
// PURE module: validates raw portfolio authority material arriving through the
// provider seam, assembles the deterministic portfolio snapshot and enforces
// snapshot freshness. Same authoritative state ⇒ same snapshot identity
// (contract §4); a stale snapshot fails closed before any material action.
// The client can never fabricate the total budget, the available funds or any
// allocation — every financial fact here is assembled server-side from
// canonical rows re-verified for tenant + business.
//
// No I/O, no clock (the caller supplies `now` for freshness checks only).

import {
  BUDGET_PERIOD_PATTERN,
  BudgetPortfolioOwnershipError,
  BudgetPortfolioValidationError,
  CURRENCY_PATTERN,
  campaignAllocationKey,
  derivePortfolioSnapshotId,
  isIsoUtc,
} from "./budget-portfolio-contract";

export const CAMPAIGN_STATUSES = ["draft", "active", "paused", "completed"] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

/** One canonical campaign row as seen by the authority seam (untrusted). */
export interface PortfolioAuthorityCampaign {
  readonly id: number;
  readonly userId: number;
  readonly businessId: number;
  readonly status: CampaignStatus;
  /** Whole-unit budget (USD) from the canonical campaign row; ≥ 0. */
  readonly budget: number;
  /** Server-derived channel/provider capability label, or null. */
  readonly provider: string | null;
}

/** Raw authority material for one business (validated before use). */
export interface PortfolioAuthorityMaterial {
  readonly business: { readonly id: number; readonly userId: number; readonly isActive: boolean } | null;
  readonly campaigns: readonly PortfolioAuthorityCampaign[];
  readonly currency: string;
  readonly budgetPeriod: string;
  readonly supportedProviders: readonly string[];
  readonly lockedAllocationKeys: readonly string[];
  /** Funds held by reservations (minor units) — immutable to optimisation. */
  readonly reservedMinor: number;
  /**
   * Server-resolved approved total for the period (minor units). Absent ⇒
   * the conservative baseline derivation (committed campaign envelope, no
   * autonomous headroom — inventory §10-F1). Never client-supplied.
   */
  readonly approvedTotalBudgetMinor?: number;
}

function fail(message: string): never {
  throw new BudgetPortfolioValidationError(
    "PROVIDER_AUTHORITY_UNAVAILABLE",
    `portfolio authority material failed validation: ${message} (fail closed)`
  );
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * Re-validate raw authority material at the boundary. Untrusted until
 * accepted; malformed or cross-tenant material fails closed and
 * indistinguishable (absence of authority never widens autonomy).
 */
export function validatePortfolioAuthorityMaterial(
  raw: unknown,
  userId: number,
  businessId: number
): PortfolioAuthorityMaterial {
  if (typeof raw !== "object" || raw === null) fail("material must be an object");
  const r = raw as Record<string, unknown>;

  const businessRaw = r.business;
  if (typeof businessRaw !== "object" || businessRaw === null) {
    throw new BudgetPortfolioOwnershipError(
      "OWNERSHIP_MISMATCH",
      `business ${businessId} not found for this tenant`
    );
  }
  const b = businessRaw as Record<string, unknown>;
  if (
    b.id !== businessId ||
    b.userId !== userId ||
    typeof b.isActive !== "boolean"
  ) {
    // Cross-tenant / wrong-business references are indistinguishable from
    // absent (fail closed).
    throw new BudgetPortfolioOwnershipError(
      "OWNERSHIP_MISMATCH",
      `business ${businessId} not found for this tenant`
    );
  }

  if (typeof r.currency !== "string" || !CURRENCY_PATTERN.test(r.currency)) {
    fail("currency must be a 3-letter uppercase code");
  }
  if (typeof r.budgetPeriod !== "string" || !BUDGET_PERIOD_PATTERN.test(r.budgetPeriod)) {
    fail('budgetPeriod must be "YYYY-MM"');
  }
  if (!Array.isArray(r.supportedProviders)) fail("supportedProviders must be an array");
  for (const p of r.supportedProviders) {
    if (typeof p !== "string" || p.trim().length === 0 || p.length > 32) {
      fail("supportedProviders entries must be non-blank strings ≤ 32 chars");
    }
  }
  if (!Array.isArray(r.lockedAllocationKeys)) fail("lockedAllocationKeys must be an array");
  for (const k of r.lockedAllocationKeys) {
    if (typeof k !== "string" || k.trim().length === 0) fail("lockedAllocationKeys entries must be non-blank strings");
  }
  if (!isNonNegativeInt(r.reservedMinor)) fail("reservedMinor must be a non-negative integer");
  if (
    r.approvedTotalBudgetMinor !== null &&
    r.approvedTotalBudgetMinor !== undefined &&
    !isNonNegativeInt(r.approvedTotalBudgetMinor)
  ) {
    fail("approvedTotalBudgetMinor must be a non-negative integer when present");
  }

  if (!Array.isArray(r.campaigns)) fail("campaigns must be an array");
  const campaigns: PortfolioAuthorityCampaign[] = [];
  const seenIds = new Set<number>();
  for (const c of r.campaigns) {
    if (typeof c !== "object" || c === null) fail("campaign entry must be an object");
    const row = c as Record<string, unknown>;
    if (
      typeof row.id !== "number" ||
      !Number.isInteger(row.id) ||
      row.id <= 0 ||
      row.userId !== userId ||
      row.businessId !== businessId
    ) {
      fail("campaign does not verify for this tenant/business");
    }
    if (seenIds.has(row.id)) fail(`duplicate campaign id ${row.id}`);
    seenIds.add(row.id);
    if (!CAMPAIGN_STATUSES.includes(row.status as CampaignStatus)) {
      fail(`campaign ${row.id} has unknown status`);
    }
    if (!isNonNegativeInt(row.budget)) fail(`campaign ${row.id} budget must be a non-negative integer`);
    if (row.budget > 1e13) fail(`campaign ${row.id} budget exceeds sane bound`);
    if (row.provider !== null && row.provider !== undefined) {
      if (typeof row.provider !== "string" || row.provider.trim().length === 0 || row.provider.length > 32) {
        fail(`campaign ${row.id} provider must be a non-blank string ≤ 32 chars or null`);
      }
    }
    campaigns.push({
      id: row.id,
      userId,
      businessId,
      status: row.status as CampaignStatus,
      budget: row.budget,
      provider: (row.provider as string | null | undefined) ?? null,
    });
  }

  return {
    business: { id: businessId, userId, isActive: b.isActive },
    campaigns: Object.freeze(campaigns),
    currency: r.currency,
    budgetPeriod: r.budgetPeriod,
    supportedProviders: Object.freeze([...r.supportedProviders]),
    lockedAllocationKeys: Object.freeze([...r.lockedAllocationKeys]),
    reservedMinor: r.reservedMinor,
    approvedTotalBudgetMinor:
      r.approvedTotalBudgetMinor === null || r.approvedTotalBudgetMinor === undefined
        ? undefined
        : r.approvedTotalBudgetMinor,
  };
}

export interface PortfolioAllocationEntry {
  readonly allocationKey: string;
  readonly campaignId: number;
  readonly provider: string | null;
  /** Integer minor units. */
  readonly amountMinor: number;
}

/** The deterministic portfolio snapshot (contract §4). */
export interface PortfolioSnapshot {
  readonly portfolioSnapshotId: string;
  readonly userId: number;
  readonly businessId: number;
  readonly budgetPeriod: string;
  readonly currency: string;
  readonly approvedTotalBudgetMinor: number;
  readonly committedMinor: number;
  readonly reservedMinor: number;
  readonly availableReallocatableMinor: number;
  readonly currentAllocations: readonly PortfolioAllocationEntry[];
  readonly supportedProviders: readonly string[];
  readonly lockedAllocationKeys: readonly string[];
  readonly disabledAllocationKeys: readonly string[];
  /** Capture time — freshness only, NEVER part of the identity. */
  readonly capturedAt: string;
}

/**
 * Assemble the snapshot. Money is integer minor units: the canonical campaign
 * budget (whole USD) converts ×100. Approved total = the committed campaign
 * envelope (inventory §10-F1: no autonomous headroom exists until a dedicated
 * budget-authority table lands at R7-X), so available headroom is zero in the
 * baseline and optimisation reallocates WITHIN the approved envelope.
 *
 * Eligibility: `active` campaigns may receive and release; `paused` campaigns
 * hold committed funds (releasable, not receivable); `draft`/`completed`
 * campaigns hold no committed funds and are disabled outright; campaigns whose
 * provider is unsupported cannot receive new allocation.
 */
export function buildPortfolioSnapshot(
  material: PortfolioAuthorityMaterial,
  capturedAt: string
): PortfolioSnapshot {
  if (!isIsoUtc(capturedAt)) {
    throw new BudgetPortfolioValidationError(
      "INVALID_CLOCK",
      `capturedAt must be an explicit ISO 8601 UTC timestamp, got ${String(capturedAt)}`
    );
  }
  const { userId, id: businessId } = material.business!;

  const currentAllocations: PortfolioAllocationEntry[] = [];
  const disabledAllocationKeys: string[] = [];
  let committedMinor = 0;

  for (const campaign of material.campaigns) {
    const key = campaignAllocationKey(campaign.id);
    const amountMinor = campaign.budget * 100;
    if (campaign.status === "active" || campaign.status === "paused") {
      if (amountMinor > 0) {
        currentAllocations.push(
          Object.freeze({ allocationKey: key, campaignId: campaign.id, provider: campaign.provider, amountMinor })
        );
        committedMinor += amountMinor;
      }
      if (
        campaign.status === "paused" ||
        (campaign.provider !== null && !material.supportedProviders.includes(campaign.provider))
      ) {
        disabledAllocationKeys.push(key);
      }
    } else {
      // draft/completed: no committed funds; cannot receive allocation.
      disabledAllocationKeys.push(key);
    }
  }
  currentAllocations.sort((a, b) => a.allocationKey.localeCompare(b.allocationKey));
  disabledAllocationKeys.sort();

  const approvedTotalBudgetMinor = material.approvedTotalBudgetMinor ?? committedMinor;
  if (approvedTotalBudgetMinor < committedMinor + material.reservedMinor) {
    throw new BudgetPortfolioValidationError(
      "PROVIDER_AUTHORITY_UNAVAILABLE",
      "authority material implies committed+reserved funds exceed the approved envelope (fail closed)"
    );
  }
  const availableReallocatableMinor = approvedTotalBudgetMinor - committedMinor - material.reservedMinor;

  const currentByKey: Record<string, number> = {};
  for (const entry of currentAllocations) currentByKey[entry.allocationKey] = entry.amountMinor;

  const portfolioSnapshotId = derivePortfolioSnapshotId({
    userId,
    businessId,
    budgetPeriod: material.budgetPeriod,
    currency: material.currency,
    approvedTotalBudgetMinor,
    committedMinor,
    reservedMinor: material.reservedMinor,
    currentAllocations: currentByKey,
    supportedProviders: material.supportedProviders,
    lockedAllocationKeys: material.lockedAllocationKeys,
    disabledAllocationKeys,
  });

  return Object.freeze({
    portfolioSnapshotId,
    userId,
    businessId,
    budgetPeriod: material.budgetPeriod,
    currency: material.currency,
    approvedTotalBudgetMinor,
    committedMinor,
    reservedMinor: material.reservedMinor,
    availableReallocatableMinor,
    currentAllocations: Object.freeze(currentAllocations),
    supportedProviders: material.supportedProviders,
    lockedAllocationKeys: material.lockedAllocationKeys,
    disabledAllocationKeys: Object.freeze(disabledAllocationKeys),
    capturedAt,
  });
}

/**
 * Freshness gate: a snapshot older than the governance policy staleness
 * horizon must not drive any material action (fail closed, SNAPSHOT_STALE).
 */
export function assertSnapshotFresh(
  snapshot: PortfolioSnapshot,
  now: string,
  staleBudgetStateMs: number
): void {
  const nowMs = Date.parse(now);
  if (Number.isNaN(nowMs)) {
    throw new BudgetPortfolioValidationError("INVALID_CLOCK", `now must be a valid ISO timestamp, got ${String(now)}`);
  }
  if (nowMs - Date.parse(snapshot.capturedAt) > staleBudgetStateMs) {
    throw new BudgetPortfolioValidationError(
      "SNAPSHOT_STALE",
      `portfolio snapshot ${snapshot.portfolioSnapshotId} is stale (capturedAt ${snapshot.capturedAt}); re-snapshot required before any material action`
    );
  }
}
