// ─── R8-D Strategic Reasoning — rule-first synthesis ───
//
// Deterministic, rule-first strategic synthesis over normalized evidence
// descriptors (contract §5). No model is in the decision path: confidence
// derives from evidence-quality caps only, contradictions stay visible, and
// association is never promoted to causation. Optional model candidates
// (untrusted, client-supplied, closed-vocabulary) may only select among
// rule-produced hypotheses — they can never invent evidence, raise
// confidence, suppress contradiction, or create a hypothesis the rules did
// not produce.

import {
  type StrategicConfidenceClass,
  type StrategicEvidenceClass,
  type StrategicEvidenceRole,
  type StrategicHypothesisType,
  type StrategicImplicationType,
  type StrategicMissingEvidenceClass,
  type StrategicUncertaintyClass,
} from "./strategic-reasoning-contract";
import type {
  ChangeEvidenceView,
  MemoryEvidenceView,
  SignalEvidenceView,
  StrategicEvidenceView,
} from "./strategic-reasoning-evidence-seam";
import { buildReasoningGraph, type ReasoningGraph } from "./strategic-reasoning-graph";

// ─── Freshness / staleness windows (deterministic policy) ───

/** External signals observed longer ago than this are stale context, not support. */
export const SIGNAL_STALENESS_WINDOW_MS = 30 * 24 * 3600_000;

// ─── Normalized evidence descriptors ───

type ChangeDirection =
  | "DECLINE"
  | "GROWTH"
  | "ALIGNMENT"
  | "RESOURCE_DECLINE"
  | "RESOURCE_GROWTH"
  | "PRESSURE"
  | null;

type SignalFamily =
  | "COMPETITOR"
  | "DEMAND"
  | "REGULATORY"
  | "TECHNOLOGY"
  | "MARKET"
  | null;

export interface EvidenceDescriptor {
  readonly view: StrategicEvidenceView;
  readonly usable: boolean;
  readonly stale: boolean;
  readonly assumption: boolean;
  readonly contradictionActive: boolean;
  readonly quality: 0 | 1 | 2 | 3;
  readonly direction: ChangeDirection;
  readonly family: SignalFamily;
  readonly corroborated: boolean;
  readonly singleSource: boolean;
}

const DECLINE_CHANGE_TYPES = new Set([
  "OBJECTIVE_REMOVED",
  "PRODUCT_REMOVED",
  "AUDIENCE_SEGMENT_REMOVED",
  "LEARNING_PATTERN_CONTRADICTED",
]);
const GROWTH_CHANGE_TYPES = new Set([
  "OBJECTIVE_ADDED",
  "PRODUCT_ADDED",
  "AUDIENCE_SEGMENT_ADDED",
  "CONSTRAINT_RELAXED",
  "RISK_POSTURE_REDUCED",
]);
const ALIGNMENT_CHANGE_TYPES = new Set([
  "OBJECTIVE_MODIFIED",
  "STRATEGY_REGIME_CHANGED",
  "PRODUCT_REPOSITIONED",
  "AUDIENCE_REPOSITIONED",
  "CONSTRAINT_TIGHTENED",
]);
const RESOURCE_DECLINE_CHANGE_TYPES = new Set(["BUDGET_ENVELOPE_DECREASED", "PROVIDER_SUPPORT_REMOVED"]);
const RESOURCE_GROWTH_CHANGE_TYPES = new Set(["BUDGET_ENVELOPE_INCREASED", "PROVIDER_SUPPORT_ADDED"]);

const CHANGE_QUALITY_BY_SIGNIFICANCE: Record<string, 1 | 2 | 3> = {
  LOW: 1,
  MODERATE: 2,
  HIGH: 3,
  CRITICAL: 3,
};

const MEMORY_QUALITY: Record<string, 0 | 1 | 2 | 3> = {
  AUTHORITATIVE: 3,
  VERIFIED: 3,
  PROVISIONAL: 2,
  OBSERVED: 1,
  UNVERIFIED: 0,
};

const SIGNAL_QUALITY: Record<string, 0 | 1 | 3> = {
  VERIFIED_EXTERNAL: 3,
  CORROBORATED_EXTERNAL: 3,
  SINGLE_EXTERNAL_SOURCE: 1,
  UNVERIFIED: 0,
  CONTRADICTED: 0,
  MALFORMED: 0,
};

