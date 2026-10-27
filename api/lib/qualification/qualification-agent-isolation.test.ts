// ─── R6-C — Runtime Agent Isolation Evidence (blocker 3) ───
//
// Executable proof that NatForgeAI runtime AI/model components cannot
// influence the qualification authority, complementing the API-level
// adversarial suites with structural dependency evidence:
//
//   1. FORWARD — no qualification module file (decision path, seams, store,
//      service, bridge, router) imports a model/agent SDK, shell/process
//      execution, filesystem access, or network fetch. The deterministic
//      engine is pure arithmetic over validated evidence.
//   2. AUTHORITY BOUNDARY — the human-review gateway's only out-of-module
//      dependency is the governed OTP primitive (api/lib/auth/otp); it never
//      touches a model, and model-facing components never import it.
//   3. REVERSE — no model/agent-facing module (api/lib/agents/**,
//      agent-router, engagement, intelligence, creative, social-listening,
//      learning) imports any qualification module: a compromised in-process
//      agent component has no code path to qualification server functions.
//   4. CLOSED SURFACE — the qualification router exposes exactly the eight
//      governed procedures; no force-state, policy-mutation, tool or agent
//      endpoint exists.
//   5. AUTONOMY SEPARATION — the evaluation path never consults the human
//      challenge gateway (autonomous qualification neither needs nor accepts
//      human-proof injection).
//
// If any of these structural properties regress, this file fails — the
// isolation claim is re-verified on every full-suite run, not just at review.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join, resolve } from "path";
import { qualificationRouter } from "../../qualification-router";

const API_ROOT = resolve(__dirname, "../..");
const QUALIFICATION_DIR = resolve(API_ROOT, "lib/qualification");

/** Model/agent/shell/network dependency deny-list for module sources. */
const FORBIDDEN_MODULE_IMPORT =
  /@ai-sdk|from\s+["']openai|from\s+["']anthropic|child_process|node:child_process|node:fs|from\s+["']fs["']|lib\/agents|agent-router|nodemailer|new\s+OpenAI|\bfetch\s*\(/;

/** Import paths that are governed server infrastructure, explicitly allowed. */
const ALLOWED_AUTHORITY_IMPORTS =
  /^\.\.\/auth\/otp$|^\.\.\/\.\.\/queries\/connection$|^@db\/schema$|@trpc\/server$|^drizzle-orm$/;

function listTsFiles(dir: string, accumulator: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      listTsFiles(full, accumulator);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      accumulator.push(full);
    }
  }
  return accumulator;
}

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [/import\s+(?:type\s+)?(?:[\s\S]*?)\s+from\s+["']([^"']+)["']/g, /import\s*\(\s*["']([^"']+)["']\s*\)/g];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      specifiers.push(match[1]);
    }
  }
  return specifiers;
}

describe("runtime agent isolation — forward dependency boundary", () => {
  const moduleFiles = listTsFiles(QUALIFICATION_DIR).concat([
    resolve(API_ROOT, "qualification-router.ts"),
  ]);

  it("qualification decision modules carry no model/agent/shell/fs/fetch dependency", () => {
    expect(moduleFiles.length).toBeGreaterThanOrEqual(13);
    for (const file of moduleFiles) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(FORBIDDEN_MODULE_IMPORT);
    }
  });

  it("the human-review authority gateway only depends on governed OTP/auth infra", () => {
    const gatewayPath = join(QUALIFICATION_DIR, "qualification-review-authority.ts");
    const specifiers = importSpecifiers(readFileSync(gatewayPath, "utf8"));
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      expect(specifier, gatewayPath).toMatch(ALLOWED_AUTHORITY_IMPORTS);
    }
  });

  it("the deterministic engine path never references the human-proof gateway", () => {
    for (const name of ["qualification-engine.ts", "qualification-evidence.ts", "qualification-policy.ts"]) {
      const source = readFileSync(join(QUALIFICATION_DIR, name), "utf8");
      expect(source, name).not.toMatch(/challengeGateway|review-authority|otp/i);
    }
    const service = readFileSync(join(QUALIFICATION_DIR, "qualification-service.ts"), "utf8");
    const evaluateBody = service.slice(
      service.indexOf("export async function evaluateQualificationForLead"),
      service.indexOf("// ─── Read surfaces ───")
    );
    expect(evaluateBody).not.toMatch(/challengeGateway/);
  });
});

describe("runtime agent isolation — reverse dependency boundary", () => {
  const agentFacingRoots = [
    "lib/agents",
    "lib/engagement",
    "lib/intelligence",
    "lib/creative",
    "lib/social-listening",
    "lib/learning",
  ];
  const agentFacingFiles: string[] = [];
  for (const root of agentFacingRoots) {
    agentFacingFiles.push(...listTsFiles(resolve(API_ROOT, root)));
  }
  agentFacingFiles.push(resolve(API_ROOT, "agent-router.ts"));

  it("no model/agent-facing module imports qualification code", () => {
    expect(agentFacingFiles.length).toBeGreaterThan(10);
    for (const file of agentFacingFiles) {
      const specifiers = importSpecifiers(readFileSync(file, "utf8"));
      for (const specifier of specifiers) {
        expect(specifier, file).not.toMatch(/lib\/qualification|qualification-router/);
      }
    }
  });
});

describe("runtime agent isolation — closed authority surface", () => {
  it("the qualification router exposes exactly the eight governed procedures", () => {
    expect(Object.keys(qualificationRouter._def.procedures).sort()).toEqual([
      "evaluate",
      "get",
      "getHandoffProjection",
      "getPolicy",
      "listHistory",
      "listReviews",
      "requestReviewResolution",
      "resolveReview",
    ]);
  });

  it("no qualification module exports a caller-controlled tool/shell/command path", () => {
    for (const file of listTsFiles(QUALIFICATION_DIR)) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/exec\(|spawn\(|execSync|eval\(|new\s+Function/);
    }
  });
});
