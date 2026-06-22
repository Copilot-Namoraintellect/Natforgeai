import { env } from "../env";
import { OpenAIImageProvider } from "./providers/openai-image-provider";
import { CreatifyVideoProvider } from "./providers/creatify-video-provider";
import { LocalVideoProvider } from "./providers/local-video-provider";
import { PlaceholderImageProvider, PlaceholderVideoProvider } from "./providers/placeholder-provider";
import { BannerbearTemplateRenderer } from "./providers/bannerbear-template-renderer";
import { TemplatedIoTemplateRenderer } from "./providers/templatedio-template-renderer";
import { PlaceholderTemplateRenderer } from "./providers/placeholder-template-renderer";
import type { ImageProvider, VideoProvider } from "./types";
import type { TemplateRendererProvider } from "./providers/template-renderer";

const openaiImage = new OpenAIImageProvider();
const creatifyVideo = new CreatifyVideoProvider();
const localVideo = new LocalVideoProvider();
const bannerbearTemplate = new BannerbearTemplateRenderer();
const templatedIoTemplate = new TemplatedIoTemplateRenderer();

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

export function getTemplateRendererProvider(): TemplateRendererProvider {
  if (!env.enablePremiumTemplateProvider) {
    return new PlaceholderTemplateRenderer(env.premiumTemplateProvider);
  }
  const provider = env.premiumTemplateProvider.toLowerCase();
  if (provider === "templatedio" || provider === "templated.io") {
    if (templatedIoTemplate.configured) return templatedIoTemplate;
    return new PlaceholderTemplateRenderer("templatedio");
  }
  if (provider === "bannerbear") {
    if (bannerbearTemplate.configured) return bannerbearTemplate;
    return new PlaceholderTemplateRenderer("bannerbear");
  }
  return new PlaceholderTemplateRenderer(env.premiumTemplateProvider);
}

export function isPremiumTemplateProviderConfigured(): boolean {
  return getTemplateRendererProvider().configured;
}
