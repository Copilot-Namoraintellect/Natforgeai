import type { CampaignMessagePack } from "../campaign-message-architect";
import type { LegacyLoadedShadowContextInput } from "./integration/legacy-shadow-context";

export const DIAGNOSTIC_SENTINEL_CAMPAIGN_ID = 999999;
export const DIAGNOSTIC_SENTINEL_BUSINESS_ID = 999999;

export const diagnosticBusiness = {
  id: DIAGNOSTIC_SENTINEL_BUSINESS_ID,
  name: "NatForge Diagnostic Business",
  industry: "Software",
  productOrService: "Marketing automation diagnostics",
  targetCustomer: "Operations managers",
  targetAudience: "Operations managers and finance leads",
  websiteEvidence: {
    productsServices: [
      "payout automation",
      "supplier disbursements",
      "reconciliation dashboard",
    ],
    targetCustomers: ["operations managers", "finance leads"],
    location: "Johannesburg",
  },
  avoidWords: ["guaranteed instant wealth", "risk free returns"],
} as const;

export const diagnosticCampaign = {
  id: DIAGNOSTIC_SENTINEL_CAMPAIGN_ID,
  name: "Diagnostic Authority Canary",
  goal: "Increase qualified demo demand",
  primaryOutcome: "Increase qualified demo demand",
  targetBuyer: "operations managers",
  mainPainPoint: "manual reconciliation",
  productOrService: "Marketing automation diagnostics",
  offerDetails: "Book a guided walkthrough",
  preferredCta: "Learn More",
  ctaStrategy: "Learn More",
  keyOutcomes: ["faster settlements", "clear reconciliation", "fewer disputes"],
  excludedOffers: ["guaranteed overnight profits"],
} as const;

export type DiagnosticFixtureCase = "approved" | "rejected_cta_mismatch";

export function buildDiagnosticLoadedContext(): LegacyLoadedShadowContextInput {
  return {
    campaignId: DIAGNOSTIC_SENTINEL_CAMPAIGN_ID,
    business: diagnosticBusiness,
    campaign: diagnosticCampaign,
    validationContext: {
      businessName: diagnosticBusiness.name,
      industry: diagnosticBusiness.industry,
      productOrService: diagnosticBusiness.productOrService,
      targetCustomer: diagnosticBusiness.targetCustomer,
      mainPainPoint: diagnosticCampaign.mainPainPoint,
      campaignObjective: diagnosticCampaign.goal,
      funnelStage: "consideration",
      preferredCta: "Consideration: Learn More",
    },
  };
}

const footerContact = {
  phone: undefined,
  whatsapp: undefined,
  email: "diagnostic@natforgeai.test",
  website: "natforgeai-diagnostic.test",
  location: "Johannesburg",
};

const platformCaptions = [
  {
    platform: "instagram",
    caption: "Reduce payout delays for operations managers with diagnostic automation.",
    cta: "Learn More",
    hashtags: ["#diagnostic", "#operations"],
  },
];

const validation = {
  passed: true,
  score: 95,
  rejections: [],
  warnings: [],
};

export const approvedDiagnosticPack: CampaignMessagePack = {
  headline: "Reduce payout delays for operations managers",
  subheadline:
    "NatForge Diagnostic automates supplier disbursements so operations managers spend less time on manual reconciliation.",
  benefitBullets: [
    "Automate payout workflows across restaurant team payouts.",
    "Track supplier settlements with a reconciliation dashboard.",
    "Cut manual reconciliation work and resolve payout delays faster.",
  ],
  cta: "Learn More",
  footerContact,
  proofPoints: [
    "Built for operations managers who need faster settlements",
    "Reduces manual reconciliation across supplier disbursements",
  ],
  platformCaptions,
  validation,
  messagePackSource: "user_structured_copy",
  isGeneric: false,
  specificityScore: 90,
};

export const rejectedCtaDiagnosticPack: CampaignMessagePack = {
  ...approvedDiagnosticPack,
  cta: "Buy Now",
  platformCaptions: [
    {
      ...platformCaptions[0],
      cta: "Buy Now",
    },
  ],
};

export function getDiagnosticPack(caseId: DiagnosticFixtureCase): CampaignMessagePack {
  switch (caseId) {
    case "approved":
      return approvedDiagnosticPack;
    case "rejected_cta_mismatch":
      return rejectedCtaDiagnosticPack;
    default:
      const exhaustive: never = caseId;
      throw new Error(`Unknown diagnostic fixture case: ${String(exhaustive)}`);
  }
}
