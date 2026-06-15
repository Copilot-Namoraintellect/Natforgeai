import path from "path";
import fs from "fs";
import { spawn } from "child_process";
import ffmpegStatic from "ffmpeg-static";
import sharp from "sharp";
import { env } from "../env";

const PUBLIC_VIDEOS_DIR = env.isProduction
  ? path.resolve(process.cwd(), "dist/public/videos")
  : path.resolve(process.cwd(), "public/videos");

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      console.log(`[VideoRenderer] Created output directory: ${dir}`);
    } catch (err: any) {
      console.error(`[VideoRenderer] Failed to create output directory: ${dir} | error="${err.message}"`);
      throw new Error(`Render failed: output folder missing — ${err.message}`);
    }
  }
}

function classifyRenderError(err: any, context: { ffmpegExitCode?: number | null; stderr?: string }): string {
  const message = err?.message || String(err);
  if (message.includes("ENOENT") && message.toLowerCase().includes("ffmpeg")) {
    return "Render failed: ffmpeg not found";
  }
  if (message.includes("output folder missing")) {
    return message;
  }
  if (context.ffmpegExitCode != null) {
    return `Render failed: ffmpeg exited with code ${context.ffmpegExitCode}`;
  }
  if (message.includes("spawn")) {
    return "Render failed: could not start ffmpeg";
  }
  return `Render failed: ${message}`;
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-z0-9_-]/gi, "_").toLowerCase();
}

