import { describe, it, expect, beforeAll } from "vitest";
import { resolveBrandAssets, applyBrandAssetGate } from "../brand-asset-resolver";
import { ensureFixtureLogos, resolveFixtureLogoPath } from "./fixture-logos";
import { ALL_FIXTURES, type FixtureBusiness, type FixtureCampaign } from "./fixtures";

const CATEGORIES = [
  { key: "3at1", label: "print/courier" },
  { key: "restaurant", label: "restaurant" },
  { key: "beauty", label: "beauty" },
  { key: "cleaning", label: "cleaning" },
  { key: "plumber", label: "trades/plumber" },
  { key: "retail", label: "retail" },
  { key: "professional", label: "professional services" },
  { key: "training", label: "training/education" },
];

describe("Brand asset fidelity across categories", () => {
  beforeAll(async () => {
    await ensureFixtureLogos();
  });

  for (const { key, label } of CATEGORIES) {
    const fixtureFn = ALL_FIXTURES[key as keyof typeof ALL_FIXTURES];
    const { business: baseBusiness, campaign } = fixtureFn();

    describe(`${label} (${key})`, () => {
      it("resolves a real logo to image mode", async () => {
        const business = { ...baseBusiness };
        const result = await resolveBrandAssets(business, campaign);

        expect(result.logoResolved).toBe(true);
        expect(result.logoRenderMode).toBe("image");
        expect(result.realLogoExpected).toBe(true);
        expect(result.realLogoRendered).toBe(true);
        const gate = applyBrandAssetGate(result);
        expect(gate.passed).toBe(true);
      });

      it("allows fallback only when no logo exists", async () => {
        const business = { ...baseBusiness, logo: undefined } as any;
        const result = await resolveBrandAssets(business, campaign);

        expect(result.logoSourceType).toBe("fallback");
        expect(result.realLogoExpected).toBe(false);
        expect(result.logoRenderMode).toBe("fallback_badge");
        const gate = applyBrandAssetGate(result);
        expect(gate.passed).toBe(true);
        expect(gate.warnings.length).toBeGreaterThan(0);
      });

      it("blocks premium ready when the logo path is broken", async () => {
        const business = { ...baseBusiness, logo: "/uploads/logo/broken/definitely-missing.png" };
        const result = await resolveBrandAssets(business, campaign);

        expect(result.realLogoExpected).toBe(true);
        expect(result.logoResolved).toBe(false);
        expect(result.realLogoRendered).toBe(false);
        expect(result.logoRenderMode).toBe("fallback_badge");
        const gate = applyBrandAssetGate(result);
        expect(gate.passed).toBe(false);
        expect(gate.label).toBe("Brand Asset Review Required");
        expect(gate.criticalIssues).toContain("Real Logo Missing");
      });
    });
  }
});
