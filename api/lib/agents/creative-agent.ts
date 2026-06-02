import { z } from "zod";
import { runAgent } from "./runner";
import { getDb } from "../../queries/connection";
import { campaigns, contentPosts, campaignAssets } from "@db/schema";
import { eq } from "drizzle-orm";

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
      prompt: z.string().optional(),
      platform: z.string().optional(),
      variations: z.array(z.string()).optional(),
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

  // Step 2: Generate additional creative assets
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

Respond with structured data.`;

  const assetsResult = await runAgent({
    userId,
    campaignId,
    agentType: "creative",
    prompt: assetsPrompt,
    schema: CreativeAssetsSchema,
    system:
      "You are an expert copywriter and creative director. You create high-converting marketing assets across all channels. Always respond with valid structured data.",
  });

  // Save content calendar to campaign
  await db
    .update(campaigns)
    .set({
      contentCalendar: calendarResult.output.days as any,
      workflowState: "creatives_ready",
      workflowContext: {
        ...(strategyContext || {}),
        creativeGeneratedAt: new Date().toISOString(),
        creativeRunId: calendarResult.runId,
        assetsRunId: assetsResult.runId,
      } as any,
    })
    .where(eq(campaigns.id, campaignId));

  // Create content_posts records from calendar
  for (const day of calendarResult.output.days) {
    for (const post of day.posts) {
      await db.insert(contentPosts).values({
        userId,
        campaignId,
        title: post.title,
        type: post.type,
        platform: post.platform,
        hook: post.hook,
        caption: post.caption,
        cta: post.cta,
        hashtags: post.hashtags.join(" "),
        visualPrompt: post.visualPrompt,
        status: "draft",
        aiGenerated: true,
        scheduledFor: new Date(day.date),
      });
    }
  }

  // Create campaign_assets records
  for (const asset of assetsResult.output.assets) {
    await db.insert(campaignAssets).values({
      userId,
      campaignId,
      assetType: asset.assetType,
      title: asset.title,
      prompt: asset.prompt || null,
      status: "ready",
      metadata: {
        content: asset.content,
        platform: asset.platform,
        variations: asset.variations,
      } as any,
    });
  }

  return {
    calendarRunId: calendarResult.runId,
    assetsRunId: assetsResult.runId,
    calendar: calendarResult.output,
    assets: assetsResult.output,
  };
}
