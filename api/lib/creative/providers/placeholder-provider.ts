import type { ImageProvider, VideoProvider, ImageRequest, ImageResult, VideoRequest, VideoResult } from "../types";

export class PlaceholderImageProvider implements ImageProvider {
  name: string;
  configured = false;

  constructor(name: string) {
    this.name = name;
  }

  async generate(_req: ImageRequest): Promise<ImageResult> {
    return {
      jobId: "",
      status: "failed",
      errorMessage: `${this.name} image provider is not configured.`,
    };
  }
}

export class PlaceholderVideoProvider implements VideoProvider {
  name: string;
  configured = false;

  constructor(name: string) {
    this.name = name;
  }

  async generateVideo(_req: VideoRequest): Promise<VideoResult> {
    return {
      jobId: "",
      status: "failed",
      errorMessage: `${this.name} video provider is not configured.`,
    };
  }

  async getStatus(jobId: string): Promise<VideoResult> {
    return {
      jobId,
      status: "failed",
      errorMessage: `${this.name} video provider is not configured.`,
    };
  }
}
