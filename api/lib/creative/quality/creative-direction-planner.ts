/**
 * Creative Direction Planner.
 *
 * Slice 4 scope:
 * - compile up to three materially distinct design direction plans from an
 *   approved CreativeContract;
 * - deterministically fingerprint each direction;
 * - mark a direction unavailable when the contract lacks supporting evidence;
 * - mark a direction unavailable when it is not materially distinct from at least
 *   one other available direction in at least two structural categories;
 * - never invent testimonials, awards, statistics, guarantees, discounts, prices,
 *   free trials, accreditations, customer counts, outcomes or capabilities.
 *
 * This module is provider-free and observation-only.
 */

import { createHash } from "crypto";
import type { ApprovedCreativeContract } from "../contracts/creative-contract";

export type CreativeDirectionKey = "authority_led" | "benefit_led" | "proof_led";

export interface CreativeDirectionPlan {
  directionId: string;
  workflowOperationId: string;
  contractFingerprint: string;
  directionKey: CreativeDirectionKey;
  ordinal: 1 | 2 | 3;
  available: boolean;
  unavailableReasonCode: string | null;
  communicationPriority: string;
  headlineRole: string;
  supportingMessageRole: string;
  visualHierarchy: string[];
  layoutIntent: string;
  imageIntent: string | null;
  colourIntent: string[];
  typographyIntent: string[];
  ctaPlacementIntent: string;
  /** Evidence IDs that specifically support this direction's angle. */
  evidenceIds: string[];
  /** Traceable authority evidence IDs used by the authority-led direction. */
  authorityEvidenceIds: string[];
  lockedContent: {
    businessName: string | null;
    cta: string;
    offer: string | null;
    requiredContactDetails: string[];
  };
  directionFingerprint: string;
}

export interface DirectionPlannerResult {
  directionPlanFingerprint: string;
  plannedDirectionCount: number;
  availableDirectionCount: number;
  unavailableDirectionCodes: string[];
  /** True when every available direction differs from at least one other available
   *  direction in at least two structural categories. */
  materialDistinctnessPassed: boolean;
  /** Number of structural categories in which the most-distinct pair differs. */
  distinctCategoryCount: number;
  /** Category codes that contribute to the most-distinct pair's distinctness. */
  distinctCategoryCodes: string[];
  directions: CreativeDirectionPlan[];
}

export interface DirectionIdentityInput {
  workflowOperationId: string;
  contractFingerprint: string;
  directionKey: CreativeDirectionKey;
  ordinal: 1 | 2 | 3;
}

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    if (typeof value === "string") return value.trim().replace(/\s+/g, " ");
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  const sorted: Record<string, unknown> = {};
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = sortKeys(obj[key]);
  }
  return sorted;
}

function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function buildDirectionId(input: DirectionIdentityInput): string {
  const payload = {
    workflowOperationId: input.workflowOperationId,
    contractFingerprint: input.contractFingerprint,
    directionKey: input.directionKey,
    ordinal: input.ordinal,
  };
  return sha256(canonicalize(payload));
}

