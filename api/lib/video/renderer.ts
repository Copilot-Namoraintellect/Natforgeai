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
    fs.mkdirSync(dir, { recursive: true });
  }
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-z0-9_-]/gi, "_").toLowerCase();
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

export async function renderLocalMp4(input: RenderVideoInput): Promise<RenderVideoOutput> {
  ensureDir(PUBLIC_VIDEOS_DIR);

  const baseName = sanitizeFilename(`${input.businessName || "video"}_${input.contentPostId}_${Date.now()}`);
  const outPath = path.join(PUBLIC_VIDEOS_DIR, `${baseName}.mp4`);
  const thumbPath = path.join(PUBLIC_VIDEOS_DIR, `${baseName}.jpg`);

  // Build scene durations (default 5s each, cap total at 30s)
  const sceneList = (input.scenes || []).slice(0, 6);
  const scenes = sceneList.map((s) => ({
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

  // Ensure total duration 20-30s
  const totalDuration = Math.min(Math.max(scenes.reduce((sum, s) => sum + s.durationSeconds, 0), 20), 30);
  const scaleFactor = totalDuration / scenes.reduce((sum, s) => sum + s.durationSeconds, 0);
  scenes.forEach((s) => {
    s.durationSeconds = Math.max(3, Math.round(s.durationSeconds * scaleFactor));
  });

  const width = 1080;
  const height = 1920;
  const fps = 30;

  // Generate frame images for each scene using sharp
  const tempDir = path.join(PUBLIC_VIDEOS_DIR, `.tmp_${baseName}`);
  ensureDir(tempDir);

  const bgColors = ["#0f172a", "#1e1b4b", "#312e81", "#1e293b", "#0c4a6e", "#312e81"];
  const textColors = ["#ffffff", "#fbbf24", "#a5b4fc", "#bae6fd", "#fde68a", "#c4b5fd"];

  const framePaths: string[] = [];

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const bg = bgColors[i % bgColors.length];
    const tc = textColors[i % textColors.length];
    const frameFile = path.join(tempDir, `frame_${String(i).padStart(3, "0")}.png`);

    const lines: string[] = [];
    if (scene.onScreenText) lines.push(scene.onScreenText);
    else lines.push(scene.visualDescription);

    // Build SVG overlay
    const svgWidth = width;
    const svgHeight = height;

    // Wrap text roughly
    function wrapText(text: string, maxChars: number): string[] {
      const words = text.split(/\s+/);
      const out: string[] = [];
      let line = "";
      for (const w of words) {
        if ((line + w).length > maxChars && line.length > 0) {
          out.push(line.trim());
          line = w + " ";
        } else {
          line += w + " ";
        }
      }
      if (line.trim()) out.push(line.trim());
      return out.length ? out : [text];
    }

    const wrappedLines = lines.flatMap((l) => wrapText(l, 28));
    const lineHeight = 72;
    const startY = svgHeight / 2 - (wrappedLines.length * lineHeight) / 2;

    let textSvg = "";
    wrappedLines.forEach((wl, idx) => {
      textSvg += `<text x="${svgWidth / 2}" y="${startY + idx * lineHeight}" font-family="Arial, sans-serif" font-size="64" font-weight="bold" fill="${tc}" text-anchor="middle">${wl.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</text>`;
    });

    // Add scene counter at top
    textSvg += `<text x="${svgWidth / 2}" y="120" font-family="Arial, sans-serif" font-size="36" fill="#94a3b8" text-anchor="middle">Scene ${i + 1} / ${scenes.length}</text>`;

    // Add business name at bottom if available
    if (input.businessName) {
      textSvg += `<text x="${svgWidth / 2}" y="${svgHeight - 120}" font-family="Arial, sans-serif" font-size="40" fill="#cbd5e1" text-anchor="middle">${input.businessName.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</text>`;
    }

    // Add CTA on last scene
    if (i === scenes.length - 1 && input.cta) {
      textSvg += `<rect x="${svgWidth / 2 - 300}" y="${svgHeight - 280}" width="600" height="90" rx="16" fill="#00D4FF" opacity="0.9" />`;
      textSvg += `<text x="${svgWidth / 2}" y="${svgHeight - 225}" font-family="Arial, sans-serif" font-size="40" font-weight="bold" fill="#0f172a" text-anchor="middle">${input.cta.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</text>`;
    }

    const svg = `
      <svg width="${svgWidth}" height="${svgHeight}" xmlns="http://www.w3.org/2000/svg">
        <rect width="100%" height="100%" fill="${bg}" />
        ${textSvg}
      </svg>
    `;

    await sharp(Buffer.from(svg))
      .resize(width, height)
      .png()
      .toFile(frameFile);

    framePaths.push(frameFile);
  }

  // If uploaded image exists, add it as an extra scene before CTA
  if (input.uploadedImagePath && fs.existsSync(input.uploadedImagePath)) {
    const imgFrame = path.join(tempDir, `frame_img.png`);
    await sharp(input.uploadedImagePath)
      .resize(width, height, { fit: "cover" })
      .png()
      .toFile(imgFrame);
    // Insert before last frame if last is CTA, else append
    if (framePaths.length > 1) {
      framePaths.splice(framePaths.length - 1, 0, imgFrame);
    } else {
      framePaths.push(imgFrame);
    }
  }

  // Build ffmpeg concat demuxer input
  const concatFile = path.join(tempDir, "concat.txt");
  const concatLines: string[] = [];
  for (const fp of framePaths) {
    const duration = scenes.length > 0 ? Math.max(3, Math.round(totalDuration / framePaths.length)) : 5;
    // Use forward slashes for ffmpeg cross-platform compatibility
    const safePath = fp.replace(/\\/g, "/").replace(/'/g, "'\\''");
    concatLines.push(`file '${safePath}'`);
    concatLines.push(`duration ${duration}`);
  }
  // ffmpeg concat demuxer requires last frame repeated without duration
  const lastSafePath = framePaths[framePaths.length - 1].replace(/\\/g, "/").replace(/'/g, "'\\''");
  concatLines.push(`file '${lastSafePath}'`);
  fs.writeFileSync(concatFile, concatLines.join("\n"), "utf-8");

  const ffmpegPath = ffmpegStatic || "ffmpeg";

  // Run ffmpeg
  await new Promise<void>((resolve, reject) => {
    const args = [
      "-y",
      "-f", "concat",
      "-safe", "0",
      "-i", concatFile,
      "-vf", `fps=${fps},format=yuv420p,scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black`,
      "-c:v", "libx264",
      "-preset", "fast",
      "-crf", "28",
      "-movflags", "+faststart",
      "-pix_fmt", "yuv420p",
      outPath,
    ];
    const proc = spawn(ffmpegPath, args, { stdio: "pipe" });
    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`));
    });
    proc.on("error", (err) => reject(err));
  });

  // Generate thumbnail from first frame
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
    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg thumbnail exited ${code}: ${stderr.slice(-500)}`));
    });
    proc.on("error", (err) => reject(err));
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

  return {
    videoUrl,
    thumbnailUrl,
    durationSeconds: totalDuration,
    aspectRatio: "9:16",
  };
}
