/**
 * Helpers for writing hybrid sample outputs and generation logs.
 */

import { writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import type { HybridPipelineResult, HybridFinalDecision } from "../../api/lib/creative/premium-v2/pipeline-types";
import type { BrandAssetResolution } from "../../api/lib/creative/brand-asset-resolver";

export function decisionLabel(finalDecision: HybridFinalDecision): string {
  switch (finalDecision) {
    case "premium_ready":
      return "Hybrid Premium Ready";
    case "hybrid_review_required":
      return "Vision Critic Unavailable - Needs Review";
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

export interface HybridLogEntry {
  fixture: string;
  label: string;
  passed: boolean;
  metadata: HybridPipelineResult["metadata"];
  critic: HybridPipelineResult["critic"];
  attemptPaths: string[];
  finalPath: string;
  brandAsset: BrandAssetDiagnostics;
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

export function printBrandAssetDiagnostics(diagnostics: BrandAssetDiagnostics): void {
  console.log("  Brand asset diagnostics:");
  console.log(`    resolvedLogoPath: ${diagnostics.resolvedLogoPath}`);
  console.log(`    resolvedLogoUrl:  ${diagnostics.resolvedLogoUrl}`);
  console.log(`    logoSourceType:   ${diagnostics.logoSourceType}`);
  console.log(`    logoRenderMode:   ${diagnostics.logoRenderMode}`);
  console.log(`    imageLoaded:      ${diagnostics.imageLoaded}`);
  console.log(`    fallbackUsed:     ${diagnostics.fallbackUsed}`);
  console.log(`    fallbackAllowed:  ${diagnostics.fallbackAllowed}`);
  console.log(`    logoCausedDowngrade: ${diagnostics.logoCausedDowngrade}`);
}
