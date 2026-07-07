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

const MIN_SCORE = 70;

export async function critiqueRenderedLeaflet(
  imageBuffer: Buffer,
  businessName: string,
  expectedLogo: boolean
): Promise<VisionCriticResult> {
  if (!env.openaiApiKey || !env.enableHybridLeafletPipeline) {
    return unavailableResult("OpenAI vision critic disabled; deterministic checks used.", false);
  }

  const dataUri = `data:image/png;base64,${imageBuffer.toString("base64")}`;

  const system = `You are a strict marketing-design QA critic. Inspect the attached 1080x1350 leaflet PNG. Score it on the 7 dimensions in the requested JSON schema. Be critical and realistic. A score below ${MIN_SCORE} on any dimension is a problem. genericTemplateRisk above 50 is a problem. Return strict JSON.`;

  const prompt = `Business: ${businessName}. Expected logo present: ${expectedLogo}. Evaluate brand fidelity (colours + logo match), readability, premium feel, visual hierarchy, logo usage, CTA visibility and generic-template risk. List critical issues and 1-3 concrete improvement suggestions.`;

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
  };
}
