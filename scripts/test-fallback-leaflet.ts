import fs from "fs";
import path from "path";
import { generateFallbackLeafletImage } from "../api/lib/creative/composition";

const business = {
  name: "Print & Copy Express",
  industry: "print shop",
  logo: "/test-logo.png",
  brandColors: ["#0EA5E9", "#F59E0B"],
};

const campaign = {
  offerDetails: "10% 0ff any orders R3 000 and above",
  preferredCta: "Request a quote today",
};

async function run(templateId: "service_business_promo" | "retail_product_promo" | "offer_discount_campaign") {
  const { buffer, footerTop, footerHeight } = await generateFallbackLeafletImage({
    business,
    campaign,
    templateId,
    aspectRatio: "4:5",
    offer: "Enjoy 10% off orders above R3,000",
  });
  const out = path.resolve(`scripts/test-output-fallback-${templateId}.png`);
  fs.writeFileSync(out, buffer);
  console.log(`✓ ${templateId}: ${buffer.length} bytes, footerTop=${footerTop}, footerHeight=${footerHeight} -> ${out}`);
}

(async () => {
  for (const id of ["service_business_promo", "retail_product_promo", "offer_discount_campaign"] as const) {
    await run(id);
  }
})();
