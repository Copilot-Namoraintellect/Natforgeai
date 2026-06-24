import { z } from "zod";
import { runAgent } from "./runner";
import { getDb } from "../../queries/connection";
import {
  campaigns,
  businesses,
  leads,
  leadActivities,
  leadScores,
  outreachRecommendations,
  campaignInterestSignals,
  socialEngagementEvents,
} from "@db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { extractCampaignKeywords, computeBaselineScore } from "../audience/scoring";
import { normaliseOutput, type AudienceIntelligenceOutput } from "./audience-intelligence-normalise";

// ─── Strict Output Schema ───
// OpenAI structured output requires EVERY property to be in the required array.
// Use .nullable() instead of .optional().

const OutreachAngleSchema = z.object({
  channel: z.enum(["email", "instagram_dm", "facebook_dm", "linkedin_dm", "whatsapp", "sms"]),
  hook: z.string(),
  cta: z.string(),
  expectedOutcome: z.string(),
});

const DiscoveredProfileSchema = z.object({
  handle: z.string(),
  platform: z.string(),
  displayName: z.string().nullable(),
  followerCount: z.number().nullable(),
  relevanceScore: z.number(),
  whyRelevant: z.string(),
  suggestedAngle: z.string(),
});

const ScoredLeadSchema = z.object({
  externalIdentifier: z.string(),
  platform: z.string(),
  handle: z.string().nullable(),
  displayName: z.string().nullable(),
  score: z.number(),
  confidence: z.enum(["low", "medium", "high"]),
  signals: z.array(z.string()),
  recommendedAction: z.enum(["reach_out", "nurture", "ignore"]),
  explanation: z.string(),
  outreachAngles: z.array(OutreachAngleSchema),
});

const ContentResonanceSchema = z.object({
  theme: z.string(),
  engagementLevel: z.enum(["low", "medium", "high"]),
  insight: z.string(),
});

const AudienceIntelligenceSchema = z.object({
  executiveSummary: z.string(),
  discoveredProfiles: z.array(DiscoveredProfileSchema),
  scoredLeads: z.array(ScoredLeadSchema),
  contentResonance: z.array(ContentResonanceSchema),
  nextSteps: z.array(z.string()),
});

export type { AudienceIntelligenceOutput };

interface RunAudienceIntelligenceOptions {
  userId: number;
  campaignId: number;
  autoCreateLeads?: boolean;
}