function directionForChange(changeType: string): ChangeDirection {
  if (DECLINE_CHANGE_TYPES.has(changeType)) return "DECLINE";
  if (GROWTH_CHANGE_TYPES.has(changeType)) return "GROWTH";
  if (ALIGNMENT_CHANGE_TYPES.has(changeType)) return "ALIGNMENT";
  if (RESOURCE_DECLINE_CHANGE_TYPES.has(changeType)) return "RESOURCE_DECLINE";
  if (RESOURCE_GROWTH_CHANGE_TYPES.has(changeType)) return "RESOURCE_GROWTH";
  if (changeType === "RISK_POSTURE_ELEVATED") return "PRESSURE";
  return null;
}

function familyForSignal(signalType: string): SignalFamily {
  switch (signalType) {
    case "COMPETITOR_ACTION":
    case "PRODUCT_LAUNCH":
      return "COMPETITOR";
    case "MARKET_DEMAND":
    case "MACRO_ENVIRONMENT":
    case "PRICING_CHANGE":
    case "ECOSYSTEM_CHANGE":
      return "DEMAND";
    case "REGULATORY_CHANGE":
      return "REGULATORY";
    case "TECHNOLOGY_CHANGE":
      return "TECHNOLOGY";
    case "REPUTATION_SIGNAL":
    case "CHANNEL_PLATFORM_CHANGE":
      return "MARKET";
    default:
      return null;
  }
}

export function describeEvidence(views: readonly StrategicEvidenceView[], nowMs: number): EvidenceDescriptor[] {
  return views.map((view) => {
    if (view.evidenceClass === "INTERNAL_MEMORY") {
      const memory = view as MemoryEvidenceView;
      const expired = memory.validUntil !== null && Date.parse(memory.validUntil) < nowMs;
      const usable = memory.factStatus === "CURRENT" && !expired;
      return {
        view,
        usable,
        stale: !usable,
        assumption: memory.statementType === "ASSUMPTION",
        contradictionActive: memory.factStatus === "CONTRADICTED",
        quality: (usable ? MEMORY_QUALITY[memory.confidenceClass] ?? 0 : 0) as 0 | 1 | 2 | 3,
        direction: null,
        family: null,
        corroborated: false,
        singleSource: false,
      };
    }
    if (view.evidenceClass === "INTERNAL_CHANGE") {
      const change = view as ChangeEvidenceView;
      const expired = change.validUntil !== null && Date.parse(change.validUntil) < nowMs;
      const active = change.status === "DETECTED" || change.status === "CONFIRMED" || change.status === "PROVISIONAL";
      const usable = active && !expired;
      let quality = (usable ? CHANGE_QUALITY_BY_SIGNIFICANCE[change.significanceClass] ?? 0 : 0) as 0 | 1 | 2 | 3;
      if (change.status === "PROVISIONAL" && quality > 2) quality = 2;
      return {
        view,
        usable,
        stale: !usable,
        assumption: change.status === "PROVISIONAL",
        contradictionActive: change.status === "CONTRADICTED",
        quality,
        direction: directionForChange(change.changeType),
        family: null,
        corroborated: false,
        singleSource: false,
      };
    }
    const signal = view as SignalEvidenceView;
    const ageMs = nowMs - Date.parse(signal.observedAt);
    const staleByAge = ageMs > SIGNAL_STALENESS_WINDOW_MS;
    const freshEnough = signal.freshnessClass === "CURRENT" || signal.freshnessClass === "AGING";
    const active = signal.signalStatus === "OBSERVED" || signal.signalStatus === "CORROBORATED";
    const usable = active && freshEnough && !staleByAge && signal.relevanceClass !== "IRRELEVANT";
    return {
      view,
      usable,
      stale: !usable,
      assumption: false,
      contradictionActive: signal.signalStatus === "CONTRADICTED" || signal.corroborationStatus === "CONTRADICTED",
      quality: (usable ? SIGNAL_QUALITY[signal.sourceTrustClass] ?? 0 : 0) as 0 | 1 | 3,
      direction: null,
      family: familyForSignal(signal.signalType),
      corroborated: signal.corroborationStatus === "CORROBORATED" && signal.corroboratingSignalIds.length >= 1,
      singleSource: signal.sourceTrustClass === "SINGLE_EXTERNAL_SOURCE" || signal.sourceTrustClass === "UNVERIFIED",
    };
  });
}

