import { env } from "../env";

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
}

export interface VideoRenderResult {
  jobId: string;
  status: "queued" | "rendering" | "completed" | "failed";
  videoUrl?: string;
  thumbnailUrl?: string;
  errorMessage?: string;
}

export interface VideoProvider {
  name: string;
  configured: boolean;
  generateVideo(req: VideoRenderRequest): Promise<VideoRenderResult>;
  getStatus(jobId: string): Promise<VideoRenderResult>;
}

// ─── Placeholder Provider ───
// Returns configured: false when no real provider credentials are available.
// This ensures the UI shows an honest "not configured" message instead of
// faking success or silently failing.
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

// Future: register real providers here (e.g., Runway, HeyGen, Synthesia)
// if (env.videoProvider === "runway" && env.runwayApiKey) {
//   providers.set("runway", new RunwayProvider(env.runwayApiKey));
// }

export function getVideoProvider(): VideoProvider {
  const providerName = env.videoProvider || "placeholder";
  const provider = providers.get(providerName);
  if (provider) return provider;
  return providers.get("placeholder")!;
}

export function isVideoRenderingConfigured(): boolean {
  return getVideoProvider().configured;
}