export async function runAudienceIntelligenceAgent({
  userId,
  campaignId,
  autoCreateLeads = false,
}: RunAudienceIntelligenceOptions) {
  const db = getDb();

  // Load campaign + business
  const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
  if (!campaign) throw new Error("Campaign not found");

  let business: typeof businesses.$inferSelect | null = null;
  if (campaign.businessId) {
    const [b] = await db.select().from(businesses).where(eq(businesses.id, campaign.businessId)).limit(1);
    business = b ?? null;
  }

  const workflowContext = (campaign.workflowContext || {}) as Record<string, unknown>;
  const audienceProfiles = Array.isArray(workflowContext?.audienceProfiles)
    ? workflowContext.audienceProfiles
    : [];

  // Load signals + source events
  const signals = await db
    .select()
    .from(campaignInterestSignals)
    .where(
      and(
        eq(campaignInterestSignals.userId, userId),
        eq(campaignInterestSignals.campaignId, campaignId)
      )
    )
    .orderBy(campaignInterestSignals.strength);

  const sourceEventIds = signals.flatMap((s) => (Array.isArray(s.sourceEventIds) ? s.sourceEventIds : []) as number[]);

  const events = sourceEventIds.length
    ? await db
        .select()
        .from(socialEngagementEvents)
        .where(inArray(socialEngagementEvents.id, sourceEventIds))
    : [];

  const eventMap = new Map(events.map((e) => [e.id, e]));

  // Compute baseline scores
  const campaignKeywords = extractCampaignKeywords({
    name: campaign.name,
    goal: campaign.goal,
    targetAudience: campaign.targetAudience,
    productOrService: campaign.productOrService,
    offerDetails: campaign.offerDetails,
    primaryOutcome: campaign.primaryOutcome,
    coreMessage: campaign.coreMessage,
  });

  const baselineScores = new Map<number, ReturnType<typeof computeBaselineScore>>();
  for (const signal of signals) {
    const sourceEvents = (Array.isArray(signal.sourceEventIds)
      ? (signal.sourceEventIds as number[]).map((id) => eventMap.get(id)).filter(Boolean)
      : []) as typeof events;
    baselineScores.set(signal.id, computeBaselineScore(signal, sourceEvents, campaignKeywords));
  }

  // Load existing leads for deduplication context
  const existingLeads = await db.select().from(leads).where(eq(leads.userId, userId));
  const existingLeadIdentifiers = new Set(
    existingLeads
      .map((l) => (l.customFields as Record<string, unknown> | null)?.externalIdentifier)
      .filter((v): v is string => typeof v === "string")
  );

  // Build prompt
  const signalSummary = signals.map((s) => {
    const baseline = baselineScores.get(s.id);
    return {
      externalIdentifier: s.externalIdentifier,
      platform: s.signalType,
      strength: s.strength,
      baselineScore: baseline?.score ?? 0,
      keywordBonus: baseline?.keywordBonus ?? 0,
      contextSnippet: s.contextSnippet,
    };
  });

  const prompt = `You are an expert audience intelligence and lead discovery analyst. Analyse the permissioned social data below and identify the best leads and outreach angles for the campaign.

CAMPAIGN:
- Name: ${campaign.name}
- Goal: ${campaign.goal}
- Target Audience: ${campaign.targetAudience || "Not specified"}
- Product/Service: ${campaign.productOrService || "Not specified"}
- Offer: ${campaign.offerDetails || "Not specified"}
- Primary Outcome: ${campaign.primaryOutcome || "Not specified"}
- Core Message: ${campaign.coreMessage || "Not specified"}
- Location: ${business?.location || campaign.targetAudience || "Not specified"}
- Industry: ${business?.industry || "Not specified"}
- Brand Tone: ${business?.brandTone || "professional"}

BUSINESS CONTEXT:
- Name: ${business?.name || "Not specified"}
- Website: ${business?.website || "Not specified"}
- Target Customer: ${business?.targetCustomer || "Not specified"}

EXISTING AUDIENCE PROFILES:
${audienceProfiles.length > 0 ? JSON.stringify(audienceProfiles.slice(0, 4)) : "None available"}

INGESTED INTEREST SIGNALS (rule-based baseline):
${JSON.stringify(signalSummary.slice(-50), null, 2)}

EXISTING LEAD IDENTIFIERS (do not duplicate):
${JSON.stringify(Array.from(existingLeadIdentifiers).slice(0, 100))}

CAMPAIGN KEYWORDS FOR MATCHING:
${campaignKeywords.slice(0, 30).join(", ")}

YOUR TASK:
1. Write a short executive summary of who is engaging and why.
2. List 3-8 discovered social profiles/communities that look relevant (include handle, platform, follower count if known, and why relevant).
3. Score and rank leads from the signals above. Each lead must have an externalIdentifier matching the signal, plus platform, handle/displayName if available, score 0-100, confidence (low/medium/high), signals, recommendedAction (reach_out/nurture/ignore), explanation, and 1-3 outreachAngles.
4. Summarise content resonance: what themes are getting engagement and what insight can guide future creative?
5. Provide 3-5 concrete next steps.

SCORING GUIDANCE:
- Score 70-100 + confidence medium/high = reach_out
- Score 40-69 = nurture
- Score below 40 = ignore
- Use the baseline scores and keyword bonuses as a starting point. Adjust ±15 points based on fit with the campaign audience and B2B/B2C context.
- Never invent signals; only score leads present in the data above.

COMPLIANCE:
- Do not include private messages or personal information beyond what is needed for outreach.
- Do not invent contact details (email/phone) unless they appear in the input data.

CRITICAL SCHEMA RULES:
- Every object must include EVERY key declared in its schema.
- If a value is unknown, return null. Do NOT omit keys.
- Respond with valid structured data only.`;

  const result = await runAgent({
    userId,
    campaignId,
    agentType: "audience",
    prompt,
    schema: AudienceIntelligenceSchema,
    system:
      "You are an expert marketing analyst specialising in lead discovery and social audience intelligence. You turn engagement signals into actionable, scored lead recommendations. CRITICAL: include EVERY key in every object. Use null for unknown values. Never omit a key.",
  });

  const normalised = normaliseOutput(result.output);

  // Persist results
  const createdLeadIds = await persistAudienceIntelligence(
    db,
    userId,
    campaign,
    normalised,
    autoCreateLeads
  );

  // Update campaign workflow context
  await db
    .update(campaigns)
    .set({
      workflowContext: {
        ...workflowContext,
        audienceIntelligenceGeneratedAt: new Date().toISOString(),
        audienceIntelligenceRunId: result.runId,
        audienceIntelligenceSummary: {
          executiveSummary: normalised.executiveSummary,
          scoredLeadCount: normalised.scoredLeads.length,
          reachOutCount: normalised.scoredLeads.filter((l) => l.recommendedAction === "reach_out").length,
        },
      } as Record<string, unknown>,
    })
    .where(eq(campaigns.id, campaignId));

  return { runId: result.runId, output: normalised, createdLeadIds };
}

