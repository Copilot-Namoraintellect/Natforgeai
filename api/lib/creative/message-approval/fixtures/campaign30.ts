import type {
  BusinessDNASnapshot,
  CampaignStrategySnapshot,
  MessageQualityPolicy,
} from "../contracts";
import { DEFAULT_V2_MESSAGE_QUALITY_POLICY } from "../policy";

export const campaign30BusinessDna = {
  snapshotId: "bizdna-30-v1",
  businessId: 30,
  version: 1,
  evidenceHashSha256: "6a83a65f3b0aa4130f784fb4f55b95c2949e980fce8f669d8e6c646f844f5080",
  capturedAtIso: "2026-07-01T08:00:00.000Z",
  businessName: "NatForge Ops",
  industry: "Financial Operations",
  primaryOffering: "Staff and supplier payout automation",
  productsAndServices: ["payout automation", "supplier disbursements", "reconciliation dashboard"],
  verifiedUseCases: ["restaurant team payouts", "supplier settlement tracking"],
  targetCustomerSegments: ["operations managers", "finance leads"],
  customerPainPoints: ["manual reconciliation", "payout delays"],
  supportedOutcomes: ["faster settlements", "fewer payment disputes"],
  capabilities: ["automated disbursements", "payment reconciliation"],
  approvedClaims: ["supports payout reconciliation workflows"],
  prohibitedClaims: ["guaranteed instant wealth", "risk free returns"],
  brandLanguageConstraints: ["best in the world"],
  evidenceReferences: ["website-evidence:campaign30"],
} as const satisfies BusinessDNASnapshot;

export const campaign30Strategy = {
  snapshotId: "strategy-30-v1",
  campaignId: 30,
  version: 1,
  strategyHashSha256: "11f5f012dc6f682c5d98b46987541ec6d8bbf34695f42af8e5d6b9adbc096063",
  capturedAtIso: "2026-07-01T08:00:00.000Z",
  objective: "Increase qualified demo demand",
  funnelStage: "consideration",
  primaryAudience: "operations managers",
  messageIntent: "Show operational reliability for payout workflows",
  centralPromise: "Reduce payout admin while improving settlement clarity",
  requiredBenefits: ["faster settlements", "clear reconciliation", "fewer disputes"],
  offer: "Book a guided walkthrough",
  ctaPolicy: {
    mode: "exact",
    requiredCta: "Learn More",
  },
  constraints: ["No invented promotions"],
  prohibitedClaims: ["guaranteed overnight profits"],
} as const satisfies CampaignStrategySnapshot;

export const campaign30Policy = DEFAULT_V2_MESSAGE_QUALITY_POLICY satisfies MessageQualityPolicy;

export interface Campaign30ReplayCase {
  readonly caseId: "A" | "B" | "C" | "D" | "E" | "F";
  readonly description: string;
  readonly source:
    | "ai_refined_pack"
    | "fallback_deterministic"
    | "latest_message_pack"
    | "user_structured_copy";
  readonly legacyIsGeneric: boolean;
  readonly legacyValidationPassed: boolean;
  readonly legacyValidationScore: number;
  readonly legacyValidationRejections: readonly string[];
  readonly copy: {
    readonly headline: string;
    readonly subheadline: string;
    readonly benefitBullets: readonly string[];
    readonly cta: string;
    readonly footerContact: {
      readonly phone: string | null;
      readonly whatsapp: string | null;
      readonly email: string | null;
      readonly website: string | null;
      readonly location: string | null;
    };
  };
  readonly expectedDecision: "approved" | "rejected";
}

