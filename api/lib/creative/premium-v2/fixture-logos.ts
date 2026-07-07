/**
 * Fixture logo file helper.
 *
 * Generates small deterministic placeholder PNGs on disk so that the brand-asset
 * resolver can resolve real local files for tests and samples without relying on
 * remote placeholder URLs. The real 3@1 Newmarket logo is used when present.
 */

import { mkdirSync, existsSync } from "fs";
import path from "path";
import sharp from "sharp";

const FIXTURE_LOGO_DIR = path.resolve(process.cwd(), "data", "public", "uploads", "fixtures");

export const REAL_3AT1_LOGO_PATH = "/uploads/logo/14/logo_a245d374-0a3d-494f-8f0f-d7e4f3f06fe3.png";

const FIXTURE_LOGO_SPECS: Record<string, { bg: string; fg: string; text: string }> = {
  "3at1": { bg: "#0047AB", fg: "#FFD700", text: "3@1" },
  restaurant: { bg: "#B91C1C", fg: "#FFFFFF", text: "BB" },
  beauty: { bg: "#831843", fg: "#FFFFFF", text: "Glow" },
  cleaning: { bg: "#0F766E", fg: "#FFFFFF", text: "SC" },
  plumber: { bg: "#1E3A8A", fg: "#FFFFFF", text: "LF" },
  retail: { bg: "#4338CA", fg: "#FFFFFF", text: "TB" },
  professional: { bg: "#1E3A8A", fg: "#FFFFFF", text: "SF" },
  training: { bg: "#065F46", fg: "#FFFFFF", text: "SU" },
};

function localPathFromPublic(publicPath: string): string | null {
  if (!publicPath.startsWith("/")) return null;
  const relative = publicPath.slice(1);
  const candidates = [
    path.resolve(process.cwd(), "public", relative),
    path.resolve(process.cwd(), "dist/public", relative),
    path.resolve(process.cwd(), "data/public/uploads", relative),
    path.resolve(process.cwd(), "data/public", relative),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

export function real3At1LogoExists(): boolean {
  return !!localPathFromPublic(REAL_3AT1_LOGO_PATH);
}

export function resolveFixtureLogoPath(fixtureName: string): string {
  if (fixtureName === "3at1" && real3At1LogoExists()) {
    return REAL_3AT1_LOGO_PATH;
  }
  return `/uploads/fixtures/${fixtureName}-logo.png`;
}

export async function ensureFixtureLogos(): Promise<Record<string, string>> {
  mkdirSync(FIXTURE_LOGO_DIR, { recursive: true });
  const result: Record<string, string> = {};

  for (const [name, spec] of Object.entries(FIXTURE_LOGO_SPECS)) {
    if (name === "3at1" && real3At1LogoExists()) {
      result[name] = REAL_3AT1_LOGO_PATH;
      continue;
    }

    const fileName = `${name}-logo.png`;
    const filePath = path.join(FIXTURE_LOGO_DIR, fileName);

    if (!existsSync(filePath)) {
      const svg = `
        <svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">
          <rect width="200" height="200" fill="${spec.bg}" rx="24"/>
          <text x="50%" y="55%" font-family="Arial, Helvetica, sans-serif" font-size="72" font-weight="900" fill="${spec.fg}" text-anchor="middle" dominant-baseline="middle">${spec.text}</text>
        </svg>
      `;
      await sharp(Buffer.from(svg, "utf-8")).png().toFile(filePath);
    }

    result[name] = `/uploads/fixtures/${fileName}`;
  }

  return result;
}
