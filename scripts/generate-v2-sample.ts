/**
 * Generate Premium Leaflet V2.2 / hybrid sample images.
 *
 * Usage:
 *   npx tsx scripts/generate-v2-sample.ts --fixture 3at1
 *   npx tsx scripts/generate-v2-sample.ts --all-fixtures
 *   npx tsx scripts/generate-v2-sample.ts --all-fixtures --hybrid
 *   npx tsx scripts/generate-v2-sample.ts --business-id 20 --campaign-id 23 --draft-only
 *   npx tsx scripts/generate-v2-sample.ts --business-id 20 --campaign-id 23 --draft-only --hybrid
 *   npx tsx scripts/generate-v2-sample.ts --fixture 3at1 --logo ./path/to/logo.png --production
 *   npx tsx scripts/generate-v2-sample.ts --fixture 3at1 --out ./my-sample.png
 */

// Load secrets from Google Cloud Secret Manager before app env is evaluated.
import "./lib/load-secrets";

import { buildPremiumV2Brief } from "../api/lib/creative/premium-v2/brief";
import { renderV2FromBrief } from "../api/lib/creative/premium-v2/renderer";
import { validatePremiumV2Quality } from "../api/lib/creative/premium-v2/quality";
import { resolveBrandKit } from "../api/lib/creative/premium-v2/brand-kit";
import { runHybridPipeline } from "../api/lib/creative/premium-v2/hybrid-pipeline";
import { env } from "../api/lib/env";
import {
  decisionLabel,
  buildHybridLogEntry,
  saveHybridAttemptImages,
  writeHybridGenerationLog,
  writeDeterministicGenerationLog,
  buildBrandAssetDiagnostics,
  buildRenderDiagnostics,
  printBrandAssetDiagnostics,
} from "./lib/hybrid-sample-writer";
import { ALL_FIXTURES, fixture3At1Newmarket } from "../api/lib/creative/premium-v2/fixtures";
import { ensureFixtureLogos } from "../api/lib/creative/premium-v2/fixture-logos";
import { writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { eq } from "drizzle-orm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outputDir = join(__dirname, "..", "dist", "samples");
mkdirSync(outputDir, { recursive: true });

function parseArgs(): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    }
  }
  return args;
}

async function renderFixture(
  fixtureName: string,
  options: { production?: boolean; logo?: string; out?: string; hybrid?: boolean }
): Promise<{ outputPath: string; label: string; passed: boolean; hybridResult?: any; deterministicLog?: any }> {
  const fixtureFn = ALL_FIXTURES[fixtureName as keyof typeof ALL_FIXTURES];
  if (!fixtureFn) {
    throw new Error(`Unknown fixture: ${fixtureName}. Available: ${Object.keys(ALL_FIXTURES).join(", ")}`);
  }

  const isMock = !options.production;
  const { business: baseBusiness, campaign } =
    fixtureName === "3at1" ? fixture3At1Newmarket(isMock) : (fixtureFn as any)();

  const business = {
    ...baseBusiness,
    logo: options.logo || baseBusiness.logo,
  };

  let buffer: Buffer;
  let label: string;
  let passed: boolean;
  let hybridResult: any;
  let deterministicLog: any;

  if (options.hybrid) {
    (env as any).enableHybridLeafletPipeline = true;
    const hybrid = await runHybridPipeline({
      business,
      campaign,
      post: { id: 200, campaignId: campaign.id, title: `${business.displayName} promo` },
      sampleMode: true,
    });
    hybridResult = hybrid;
    buffer = hybrid.buffer;
    passed = hybrid.metadata.finalDecision === "premium_ready";
    label = decisionLabel(hybrid.metadata.finalDecision);

    console.log(`\n[${fixtureName}] Hybrid brief:`, JSON.stringify(hybrid.brief, null, 2));
    console.log(`[${fixtureName}] Hybrid visual direction:`, JSON.stringify(hybrid.visualDirection, null, 2));
    console.log(`[${fixtureName}] Hybrid critic:`, JSON.stringify(hybrid.critic, null, 2));
    console.log(`[${fixtureName}] Hybrid metadata:`, JSON.stringify(hybrid.metadata, null, 2));
    printBrandAssetDiagnostics(buildBrandAssetDiagnostics(hybrid.brandKit.brandAsset), buildRenderDiagnostics(hybrid.metadata));
  } else {
    const brandKit = await resolveBrandKit(business);
    const brief = await buildPremiumV2Brief({
      business,
      campaign,
      post: { id: 200, campaignId: campaign.id, title: `${business.displayName} promo` },
      brandKit,
    });

    console.log(`\n[${fixtureName}] Brief:`, JSON.stringify(brief, null, 2));

    const preQuality = validatePremiumV2Quality(brief, undefined, { production: !!options.production });
    console.log(`[${fixtureName}] Pre-render quality:`, preQuality.label, preQuality.warnings);

    const { buffer: renderedBuffer, metrics } = await renderV2FromBrief(brief);
    const postQuality = validatePremiumV2Quality(brief, metrics, { production: !!options.production });
    buffer = renderedBuffer;
    label = postQuality.label;
    passed = postQuality.passed;
    console.log(`[${fixtureName}] Post-render quality:`, postQuality.label, postQuality.score);
    deterministicLog = {
      fixture: fixtureName,
      label,
      passed,
      score: postQuality.score,
      brandAsset: buildBrandAssetDiagnostics(brief.brandAsset),
    };
    printBrandAssetDiagnostics(deterministicLog.brandAsset);
  }

  const suffix = options.production ? "production" : options.hybrid ? "hybrid" : "v2.2";
  const outputPath =
    options.out ||
    (fixtureName === "3at1"
      ? join(outputDir, `3at1-newmarket-${suffix}-sample.png`)
      : join(outputDir, options.hybrid ? "hybrid" : "v2.2", `${fixtureName}-${suffix}-sample.png`));

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, buffer);
  console.log(`[${fixtureName}] Sample written to:`, outputPath);

  return { outputPath, label, passed, hybridResult, deterministicLog };
}

