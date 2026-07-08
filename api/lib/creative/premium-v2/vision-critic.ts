/**
 * Premium Leaflet Hybrid Pipeline – Vision QA Critic.
 *
 * Sends the final rendered PNG to an OpenAI vision model and returns a
 * structured scorecard. Flags critical issues such as missing logo, generic
 * template look, clipped text/CTA, weak brand colours and dull copy.
 *
 * IMPORTANT: on OpenAI failure (quota, network, etc.) this module returns a
 * failed result, NOT a permissive pass. The orchestrator must treat a failed
 * critic as a reason to fall back and mark the output for review.
 */

import { generateObject } from "ai";
import { structuredModel } from "../../agents/openai";
import { env } from "../../env";
import { VisionCriticResultSchema, type VisionCriticResult } from "./pipeline-types";
import type { BrandAssetResolution } from "../brand-asset-resolver";
import { z } from "zod";

export const LogoCropCriticResultSchema = z
  .object({
    realLogoPresent: z.boolean().describe("Does the crop clearly show the real uploaded brand logo (not a fallback monogram badge)?"),
    logoMatchesExpected: z.boolean().describe("Does the logo in the crop match the expected logo image provided?"),
    fallbackBadgeUsed: z.boolean().describe("Is the crop showing a fallback initials/monogram badge instead of the real logo?"),
    logoDistortedOrCropped: z.boolean().describe("Is the logo distorted, partially cropped, or too small/blurry to read?"),
    explanation: z.string().describe("Brief explanation of what you see in the crop and expected-logo comparison"),
  })
  .strict();

export type LogoCropCriticResult = z.infer<typeof LogoCropCriticResultSchema>;

const MIN_SCORE = 70;

export async function critiqueRenderedLeaflet(
  imageBuffer: Buffer,
  businessName: string,
  brandAsset: BrandAssetResolution | undefined
): Promise<VisionCriticResult> {
  if (!env.openaiApiKey || !env.enableHybridLeafletPipeline) {
    return unavailableResult("OpenAI vision critic disabled; deterministic checks used.", false);
  }

  const dataUri = `data:image/png;base64,${imageBuffer.toString("base64")}`;

  const system = `You are a strict marketing-design QA critic. Inspect the attached 1080x1350 leaflet PNG. Score it on the 7 dimensions in the requested JSON schema. Be critical and realistic. A score below ${MIN_SCORE} on any dimension is a problem. genericTemplateRisk above 50 is a problem. Return strict JSON.`;

  const expectedLogo = !!brandAsset && brandAsset.realLogoExpected;
  const renderMode = brandAsset?.logoRenderMode ?? "fallback_badge";
  const prompt = `Business: ${businessName}. Expected logo present: ${expectedLogo}. Render mode: ${renderMode}. Brand source: ${brandAsset?.logoSourceType ?? "unknown"}.

Evaluate the 1080x1350 leaflet on the 7 score dimensions and also answer these five brand-fidelity questions explicitly in the JSON fields:
1. realLogoPresent: does the rendered leaflet show a real logo (not a fallback initials badge)?
2. logoMatchesBrand: does the logo appear to match the expected business/brand?
3. fallbackBadgeUsed: is a fallback/monogram badge used?
4. logoDistortedOrCropped: is the logo distorted, cropped, circle-cropped, masked, or too small to read (e.g. rendered height clearly below ~55px or width so compressed it is unreadable)?
5. brandFidelityPassed: should this pass brand fidelity overall?

Be critical. A real logo expected but missing or replaced by a fallback badge MUST fail brand fidelity. A distorted/cropped/masked/circle-cropped/unreadable logo MUST fail brand fidelity. A logo squeezed into a tiny square or circle when it is a wide horizontal mark MUST fail logoDistortedOrCropped. The real logo must be clearly visible and readable, not merely loaded. A brand name/logo mismatch MUST fail brand fidelity.

Guidance on distinguishing a real logo from a fallback badge: a fallback badge is typically a solid-colour circle or square containing one or two letters (initials/monogram). A real logo is the actual brand artwork, often a wide horizontal wordmark or icon, usually placed inside a light backing panel. If the leaflet shows the real brand artwork (even inside a panel) and not just initials, set realLogoPresent=true and fallbackBadgeUsed=false. If you are unsure because the logo is too small or blurry, set logoDistortedOrCropped=true.

List critical issues and 1-3 concrete improvement suggestions.`;

  try {
    const { object } = await generateObject({
      model: structuredModel,
      schema: VisionCriticResultSchema,
      system,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image", image: dataUri },
          ],
        },
      ],
      temperature: 0.2,
    });

    // Normalize pass/fail against thresholds.
    const scores = object.scores;
    const criticalIssues = object.criticalIssues.slice();
    if (scores.brandFidelity < MIN_SCORE) criticalIssues.push("Brand fidelity below threshold");
    if (scores.readability < MIN_SCORE) criticalIssues.push("Readability below threshold");
    if (scores.premiumFeel < MIN_SCORE) criticalIssues.push("Premium feel below threshold");
    if (scores.visualHierarchy < MIN_SCORE) criticalIssues.push("Visual hierarchy below threshold");
    if (expectedLogo && scores.logoUsage < MIN_SCORE) criticalIssues.push("Logo usage below threshold");
    if (expectedLogo && renderMode === "fallback_badge") criticalIssues.push("Rendered logo is a fallback badge instead of the real brand logo");
    if (expectedLogo && !object.realLogoPresent) criticalIssues.push("Real logo missing in rendered leaflet");
    if (object.fallbackBadgeUsed && expectedLogo) criticalIssues.push("Fallback badge used while a real logo exists");
    if (object.logoDistortedOrCropped) criticalIssues.push("Logo is distorted, cropped, or too small");
    if (!object.logoMatchesBrand && expectedLogo) criticalIssues.push("Logo does not appear to match the expected brand");
    if (!object.brandFidelityPassed && expectedLogo) criticalIssues.push("Brand fidelity check failed");
    if (scores.CTAVisibility < MIN_SCORE) criticalIssues.push("CTA visibility below threshold");
    if (scores.genericTemplateRisk > 50) criticalIssues.push("Generic template risk too high");

    return {
      ...object,
      unavailable: object.unavailable ?? false,
      quotaError: object.quotaError ?? false,
      criticalIssues: Array.from(new Set(criticalIssues)),
      passed: criticalIssues.length === 0,
    };
  } catch (err: any) {
    const message = err.message || String(err);
    const isQuota = /quota|rate|billing|insufficient|limit/i.test(message);
    console.warn(`[HybridCritic] Vision critique failed: ${message}. Marking critic as unavailable.`);
    return unavailableResult(message, isQuota);
  }
}