// ─── Rule-first candidate synthesis ───

export interface SynthesisCandidate {
  readonly hypothesisType: StrategicHypothesisType;
  readonly implicationType: StrategicImplicationType;
  readonly priority: number;
  readonly anchorRefs: readonly string[];
  readonly supportRefs: readonly string[];
  readonly missingEvidence: readonly StrategicMissingEvidenceClass[];
  readonly rationaleCode: string;
}

interface RuleContext {
  descriptors: EvidenceDescriptor[];
  usableChanges: EvidenceDescriptor[];
  usableSignals: EvidenceDescriptor[];
  usableMemory: EvidenceDescriptor[];
  usableInternal: EvidenceDescriptor[];
  hasOutcomeAttributionAnchor: boolean;
}

function collectCandidates(ctx: RuleContext): SynthesisCandidate[] {
  const out: SynthesisCandidate[] = [];
  const usable = (d: EvidenceDescriptor) => d.usable;

  // ── 1. Resource mismatch (internal budget / provider capability) ──
  const resourceChanges = ctx.usableChanges.filter(
    (d) => d.direction === "RESOURCE_DECLINE" || d.direction === "RESOURCE_GROWTH"
  );
  for (const change of resourceChanges) {
    const loneWeakBudgetDecrease =
      change.direction === "RESOURCE_DECLINE" &&
      (change.view as ChangeEvidenceView).significanceClass === "LOW" &&
      ctx.usableChanges.length === 1 &&
      !ctx.hasOutcomeAttributionAnchor;
    if (loneWeakBudgetDecrease) {
      // Budget underperformance + weak/absent attribution ⇒ insufficient for
      // a strategic conclusion (contract §5 example).
      out.push({
        hypothesisType: "NO_ACTIONABLE_CONCLUSION",
        implicationType: "NO_ACTION",
        priority: 10,
        anchorRefs: [change.view.ref],
        supportRefs: [],
        missingEvidence: ["ATTRIBUTION_QUALITY"],
        rationaleCode: "BUDGET_UNDERPERFORMANCE_WEAK_ATTRIBUTION",
      });
      continue;
    }
    out.push({
      hypothesisType: "RESOURCE_MISMATCH",
      implicationType: "REVIEW_RESOURCE_PRIORITY",
      priority: 1,
      anchorRefs: [change.view.ref],
      supportRefs: ctx.usableInternal.filter((d) => d.view.ref !== change.view.ref).map((d) => d.view.ref),
      missingEvidence: [],
      rationaleCode:
        change.direction === "RESOURCE_DECLINE" ? "RESOURCE_CAPACITY_REMOVED" : "RESOURCE_CAPACITY_ADDED",
    });
  }

  // ── 2. Strategic alignment (objective / strategy / constraint change) ──
  const alignmentChanges = ctx.usableChanges.filter((d) => d.direction === "ALIGNMENT");
  for (const change of alignmentChanges) {
    const assumptionAnchors = ctx.usableMemory.filter((d) => d.assumption).map((d) => d.view.ref);
    out.push({
      hypothesisType: "STRATEGIC_ALIGNMENT",
      implicationType: assumptionAnchors.length > 0 ? "VALIDATE_ASSUMPTION" : "MONITOR",
      priority: 2,
      anchorRefs: [change.view.ref],
      supportRefs: [...assumptionAnchors, ...ctx.usableMemory.filter((d) => !d.assumption).map((d) => d.view.ref)],
      missingEvidence: [],
      rationaleCode: "INTERNAL_STRATEGIC_STATE_CHANGED",
    });
  }

  // ── 3. External-only regulatory / technology / competitive ──
  for (const signal of ctx.usableSignals) {
    if (signal.family === "REGULATORY") {
      out.push({
        hypothesisType: "REGULATORY_IMPLICATION",
        implicationType: "INVESTIGATE",
        priority: 3,
        anchorRefs: [signal.view.ref],
        supportRefs: ctx.usableSignals
          .filter((d) => d !== signal && d.family === "REGULATORY")
          .map((d) => d.view.ref),
        missingEvidence: [],
        rationaleCode: "EXTERNAL_REGULATORY_SIGNAL",
      });
    } else if (signal.family === "TECHNOLOGY") {
      out.push({
        hypothesisType: "TECHNOLOGY_IMPLICATION",
        implicationType: "MONITOR",
        priority: 4,
        anchorRefs: [signal.view.ref],
        supportRefs: ctx.usableSignals
          .filter((d) => d !== signal && d.family === "TECHNOLOGY")
          .map((d) => d.view.ref),
        missingEvidence: [],
        rationaleCode: "EXTERNAL_TECHNOLOGY_SIGNAL",
      });
    } else if (signal.family === "COMPETITOR") {
      out.push({
        hypothesisType: "COMPETITIVE_PRESSURE",
        implicationType: "MONITOR",
        priority: 5,
        anchorRefs: [signal.view.ref],
        supportRefs: ctx.usableSignals
          .filter((d) => d !== signal && d.family === "COMPETITOR")
          .map((d) => d.view.ref),
        missingEvidence: [],
        rationaleCode: "EXTERNAL_COMPETITOR_SIGNAL",
      });
    }
  }

  // ── 4. Composed decline / growth patterns (internal × external) ──
  const internalDecline = ctx.usableChanges.filter((d) => d.direction === "DECLINE");
  const internalGrowth = ctx.usableChanges.filter((d) => d.direction === "GROWTH");
  const demandSignals = ctx.usableSignals.filter((d) => d.family === "DEMAND");
  const demandCorroborated = demandSignals.filter((d) => d.corroborated);
  const demandUncorroborated = demandSignals.filter((d) => !d.corroborated);

  if (internalDecline.length > 0 && demandCorroborated.length > 0) {
    // Internal decline + externally corroborated demand signal ⇒ bounded
    // market-decline hypothesis (corroboration strengthens support).
    out.push({
      hypothesisType: "DECLINE_SIGNAL",
      implicationType: "REVIEW_MARKET_RESPONSE",
      priority: 6,
      anchorRefs: internalDecline.map((d) => d.view.ref),
      supportRefs: [...demandCorroborated.map((d) => d.view.ref), ...internalDecline.slice(1).map((d) => d.view.ref)],
      missingEvidence: [],
      rationaleCode: "INTERNAL_DECLINE_CORROBORATED_BY_EXTERNAL_DEMAND",
    });
  }
  if (internalDecline.length > 0 && demandSignals.length > 0 && demandCorroborated.length === 0) {
    // Internal decline without external corroboration ⇒ bounded internal-gap
    // hypothesis; the market claim remains unproven.
    out.push({
      hypothesisType: "BUSINESS_CAPABILITY_GAP",
      implicationType: "REVIEW_POSITIONING",
      priority: 7,
      anchorRefs: internalDecline.map((d) => d.view.ref),
      supportRefs: demandUncorroborated.map((d) => d.view.ref),
      missingEvidence: ["CORROBORATION"],
      rationaleCode: "INTERNAL_DECLINE_WITHOUT_EXTERNAL_CORROBORATION",
    });
  }
  if (internalDecline.length > 0 && demandSignals.length === 0) {
    // Internal-only decline ⇒ bounded decline hypothesis anchored on the
    // internal evidence alone (memory + change can form a valid hypothesis).
    out.push({
      hypothesisType: "DECLINE_SIGNAL",
      implicationType: "REVIEW_MARKET_RESPONSE",
      priority: 7,
      anchorRefs: internalDecline.map((d) => d.view.ref),
      supportRefs: ctx.usableMemory.map((d) => d.view.ref),
      missingEvidence: [],
      rationaleCode: "INTERNAL_DECLINE_ANCHORED",
    });
  }
  if (internalGrowth.length > 0 && demandSignals.length === 0) {
    out.push({
      hypothesisType: "GROWTH_SIGNAL",
      implicationType: "MONITOR",
      priority: 8,
      anchorRefs: internalGrowth.map((d) => d.view.ref),
      supportRefs: ctx.usableMemory.map((d) => d.view.ref),
      missingEvidence: [],
      rationaleCode: "INTERNAL_GROWTH_ANCHORED",
    });
  }
  if (internalGrowth.length > 0 && demandSignals.length > 0) {
    out.push({
      hypothesisType: "GROWTH_SIGNAL",
      implicationType: "MONITOR",
      priority: 8,
      anchorRefs: internalGrowth.map((d) => d.view.ref),
      supportRefs: demandSignals.map((d) => d.view.ref),
      missingEvidence: [],
      rationaleCode: "INTERNAL_GROWTH_WITH_EXTERNAL_DEMAND",
    });
  }

  // ── 5. Pure external market shift (no usable internal anchor) ──
  const hasUsableInternal = ctx.usableInternal.length > 0;
  if (!hasUsableInternal && demandSignals.length > 0) {
    out.push({
      hypothesisType: "MARKET_SHIFT",
      implicationType: "MONITOR",
      priority: 9,
      anchorRefs: demandSignals.map((d) => d.view.ref),
      supportRefs: [],
      missingEvidence: ["INTERNAL_PERFORMANCE_STATE"],
      rationaleCode: "EXTERNAL_DEMAND_WITHOUT_INTERNAL_ANCHOR",
    });
  }

  // ── 6. Fallback ──
  if (out.length === 0) {
    const anyUsable = ctx.descriptors.some(usable);
    out.push({
      hypothesisType: "NO_ACTIONABLE_CONCLUSION",
      implicationType: "NO_ACTION",
      priority: 11,
      anchorRefs: ctx.descriptors.filter(usable).map((d) => d.view.ref),
      supportRefs: [],
      missingEvidence: anyUsable ? [] : ["FRESH_INTERNAL_STATE"],
      rationaleCode: anyUsable ? "NO_RULE_MATCHED" : "ZERO_USABLE_EVIDENCE",
    });
  }
  return out;
}

