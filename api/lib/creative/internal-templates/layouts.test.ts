import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { getInternalTemplateLayout } from "./layouts";
import type { InternalTemplateRenderContext } from "./types";
import type { PremiumTemplateId } from "../template-catalogue";

const tinyPngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function meanBrightness(buffer: Buffer): number {
  let sum = 0;
  for (let i = 0; i < buffer.length; i += 4) {
    sum += (buffer[i] + buffer[i + 1] + buffer[i + 2]) / 3;
  }
  return sum / (buffer.length / 4);
}

function baseContext(templateId: PremiumTemplateId): InternalTemplateRenderContext {
  return {
    templateId,
    width: 1080,
    height: 1350,
    businessName: "Zutohub",
    logoBuffer: Buffer.from(tinyPngBase64, "base64"),
    brandPalette: {
      primary: "#0F766E",
      secondary: "#99F6E4",
      accent: "#F59E0B",
      source: "brandColors",
    },
    headline: "Instant payouts for restaurants, delivery platforms and frontline teams",
    offer: "Pay approved tips, commissions and supplier payouts faster",
    subheadline: "Stop waiting for weekly settlement and reconciliation.",
    cta: "Book a Zuto Hub Demo",
    services: [
      "Payouts for restaurants, delivery platforms and frontline teams",
      "Automated tips, commissions and supplier payouts",
      "Approved delivery orders settled without manual reconciliation",
      "Track payouts, settlement and reconciliation in one place",
    ],
    contact: {
      phone: "(011) 123-4567",
      whatsapp: "082 123 4567",
      email: "info@zutohub.co.za",
      website: "https://www.zutohub.co.za",
      location: "Randburg, South Africa",
    },
  };
}

describe("internal premium leaflet layouts", () => {
  it("service_business_promo renders 1080x1350 and keeps CTA/footer visible", async () => {
    const layout = getInternalTemplateLayout("service_business_promo");
    const buffer = await layout.render(baseContext("service_business_promo"));

    const meta = await sharp(buffer).metadata();
    expect(meta.width).toBe(1080);
    expect(meta.height).toBe(1350);

    // Extract the bottom 180 rows (CTA + footer area) and ensure it is not
    // empty/white — i.e. the CTA and footer were actually drawn inside the canvas.
    const bottomRegion = await sharp(buffer)
      .extract({ left: 0, top: 1350 - 180, width: 1080, height: 180 })
      .raw()
      .toBuffer();

    const avg = meanBrightness(bottomRegion);
    expect(avg).toBeLessThan(245);

    // The footer band is drawn with the primary brand colour; the centre of the
    // very bottom row should be noticeably darker than pure white.
    const bottomRow = await sharp(buffer)
      .extract({ left: 540 - 10, top: 1349, width: 20, height: 1 })
      .raw()
      .toBuffer();
    expect(meanBrightness(bottomRow)).toBeLessThan(200);

    // The CTA pill sits just above the footer and should be filled with the
    // accent colour in the horizontal band above the footer.
    const ctaBand = await sharp(buffer)
      .extract({ left: 100, top: 1350 - 170, width: 880, height: 70 })
      .raw()
      .toBuffer();
    expect(meanBrightness(ctaBand)).toBeLessThan(240);
    expect(meanBrightness(ctaBand)).toBeGreaterThan(80);
  });

  const otherTemplates: PremiumTemplateId[] = [
    "retail_product_promo",
    "offer_discount_campaign",
    "corporate_professional",
    "local_store_promo",
  ];

  it.each(otherTemplates)("%s renders 1080x1350 without a clipped footer", async (templateId) => {
    const layout = getInternalTemplateLayout(templateId);
    const ctx = baseContext(templateId);
    if (templateId === "local_store_promo") {
      // Trim services to the number the template displays so we test wrapping.
      ctx.services = ctx.services.slice(0, 3);
    }
    const buffer = await layout.render(ctx);

    const meta = await sharp(buffer).metadata();
    expect(meta.width).toBe(1080);
    expect(meta.height).toBe(1350);

    const bottomRow = await sharp(buffer)
      .extract({ left: 540 - 10, top: 1349, width: 20, height: 1 })
      .raw()
      .toBuffer();
    expect(meanBrightness(bottomRow)).toBeLessThan(230);
  });

  it("service_business_promo keeps a long CTA inside the CTA pill", async () => {
    const layout = getInternalTemplateLayout("service_business_promo");
    const ctx = baseContext("service_business_promo");
    ctx.cta = "Book your free personalised Zuto Hub consultation today";
    const buffer = await layout.render(ctx);

    const meta = await sharp(buffer).metadata();
    expect(meta.width).toBe(1080);
    expect(meta.height).toBe(1350);

    const bottomRegion = await sharp(buffer)
      .extract({ left: 0, top: 1350 - 180, width: 1080, height: 180 })
      .raw()
      .toBuffer();
    expect(meanBrightness(bottomRegion)).toBeLessThan(245);
  });
});
