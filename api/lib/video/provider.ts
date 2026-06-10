import { env } from "../env";
import { renderLocalMp4 } from "./renderer";

export interface VideoRenderRequest {
  contentPostId: number;
  campaignId: number;
  userId: number;
  script: string;
  scenes: Array<{
    sceneNumber: number;
    visualDescription: string;
    onScreenText?: string | null;
    voiceoverScript?: string | null;
  }>;
  duration?: string;
  style?: string;
  title?: string;
  businessName?: string;
  productName?: string;
  offer?: string;
  cta?: string;
  uploadedImagePath?: string | null;
}

export interface VideoRenderResult {
  jobId: string;
  status: "queued" | "rendering" | "completed" | "failed";
  videoUrl?: string;
  thumbnailUrl?: string;
  errorMessage?: string;
  durationSeconds?: number;
  aspectRatio?: string;
}

export interface VideoProvider {
  name: string;
  configured: boolean;
  generateVideo(req: VideoRenderRequest): Promise<VideoRenderResult>;
  getStatus(jobId: string): Promise<VideoRenderResult>;
}

// ─── Local FFmpeg Renderer ───
class LocalVideoProvider implements VideoProvider {
  name = "local";
  configured = true;

  async generateVideo(req: VideoRenderRequest): Promise<VideoRenderResult> {
    try {
      const result = await renderLocalMp4({
        contentPostId: req.contentPostId,
        campaignId: req.campaignId,
        userId: req.userId,
        title: req.title || "Video",
        businessName: req.businessName,
        productName: req.productName,
        offer: req.offer,
        cta: req.cta,
        scenes: req.scenes.map((s) => ({
          sceneNumber: s.sceneNumber,
          durationSeconds: 5,
          visualDescription: s.visualDescription,
          onScreenText: s.onScreenText,
          voiceoverScript: s.voiceoverScript,
        })),
        duration: req.duration,
        style: req.style,
        uploadedImagePath: req.uploadedImagePath,
      });

      return {
        jobId: `local-${req.contentPostId}-${Date.now()}`,
        status: "completed",
        videoUrl: result.videoUrl,
        thumbnailUrl: result.thumbnailUrl,
        durationSeconds: result.durationSeconds,
        aspectRatio: result.aspectRatio,
      };
    } catch (err: any) {
      return {
        jobId: `local-fail-${Date.now()}`,
        status: "failed",
        errorMessage: err.message || "Local render failed",
      };
    }
  }

  async getStatus(jobId: string): Promise<VideoRenderResult> {
    // Local renders are synchronous; status is final immediately
    if (jobId.startsWith("local-fail")) {
      return { jobId, status: "failed", errorMessage: "Previous render failed" };
    }
    return { jobId, status: "completed" };
  }
}

// ─── Placeholder Provider ───
class PlaceholderVideoProvider implements VideoProvider {
  name = "placeholder";
  configured = false;

  async generateVideo(): Promise<VideoRenderResult> {
    throw new Error(
      "Video rendering is not configured. Set VIDEO_PROVIDER environment variable to enable automatic video generation."
    );
  }

  async getStatus(): Promise<VideoRenderResult> {
    throw new Error("Video rendering is not configured.");
  }
}

// ─── Provider Registry ───
const providers = new Map<string, VideoProvider>();
providers.set("placeholder", new PlaceholderVideoProvider());
providers.set("local", new LocalVideoProvider());

// Future: register real providers here (e.g., Runway, HeyGen, Synthesia)
// if (env.videoProvider === "runway" && env.runwayApiKey) {
//   providers.set("runway", new RunwayProvider(env.runwayApiKey));
// }

export function getVideoProvider(): VideoProvider {
  const providerName = env.videoProvider || "local";
  const provider = providers.get(providerName);
  if (provider) return provider;
  return providers.get("placeholder")!;
}

export function isVideoRenderingConfigured(): boolean {
  return getVideoProvider().configured;
}
