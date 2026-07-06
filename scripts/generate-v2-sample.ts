/**
 * Generate Premium Leaflet V2.1 sample images.
 *
 * Usage:
 *   npx tsx scripts/generate-v2-sample.ts --fixture 3at1
 *   npx tsx scripts/generate-v2-sample.ts --all-fixtures
 *   npx tsx scripts/generate-v2-sample.ts --business-id 20 --campaign-id 23 --draft-only
 *   npx tsx scripts/generate-v2-sample.ts --fixture 3at1 --logo ./path/to/logo.png --production
 */

import { buildPremiumV2Brief } from "../api/lib/creative/premium-v2/brief";
import { renderV2FromBrief } from "../api/lib/creative/premium-v2/renderer";
import { validatePremiumV2Quality } from "../api/lib/creative/premium-v2/quality";
import { resolveBrandKit } from "../api/lib/creative/premium-v2/brand-kit";
import { ALL_FIXTURES, fixture3At1Newmarket } from "../api/lib/creative/premium-v2/fixtures";
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
  options: { production?: boolean; logo?: string }
): Promise<{ outputPath: string; label: string; passed: boolean }> {
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

  const { buffer, metrics } = await renderV2FromBrief(brief);
  const postQuality = validatePremiumV2Quality(brief, metrics, { production: !!options.production });
  console.log(`[${fixtureName}] Post-render quality:`, postQuality.label, postQuality.score);

  const suffix = options.production ? "production" : "v2.1";
  const outputPath =
    fixtureName === "3at1"
      ? join(outputDir, `3at1-newmarket-${suffix}-sample.png`)
      : join(outputDir, "v2.1", `${fixtureName}-${suffix}-sample.png`);

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, buffer);
  console.log(`[${fixtureName}] Sample written to:`, outputPath);

  return { outputPath, label: postQuality.label, passed: postQuality.passed };
}

async function renderDraftSample(businessId: string, campaignId: string, options: { production?: boolean; logo?: string }) {
  console.warn(`\n[Draft sample] Loading business ${businessId} and campaign ${campaignId} from DB (read-only).`);
  console.warn("This mode is sample-only and will not mutate content_posts, publishing_queue or campaign state.");

  const { getDb } = await import("../api/queries/connection");
  const { businesses, campaigns } = await import("../api/db/schema");
  const db = getDb();

  const businessRows = await db.select().from(businesses).where(eq(businesses.id, Number(businessId))).limit(1);
  const campaignRows = await db.select().from(campaigns).where(eq(campaigns.id, Number(campaignId))).limit(1);

  if (!businessRows.length || !campaignRows.length) {
    throw new Error("Business or campaign not found");
  }

  const business = businessRows[0] as any;
  const campaign = campaignRows[0] as any;
  if (options.logo) business.logo = options.logo;

  const brandKit = await resolveBrandKit(business);
  const brief = await buildPremiumV2Brief({
    business,
    campaign,
    post: { id: 0, campaignId: campaign.id, title: "Draft sample" },
    brandKit,
  });

  const { buffer, metrics } = await renderV2FromBrief(brief);
  const quality = validatePremiumV2Quality(brief, metrics, { production: !!options.production });

  const outputPath = join(outputDir, "draft", `business-${businessId}-campaign-${campaignId}-sample.png`);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, buffer);

  console.log("Draft sample written to:", outputPath);
  console.log("Quality:", quality.label, quality.score, quality.warnings);
}

async function main() {
  const args = parseArgs();

  if (args["all-fixtures"] || args.all) {
    mkdirSync(join(outputDir, "v2.1"), { recursive: true });
    const results: { name: string; label: string; passed: boolean }[] = [];
    for (const name of Object.keys(ALL_FIXTURES)) {
      const result = await renderFixture(name, { production: !!args.production, logo: args.logo as string });
      results.push({ name, ...result });
    }
    console.log("\n=== Sample summary ===");
    for (const r of results) {
      console.log(`${r.name}: ${r.label} (${r.passed ? "PASS" : "FAIL"})`);
    }
    return;
  }

  if (args.fixture) {
    await renderFixture(args.fixture as string, { production: !!args.production, logo: args.logo as string });
    return;
  }

  if (args["business-id"] && args["campaign-id"]) {
    if (!args["draft-only"]) {
      throw new Error("Real business/campaign sampling requires --draft-only to prevent mutating live data.");
    }
    await renderDraftSample(args["business-id"] as string, args["campaign-id"] as string, {
      production: !!args.production,
      logo: args.logo as string,
    });
    return;
  }

  console.log(`
Usage:
  npx tsx scripts/generate-v2-sample.ts --fixture 3at1
  npx tsx scripts/generate-v2-sample.ts --all-fixtures
  npx tsx scripts/generate-v2-sample.ts --business-id 20 --campaign-id 23 --draft-only
  npx tsx scripts/generate-v2-sample.ts --fixture 3at1 --logo ./logo.png --production
`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
