import path from "path";
import fs from "fs";
import { env } from "../env";
import { randomUUID } from "crypto";

const PUBLIC_GENERATED_DIR = env.isProduction
  ? path.resolve(process.cwd(), "dist/public/generated")
  : path.resolve(process.cwd(), "public/generated");

const PUBLIC_UPLOADS_DIR = env.isProduction
  ? path.resolve(process.cwd(), "dist/public/uploads")
  : path.resolve(process.cwd(), "public/uploads");

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

function stripDataUri(base64: string): string {
  const match = base64.match(/^data:[^;]+;base64,(.+)$/);
  return match ? match[1] : base64;
}

export async function storeUploadedAsset(
  base64: string,
  options: {
    userId: number;
    assetType: string;
    fileName: string;
  }
): Promise<StoredMedia> {
  if (!base64) throw new Error("No asset data provided");

  const clean = stripDataUri(base64);
  const safeName = options.fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
  const ext = path.extname(safeName) || ".png";
  const base = path.basename(safeName, ext) || "asset";
  const dir = path.join(PUBLIC_UPLOADS_DIR, options.assetType, String(options.userId));
  ensureDir(dir);

  const fileName = `${base}_${randomUUID()}${ext}`;
  const localPath = path.join(dir, fileName);

  const buffer = Buffer.from(clean, "base64");
  fs.writeFileSync(localPath, buffer);

  const publicUrl = `${publicBaseUrl()}/uploads/${options.assetType}/${options.userId}/${fileName}`;

  return { publicUrl, localPath };
}

export async function storeImageBuffer(
  buffer: Buffer,
  options: {
    campaignId?: number;
    prefix?: string;
    extension?: string;
  } = {}
): Promise<StoredMedia> {
  if (!buffer || buffer.length === 0) throw new Error("No image buffer provided");

  const ext = options.extension || "png";
  const dir = path.join(
    PUBLIC_GENERATED_DIR,
    "images",
    options.campaignId ? String(options.campaignId) : "general"
  );
  ensureDir(dir);

  const fileName = `${options.prefix || "img"}_${randomUUID()}.${ext}`;
  const localPath = path.join(dir, fileName);

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
