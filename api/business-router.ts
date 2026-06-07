import { z } from "zod";
import { generateObject } from "ai";
import { createRouter, authedQuery, aiActionQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { businesses } from "@db/schema";
import { eq, and } from "drizzle-orm";
import { defaultModel } from "./lib/agents/openai";

export const businessRouter = createRouter({
  list: authedQuery.query(async ({ ctx }) => {
    const db = getDb();
    return db
      .select()
      .from(businesses)
      .where(eq(businesses.userId, ctx.user.id))
      .orderBy(businesses.createdAt);
  }),

  get: authedQuery
    .input(z.object({ id: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = getDb();
      const [biz] = await db
        .select()
        .from(businesses)
        .where(
          and(
            eq(businesses.id, input.id),
            eq(businesses.userId, ctx.user.id)
          )
        );
      return biz ?? null;
    }),

  create: authedQuery
    .input(
      z.object({
        name: z.string().min(1),
        description: z.string().optional(),
        industry: z.string().optional(),
        location: z.string().optional(),
        targetAudience: z.string().optional(),
        tone: z.string().optional(),
        website: z.string().optional(),
        productOrService: z.string().optional(),
        targetCustomer: z.string().optional(),
        monthlyBudget: z.number().optional(),
        brandTone: z.string().optional(),
        mainGoal: z.string().optional(),
        socialLinks: z.any().optional(),
        whatsappNumber: z.string().optional(),
        preferredPlatforms: z.string().optional(),
        premiumContentPreferences: z.string().optional(),
        hasProductVideos: z.boolean().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const [biz] = await db.insert(businesses).values({
        userId: ctx.user.id,
        name: input.name,
        description: input.description,
        industry: input.industry,
        location: input.location,
        targetAudience: input.targetAudience,
        tone: input.tone ?? "professional",
        website: input.website,
        productOrService: input.productOrService,
        targetCustomer: input.targetCustomer,
        monthlyBudget: input.monthlyBudget,
        brandTone: input.brandTone,
        mainGoal: input.mainGoal,
        socialLinks: input.socialLinks,
        whatsappNumber: input.whatsappNumber,
        preferredPlatforms: input.preferredPlatforms,
        premiumContentPreferences: input.premiumContentPreferences,
        hasProductVideos: input.hasProductVideos,
        onboardingComplete: true,
      });
      return { id: Number(biz.insertId), success: true };
    }),

  update: authedQuery
    .input(
      z.object({
        id: z.number(),
        name: z.string().min(1).optional(),
        description: z.string().optional(),
        industry: z.string().optional(),
        location: z.string().optional(),
        targetAudience: z.string().optional(),
        tone: z.string().optional(),
        website: z.string().optional(),
        productOrService: z.string().optional(),
        targetCustomer: z.string().optional(),
        monthlyBudget: z.number().optional(),
        brandTone: z.string().optional(),
        mainGoal: z.string().optional(),
        socialLinks: z.any().optional(),
        whatsappNumber: z.string().optional(),
        preferredPlatforms: z.string().optional(),
        premiumContentPreferences: z.string().optional(),
        hasProductVideos: z.boolean().optional(),
        onboardingComplete: z.boolean().optional(),
        isActive: z.boolean().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const { id, ...data } = input;
      await db
        .update(businesses)
        .set(data)
        .where(
          and(eq(businesses.id, id), eq(businesses.userId, ctx.user.id))
        );
      return { success: true };
    }),

  delete: authedQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      await db
        .delete(businesses)
        .where(
          and(
            eq(businesses.id, input.id),
            eq(businesses.userId, ctx.user.id)
          )
        );
      return { success: true };
    }),

  analyseWebsite: aiActionQuery
    .input(
      z.object({
        websiteUrl: z.string().url(),
        businessName: z.string().optional(),
        industry: z.string().optional(),
        location: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      try {
        let url = input.websiteUrl.trim();
        if (!/^https?:\/\//i.test(url)) {
          url = "https://" + url;
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);

        let html: string;
        try {
          const res = await fetch(url, {
            headers: {
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
              Accept: "text/html",
            },
            signal: controller.signal,
          });
          clearTimeout(timeout);
          if (!res.ok) {
            return {
              success: false,
              error: "FETCH_FAILED",
              message: `We could not reach this website (status ${res.status}). You can continue manually.`,
            };
          }
          html = await res.text();
        } catch (fetchErr: any) {
          clearTimeout(timeout);
          return {
            success: false,
            error: "FETCH_FAILED",
            message: "We could not analyse this website. You can continue manually.",
          };
        }

        // Extract meta and text content
        const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
        const title = titleMatch ? titleMatch[1].trim() : "";

        const metaDescMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)
          || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i);
        const metaDesc = metaDescMatch ? metaDescMatch[1].trim() : "";

        const ogTitleMatch = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
          || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
        const ogTitle = ogTitleMatch ? ogTitleMatch[1].trim() : "";

        const ogDescMatch = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i)
          || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i);
        const ogDesc = ogDescMatch ? ogDescMatch[1].trim() : "";

        const h1Matches = [...html.matchAll(/<h1[^>]*>([^<]*)<\/h1>/gi)].map(m => m[1].trim()).filter(Boolean);
        const h2Matches = [...html.matchAll(/<h2[^>]*>([^<]*)<\/h2>/gi)].map(m => m[1].trim()).filter(Boolean);

        // Strip tags for visible text
        let text = html
          .replace(/<script[\s\S]*?<\/script>/gi, " ")
          .replace(/<style[\s\S]*?<\/style>/gi, " ")
          .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
          .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
          .replace(/<header[\s\S]*?<\/header>/gi, " ")
          .replace(/<aside[\s\S]*?<\/aside>/gi, " ")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim();

        // Truncate to ~4,000 chars
        if (text.length > 4000) {
          text = text.slice(0, 4000) + "...";
        }

        const contextParts = [
          input.businessName ? `Business Name: ${input.businessName}` : "",
          input.industry ? `Industry: ${input.industry}` : "",
          input.location ? `Location: ${input.location}` : "",
          title ? `Page Title: ${title}` : "",
          metaDesc ? `Meta Description: ${metaDesc}` : "",
          ogTitle ? `OG Title: ${ogTitle}` : "",
          ogDesc ? `OG Description: ${ogDesc}` : "",
          h1Matches.length ? `Headings H1: ${h1Matches.join(" | ")}` : "",
          h2Matches.length ? `Headings H2: ${h2Matches.slice(0, 6).join(" | ")}` : "",
          `Visible Text: ${text}`,
        ].filter(Boolean);

        const prompt = `Analyse the following website content and return structured marketing insights for a business onboarding wizard. Be concise but specific. If information is not clearly available, make reasonable assumptions based on the industry and context, and list those assumptions.

${contextParts.join("\n")}

Return your analysis in the exact structured format requested.`;

        const analysisSchema = z.object({
          productOrService: z.string().describe("What the business sells or offers"),
          targetCustomer: z.string().describe("The ideal customer profile"),
          productDescription: z.string().describe("A rich description of the main product or service"),
          uniqueSellingPoint: z.string().describe("What makes this business different from competitors"),
          pricePointOffer: z.string().nullable().describe("Detected price or offer, or null if not found. Use USD."),
          primaryGoal: z.string().describe("The most logical primary marketing goal"),
          secondaryGoal: z.string().nullable().describe("A sensible secondary goal, or null"),
          successMetric: z.string().describe("The best success metric to track"),
          targetRevenue: z.string().nullable().describe("Suggested target revenue or business outcome, or null"),
          brandTone: z.string().describe("Suggested brand tone, e.g. professional, friendly, premium, bold, playful, educational"),
          visualStyle: z.string().describe("Suggested visual style, e.g. modern, classic, minimal, bold, luxury, playful"),
          colorPalette: z.string().describe("Suggested colour palette based on website vibes, or generic if unknown"),
          brandVoiceNotes: z.string().describe("Notes on how the brand should sound"),
          wordsToAvoid: z.string().describe("Words or phrases that might not fit the brand"),
          preferredPlatforms: z.array(z.string()).describe("Recommended marketing platforms"),
          recommendedAssetTypes: z.array(z.string()).describe("Recommended asset types from: logo, product_images, testimonials, past_ads, brand_guide"),
          confidence: z.number().min(0).max(1).describe("Confidence score 0-1"),
          assumptions: z.array(z.string()).describe("List any assumptions made"),
        });

        const result = await generateObject({
          model: defaultModel,
          system: "You are an expert marketing analyst. Analyse websites and return structured, actionable marketing insights. Always use USD for prices. Be concise.",
          prompt,
          schema: analysisSchema,
        });

        return {
          success: true,
          suggestions: result.object,
        };
      } catch (err: any) {
        return {
          success: false,
          error: "ANALYSIS_FAILED",
          message: "We could not analyse this website. You can continue manually.",
        };
      }
    }),
});
