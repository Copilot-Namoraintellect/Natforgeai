import { createHash } from "crypto";
import type {
  BusinessDNASnapshot,
  CampaignStrategySnapshot,
  ShadowEvaluationResult,
} from "../contracts";
import { normalizeFunnelStage, selectStageCta } from "../../cta-utils";
import {
  extractApprovedStrategyLineage,
  observeIfEnabled,
  resolveExpectedApprovedStrategyFingerprint,
} from "../../contracts/observe-quality-authority";
import { InMemoryWorkflowOperationRegistry } from "../../../workflow/workflow-operation";

export interface LegacyValidationContextInput {
  readonly businessName?: string;
  readonly industry?: string;
  readonly productOrService?: string;
  readonly targetCustomer?: string;
  readonly mainPainPoint?: string;
  readonly campaignObjective?: string;
  readonly funnelStage?: string;
  readonly preferredCta?: string;
}

export interface LegacyLoadedShadowContextInput {
  readonly campaignId: number;
  readonly business?: any;
  readonly campaign?: any;
  readonly validationContext?: LegacyValidationContextInput;
  /**
   * Injected workflow-operation registry for cross-point observation.  When
   * omitted, observe mode will safely skip cross-point correlation.
   */
  readonly registry?: InMemoryWorkflowOperationRegistry | null;
}

export interface LegacyShadowContextProjection {
  readonly businessDna: BusinessDNASnapshot;
  readonly campaignStrategy: CampaignStrategySnapshot;
  readonly diagnostics: Pick<
    ShadowEvaluationResult,
    "contextSource" | "contextReadyForComparison" | "missingContextFields"
  >;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => text(item)).filter(Boolean);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function stableHash(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
}