export async function critiqueLogoCrop(
  logoCropBuffer: Buffer,
  expectedLogoBuffer: Buffer,
  businessName: string
): Promise<LogoCropCriticResult> {
  if (!env.openaiApiKey || !env.enableHybridLeafletPipeline) {
    return {
      realLogoPresent: false,
      logoMatchesExpected: false,
      fallbackBadgeUsed: true,
      logoDistortedOrCropped: true,
      explanation: "OpenAI vision critic disabled; deterministic checks used.",
    };
  }

  const cropDataUri = `data:image/png;base64,${logoCropBuffer.toString("base64")}`;
  const expectedDataUri = `data:image/png;base64,${expectedLogoBuffer.toString("base64")}`;

  const system = `You are a precise logo-verification vision model. Compare the two attached images. Image 1 is a cropped region from a marketing leaflet header. Image 2 is the expected uploaded brand logo for ${businessName}. Answer the four JSON questions strictly. A fallback badge is a solid-colour circle or square containing one or two letters (initials/monogram). The real logo is the actual brand artwork, often a wide horizontal wordmark or icon.`;

  const prompt = `Business: ${businessName}.

Image 1 (left) shows a crop of the leaflet header/logo area.
Image 2 (right) shows the expected uploaded brand logo.

Determine:
1. Does Image 1 contain the real uploaded logo (not a fallback initials badge)?
2. Does the logo in Image 1 match Image 2 (same brand artwork)?
3. Is Image 1 showing a fallback initials/monogram badge instead of the real logo?
4. Is the logo in Image 1 distorted, partially cropped, or too small/blurry to read?

Be decisive. If Image 1 clearly shows the same artwork as Image 2, set realLogoPresent=true, logoMatchesExpected=true, fallbackBadgeUsed=false. If Image 1 shows only a monogram badge or the logo is unreadable, set fallbackBadgeUsed=true or logoDistortedOrCropped=true accordingly.`;

  try {
    const { object } = await generateObject({
      model: structuredModel,
      schema: LogoCropCriticResultSchema,
      system,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image", image: cropDataUri },
            { type: "image", image: expectedDataUri },
          ],
        },
      ],
      temperature: 0.1,
    });

    return {
      ...object,
      explanation: object.explanation || "No explanation provided.",
    };
  } catch (err: any) {
    const message = err.message || String(err);
    console.warn(`[HybridCritic] Logo crop critique failed: ${message}.`);
    return {
      realLogoPresent: false,
      logoMatchesExpected: false,
      fallbackBadgeUsed: true,
      logoDistortedOrCropped: true,
      explanation: `Logo crop critique failed: ${message}`,
    };
  }
}

function unavailableResult(reason: string, quotaError: boolean): VisionCriticResult {
  return {
    scores: {
      brandFidelity: 50,
      readability: 50,
      premiumFeel: 50,
      visualHierarchy: 50,
      logoUsage: 50,
      CTAVisibility: 50,
      genericTemplateRisk: 50,
    },
    passed: false,
    unavailable: true,
    quotaError,
    criticalIssues: [quotaError ? `OpenAI quota error: ${reason}` : `Vision critic unavailable: ${reason}`],
    improvementSuggestions: ["Re-render with deterministic fallback and queue for manual review."],
    realLogoPresent: false,
    logoMatchesBrand: false,
    fallbackBadgeUsed: true,
    logoDistortedOrCropped: true,
    brandFidelityPassed: false,
  };
}
