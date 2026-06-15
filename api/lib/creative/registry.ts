import { env } from "../env";
import { OpenAIImageProvider } from "./providers/openai-image-provider";
import { CreatifyVideoProvider } from "./providers/creatify-video-provider";
import { LocalVideoProvider } from "./providers/local-video-provider";
import { PlaceholderImageProvider, PlaceholderVideoProvider } from "./providers/placeholder-provider";
import type { ImageProvider, VideoProvider } from "./types";

const openaiImage = new OpenAIImageProvider();
const creatifyVideo = new CreatifyVideoProvider();
const localVideo = new LocalVideoProvider();

export function getImageProvider(): ImageProvider {
  if (env.openaiApiKey) return openaiImage;
  return new PlaceholderImageProvider("openai");
}

export function isImageGenerationConfigured(): boolean {
  return getImageProvider().configured;
}

export function getPremiumVideoProvider(): VideoProvider {
  if (creatifyVideo.configured) return creatifyVideo;
  return new PlaceholderVideoProvider("creatify");
}

export function isPremiumVideoConfigured(): boolean {
  return getPremiumVideoProvider().configured;
}

export function getBasicVideoProvider(): VideoProvider {
  return localVideo;
}

export function isBasicVideoConfigured(): boolean {
  return localVideo.configured;
}

// Backward-compatible helpers while callers migrate
export function getVideoProvider(): VideoProvider {
  return localVideo;
}

export function isVideoRenderingConfigured(): boolean {
  return localVideo.configured;
}
