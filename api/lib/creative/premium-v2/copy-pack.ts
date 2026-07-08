/**
 * Premium Leaflet Hybrid Pipeline – Structured Cleaned Copy Pack.
 *
 * Builds a deterministic, cleaned copy pack from the AI brief before rendering.
 * The renderer consumes this pack directly so broken phrases are repaired at
 * the source, not only detected after rendering.
 */

import type { AICreativeBrief, PremiumCopyPack, VisualDirection } from "./pipeline-types";
import { cleanCopy } from "./copy-quality";
import { inferBusinessCategory } from "./curation";
import type { BusinessEvidence, CampaignEvidence } from "./curation";
import { getServiceMicrocopy } from "./copy";

function repairCta(cta: string): string {
  const cleaned = cleanCopy(cta).replace(/\.$/, "").trim();
  if (/^get\s+touch$/i.test(cleaned)) return "Get in Touch";
  if (/^get\s+quote$/i.test(cleaned)) return "Get a Quote";
  if (/^contact$/i.test(cleaned)) return "Contact Today";
  if (/^request$/i.test(cleaned)) return "Request a Quote";
  if (cleaned.split(/\s+/).filter(Boolean).length < 2) return "Get in Touch";
  return cleaned;
}

function repairSentenceCase(text: string): string {
  // Fix awkward title-case nouns dropped inside sentences, e.g.
  // "we handle Important Documents" -> "we handle important documents"
  return text
    .split(" ")
    .map((word, i) => {
      if (i === 0) return word;
      // Keep capitalised brand/proper nouns if they look like names.
      if (/^[A-Z][a-z]+$/.test(word) && !/^(I|A)$/.test(word)) {
        return word.toLowerCase();
      }
      return word;
    })
    .join(" ");
}

function buildServiceDescription(category: string, serviceName: string, rawDescription: string | null): string {
  const name = serviceName.trim();
  const fallback = getServiceMicrocopy(category, name);
  const raw = cleanCopy(rawDescription || "").replace(/\.$/, "");

  // Block nonsensical repeats like "Printing Solutions printing" or "services made fit your project".
  const lowerName = name.toLowerCase();
  if (raw.toLowerCase().includes(lowerName) && raw.split(/\s+/).length <= 4) {
    return fallback;
  }
  if (/\bmade\s+fit\s+your\s+project\b/i.test(raw)) return fallback;
  if (/\bdelivery\s+when\s+matters\b/i.test(raw)) return "Reliable delivery options for documents and parcels";
  if (!raw || raw.length < 8) return fallback;

  return repairSentenceCase(raw);
}

export function buildPremiumCopyPack(
  business: BusinessEvidence,
  campaign: CampaignEvidence | undefined,
  brief: AICreativeBrief,
  _visualDirection: VisualDirection
): PremiumCopyPack {
  const category = inferBusinessCategory(business, campaign);

  const eyebrow = cleanCopy((business.displayName || business.name || "Your Local Business") as string)
    .replace(/\.$/, "");
  const headline = cleanCopy(brief.headline);
  const subheadline = cleanCopy(brief.subheadline);

  // Build featured benefit from the first primary service, fallback to first benefit.
  const firstService = brief.primaryServices[0];
  const featuredBenefit: PremiumCopyPack["featuredBenefit"] = firstService
    ? {
        title: cleanCopy(firstService.name).replace(/\.$/, ""),
        body: buildServiceDescription(category, firstService.name, firstService.description),
      }
    : {
        title: "What we do",
        body: "Professional support tailored to your needs.",
      };

  // Supporting services: max 2, deduplicated, with clean descriptions.
  const seen = new Set<string>();
  const services: PremiumCopyPack["services"] = [];
  for (const s of brief.primaryServices.slice(1)) {
    const title = cleanCopy(s.name).replace(/\.$/, "");
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    services.push({ title, body: buildServiceDescription(category, s.name, s.description) });
    if (services.length >= 2) break;
  }

  // Proof points from benefits.
  const proofPoints = brief.benefits
    .map((b) => cleanCopy(b).replace(/\.$/, ""))
    .filter((b) => b.length > 0)
    .slice(0, 3);

  const cta = repairCta(brief.cta);

  const parts: string[] = [];
  if (business.location) parts.push(business.location as string);
  if (business.phone) parts.push(business.phone as string);
  if (business.website) parts.push(business.website as string);
  const footer = parts.join(" · ");

  return { eyebrow, headline, subheadline, featuredBenefit, services, proofPoints, cta, footer };
}
