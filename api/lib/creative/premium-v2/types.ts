/**
 * Premium Leaflet V2 – structured brief and curation types.
 *
 * The V2 pipeline separates *what the leaflet says* from *how it looks*.
 * Business evidence is first converted into a PremiumLeafletV2Brief, which is
 * then consumed by the V2 renderer. This makes the brief testable, reusable,
 * and independent of any specific rendering backend.
 */

export type PremiumV2BusinessCategory =
  | "local_services"
  | "retail_product"
  | "food_restaurant"
  | "professional_services"
  | "print_courier"
  | "beauty_wellness"
  | "healthcare_wellness"
  | "training_education"
  | "logistics"
  | "general";

export type PremiumV2LayoutDensity =
  | "premium_minimal"
  | "premium_services"
  | "offer_focused"
  | "catalogue_brochure"
  | "corporate_professional"
  | "local_promo";

export type PremiumV2VisualStyle =
  | "modern"
  | "classic"
  | "bold"
  | "minimal"
  | "luxury"
  | "friendly";

export type PremiumV2RefinementMode =
  | "design_only"
  | "improve_copy"
  | "add_services"
  | "more_premium"
  | "reduce_clutter"
  | "stronger_cta"
  | "emphasise_offer"
  | "emphasise_location"
  | "fewer_services"
  | "full_redesign"
  | "catalogue_layout"
  | "general";

export interface PremiumV2Service {
  name: string;
  description?: string;
  icon?: string;
  isPrimary: boolean;
}

export interface PremiumV2BrandPalette {
  primary: string;
  secondary: string;
  accent: string;
  background: string;
  text: string;
  textMuted: string;
}

export interface PremiumV2BrandKit {
  palette: PremiumV2BrandPalette;
  source: "logo" | "brandColors" | "websiteEvidence" | "default";
  logoUrl?: string;
}

export interface PremiumV2ContactLines {
  phone?: string;
  whatsapp?: string;
  email?: string;
  website?: string;
  location?: string;
}

export interface PremiumV2ProofPoint {
  label: string;
  value?: string;
}

export interface PremiumLeafletV2Brief {
  businessName: string;
  businessCategory: PremiumV2BusinessCategory;
  campaignGoal?: string;
  targetCustomer?: string;
  customerPainPoint?: string;
  headline: string;
  subheadline?: string;
  primaryServices: PremiumV2Service[];
  secondaryServices: PremiumV2Service[];
  offer?: string;
  benefits: string[];
  cta: string;
  contact: PremiumV2ContactLines;
  visualStyle: PremiumV2VisualStyle;
  layoutDensity: PremiumV2LayoutDensity;
  brandPalette: PremiumV2BrandPalette;
  logoUrl?: string;
  logoPlacement: "header" | "footer" | "hero";
  proofPoints: PremiumV2ProofPoint[];
  complianceNotes?: string[];
  refinementMode?: PremiumV2RefinementMode;
  refinementInstruction?: string;
  /** Original raw inputs used to build the brief; useful for debugging. */
  _evidence?: {
    industry?: string;
    productOrService?: string;
    targetBuyer?: string;
    mainPainPoint?: string;
    offerDetails?: string;
    websiteEvidenceCategory?: string;
    websiteEvidenceServices?: string[];
  };
}

export interface PremiumV2QualityResult {
  passed: boolean;
  score: number;
  label:
    | "Premium Ready"
    | "Good but Needs Review"
    | "Too Crowded"
    | "Text Too Small"
    | "CTA Clipped"
    | "Footer Clipped"
    | "Generic Copy"
    | "Failed Premium Standard"
    | "Brand Mismatch"
    | "Generic Layout"
    | "Weak Copy"
    | "Duplicate Services"
    | "Missing Logo"
    | "Placeholder Contact"
    | "Needs Design Review";
  criticalFailures: string[];
  warnings: string[];
}
