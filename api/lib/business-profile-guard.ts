import type { BusinessEvidence } from "./website-analyser";
import {
  containsGenericFallbackPhrases,
  getEvidenceText,
} from "./website-analyser";

/**
 * Post-process AI-generated profile suggestions to make sure they are strictly
 * grounded in the supplied website evidence. Generic/NatForgeAI fallback copy is
 * detected and cleared if it does not appear in the raw evidence.
 */
export function guardProfileSuggestions<T extends Record<string, unknown>>(
  suggestions: T,
  evidence: BusinessEvidence,
  opts?: { fieldsToCheck?: string[]; lowConfidenceThreshold?: number }
): { suggestions: T; warnings: string[]; genericGuardTriggered: boolean } {
  const warnings: string[] = [];
  let genericGuardTriggered = false;
  const evidenceText = getEvidenceText(evidence);

  const fieldsToCheck = opts?.fieldsToCheck ?? [
    "businessCategory",
    "productOrService",
    "productDescription",
    "uniqueSellingPoint",
    "brandVoiceNotes",
    "description",
    "industry",
    "targetAudience",
    "mainGoal",
  ];

  const guarded = { ...suggestions };

  for (const key of fieldsToCheck) {
    const value = guarded[key];
    if (typeof value !== "string" || !value.trim()) continue;

    const phrases = containsGenericFallbackPhrases(value);
    for (const phrase of phrases) {
      if (!evidenceText.includes(phrase.toLowerCase())) {
        genericGuardTriggered = true;
        warnings.push(
          `${key} contained unsupported generic phrase "${phrase}" and was cleared.`
        );
        (guarded as Record<string, unknown>)[key] = "";
      }
    }
  }

  const lowConfidenceThreshold = opts?.lowConfidenceThreshold ?? 0.5;
  if (evidence.confidence < lowConfidenceThreshold) {
    warnings.push(
      "Website evidence confidence is low; leaving uncertain fields blank."
    );
    const keep = new Set(["confidence", "assumptions"]);
    for (const key of Object.keys(guarded)) {
      if (keep.has(key)) continue;
      const val = guarded[key];
      if (typeof val === "string") {
        (guarded as Record<string, unknown>)[key] = "";
      } else if (Array.isArray(val)) {
        (guarded as Record<string, unknown>)[key] = [];
      }
    }
  }

  return { suggestions: guarded, warnings, genericGuardTriggered };
}
