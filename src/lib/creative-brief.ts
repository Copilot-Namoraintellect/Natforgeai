/**
 * Helpers for editing a campaign's creative brief before retrying a failed
 * creative generation. Keeps validation, readiness checks and business-profile
 * hydration in one place so the UI components stay small and testable.
 */

export const REQUIRED_BRIEF_FIELDS = [
  "productOrService",
  "targetBuyer",
  "mainPainPoint",
  "preferredCta",
] as const;

export type RequiredBriefField = (typeof REQUIRED_BRIEF_FIELDS)[number];

export const PLACEHOLDER_VALUES = [
  "your business",
  "your company",
  "[your company]",
  "n/a",
  "tbd",
  "tbc",
  "na",
  "not applicable",
  "to be determined",
  "to be confirmed",
  "none",
  "",
];

export const CONTENT_STYLE_NONE_SENTINEL = "__none__";

export const BRIEF_FIELD_LABELS: Record<string, string> = {
  productOrService: "Product or Service",
  targetBuyer: "Target Buyer",
  mainPainPoint: "Main Pain Point",
  preferredCta: "Preferred CTA",
  primaryOutcome: "Primary Outcome",
  offerDetails: "Offer Details",
  excludedOffers: "Excluded Offers / Words",
  referenceStyle: "Reference Style",
  contentStyle: "Content Style",
  targetAudience: "Target Audience",
  coreMessage: "Core Message",
};

export interface CreativeBriefForm {
  name: string;
  productOrService: string;
  targetBuyer: string;
  mainPainPoint: string;
  preferredCta: string;
  primaryOutcome: string;
  offerDetails: string;
  excludedOffers: string;
  referenceStyle: string;
  contentStyle: string;
  targetAudience: string;
  coreMessage: string;
}

export const EMPTY_CREATIVE_BRIEF: CreativeBriefForm = {
  name: "",
  productOrService: "",
  targetBuyer: "",
  mainPainPoint: "",
  preferredCta: "",
  primaryOutcome: "",
  offerDetails: "",
  excludedOffers: "",
  referenceStyle: "",
  contentStyle: "",
  targetAudience: "",
  coreMessage: "",
};

function normalizeForPlaceholderCheck(value: string): string {
  return value
    .toLowerCase()
    .replace(/\[|\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isPlaceholderValue(value: string): boolean {
  const normalized = normalizeForPlaceholderCheck(value);
  return PLACEHOLDER_VALUES.includes(normalized);
}

/**
 * Check whether a campaign snapshot contains the four required grounding fields
 * that creative generation needs to produce non-generic, quality-approved copy.
 */
export function isCreativeBriefComplete(campaign: unknown): boolean {
  if (!campaign || typeof campaign !== "object") return false;
  const c = campaign as Record<string, unknown>;
  return REQUIRED_BRIEF_FIELDS.every((field) => {
    const value = c[field];
    return typeof value === "string" && value.trim().length > 0 && !isPlaceholderValue(value);
  });
}

/**
 * Validate the editable brief form. Returns a map of field-specific errors and
 * a boolean indicating whether the form is submittable.
 */
export function validateCreativeBrief(values: Partial<CreativeBriefForm>): {
  valid: boolean;
  errors: Record<string, string>;
} {
  const errors: Record<string, string> = {};
  for (const field of REQUIRED_BRIEF_FIELDS) {
    const raw = values[field] ?? "";
    const value = typeof raw === "string" ? raw.trim() : "";
    if (!value) {
      errors[field] = `${BRIEF_FIELD_LABELS[field] ?? field} is required.`;
    } else if (isPlaceholderValue(value)) {
      errors[field] = `Please replace the placeholder with a specific ${
        BRIEF_FIELD_LABELS[field] ?? field
      }.`;
    }
  }
  return { valid: Object.keys(errors).length === 0, errors };
}

/**
 * Trim every string value in the form so trailing spaces are not persisted.
 */
export function trimCreativeBrief(values: Partial<CreativeBriefForm>): Partial<CreativeBriefForm> {
  const trimmed: Partial<CreativeBriefForm> = {};
  for (const [key, value] of Object.entries(values)) {
    trimmed[key as keyof CreativeBriefForm] = typeof value === "string" ? value.trim() : value;
  }
  return trimmed;
}

/**
 * Build an edit form from the persisted campaign snapshot. Empty strings are
 * used for null/undefined values so the form inputs stay controlled.
 */
export function prefillBriefFromCampaign(campaign: unknown): CreativeBriefForm {
  if (!campaign || typeof campaign !== "object") {
    return { ...EMPTY_CREATIVE_BRIEF };
  }
  const c = campaign as Record<string, unknown>;
  const stringOrEmpty = (value: unknown): string =>
    typeof value === "string" ? value : "";
  return {
    name: stringOrEmpty(c.name),
    productOrService: stringOrEmpty(c.productOrService),
    targetBuyer: stringOrEmpty(c.targetBuyer),
    mainPainPoint: stringOrEmpty(c.mainPainPoint),
    preferredCta: stringOrEmpty(c.preferredCta),
    primaryOutcome: stringOrEmpty(c.primaryOutcome),
    offerDetails: stringOrEmpty(c.offerDetails),
    excludedOffers: stringOrEmpty(c.excludedOffers),
    referenceStyle: stringOrEmpty(c.referenceStyle),
    contentStyle: stringOrEmpty(c.contentStyle),
    targetAudience: stringOrEmpty(c.targetAudience),
    coreMessage: stringOrEmpty(c.coreMessage),
  };
}

/**
 * Fill empty campaign brief fields from the linked business profile. Only the
 * fields the user explicitly leaves empty are filled; existing campaign values
 * are never silently overwritten.
 */
export function applyBusinessProfileToBrief(
  form: CreativeBriefForm,
  business: unknown
): CreativeBriefForm {
  if (!business || typeof business !== "object") {
    return form;
  }
  const b = business as Record<string, unknown>;
  const businessValue = (key: string): string | null => {
    const value = b[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
    return null;
  };

  const next: CreativeBriefForm = { ...form };

  if (!next.productOrService.trim()) {
    const value = businessValue("productOrService");
    if (value) next.productOrService = value;
  }
  if (!next.targetBuyer.trim()) {
    const value = businessValue("targetCustomer") ?? businessValue("targetAudience");
    if (value) next.targetBuyer = value;
  }
  if (!next.targetAudience.trim()) {
    const value = businessValue("targetAudience") ?? businessValue("targetCustomer");
    if (value) next.targetAudience = value;
  }

  return next;
}

/**
 * Convert the trimmed form into a payload suitable for campaign.update.
 * Only fields that campaign.update already accepts are included.
 */
export function buildCampaignUpdatePayload(
  form: Partial<CreativeBriefForm>
): Partial<CreativeBriefForm> {
  const trimmed = trimCreativeBrief(form);
  if (trimmed.contentStyle === CONTENT_STYLE_NONE_SENTINEL) {
    trimmed.contentStyle = "";
  }
  return trimmed;
}