export function buildLegacyShadowContextProjection(
  input: LegacyLoadedShadowContextInput
): LegacyShadowContextProjection {
  const business = (input.business || {}) as any;
  const campaign = (input.campaign || {}) as any;
  const ctx = (input.validationContext || {}) as LegacyValidationContextInput;
  const evidence = (business.websiteEvidence || {}) as any;

  const productsAndServices = unique([
    ...toStringArray(evidence.productsServices),
    text(business.productOrService),
    text(ctx.productOrService),
  ]);

  const verifiedUseCases = unique([
    ...toStringArray(evidence.productsServices),
    text(campaign.productOrService),
  ]);

  const targetCustomerSegments = unique([
    ...toStringArray(evidence.targetCustomers),
    text(business.targetCustomer),
    text(business.targetAudience),
    text(campaign.targetBuyer),
    text(ctx.targetCustomer),
  ]);

  const customerPainPoints = unique([
    text(campaign.mainPainPoint),
    text(ctx.mainPainPoint),
  ]);

  const supportedOutcomes = unique([
    ...toStringArray(campaign.keyOutcomes),
    text(campaign.goal),
    text(campaign.primaryOutcome),
  ]);

  const capabilities = unique([
    ...toStringArray(evidence.productsServices),
    text(ctx.productOrService),
  ]);

  const businessProjection = {
    businessId: Number.isFinite(Number(business.id)) ? Number(business.id) : 0,
    version: 1,
    businessName: text(business.name) || text(ctx.businessName),
    industry: text(business.industry) || text(evidence.businessCategory) || text(ctx.industry),
    primaryOffering: text(business.productOrService) || text(ctx.productOrService),
    productsAndServices,
    verifiedUseCases,
    targetCustomerSegments,
    customerPainPoints,
    supportedOutcomes,
    capabilities,
    approvedClaims: [] as string[],
    prohibitedClaims: unique(toStringArray(business.avoidWords)),
    brandLanguageConstraints: [] as string[],
    evidenceReferences: [text(evidence.location)].filter(Boolean),
  };

  const evidenceHashSha256 = stableHash({
    businessName: businessProjection.businessName,
    industry: businessProjection.industry,
    primaryOffering: businessProjection.primaryOffering,
    productsAndServices: businessProjection.productsAndServices,
    verifiedUseCases: businessProjection.verifiedUseCases,
    targetCustomerSegments: businessProjection.targetCustomerSegments,
    customerPainPoints: businessProjection.customerPainPoints,
    supportedOutcomes: businessProjection.supportedOutcomes,
    capabilities: businessProjection.capabilities,
    prohibitedClaims: businessProjection.prohibitedClaims,
    evidenceReferences: businessProjection.evidenceReferences,
  });

  const businessDna: BusinessDNASnapshot = {
    snapshotId: `shadow-bdna-${businessProjection.businessId}-${evidenceHashSha256.slice(0, 16)}`,
    businessId: businessProjection.businessId,
    version: businessProjection.version,
    evidenceHashSha256,
    capturedAtIso: new Date(0).toISOString(),
    businessName: businessProjection.businessName,
    industry: businessProjection.industry,
    primaryOffering: businessProjection.primaryOffering,
    productsAndServices: businessProjection.productsAndServices,
    verifiedUseCases: businessProjection.verifiedUseCases,
    targetCustomerSegments: businessProjection.targetCustomerSegments,
    customerPainPoints: businessProjection.customerPainPoints,
    supportedOutcomes: businessProjection.supportedOutcomes,
    capabilities: businessProjection.capabilities,
    approvedClaims: businessProjection.approvedClaims,
    prohibitedClaims: businessProjection.prohibitedClaims,
    brandLanguageConstraints: businessProjection.brandLanguageConstraints,
    evidenceReferences: businessProjection.evidenceReferences,
  };

  const requiredCta = text(
    selectStageCta(text(ctx.preferredCta) || text(campaign.preferredCta) || text(campaign.ctaStrategy), text(ctx.funnelStage) || text(ctx.campaignObjective) || text(campaign.primaryOutcome) || text(campaign.goal))
  );
  const campaignId = Number.isFinite(Number(campaign.id)) ? Number(campaign.id) : input.campaignId;

  // Slice 1 observation: compare legacy-selected CTA with the new CreativeContract authority.
  // This block must not change the returned projection or any persisted state.
  {
    const workflowContext = (campaign?.workflowContext || {}) as Record<string, unknown>;
    const userId = Number.isFinite(Number(campaign?.userId)) ? Number(campaign.userId) : 0;
    const lineage = extractApprovedStrategyLineage(workflowContext, campaignId, userId);
    observeIfEnabled("legacy shadow context observation", {
      campaignId,
      userId,
      businessId: businessDna.businessId,
      businessName: businessDna.businessName,
      lineage,
      expectedApprovedStrategyFingerprint: resolveExpectedApprovedStrategyFingerprint(workflowContext),
      funnelStage: normalizeFunnelStage(ctx.funnelStage || campaign.primaryOutcome || campaign.goal),
      campaignInputCta: text(ctx.preferredCta) || text(campaign.preferredCta) || text(campaign.ctaStrategy) || null,
      offerActionCta: null,
      targetAudience: text(ctx.targetCustomer) || text(campaign.targetBuyer),
      offer: text(campaign.offerDetails),
      businessCapabilities: businessDna.productsAndServices,
      legacySelectedCta: requiredCta,
      attemptType: "message_pack",
      registry: input.registry ?? null,
      proposedContent: {
        headline: text(campaign.name) || businessDna.primaryOffering,
        primaryText: text(campaign.goal) || text(campaign.primaryOutcome) || businessDna.primaryOffering,
        benefits: businessDna.capabilities.slice(0, 3),
        cta: requiredCta,
        funnelStage: normalizeFunnelStage(ctx.funnelStage || campaign.primaryOutcome || campaign.goal),
        targetAudience: text(ctx.targetCustomer) || text(campaign.targetBuyer),
        offer: text(campaign.offerDetails) || null,
        businessName: businessDna.businessName,
        protectedFields: {
          businessName: businessDna.businessName,
        },
      },
    });
  }

  const strategyProjection = {
    campaignId: Number.isFinite(Number(campaign.id)) ? Number(campaign.id) : input.campaignId,
    version: 1,
    objective: text(campaign.goal) || text(campaign.primaryOutcome) || text(ctx.campaignObjective),
    funnelStage: text(ctx.funnelStage),
    primaryAudience: text(campaign.targetBuyer) || text(ctx.targetCustomer),
    messageIntent: text(campaign.name),
    centralPromise: text(campaign.offerDetails),
    requiredBenefits: unique(toStringArray(campaign.keyOutcomes)),
    offer: text(campaign.offerDetails),
    ctaPolicy: {
      mode: "exact" as const,
      requiredCta,
    },
    constraints: [] as string[],
    prohibitedClaims: unique(toStringArray(campaign.excludedOffers)),
  };

  const strategyHashSha256 = stableHash({
    objective: strategyProjection.objective,
    funnelStage: strategyProjection.funnelStage,
    primaryAudience: strategyProjection.primaryAudience,
    messageIntent: strategyProjection.messageIntent,
    centralPromise: strategyProjection.centralPromise,
    requiredBenefits: strategyProjection.requiredBenefits,
    offer: strategyProjection.offer,
    ctaPolicy: strategyProjection.ctaPolicy,
    constraints: strategyProjection.constraints,
    prohibitedClaims: strategyProjection.prohibitedClaims,
  });

  const campaignStrategy: CampaignStrategySnapshot = {
    snapshotId: `shadow-strategy-${strategyProjection.campaignId}-${strategyHashSha256.slice(0, 16)}`,
    campaignId: strategyProjection.campaignId,
    version: strategyProjection.version,
    strategyHashSha256,
    capturedAtIso: new Date(0).toISOString(),
    objective: strategyProjection.objective,
    funnelStage: strategyProjection.funnelStage,
    primaryAudience: strategyProjection.primaryAudience,
    messageIntent: strategyProjection.messageIntent,
    centralPromise: strategyProjection.centralPromise,
    requiredBenefits: strategyProjection.requiredBenefits,
    offer: strategyProjection.offer,
    ctaPolicy: strategyProjection.ctaPolicy,
    constraints: strategyProjection.constraints,
    prohibitedClaims: strategyProjection.prohibitedClaims,
  };

  const missingContextFields = [
    !businessDna.businessName ? "businessName" : "",
    !businessDna.primaryOffering ? "primaryOffering" : "",
    businessDna.productsAndServices.length === 0 ? "productsAndServices" : "",
    campaignStrategy.primaryAudience ? "" : "primaryAudience",
    campaignStrategy.objective ? "" : "objective",
    campaignStrategy.ctaPolicy.mode === "exact" && campaignStrategy.ctaPolicy.requiredCta
      ? ""
      : "ctaPolicy.requiredCta",
  ].filter(Boolean);

  return {
    businessDna,
    campaignStrategy,
    diagnostics: {
      contextSource: "legacy_loaded_context",
      contextReadyForComparison: missingContextFields.length === 0,
      missingContextFields,
    },
  };
}
