// ─── R8-B Business Change Intelligence — rule-first change detection ───
//
// PURE module: canonical-normalised state views (closed templates) + the
// deterministic detection rule table (contract §5). Detection compares the
// previous authoritative state (R8-A current memory, re-resolved through the
// pointer chain) against the newly observed authoritative state. Equal
// canonical states produce NO change; representation-only differences are
// erased by documented normalisation; no rule firing returns null. No model
// participates; no fuzzy matching; no I/O, no clock.

import type { BusinessChangeSubjectType, BusinessChangeType } from "./business-change-contract";
import { BusinessChangeInputError } from "./business-change-contract";

// ─── Canonical normalisation (documented, deterministic) ───

/** Text: trim + collapse internal whitespace + case-fold. */
export function normComparisonText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

/** String set: trim, drop empties, dedupe (case-folded), sort. */
export function normStringSet(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const entry of value) {
    const text = normComparisonText(entry);
    if (text.length > 0) seen.add(text);
  }
  return [...seen].sort();
}

/** Bounded plain string (trim only — case preserved where meaningful). */
export function normPlainString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Integer minor units; non-finite/negative-safe default 0. */
export function normMinorUnits(value: unknown): number {
  const n = typeof value === "bigint" ? Number(value) : typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
}

// ─── Closed state-view templates ───

export interface ChangeStateView {
  template: string;
  fields: Record<string, unknown>;
}

export const CHANGE_STATE_TEMPLATES: Record<BusinessChangeSubjectType, string> = {
  OBJECTIVE: "OBJECTIVE_STATE",
  PRODUCT_SET: "PRODUCT_SERVICE_STATE",
  AUDIENCE_SET: "AUDIENCE_STATE",
  BUDGET_ENVELOPE: "BUDGET_ENVELOPE_STATE",
  PROVIDER_CAPABILITY: "PROVIDER_CAPABILITY_STATE",
  LEARNING: "LEARNING_STATE",
  STRATEGY: "STRATEGY_STATE",
  CONSTRAINT: "CONSTRAINT_STATE",
  RISK_POSTURE: "RISK_POSTURE_STATE",
};

// ─── Pure view builders (used by the seams on server-loaded rows) ───

export function buildObjectiveStateView(objectiveText: unknown): ChangeStateView {
  return { template: "OBJECTIVE_STATE", fields: { objectiveText: normComparisonText(objectiveText) } };
}

export function buildProductSetStateView(input: { primaryOffering: unknown; productsAndServices: unknown }): ChangeStateView {
  return {
    template: "PRODUCT_SERVICE_STATE",
    fields: {
      primaryOffering: normComparisonText(input.primaryOffering),
      products: normStringSet(input.productsAndServices),
    },
  };
}

export function buildAudienceSetStateView(input: { targetCustomerSegments: unknown }): ChangeStateView {
  const segments = normStringSet(input.targetCustomerSegments);
  return {
    template: "AUDIENCE_STATE",
    fields: { primarySegment: segments[0] ?? "", segments },
  };
}

export function buildBudgetEnvelopeStateView(input: { approvedTotalBudgetMinor: unknown; currency: unknown }): ChangeStateView {
  return {
    template: "BUDGET_ENVELOPE_STATE",
    fields: {
      approvedTotalMinor: normMinorUnits(input.approvedTotalBudgetMinor),
      currency: normPlainString(input.currency).toUpperCase(),
    },
  };
}

export function buildProviderCapabilityStateView(input: { supportedProviders: unknown }): ChangeStateView {
  return { template: "PROVIDER_CAPABILITY_STATE", fields: { supportedProviders: normStringSet(input.supportedProviders) } };
}

export function buildLearningStateView(input: {
  status: unknown;
  contradictionCount: unknown;
  confidenceClass: unknown;
  upstreamStateFingerprint: unknown;
}): ChangeStateView {
  const count = Number(input.contradictionCount);
  return {
    template: "LEARNING_STATE",
    fields: {
      status: normPlainString(input.status),
      contradictionCount: Number.isFinite(count) && count > 0 ? Math.trunc(count) : 0,
      confidenceClass: normPlainString(input.confidenceClass),
      upstreamStateFingerprint: normPlainString(input.upstreamStateFingerprint),
    },
  };
}

