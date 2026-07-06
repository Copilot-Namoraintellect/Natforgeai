import { describe, it, expect } from "vitest";
import { buildPremiumV2Brief } from "./brief";
import { renderV2FromBrief } from "./renderer";
import { validatePremiumV2Quality } from "./quality";
import { resolveBrandKit } from "./brand-kit";
import {
  fixture3At1Newmarket,
  fixtureRestaurant,
  fixtureBeauty,
  fixtureCleaning,
  fixturePlumber,
  fixtureRetail,
  fixtureProfessional,
  fixtureTraining,
} from "./fixtures";
import { WEAK_PHRASES } from "./copy";

const FIXTURES = [
  { name: "print_courier", get: fixture3At1Newmarket },
  { name: "restaurant", get: fixtureRestaurant },
  { name: "beauty", get: fixtureBeauty },
  { name: "cleaning", get: fixtureCleaning },
  { name: "plumber", get: fixturePlumber },
  { name: "retail", get: fixtureRetail },
  { name: "professional", get: fixtureProfessional },
  { name: "training", get: fixtureTraining },
];

function containsWeakCopy(text?: string): string[] {
  if (!text) return [];
  const lower = text.toLowerCase();
  return WEAK_PHRASES.filter((p) => lower.includes(p));
}

describe("Premium V2.1 category-wide brand fidelity", () => {
  it.each(FIXTURES)("$name uses brand palette and renders without clipping", async ({ get }) => {
    const { business, campaign } = get();
    const brandKit = await resolveBrandKit(business);
    const brief = await buildPremiumV2Brief({
      business,
      campaign,
      post: { id: 1, campaignId: campaign.id, title: "Promo" },
      brandKit,
    });

    // Brand palette should come from explicit brand colours in fixtures.
    expect(brandKit.source).toBe("brandColors");
    expect(brief.brandPalette.primary).toBeTruthy();

    const { metrics } = await renderV2FromBrief(brief);
    const quality = validatePremiumV2Quality(brief, metrics);

    expect(metrics.width).toBe(1080);
    expect(metrics.height).toBe(1350);
    expect(metrics.ctaBoundingBox.y + metrics.ctaBoundingBox.h).toBeLessThanOrEqual(metrics.height);
    expect(metrics.footerY + metrics.footerHeight).toBeLessThanOrEqual(metrics.height);
    expect(quality.criticalFailures).toEqual([]);
  });

  it.each(FIXTURES)("$name produces strong, category-specific copy", async ({ get }) => {
    const { business, campaign } = get();
    const brandKit = await resolveBrandKit(business);
    const brief = await buildPremiumV2Brief({
      business,
      campaign,
      post: { id: 1, campaignId: campaign.id, title: "Promo" },
      brandKit,
    });

    expect(brief.headline.length).toBeGreaterThanOrEqual(12);
    expect(containsWeakCopy(brief.headline)).toEqual([]);
    expect(containsWeakCopy(brief.subheadline)).toEqual([]);

    const allCopy = [
      brief.headline,
      brief.subheadline,
      brief.cta,
      ...brief.benefits,
      ...brief.primaryServices.map((s) => `${s.name} ${s.description || ""}`),
    ].join(" ");
    expect(containsWeakCopy(allCopy)).toEqual([]);

    expect(brief.cta).not.toMatch(/^Learn more$/i);
    expect(brief.cta).not.toMatch(/^Contact us today$/i);
  });

  it.each(FIXTURES)("$name curates services without duplicates", async ({ get }) => {
    const { business, campaign } = get();
    const brandKit = await resolveBrandKit(business);
    const brief = await buildPremiumV2Brief({
      business,
      campaign,
      post: { id: 1, campaignId: campaign.id, title: "Promo" },
      brandKit,
    });

    const allNames = [...brief.primaryServices, ...brief.secondaryServices].map((s) => s.name.toLowerCase());
    const unique = new Set(allNames);
    expect(unique.size).toBe(allNames.length);

    // Primary cards should have benefit descriptions.
    const described = brief.primaryServices.filter((s) => !!s.description).length;
    expect(described).toBeGreaterThan(0);
  });

  it.each(FIXTURES)("$name subheadline is customer-facing and not the raw pain point", async ({ get }) => {
    const { business, campaign } = get();
    const brandKit = await resolveBrandKit(business);
    const brief = await buildPremiumV2Brief({
      business,
      campaign,
      post: { id: 1, campaignId: campaign.id, title: "Promo" },
      brandKit,
    });

    expect(brief.subheadline).toBeTruthy();
    expect(brief.subheadline!.length).toBeGreaterThanOrEqual(20);

    // Must not equal the raw customer pain point.
    const painPoint = (campaign.mainPainPoint || "").toLowerCase().trim();
    if (painPoint) {
      expect(brief.subheadline!.toLowerCase().trim()).not.toBe(painPoint);
    }

    // Must be customer-facing: contain positive outcome words rather than problem-only words.
    const subLower = brief.subheadline!.toLowerCase();
    const positiveWords = ["fresh", "bold", "relax", "refresh", "reliable", "fast", "practical", "clear", "expert", "professional", "quality", "great", "trusted", "easy", "convenient", "friendly"];
    const hasPositive = positiveWords.some((w) => subLower.includes(w));
    expect(hasPositive).toBe(true);

    const problemOnlyWords = ["boring", "stress", "lack", "inconsistent", "burst", "unclear"];
    const hasProblemOnly = problemOnlyWords.some((w) => subLower.includes(w));
    expect(hasProblemOnly).toBe(false);
  });
});

describe("3@1 Newmarket V2.1 regression target", () => {
  it("produces the expected headline, services and CTA", async () => {
    const { business, campaign } = fixture3At1Newmarket(true);
    const brandKit = await resolveBrandKit(business);
    const brief = await buildPremiumV2Brief({
      business,
      campaign,
      post: { id: 200, campaignId: campaign.id, title: "Print promo" },
      brandKit,
    });

    expect(brief.headline).toBe("Professional Printing, Courier & Business Services in Newmarket, Alberton");
    expect(brief.cta).toBe("Request a Quote Today");

    const primaryNames = brief.primaryServices.map((s) => s.name);
    expect(primaryNames).toContain("Business Cards & Flyers");
    expect(primaryNames).toContain("Large Format Printing");
    expect(primaryNames).toContain("Wall Canvas Prints");
    expect(primaryNames).toContain("Courier Services");

    const secondaryNames = brief.secondaryServices.map((s) => s.name);
    const expectedSecondary = ["Banners", "Posters", "Laminating", "Binding", "Copies & Scans"];
    for (const expected of expectedSecondary) {
      expect(secondaryNames).toContain(expected);
    }
  });
});
