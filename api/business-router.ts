import { z } from "zod";
import { generateObject } from "ai";
import { TRPCError } from "@trpc/server";
import { createRouter, authedQuery, aiActionQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { businesses, users } from "@db/schema";
import { eq, and, sql } from "drizzle-orm";
import { defaultModel } from "./lib/agents/openai";
import { storeUploadedAsset } from "./lib/creative/storage";

type OperationName =
  | "business.list"
  | "business.create"
  | "business.update"
  | "business.delete"
  | "business.uploadAsset"
  | "business.completeProfileWithAi";

type CreateBusinessResult =
  | { success: false; code: "DUPLICATE"; existingId: number; message: string }
  | { success: true; id: number };

const SENSITIVE_INPUT_KEYS = new Set([
  "base64",
  "password",
  "token",
  "secret",
  "apiKey",
  "accessToken",
  "refreshToken",
  "authorization",
  "credentials",
  "privateKey",
]);

function getSafeInputKeys(input: unknown): string[] {
  if (!input || typeof input !== "object") return [];
  return Object.keys(input).filter((key) => !SENSITIVE_INPUT_KEYS.has(key));
}

function hasLogo(input: unknown): boolean {
  if (!input || typeof input !== "object") return false;
  const record = input as Record<string, unknown>;
  if (typeof record.logo === "string" && record.logo.length > 0) {
    return true;
  }
  if (
    record.assetType === "logo" &&
    typeof record.base64 === "string" &&
    record.base64.length > 0
  ) {
    return true;
  }
  return false;
}

function extractDbError(err: unknown) {
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    return {
      message: typeof e.message === "string" ? e.message : String(err),
      code: e.code,
      sqlState: e.sqlState,
      sql: e.sql,
    };
  }
  return { message: String(err) };
}

function logOperation(ctx: { user?: { id?: number } }, name: OperationName, input: unknown) {
  console.log(
    JSON.stringify({
      userId: ctx.user?.id,
      operation: name,
      inputKeys: getSafeInputKeys(input),
      logoExists: hasLogo(input),
    })
  );
}

function logError(
  ctx: { user?: { id?: number } },
  name: OperationName,
  input: unknown,
  err: unknown
) {
  const dbError = extractDbError(err);
  console.error(
    JSON.stringify({
      userId: ctx.user?.id,
      operation: name,
      inputKeys: getSafeInputKeys(input),
      logoExists: hasLogo(input),
      errorMessage: dbError.message,
      errorCode: dbError.code,
      sqlState: dbError.sqlState,
      sql: dbError.sql,
      stack: err instanceof Error ? err.stack : undefined,
    })
  );
}

