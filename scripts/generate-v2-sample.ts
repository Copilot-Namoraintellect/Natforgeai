/**
 * Generate a sample Premium Leaflet V2 image for the 3@1 Newmarket fixture.
 * Run with: npx tsx scripts/generate-v2-sample.ts
 */

import { buildPremiumV2Brief } from "../api/lib/creative/premium-v2/brief";
import { renderV2FromBrief } from "../api/lib/creative/premium-v2/renderer";
import { writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outputDir = join(__dirname, "..", "dist", "samples");
mkdirSync(outputDir, { recursive: true });

const business = {
  id: 2,
  name: "3@1 Newmarket",
  displayName: "3@1 Newmarket",
  logo: "https://via.placeholder.com/200x200/0047AB/FFFFFF?text=3@1",
  industry: "Print and courier",
  location: "Newmarket, Alberton",
  phone: "011 123 9999",
  website: "https://3at1newmarket.test",
  productOrService: "Business cards, Flyers, Large format prints, Wall canvas prints, Courier services, Banners, Posters, Custom printing, Laminating, Binding, Copies, Scans",
  targetCustomer: "Small businesses and event planners",
  brandColors: ["#0047AB", "#FFD700", "#FFFFFF"],
  visualStyle: "modern",
  websiteEvidence: {
    businessCategory: "print and courier",
    productsServices: ["Business cards", "Flyers", "Large format prints", "Wall canvas prints", "Courier services", "Banners", "Posters", "Custom printing", "Laminating", "Binding", "Copies", "Scans"],
  },
};

const campaign = {
  id: 20,
  name: "Newmarket Print Promo",
  goal: "Leads",
  primaryOutcome: "Get more print orders",
  targetBuyer: "Small business owners",
  mainPainPoint: "Need fast, affordable printing and delivery",
  productOrService: "Printing, Copying, Scanning, Laminating, Binding, Courier",
  preferredCta: "Request a Quote Today",
};

async function main() {
  const brief = buildPremiumV2Brief({
    business,
    campaign,
    post: { id: 200, campaignId: 20, title: "Print promo" },
  });

  console.log("Brief:", JSON.stringify(brief, null, 2));

  const { buffer, metrics } = await renderV2FromBrief(brief);
  const outputPath = join(outputDir, "3at1-newmarket-v2-sample.png");
  writeFileSync(outputPath, buffer);
  console.log("\nSample written to:", outputPath);
  console.log("Layout metrics:", metrics);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
