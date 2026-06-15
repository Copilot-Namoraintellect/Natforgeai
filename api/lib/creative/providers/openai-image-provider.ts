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
        errorMessage: "OpenAI API key is not configured",
      };
    }

    const size = mapAspectRatio(req.aspectRatio);

    try {
      const response = await fetch("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.openaiApiKey}`,
        },
        body: JSON.stringify({
          model: "dall-e-3",
          prompt: req.prompt,
          n: 1,
          size,
          quality: "standard",
          response_format: "url",
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        return {
          jobId: "",
          status: "failed",
          errorMessage: `OpenAI image generation failed (${response.status}): ${errorBody}`,
        };
      }

      const data = (await response.json()) as any;
      const imageUrl = data?.data?.[0]?.url;

      if (!imageUrl) {
        return {
          jobId: "",
          status: "failed",
          errorMessage: "OpenAI returned no image URL",
        };
      }

      const jobId = `openai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      return {
        jobId,
        providerJobId: jobId,
        provider: this.name,
        status: "completed",
        imageUrl,
      };
    } catch (err: any) {
      return {
        jobId: "",
        status: "failed",
        errorMessage: err.message || "OpenAI image generation request failed",
      };
    }
  }
}
