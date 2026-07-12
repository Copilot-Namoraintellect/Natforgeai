import { z } from "zod";
import { generateObject } from "ai";
import { TRPCError } from "@trpc/server";
import { createRouter, authedQuery, aiActionQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { businesses, users } from "@db/schema";
import { eq, and, sql } from "drizzle-orm";
import { defaultModel } from "./lib/agents/openai";
import { storeUploadedAsset } from "./lib/creative/storage";
import { createAlert } from "./lib/alerts";
import { logInfo, logWarn } from "./lib/logger";
import {
  crawlWebsitePages,
  buildWebsiteAnalysisPrompt,
  getEvidenceText,
  type BusinessEvidence,
} from "./lib/website-analyser";
import { guardProfileSuggestions } from "./lib/business-profile-guard";
import { buildBusinessDescriptionsFromEvidence } from "./lib/business-description";

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

function mapAnalysisErrorToUserMessage(code: string, reason: string): string {
  switch (code) {
    case "INVALID_URL":
      return "That doesn't look like a valid website URL. Please check it and try again, or continue manually.";
    case "UNREACHABLE":
      return "We could not reach this website. It may be offline or the domain may not exist. You can continue manually.";
    case "TIMEOUT":
      return "The website took too long to respond. You can continue manually.";
    case "BLOCKED":
      return "This website blocked our analysis request. You can continue manually.";
    case "SERVER_ERROR":
      return "This website returned a server error. You can continue manually.";
    case "NO_CONTENT":
      return "We could not find enough useful content on this website. You can continue manually.";
    case "INSUFFICIENT_QUOTA":
      return "AI analysis is temporarily unavailable due to provider quota/billing. You can continue manually.";
    default:
      return `${reason}. You can complete your profile manually.`;
  }
}

function isInsufficientQuotaError(err: any): boolean {
  if (!err) return false;
  const statusCode = err.statusCode ?? err.status ?? err.response?.status;
  const code = err.code ?? err.error?.code ?? err.response?.data?.error?.code;
  const message = err.message || err.error?.message || "";
  return (
    statusCode === 429 ||
    code === "insufficient_quota" ||
    message.toLowerCase().includes("insufficient_quota") ||
    message.toLowerCase().includes("exceeded your current quota") ||
    message.toLowerCase().includes("billing")
  );
}

function buildDeterministicProfileSuggestions(
  evidence: BusinessEvidence,
  input: { businessName?: string; industry?: string; location?: string }
) {
  const category = evidence.businessCategory || input.industry || "Business";
  const products = evidence.productsServices.length
    ? evidence.productsServices
    : ["Products/services not listed on website"];
  const customers = evidence.targetCustomers.length
    ? evidence.targetCustomers
    : ["Customers not explicitly stated"];

  const firstProduct = products[0] || "";
  const productDescription = evidence.evidenceSnippets.slice(0, 3).join(" ").trim() || firstProduct;

  const platformMap: Record<string, string[]> = {
    "Food & Beverage / Restaurant": ["instagram", "facebook", "tiktok"],
    "Beauty & Personal Care": ["instagram", "facebook", "tiktok"],
    "Art & Décor / Canvas & Framed Prints": ["instagram", "facebook", "pinterest"],
    "Print, Copy & Courier Services": ["facebook", "linkedin", "whatsapp"],
    "Financial Services / Fintech": ["linkedin", "facebook", "whatsapp"],
    "Professional Services / Consulting": ["linkedin", "facebook"],
    "Marketing / Digital Agency": ["linkedin", "instagram", "facebook"],
    "Real Estate": ["facebook", "instagram", "linkedin"],
  };

  const preferredPlatforms = platformMap[category] || ["facebook", "instagram", "linkedin"];
  const descriptions = buildBusinessDescriptionsFromEvidence(evidence, {
    businessName: input.businessName,
    businessCategory: category,
    location: input.location || evidence.location,
    tone: "professional",
  });

  return {
    businessCategory: category,
    shortDescription: descriptions.shortDescription,
    businessDescription: descriptions.businessDescription,
    productOrService: firstProduct,
    targetCustomer: customers.join(", "),
    productDescription,
    uniqueSellingPoint: evidence.evidenceSnippets[0] || firstProduct,
    pricePointOffer: null,
    primaryGoal: "Build brand awareness",
    secondaryGoal: "Generate more leads",
    successMetric: "Engagement rate",
    targetRevenue: null,
    brandTone: "professional",
    visualStyle: "modern",
    colorPalette: "neutral",
    brandVoiceNotes: `Clear, trustworthy ${category.toLowerCase()} voice.`,
    wordsToAvoid: "",
    preferredPlatforms,
    recommendedAssetTypes: ["logo", "product_images"],
    confidence: evidence.confidence,
    assumptions: evidence.assumptions,
  };
}

async function maybeCreateQuotaAlert(err: any) {
  if (!isInsufficientQuotaError(err)) return;
  try {
    await createAlert({
      severity: "critical",
      category: "openai",
      message: "OpenAI quota exhausted or billing issue. AI features including website analysis may fail.",
      details: {
        errorCode: err.code,
        statusCode: err.statusCode ?? err.status,
        message: err.message,
      },
    });
  } catch (alertErr: any) {
    console.error("[businessRouter] Failed to create quota alert:", alertErr.message);
  }
}

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

        // Auto-analyse website to build structured evidence for downstream gates.
        let websiteEvidence: unknown = null;
        if (input.website) {
          try {
            const analysis = await crawlWebsitePages(input.website, { maxPages: 8, timeoutMs: 5000 });
            if (analysis.log.normalizedUrl) {
              console.log(`[businessRouter.create] Website analysis | userId=${ctx.user.id} | rawInput="${analysis.log.rawWebsiteInput}" | normalizedUrl=${analysis.log.normalizedUrl} | fetched=${analysis.log.pagesFetched}/${analysis.log.pagesCrawled} | confidence=${analysis.log.confidence} | failureReason=${analysis.log.failureReason || "none"}`);
            }
            if (analysis.pages[0]?.fetched) {
              websiteEvidence = analysis.evidence;
            }
          } catch (analyseErr: any) {
            console.warn(`[businessRouter.create] Website analysis failed: ${analyseErr.message}`);
          }
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
          websiteEvidence,
          onboardingComplete: true,
        } as any);

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

        // Re-analyse website if the URL changed.
        if (data.website) {
          try {
            const [current] = await db
              .select({ website: businesses.website })
              .from(businesses)
              .where(and(eq(businesses.id, id), eq(businesses.userId, ctx.user.id)))
              .limit(1);
            if (current?.website !== data.website) {
              const analysis = await crawlWebsitePages(data.website, { maxPages: 8, timeoutMs: 5000 });
              if (analysis.log.normalizedUrl) {
                console.log(`[businessRouter.update] Website re-analysis | userId=${ctx.user.id} | rawInput="${analysis.log.rawWebsiteInput}" | normalizedUrl=${analysis.log.normalizedUrl} | fetched=${analysis.log.pagesFetched}/${analysis.log.pagesCrawled} | confidence=${analysis.log.confidence} | failureReason=${analysis.log.failureReason || "none"}`);
              }
              if (analysis.pages[0]?.fetched) {
                (data as any).websiteEvidence = analysis.evidence;
              }
            }
          } catch (analyseErr: any) {
            console.warn(`[businessRouter.update] Website re-analysis failed: ${analyseErr.message}`);
          }
        }

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
        websiteUrl: z.string(),
        businessName: z.string().optional(),
        industry: z.string().optional(),
        location: z.string().optional(),
        businessId: z.number().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const logPrefix = `[businessRouter.analyseWebsite] userId=${ctx.user.id}`;
      try {
        const analysis = await crawlWebsitePages(input.websiteUrl, { maxPages: 10, timeoutMs: 6000 });
        const { pages, evidence, log } = analysis;
        const homepage = pages[0];

        console.log(`${logPrefix} | rawInput="${log.rawWebsiteInput}" | normalizedUrl=${log.normalizedUrl} | attemptedUrls=[${log.fetchAttemptedUrls.join(", ")}] | statusCode=${log.statusCode || "n/a"} | redirectUrl=${log.redirectUrl || "n/a"} | contentLength=${log.contentLength || "n/a"} | fetched=${log.pagesFetched}/${log.pagesCrawled} | confidence=${log.confidence} | failureReason=${log.failureReason || "none"}`);

        if (!homepage || !homepage.fetched) {
          const reason = log.failureReason || "Could not fetch website";
          const userMessage = mapAnalysisErrorToUserMessage(log.errorCode || "UNKNOWN", reason);
          return {
            success: false,
            error: log.errorCode || "FETCH_FAILED",
            message: userMessage,
            log,
          };
        }

        // Low-confidence evidence is no longer rejected outright; the grounding
        // guard below blanks unsupported/generated fields and returns warnings.

        const prompt = buildWebsiteAnalysisPrompt(evidence);

        const evidenceCharCount = getEvidenceText(evidence).length;
        const selectedSnippets = evidence.evidenceSnippets.slice(0, 10);

        const analysisSchema = z.object({
          businessCategory: z.string().describe("Confirmed business category"),
          shortDescription: z.string().describe("A compact one-line summary for UI cards"),
          businessDescription: z.string().describe("A rich 80-150 word business profile grounded in website evidence that includes what the business does, target customers, key products/services, value proposition, location/service area if available, and tone"),
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

        let suggestions;
        try {
          const result = await generateObject({
            model: defaultModel,
            system:
              "You are an expert marketing analyst. Analyse the structured website evidence and return actionable marketing insights. " +
              "CRITICAL: Return only facts supported by the supplied website evidence. If unsupported, return null/empty and include a warning. " +
              "Generate a shortDescription for compact UI and a separate businessDescription between 80 and 150 words for campaign grounding. " +
              "The businessDescription must explicitly cover what the business does, target customers, key products/services, value proposition, service area/location when available, and brand tone. " +
              "Do not infer unrelated SaaS/marketing-platform details. " +
              "Do not classify the business as SEO, digital marketing, social media management, data analytics, restaurant, salon, or consulting " +
              "unless the evidence explicitly and repeatedly supports that classification. Only list products/services actually mentioned in the evidence. " +
              "Always use USD for prices. Be concise.",
            prompt,
            schema: analysisSchema,
          });
          suggestions = result.object;
        } catch (openAiErr: any) {
          await maybeCreateQuotaAlert(openAiErr);

          if (isInsufficientQuotaError(openAiErr)) {
            console.warn(`${logPrefix} OpenAI quota exceeded; using deterministic fallback`);
            suggestions = buildDeterministicProfileSuggestions(evidence, {
              businessName: input.businessName,
              industry: input.industry,
              location: input.location,
            });
          } else {
            throw openAiErr;
          }
        }

        // Grounding guard: clear unsupported generic/NatForgeAI copy and low-confidence fields.
        const {
          suggestions: guardedSuggestions,
          warnings,
          genericGuardTriggered,
        } = guardProfileSuggestions(suggestions, evidence);

        const descriptions = buildBusinessDescriptionsFromEvidence(evidence, {
          businessName: input.businessName,
          businessCategory: (guardedSuggestions as any).businessCategory,
          valueProposition: (guardedSuggestions as any).uniqueSellingPoint,
          location: input.location || evidence.location,
          tone: (guardedSuggestions as any).brandTone,
        });

        if (!(guardedSuggestions as any).shortDescription) {
          (guardedSuggestions as any).shortDescription = descriptions.shortDescription;
        }
        (guardedSuggestions as any).businessDescription = descriptions.businessDescription;

        logInfo("[businessRouter.analyseWebsite] suggestions guarded", {
          userId: ctx.user.id,
          businessId: input.businessId ?? null,
          rawWebsiteInput: log.rawWebsiteInput,
          normalizedUrl: log.normalizedUrl,
          redirectUrl: log.redirectUrl || null,
          pagesCrawled: log.pagesCrawled,
          pagesFetched: log.pagesFetched,
          confidence: log.confidence,
          failureReason: log.failureReason || null,
          evidenceCharCount,
          selectedEvidenceSnippets: selectedSnippets,
          generatedProfileFields: Object.keys(guardedSuggestions),
          genericGuardTriggered,
          warningCount: warnings.length,
        });

        // Persist structured evidence on the business row for downstream gates.
        const db = getDb();
        if (input.businessId) {
          await db
            .update(businesses)
            .set({
              websiteEvidence: evidence as any,
              updatedAt: new Date(),
            } as any)
            .where(and(eq(businesses.id, input.businessId), eq(businesses.userId, ctx.user.id)));
        }

        return {
          success: true,
          suggestions: guardedSuggestions,
          evidence,
          log,
          warnings,
        };
      } catch (err: any) {
        console.error(`${logPrefix} error`, err);
        return {
          success: false,
          error: "ANALYSIS_FAILED",
          message: "We could not analyse this website automatically. You can complete your profile manually.",
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

        const websiteUrl = input.website ?? existing?.website;
        let evidence: BusinessEvidence | undefined;
        let crawlLog: { normalizedUrl?: string; redirectUrl?: string; confidence?: number; failureReason?: string; pagesCrawled?: number } | undefined;

        if (websiteUrl) {
          try {
            const analysis = await crawlWebsitePages(websiteUrl, { maxPages: 8, timeoutMs: 5000 });
            if (analysis.pages[0]?.fetched) {
              evidence = analysis.evidence;
              crawlLog = analysis.log;
            }
          } catch (crawlErr: any) {
            logWarn("[businessRouter.completeProfileWithAi] website crawl failed", {
              userId: ctx.user.id,
              businessId: input.id ?? null,
              websiteUrl,
              error: crawlErr?.message || String(crawlErr),
            });
          }
        }

        const essentials = {
          name: input.name ?? existing?.name,
          website: websiteUrl,
          email: existing?.email,
          whatsappNumber: existing?.whatsappNumber,
          location: input.location ?? existing?.location,
          description: input.description,
        };

        const contextParts = [
          essentials.name ? `Business name: ${essentials.name}` : "",
          essentials.website ? `Website: ${essentials.website}` : "",
          essentials.email ? `Email: ${essentials.email}` : "",
          essentials.whatsappNumber ? `WhatsApp number: ${essentials.whatsappNumber}` : "",
          essentials.location ? `Location: ${essentials.location}` : "",
          essentials.description ? `Provided description: ${essentials.description}` : "",
          input.logo ? "A logo has been provided." : "",
        ].filter(Boolean);

        const evidenceSection = evidence
          ? `\nWEBSITE EVIDENCE (use this as the only source of truth for products/services/industry/audience):\n` +
            `- Business category: ${evidence.businessCategory}\n` +
            `- Products/Services mentioned: ${evidence.productsServices.join(", ")}\n` +
            `- Target customers mentioned: ${evidence.targetCustomers.join(", ")}\n` +
            `- Location: ${evidence.location || "Not detected"}\n` +
            `- Evidence snippets:\n${evidence.evidenceSnippets.map((s) => "  - " + s).join("\n")}\n` +
            `- Confidence: ${evidence.confidence}\n` +
            `CRITICAL: Only use facts from the WEBSITE EVIDENCE above. If a field is unsupported by the evidence, return it empty/null and explain in warnings. Do not use NatForgeAI product copy, generic SaaS marketing copy, placeholder text, or another business profile.`
          : "";

        const prompt = `You are helping complete a business profile for a marketing platform.

Use only the information below. Do not invent website URLs, email addresses, phone numbers, physical addresses, or any other contact details that are not already provided.

${contextParts.join("\n")}${evidenceSection}

Suggest values for the remaining profile fields. Be concise and realistic. If something is unknown, leave it empty and include a warning. Do not make assumptions or invent content.`;

        const completionSchema = z.object({
          description: z.string().nullable().describe("A clear business description, or null if unsupported"),
          industry: z.string().nullable().describe("The industry this business operates in, or null if unsupported"),
          targetAudience: z.string().nullable().describe("The ideal target audience, or null if unsupported"),
          brandTone: z.string().nullable().describe("Suggested brand tone, or null if unsupported"),
          productOrService: z.string().nullable().describe("What the business sells or offers, or null if unsupported"),
          brandColors: z.array(z.string()).nullable().describe("Suggested brand colours as hex codes, or null"),
          visualStyle: z.string().nullable().describe("Suggested visual style, or null if unsupported"),
          brandVoiceNotes: z.string().nullable().describe("Notes on how the brand should sound, or null"),
          avoidWords: z.string().nullable().describe("Words or phrases the brand should avoid, or null"),
          mainGoal: z.string().nullable().describe("The primary marketing goal, or null"),
          premiumContentPreferences: z.string().nullable().describe("Preferences for premium content types or formats, or null"),
          warnings: z.array(z.string()).describe("Any unsupported fields or assumptions"),
        });

        const result = await generateObject({
          model: defaultModel,
          system:
            "You are an expert marketing strategist. Complete business profiles with structured, actionable suggestions. " +
            "Return only facts supported by the supplied website evidence or explicit user input. " +
            "If unsupported, return null/empty and include a warning. Never invent contact details or URLs.",
          prompt,
          schema: completionSchema,
        });

        let suggestions = result.object;
        let warnings = suggestions.warnings ?? [];
        let genericGuardTriggered = false;

        if (evidence) {
          const guarded = guardProfileSuggestions(suggestions, evidence, {
            fieldsToCheck: ["description", "industry", "productOrService", "targetAudience", "brandVoiceNotes", "mainGoal"],
          });
          suggestions = guarded.suggestions;
          warnings = [...warnings, ...guarded.warnings];
          genericGuardTriggered = guarded.genericGuardTriggered;
        }

        logInfo("[businessRouter.completeProfileWithAi] profile completed", {
          userId: ctx.user.id,
          businessId: input.id ?? null,
          rawWebsiteInput: websiteUrl ?? null,
          normalizedUrl: crawlLog?.normalizedUrl ?? null,
          redirectUrl: crawlLog?.redirectUrl ?? null,
          pagesCrawled: crawlLog?.pagesCrawled ?? null,
          confidence: crawlLog?.confidence ?? null,
          failureReason: crawlLog?.failureReason ?? null,
          evidenceCharCount: evidence ? getEvidenceText(evidence).length : 0,
          selectedEvidenceSnippets: evidence ? evidence.evidenceSnippets.slice(0, 10) : [],
          generatedProfileFields: Object.keys(suggestions),
          genericGuardTriggered,
          warningCount: warnings.length,
        });

        return {
          success: true,
          suggestions,
          warnings,
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