export const campaign30ReplayCases = [
  {
    caseId: "A",
    description: "Specific AI-refined copy with stale legacy generic metadata",
    source: "ai_refined_pack",
    legacyIsGeneric: true,
    legacyValidationPassed: false,
    legacyValidationScore: 45,
    legacyValidationRejections: ["Generic message pack"],
    copy: {
      headline: "Reduce payout delays for operations managers",
      subheadline:
        "NatForge Ops automates supplier disbursements so operations managers spend less time on manual reconciliation.",
      benefitBullets: [
        "Automate payout automation workflows across restaurant team payouts.",
        "Track supplier settlement tracking with a reconciliation dashboard.",
        "Cut manual reconciliation work and resolve payout delays faster.",
      ],
      cta: "Learn More",
      footerContact: {
        phone: null,
        whatsapp: null,
        email: "team@natforgeops.test",
        website: "natforgeops.test",
        location: "Johannesburg",
      },
    },
    expectedDecision: "approved",
  },
  {
    caseId: "B",
    description: "Genuinely generic AI-refined copy with stale success metadata",
    source: "ai_refined_pack",
    legacyIsGeneric: false,
    legacyValidationPassed: true,
    legacyValidationScore: 100,
    legacyValidationRejections: [],
    copy: {
      headline: "Transform your business today",
      subheadline: "Unlock success with comprehensive solutions for every company.",
      benefitBullets: [
        "Amazing results for your business.",
        "Join thousands of happy customers.",
        "Best outcomes with modern solutions.",
      ],
      cta: "Learn More",
      footerContact: {
        phone: null,
        whatsapp: null,
        email: null,
        website: null,
        location: null,
      },
    },
    expectedDecision: "rejected",
  },
  {
    caseId: "C",
    description: "Valid deterministic fallback grounded in policy",
    source: "fallback_deterministic",
    legacyIsGeneric: false,
    legacyValidationPassed: true,
    legacyValidationScore: 95,
    legacyValidationRejections: [],
    copy: {
      headline: "Simplify supplier disbursements with payout automation",
      subheadline:
        "Built for operations managers who need faster settlements and fewer payout delays.",
      benefitBullets: [
        "Automated disbursements improve restaurant team payouts in minutes.",
        "Payment reconciliation reduces manual reconciliation across teams.",
        "Supplier settlement tracking lowers payout disputes by keeping records clear.",
      ],
      cta: "Learn More",
      footerContact: {
        phone: null,
        whatsapp: null,
        email: "team@natforgeops.test",
        website: "natforgeops.test",
        location: "Johannesburg",
      },
    },
    expectedDecision: "approved",
  },
  {
    caseId: "D",
    description: "Invalid deterministic fallback with generic benefits",
    source: "fallback_deterministic",
    legacyIsGeneric: false,
    legacyValidationPassed: true,
    legacyValidationScore: 90,
    legacyValidationRejections: [],
    copy: {
      headline: "Comprehensive solutions for everyone",
      subheadline: "Support every business with modern tools.",
      benefitBullets: [
        "Great outcomes for your business.",
        "Reliable support for all companies.",
        "Easy growth for any brand.",
      ],
      cta: "Learn More",
      footerContact: {
        phone: null,
        whatsapp: null,
        email: null,
        website: null,
        location: null,
      },
    },
    expectedDecision: "rejected",
  },
  {
    caseId: "E",
    description: "CTA mutation invalidates prior approval identity",
    source: "ai_refined_pack",
    legacyIsGeneric: false,
    legacyValidationPassed: true,
    legacyValidationScore: 92,
    legacyValidationRejections: [],
    copy: {
      headline: "Keep payout reconciliation audit-ready",
      subheadline:
        "Operations managers can automate supplier disbursements while cutting payout delays.",
      benefitBullets: [
        "Payout automation shortens settlement time for restaurant team payouts.",
        "Reconciliation dashboard highlights exceptions before disputes escalate.",
        "Automated disbursements reduce manual reconciliation workload each week.",
      ],
      cta: "Learn More",
      footerContact: {
        phone: null,
        whatsapp: null,
        email: "team@natforgeops.test",
        website: "natforgeops.test",
        location: "Johannesburg",
      },
    },
    expectedDecision: "approved",
  },
  {
    caseId: "F",
    description: "Benefit mutation changes hash after assessment",
    source: "ai_refined_pack",
    legacyIsGeneric: false,
    legacyValidationPassed: true,
    legacyValidationScore: 91,
    legacyValidationRejections: [],
    copy: {
      headline: "Automate team and supplier payouts",
      subheadline:
        "NatForge Ops helps operations managers and finance leads reduce payout delays with payout automation and manual reconciliation support.",
      benefitBullets: [
        "Automated disbursements accelerate restaurant team payouts.",
        "Supplier disbursements and supplier settlement tracking keep payout records consistent.",
        "Payment reconciliation resolves manual reconciliation bottlenecks.",
      ],
      cta: "Learn More",
      footerContact: {
        phone: null,
        whatsapp: null,
        email: "team@natforgeops.test",
        website: "natforgeops.test",
        location: "Johannesburg",
      },
    },
    expectedDecision: "approved",
  },
] as const satisfies readonly Campaign30ReplayCase[];
