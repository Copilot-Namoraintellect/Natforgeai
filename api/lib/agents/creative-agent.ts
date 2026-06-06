import { z } from "zod";
import { runAgent } from "./runner";
import { getDb } from "../../queries/connection";
import { campaigns, contentPosts, campaignAssets } from "@db/schema";
import { eq, and } from "drizzle-orm";

const ContentCalendarSchema = z.object({
  days: z.array(
    z.object({
      day: z.number().min(1).max(30),
      date: z.string(), // ISO date string
      theme: z.string(),
      posts: z.array(
        z.object({
          platform: z.string(),
          type: z.enum(["social_post", "ad_copy", "email", "script", "blog", "story"]),
          title: z.string(),
          hook: z.string(),
          caption: z.string(),
          cta: z.string(),
          hashtags: z.array(z.string()),
          visualPrompt: z.string(),
          bestTimeToPost: z.string(),
        })
      ),
    })
  ),
});

const CreativeAssetsSchema = z.object({
  assets: z.array(
    z.object({
      assetType: z.enum([
        "image",
        "video_script",
        "carousel",
        "ad_copy",
        "caption",
        "hashtag_set",
        "cta_variant",
        "email_copy",
        "whatsapp_copy",
      ]),
      title: z.string(),
      content: z.string(),
      prompt: z.string().nullable(),
      platform: z.string().nullable(),
      variations: z.array(z.string()).nullable(),
    })
  ),
});

export type ContentCalendarOutput = z.infer<typeof ContentCalendarSchema>;
export type CreativeAssetsOutput = z.infer<typeof CreativeAssetsSchema>;

