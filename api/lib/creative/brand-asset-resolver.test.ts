import { describe, it, expect, beforeAll } from "vitest";
import { resolveBrandAssets, applyBrandAssetGate, type BrandAssetResolution } from "./brand-asset-resolver";
import { ensureFixtureLogos, resolveFixtureLogoPath } from "./premium-v2/fixture-logos";

describe("BrandAssetResolver", () => {
  beforeAll(async () => {
    await ensureFixtureLogos();
  });

  it("returns the uploaded logo when the business has a resolvable local logo", async () => {
    const logoPath = resolveFixtureLogoPath("3at1");
    const business = { id: 2, name: "3@1 Newmarket", logo: logoPath };
    const result = await resolveBrandAssets(business);

    expect(result.logoSourceType).toBe("uploaded");
    expect(result.logoSourcePath).toBe(logoPath);
    expect(result.logoResolved).toBe(true);
    expect(result.logoRenderMode).toBe("image");
    expect(result.realLogoExpected).toBe(true);
    expect(result.realLogoRendered).toBe(true);
    expect(result.fallbackReason).toBeNull();
  });

  it("uses image render mode when the uploaded logo path exists", async () => {
    const logoPath = resolveFixtureLogoPath("restaurant");
    const business = { id: 3, name: "Burger Barn", logo: logoPath };
    const result = await resolveBrandAssets(business);

    expect(result.logoRenderMode).toBe("image");
    expect(result.realLogoRendered).toBe(true);
  });

  it("flags a broken logo path as a brand asset failure", async () => {
    const business = { id: 99, name: "Broken Logo Co", logo: "/uploads/logo/99/definitely-missing.png" };
    const result = await resolveBrandAssets(business);

    expect(result.realLogoExpected).toBe(true);
    expect(result.logoResolved).toBe(false);
    expect(result.realLogoRendered).toBe(false);
    expect(result.logoRenderMode).toBe("fallback_badge");
    const gate = applyBrandAssetGate(result);
    expect(gate.passed).toBe(false);
    expect(gate.label).toBe("Brand Asset Review Required");
    expect(gate.criticalIssues).toContain("Real Logo Missing");
  });

  it("only allows fallback when no logo source exists", async () => {
    const business = { id: 100, name: "No Logo Co" };
    const result = await resolveBrandAssets(business);

    expect(result.logoSourceType).toBe("fallback");
    expect(result.realLogoExpected).toBe(false);
    expect(result.realLogoRendered).toBe(false);
    expect(result.logoRenderMode).toBe("fallback_badge");
    expect(result.brandAssetWarnings.length).toBeGreaterThan(0);

    const gate = applyBrandAssetGate(result);
    expect(gate.passed).toBe(true);
    expect(gate.label).toBe("Brand Assets OK");
  });

  it("writes the required brand-asset metadata fields", async () => {
    const logoPath = resolveFixtureLogoPath("beauty");
    const business = { id: 4, name: "Glow Spa", logo: logoPath };
    const campaign = { id: 31 };
    const result = await resolveBrandAssets(business, campaign);

    expect(result.businessId).toBe(business.id);
    expect(result.campaignId).toBe(campaign.id);
    expect(result.logoSourceType).toBeDefined();
    expect(result.logoSourcePath).toBeDefined();
    expect(result.logoSourceUrl).toBeDefined();
    expect(result.logoResolved).toBeDefined();
    expect(result.logoRenderMode).toBeDefined();
    expect(result.realLogoExpected).toBeDefined();
    expect(result.realLogoRendered).toBeDefined();
    expect(result.brandAssetWarnings).toBeDefined();
  });

  it("carries a logoBuffer when fetchBuffer is true", async () => {
    const logoPath = resolveFixtureLogoPath("cleaning");
    const business = { id: 5, name: "Sparkle Cleaners", logo: logoPath };
    const result = await resolveBrandAssets(business, undefined, { fetchBuffer: true });

    expect(result.logoBuffer).toBeInstanceOf(Buffer);
    expect(result.logoBuffer!.length).toBeGreaterThan(0);
  });
});