// ─── Confidence / uncertainty (evidence-quality caps only) ───

function scoreToConfidence(score: number): StrategicConfidenceClass {
  if (score <= 0) return "INSUFFICIENT";
  if (score === 1) return "LOW";
  if (score === 2) return "MODERATE";
  return "HIGH";
}

export interface ConfidenceDerivation {
  readonly confidenceClass: StrategicConfidenceClass;
  readonly uncertaintyClasses: readonly StrategicUncertaintyClass[];
}

export function deriveConfidence(input: {
  candidate: SynthesisCandidate;
  descriptors: readonly EvidenceDescriptor[];
  allRefs: readonly string[];
}): ConfidenceDerivation {
  const { candidate, descriptors } = input;
  const involvedRefs = new Set([...candidate.anchorRefs, ...candidate.supportRefs]);
  const involved = descriptors.filter((d) => involvedRefs.has(d.view.ref));
  const usableInvolved = involved.filter((d) => d.usable);
  const usableInternal = involved.filter((d) => d.usable && d.view.evidenceClass !== "EXTERNAL_SIGNAL");
  const externalInvolved = involved.filter((d) => d.view.evidenceClass === "EXTERNAL_SIGNAL");
  const usableExternal = externalInvolved.filter((d) => d.usable);
  // The whole bound bundle is the reasoning scope: freshness, trust and
  // contradiction surface even when an item is not a selected support ref.
  const anyExternal = descriptors.some((d) => d.view.evidenceClass === "EXTERNAL_SIGNAL");
  const anyUsableInternal = descriptors.some((d) => d.usable && d.view.evidenceClass !== "EXTERNAL_SIGNAL");

  const uncertainties = new Set<StrategicUncertaintyClass>();
  const internalQuality = Math.max(0, ...usableInternal.map((d) => d.quality));
  const externalQuality = Math.max(0, ...usableExternal.map((d) => d.quality));
  const hasInternalAnchor = usableInternal.length > 0 && internalQuality > 0;

  if (descriptors.some((d) => !d.usable)) uncertainties.add("STALE_EVIDENCE");
  if (usableInvolved.some((d) => d.quality <= 1 && d.view.evidenceClass !== "EXTERNAL_SIGNAL")) uncertainties.add("WEAK_EVIDENCE");
  if (descriptors.some((d) => d.view.evidenceClass === "EXTERNAL_SIGNAL" && d.singleSource)) uncertainties.add("SINGLE_EXTERNAL_SOURCE");
  const assumptionMemoryInvolved = involved.some(
    (d) => d.view.evidenceClass === "INTERNAL_MEMORY" && d.assumption
  );
  const assumptionInvolved = usableInternal.filter((d) => d.assumption);
  if (assumptionInvolved.length > 0) uncertainties.add("ASSUMPTION_HEAVY");
  if (!anyUsableInternal && anyExternal) uncertainties.add("MISSING_INTERNAL_STATE");
  if (descriptors.some((d) => d.contradictionActive)) uncertainties.add("CONFLICTING_EVIDENCE");

  let score: number;
  if (!hasInternalAnchor) {
    // External-only reasoning can never exceed LOW (external alone never
    // becomes business fact).
    score = externalQuality >= 3 ? 1 : 0;
  } else if (usableExternal.length > 0 && externalQuality >= 3 && usableExternal.every((d) => d.corroborated)) {
    score = internalQuality >= 3 ? 3 : 2;
  } else if (usableExternal.length > 0) {
    score = Math.min(internalQuality, 2);
  } else {
    score = internalQuality;
  }

  // Caps (strongest applicable wins — never promotable by model or client).
  if (candidate.hypothesisType === "NO_ACTIONABLE_CONCLUSION" && score > 1) score = 1;
  if (usableInvolved.length === 0) score = 0;
  // Assumption-heavy memory caps confidence (contract §6).
  if (assumptionMemoryInvolved && score > 2) score = 2;
  if (descriptors.some((d) => d.contradictionActive) && score > 2) score = 2;
  if (descriptors.some((d) => d.view.evidenceClass === "EXTERNAL_SIGNAL" && d.singleSource) && score > 1) score = 1;
  if (!hasInternalAnchor && externalInvolved.length > 0 && score > 1) score = 1;

  return { confidenceClass: scoreToConfidence(score), uncertaintyClasses: [...uncertainties].sort() };
}