export function buildStrategyStateView(input: { strategyHashSha256: unknown }): ChangeStateView {
  return { template: "STRATEGY_STATE", fields: { strategyHashSha256: normPlainString(input.strategyHashSha256) } };
}

export function buildConstraintStateView(input: { decision: unknown; policyVersion: unknown }): ChangeStateView {
  return {
    template: "CONSTRAINT_STATE",
    fields: {
      decision: normPlainString(input.decision),
      policyVersion: normPlainString(input.policyVersion),
    },
  };
}

export function buildRiskPostureStateView(input: { riskClass: unknown }): ChangeStateView {
  // R7-F stores lowercase tiers (low < medium < high < critical); the closed
  // comparison vocabulary is case-folded so representation case can never
  // mint or mask a change.
  return { template: "RISK_POSTURE_STATE", fields: { riskClass: normPlainString(input.riskClass).toUpperCase() } };
}

// ─── Detection rule table (contract §5) ───

export interface DetectedChange {
  changeType: BusinessChangeType;
  /** Significance context (contract §7.1). */
  budgetDeltaMinor: number | null;
  setChangeCount: number | null;
  ordinalDistance: number | null;
}

function setDiff(previous: readonly string[], current: readonly string[]): { added: string[]; removed: string[] } {
  const prev = new Set(previous);
  const curr = new Set(current);
  return {
    added: current.filter((entry) => !prev.has(entry)),
    removed: previous.filter((entry) => !curr.has(entry)),
  };
}

const CONSTRAINT_RANK: Record<string, number> = { ALLOW: 0, REVIEW_REQUIRED: 1, BLOCK: 2 };
const RISK_RANK: Record<string, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };

/**
 * Deterministic change detection for one subject. Returns null when the
 * canonical states are equal (no change). When several rules could fire, the
 * documented priority order picks exactly one change type per evaluation.
 */
