// ─── R8-F Strategic Intelligence Governance — strategic risk classification (F4) ───
//
// SERVER-DERIVED strategic risk. The client (reasoning agent) may DECLARE
// impact descriptors as proposal material; each declared descriptor can only
// ever RAISE risk, never lower it. There is no client-supplied risk field at
// all — any attempt to supply one is rejected at proposal build
// (CLIENT_AUTHORITY_FIELD_REJECTED; AC29 "an agent cannot lower its own risk
// class").
//
// Risk rises for recommendations involving (charter F4): major business
// priority changes, material budget implications, entering/exiting a market,
// sensitive audience changes, high reputational risk, significant
// product/brand positioning change, high uncertainty, and reliance on weak
// external evidence. HIGH/CRITICAL recommendations never autonomously become
// executable — risk disposition maps them to REVIEW_REQUIRED/BLOCK and the
// only gate downstream produces advisory-consumption authority, never
// execution authority.
//
// Pure module: no I/O, no clock, no state.

import {
  STRATEGIC_RISK_CLASSES,
  type StrategicRiskClass,
} from "./strategic-governance-contract";
import {
  baseRiskOrdinalForRecommendation,
  type StrategicRecommendationType,
} from "./strategic-recommendation-taxonomy";

/**
 * Closed set of client-declarable impact descriptors. Declarations are
 * proposal MATERIAL: each can only raise the server-derived risk ordinal.
 * Omitting a declaration can never raise risk, and no declaration exists that
 * lowers it.
 */
export const STRATEGIC_IMPACT_DECLARATIONS = [
  "budgetMateriality",
  "marketEntryExit",
  "sensitiveAudienceChange",
  "reputationalRisk",
  "brandPositioningChange",
  "highUncertainty",
  "externalReliance",
] as const;
export type StrategicImpactDeclaration = (typeof STRATEGIC_IMPACT_DECLARATIONS)[number];

export interface StrategicDeclaredImpact {
  readonly budgetMateriality: boolean;
  readonly marketEntryExit: boolean;
  readonly sensitiveAudienceChange: boolean;
  readonly reputationalRisk: boolean;
  readonly brandPositioningChange: boolean;
  readonly highUncertainty: boolean;
  readonly externalReliance: boolean;
}

export const EMPTY_DECLARED_IMPACT: StrategicDeclaredImpact = Object.freeze({
  budgetMateriality: false,
  marketEntryExit: false,
  sensitiveAudienceChange: false,
  reputationalRisk: false,
  brandPositioningChange: false,
  highUncertainty: false,
  externalReliance: false,
});

/** Ordinal → closed risk class. */
export function strategicRiskClassFromOrdinal(ordinal: number): StrategicRiskClass {
  const clamped = Math.max(0, Math.min(STRATEGIC_RISK_CLASSES.length - 1, ordinal));
  return STRATEGIC_RISK_CLASSES[clamped];
}

export interface DeriveStrategicRiskInput {
  readonly recommendationType: StrategicRecommendationType;
  readonly declaredImpact: StrategicDeclaredImpact;
  /** True when the proposal relies on weak (single-source/unverified) external evidence. */
  readonly weakExternalEvidenceReliance: boolean;
  /** True when prompt-injection suspicion fired (F6). */
  readonly injectionSuspected: boolean;
}

export interface DerivedStrategicRisk {
  readonly riskClass: StrategicRiskClass;
  /** True when any declared impact descriptor actually raised the ordinal. */
  readonly raisedByDeclaration: boolean;
}

/**
 * Derive the strategic risk class: base ordinal by recommendation type, raised
 * (never lowered) by declared impact descriptors, weak external evidence
 * reliance, and injection suspicion. Monotonic upward only.
 */
export function deriveStrategicRisk(input: DeriveStrategicRiskInput): DerivedStrategicRisk {
  const base = baseRiskOrdinalForRecommendation(input.recommendationType);
  let ordinal = base;
  let raisedByDeclaration = false;

  const d = input.declaredImpact;
  // Material strategic impact descriptors: each adds one tier.
  if (
    d.budgetMateriality ||
    d.marketEntryExit ||
    d.sensitiveAudienceChange ||
    d.reputationalRisk ||
    d.brandPositioningChange
  ) {
    ordinal += 1;
    raisedByDeclaration = true;
  }
  if (d.highUncertainty) {
    ordinal += 1;
    raisedByDeclaration = true;
  }
  if (d.externalReliance && input.weakExternalEvidenceReliance) {
    ordinal += 1;
    raisedByDeclaration = true;
  }
  if (input.injectionSuspected) {
    // Injection suspicion is authority-neutral: it raises risk (up to
    // CRITICAL) so the recommendation can never flow autonomously, but it
    // never widens authority (F6).
    ordinal += 2;
  }

  return {
    riskClass: strategicRiskClassFromOrdinal(ordinal),
    raisedByDeclaration,
  };
}
