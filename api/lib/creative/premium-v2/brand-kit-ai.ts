/**
 * Premium Leaflet Hybrid Pipeline – BrandKit Resolver.
 *
 * Uses OpenAI vision to inspect the business logo and any website brand evidence,
 * then outputs a strict BrandKit JSON object. Falls back to the deterministic
 * brand-kit resolver when OpenAI is unavailable, unconfigured or fails.
 */

import { generateObject } from "ai";
import { structuredModel } from "../../agents/openai";
import { env } from "../../env";
import { asString } from "./curation";
import type { BusinessEvidence } from "./curation";
import { resolveBrandKit as resolveDeterministicBrandKit } from "./brand-kit";
import { BrandKitSchema, type HybridBrandKit } from "./pipeline-types";

const LOGO_FETCH_TIMEOUT_MS = 8000;

function toDataUri(buffer: Buffer, contentType: string): string {
  return `data:${contentType};base64,${buffer.toString("base64")}`;
}

async function fetchLogoBuffer(logoUrl: string): Promise<Buffer | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LOGO_FETCH_TIMEOUT_MS);
    const res = await fetch(logoUrl, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

function inferContentType(buffer: Buffer): string {
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return "image/png";
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return "image/jpeg";
  if (buffer[0] === 0x47 && buffer[1] === 0x49) return "image/gif";
  if (buffer[0] === 0x52 && buffer[1] === 0x49) return "image/webp";
  return "image/png";
}

function buildSystemPrompt(): string {
  return [
    "You are a brand analyst for a marketing design system.",
    "Inspect the provided business logo/brand asset and output a strict brand kit JSON.",
    "Use the supplied saved colours as the primary source of truth, but refine or add accent/secondary colours based on the logo.",
    "Never invent a logo URL. Describe the logo briefly. All hex colours must be 6-digit uppercase.",
  ].join(" ");
}

function buildUserText(business: BusinessEvidence, logoUrl: string | null): string {
  const parts = [
    `Business: ${asString(business.displayName || business.name)}`,
    `Industry: ${asString(business.industry)}`,
    logoUrl ? "Logo provided above." : "No logo provided.",
  ];
  if (business.brandColors?.length) {
    parts.push(`Saved brand colours: ${(business.brandColors as string[]).join(", ")}.`);
  }
  return parts.join("\n");
}

export async function resolveBrandKitWithAI(business: BusinessEvidence): Promise<HybridBrandKit> {
  const deterministic = await resolveDeterministicBrandKit(business);

  if (!env.openaiApiKey || !env.enableHybridLeafletPipeline) {
    return mapDeterministicToHybrid(deterministic);
  }

  const logoUrl = asString(business.logo);
  const logoBuffer = logoUrl ? await fetchLogoBuffer(logoUrl) : null;

  try {
    const userContent: any[] = [
      { type: "text", text: buildUserText(business, logoUrl || null) },
    ];

    if (logoBuffer) {
      userContent.unshift({
        type: "image",
        image: toDataUri(logoBuffer, inferContentType(logoBuffer)),
      });
    }

    const { object } = await generateObject({
      model: structuredModel,
      schema: BrandKitSchema,
      system: buildSystemPrompt(),
      messages: [{ role: "user", content: userContent }],
      temperature: 0.2,
    });

    if (!object.logoUrl && logoUrl) {
      object.logoUrl = logoUrl;
    }
    if (!object.logoUrl) {
      object.logoUrl = null;
    }

    return object;
  } catch (err: any) {
    console.warn(`[HybridBrandKit] AI brand analysis failed: ${err.message}. Falling back to deterministic resolver.`);
    return mapDeterministicToHybrid(deterministic);
  }
}

function mapDeterministicToHybrid(deterministic: {
  palette: { primary: string; secondary: string; accent: string; background: string; text: string; textMuted: string };
  source: "logo" | "brandColors" | "websiteEvidence" | "default";
  logoUrl?: string;
}): HybridBrandKit {
  return {
    ...deterministic.palette,
    source: deterministic.source,
    logoUrl: deterministic.logoUrl || null,
    logoDescription: null,
    typographyNote: null,
  };
}

export { resolveDeterministicBrandKit };