async function renderDraftSample(
  businessId: string,
  campaignId: string,
  options: { production?: boolean; logo?: string; hybrid?: boolean }
) {
  console.warn(`\n[Draft sample] Loading business ${businessId} and campaign ${campaignId} from DB (read-only).`);
  console.warn("This mode is sample-only and will not mutate content_posts, publishing_queue or campaign state.");

  const { getDb } = await import("../api/queries/connection");
  const { businesses, campaigns } = await import("../db/schema.ts");
  const db = getDb();

  const businessRows = await db.select().from(businesses).where(eq(businesses.id, Number(businessId))).limit(1);
  const campaignRows = await db.select().from(campaigns).where(eq(campaigns.id, Number(campaignId))).limit(1);

  if (!businessRows.length || !campaignRows.length) {
    throw new Error("Business or campaign not found");
  }

  const business = businessRows[0] as any;
  const campaign = campaignRows[0] as any;
  if (options.logo) business.logo = options.logo;

  let buffer: Buffer;
  let brandAssetDiagnostics: any;
  let hybrid: any;

  if (options.hybrid) {
    (env as any).enableHybridLeafletPipeline = true;
    hybrid = await runHybridPipeline({
      business,
      campaign,
      post: { id: 0, campaignId: campaign.id, title: "Draft sample" },
      sampleMode: true,
    });
    buffer = hybrid.buffer;
    brandAssetDiagnostics = buildBrandAssetDiagnostics(hybrid.brandKit.brandAsset);
    console.log("Hybrid draft sample finalDecision:", hybrid.metadata.finalDecision);
    console.log("Hybrid critic:", JSON.stringify(hybrid.critic, null, 2));
    console.log("Hybrid render diagnostics:", JSON.stringify(buildRenderDiagnostics(hybrid.metadata), null, 2));
  } else {
    const brandKit = await resolveBrandKit(business);
    const brief = await buildPremiumV2Brief({
      business,
      campaign,
      post: { id: 0, campaignId: campaign.id, title: "Draft sample" },
      brandKit,
    });

    const { buffer: renderedBuffer, metrics } = await renderV2FromBrief(brief);
    const quality = validatePremiumV2Quality(brief, metrics, { production: !!options.production });
    buffer = renderedBuffer;
    brandAssetDiagnostics = buildBrandAssetDiagnostics(brief.brandAsset);
    console.log("Quality:", quality.label, quality.score, quality.warnings);
  }

  const suffix = options.hybrid ? "hybrid-draft" : "draft";
  const outputPath = join(outputDir, "draft", `business-${businessId}-campaign-${campaignId}-${suffix}-sample.png`);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, buffer);

  if (options.hybrid) {
    const attemptDir = dirname(outputPath);
    const fixtureName = `business-${businessId}-campaign-${campaignId}`;
    const attemptPaths = saveHybridAttemptImages(attemptDir, fixtureName, hybrid);
    const entry = buildHybridLogEntry(fixtureName, hybrid, attemptPaths, outputPath);
    const logPath = writeHybridGenerationLog(attemptDir, [entry]);
    console.log("Hybrid generation log written to:", logPath);
    if (attemptPaths.length) {
      console.log("Hybrid attempt images:", attemptPaths);
    }
  }

  console.log("Draft sample written to:", outputPath);
  printBrandAssetDiagnostics(brandAssetDiagnostics, options.hybrid && hybrid ? buildRenderDiagnostics(hybrid.metadata) : undefined);
}