function escapeSvg(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

interface SceneInput {
  sceneNumber: number;
  durationSeconds: number;
  visualDescription: string;
  onScreenText?: string | null;
  voiceoverScript?: string | null;
}

interface RenderVideoInput {
  contentPostId: number;
  campaignId: number;
  userId: number;
  title: string;
  businessName?: string;
  productName?: string;
  offer?: string;
  cta?: string;
  scenes: SceneInput[];
  duration?: string;
  style?: string;
  uploadedImagePath?: string | null;
}

interface RenderVideoOutput {
  videoUrl: string;
  thumbnailUrl: string;
  durationSeconds: number;
  aspectRatio: string;
}

const WIDTH = 1080;
const HEIGHT = 1920;
const FPS = 30;

const BRAND_ACCENT = "#00D4FF";
const BRAND_SECONDARY = "#7C3AED";

const GRADIENTS = [
  { from: "#0f172a", to: "#1e1b4b" },
  { from: "#1e1b4b", to: "#312e81" },
  { from: "#0c4a6e", to: "#1e3a8a" },
  { from: "#312e81", to: "#4c1d95" },
  { from: "#111827", to: "#312e81" },
  { from: "#0f172a", to: "#0c4a6e" },
];

function wrapText(text: string, maxChars: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let line = "";
  for (const w of words) {
    if ((line + " " + w).trim().length > maxChars && line.length > 0) {
      out.push(line.trim());
      line = w;
    } else {
      line = line ? `${line} ${w}` : w;
    }
  }
  if (line.trim()) out.push(line.trim());
  return out.length ? out : [text];
}

function buildFrameSvg(
  scene: SceneInput,
  index: number,
  total: number,
  input: RenderVideoInput
): string {
  const isFirst = index === 0;
  const isLast = index === total - 1;
  const gradient = GRADIENTS[index % GRADIENTS.length];
  const caption = scene.onScreenText || scene.visualDescription || input.title || "";
  const wrapped = wrapText(caption, 32);
  const lineHeight = 68;
  const chipText = isFirst ? "The problem" : isLast ? "Next step" : "The solution";
  const chipColor = isFirst ? "#f87171" : isLast ? BRAND_ACCENT : "#34d399";

  const captionBoxPadding = 48;
  const captionBoxHeight = Math.max(180, wrapped.length * lineHeight + captionBoxPadding * 2);
  const captionBoxY = HEIGHT - captionBoxHeight - 260;

  let linesSvg = "";
  const startY = captionBoxY + captionBoxPadding + lineHeight * 0.75;
  wrapped.forEach((wl, idx) => {
    linesSvg += `<text x="${WIDTH / 2}" y="${startY + idx * lineHeight}" font-family="Arial, sans-serif" font-size="56" font-weight="700" fill="#ffffff" text-anchor="middle">${escapeSvg(wl)}</text>`;
  });

  const ctaButtonSvg =
    isLast && input.cta
      ? `
    <g filter="url(#shadow)">
      <rect x="${WIDTH / 2 - 320}" y="${HEIGHT - 210}" width="640" height="100" rx="24" fill="${BRAND_ACCENT}" />
      <text x="${WIDTH / 2}" y="${HEIGHT - 150}" font-family="Arial, sans-serif" font-size="42" font-weight="bold" fill="#0f172a" text-anchor="middle">${escapeSvg(input.cta)}</text>
    </g>
  `
      : "";

  const businessName = input.businessName || input.productName || "";

  return `
    <svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bgGradient" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stop-color="${gradient.from}" />
          <stop offset="100%" stop-color="${gradient.to}" />
        </linearGradient>
        <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="6" stdDeviation="6" flood-color="#000000" flood-opacity="0.4" />
        </filter>
        <linearGradient id="barGradient" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stop-color="${BRAND_ACCENT}" />
          <stop offset="100%" stop-color="${BRAND_SECONDARY}" />
        </linearGradient>
      </defs>

      <!-- Background -->
      <rect width="100%" height="100%" fill="url(#bgGradient)" />

      <!-- Top brand bar -->
      <rect x="0" y="0" width="100%" height="130" fill="rgba(0,0,0,0.28)" />
      <rect x="0" y="0" width="12" height="130" fill="url(#barGradient)" />
      <text x="54" y="82" font-family="Arial, sans-serif" font-size="44" font-weight="800" fill="#ffffff">${escapeSvg(businessName)}</text>
      <text x="${WIDTH - 54}" y="82" font-family="Arial, sans-serif" font-size="26" fill="#94a3b8" text-anchor="end">Draft motion video</text>

      <!-- Arc chip -->
      <g filter="url(#shadow)">
        <rect x="54" y="170" width="260" height="58" rx="29" fill="${chipColor}" opacity="0.95" />
        <text x="184" y="210" font-family="Arial, sans-serif" font-size="26" font-weight="bold" fill="#0f172a" text-anchor="middle">${chipText}</text>
      </g>

      <!-- Caption card -->
      <g filter="url(#shadow)">
        <rect x="54" y="${captionBoxY}" width="${WIDTH - 108}" height="${captionBoxHeight}" rx="28" fill="rgba(15,23,42,0.72)" />
        ${linesSvg}
      </g>

      <!-- CTA button (last scene) -->
      ${ctaButtonSvg}
    </svg>
  `;
}

export async function renderLocalMp4(input: RenderVideoInput): Promise<RenderVideoOutput> {
  const ffmpegPath = ffmpegStatic || "ffmpeg";
  console.log(`[VideoRenderer] Starting local render | contentPostId=${input.contentPostId} | campaignId=${input.campaignId} | userId=${input.userId} | outputDir=${PUBLIC_VIDEOS_DIR} | ffmpegPath=${ffmpegPath}`);

  ensureDir(PUBLIC_VIDEOS_DIR);

  const baseName = sanitizeFilename(`${input.businessName || "video"}_${input.contentPostId}_${Date.now()}`);
  const outPath = path.join(PUBLIC_VIDEOS_DIR, `${baseName}.mp4`);
  const thumbPath = path.join(PUBLIC_VIDEOS_DIR, `${baseName}.jpg`);

  // Build scene list with sane durations
  const rawScenes = (input.scenes || []).slice(0, 6);
  const scenes: SceneInput[] = rawScenes.map((s) => ({
    ...s,
    durationSeconds: Math.min(Math.max(s.durationSeconds || 5, 3), 8),
  }));

  if (scenes.length === 0) {
    scenes.push({
      sceneNumber: 1,
      durationSeconds: 5,
      visualDescription: input.title || "Video",
      onScreenText: input.title || "",
      voiceoverScript: null,
    });
  }

  // Keep total runtime between 20-30 seconds
  const rawTotal = scenes.reduce((sum, s) => sum + s.durationSeconds, 0);
  const totalDuration = Math.min(Math.max(rawTotal, 20), 30);
  const scaleFactor = totalDuration / rawTotal;
  scenes.forEach((s) => {
    s.durationSeconds = Math.max(3, Math.round(s.durationSeconds * scaleFactor));
  });

  const tempDir = path.join(PUBLIC_VIDEOS_DIR, `.tmp_${baseName}`);
  ensureDir(tempDir);

  const framePaths: string[] = [];
  const frameDurations: number[] = [];

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const frameFile = path.join(tempDir, `frame_${String(i).padStart(3, "0")}.png`);
    const svg = buildFrameSvg(scene, i, scenes.length, input);

    await sharp(Buffer.from(svg))
      .resize(WIDTH, HEIGHT)
      .png()
      .toFile(frameFile);

    framePaths.push(frameFile);
    frameDurations.push(scene.durationSeconds);
  }

  // If an uploaded image exists, insert it as a product/service shot before the final CTA scene
  if (input.uploadedImagePath && fs.existsSync(input.uploadedImagePath)) {
    const imgFrame = path.join(tempDir, `frame_img.png`);
    await sharp(input.uploadedImagePath)
      .resize(WIDTH, HEIGHT, { fit: "cover" })
      .png()
      .toFile(imgFrame);

    const insertIndex = framePaths.length > 1 ? framePaths.length - 1 : framePaths.length;
    framePaths.splice(insertIndex, 0, imgFrame);
    frameDurations.splice(insertIndex, 0, 4);
  }

  // Build ffmpeg concat demuxer input with per-frame durations
  const concatFile = path.join(tempDir, "concat.txt");
  const concatLines: string[] = [];
  for (let i = 0; i < framePaths.length; i++) {
    const safePath = framePaths[i].replace(/\\/g, "/").replace(/'/g, "'\\''");
    concatLines.push(`file '${safePath}'`);
    concatLines.push(`duration ${frameDurations[i]}`);
  }
  // ffmpeg concat demuxer requires the last frame repeated without duration
  const lastSafePath = framePaths[framePaths.length - 1].replace(/\\/g, "/").replace(/'/g, "'\\''");
  concatLines.push(`file '${lastSafePath}'`);
  fs.writeFileSync(concatFile, concatLines.join("\n"), "utf-8");

  // Run ffmpeg
  let ffmpegExitCode: number | null = null;
  let ffmpegStderr = "";
  await new Promise<void>((resolve, reject) => {
    const args = [
      "-y",
      "-f", "concat",
      "-safe", "0",
      "-i", concatFile,
      "-vf", `fps=${FPS},format=yuv420p,scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease,pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2:black`,
      "-c:v", "libx264",
      "-preset", "fast",
      "-crf", "28",
      "-movflags", "+faststart",
      "-pix_fmt", "yuv420p",
      outPath,
    ];
    const proc = spawn(ffmpegPath, args, { stdio: "pipe" });
    proc.stderr.on("data", (d) => { ffmpegStderr += d.toString(); });
    proc.on("close", (code) => {
      ffmpegExitCode = code ?? null;
      if (code === 0) {
        resolve();
      } else {
        console.error(`[VideoRenderer] ffmpeg exited with code ${code} | contentPostId=${input.contentPostId} | stderr="${ffmpegStderr.slice(-500)}"`);
        reject(new Error(classifyRenderError(new Error(`ffmpeg exited ${code}: ${ffmpegStderr.slice(-500)}`), { ffmpegExitCode: code, stderr: ffmpegStderr })));
      }
    });
    proc.on("error", (err) => {
      console.error(`[VideoRenderer] ffmpeg spawn error | contentPostId=${input.contentPostId} | error="${err.message}"`);
      reject(new Error(classifyRenderError(err, { ffmpegExitCode, stderr: ffmpegStderr })));
    });
  });

  // Generate thumbnail from first frame
  let thumbStderr = "";
  await new Promise<void>((resolve, reject) => {
    const args = [
      "-y",
      "-i", outPath,
      "-ss", "00:00:00.500",
      "-vframes", "1",
      "-q:v", "2",
      thumbPath,
    ];
    const proc = spawn(ffmpegPath, args, { stdio: "pipe" });
    proc.stderr.on("data", (d) => { thumbStderr += d.toString(); });
    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        console.error(`[VideoRenderer] ffmpeg thumbnail exited with code ${code} | contentPostId=${input.contentPostId} | stderr="${thumbStderr.slice(-500)}"`);
        reject(new Error(`Render failed: thumbnail generation failed (ffmpeg exited ${code})`));
      }
    });
    proc.on("error", (err) => {
      console.error(`[VideoRenderer] ffmpeg thumbnail spawn error | contentPostId=${input.contentPostId} | error="${err.message}"`);
      reject(new Error(`Render failed: thumbnail generation failed — ${err.message}`));
    });
  });

  // Cleanup temp files
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }

  // Determine public URL base
  const baseUrl = env.isProduction ? "" : `http://localhost:3000`;
  const videoUrl = `${baseUrl}/videos/${path.basename(outPath)}`;
  const thumbnailUrl = `${baseUrl}/videos/${path.basename(thumbPath)}`;

  const actualDuration = frameDurations.reduce((sum, d) => sum + d, 0);
  console.log(`[VideoRenderer] Render completed successfully | contentPostId=${input.contentPostId} | campaignId=${input.campaignId} | videoUrl=${videoUrl} | thumbnailUrl=${thumbnailUrl} | duration=${actualDuration}s`);

  return {
    videoUrl,
    thumbnailUrl,
    durationSeconds: actualDuration,
    aspectRatio: "9:16",
  };
}