export const businessRouter = createRouter({
  list: authedQuery.query(async ({ ctx }) => {
    logOperation(ctx, "business.list", {});
    try {
      const db = getDb();
      const rows = await db
        .select()
        .from(businesses)
        .where(eq(businesses.userId, ctx.user.id))
        .orderBy(businesses.createdAt);
      return rows;
    } catch (err) {
      logError(ctx, "business.list", {}, err);
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Could not load businesses. Please try again.",
      });
    }
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
        logo: z.string().optional(),
        email: z.string().optional(),
        website: z.string().optional(),
        productOrService: z.string().optional(),
        targetCustomer: z.string().optional(),
        monthlyBudget: z.number().optional(),
        brandTone: z.string().optional(),
        brandColors: z.array(z.string()).optional(),
        visualStyle: z.string().optional(),
        brandVoiceNotes: z.string().optional(),
        avoidWords: z.string().optional(),
        mainGoal: z.string().optional(),
        socialLinks: z.any().optional(),
        whatsappNumber: z.string().optional(),
        preferredPlatforms: z.string().optional(),
        premiumContentPreferences: z.string().optional(),
        hasProductVideos: z.boolean().optional(),
        allowDuplicate: z.boolean().optional(),
      })
    )
    .mutation(async ({ ctx, input }): Promise<CreateBusinessResult> => {
      logOperation(ctx, "business.create", input);
      try {
        const db = getDb();
        const normalizedName = input.name.trim();

        const existing = await db
          .select({ id: businesses.id, name: businesses.name })
          .from(businesses)
          .where(
            and(
              eq(businesses.userId, ctx.user.id),
              sql`lower(${businesses.name}) = lower(${normalizedName})`
            )
          )
          .limit(1);

        if (existing.length > 0 && !input.allowDuplicate) {
          return {
            success: false,
            code: "DUPLICATE",
            existingId: existing[0]!.id,
            message:
              "A business with this name already exists. Do you want to edit the existing business instead?",
          };
        }

        const [biz] = await db.insert(businesses).values({
          userId: ctx.user.id,
          name: input.name,
          description: input.description,
          industry: input.industry,
          location: input.location,
          targetAudience: input.targetAudience,
          tone: input.tone ?? "professional",
          logo: input.logo,
          email: input.email,
          website: input.website,
          productOrService: input.productOrService,
          targetCustomer: input.targetCustomer,
          monthlyBudget: input.monthlyBudget,
          brandTone: input.brandTone,
          brandColors: input.brandColors,
          visualStyle: input.visualStyle,
          brandVoiceNotes: input.brandVoiceNotes,
          avoidWords: input.avoidWords,
          mainGoal: input.mainGoal,
          socialLinks: input.socialLinks,
          whatsappNumber: input.whatsappNumber,
          preferredPlatforms: input.preferredPlatforms,
          premiumContentPreferences: input.premiumContentPreferences,
          hasProductVideos: input.hasProductVideos,
          onboardingComplete: true,
        });

        await db
          .update(users)
          .set({ onboardingComplete: true })
          .where(eq(users.id, ctx.user.id));

        return { id: Number(biz.insertId), success: true };
      } catch (err) {
        logError(ctx, "business.create", input, err);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message:
            "Could not save business profile. Please check the required fields and try again.",
        });
      }
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
        logo: z.string().optional(),
        email: z.string().optional(),
        website: z.string().optional(),
        productOrService: z.string().optional(),
        targetCustomer: z.string().optional(),
        monthlyBudget: z.number().optional(),
        brandTone: z.string().optional(),
        brandColors: z.array(z.string()).optional(),
        visualStyle: z.string().optional(),
        brandVoiceNotes: z.string().optional(),
        avoidWords: z.string().optional(),
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
      logOperation(ctx, "business.update", input);
      try {
        const db = getDb();
        const { id, ...data } = input;
        await db
          .update(businesses)
          .set(data)
          .where(
            and(eq(businesses.id, id), eq(businesses.userId, ctx.user.id))
          );

        if (data.onboardingComplete === true) {
          await db
            .update(users)
            .set({ onboardingComplete: true })
            .where(eq(users.id, ctx.user.id));
        }

        return { success: true };
      } catch (err) {
        logError(ctx, "business.update", input, err);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message:
            "Could not save business profile. Please check the required fields and try again.",
        });
      }
    }),

  uploadAsset: authedQuery
    .input(
      z.object({
        base64: z.string().min(1),
        fileName: z.string().min(1),
        assetType: z.enum(["logo", "reference_image", "product_photo"]),
      })
    )
    .mutation(async ({ ctx, input }) => {
      logOperation(ctx, "business.uploadAsset", input);
      try {
        const stored = await storeUploadedAsset(input.base64, {
          userId: ctx.user.id,
          assetType: input.assetType,
          fileName: input.fileName,
        });
        return { url: stored.publicUrl, path: stored.localPath };
      } catch (err) {
        logError(ctx, "business.uploadAsset", input, err);
        const isLogo = input.assetType === "logo";
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: isLogo
            ? "Could not upload logo. Please try a PNG/JPG file."
            : "Could not upload asset. Please try again.",
        });
      }
    }),

  delete: authedQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      logOperation(ctx, "business.delete", input);
      try {
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
      } catch (err) {
        logError(ctx, "business.delete", input, err);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Could not delete business profile. Please try again.",
        });
      }
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

  completeProfileWithAi: aiActionQuery
    .input(
      z.object({
        id: z.number().optional(),
        name: z.string().optional(),
        website: z.string().optional(),
        location: z.string().optional(),
        description: z.string().optional(),
        logo: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      logOperation(ctx, "business.completeProfileWithAi", input);
      try {
        const db = getDb();
        let existing: typeof businesses.$inferSelect | undefined;

        if (input.id) {
          const [biz] = await db
            .select()
            .from(businesses)
            .where(
              and(
                eq(businesses.id, input.id),
                eq(businesses.userId, ctx.user.id)
              )
            );
          existing = biz;
        }

        const essentials = {
          name: input.name ?? existing?.name,
          website: input.website ?? existing?.website,
          email: existing?.email,
          whatsappNumber: existing?.whatsappNumber,
          location: input.location ?? existing?.location,
        };

        const contextParts = [
          essentials.name ? `Business name: ${essentials.name}` : "",
          essentials.website ? `Website: ${essentials.website}` : "",
          essentials.email ? `Email: ${essentials.email}` : "",
          essentials.whatsappNumber ? `WhatsApp number: ${essentials.whatsappNumber}` : "",
          essentials.location ? `Location: ${essentials.location}` : "",
          input.description ? `Provided description: ${input.description}` : "",
          existing?.description ? `Existing description: ${existing.description}` : "",
          existing?.industry ? `Existing industry: ${existing.industry}` : "",
          existing?.productOrService ? `Products/services: ${existing.productOrService}` : "",
          input.logo ? "A logo has been provided." : "",
        ].filter(Boolean);

        const prompt = `You are helping complete a business profile for a marketing platform.

Use only the information below. Do not invent website URLs, email addresses, phone numbers, physical addresses, or any other contact details that are not already provided. Do not overwrite fields the user has already supplied.

${contextParts.join("\n")}

Suggest values for the remaining profile fields. Be concise and realistic. If something is unknown, make a reasonable, clearly-marked assumption or leave it generic.`;

        const completionSchema = z.object({
          description: z.string().describe("A clear business description"),
          industry: z.string().describe("The industry this business operates in"),
          targetAudience: z.string().describe("The ideal target audience"),
          brandTone: z.string().describe("Suggested brand tone, e.g. professional, friendly, premium, bold"),
          productOrService: z.string().describe("What the business sells or offers"),
          brandColors: z.array(z.string()).describe("Suggested brand colours as hex codes"),
          visualStyle: z.string().describe("Suggested visual style, e.g. modern, minimal, bold, luxury"),
          brandVoiceNotes: z.string().describe("Notes on how the brand should sound"),
          avoidWords: z.string().describe("Words or phrases the brand should avoid"),
          mainGoal: z.string().describe("The primary marketing goal"),
          premiumContentPreferences: z.string().describe("Preferences for premium content types or formats"),
        });

        const result = await generateObject({
          model: defaultModel,
          system:
            "You are an expert marketing strategist. Complete business profiles with structured, actionable suggestions. Never invent contact details or URLs.",
          prompt,
          schema: completionSchema,
        });

        return {
          success: true,
          suggestions: result.object,
        };
      } catch (err) {
        logError(ctx, "business.completeProfileWithAi", input, err);
        return {
          success: false,
          error: "AI_COMPLETE_FAILED",
          message: "We could not complete your profile with AI. Please continue manually.",
        };
      }
    }),
});