export function detectChange(input: {
  subjectType: BusinessChangeSubjectType;
  previous: ChangeStateView;
  current: ChangeStateView;
}): DetectedChange | null {
  const { subjectType, previous, current } = input;
  if (previous.template !== current.template) {
    throw new BusinessChangeInputError(
      "CHANGE_COMPARISON_STATE_MISSING",
      `Cannot compare state views of different templates (${previous.template} vs ${current.template}).`
    );
  }
  const p = previous.fields;
  const c = current.fields;
  const none: DetectedChange = { changeType: "OBJECTIVE_ADDED", budgetDeltaMinor: null, setChangeCount: null, ordinalDistance: null };

  switch (subjectType) {
    case "OBJECTIVE": {
      const prevText = String(p.objectiveText ?? "");
      const currText = String(c.objectiveText ?? "");
      if (prevText === currText) return null;
      if (prevText.length === 0) return { ...none, changeType: "OBJECTIVE_ADDED" };
      if (currText.length === 0) return { ...none, changeType: "OBJECTIVE_REMOVED" };
      return { ...none, changeType: "OBJECTIVE_MODIFIED" };
    }
    case "PRODUCT_SET": {
      const prevOffering = String(p.primaryOffering ?? "");
      const currOffering = String(c.primaryOffering ?? "");
      const prevProducts = (p.products ?? []) as string[];
      const currProducts = (c.products ?? []) as string[];
      const diff = setDiff(prevProducts, currProducts);
      // Priority: repositioning (offering change) > added > removed.
      if (prevOffering !== currOffering) return { ...none, changeType: "PRODUCT_REPOSITIONED" };
      if (diff.added.length > 0) return { ...none, changeType: "PRODUCT_ADDED", setChangeCount: diff.added.length };
      if (diff.removed.length > 0) return { ...none, changeType: "PRODUCT_REMOVED", setChangeCount: diff.removed.length };
      return null;
    }
    case "AUDIENCE_SET": {
      const prevPrimary = String(p.primarySegment ?? "");
      const currPrimary = String(c.primarySegment ?? "");
      const prevSegments = (p.segments ?? []) as string[];
      const currSegments = (c.segments ?? []) as string[];
      const diff = setDiff(prevSegments, currSegments);
      if (diff.added.length > 0) return { ...none, changeType: "AUDIENCE_SEGMENT_ADDED", setChangeCount: diff.added.length };
      if (diff.removed.length > 0) return { ...none, changeType: "AUDIENCE_SEGMENT_REMOVED", setChangeCount: diff.removed.length };
      if (prevPrimary !== currPrimary) return { ...none, changeType: "AUDIENCE_REPOSITIONED" };
      return null;
    }
    case "BUDGET_ENVELOPE": {
      const prevTotal = normMinorUnits(p.approvedTotalMinor);
      const currTotal = normMinorUnits(c.approvedTotalMinor);
      const delta = currTotal - prevTotal;
      if (delta === 0) return null;
      return {
        ...none,
        changeType: delta > 0 ? "BUDGET_ENVELOPE_INCREASED" : "BUDGET_ENVELOPE_DECREASED",
        budgetDeltaMinor: Math.abs(delta),
      };
    }
    case "PROVIDER_CAPABILITY": {
      const prevProviders = (p.supportedProviders ?? []) as string[];
      const currProviders = (c.supportedProviders ?? []) as string[];
      const diff = setDiff(prevProviders, currProviders);
      if (diff.added.length > 0) return { ...none, changeType: "PROVIDER_SUPPORT_ADDED", setChangeCount: diff.added.length };
      if (diff.removed.length > 0) return { ...none, changeType: "PROVIDER_SUPPORT_REMOVED", setChangeCount: diff.removed.length };
      return null;
    }
    case "LEARNING": {
      const prevFp = String(p.upstreamStateFingerprint ?? "");
      const currFp = String(c.upstreamStateFingerprint ?? "");
      const prevContradictions = Number(p.contradictionCount ?? 0);
      const currContradictions = Number(c.contradictionCount ?? 0);
      const prevStatus = String(p.status ?? "");
      const currStatus = String(c.status ?? "");
      // Priority: contradiction (same pattern contradicted) > supersession
      // (replaced by a newer upstream learning state).
      const contradictionFired =
        currContradictions > prevContradictions ||
        (currStatus !== prevStatus && /CONTRADICT/i.test(currStatus) && !/CONTRADICT/i.test(prevStatus));
      if (contradictionFired) return { ...none, changeType: "LEARNING_PATTERN_CONTRADICTED" };
      if (prevFp !== currFp && prevFp.length > 0 && currFp.length > 0) {
        return { ...none, changeType: "LEARNING_PATTERN_SUPERSEDED" };
      }
      return null;
    }
    case "STRATEGY": {
      const prevHash = String(p.strategyHashSha256 ?? "");
      const currHash = String(c.strategyHashSha256 ?? "");
      if (prevHash.length === 0 || currHash.length === 0) {
        throw new BusinessChangeInputError(
          "CHANGE_COMPARISON_STATE_MISSING",
          "Strategy regime comparison requires both snapshots to carry a strategyHashSha256."
        );
      }
      if (prevHash === currHash) return null;
      return { ...none, changeType: "STRATEGY_REGIME_CHANGED" };
    }
    case "CONSTRAINT": {
      const prevRank = CONSTRAINT_RANK[String(p.decision ?? "")] ?? -1;
      const currRank = CONSTRAINT_RANK[String(c.decision ?? "")] ?? -1;
      if (prevRank < 0 || currRank < 0) {
        throw new BusinessChangeInputError(
          "CHANGE_COMPARISON_STATE_MISSING",
          "Constraint comparison requires closed governance decisions (ALLOW/REVIEW_REQUIRED/BLOCK)."
        );
      }
      if (prevRank === currRank) return null;
      return {
        ...none,
        changeType: currRank > prevRank ? "CONSTRAINT_TIGHTENED" : "CONSTRAINT_RELAXED",
        ordinalDistance: Math.abs(currRank - prevRank),
      };
    }
    case "RISK_POSTURE": {
      const prevRank = RISK_RANK[String(p.riskClass ?? "")] ?? -1;
      const currRank = RISK_RANK[String(c.riskClass ?? "")] ?? -1;
      if (prevRank < 0 || currRank < 0) {
        throw new BusinessChangeInputError(
          "CHANGE_COMPARISON_STATE_MISSING",
          "Risk posture comparison requires closed risk classes (LOW/MEDIUM/HIGH/CRITICAL)."
        );
      }
      if (prevRank === currRank) return null;
      return {
        ...none,
        changeType: currRank > prevRank ? "RISK_POSTURE_ELEVATED" : "RISK_POSTURE_REDUCED",
        ordinalDistance: Math.abs(currRank - prevRank),
      };
    }
    default:
      return null;
  }
}
