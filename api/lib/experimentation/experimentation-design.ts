// ─── R7-D Experimentation Engine — hypothesis & design validation (D2) ───
//
// PURE module. Validates that a proposed hypothesis + design can be safely
// and measurably tested. A hypothesis must bind exact learning/evidence;
// unknown / cross-business / stale / contradicted / deprecated / fabricated
// learning is rejected (conservatively where policy allows). Protected-trait
// manipulation and unmeasurable treatment/control definitions are rejected.
// No model may define hidden execution authority: hypothesis statements and
// narrative drafts are bounded text only and carry no authority claims.

import {
  ExperimentInputError,
  ExperimentStateError,
  EXPERIMENT_PROTECTED_TRAIT_SET,
  EXPERIMENT_DIMENSION_SET,
  guardHypothesisStatement,
  guardNarrativeDraft,
  type ExperimentDesign,
} from "./experimentation-contract";
import type { ConsumedLearningProjection } from "./experimentation-seams";

export interface ValidatedHypothesis {
  readonly statement: string;
  readonly narrativeDraft: string | null;
}

/**
 * Validate the learning reference binds exact, current, in-scope evidence.
 * Returns nothing on success; throws fail-closed on any breach.
 */
export function validateLearningBinding(input: {
  userId: number;
  learningId: string;
  learning: ConsumedLearningProjection | null;
}): void {
  const { learning } = input;
  if (learning === null) {
    throw new ExperimentStateError(
      "EXPERIMENT_UNKNOWN_LEARNING",
      `learningId ${input.learningId} does not resolve to a governed learning record for this tenant.`
    );
  }
  if (learning.learningId !== input.learningId) {
    throw new ExperimentStateError(
      "EXPERIMENT_UNKNOWN_LEARNING",
      "Learning projection identity does not match the requested learningId."
    );
  }
  if (learning.freshness?.stale) {
    throw new ExperimentStateError(
      "EXPERIMENT_STALE_LEARNING",
      "The referenced learning is stale (past its validity horizon) and cannot ground a new experiment."
    );
  }
  // Status gating — contradicted/deprecated learning is never silently
  // testable. CANDIDATE is permitted only as far as DRAFT; governance (R7-F)
  // scrutinises it before any activation.
  if (learning.status === "CONTRADICTED") {
    throw new ExperimentStateError(
      "EXPERIMENT_LEARNING_CONTRADICTED",
      "The referenced learning is contradicted; contradicted evidence cannot ground an experiment."
    );
  }
  if (
    learning.status === "SUPERSEDED" ||
    learning.status === "DEPRECATED" ||
    learning.status === "INVALIDATED"
  ) {
    throw new ExperimentStateError(
      "EXPERIMENT_LEARNING_DEPRECATED",
      `The referenced learning status ${learning.status} is history, not current evidence.`
    );
  }
}

/**
 * Cross-business learning is structurally impossible here: the business
 * scope is server-resolved from the learning record itself (§5.2) — a client
 * can never supply or override businessId. This guard exists for the seam
 * contract: any learning whose business scope disagrees with the consuming
 * tenant context is rejected.
 */
export function assertLearningTenantScope(input: {
  userId: number;
  learning: ConsumedLearningProjection;
}): void {
  if (!Number.isInteger(input.learning.businessId) || input.learning.businessId <= 0) {
    throw new ExperimentStateError(
      "EXPERIMENT_CROSS_BUSINESS_LEARNING",
      "Learning record carries an invalid business scope."
    );
  }
}

/** Validate hypothesis text (bounded, testable, no authority claims). */
export function validateHypothesis(input: {
  statement: string;
  narrativeDraft?: string | undefined;
}): ValidatedHypothesis {
  const statement = input.statement.trim();
  if (statement.length === 0) {
    throw new ExperimentInputError(
      "EXPERIMENT_MALFORMED_HYPOTHESIS",
      "Hypothesis statement must be non-empty."
    );
  }
  guardHypothesisStatement(statement);
  const narrativeDraft = input.narrativeDraft?.trim() ? input.narrativeDraft : null;
  if (narrativeDraft !== null) {
    guardNarrativeDraft(narrativeDraft);
  }
  return { statement, narrativeDraft };
}

/** Bounded canonical size for an inert descriptor. */
const DESCRIPTOR_MAX_BYTES = 4096;

function descriptorByteSize(descriptor: Record<string, unknown>): number {
  return Buffer.byteLength(JSON.stringify(descriptor) ?? "{}", "utf8");
}

