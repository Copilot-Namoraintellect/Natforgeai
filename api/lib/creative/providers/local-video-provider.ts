import { renderLocalMp4 } from "../../video/renderer";
import type { VideoProvider, VideoRequest, VideoResult } from "../types";

export class LocalVideoProvider implements VideoProvider {
  name = "local";
  configured = true;

  async generateVideo(req: VideoRequest): Promise<VideoResult> {
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
        scenes: (req.scenes || []).map((s) => ({
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
        providerJobId: `local-${req.contentPostId}-${Date.now()}`,
        provider: this.name,
        status: "completed",
        videoUrl: result.videoUrl,
        thumbnailUrl: result.thumbnailUrl,
        durationSeconds: result.durationSeconds,
        aspectRatio: result.aspectRatio,
      };
    } catch (err: any) {
      return {
        jobId: `local-fail-${Date.now()}`,
        providerJobId: `local-fail-${Date.now()}`,
        provider: this.name,
        status: "failed",
        errorMessage: err.message || "Local render failed",
      };
    }
  }

  async getStatus(jobId: string): Promise<VideoResult> {
    if (jobId.startsWith("local-fail")) {
      return { jobId, provider: this.name, status: "failed", errorMessage: "Previous render failed" };
    }
    return { jobId, provider: this.name, status: "completed" };
  }
}
