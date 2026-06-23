import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { composeHybridLeaflet, loadLogoBuffer, type HybridComposerContext } from "./hybrid-leaflet-composer";

async function createBackgroundBuffer(): Promise<Buffer> {
  return sharp({
    create: {
      width: 1024,
      height: 1536,
      channels: 3,
      background: { r: 60, g: 80, b: 120 },
    },
  })
    .png()
    .toBuffer();
}

function baseContext(overrides?: Partial<HybridComposerContext>): HybridComposerContext {
  return {
    width: 1080,
    height: 1350,
    businessName: "Test Biz",
    logoUrl: "",
    brandColors: {
      primary: "#FF0000",
      secondary: "#000000",
      accent: "#FFFFFF",
      background: "#0a0f19",
      text: "#ffffff",
    },
    headline: "Big Sale",
    offer: "50% off everything",
    subheadline: "This weekend only",
    cta: "Shop now",
    services: ["Delivery", "Quality"],
    contact: { website: "https://test.com", whatsapp: "123456" },
    ...overrides,
  };
}

describe("loadLogoBuffer", () => {
  it("returns null when no logo URL is provided", async () => {
    const result = await loadLogoBuffer(undefined);
    expect(result).toBeNull();
  });
});

describe("composeHybridLeaflet", () => {
  it("returns a 1080x1350 PNG with text overlay", async () => {
    const background = await createBackgroundBuffer();
    const result = await composeHybridLeaflet(background, baseContext());

    const meta = await sharp(result).metadata();
    expect(meta.format).toBe("png");
    expect(meta.width).toBe(1080);
    expect(meta.height).toBe(1350);
  });

  it("still produces output when some text fields are empty", async () => {
    const background = await createBackgroundBuffer();
    const result = await composeHybridLeaflet(
      background,
      baseContext({ subheadline: "", offer: "", services: [] })
    );
    const meta = await sharp(result).metadata();
    expect(meta.format).toBe("png");
    expect(meta.width).toBe(1080);
    expect(meta.height).toBe(1350);
  });
});
