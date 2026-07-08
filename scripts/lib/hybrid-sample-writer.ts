/**
 * Helpers for writing hybrid sample outputs and generation logs.
 */

import { writeFileSync, mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import sharp from "sharp";
import type { HybridPipelineResult, HybridFinalDecision } from "../../api/lib/creative/premium-v2/pipeline-types";
import type { BrandAssetResolution } from "../../api/lib/creative/brand-asset-resolver";

export function decisionLabel(finalDecision: HybridFinalDecision): string {
  switch (finalDecision) {
    case "premium_ready":
      return "Hybrid Premium Ready";
    case "hybrid_review_required":
      return "Vision Critic Unavailable - Needs Review";
    case "content_review_required":
      return "Content Review Required";
    case "fallback_used":
      return "Fallback Used - Needs Review";
    case "failed":
      return "Failed";
    default:
      return "Needs Review";
  }
}

export interface BrandAssetDiagnostics {
  resolvedLogoPath: string | null;
  resolvedLogoUrl: string | null;
  logoSourceType: string | null;
  logoRenderMode: string | null;
  imageLoaded: boolean;
  fallbackUsed: boolean;
  fallbackAllowed: boolean;
  logoCausedDowngrade: boolean;
}

export interface RenderDiagnostics {
  realLogoExpected?: boolean;
  realLogoRendered?: boolean;
  logoNaturalWidth?: number;
  logoNaturalHeight?: number;
  logoRenderedWidth?: number;
  logoRenderedHeight?: number;
  logoVisibleArea?: number;
  logoRenderMode?: string;
  fallbackBadgeRendered?: boolean;
  logoMaskedOrCropped?: boolean;
  logoDataUriUsed?: boolean;
  logoFetchUsed?: boolean;
  structuralBrandFidelityPassed?: boolean;
  visionBrandFidelityPassed?: boolean;
  criticConflict?: boolean;
  criticConflictReason?: string | null;
  offerExpected?: boolean;
  offerSource?: string | null;
  offerRendered?: boolean;
  inventedOfferDetected?: boolean;
  contentFidelityPassed?: boolean;
}

export interface HybridLogEntry {
  fixture: string;
  label: string;
  passed: boolean;
  metadata: HybridPipelineResult["metadata"];
  critic: HybridPipelineResult["critic"];
  attemptPaths: string[];
  finalPath: string;
  brandAsset: BrandAssetDiagnostics;
  renderDiagnostics: RenderDiagnostics;
  attemptDiagnostics: RenderDiagnostics[];
}

export interface DeterministicLogEntry {
  fixture: string;
  label: string;
  passed: boolean;
  score: number;
  brandAsset: BrandAssetDiagnostics;
}

export function buildBrandAssetDiagnostics(brandAsset?: BrandAssetResolution): BrandAssetDiagnostics {
  const fallbackUsed = brandAsset?.logoRenderMode === "fallback_badge";
  const fallbackAllowed = fallbackUsed && !brandAsset?.realLogoExpected;
  const logoCausedDowngrade = !!brandAsset && brandAsset.realLogoExpected && !brandAsset.realLogoRendered;
  return {
    resolvedLogoPath: brandAsset?.logoSourcePath ?? null,
    resolvedLogoUrl: brandAsset?.logoSourceUrl ?? null,
    logoSourceType: brandAsset?.logoSourceType ?? null,
    logoRenderMode: brandAsset?.logoRenderMode ?? null,
    imageLoaded: brandAsset?.logoResolved ?? false,
    fallbackUsed,
    fallbackAllowed,
    logoCausedDowngrade,
  };
}

export function buildHybridLogEntry(
  fixtureName: string,
  hybridResult: HybridPipelineResult,
  attemptPaths: string[],
  finalPath: string
): HybridLogEntry {
  return {
    fixture: fixtureName,
    label: decisionLabel(hybridResult.metadata.finalDecision),
    passed:
      hybridResult.metadata.finalDecision === "premium_ready" &&
      !hybridResult.metadata.usedDeterministicFallback,
    metadata: hybridResult.metadata,
    critic: hybridResult.critic,
    attemptPaths,
    finalPath,
    brandAsset: buildBrandAssetDiagnostics(hybridResult.brandKit.brandAsset),
    renderDiagnostics: buildRenderDiagnostics(hybridResult.metadata),
    attemptDiagnostics: (hybridResult.attempts || []).map((attempt) => buildRenderDiagnostics(attempt.metrics)),
  };
}

export function saveHybridAttemptImages(
  outputDir: string,
  fixtureName: string,
  hybridResult: HybridPipelineResult
): string[] {
  if (!hybridResult.attempts || hybridResult.attempts.length === 0) return [];

  mkdirSync(outputDir, { recursive: true });
  const safeName = fixtureName.replace(/[^a-z0-9_-]/gi, "-");
  const paths: string[] = [];
  hybridResult.attempts.forEach((attempt, index) => {
    const path = join(outputDir, `${safeName}-hybrid-attempt-${index}.png`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, attempt.buffer);
    paths.push(path);
  });
  return paths;
}

export async function saveHybridLogoArtifacts(
  outputDir: string,
  fixtureName: string,
  hybridResult: HybridPipelineResult
): Promise<{ expectedLogoPath?: string; logoCropPath?: string }> {
  mkdirSync(outputDir, { recursive: true });
  const safeName = fixtureName.replace(/[^a-z0-9_-]/gi, "-");
  const result: { expectedLogoPath?: string; logoCropPath?: string } = {};

  const logoBuffer = hybridResult.brandKit.brandAsset?.logoBuffer;
  if (logoBuffer) {
    const expectedLogoPath = join(outputDir, `${safeName}-expected-logo.png`);
    writeFileSync(expectedLogoPath, logoBuffer);
    result.expectedLogoPath = expectedLogoPath;
  }

  // Crop the full header/logo region from the final rendered leaflet for visual inspection.
  // The header spans the full width and top 170px, containing the logo panel and business name.
  const finalBuffer = hybridResult.buffer;
  try {
    const logoCropPath = join(outputDir, `${safeName}-logo-region-crop.png`);
    await sharp(finalBuffer)
      .extract({ left: 0, top: 0, width: 1080, height: 170 })
      .toFile(logoCropPath);
    result.logoCropPath = logoCropPath;
  } catch (err: any) {
    console.warn(`[HybridSampleWriter] Could not crop logo region: ${err.message}`);
  }

  return result;
}

export function writeHybridGenerationLog(outputDir: string, entries: HybridLogEntry[]): string {
  mkdirSync(outputDir, { recursive: true });
  const logPath = join(outputDir, "generation-log.txt");
  writeFileSync(logPath, JSON.stringify(entries, null, 2));
  return logPath;
}

export function writeDeterministicGenerationLog(outputDir: string, entries: DeterministicLogEntry[]): string {
  mkdirSync(outputDir, { recursive: true });
  const logPath = join(outputDir, "generation-log.txt");
  writeFileSync(logPath, JSON.stringify(entries, null, 2));
  return logPath;
}

export function readHybridGenerationLog(outputDir: string): HybridLogEntry[] {
  const logPath = join(outputDir, "generation-log.txt");
  const content = readFileSync(logPath, "utf-8");
  return JSON.parse(content) as HybridLogEntry[];
}

export function buildRenderDiagnostics(metadata?: HybridPipelineResult["metadata"]): RenderDiagnostics {
  if (!metadata) return {};
  return {
    realLogoExpected: metadata.realLogoExpected,
    realLogoRendered: metadata.realLogoRendered,
    logoNaturalWidth: metadata.logoNaturalWidth,
    logoNaturalHeight: metadata.logoNaturalHeight,
    logoRenderedWidth: metadata.logoRenderedWidth,
    logoRenderedHeight: metadata.logoRenderedHeight,
    logoVisibleArea: metadata.logoVisibleArea,
    logoRenderMode: metadata.logoRenderMode,
    fallbackBadgeRendered: metadata.fallbackBadgeRendered,
    logoMaskedOrCropped: metadata.logoMaskedOrCropped,
    logoDataUriUsed: metadata.logoDataUriUsed,
    logoFetchUsed: metadata.logoFetchUsed,
    structuralBrandFidelityPassed: metadata.structuralBrandFidelityPassed,
    visionBrandFidelityPassed: metadata.visionBrandFidelityPassed,
    criticConflict: metadata.criticConflict,
    criticConflictReason: metadata.criticConflictReason,
    offerExpected: metadata.offerExpected,
    offerSource: metadata.offerSource,
    offerRendered: metadata.offerRendered,
    inventedOfferDetected: metadata.inventedOfferDetected,
    contentFidelityPassed: metadata.contentFidelityPassed,
  };
}

export function printBrandAssetDiagnostics(diagnostics: BrandAssetDiagnostics, renderDiagnostics?: RenderDiagnostics): void {
  console.log("  Brand asset diagnostics:");
  console.log(`    resolvedLogoPath: ${diagnostics.resolvedLogoPath}`);
  console.log(`    resolvedLogoUrl:  ${diagnostics.resolvedLogoUrl}`);
  console.log(`    logoSourceType:   ${diagnostics.logoSourceType}`);
  console.log(`    logoRenderMode:   ${diagnostics.logoRenderMode}`);
  console.log(`    imageLoaded:      ${diagnostics.imageLoaded}`);
  console.log(`    fallbackUsed:     ${diagnostics.fallbackUsed}`);
  console.log(`    fallbackAllowed:  ${diagnostics.fallbackAllowed}`);
  console.log(`    logoCausedDowngrade: ${diagnostics.logoCausedDowngrade}`);

  if (renderDiagnostics) {
    console.log("  Render diagnostics:");
    console.log(`    realLogoExpected:     ${renderDiagnostics.realLogoExpected ?? "n/a"}`);
    console.log(`    realLogoRendered:     ${renderDiagnostics.realLogoRendered ?? "n/a"}`);
    console.log(`    logoNaturalWidth:     ${renderDiagnostics.logoNaturalWidth ?? "n/a"}`);
    console.log(`    logoNaturalHeight:    ${renderDiagnostics.logoNaturalHeight ?? "n/a"}`);
    console.log(`    logoRenderedWidth:    ${renderDiagnostics.logoRenderedWidth ?? "n/a"}`);
    console.log(`    logoRenderedHeight:   ${renderDiagnostics.logoRenderedHeight ?? "n/a"}`);
    console.log(`    logoVisibleArea:      ${renderDiagnostics.logoVisibleArea ?? "n/a"}`);
    console.log(`    logoRenderMode:       ${renderDiagnostics.logoRenderMode ?? "n/a"}`);
    console.log(`    fallbackBadgeRendered:${renderDiagnostics.fallbackBadgeRendered ?? "n/a"}`);
    console.log(`    logoMaskedOrCropped:  ${renderDiagnostics.logoMaskedOrCropped ?? "n/a"}`);
    console.log(`    logoDataUriUsed:      ${renderDiagnostics.logoDataUriUsed ?? "n/a"}`);
    console.log(`    logoFetchUsed:        ${renderDiagnostics.logoFetchUsed ?? "n/a"}`);
    console.log(`    structuralBrandFidelityPassed: ${renderDiagnostics.structuralBrandFidelityPassed ?? "n/a"}`);
    console.log(`    visionBrandFidelityPassed:     ${renderDiagnostics.visionBrandFidelityPassed ?? "n/a"}`);
    console.log(`    criticConflict:       ${renderDiagnostics.criticConflict ?? "n/a"}`);
    console.log(`    offerExpected:        ${renderDiagnostics.offerExpected ?? "n/a"}`);
    console.log(`    offerSource:          ${renderDiagnostics.offerSource ?? "n/a"}`);
    console.log(`    offerRendered:        ${renderDiagnostics.offerRendered ?? "n/a"}`);
    console.log(`    inventedOfferDetected:${renderDiagnostics.inventedOfferDetected ?? "n/a"}`);
    console.log(`    contentFidelityPassed:${renderDiagnostics.contentFidelityPassed ?? "n/a"}`);
  }
}