async function main() {
  const args = parseArgs();

  if (args.fixture || args["all-fixtures"] || args.all) {
    // Ensure local fixture logo files exist before rendering.
    await ensureFixtureLogos();
  }

  if (args["all-fixtures"] || args.all) {
    const hybrid = !!args.hybrid;
    mkdirSync(join(outputDir, hybrid ? "hybrid" : "v2.2"), { recursive: true });
    const fixtureNames = Object.keys(ALL_FIXTURES);
    const maxFixtures = typeof args["max-fixtures"] === "string" ? parseInt(args["max-fixtures"], 10) : undefined;
    const selectedFixtures =
      typeof maxFixtures === "number" && !Number.isNaN(maxFixtures)
        ? fixtureNames.slice(0, Math.max(0, maxFixtures))
        : fixtureNames;

    const logEntries: any[] = [];
    const deterministicEntries: any[] = [];
    const summary: { name: string; label: string }[] = [];
    for (const name of selectedFixtures) {
      const result = await renderFixture(name, { production: !!args.production, logo: args.logo as string, hybrid });
      summary.push({ name, label: result.label });
      if (hybrid && result.hybridResult) {
        const attemptDir = join(outputDir, "hybrid");
        const attemptPaths = saveHybridAttemptImages(attemptDir, name, result.hybridResult);
        const entry = buildHybridLogEntry(name, result.hybridResult, attemptPaths, result.outputPath);
        logEntries.push(entry);
      } else if (result.deterministicLog) {
        deterministicEntries.push(result.deterministicLog);
      }
    }

    if (hybrid && logEntries.length) {
      const logPath = writeHybridGenerationLog(join(outputDir, "hybrid"), logEntries);
      console.log("\n=== Hybrid generation log written to ===", logPath);
      console.log("\n=== Hybrid critic JSON ===");
      for (const entry of logEntries) {
        console.log(`\n[${entry.fixture}]`, JSON.stringify(entry.critic, null, 2));
      }
    } else if (deterministicEntries.length) {
      const logPath = writeDeterministicGenerationLog(join(outputDir, "v2.2"), deterministicEntries);
      console.log("\n=== Deterministic generation log written to ===", logPath);
    }
    console.log("\n=== Sample summary ===");
    for (const s of summary) {
      console.log(`${s.name}: ${s.label}`);
    }
    return;
  }

  if (args.fixture) {
    const result = await renderFixture(args.fixture as string, {
      production: !!args.production,
      logo: args.logo as string,
      out: args.out as string,
      hybrid: !!args.hybrid,
    });
    if (args.hybrid && result.hybridResult) {
      const attemptDir = join(outputDir, "hybrid");
      const attemptPaths = saveHybridAttemptImages(attemptDir, args.fixture as string, result.hybridResult);
      const entry = buildHybridLogEntry(args.fixture as string, result.hybridResult, attemptPaths, result.outputPath);
      const logPath = writeHybridGenerationLog(attemptDir, [entry]);
      console.log("\n=== Hybrid generation log written to ===", logPath);
      console.log(`\n[${args.fixture}] Attempt images:`, attemptPaths);
    } else if (result.deterministicLog) {
      const logPath = writeDeterministicGenerationLog(join(outputDir, "v2.2"), [result.deterministicLog]);
      console.log("\n=== Deterministic generation log written to ===", logPath);
    }
    console.log("\n=== Sample summary ===");
    console.log(`${args.fixture}: ${result.label}`);
    return;
  }

  if (args["business-id"] && args["campaign-id"]) {
    if (!args["draft-only"]) {
      throw new Error("Real business/campaign sampling requires --draft-only to prevent mutating live data.");
    }
    await renderDraftSample(args["business-id"] as string, args["campaign-id"] as string, {
      production: !!args.production,
      logo: args.logo as string,
      hybrid: !!args.hybrid,
    });
    return;
  }

  console.log(`
Usage:
  npx tsx scripts/generate-v2-sample.ts --fixture 3at1
  npx tsx scripts/generate-v2-sample.ts --all-fixtures
  npx tsx scripts/generate-v2-sample.ts --all-fixtures --hybrid
  npx tsx scripts/generate-v2-sample.ts --business-id 20 --campaign-id 23 --draft-only
  npx tsx scripts/generate-v2-sample.ts --business-id 20 --campaign-id 23 --draft-only --hybrid
  npx tsx scripts/generate-v2-sample.ts --fixture 3at1 --logo ./logo.png --production
  npx tsx scripts/generate-v2-sample.ts --fixture 3at1 --out ./my-sample.png
`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