// ─── Model-candidate merge (untrusted; select-among-rule-output only) ───

export function applyModelCandidates(input: {
  candidates: readonly SynthesisCandidate[];
  selected: SynthesisCandidate;
  modelCandidateHypothesisTypes: readonly string[] | undefined;
}): SynthesisCandidate {
  const { candidates, selected, modelCandidateHypothesisTypes } = input;
  if (!modelCandidateHypothesisTypes || modelCandidateHypothesisTypes.length === 0) return selected;
  const requested = new Set(modelCandidateHypothesisTypes);
  if (requested.has(selected.hypothesisType)) return selected;
  // A model candidate may only promote a hypothesis the rule engine itself
  // produced — and only when the rule-selected conclusion is NO_ACTIONABLE.
  if (selected.hypothesisType !== "NO_ACTIONABLE_CONCLUSION") return selected;
  const promotable = candidates.filter(
    (c) => c.hypothesisType !== "NO_ACTIONABLE_CONCLUSION" && requested.has(c.hypothesisType)
  );
  if (promotable.length !== 1) return selected;
  return promotable[0];
}

// ─── Public synthesis result ───

export interface StrategicSynthesis {
  readonly hypothesisType: StrategicHypothesisType;
  readonly implicationType: StrategicImplicationType;
  readonly confidenceClass: StrategicConfidenceClass;
  readonly uncertaintyClasses: readonly StrategicUncertaintyClass[];
  readonly missingEvidence: readonly StrategicMissingEvidenceClass[];
  readonly rationaleCode: string;
  readonly supportingEvidence: ReadonlyArray<{ ref: string; evidenceClass: StrategicEvidenceClass; role: StrategicEvidenceRole }>;
  readonly contradictingEvidence: ReadonlyArray<{ ref: string; evidenceClass: StrategicEvidenceClass }>;
  readonly graph: ReasoningGraph;
}

