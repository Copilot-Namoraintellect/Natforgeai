/**
 * Premium Leaflet V2 – refinement mode inference and rules.
 *
 * Replaces the unstable free-text refinement box with explicit modes.
 * The UI can still accept free text, but the system first classifies it into
 * a known mode so users know what will change and what will be preserved.
 */

import type { PremiumV2RefinementMode } from "./types";

const MODE_KEYWORDS: Record<Exclude<PremiumV2RefinementMode, "general">, string[]> = {
  design_only: [
    "design only",
    "layout only",
    "change layout",
    "change design",
    "visual only",
    "background only",
    "spacing",
    "typography",
    "font",
    "colours",
    "colors",
    "make it darker",
    "make it lighter",
    "more whitespace",
    "move logo",
    "logo placement",
  ],
  improve_copy: [
    "improve copy",
    "better text",
    "rewrite copy",
    "better headline",
    "better cta",
    "polish wording",
  ],
  add_services: [
    "add services",
    "include services",
    "add more services",
    "add product",
    "include product",
  ],
  more_premium: [
    "more premium",
    "make it premium",
    "premium look",
    "luxury",
    "high-end",
    "upscale",
    "sophisticated",
  ],
  reduce_clutter: [
    "reduce clutter",
    "less crowded",
    "less busy",
    "cleaner",
    "simpler",
    "minimal",
    "more space",
  ],
  stronger_cta: [
    "stronger cta",
    "bigger cta",
    "better cta",
    "cta stronger",
    "call to action",
  ],
  emphasise_offer: [
    "emphasise offer",
    "highlight offer",
    "offer focus",
    "promo focus",
    "discount focus",
  ],
  emphasise_location: [
    "emphasise location",
    "highlight location",
    "location focus",
    "in alberton",
    "in johannesburg",
    "near me",
  ],
  fewer_services: [
    "fewer services",
    "less services",
    "reduce services",
    "use fewer",
    "only main services",
  ],
  full_redesign: [
    "full redesign",
    "redesign everything",
    "start over",
    "completely new",
  ],
  catalogue_layout: [
    "catalogue",
    "brochure",
    "full list",
    "all services listed",
    "menu layout",
  ],
};

export function inferRefinementMode(instruction: string): PremiumV2RefinementMode {
  const lower = instruction.toLowerCase();
  if (!lower.trim()) return "general";

  // Check explicit mode phrases first.
  for (const [mode, keywords] of Object.entries(MODE_KEYWORDS)) {
    for (const kw of keywords) {
      if (lower.includes(kw)) return mode as PremiumV2RefinementMode;
    }
  }

  return "general";
}

export function getRefinementModeDescription(mode: PremiumV2RefinementMode): string {
  const descriptions: Record<PremiumV2RefinementMode, string> = {
    design_only: "Only layout, colours, spacing, typography, and logo placement will change. Headline, CTA, and services stay the same.",
    improve_copy: "Headline, subheadline, benefits, and CTA may be rewritten. Layout and services stay the same.",
    add_services: "New services will be added; existing copy is preserved unless room requires trimming.",
    more_premium: "Visual treatment becomes more premium/upscale. Copy is preserved.",
    reduce_clutter: "Layout becomes cleaner with more whitespace and fewer visual elements. Copy is preserved.",
    stronger_cta: "The call-to-action is made more prominent. Everything else is preserved.",
    emphasise_offer: "The offer or promotion is moved to the hero area. Layout may change; copy is preserved.",
    emphasise_location: "Location and local relevance are emphasised. Copy is preserved.",
    fewer_services: "Only the most important services are shown prominently. Copy is preserved.",
    full_redesign: "A completely new layout and visual approach. Approved copy may still be used as source material.",
    catalogue_layout: "All services are shown in a brochure/catalogue layout. This overrides the normal premium service limit.",
    general: "A general refinement based on your instructions. Layout may change; approved copy is preserved where possible.",
  };
  return descriptions[mode];
}

export function getRefinementModeLabel(mode: PremiumV2RefinementMode): string {
  const labels: Record<PremiumV2RefinementMode, string> = {
    design_only: "Design only",
    improve_copy: "Improve copy",
    add_services: "Add/update services",
    more_premium: "Make more premium",
    reduce_clutter: "Reduce clutter",
    stronger_cta: "Stronger CTA",
    emphasise_offer: "Emphasise offer",
    emphasise_location: "Emphasise location",
    fewer_services: "Use fewer services",
    full_redesign: "Full redesign",
    catalogue_layout: "Brochure/catalogue layout",
    general: "General refinement",
  };
  return labels[mode];
}

export function isDesignOnlyRefinementMode(mode: PremiumV2RefinementMode): boolean {
  return mode === "design_only" || mode === "more_premium" || mode === "reduce_clutter";
}

export function shouldPreserveCopy(mode: PremiumV2RefinementMode): boolean {
  // Modes that must not rewrite headline/CTA/benefits.
  return ["design_only", "more_premium", "reduce_clutter", "stronger_cta", "emphasise_offer", "emphasise_location", "fewer_services"].includes(mode);
}
