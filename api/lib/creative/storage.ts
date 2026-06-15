import path from "path";
import fs from "fs";
import { env } from "../env";
import { randomUUID } from "crypto";

const PUBLIC_GENERATED_DIR = env.isProduction
  ? path.resolve(process.cwd(), "dist/public/generated")
  : path.resolve(process.cwd(), "public/generated");

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function publicBaseUrl(): string {
  return env.isProduction ? "" : "http://localhost:3000";
}

export interface StoredMedia {
  publicUrl: string;
  localPath: string;
}

export async function downloadAndStoreImage(
  url: string,
  options: {
    campaignId?: number;
    prefix?: string;
    extension?: string;
  } = {}
): Promise<StoredMedia> {
  if (!url) throw new Error("No image URL provided");

  const ext = options.extension || "png";
  const dir = path.join(
    PUBLIC_GENERATED_DIR,
    "images",
    options.campaignId ? String(options.campaignId) : "general"
  );
  ensureDir(dir);

  const fileName = `${options.prefix || "img"}_${randomUUID()}.${ext}`;
  const localPath = path.join(dir, fileName);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download image: ${response.status} ${response.statusText}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(localPath, buffer);

  const publicUrl = `${publicBaseUrl()}/generated/images/${
    options.campaignId ? String(options.campaignId) : "general"
  }/${fileName}`;

  return { publicUrl, localPath };
}

export async function storeBase64Image(
  base64: string,
  options: {
    campaignId?: number;
    prefix?: string;
    extension?: string;
  } = {}
): Promise<StoredMedia> {
  if (!base64) throw new Error("No base64 image provided");

  const ext = options.extension || "png";
  const dir = path.join(
    PUBLIC_GENERATED_DIR,
    "images",
    options.campaignId ? String(options.campaignId) : "general"
  );
  ensureDir(dir);

  const fileName = `${options.prefix || "img"}_${randomUUID()}.${ext}`;
  const localPath = path.join(dir, fileName);

  const buffer = Buffer.from(base64, "base64");
  fs.writeFileSync(localPath, buffer);

  const publicUrl = `${publicBaseUrl()}/generated/images/${
    options.campaignId ? String(options.campaignId) : "general"
  }/${fileName}`;

  return { publicUrl, localPath };
}

export async function downloadAndStoreVideo(
  url: string,
  options: {
    campaignId?: number;
    prefix?: string;
    extension?: string;
  } = {}
): Promise<StoredMedia> {
  if (!url) throw new Error("No video URL provided");

  const ext = options.extension || "mp4";
  const dir = path.join(
    PUBLIC_GENERATED_DIR,
    "videos",
    options.campaignId ? String(options.campaignId) : "general"
  );
  ensureDir(dir);

  const fileName = `${options.prefix || "video"}_${randomUUID()}.${ext}`;
  const localPath = path.join(dir, fileName);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download video: ${response.status} ${response.statusText}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(localPath, buffer);

  const publicUrl = `${publicBaseUrl()}/generated/videos/${
    options.campaignId ? String(options.campaignId) : "general"
  }/${fileName}`;

  return { publicUrl, localPath };
}
