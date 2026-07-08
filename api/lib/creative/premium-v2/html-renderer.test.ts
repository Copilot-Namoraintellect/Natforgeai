import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { computeLogoRenderPlan, renderHybridLeaflet } from "./html-renderer";
import type { HybridBrandKit, VisualDirection } from "./pipeline-types";

const brandKit: HybridBrandKit = {
  primary: "#0047AB",
  secondary: "#FFD700",
  accent: "#DC143C",
  background: "#F8FAFC",
  text: "#0F172A",
  textMuted: "#475569",
  source: "logo",
  logoUrl: null,
  logoDescription: null,
  typographyNote: null,
};

const visualDirection: VisualDirection = {
  layoutPreset: "premium_local_service",
  density: "balanced",
  heroTreatment: "shape_accent",
  backgroundDirection: "abstract_brand_gradient",
  backgroundPrompt: "soft gradient no text",
  ctaTreatment: "solid_button",
  serviceLayout: "grid",
  colourUsageNote: "brand colours",
};

function makeBrief(overrides?: Partial<Parameters<typeof renderHybridLeaflet>[0]>) {
  return {
    businessName: "3@1 Newmarket",
    headline: "Fast, Professional Printing",
    subheadline: "Business cards, flyers, banners and courier services in Newmarket.",
    primaryServices: [
      { name: "Business Cards", description: "Premium card printing" },
      { name: "Flyers & Banners", description: "High-impact large format" },
    ],
    secondaryServices: [{ name: "Courier" }, { name: "Laminating" }],
    benefits: ["Same-day service", "Local delivery", "Competitive pricing"],
    cta: "Request a Quote Today",
    contact: { phone: "011 123 9999", website: "https://3at1newmarket.test", location: "Newmarket, Alberton" },
    ...overrides,
  };
}

async function makeLogoBuffer(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 0, g: 80, b: 180, alpha: 255 },
    },
  })
    .png()
    .toBuffer();
}

