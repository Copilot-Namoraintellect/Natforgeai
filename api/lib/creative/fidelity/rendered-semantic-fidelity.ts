/**
 * Rendered Semantic Fidelity Evaluator (WBS12E).
 *
 * Deterministic post-render semantic fidelity evaluation.
 *
 * Scope:
 * - compares the semantic content actually rendered into a creative artifact
 *   against the approved semantic intent (an ApprovedCreativeContract plus the
 *   approved headline carried by the approved message pack / campaign core
 *   message);
 * - returns explicit pass/fail reasons for every check;
 * - detects missing approved headline / CTA / offer / claims;
 * - detects claims introduced by the render that are not backed by approved
 *   evidence, including prohibited claims;
 * - is pure: it never rewrites content, never calls providers, never reads
 *   rendered bytes, never writes state, and never changes workflow status;
 * - is deterministic: no clocks, no randomness, stable result ordering.
 *
 * Fail-closed posture: a rendered field required by the approved intent that
 * is absent or blank is a failure, never a silent pass. When the supplied
 * contract is not an approved contract, every semantic check fails closed as
 * not authoritative.
 *
 * This module intentionally does not integrate with renderers, providers,
 * databases, workflow registries, or the quality-authority observer; it is a
 * standalone evaluation primitive to be wired at a finalization seam by its
 * owner.
 */

import type { ApprovedCreativeContract } from "../contracts/creative-contract";
import {
  compileEvidenceSet,
  isDistinctBenefit,
  isInventedOffer,
  isUnsupportedClaim,
  validateClaim,
  validateOffer,
  type EvidenceSet,
  type GroundedBenefit,
} from "../contracts/grounded-evidence";
import { normalizeCtaText } from "../cta-utils";

export const RENDERED_SEMANTIC_FIDELITY_EVALUATOR_VERSION =
  "wbs12e.rendered-semantic-fidelity.v1";

/**
 * Semantic content observed on the rendered artifact. Fields the caller could
 * not observe post-render must be omitted or null; omitted/null fields are
 * treated as missing for required approved elements and are skipped for
 * introduced-claim detection.
 */
export interface RenderedCreativeSemanticContent {
  headline?: string | null;
  subheadline?: string | null;
  body?: string | null;
  cta?: string | null;
  offer?: string | null;
  /** Rendered claims / benefit statements (e.g. leaflet service bullets). */
  claims?: readonly string[];
  /** Rendered contact detail labels/values. */
  contactDetails?: readonly string[];
  businessName?: string | null;
}

export interface EvaluateRenderedSemanticFidelityInput {
  /** Approved semantic intent. Must be an ApprovedCreativeContract. */
  contract: ApprovedCreativeContract;
  /**
   * Approved headline text (e.g. ApprovedMessagePack.copy.headline). Optional:
   * when absent, headline presence is not required and the headline check is
   * reported as not_applicable.
   */
  approvedHeadline?: string | null;
  /** Semantic content observed on the rendered artifact. */
  rendered: RenderedCreativeSemanticContent;
  evaluatorVersion?: string;
}

export type FidelityCheckStatus = "pass" | "fail" | "not_applicable";

export interface RenderedSemanticFidelityCheck {
  checkId: string;
  status: FidelityCheckStatus;
  reasonCode: string;
  explanation: string;
}

export type MissingApprovedElementKind =
  | "headline"
  | "cta"
  | "offer"
  | "claim";

export interface MissingApprovedElement {
  kind: MissingApprovedElementKind;
  /** The approved text that was expected on the render. */
  expected: string;
  /** What was observed on the render (null when the field was absent). */
  observed: string | null;
  reasonCode: string;
}

export interface IntroducedUnsupportedClaim {
  /** Rendered field that introduced the unsupported claim. */
  field: string;
  text: string;
  reasonCode: string;
}

export interface RenderedSemanticFidelityFailure {
  checkId: string;
  reasonCode: string;
  explanation: string;
}

