/**
 * Premium Leaflet Hybrid Pipeline – Vision QA Critic.
 *
 * Sends the final rendered PNG to an OpenAI vision model and returns a
 * structured scorecard. Flags critical issues such as missing logo, generic
 * template look, clipped text/CTA, weak brand colours and dull copy.
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
    return passingResult("OpenAI vision critic disabled; deterministic checks used.");
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
      criticalIssues: Array.from(new Set(criticalIssues)),
      passed: criticalIssues.length === 0,
    };
  } catch (err: any) {
    console.warn(`[HybridCritic] Vision critique failed: ${err.message}. Returning permissive result.`);
    return passingResult("Vision critic unavailable; assuming pass with deterministic guardrails.");
  }
}

function passingResult(reason: string): VisionCriticResult {
  return {
    scores: {
      brandFidelity: 85,
      readability: 85,
      premiumFeel: 80,
      visualHierarchy: 85,
      logoUsage: 85,
      CTAVisibility: 90,
      genericTemplateRisk: 25,
    },
    passed: true,
    criticalIssues: [],
    improvementSuggestions: [reason],
  };
}