async function persistAudienceIntelligence(
  db: ReturnType<typeof getDb>,
  userId: number,
  campaign: typeof campaigns.$inferSelect,
  output: AudienceIntelligenceOutput,
  autoCreateLeads: boolean
): Promise<number[]> {
  const createdLeadIds: number[] = [];
  const businessId = campaign.businessId ?? null;

  // Map existing leads by external identifier
  const existingLeads = await db.select().from(leads).where(eq(leads.userId, userId));
  const leadByExternalId = new Map<string, typeof leads.$inferSelect>();
  for (const lead of existingLeads) {
    const extId = (lead.customFields as Record<string, unknown> | null)?.externalIdentifier;
    if (typeof extId === "string") leadByExternalId.set(extId, lead);
  }

  // Build a map of signals by external identifier for metadata
  const signalRows = await db
    .select()
    .from(campaignInterestSignals)
    .where(
      and(
        eq(campaignInterestSignals.userId, userId),
        eq(campaignInterestSignals.campaignId, campaign.id)
      )
    );
  const signalByExternalId = new Map(signalRows.map((s) => [s.externalIdentifier, s]));

  for (const lead of output.scoredLeads) {
    if (!lead.externalIdentifier) continue;

    const signal = signalByExternalId.get(lead.externalIdentifier);

    // Upsert lead score
    const scoreValues = {
      userId,
      businessId,
      campaignId: campaign.id,
      leadId: leadByExternalId.get(lead.externalIdentifier)?.id ?? null,
      socialProfileId: signal?.socialProfileId ?? null,
      externalIdentifier: lead.externalIdentifier,
      platform: lead.platform || signal?.externalIdentifier?.split(":")[0] || "unknown",
      handle: lead.handle,
      displayName: lead.displayName,
      score: lead.score,
      confidence: lead.confidence,
      signalsSummary: lead.signals,
      explanation: lead.explanation,
      recommendedAction: lead.recommendedAction,
      scoredAt: new Date(),
    };

    await db
      .insert(leadScores)
      .values(scoreValues)
      .onDuplicateKeyUpdate({
        set: {
          leadId: scoreValues.leadId,
          socialProfileId: scoreValues.socialProfileId,
          handle: scoreValues.handle,
          displayName: scoreValues.displayName,
          score: scoreValues.score,
          confidence: scoreValues.confidence,
          signalsSummary: scoreValues.signalsSummary,
          explanation: scoreValues.explanation,
          recommendedAction: scoreValues.recommendedAction,
          scoredAt: scoreValues.scoredAt,
          updatedAt: new Date(),
        },
      });

    // Retrieve the lead score id
    const [scoreRow] = await db
      .select()
      .from(leadScores)
      .where(
        and(
          eq(leadScores.userId, userId),
          eq(leadScores.campaignId, campaign.id),
          eq(leadScores.externalIdentifier, lead.externalIdentifier)
        )
      )
      .limit(1);

    if (!scoreRow) continue;

    // Delete old recommendations for this score and insert new ones
    await db.delete(outreachRecommendations).where(eq(outreachRecommendations.leadScoreId, scoreRow.id));

    const topAngles = lead.outreachAngles.slice(0, 3);
    if (topAngles.length > 0 && lead.recommendedAction === "reach_out") {
      await db.insert(outreachRecommendations).values(
        topAngles.map((angle, idx) => ({
          userId,
          businessId,
          campaignId: campaign.id,
          leadScoreId: scoreRow.id,
          leadId: scoreRow.leadId,
          channel: angle.channel,
          angle: angle.hook,
          personalisedHook: angle.hook,
          cta: angle.cta,
          expectedOutcome: angle.expectedOutcome,
          priority: lead.score - idx,
        }))
      );
    }

    // Auto-create leads for high scorers
    if (autoCreateLeads && lead.recommendedAction === "reach_out" && lead.score >= 70 && lead.confidence !== "low") {
      if (!leadByExternalId.has(lead.externalIdentifier)) {
        const [insertResult] = await db.insert(leads).values({
          userId,
          businessId,
          campaignId: campaign.id,
          name: lead.displayName || lead.handle || `Lead from ${lead.platform}`,
          source: lead.platform,
          score: lead.score,
          status: "new",
          notes: lead.explanation,
          customFields: {
            externalIdentifier: lead.externalIdentifier,
            handle: lead.handle,
            platform: lead.platform,
            discoveredBy: "audience_intelligence_agent",
          },
        });
        const leadId = Number(insertResult.insertId);
        createdLeadIds.push(leadId);
        leadByExternalId.set(lead.externalIdentifier, {
          id: leadId,
        } as typeof leads.$inferSelect);

        await db.insert(leadActivities).values({
          leadId,
          type: "note",
          description: `Discovered by Audience Intelligence Agent (score ${lead.score}, confidence ${lead.confidence}). ${lead.explanation}`,
        });

        // Update the lead score + recommendations with the new leadId
        await db
          .update(leadScores)
          .set({ leadId })
          .where(eq(leadScores.id, scoreRow.id));
        await db
          .update(outreachRecommendations)
          .set({ leadId })
          .where(eq(outreachRecommendations.leadScoreId, scoreRow.id));
      }
    }
  }

  return createdLeadIds;
}
