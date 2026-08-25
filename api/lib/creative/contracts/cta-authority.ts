/**
 * CTA Authority Resolution.
 *
 * Deterministically resolve the authoritative CTA for a creative contract
 * using the approved strategy hierarchy. No provider calls. No fallback to
 * generic category defaults unless explicitly requested.
 */

import { normalizeCtaText, type FunnelStage } from "../cta-utils";

const DEFAULT_FUNNEL_CTAS: Record<FunnelStage, string> = {
  awareness: "Learn More",
  consideration: "Sign Up for a Free Consultation",
  conversion: "Get Started Today",
  retention: "Join Our Community",
};

export type CtaAuthoritySource =
  | "strategy_stage"
  | "strategy_campaign_wide"
  | "campaign_input"
  | "approved_offer_action"
  | "stage_default"
  | "ai_delegated"
  | "none";

export interface CtaAuthority {
  text: string;
  source: CtaAuthoritySource;
  locked: boolean;
}

export interface ResolveCtaAuthorityInput {
  funnelStage: FunnelStage;
  stageCtas?: Partial<Record<FunnelStage, string | null | undefined>>;
  campaignWideCta?: string | null;
  campaignInputCta?: string | null;
  offerActionCta?: string | null;
  aiDelegated?: boolean;
}

function safeCta(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Resolve the authoritative CTA.
 *
 * Precedence:
 * 1. applicable stage CTA in the approved strategy;
 * 2. unambiguous campaign-wide CTA in the approved strategy;
 * 3. explicit campaign-input CTA included in approved strategy lineage;
 * 4. explicit action from an approved offer;
 * 5. deterministic stage default only when no approved CTA exists;
 * 6. AI selection only when the approved strategy explicitly delegates selection.
 */
export function resolveCtaAuthority(input: ResolveCtaAuthorityInput): CtaAuthority {
  const stage = input.funnelStage;

  // 1. Applicable stage CTA in the approved strategy.
  const stageCta = safeCta(input.stageCtas?.[stage]);
  if (stageCta) {
    return {
      text: stageCta,
      source: "strategy_stage",
      locked: true,
    };
  }

  // 2. Unambiguous campaign-wide CTA in the approved strategy.
  const campaignWideCta = safeCta(input.campaignWideCta);
  if (campaignWideCta) {
    return {
      text: campaignWideCta,
      source: "strategy_campaign_wide",
      locked: true,
    };
  }

  // 3. Explicit campaign-input CTA included in approved strategy lineage.
  const campaignInputCta = safeCta(input.campaignInputCta);
  if (campaignInputCta) {
    return {
      text: campaignInputCta,
      source: "campaign_input",
      locked: true,
    };
  }

  // 4. Explicit action from an approved offer.
  const offerActionCta = safeCta(input.offerActionCta);
  if (offerActionCta) {
    return {
      text: offerActionCta,
      source: "approved_offer_action",
      locked: true,
    };
  }

  // 6. AI selection only when explicitly delegated.
  if (input.aiDelegated) {
    return {
      text: DEFAULT_FUNNEL_CTAS[stage],
      source: "ai_delegated",
      locked: false,
    };
  }

  // 5. Deterministic stage default only when no approved CTA exists.
  return {
    text: DEFAULT_FUNNEL_CTAS[stage],
    source: "stage_default",
    locked: false,
  };
}

/**
 * Check whether two CTAs are semantically identical after normalisation.
 */
export function ctasMatch(a: string, b: string): boolean {
  return normalizeCtaText(a) === normalizeCtaText(b);
}

const GENERIC_FALLBACK_CTA_PATTERNS = [
  /learn more/i,
  /click here/i,
  /read more/i,
  /find out more/i,
  /discover more/i,
  /explore more/i,
  /get started/i,
  /start now/i,
  /sign up today/i,
  /^submit$/i,
  /^more info$/i,
  /^details$/i,
  /^contact us$/i,
  /join our community/i,
];

/**
 * Check whether a CTA is a generic fallback that should not override an approved CTA.
 */
export function isGenericFallbackCta(cta: string): boolean {
  return GENERIC_FALLBACK_CTA_PATTERNS.some((pattern) => pattern.test(cta.trim()));
}

/**
 * Detect ambiguous CTA authority.
 * Returns a non-null warning string when multiple approved sources conflict.
 */
export function detectCtaAmbiguity(input: ResolveCtaAuthorityInput): string | null {
  const stage = input.funnelStage;
  const conflicts: string[] = [];

  if (input.stageCtas?.[stage]) conflicts.push("stage");
  if (input.campaignWideCta) conflicts.push("campaign-wide");
  if (input.campaignInputCta) conflicts.push("campaign-input");
  if (input.offerActionCta) conflicts.push("offer-action");

  // More than one approved-level source is present. Note that stage + campaign-wide
  // is acceptable (stage wins), but stage + campaign-input or campaign-wide + offer-action
  // is ambiguous.
  if (
    (input.stageCtas?.[stage] && input.campaignInputCta) ||
    (input.campaignWideCta && input.offerActionCta) ||
    (input.stageCtas?.[stage] && input.offerActionCta && !ctasMatch(input.stageCtas[stage]!, input.offerActionCta))
  ) {
    return `Ambiguous CTA authority: ${conflicts.join(" vs ")}`;
  }

  return null;
}
