/**
 * Brand Asset Resolver
 *
 * Central, deterministic source of truth for brand assets used by every
 * premium leaflet path (deterministic V2, hybrid, future AI image/video
 * campaigns, and refinement/regeneration flows).
 *
 * Rules:
 * - A real logo is expected if any logo source exists on the business/campaign.
 * - A fallback badge is allowed only when no real logo source exists.
 * - If a real logo source exists but cannot be resolved, the result is a
 *   brand-asset failure, not a silent fallback.
 * - All decisions are captured in metadata so callers can enforce the hard
 *   brand-asset quality gate.
 */

import { existsSync } from "fs";
import path from "path";
import { env } from "../env";

export type LogoSourceType =
  | "uploaded"
  | "asset"
  | "campaign_asset"
  | "website"
  | "social"
  | "fallback";

export interface BrandAssetResolution {
  businessId?: number | string;
  campaignId?: number | string;
  logoSourceType: LogoSourceType;
  logoSourcePath: string | null;
  logoSourceUrl: string | null;
  logoResolved: boolean;
  logoRenderMode: "image" | "fallback_badge";
  realLogoExpected: boolean;
  realLogoRendered: boolean;
  fallbackReason: string | null;
  brandAssetWarnings: string[];
  logoBuffer?: Buffer;
}

interface LogoCandidate {
  type: LogoSourceType;
  value: string;
}

const LOGO_FETCH_TIMEOUT_MS = 8000;

export function isBrandAssetFailure(resolution: BrandAssetResolution): boolean {
  return resolution.realLogoExpected && !resolution.realLogoRendered;
}

function asString(value: unknown): string {
  if (typeof value === "string") return value.trim();
  return "";
}

function candidatesFor(business: any, campaign?: any): LogoCandidate[] {
  const list: LogoCandidate[] = [];

  const uploaded = asString(business?.logo);
  if (uploaded) list.push({ type: "uploaded", value: uploaded });

  const assetUrl = asString(business?.logoAssetUrl ?? business?.logoAssetPath);
  if (assetUrl) list.push({ type: "asset", value: assetUrl });

  // Campaign-approved logo asset. In the current schema the campaign table has no
  // dedicated logo column, so we also look for an image asset reference when present.
  const campaignLogo = asString(campaign?.logoUrl ?? campaign?.approvedLogoUrl ?? campaign?.approvedLogoAssetUrl);
  if (campaignLogo) list.push({ type: "campaign_asset", value: campaignLogo });

  const website = asString(business?.website);
  if (website && /^https?:\/\//i.test(website)) {
    try {
      const url = new URL(website);
      list.push({ type: "website", value: `${url.origin}/favicon.ico` });
    } catch {
      // ignore malformed URL
    }
  }

  const social = asString(business?.facebookUrl ?? business?.instagramUrl ?? business?.linkedinUrl);
  if (social && /^https?:\/\//i.test(social)) {
    list.push({ type: "social", value: social });
  }

  return list;
}

export function resolveAbsoluteLogoUrl(logoPath: string): string {
  if (/^https?:\/\//i.test(logoPath)) return logoPath;
  if (logoPath.startsWith("/")) {
    const base = env.publicAppUrl || `http://localhost:${process.env.PORT || "3001"}`;
    return `${base.replace(/\/$/, "")}${logoPath}`;
  }
  return logoPath;
}

function resolveLocalPath(logoPath: string): string | null {
  if (/^https?:\/\//i.test(logoPath)) return null;
  if (logoPath.startsWith("/")) {
    const relative = logoPath.slice(1);
    const candidates = [
      path.resolve(process.cwd(), "public", relative),
      path.resolve(process.cwd(), "dist/public", relative),
      path.resolve(process.cwd(), "data/public/uploads", relative),
      path.resolve(process.cwd(), "data/public", relative),
    ];
    for (const p of candidates) {
      if (existsSync(p)) return p;
    }
  }
  if (existsSync(logoPath)) return logoPath;
  return null;
}

async function validateRemoteLogo(url: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LOGO_FETCH_TIMEOUT_MS);
    const response = await fetch(url, { method: "HEAD", signal: controller.signal });
    clearTimeout(timeout);
    if (!response.ok) return false;
    // Reject remote candidates that are clearly HTML pages (e.g. social profiles).
    const contentType = response.headers.get("content-type") || "";
    if (contentType && !contentType.startsWith("image/")) return false;
    return true;
  } catch {
    return false;
  }
}

async function fetchRemoteLogo(url: string): Promise<Buffer | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LOGO_FETCH_TIMEOUT_MS);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!response.ok) return null;
    return Buffer.from(await response.arrayBuffer());
  } catch {
    return null;
  }
}

