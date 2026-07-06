/**
 * Premium Leaflet Hybrid Pipeline – Background Generator.
 *
 * Generates a text-free, logo-free, signage-free background image using the
 * existing OpenAI image provider. The prompt is built from the VisualDirection
 * and is strictly forbidden from containing readable text, fake logos or fake
 * contact details.
 */

import sharp from "sharp";
import { OpenAIImageProvider } from "../providers/openai-image-provider";
import type { VisualDirection } from "./pipeline-types";

const TARGET_WIDTH = 1080;
const TARGET_HEIGHT = 1350;

export async function generateBackground(visualDirection: VisualDirection): Promise<Buffer | null> {
  const provider = new OpenAIImageProvider();
  if (!provider.configured) {
    console.warn("[HybridBackground] OpenAI image provider not configured.");
    return null;
  }

  const safePrompt = sanitizePrompt(visualDirection.backgroundPrompt);

  const result = await provider.generate({
    userId: 0,
    prompt: safePrompt,
    aspectRatio: "4:5",
  });

  if (result.status !== "completed" || (!result.imageBase64 && !result.imageUrl)) {
    console.warn(`[HybridBackground] Background generation failed: ${result.errorMessage || "no image data"}`);
    return null;
  }

  try {
    const inputBuffer = result.imageBase64
      ? Buffer.from(result.imageBase64, "base64")
      : Buffer.from(await fetch(result.imageUrl!).then((r) => r.arrayBuffer()) as ArrayBuffer);

    return sharp(inputBuffer)
      .resize({ width: TARGET_WIDTH, height: TARGET_HEIGHT, fit: "cover", position: "center" })
      .png()
      .toBuffer();
  } catch (err: any) {
    console.warn(`[HybridBackground] Background processing failed: ${err.message}`);
    return null;
  }
}

function sanitizePrompt(prompt: string): string {
  const base = prompt.trim();
  const suffix = "NO text, NO letters, NO numbers, NO logos, NO brand marks, NO signage, NO contact details, NO phone numbers, NO website URLs, NO people faces.";
  if (base.toLowerCase().includes(suffix.toLowerCase())) return base;
  return `${base} ${suffix}`;
}