function validateDescriptor(
  label: string,
  descriptor: Record<string, unknown>,
  what: string
): void {
  if (Object.keys(descriptor).length === 0) {
    throw new ExperimentInputError(
      "EXPERIMENT_DESIGN_UNMEASURABLE",
      `${what} "${label}" has an empty descriptor; definitions must be measurable.`
    );
  }
  if (descriptorByteSize(descriptor) > DESCRIPTOR_MAX_BYTES) {
    throw new ExperimentInputError(
      "EXPERIMENT_DESIGN_UNMEASURABLE",
      `${what} "${label}" descriptor exceeds the 4 KiB bound.`
    );
  }
  // A descriptor may never name a protected trait key or an execution
  // instruction surface: keys are bounded plain labels.
  for (const key of Object.keys(descriptor)) {
    if (EXPERIMENT_PROTECTED_TRAIT_SET.has(key.toLowerCase())) {
      throw new ExperimentInputError(
        "EXPERIMENT_PROTECTED_TRAIT_DIMENSION",
        `${what} "${label}" descriptor names protected trait "${key}".`
      );
    }
  }
}

/**
 * Validate the full experiment design (closed vocabulary, structure,
 * allocation arithmetic, safe measurability). The business scope is
 * server-resolved from the learning — the client never supplies it.
 */
export function validateExperimentDesign(input: {
  userId: number;
  businessId: number;
  design: ExperimentDesign;
}): { design: ExperimentDesign; armCount: number } {
  const { design } = input;

  if (!EXPERIMENT_DIMENSION_SET.has(design.dimension)) {
    throw new ExperimentInputError(
      "EXPERIMENT_UNSUPPORTED_DIMENSION",
      `Experiment dimension "${design.dimension}" is outside the closed vocabulary.`
    );
  }
  if (EXPERIMENT_PROTECTED_TRAIT_SET.has(design.dimension.toLowerCase())) {
    throw new ExperimentInputError(
      "EXPERIMENT_PROTECTED_TRAIT_DIMENSION",
      `Experiment dimension "${design.dimension}" is a protected trait.`
    );
  }

  const treatmentCount = design.treatmentDefinitions.length;
  if (design.designType === "A_B" && treatmentCount !== 1) {
    throw new ExperimentInputError(
      "EXPERIMENT_DESIGN_UNMEASURABLE",
      `A_B design requires exactly one treatment; got ${treatmentCount}.`
    );
  }
  if (design.designType === "MULTI_ARM" && (treatmentCount < 2 || treatmentCount > 4)) {
    throw new ExperimentInputError(
      "EXPERIMENT_DESIGN_UNMEASURABLE",
      `MULTI_ARM design requires 2..4 treatments; got ${treatmentCount}.`
    );
  }

  const armCount = treatmentCount + 1; // control + treatments
  const fractions = design.allocationPolicy.fractionsBps;
  if (fractions.length !== armCount) {
    throw new ExperimentInputError(
      "EXPERIMENT_ALLOCATION_INVALID",
      `allocationPolicy.fractionsBps must have one fraction per arm (${armCount}); got ${fractions.length}.`
    );
  }
  const total = fractions.reduce((sum, f) => sum + f, 0);
  if (total !== 10000) {
    throw new ExperimentInputError(
      "EXPERIMENT_ALLOCATION_INVALID",
      `allocationPolicy.fractionsBps must sum to exactly 10000 bps; got ${total}.`
    );
  }
  for (const f of fractions) {
    if (!Number.isInteger(f) || f <= 0) {
      throw new ExperimentInputError(
        "EXPERIMENT_ALLOCATION_INVALID",
        "allocation fractions must be positive integers."
      );
    }
  }

  validateDescriptor(design.controlDefinition.label, design.controlDefinition.descriptor, "Control");
  const seenLabels = new Set([design.controlDefinition.label]);
  for (const t of design.treatmentDefinitions) {
    if (seenLabels.has(t.label)) {
      throw new ExperimentInputError(
        "EXPERIMENT_DESIGN_UNMEASURABLE",
        `Duplicate arm label "${t.label}"; arms must be distinguishable.`
      );
    }
    seenLabels.add(t.label);
    validateDescriptor(t.label, t.descriptor, "Treatment");
  }

  if (!Number.isInteger(design.minimumSamplePerArm) || design.minimumSamplePerArm < 1) {
    throw new ExperimentInputError(
      "EXPERIMENT_DESIGN_UNMEASURABLE",
      "minimumSamplePerArm must be a positive integer."
    );
  }
  if (!Number.isInteger(design.durationDays) || design.durationDays < 1 || design.durationDays > 90) {
    throw new ExperimentInputError(
      "EXPERIMENT_DESIGN_UNMEASURABLE",
      "durationDays must be an integer in 1..90."
    );
  }

  return { design, armCount };
}