export interface RenderedSemanticFidelityResult {
  passed: boolean;
  evaluatorVersion: string;
  contractFingerprint: string;
  evidenceSetFingerprint: string;
  checks: RenderedSemanticFidelityCheck[];
  failures: RenderedSemanticFidelityFailure[];
  missingApprovedElements: MissingApprovedElement[];
  introducedUnsupportedClaims: IntroducedUnsupportedClaim[];
  diagnostics: string[];
}

// ─── Text normalisation (deterministic, provider-free) ───

function normalizePresenceText(value: string | null | undefined): string {
  return normalizeCtaText(value).replace(/\s+/g, " ").trim();
}

function isBlank(value: string | null | undefined): boolean {
  return normalizePresenceText(value).length === 0;
}

/** Whole-phrase containment on normalised text (no substring false positives). */
function containsPhrase(haystack: string, needle: string): boolean {
  const h = normalizePresenceText(haystack);
  const n = normalizePresenceText(needle);
  if (!h || !n) return false;
  if (h === n) return true;
  const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?:^|[^a-z0-9])${escaped}(?=[^a-z0-9]|$)`, "i");
  return pattern.test(h);
}

function ctaEquivalent(renderedCta: string, approvedCta: string): boolean {
  const a = normalizePresenceText(renderedCta);
  const b = normalizePresenceText(approvedCta);
  if (!a || !b) return false;
  return a === b || containsPhrase(a, b) || containsPhrase(b, a);
}

function check(
  checkId: string,
  status: FidelityCheckStatus,
  reasonCode: string,
  explanation: string
): RenderedSemanticFidelityCheck {
  return { checkId, status, reasonCode, explanation };
}

function missingElement(
  kind: MissingApprovedElementKind,
  expected: string,
  observed: string | null,
  reasonCode: string
): MissingApprovedElement {
  return { kind, expected, observed, reasonCode };
}

// ─── Individual checks ───

function checkLineage(contract: ApprovedCreativeContract): RenderedSemanticFidelityCheck {
  if (contract && contract.kind === "approved") {
    return check(
      "LINEAGE_AUTHORITATIVE",
      "pass",
      "CONTRACT_APPROVED",
      `ApprovedCreativeContract is authoritative for strategyRunId ${contract.strategyRunId}.`
    );
  }
  return check(
    "LINEAGE_AUTHORITATIVE",
    "fail",
    "LINEAGE_NOT_AUTHORITATIVE",
    "Semantic fidelity can only be evaluated against an approved creative contract."
  );
}

function checkApprovedHeadline(
  approvedHeadline: string | null,
  rendered: RenderedCreativeSemanticContent
): { check: RenderedSemanticFidelityCheck; missing: MissingApprovedElement | null } {
  if (isBlank(approvedHeadline)) {
    return {
      check: check(
        "APPROVED_HEADLINE_PRESENT",
        "not_applicable",
        "NO_APPROVED_HEADLINE",
        "No approved headline was supplied; headline presence is not required."
      ),
      missing: null,
    };
  }
  const approved = approvedHeadline!.trim();
  const renderedHeadline = isBlank(rendered.headline) ? null : String(rendered.headline).trim();
  if (renderedHeadline === null) {
    return {
      check: check(
        "APPROVED_HEADLINE_PRESENT",
        "fail",
        "MISSING_RENDERED_HEADLINE",
        `Approved headline "${approved}" was not rendered: no rendered headline was observed.`
      ),
      missing: missingElement("headline", approved, null, "MISSING_RENDERED_HEADLINE"),
    };
  }
  if (containsPhrase(renderedHeadline, approved)) {
    return {
      check: check(
        "APPROVED_HEADLINE_PRESENT",
        "pass",
        "APPROVED_HEADLINE_RENDERED",
        `Approved headline "${approved}" is present on the render.`
      ),
      missing: null,
    };
  }
  return {
    check: check(
      "APPROVED_HEADLINE_PRESENT",
      "fail",
      "APPROVED_HEADLINE_NOT_RENDERED",
      `Rendered headline "${renderedHeadline}" does not carry the approved headline "${approved}".`
    ),
    missing: missingElement("headline", approved, renderedHeadline, "APPROVED_HEADLINE_NOT_RENDERED"),
  };
}

function checkApprovedCta(
  contract: ApprovedCreativeContract,
  rendered: RenderedCreativeSemanticContent
): { check: RenderedSemanticFidelityCheck; missing: MissingApprovedElement | null } {
  const approved = contract.cta?.text ?? "";
  if (isBlank(approved)) {
    return {
      check: check(
        "APPROVED_CTA_PRESENT",
        "not_applicable",
        "NO_APPROVED_CTA",
        "The contract carries no approved CTA; CTA presence is not required."
      ),
      missing: null,
    };
  }
  const renderedCta = isBlank(rendered.cta) ? null : String(rendered.cta).trim();
  if (renderedCta === null) {
    return {
      check: check(
        "APPROVED_CTA_PRESENT",
        "fail",
        "MISSING_RENDERED_CTA",
        `Approved CTA "${approved}" was not rendered: no rendered CTA was observed.`
      ),
      missing: missingElement("cta", approved, null, "MISSING_RENDERED_CTA"),
    };
  }
  if (ctaEquivalent(renderedCta, approved)) {
    return {
      check: check(
        "APPROVED_CTA_PRESENT",
        "pass",
        "APPROVED_CTA_RENDERED",
        `Rendered CTA "${renderedCta}" matches the approved CTA.`
      ),
      missing: null,
    };
  }
  return {
    check: check(
      "APPROVED_CTA_PRESENT",
      "fail",
      "RENDERED_CTA_OVERRIDES_APPROVED",
      `Rendered CTA "${renderedCta}" overrides the approved CTA "${approved}".`
    ),
    missing: missingElement("cta", approved, renderedCta, "RENDERED_CTA_OVERRIDES_APPROVED"),
  };
}

function checkApprovedOffer(
  contract: ApprovedCreativeContract,
  rendered: RenderedCreativeSemanticContent
): { check: RenderedSemanticFidelityCheck; missing: MissingApprovedElement | null } {
  const approved = contract.offer?.text ?? null;
  const renderedOffer = isBlank(rendered.offer) ? null : String(rendered.offer).trim();

  if (isBlank(approved)) {
    if (renderedOffer === null) {
      return {
        check: check(
          "APPROVED_OFFER_PRESENT",
          "pass",
          "NO_OFFER_NONE_RENDERED",
          "No approved offer and none rendered."
        ),
        missing: null,
      };
    }
    const invented = isInventedOffer(renderedOffer, null);
    if (invented.invented) {
      return {
        check: check(
          "APPROVED_OFFER_PRESENT",
          "fail",
          invented.code ?? "INVENTED_OFFER",
          `Rendered offer "${renderedOffer}" introduces commercial terms with no approved offer.`
        ),
        missing: null,
      };
    }
    return {
      check: check(
        "APPROVED_OFFER_PRESENT",
        "pass",
        "NO_APPROVED_OFFER_RENDERED_OK",
        "No approved offer; rendered offer contains no invented commercial terms."
      ),
      missing: null,
    };
  }

  const approvedText = approved!.trim();
  if (renderedOffer === null) {
    if (contract.offer.required) {
      return {
        check: check(
          "APPROVED_OFFER_PRESENT",
          "fail",
          "MISSING_RENDERED_OFFER",
          `Approved offer "${approvedText}" is required but no rendered offer was observed.`
        ),
        missing: missingElement("offer", approvedText, null, "MISSING_RENDERED_OFFER"),
      };
    }
    return {
      check: check(
        "APPROVED_OFFER_PRESENT",
        "pass",
        "APPROVED_OFFER_OMITTED",
        `Approved offer "${approvedText}" is optional and was omitted.`
      ),
      missing: null,
    };
  }

  const validation = validateOffer(renderedOffer, contract);
  if (validation.valid) {
    return {
      check: check(
        "APPROVED_OFFER_PRESENT",
        "pass",
        "APPROVED_OFFER_RENDERED",
        `Rendered offer "${renderedOffer}" is compatible with the approved offer.`
      ),
      missing: null,
    };
  }
  return {
    check: check(
      "APPROVED_OFFER_PRESENT",
      "fail",
      validation.code ?? "RENDERED_OFFER_DIVERGES",
      `Rendered offer "${renderedOffer}" is not compatible with approved offer "${approvedText}".`
    ),
    missing: missingElement("offer", approvedText, renderedOffer, validation.code ?? "RENDERED_OFFER_DIVERGES"),
  };
}

interface RenderedClaimField {
  field: string;
  text: string;
}

function collectRenderedClaimFields(
  rendered: RenderedCreativeSemanticContent
): RenderedClaimField[] {
  const fields: RenderedClaimField[] = [];
  const push = (field: string, value: string | null | undefined) => {
    if (!isBlank(value)) fields.push({ field, text: String(value).trim() });
  };
  push("headline", rendered.headline);
  push("subheadline", rendered.subheadline);
  push("body", rendered.body);
  (rendered.claims ?? []).forEach((claim, index) => push(`claims[${index}]`, claim));
  push("offer", rendered.offer);
  return fields;
}

function checkApprovedClaims(
  contract: ApprovedCreativeContract,
  evidenceSet: EvidenceSet,
  rendered: RenderedCreativeSemanticContent
): {
  check: RenderedSemanticFidelityCheck;
  missing: MissingApprovedElement[];
  diagnostics: string[];
  groundedRenderedClaims: GroundedBenefit[];
} {
  const renderedClaims = (rendered.claims ?? []).filter((c) => !isBlank(c));
  const required = contract.minimumBenefitCount ?? 0;
  const diagnostics: string[] = [];

  if (renderedClaims.length === 0) {
    if (required > 0) {
      return {
        check: check(
          "APPROVED_CLAIMS_PRESENT",
          "fail",
          "NO_RENDERED_CLAIMS",
          `No rendered claims were observed; ${required} distinct grounded claim(s) are required.`
        ),
        missing: [],
        diagnostics,
        groundedRenderedClaims: [],
      };
    }
    return {
      check: check(
        "APPROVED_CLAIMS_PRESENT",
        "pass",
        "NO_CLAIMS_REQUIRED",
        "No claims are required by the contract and none were rendered."
      ),
      missing: [],
      diagnostics,
      groundedRenderedClaims: [],
    };
  }

  const groundedRenderedClaims: GroundedBenefit[] = [];
  for (const [index, text] of renderedClaims.entries()) {
    const claim = validateClaim(text.trim(), evidenceSet);
    if (claim.validationStatus === "grounded") {
      const benefit: GroundedBenefit = {
        benefitId: `rendered-claim-${index}`,
        text: text.trim(),
        evidenceIds: [...claim.evidenceIds].sort(),
        originatingCapabilities: claim.evidenceIds
          .map((id) => evidenceSet.evidenceById.get(id)?.displayText ?? "")
          .sort(),
        validationStatus: "grounded",
      };
      if (isDistinctBenefit(benefit, groundedRenderedClaims)) {
        groundedRenderedClaims.push(benefit);
      }
    }
  }

  const distinctGrounded = groundedRenderedClaims.length;
  if (distinctGrounded < required) {
    return {
      check: check(
        "APPROVED_CLAIMS_PRESENT",
        "fail",
        "MISSING_APPROVED_CLAIMS",
        `${distinctGrounded} distinct grounded claim(s) rendered; ${required} required by the approved contract.`
      ),
      missing: [],
      diagnostics,
      groundedRenderedClaims,
    };
  }

  return {
    check: check(
      "APPROVED_CLAIMS_PRESENT",
      "pass",
      "APPROVED_CLAIMS_RENDERED",
      `${distinctGrounded} distinct grounded claim(s) rendered, meeting the required ${required}.`
    ),
    missing: [],
    diagnostics,
    groundedRenderedClaims,
  };
}

function checkIntroducedClaims(
  evidenceSet: EvidenceSet,
  rendered: RenderedCreativeSemanticContent
): {
  check: RenderedSemanticFidelityCheck;
  introduced: IntroducedUnsupportedClaim[];
  warnings: string[];
} {
  const introduced: IntroducedUnsupportedClaim[] = [];
  const warnings: string[] = [];

  for (const { field, text } of collectRenderedClaimFields(rendered)) {
    const claim = validateClaim(text, evidenceSet);
    if (claim.validationStatus === "ungrounded") {
      const reasonCode = isUnsupportedClaim(text, evidenceSet)
        ? "UNSUPPORTED_CLAIM_INTRODUCED"
        : "UNGROUNDED_CLAIM_INTRODUCED";
      introduced.push({ field, text, reasonCode });
    } else if (claim.validationStatus === "partially_grounded") {
      warnings.push(
        `Rendered ${field} "${text}" is only partially grounded in approved evidence.`
      );
    }
  }

  if (introduced.length > 0) {
    return {
      check: check(
        "INTRODUCED_UNSUPPORTED_CLAIMS",
        "fail",
        introduced[0].reasonCode,
        `${introduced.length} rendered claim(s) are not backed by approved evidence.`
      ),
      introduced,
      warnings,
    };
  }

  return {
    check: check(
      "INTRODUCED_UNSUPPORTED_CLAIMS",
      "pass",
      "NO_UNSUPPORTED_CLAIMS_INTRODUCED",
      "Every rendered claim is grounded in approved evidence."
    ),
    introduced,
    warnings,
  };
}

function checkProhibitedClaims(
  contract: ApprovedCreativeContract,
  rendered: RenderedCreativeSemanticContent
): RenderedSemanticFidelityCheck {
  const prohibited = contract.prohibitedClaims ?? [];
  if (prohibited.length === 0) {
    return check(
      "PROHIBITED_CLAIMS_ABSENT",
      "not_applicable",
      "NO_PROHIBITED_CLAIMS",
      "The contract declares no prohibited claims."
    );
  }
  const allText = [
    rendered.headline,
    rendered.subheadline,
    rendered.body,
    ...(rendered.claims ?? []),
    rendered.offer,
  ]
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .join(" ");
  const hits = prohibited.filter((claim) => containsPhrase(allText, claim));
  if (hits.length > 0) {
    return check(
      "PROHIBITED_CLAIMS_ABSENT",
      "fail",
      "PROHIBITED_CLAIM_PRESENT",
      `Prohibited claim(s) rendered: ${hits.map((h) => `"${h}"`).join(", ")}.`
    );
  }
  return check(
    "PROHIBITED_CLAIMS_ABSENT",
    "pass",
    "NO_PROHIBITED_CLAIMS_RENDERED",
    "No prohibited claims were rendered."
  );
}

function checkRequiredContactDetails(
  contract: ApprovedCreativeContract,
  rendered: RenderedCreativeSemanticContent
): RenderedSemanticFidelityCheck {
  const required = (contract.requiredContactDetails ?? []).filter((d) => !isBlank(d));
  if (required.length === 0) {
    return check(
      "REQUIRED_CONTACT_DETAILS_PRESENT",
      "not_applicable",
      "NO_CONTACT_DETAILS_REQUIRED",
      "No contact details are required by the contract."
    );
  }
  const provided = new Set((rendered.contactDetails ?? []).map((d) => normalizePresenceText(d)));
  const missing = required.filter((d) => !provided.has(normalizePresenceText(d)));
  if (missing.length > 0) {
    return check(
      "REQUIRED_CONTACT_DETAILS_PRESENT",
      "fail",
      "MISSING_REQUIRED_CONTACT_DETAIL",
      `Missing required contact detail(s): ${missing.join(", ")}.`
    );
  }
  return check(
    "REQUIRED_CONTACT_DETAILS_PRESENT",
    "pass",
    "REQUIRED_CONTACT_DETAILS_RENDERED",
    "All required contact details are rendered."
  );
}

function checkBusinessName(
  contract: ApprovedCreativeContract,
  rendered: RenderedCreativeSemanticContent
): RenderedSemanticFidelityCheck {
  if (isBlank(rendered.businessName)) {
    return check(
      "BUSINESS_NAME_PRESERVED",
      "not_applicable",
      "BUSINESS_NAME_NOT_OBSERVED",
      "No rendered business name was observed; preservation is not evaluated."
    );
  }
  const renderedName = String(rendered.businessName).trim();
  if (normalizePresenceText(renderedName) === normalizePresenceText(contract.businessName)) {
    return check(
      "BUSINESS_NAME_PRESERVED",
      "pass",
      "BUSINESS_NAME_PRESERVED_ON_RENDER",
      "Rendered business name matches the contract business name."
    );
  }
  return check(
    "BUSINESS_NAME_PRESERVED",
    "fail",
    "BUSINESS_NAME_ALTERED",
    `Rendered business name "${renderedName}" differs from contract business name "${contract.businessName}".`
  );
}

// ─── Evaluator ───

function buildNotAuthoritativeResult(
  evaluatorVersion: string,
  contract: ApprovedCreativeContract,
  lineageCheck: RenderedSemanticFidelityCheck
): RenderedSemanticFidelityResult {
  const skipped = (checkId: string): RenderedSemanticFidelityCheck =>
    check(checkId, "not_applicable", "LINEAGE_NOT_AUTHORITATIVE", "Skipped: contract is not authoritative.");
  const checks = [
    lineageCheck,
    skipped("APPROVED_HEADLINE_PRESENT"),
    skipped("APPROVED_CTA_PRESENT"),
    skipped("APPROVED_OFFER_PRESENT"),
    skipped("APPROVED_CLAIMS_PRESENT"),
    skipped("INTRODUCED_UNSUPPORTED_CLAIMS"),
    skipped("PROHIBITED_CLAIMS_ABSENT"),
    skipped("REQUIRED_CONTACT_DETAILS_PRESENT"),
    skipped("BUSINESS_NAME_PRESERVED"),
  ];
  return {
    passed: false,
    evaluatorVersion,
    contractFingerprint: contract?.contractFingerprint ?? "",
    evidenceSetFingerprint: "",
    checks,
    failures: [
      {
        checkId: lineageCheck.checkId,
        reasonCode: lineageCheck.reasonCode,
        explanation: lineageCheck.explanation,
      },
    ],
    missingApprovedElements: [],
    introducedUnsupportedClaims: [],
    diagnostics: [],
  };
}

/**
 * Evaluate rendered semantic fidelity against approved intent.
 *
 * Pure and deterministic. Never throws for ordinary bad input: malformed
 * input or an unexpected internal error fails closed with an explicit reason.
 */
export function evaluateRenderedSemanticFidelity(
  input: EvaluateRenderedSemanticFidelityInput
): RenderedSemanticFidelityResult {
  const evaluatorVersion =
    input?.evaluatorVersion ?? RENDERED_SEMANTIC_FIDELITY_EVALUATOR_VERSION;

  if (!input || typeof input !== "object" || !input.contract || !input.rendered) {
    return {
      passed: false,
      evaluatorVersion,
      contractFingerprint: "",
      evidenceSetFingerprint: "",
      checks: [
        check(
          "FIDELITY_INPUT_VALID",
          "fail",
          "FIDELITY_INPUT_INVALID",
          "Evaluation requires an approved contract and rendered content."
        ),
      ],
      failures: [
        {
          checkId: "FIDELITY_INPUT_VALID",
          reasonCode: "FIDELITY_INPUT_INVALID",
          explanation: "Evaluation requires an approved contract and rendered content.",
        },
      ],
      missingApprovedElements: [],
      introducedUnsupportedClaims: [],
      diagnostics: [],
    };
  }

  const { contract, rendered } = input;
  const approvedHeadline = isBlank(input.approvedHeadline) ? null : String(input.approvedHeadline).trim();

  try {
    const lineageCheck = checkLineage(contract);
    if (lineageCheck.status === "fail") {
      return buildNotAuthoritativeResult(evaluatorVersion, contract, lineageCheck);
    }

    const evidenceSet = compileEvidenceSet(contract, contract.contractFingerprint);

    const headline = checkApprovedHeadline(approvedHeadline, rendered);
    const cta = checkApprovedCta(contract, rendered);
    const offer = checkApprovedOffer(contract, rendered);
    const claims = checkApprovedClaims(contract, evidenceSet, rendered);
    const introduced = checkIntroducedClaims(evidenceSet, rendered);
    const prohibited = checkProhibitedClaims(contract, rendered);
    const contact = checkRequiredContactDetails(contract, rendered);
    const businessName = checkBusinessName(contract, rendered);

    // Informational: which approved claims did not appear anywhere in the
    // rendered text. Absence of an optional approved claim is not a failure;
    // the hard claim requirement is enforced by APPROVED_CLAIMS_PRESENT.
    const renderedText = [
      rendered.headline,
      rendered.subheadline,
      rendered.body,
      ...(rendered.claims ?? []),
      rendered.offer,
    ]
      .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
      .join(" ");
    for (const approvedClaim of contract.groundedClaims ?? []) {
      if (isBlank(approvedClaim)) continue;
      if (!containsPhrase(renderedText, approvedClaim)) {
        claims.diagnostics.push(
          `Approved claim "${approvedClaim}" does not appear in the rendered text.`
        );
      }
    }

    const checks: RenderedSemanticFidelityCheck[] = [
      lineageCheck,
      headline.check,
      cta.check,
      offer.check,
      claims.check,
      introduced.check,
      prohibited,
      contact,
      businessName,
    ];

    const failures: RenderedSemanticFidelityFailure[] = checks
      .filter((c) => c.status === "fail")
      .map((c) => ({ checkId: c.checkId, reasonCode: c.reasonCode, explanation: c.explanation }));

    const missingApprovedElements: MissingApprovedElement[] = [
      ...(headline.missing ? [headline.missing] : []),
      ...(cta.missing ? [cta.missing] : []),
      ...(offer.missing ? [offer.missing] : []),
      ...claims.missing,
    ];

    return {
      passed: failures.length === 0,
      evaluatorVersion,
      contractFingerprint: contract.contractFingerprint,
      evidenceSetFingerprint: evidenceSet.evidenceSetFingerprint,
      checks,
      failures,
      missingApprovedElements,
      introducedUnsupportedClaims: introduced.introduced,
      diagnostics: [...claims.diagnostics, ...introduced.warnings],
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const failure = {
      checkId: "FIDELITY_EVALUATION_ERROR",
      reasonCode: "FIDELITY_EVALUATION_ERROR",
      explanation: `Rendered semantic fidelity evaluation failed closed: ${reason}`,
    };
    return {
      passed: false,
      evaluatorVersion,
      contractFingerprint: contract?.contractFingerprint ?? "",
      evidenceSetFingerprint: "",
      checks: [check(failure.checkId, "fail", failure.reasonCode, failure.explanation)],
      failures: [failure],
      missingApprovedElements: [],
      introducedUnsupportedClaims: [],
      diagnostics: [],
    };
  }
}
