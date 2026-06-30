export type ProviderStatus =
  | "pending"
  | "queued"
  | "rendering"
  | "running"
  | "completed"
  | "done"
  | "failed"
  | "cancelled";

export type ImageQualityTier = "premium" | "acceptable" | "draft" | "failed";

export interface ImageResult {
  jobId: string;
  status: ProviderStatus;
  imageUrl?: string;
  imageBase64?: string;
  extension?: string;
  errorMessage?: string;
  provider?: string;
  providerJobId?: string;
  rawResponse?: any;
  qualityTier?: ImageQualityTier;
  qualityLabel?: string;
  isDraft?: boolean;
  creditsCharged?: number;
  usingFallback?: boolean;
  fallbackMessage?: string;
}

export interface VideoResult {
  jobId: string;
  status: ProviderStatus;
  videoUrl?: string;
  thumbnailUrl?: string;
  durationSeconds?: number;
  aspectRatio?: string;
  errorMessage?: string;
  provider?: string;
  providerJobId?: string;
  providerLinkId?: string;
  providerCreditsUsed?: number;
  rawResponse?: any;
}

export interface ImageRequest {
  userId: number;
  campaignId?: number;
  businessId?: number;
  contentPostId?: number;
  prompt: string;
  aspectRatio?: string;
  style?: string;
  negativePrompt?: string;
}

export interface VideoRequest {
  contentPostId: number;
  campaignId: number;
  userId: number;
  script: string;
  scenes?: Array<{
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
  websiteUrl?: string;
  targetAudience?: string;
  painPoint?: string;
  productOrService?: string;
  visualStyle?: string;
  brandColors?: string[];
  uploadedImagePath?: string | null;
}

export interface ImageProvider {
  name: string;
  configured: boolean;
  generate(req: ImageRequest): Promise<ImageResult>;
}

export interface VideoProvider {
  name: string;
  configured: boolean;
  generateVideo(req: VideoRequest): Promise<VideoResult>;
  getStatus(jobId: string, extra?: { providerLinkId?: string }): Promise<VideoResult>;
}

export interface ProviderJobRecord {
  provider: string;
  providerJobId: string;
  providerLinkId?: string;
  status: ProviderStatus;
  outputUrl?: string;
  thumbnailUrl?: string;
  creditsUsed?: number;
  failedReason?: string;
  rawResponse?: any;
}