async function addTextToLogo(buffer: Buffer, text: string): Promise<Buffer> {
  const meta = await sharp(buffer).metadata();
  const width = meta.width || 200;
  const height = meta.height || 80;
  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><rect width="${width}" height="${height}" fill="#0050B3"/><text x="50%" y="55%" font-family="Arial, Helvetica, sans-serif" font-size="${Math.min(height * 0.45, 56)}" font-weight="900" fill="#FFD700" text-anchor="middle" dominant-baseline="middle">${text}</text></svg>`;
  return sharp(Buffer.from(svg, "utf-8")).png().toBuffer();
}

describe("computeLogoRenderPlan", () => {
  it("treats a wide logo (>2.2:1) as horizontal with readable dimensions", async () => {
    const buffer = await makeLogoBuffer(800, 200);
    const plan = await computeLogoRenderPlan(buffer);

    expect(plan.aspectRatio).toBeGreaterThan(2.2);
    expect(plan.treatment).toBe("horizontal");
    expect(plan.renderedWidth).toBeLessThanOrEqual(340);
    expect(plan.renderedHeight).toBeLessThanOrEqual(110);
    expect(plan.renderedHeight).toBeGreaterThanOrEqual(55);
  });

  it("treats a compact/square logo as compact", async () => {
    const buffer = await makeLogoBuffer(200, 200);
    const plan = await computeLogoRenderPlan(buffer);

    expect(plan.aspectRatio).toBeLessThanOrEqual(2.2);
    expect(plan.treatment).toBe("compact");
    expect(plan.renderedWidth).toBeLessThanOrEqual(220);
    expect(plan.renderedHeight).toBeLessThanOrEqual(120);
    expect(plan.renderedHeight).toBeGreaterThanOrEqual(55);
  });

  it("honours the minimum readable height when the logo can fit within the horizontal panel", async () => {
    // 600x100 is very wide (6:1) but still tall enough that scaling to the
    // max width of 340px gives a height above the 55px readability floor.
    const buffer = await makeLogoBuffer(600, 100);
    const plan = await computeLogoRenderPlan(buffer);

    expect(plan.treatment).toBe("horizontal");
    expect(plan.renderedWidth).toBeLessThanOrEqual(340);
    expect(plan.renderedHeight).toBeGreaterThanOrEqual(55);
  });

  it("preserves aspect ratio for all treatments", async () => {
    const wide = await makeLogoBuffer(600, 150);
    const widePlan = await computeLogoRenderPlan(wide);
    expect(Math.abs(widePlan.renderedWidth / widePlan.renderedHeight - 4)).toBeLessThan(0.1);

    const square = await makeLogoBuffer(200, 200);
    const squarePlan = await computeLogoRenderPlan(square);
    expect(squarePlan.renderedWidth).toBe(squarePlan.renderedHeight);
  });
});

describe("renderHybridLeaflet logo handling", () => {
  it("renders a wide real logo horizontally without masking or fallback badge", async () => {
    const logoBuffer = await addTextToLogo(await makeLogoBuffer(800, 200), "3@1");
    const { buffer, metrics } = await renderHybridLeaflet(
      makeBrief(),
      brandKit,
      visualDirection,
      null,
      logoBuffer,
      {
        logoSourceType: "uploaded",
        logoSourcePath: "/uploads/logo/3at1.png",
        logoSourceUrl: "https://example.com/3at1.png",
        logoResolved: true,
        logoRenderMode: "image",
        realLogoExpected: true,
        realLogoRendered: true,
        fallbackReason: null,
        brandAssetWarnings: [],
      }
    );

    expect(buffer).toBeInstanceOf(Buffer);
    const meta = await sharp(buffer).metadata();
    expect(meta.width).toBe(1080);
    expect(meta.height).toBe(1350);

    expect(metrics.realLogoExpected).toBe(true);
    expect(metrics.realLogoRendered).toBe(true);
    expect(metrics.logoRenderMode).toBe("image");
    expect(metrics.fallbackBadgeRendered).toBe(false);
    expect(metrics.logoMaskedOrCropped).toBe(false);
    expect(metrics.logoDataUriUsed).toBe(true);

    expect(metrics.logoNaturalWidth).toBe(800);
    expect(metrics.logoNaturalHeight).toBe(200);
    expect(metrics.logoRenderedHeight).toBeGreaterThanOrEqual(55);
    expect(metrics.logoRenderedWidth).toBeGreaterThan(200);
    expect(metrics.logoVisibleArea).toBeGreaterThan(200 * 55);
  });

  it("falls back to a badge only when no real logo is expected", async () => {
    const { buffer, metrics } = await renderHybridLeaflet(
      makeBrief(),
      brandKit,
      visualDirection,
      null,
      null,
      {
        logoSourceType: "fallback",
        logoSourcePath: null,
        logoSourceUrl: null,
        logoResolved: false,
        logoRenderMode: "fallback_badge",
        realLogoExpected: false,
        realLogoRendered: false,
        fallbackReason: "No logo provided",
        brandAssetWarnings: ["Using fallback monogram because no brand logo exists."],
      }
    );

    expect(buffer).toBeInstanceOf(Buffer);
    expect(metrics.realLogoExpected).toBe(false);
    expect(metrics.realLogoRendered).toBe(false);
    expect(metrics.logoRenderMode).toBe("fallback_badge");
    expect(metrics.fallbackBadgeRendered).toBe(true);
  });

  it("throws detailed diagnostics when a real logo was expected but the buffer is missing", async () => {
    await expect(
      renderHybridLeaflet(
        makeBrief(),
        brandKit,
        visualDirection,
        null,
        null,
        {
          logoSourceType: "uploaded",
          logoSourcePath: "/uploads/logo/3at1.png",
          logoSourceUrl: "https://example.com/3at1.png",
          logoResolved: true,
          logoRenderMode: "image",
          realLogoExpected: true,
          realLogoRendered: false,
          fallbackReason: "Logo buffer unavailable",
          brandAssetWarnings: ["Real logo expected but could not be loaded; fallback badge is a placeholder."],
        }
      )
    ).rejects.toThrow(/Real logo expected for 3@1 Newmarket but not rendered/);
  });
});
