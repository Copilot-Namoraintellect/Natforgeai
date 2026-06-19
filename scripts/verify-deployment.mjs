/**
 * Deployment verification script for NatForgeAI IIS media routing.
 *
 * Run after `npm run build` and/or after deploying to IIS:
 *   node scripts/verify-deployment.mjs
 *
 * The script checks that web.config contains the required rewrite rules and
 * that generated media routes return image/png instead of text/html.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

const requiredRules = [
  { name: "API proxy", pattern: /\^api\/\(\.\*\)/ },
  { name: "Generated media", pattern: /\^generated\/\(\.\*\)/ },
  { name: "Uploaded media", pattern: /\^uploads\/\(\.\*\)/ },
  { name: "React SPA fallback", pattern: /React SPA Fallback/ },
];

function checkWebConfig(filePath) {
  if (!fs.existsSync(filePath)) {
    console.error(`❌ Missing ${filePath}`);
    return false;
  }
  const content = fs.readFileSync(filePath, "utf-8");
  let ok = true;
  for (const rule of requiredRules) {
    if (!rule.pattern.test(content)) {
      console.error(`❌ ${filePath} missing rule: ${rule.name}`);
      ok = false;
    }
  }
  if (ok) {
    console.log(`✅ ${filePath} contains all required rewrite rules.`);
  }
  return ok;
}

async function smokeTestMedia(url) {
  try {
    const response = await fetch(url, { method: "HEAD" });
    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    if (response.ok && contentType.startsWith("image/")) {
      console.log(`✅ Smoke test passed: ${url} → ${response.status} ${contentType}`);
      return true;
    }
    console.error(`❌ Smoke test failed: ${url} → ${response.status} ${contentType} (expected image/*)`);
    return false;
  } catch (err) {
    console.error(`❌ Smoke test error: ${url} → ${err.message}`);
    return false;
  }
}

async function main() {
  console.log("Verifying NatForgeAI deployment...\n");

  const publicConfig = path.join(projectRoot, "public", "web.config");
  const distConfig = path.join(projectRoot, "dist", "public", "web.config");

  const publicOk = checkWebConfig(publicConfig);
  const distOk = checkWebConfig(distConfig);

  let smokeOk = true;
  const smokeUrl = process.env.NATFORGE_SMOKE_URL;
  if (smokeUrl) {
    smokeOk = await smokeTestMedia(smokeUrl);
  } else {
    console.log("ℹ️  Set NATFORGE_SMOKE_URL to run an HTTP smoke test.");
  }

  console.log("");
  if (publicOk && distOk && smokeOk) {
    console.log("✅ Deployment verification passed.");
    process.exit(0);
  } else {
    console.error("❌ Deployment verification failed.");
    process.exit(1);
  }
}

main();
