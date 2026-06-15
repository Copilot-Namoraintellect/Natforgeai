import { env } from "../../env";
import type { VideoProvider, VideoRequest, VideoResult, ProviderStatus } from "../types";

function getHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "X-API-ID": env.creatifyApiId,
    "X-API-KEY": env.creatifyApiKey,
  };
}

function mapStatus(status: string): ProviderStatus {
  switch (status?.toLowerCase()) {
    case "pending":
      return "pending";
    case "in_queue":
      return "queued";
    case "running":
      return "running";
    case "done":
      return "done";
    case "failed":
      return "failed";
    default:
      return "pending";
  }
}

export interface CreatifyLinkInput {
  url: string;
}

export interface CreatifyLinkUpdateInput {
  title?: string;
  description?: string;
  imageUrls?: string[];
  videoUrls?: string[];
  logoUrl?: string;
}

export interface CreatifyVideoInput {
  link: string;
  name: string;
  targetPlatform: string;
  targetAudience: string;
  visualStyle: string;
  scriptStyle: string;
  aspectRatio: string;
  videoLength: number;
  language: string;
  modelVersion: string;
  overrideScript: string;
  webhookUrl: string;
  noCaption?: boolean;
  noCta?: boolean;
  noStockBroll?: boolean;
  backgroundMusicVolume?: number;
  voiceoverVolume?: number;
  captionSetting?: Record<string, any>;
}

export class CreatifyVideoProvider implements VideoProvider {
  name = "creatify";

  get configured(): boolean {
    return !!env.creatifyApiId && !!env.creatifyApiKey;
  }

  private baseUrl(): string {
    return env.creatifyApiBaseUrl.replace(/\/$/, "");
  }