function isExplicitLogoCandidate(type: LogoSourceType): boolean {
  return type === "uploaded" || type === "asset" || type === "campaign_asset";
}

export async function resolveBrandAssets(
  business: any,
  campaign?: any,
  options?: { fetchBuffer?: boolean }
): Promise<BrandAssetResolution> {
  const businessId = business?.id;
  const campaignId = campaign?.id;
  const candidates = candidatesFor(business, campaign);

  // A real logo is "expected" only when the business/campaign has explicitly
  // provided one (uploaded, asset, or campaign asset). Website/social candidates
  // are speculative: if they resolve we treat them as real logos; if they fail
  // we fall back without raising a brand-asset failure.
  const explicitCandidates = candidates.filter((c) => isExplicitLogoCandidate(c.type));
  let realLogoExpected = explicitCandidates.length > 0;

  if (candidates.length === 0) {
    return {
      businessId,
      campaignId,
      logoSourceType: "fallback",
      logoSourcePath: null,
      logoSourceUrl: null,
      logoResolved: false,
      logoRenderMode: "fallback_badge",
      realLogoExpected: false,
      realLogoRendered: false,
      fallbackReason: "No logo source found on business or campaign",
      brandAssetWarnings: ["Using fallback monogram because no brand logo exists."],
    };
  }

  for (const candidate of candidates) {
    const absoluteUrl = resolveAbsoluteLogoUrl(candidate.value);
    const localPath = resolveLocalPath(candidate.value);

    if (localPath) {
      try {
        const buffer = await import("fs/promises").then((fs) => fs.readFile(localPath));
        return {
          businessId,
          campaignId,
          logoSourceType: candidate.type,
          logoSourcePath: candidate.value,
          logoSourceUrl: absoluteUrl,
          logoResolved: true,
          logoRenderMode: "image",
          realLogoExpected: true,
          realLogoRendered: true,
          fallbackReason: null,
          brandAssetWarnings: [],
          logoBuffer: options?.fetchBuffer ? buffer : undefined,
        };
      } catch {
        // continue to next candidate
      }
    }

    const isReachable = await validateRemoteLogo(absoluteUrl);
    if (isReachable) {
      const buffer = options?.fetchBuffer ? await fetchRemoteLogo(absoluteUrl) : undefined;
      return {
        businessId,
        campaignId,
        logoSourceType: candidate.type,
        logoSourcePath: candidate.value,
        logoSourceUrl: absoluteUrl,
        logoResolved: true,
        logoRenderMode: "image",
        realLogoExpected: true,
        realLogoRendered: true,
        fallbackReason: null,
        brandAssetWarnings: [],
        logoBuffer: buffer ?? undefined,
      };
    }
  }

  // None of the candidates resolved.
  const attempted = candidates.map((c) => `${c.type}:${c.value}`).join(", ");
  const primaryCandidate = explicitCandidates[0] ?? candidates[0];
  const fallbackReason = realLogoExpected
    ? `Logo source(s) found but none could be resolved: ${attempted}`
    : `No verified logo source found; attempted: ${attempted}`;

  // If no explicit logo was provided and we could not verify a website/social
  // logo, report the source as fallback so callers can clearly see that no
  // real logo source exists.
  const noVerifiedSource = !realLogoExpected;

  return {
    businessId,
    campaignId,
    logoSourceType: noVerifiedSource ? "fallback" : primaryCandidate.type,
    logoSourcePath: noVerifiedSource ? null : primaryCandidate.value,
    logoSourceUrl: noVerifiedSource ? null : resolveAbsoluteLogoUrl(primaryCandidate.value),
    logoResolved: false,
    logoRenderMode: "fallback_badge",
    realLogoExpected,
    realLogoRendered: false,
    fallbackReason,
    brandAssetWarnings: realLogoExpected
      ? ["Real logo expected but could not be loaded; fallback badge is a placeholder."]
      : ["Using fallback monogram because no verified brand logo exists."],
  };
}

export function applyBrandAssetGate(
  resolution: BrandAssetResolution
): { passed: boolean; label: string; criticalIssues: string[]; warnings: string[] } {
  if (resolution.realLogoExpected && !resolution.realLogoRendered) {
    return {
      passed: false,
      label: "Brand Asset Review Required",
      criticalIssues: ["Real Logo Missing"],
      warnings: resolution.brandAssetWarnings,
    };
  }
  return { passed: true, label: "Brand Assets OK", criticalIssues: [], warnings: resolution.brandAssetWarnings };
}
