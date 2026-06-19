import { env } from "../../env";
import type { ImageProvider, ImageRequest, ImageResult } from "../types";

function mapAspectRatio(ratio?: string): "1024x1024" | "1792x1024" | "1024x1792" {
  switch (ratio) {
    case "16:9":
    case "3:2":
    case "4:3":
      return "1792x1024";
    case "9:16":
    case "2:3":
    case "4:5":
      return "1024x1792";
    case "1:1":
    default:
      return "1024x1024";
  }
}

function mapAspectRatioForGptImage(ratio?: string): "1024x1024" | "1024x1536" | "1536x1024" {
  switch (ratio) {
    case "16:9":
    case "3:2":
    case "4:3":
      return "1536x1024";
    case "9:16":
    case "2:3":
    case "4:5":
      return "1024x1536";
    case "1:1":
    default:
      return "1024x1024";
  }
}

export class OpenAIImageProvider implements ImageProvider {
  name = "openai";

  get configured(): boolean {
    return !!env.openaiApiKey;
  }

  async generate(req: ImageRequest): Promise<ImageResult> {
    if (!env.openaiApiKey) {
      return {
        jobId: "",
        status: "failed",
        errorMessage: "Premium image generation is not configured. Please contact admin.",
      };
    }

    const model = env.openaiImageModel || "gpt-image-1";
    const isDallE = model.includes("dall-e");
    const size = isDallE ? mapAspectRatio(req.aspectRatio) : mapAspectRatioForGptImage(req.aspectRatio);

    const jobId = `openai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    console.log(`[OpenAIImageProvider] Requesting image | jobId=${jobId} | model=${model} | size=${size}`);

    try {
      const body: Record<string, any> = {
        model,
        prompt: req.prompt,
        n: 1,
        size,
      };

      if (isDallE) {
        // DALL-E 3 supports quality: standard | hd
        const dallEQuality = env.openaiImageQuality === "hd" ? "hd" : "standard";
        body.quality = dallEQuality;
        // DALL-E 3 uses response_format to request base64
        body.response_format = "b64_json";
      } else {
        // gpt-image-1 supports quality: low | medium | high | auto
        const gptImageQualities = ["low", "medium", "high", "auto"];
        const rawQuality = env.openaiImageQuality || "high";
        body.quality = gptImageQualities.includes(rawQuality) ? rawQuality : "high";
        // gpt-image-1 uses output_format for file format (png/jpeg/webp).
        // Base64 data is returned by default in result.data[0].b64_json.
        const outputFormat = env.openaiImageOutputFormat || "png";
        body.output_format = ["png", "jpeg", "webp"].includes(outputFormat) ? outputFormat : "png";
      }

      const response = await fetch("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.openaiApiKey}`,
        },
        body: JSON.stringify(body),
      });

      const rawResponse = (await response.json().catch(async () => ({}))) as any;

      if (!response.ok) {
        const errorDetail = rawResponse?.error?.message || JSON.stringify(rawResponse);
        console.error(`[OpenAIImageProvider] Generation failed | jobId=${jobId} | status=${response.status} | error="${errorDetail}"`);
        return {
          jobId,
          status: "failed",
          errorMessage: `OpenAI image generation failed (${response.status}): ${errorDetail}`,
          provider: this.name,
          providerJobId: jobId,
          rawResponse,
        };
      }

      const b64 = rawResponse?.data?.[0]?.b64_json as string | undefined;
      const imageUrl = rawResponse?.data?.[0]?.url as string | undefined;

      if (!b64 && !imageUrl) {
        console.error(`[OpenAIImageProvider] No image data | jobId=${jobId} | rawResponseKeys=${Object.keys(rawResponse).join(",")}`);
        return {
          jobId,
          status: "failed",
          errorMessage: "OpenAI returned no image data",
          provider: this.name,
          providerJobId: jobId,
          rawResponse,
        };
      }

      console.log(`[OpenAIImageProvider] Generation succeeded | jobId=${jobId} | hasBase64=${!!b64} | hasUrl=${!!imageUrl}`);

      return {
        jobId,
        providerJobId: jobId,
        provider: this.name,
        status: "completed",
        imageUrl,
        imageBase64: b64,
        extension: isDallE ? "png" : (body.output_format as string),
        rawResponse,
      };
    } catch (err: any) {
      console.error(`[OpenAIImageProvider] Request exception | jobId=${jobId} | error="${err.message}"`);
      return {
        jobId,
        status: "failed",
        errorMessage: err.message || "OpenAI image generation request failed",
        provider: this.name,
        providerJobId: jobId,
      };
    }
  }
}
