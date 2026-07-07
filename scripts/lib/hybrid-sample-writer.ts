/**
 * Helpers for writing hybrid sample outputs and generation logs.
 */

import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import type { HybridPipelineResult, HybridFinalDecision } from "../../api/lib/creative/premium-v2/pipeline-types";

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

export interface HybridLogEntry {
  fixture: string;
  label: string;
  passed: boolean;
  metadata: HybridPipelineResult["metadata"];
  critic: HybridPipelineResult["critic"];
  attemptPaths: string[];
  finalPath: string;
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
  };
}

export function saveHybridAttemptImages(
  outputDir: string,
  fixtureName: string,
  hybridResult: HybridPipelineResult
): string[] {
  if (!hybridResult.attempts || hybridResult.attempts.length === 0) return [];

  const safeName = fixtureName.replace(/[^a-z0-9_-]/gi, "-");
  const paths: string[] = [];
  hybridResult.attempts.forEach((attempt, index) => {
    const path = join(outputDir, `${safeName}-hybrid-attempt-${index}.png`);
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