export async function runCreativeAgent({
  userId,
  campaignId,
}: {
  userId: number;
  campaignId: number;
}) {
  const db = getDb();

  // Get campaign and business info
  const [campaign] = await db
    .select()
    .from(campaigns)
    .where(eq(campaigns.id, campaignId))
    .limit(1);

  if (!campaign) {
    throw new Error("Campaign not found");
  }

  const strategyContext = campaign.workflowContext as any;
  const personas = campaign.personas as any[];
  const coreMessage = campaign.coreMessage;
  const ctaStrategy = campaign.ctaStrategy;

  // Step 1: Generate 30-day content calendar
  const calendarPrompt = `You are a sales-focused content strategist who creates high-converting marketing calendars. Every post must be designed to drive revenue — no generic brand awareness filler.

CAMPAIGN DETAILS:
- Name: ${campaign.name}
- Goal: ${campaign.goal}
- Core Message: ${coreMessage || "Not specified"}
- CTA Strategy: ${ctaStrategy || "Not specified"}
- Target Audience: ${campaign.targetAudience || "Not specified"}
- Platforms: ${campaign.platforms || "Instagram, Facebook, TikTok"}
- Personas: ${personas ? JSON.stringify(personas.map((p: any) => p.name || p)) : "General audience"}

${strategyContext?.campaignTheme ? `Campaign Theme: ${strategyContext.campaignTheme}` : ""}
${strategyContext?.platformStrategy ? `Platform Strategy: ${JSON.stringify(strategyContext.platformStrategy)}` : ""}

Create a 30-day sales-driven content calendar with:
- Each day should have 1-3 posts across different platforms
- 60% direct-response content (pain-point hooks, urgency-driven CTAs, limited-time offers)
- 20% authority-building (results, case studies, testimonials)
- 20% engagement (but with clear path to purchase)
- EVERY post must include: a scroll-stopping HOOK, body copy that addresses a pain point, a clear CTA with urgency, and relevant hashtags
- Include a detailed visual generation prompt for each post (describe the image/video content explicitly)
- Specify best time to post for maximum reach
- Include Instagram Reels and TikTok scripts where relevant
- Progress through: hook → agitate pain → present solution → add urgency → strong CTA

Post structure rules:
- HOOK: First line must be bold, emotional, or controversial (max 12 words)
- CAPTION: 2-4 short paragraphs max. Use line breaks. Speak directly to the reader. No fluff.
- CTA: Must specify exact action and create urgency ("Link in bio — only 20 spots", "DM 'YES' now", etc.)
- HASHTAGS: 5-10 targeted tags, mixing niche + trending
- VISUAL PROMPT: Describe the image/video scene in detail for AI image generation tools

Respond with structured data.`;

  const calendarResult = await runAgent({
    userId,
    campaignId,
    agentType: "creative",
    prompt: calendarPrompt,
    schema: ContentCalendarSchema,
    system:
      "You are an expert performance marketer who creates high-converting, sales-driven content calendars. You specialize in Instagram Reels, TikTok, Facebook ads, and direct-response copywriting. Every post must drive action, not just engagement. Always respond with valid structured data.",
  });

  // Save content calendar to campaign immediately (before assets)
  await db
    .update(campaigns)
    .set({
      contentCalendar: calendarResult.output.days as any,
      workflowContext: {
        ...(strategyContext || {}),
        creativeGeneratedAt: new Date().toISOString(),
        creativeRunId: calendarResult.runId,
      } as any,
    })
    .where(eq(campaigns.id, campaignId));

  // Prevent duplicate content posts on retry: delete existing aiGenerated drafts
  const existingDrafts = await db
    .select()
    .from(contentPosts)
    .where(
      and(
        eq(contentPosts.campaignId, campaignId),
        eq(contentPosts.aiGenerated, true),
        eq(contentPosts.status, "draft")
      )
    );

  for (const draft of existingDrafts) {
    await db.delete(contentPosts).where(eq(contentPosts.id, draft.id));
  }

  // Create content_posts records from calendar (best-effort)
  let savedPosts = 0;
  for (const day of calendarResult.output.days) {
    for (const post of day.posts) {
      try {
        await db.insert(contentPosts).values({
          userId,
          campaignId,
          title: post.title,
          type: post.type,
          platform: post.platform,
          hook: post.hook,
          caption: post.caption,
          cta: post.cta,
          hashtags: Array.isArray(post.hashtags) ? post.hashtags.join(" ") : post.hashtags,
          visualPrompt: post.visualPrompt,
          status: "draft",
          aiGenerated: true,
          scheduledFor: new Date(day.date),
        });
        savedPosts++;
      } catch (err: any) {
        console.error("[CreativeAgent] Failed to save content post:", err.message);
      }
    }
  }
  console.log(`[CreativeAgent] Saved ${savedPosts} content posts for campaign ${campaignId}`);

  // Step 2: Generate additional creative assets (optional - don't fail the whole workflow)
  const assetsPrompt = `You are a conversion-focused creative director. Generate high-performing sales assets for this campaign. Every asset must be designed to drive clicks, leads, or purchases.

CAMPAIGN DETAILS:
- Name: ${campaign.name}
- Goal: ${campaign.goal}
- Core Message: ${coreMessage || "Not specified"}
- CTA Strategy: ${ctaStrategy || "Not specified"}
- Target Audience: ${campaign.targetAudience || "Not specified"}
- Platforms: ${campaign.platforms || "Instagram, Facebook, TikTok"}

Generate:
1. 3 high-converting ad copy variations (different psychological angles: fear of missing out, social proof, direct benefit)
2. 3 email subject lines + body copy for a sales sequence (subject lines must be under 40 chars, body under 150 words each)
3. 3 WhatsApp message templates for follow-ups and closing (casual but persuasive tone)
4. 5 image generation prompts for conversion-focused hero visuals (describe exact scene, colors, text overlay, emotional trigger)
5. A sales carousel post outline (5 slides: hook → problem → solution → proof → CTA)
6. 3 CTA variations for different funnel stages (awareness, consideration, decision)
7. 2 Instagram Reel scripts with exact hook text, 15-30 second structure, and on-screen text suggestions

Respond with structured data. Always include prompt, platform, and variations keys for every asset. Use null when they do not apply.`;

  let assetsResult: { runId: number; output: z.infer<typeof CreativeAssetsSchema> } | undefined;
  let assetsError: string | undefined;
  try {
    assetsResult = await runAgent({
      userId,
      campaignId,
      agentType: "creative",
      prompt: assetsPrompt,
      schema: CreativeAssetsSchema,
      system:
        "You are an expert copywriter and creative director. You create high-converting marketing assets across all channels. Always respond with valid structured data. Always include prompt, platform, and variations keys. Use null when a field does not apply.",
    });
  } catch (err: any) {
    console.error("[CreativeAgent] Assets generation failed:", err.message);
    assetsError = err.message;
    // Continue without assets - calendar and posts are the core deliverables
  }

  // Update campaign with final context including assets info
  await db
    .update(campaigns)
    .set({
      workflowContext: {
        ...(strategyContext || {}),
        creativeGeneratedAt: new Date().toISOString(),
        creativeRunId: calendarResult.runId,
        assetsRunId: assetsResult?.runId ?? null,
        assetsGenerationError: assetsError ?? null,
      } as any,
    })
    .where(eq(campaigns.id, campaignId));

  // Create campaign_assets records (best-effort)
  let savedAssets = 0;
  if (assetsResult) {
    for (const asset of assetsResult.output.assets) {
      try {
        await db.insert(campaignAssets).values({
          userId,
          campaignId,
          assetType: asset.assetType,
          title: asset.title,
          prompt: asset.prompt ?? null,
          status: "ready",
          metadata: {
            content: asset.content,
            platform: asset.platform,
            variations: asset.variations,
          } as any,
        });
        savedAssets++;
      } catch (err: any) {
        console.error("[CreativeAgent] Failed to save campaign asset:", err.message);
      }
    }
  }
  console.log(`[CreativeAgent] Saved ${savedAssets} campaign assets for campaign ${campaignId}`);

  return {
    calendarRunId: calendarResult.runId,
    assetsRunId: assetsResult?.runId ?? null,
    calendar: calendarResult.output,
    assets: assetsResult?.output ?? null,
    savedPosts,
    savedAssets,
  };
}