export function synthesizeStrategicReasoning(input: {
  evidence: readonly StrategicEvidenceView[];
  nowMs: number;
  modelCandidateHypothesisTypes?: readonly string[];
}): StrategicSynthesis {
  const descriptors = describeEvidence(input.evidence, input.nowMs);
  const ctx: RuleContext = {
    descriptors,
    usableChanges: descriptors.filter((d) => d.usable && d.view.evidenceClass === "INTERNAL_CHANGE"),
    usableSignals: descriptors.filter((d) => d.usable && d.view.evidenceClass === "EXTERNAL_SIGNAL"),
    usableMemory: descriptors.filter((d) => d.usable && d.view.evidenceClass === "INTERNAL_MEMORY"),
    usableInternal: descriptors.filter((d) => d.usable && d.view.evidenceClass !== "EXTERNAL_SIGNAL"),
    hasOutcomeAttributionAnchor: descriptors.some(
      (d) =>
        d.view.evidenceClass === "INTERNAL_MEMORY" &&
        ((d.view as MemoryEvidenceView).sourceAuthority === "r7_outcome" ||
          (d.view as MemoryEvidenceView).sourceAuthority === "r7_attribution")
    ),
  };

  const candidates = collectCandidates(ctx).sort((a, b) => a.priority - b.priority);
  let selected = candidates[0];
  selected = applyModelCandidates({
    candidates,
    selected,
    modelCandidateHypothesisTypes: input.modelCandidateHypothesisTypes,
  });

  const confidence = deriveConfidence({ candidate: selected, descriptors, allRefs: descriptors.map((d) => d.view.ref) });

  // Supporting / contradicting accounting.
  const supportRefs = new Set([...selected.anchorRefs, ...selected.supportRefs]);
  const supporting: Array<{ ref: string; evidenceClass: StrategicEvidenceClass; role: StrategicEvidenceRole }> = [];
  const contradicting: Array<{ ref: string; evidenceClass: StrategicEvidenceClass }> = [];
  for (const d of descriptors) {
    if (!supportRefs.has(d.view.ref)) continue;
    if (d.contradictionActive) {
      contradicting.push({ ref: d.view.ref, evidenceClass: d.view.evidenceClass });
      continue;
    }
    const role: StrategicEvidenceRole = selected.anchorRefs.includes(d.view.ref)
      ? "ANCHOR"
      : d.usable
        ? "SUPPORT"
        : "CONTEXT";
    supporting.push({ ref: d.view.ref, evidenceClass: d.view.evidenceClass, role });
  }
  // Contradicted-but-unsupported evidence still stays visible.
  for (const d of descriptors) {
    if (d.contradictionActive && !supportRefs.has(d.view.ref)) {
      contradicting.push({ ref: d.view.ref, evidenceClass: d.view.evidenceClass });
    }
  }
  const supportingEvidence: StrategicSynthesis["supportingEvidence"] = supporting;
  const contradictingEvidence: StrategicSynthesis["contradictingEvidence"] = contradicting;

  // Cross-evidence contradiction pairs from upstream lineage (in-bundle only).
  const refSet = new Set(descriptors.map((d) => d.view.ref));
  const contradictionPairs: Array<readonly [string, string]> = [];
  for (const d of descriptors) {
    if (d.view.evidenceClass === "INTERNAL_MEMORY") {
      for (const other of (d.view as MemoryEvidenceView).contradictsMemoryIds) {
        if (refSet.has(other)) contradictionPairs.push([d.view.ref, other]);
      }
    } else if (d.view.evidenceClass === "EXTERNAL_SIGNAL") {
      for (const other of (d.view as SignalEvidenceView).contradictingSignalIds) {
        if (refSet.has(other)) contradictionPairs.push([d.view.ref, other]);
      }
    }
  }

  // Graph edges: SUPPORTS for usable support, LIMITS for stale/assumption
  // support, CONTEXTUALISES for context, CONTRADICTS handled as pairs.
  const graph = buildReasoningGraph({
    evidence: descriptors
      .filter((d) => supportRefs.has(d.view.ref))
      .map((d) => {
        const types: Array<"SUPPORTS" | "CONTEXTUALISES" | "LIMITS"> = [];
        if (d.contradictionActive) types.push("LIMITS");
        else if (!d.usable) types.push("CONTEXTUALISES");
        else {
          types.push("SUPPORTS");
          if (d.assumption || d.stale) types.push("LIMITS");
        }
        return {
          ref: d.view.ref,
          evidenceClass: d.view.evidenceClass,
          role: selected.anchorRefs.includes(d.view.ref) ? ("ANCHOR" as const) : d.usable ? ("SUPPORT" as const) : ("CONTEXT" as const),
          edgeTypes: types,
        };
      }),
    contradictionPairs,
  });

  return {
    hypothesisType: selected.hypothesisType,
    implicationType: selected.implicationType,
    confidenceClass: confidence.confidenceClass,
    uncertaintyClasses: confidence.uncertaintyClasses,
    missingEvidence: [...new Set(selected.missingEvidence)].sort(),
    rationaleCode: selected.rationaleCode,
    supportingEvidence,
    contradictingEvidence,
    graph,
  };
}