  async createLink(url: string): Promise<{ id: string; raw: any }> {
    const response = await fetch(`${this.baseUrl()}/api/links/`, {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify({ url }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Creatify createLink failed (${response.status}): ${text}`);
    }

    const data = (await response.json()) as any;
    if (!data.id) {
      throw new Error("Creatify createLink response missing id");
    }

    return { id: String(data.id), raw: data };
  }

  async updateLink(id: string, input: CreatifyLinkUpdateInput): Promise<any> {
    const response = await fetch(`${this.baseUrl()}/api/links/${id}/`, {
      method: "PUT",
      headers: getHeaders(),
      body: JSON.stringify({
        title: input.title,
        description: input.description,
        image_urls: input.imageUrls || [],
        video_urls: input.videoUrls || [],
        logo_url: input.logoUrl,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Creatify updateLink failed (${response.status}): ${text}`);
    }

    return (await response.json()) as any;
  }

  async createVideo(input: CreatifyVideoInput): Promise<{ id: string; raw: any }> {
    const response = await fetch(`${this.baseUrl()}/api/link_to_videos/`, {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify({
        link: input.link,
        name: input.name,
        target_platform: input.targetPlatform,
        target_audience: input.targetAudience,
        visual_style: input.visualStyle,
        script_style: input.scriptStyle,
        aspect_ratio: input.aspectRatio,
        video_length: input.videoLength,
        language: input.language,
        model_version: input.modelVersion,
        override_script: input.overrideScript,
        webhook_url: input.webhookUrl,
        no_caption: input.noCaption ?? false,
        no_cta: input.noCta ?? false,
        no_stock_broll: input.noStockBroll ?? false,
        background_music_volume: input.backgroundMusicVolume ?? 0.3,
        voiceover_volume: input.voiceoverVolume ?? 0.8,
        caption_setting: input.captionSetting,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Creatify createVideo failed (${response.status}): ${text}`);
    }

    const data = (await response.json()) as any;
    if (!data.id) {
      throw new Error("Creatify createVideo response missing id");
    }

    return { id: String(data.id), raw: data };
  }

  async getStatus(id: string): Promise<VideoResult> {
    const response = await fetch(`${this.baseUrl()}/api/link_to_videos/${id}/`, {
      method: "GET",
      headers: getHeaders(),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Creatify getStatus failed (${response.status}): ${text}`);
    }

    const data = (await response.json()) as any;
    return this.parseVideoResponse(data);
  }

  parseVideoResponse(data: any): VideoResult {
    const status = mapStatus(data.status);
    const durationSeconds = data.duration ? Number(data.duration) : undefined;

    return {
      jobId: data.id ? String(data.id) : "",
      providerJobId: data.id ? String(data.id) : "",
      providerLinkId: data.link ? String(data.link) : undefined,
      provider: this.name,
      status,
      videoUrl: data.video_output || undefined,
      thumbnailUrl: data.video_thumbnail || undefined,
      durationSeconds,
      aspectRatio: "9:16",
      errorMessage: data.failed_reason || undefined,
      providerCreditsUsed: data.credits_used != null ? Number(data.credits_used) : undefined,
      rawResponse: data,
    };
  }

  async generateVideo(req: VideoRequest): Promise<VideoResult> {
    if (!this.configured) {
      return {
        jobId: "",
        status: "failed",
        errorMessage: "Creatify is not configured. Add CREATIFY_API_ID and CREATIFY_API_KEY.",
      };
    }

    if (!req.websiteUrl) {
      return {
        jobId: "",
        status: "failed",
        errorMessage: "A business website URL is required to generate a premium video with Creatify.",
      };
    }

    try {
      const link = await this.createLink(req.websiteUrl);

      await this.updateLink(link.id, {
        title: req.title || req.businessName || "Campaign",
        description: this.buildDescription(req),
        logoUrl: undefined,
        imageUrls: [],
        videoUrls: [],
      });

      const video = await this.createVideo({
        link: link.id,
        name: req.title || `${req.businessName || "Campaign"} Premium Video`,
        targetPlatform: "Instagram",
        targetAudience: req.targetAudience || "general audience",
        visualStyle: "DynamicProductTemplate",
        scriptStyle: "DontWorryWriter",
        aspectRatio: "9x16",
        videoLength: 15,
        language: "en",
        modelVersion: "aurora_v1_fast",
        overrideScript: this.buildScript(req),
        webhookUrl: env.creatifyWebhookUrl,
        captionSetting: this.buildCaptionSetting(req),
      });

      return {
        jobId: video.id,
        providerJobId: video.id,
        providerLinkId: link.id,
        provider: this.name,
        status: "queued",
        aspectRatio: "9:16",
        rawResponse: { link: link.raw, video: video.raw },
      };
    } catch (err: any) {
      return {
        jobId: "",
        status: "failed",
        errorMessage: err.message || "Creatify video generation request failed",
      };
    }
  }

  private buildDescription(req: VideoRequest): string {
    const parts = [
      req.productOrService ? `Product/Service: ${req.productOrService}` : "",
      req.painPoint ? `Pain point: ${req.painPoint}` : "",
      req.targetAudience ? `Target buyer: ${req.targetAudience}` : "",
      req.cta ? `Call to action: ${req.cta}` : "",
      req.offer ? `Offer: ${req.offer}` : "",
      "Do not invent discounts, free trials, limited spots or promotions.",
    ];
    return parts.filter(Boolean).join("\n");
  }

  private buildScript(req: VideoRequest): string {
    if (req.script) return req.script;
    const scenes = req.scenes || [];
    const lines = scenes
      .map((s) => s.onScreenText || s.visualDescription || "")
      .filter(Boolean)
      .join("\n");
    return lines || req.title || "";
  }

  private buildCaptionSetting(req: VideoRequest): Record<string, any> {
    const colors = req.brandColors || [];
    const primary = colors[0] || "#00C2FF";
    return {
      offset: { x: 0, y: 0.4 },
      font_size: 48,
      background_color: "#000000",
      text_color: "#FFFFFF",
      highlight_text_color: primary,
      max_width: 900,
      hidden: false,
      override_visual_style: false,
    };
  }
}