export function buildDirectionFingerprint(
  plan: Omit<CreativeDirectionPlan, "directionId" | "directionFingerprint">
): string {
  const payload = {
    workflowOperationId: plan.workflowOperationId,
    contractFingerprint: plan.contractFingerprint,
    directionKey: plan.directionKey,
    ordinal: plan.ordinal,
    available: plan.available,
    unavailableReasonCode: plan.unavailableReasonCode,
    communicationPriority: plan.communicationPriority,
    headlineRole: plan.headlineRole,
    supportingMessageRole: plan.supportingMessageRole,
    visualHierarchy: plan.visualHierarchy,
    layoutIntent: plan.layoutIntent,
    imageIntent: plan.imageIntent,
    colourIntent: plan.colourIntent,
    typographyIntent: plan.typographyIntent,
    ctaPlacementIntent: plan.ctaPlacementIntent,
    evidenceIds: plan.evidenceIds.slice().sort(),
    authorityEvidenceIds: plan.authorityEvidenceIds.slice().sort(),
    lockedContent: {
      businessName: plan.lockedContent.businessName,
      cta: plan.lockedContent.cta,
      offer: plan.lockedContent.offer,
      requiredContactDetails: plan.lockedContent.requiredContactDetails.slice().sort(),
    },
  };
  return sha256(canonicalize(payload));
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

function classifyAuthorityEvidenceIds(contract: ApprovedCreativeContract): string[] {
  const approvedAuthorityIds = new Set(
    contract.approvedEvidence
      .filter((evidence) => evidence.classification === "authority")
      .map((evidence) => evidence.evidenceId)
  );
  return [...new Set(contract.authorityEvidenceIds)]
    .filter((evidenceId) => approvedAuthorityIds.has(evidenceId))
    .sort();
}

function buildAuthorityLed(
  input: DirectionPlannerInput,
  ordinal: 1 | 2 | 3
): CreativeDirectionPlan {
  const authorityEvidenceIds = classifyAuthorityEvidenceIds(input.contract);
  const hasAuthorityEvidence = authorityEvidenceIds.length > 0;

  const plan: CreativeDirectionPlan = {
    directionId: "", // filled after fingerprint
    workflowOperationId: input.workflowOperationId,
    contractFingerprint: input.contract.contractFingerprint,
    directionKey: "authority_led",
    ordinal,
    available: hasAuthorityEvidence,
    unavailableReasonCode: hasAuthorityEvidence ? null : "AUTHORITY_EVIDENCE_MISSING",
    communicationPriority: "Establish institutional role and approved evidence",
    headlineRole: "Lead with business role and substantiated capability",
    supportingMessageRole: "Reinforce through approved facts and brand-safe language",
    visualHierarchy: [
      "business identity / logo",
      "role headline",
      "approved capability proof points",
      "CTA",
    ],
    layoutIntent: "balanced editorial / role-first",
    imageIntent: "professional context imagery",
    colourIntent: ["brand primary", "neutral tones"],
    typographyIntent: ["confident headline weight", "clear body typography"],
    ctaPlacementIntent: "prominent lower-right or central placement",
    evidenceIds: authorityEvidenceIds,
    authorityEvidenceIds,
    lockedContent: {
      businessName: input.contract.businessName ?? null,
      cta: input.contract.cta.text,
      offer: input.contract.offer.text,
      requiredContactDetails: input.contract.requiredContactDetails.slice().sort(),
    },
    directionFingerprint: "", // filled below
  };
  plan.directionFingerprint = buildDirectionFingerprint(plan);
  plan.directionId = buildDirectionId({
    workflowOperationId: input.workflowOperationId,
    contractFingerprint: input.contract.contractFingerprint,
    directionKey: "authority_led",
    ordinal,
  });
  return plan;
}

function buildBenefitLed(
  input: DirectionPlannerInput,
  ordinal: 1 | 2 | 3
): CreativeDirectionPlan {
  // Only genuinely grounded benefits with traceable evidence can support a
  // benefit-led direction. Ungrounded placeholder benefits do not count.
  const groundedBenefits = input.contract.groundedBenefitEvidence.filter(
    (b) => b.validationStatus === "grounded" && b.evidenceIds.length > 0
  );
  const evidenceIds = uniqueSorted(groundedBenefits.flatMap((b) => b.evidenceIds));
  const plan: CreativeDirectionPlan = {
    directionId: "",
    workflowOperationId: input.workflowOperationId,
    contractFingerprint: input.contract.contractFingerprint,
    directionKey: "benefit_led",
    ordinal,
    available: groundedBenefits.length > 0,
    unavailableReasonCode: groundedBenefits.length === 0 ? "BENEFIT_EVIDENCE_MISSING" : null,
    communicationPriority: "Lead with the most important grounded customer benefit",
    headlineRole: "Lead with customer outcome and concrete benefit",
    supportingMessageRole: "Substantiate the benefit with approved evidence",
    visualHierarchy: [
      "benefit headline",
      "supporting evidence",
      "customer context",
      "CTA",
    ],
    layoutIntent: "benefit-first / card or hero layout",
    imageIntent: "customer-outcome or service-in-use imagery",
    colourIntent: ["brand primary", "benefit-highlight accent"],
    typographyIntent: ["benefit-led headline", "readable evidence text"],
    ctaPlacementIntent: "prominent below primary benefit",
    evidenceIds,
    authorityEvidenceIds: [],
    lockedContent: {
      businessName: input.contract.businessName ?? null,
      cta: input.contract.cta.text,
      offer: input.contract.offer.text,
      requiredContactDetails: input.contract.requiredContactDetails.slice().sort(),
    },
    directionFingerprint: "",
  };
  plan.directionFingerprint = buildDirectionFingerprint(plan);
  plan.directionId = buildDirectionId({
    workflowOperationId: input.workflowOperationId,
    contractFingerprint: input.contract.contractFingerprint,
    directionKey: "benefit_led",
    ordinal,
  });
  return plan;
}

function buildProofLed(
  input: DirectionPlannerInput,
  ordinal: 1 | 2 | 3
): CreativeDirectionPlan {
  // Proof-led depends on traceable evidence IDs. If the contract has no
  // evidence-backed benefits, the direction is unavailable.
  const traceableEvidence = input.contract.groundedBenefitEvidence.filter(
    (b) => b.evidenceIds.length > 0
  );
  const evidenceIds = uniqueSorted(traceableEvidence.flatMap((b) => b.evidenceIds));
  const plan: CreativeDirectionPlan = {
    directionId: "",
    workflowOperationId: input.workflowOperationId,
    contractFingerprint: input.contract.contractFingerprint,
    directionKey: "proof_led",
    ordinal,
    available: traceableEvidence.length > 0,
    unavailableReasonCode: traceableEvidence.length === 0 ? "PROOF_EVIDENCE_MISSING" : null,
    communicationPriority: "Substantiate with approved evidence and traceable facts",
    headlineRole: "Lead with substantiated proof point",
    supportingMessageRole: "Connect evidence to customer outcome",
    visualHierarchy: [
      "proof headline",
      "evidence references",
      "capability detail",
      "CTA",
    ],
    layoutIntent: "proof-led / editorial detail",
    imageIntent: "evidence or process imagery",
    colourIntent: ["brand primary", "data/evidence neutral tones"],
    typographyIntent: ["precise headline", "evidence labels"],
    ctaPlacementIntent: "prominent after proof block",
    evidenceIds,
    authorityEvidenceIds: [],
    lockedContent: {
      businessName: input.contract.businessName ?? null,
      cta: input.contract.cta.text,
      offer: input.contract.offer.text,
      requiredContactDetails: input.contract.requiredContactDetails.slice().sort(),
    },
    directionFingerprint: "",
  };
  plan.directionFingerprint = buildDirectionFingerprint(plan);
  plan.directionId = buildDirectionId({
    workflowOperationId: input.workflowOperationId,
    contractFingerprint: input.contract.contractFingerprint,
    directionKey: "proof_led",
    ordinal,
  });
  return plan;
}

export interface DirectionPlannerInput {
  workflowOperationId: string;
  contract: ApprovedCreativeContract;
}

type StructuralCategoryCode =
  | "communicationPriority"
  | "headlineRole"
  | "supportingMessageRole"
  | "visualHierarchy"
  | "layoutIntent"
  | "ctaPlacementIntent"
  | "imageIntent";

const STRUCTURAL_CATEGORIES: StructuralCategoryCode[] = [
  "communicationPriority",
  "headlineRole",
  "supportingMessageRole",
  "visualHierarchy",
  "layoutIntent",
  "ctaPlacementIntent",
  "imageIntent",
];

function isCategoryDistinct(
  a: CreativeDirectionPlan,
  b: CreativeDirectionPlan,
  category: StructuralCategoryCode
): boolean {
  const va = a[category];
  const vb = b[category];

  if (category === "visualHierarchy") {
    if (!Array.isArray(va) || !Array.isArray(vb)) return false;
    const setA = new Set((va as string[]).map(normalize));
    const setB = new Set((vb as string[]).map(normalize));
    if (setA.size !== setB.size) return true;
    for (const item of setA) {
      if (!setB.has(item)) return true;
    }
    return false;
  }

  if (category === "imageIntent") {
    // null vs non-null counts as distinct; otherwise compare normalized strings.
    if (va === null && vb !== null) return true;
    if (va !== null && vb === null) return true;
    if (va === null || vb === null) return false;
    return normalize(va as string) !== normalize(vb as string);
  }

  return normalize(String(va)) !== normalize(String(vb));
}

function computeMaterialDistinctness(
  directions: CreativeDirectionPlan[]
): {
  materialDistinctnessPassed: boolean;
  distinctCategoryCount: number;
  distinctCategoryCodes: string[];
  updatedDirections: CreativeDirectionPlan[];
} {
  // Work only with directions that are already evidence-available.
  const availableIndexes = directions
    .map((d, i) => ({ d, i }))
    .filter(({ d }) => d.available)
    .map(({ i }) => i);

  // If fewer than 2 directions are available, material distinctness is trivially satisfied.
  if (availableIndexes.length < 2) {
    return {
      materialDistinctnessPassed: true,
      distinctCategoryCount: 0,
      distinctCategoryCodes: [],
      updatedDirections: directions,
    };
  }

  // Pairwise distinct category sets.
  const pairwiseDistinctCategories = new Map<string, StructuralCategoryCode[]>();
  for (let i = 0; i < availableIndexes.length; i++) {
    for (let j = i + 1; j < availableIndexes.length; j++) {
      const idxA = availableIndexes[i];
      const idxB = availableIndexes[j];
      const a = directions[idxA];
      const b = directions[idxB];
      const distinctCategories = STRUCTURAL_CATEGORIES.filter((cat) =>
        isCategoryDistinct(a, b, cat)
      );
      pairwiseDistinctCategories.set(`${idxA}-${idxB}`, distinctCategories);
    }
  }

  // Determine which available directions are materially distinct from at least
  // one other available direction in two or more structural categories.
  const materiallyDistinct = new Set<number>();
  for (const [key, categories] of pairwiseDistinctCategories.entries()) {
    if (categories.length >= 2) {
      const [a, b] = key.split("-").map(Number);
      materiallyDistinct.add(a);
      materiallyDistinct.add(b);
    }
  }

  // Mark directions that fail material distinctness as unavailable.
  const updatedDirections = directions.map((d, i) => {
    if (!d.available) return d;
    if (!materiallyDistinct.has(i)) {
      return {
        ...d,
        available: false,
        unavailableReasonCode: "MATERIAL_DISTINCTNESS_FAILED",
      };
    }
    return d;
  });

  // Find the most-distinct pair.
  let maxDistinctCount = 0;
  let maxDistinctCategories: StructuralCategoryCode[] = [];
  for (const categories of pairwiseDistinctCategories.values()) {
    if (categories.length > maxDistinctCount) {
      maxDistinctCount = categories.length;
      maxDistinctCategories = categories;
    }
  }

  const remainingAvailable = updatedDirections.filter((d) => d.available);
  const materialDistinctnessPassed =
    remainingAvailable.length >= 2 &&
    remainingAvailable.every((d) => {
      const idx = updatedDirections.indexOf(d);
      return materiallyDistinct.has(idx);
    });

  return {
    materialDistinctnessPassed,
    distinctCategoryCount: maxDistinctCount,
    distinctCategoryCodes: maxDistinctCategories,
    updatedDirections,
  };
}

export function compileDirectionPlans(input: DirectionPlannerInput): DirectionPlannerResult {
  const authorityLed = buildAuthorityLed(input, 1);
  const benefitLed = buildBenefitLed(input, 2);
  const proofLed = buildProofLed(input, 3);

  let directions: CreativeDirectionPlan[] = [authorityLed, benefitLed, proofLed];

  const {
    materialDistinctnessPassed,
    distinctCategoryCount,
    distinctCategoryCodes,
    updatedDirections,
  } = computeMaterialDistinctness(directions);

  directions = updatedDirections;

  const availableDirectionCount = directions.filter((d) => d.available).length;
  const unavailableDirectionCodes = directions
    .filter((d) => !d.available && d.unavailableReasonCode)
    .map((d) => d.unavailableReasonCode!);

  const directionPlanFingerprint = sha256(
    canonicalize(
      directions.map((d) => ({
        directionId: d.directionId,
        directionFingerprint: d.directionFingerprint,
        available: d.available,
      }))
    )
  );

  return {
    directionPlanFingerprint,
    plannedDirectionCount: directions.length,
    availableDirectionCount,
    unavailableDirectionCodes,
    materialDistinctnessPassed,
    distinctCategoryCount,
    distinctCategoryCodes,
    directions,
  };
}
