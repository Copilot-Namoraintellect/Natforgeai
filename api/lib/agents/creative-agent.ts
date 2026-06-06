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
  const calendarPrompt = `You are a content strategist and social media manager. Create a detailed 30-day content calendar for this marketing campaign.

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

Create a 30-day content calendar with:
- Each day should have 1-3 posts across different platforms
- Mix of educational, promotional, engagement, and awareness content
- Include hooks, captions, CTAs, and hashtags for each post
- Include a visual/image generation prompt for each post
- Specify best time to post for each piece
- Themes should progress through the funnel: awareness → consideration → conversion → retention

Respond with structured data.`;

  const calendarResult = await runAgent({
    userId,
    campaignId,
    agentType: "creative",
    prompt: calendarPrompt,
    schema: ContentCalendarSchema,
    system:
      "You are an expert content strategist who creates engaging, platform-optimized social media content calendars. You understand Instagram, TikTok, Facebook, LinkedIn, Twitter/X, and email marketing. Always respond with valid structured data.",
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
  const assetsPrompt = `You are a creative director. Generate additional marketing assets for this campaign.

CAMPAIGN DETAILS:
- Name: ${campaign.name}
- Goal: ${campaign.goal}
- Core Message: ${coreMessage || "Not specified"}
- CTA Strategy: ${ctaStrategy || "Not specified"}
- Target Audience: ${campaign.targetAudience || "Not specified"}
- Platforms: ${campaign.platforms || "Instagram, Facebook, TikTok"}

Generate:
1. 3 ad copy variations (different angles/approaches)
2. 3 email subject lines + body copy for a welcome sequence
3. 3 WhatsApp message templates for follow-ups
4. 5 image generation prompts for hero visuals
5. A carousel post outline (5 slides)
6. 3 CTA variations for different funnel stages

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
