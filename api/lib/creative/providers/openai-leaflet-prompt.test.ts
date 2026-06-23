import { describe, it, expect } from "vitest";
import { buildOpenAiLeafletPrompt } from "./openai-leaflet-prompt";

function baseInput() {
  return {
    businessName: "Cape Print Shop",
    businessCategory: "print and copy shop",
    productOrService: "Printing",
    location: "Cape Town",
    offer: "10% off banners",
    headline: "Big banner sale",
    campaignObjective: "drive foot traffic",
    brandColors: ["#FF0000", "#000000", "#FFFFFF"],
    format: "leaflet" as const,
    aspectRatio: "4:5",
    creativeGuidance: "modern workspace still-life",
  };
}

describe("buildOpenAiLeafletPrompt", () => {
  it("includes the business name and category", () => {
    const { prompt } = buildOpenAiLeafletPrompt(baseInput());
    expect(prompt).toContain("Cape Print Shop");
    expect(prompt).toContain("print");
  });

  it("explicitly forbids text, logos and UI elements", () => {
    const { prompt } = buildOpenAiLeafletPrompt(baseInput());
    expect(prompt).toMatch(/NO text/i);
    expect(prompt).toMatch(/NO logos/i);
    expect(prompt).toMatch(/NO UI elements/i);
    expect(prompt).toMatch(/NO people/i);
    expect(prompt).toMatch(/NO faces/i);
  });

  it("adds a stronger retry constraint when isRetry is true", () => {
    const { prompt } = buildOpenAiLeafletPrompt({ ...baseInput(), isRetry: true });
    expect(prompt).toContain("RETRY NOTE");
    expect(prompt).toContain("pure, unbranded visual scene only");
  });

  it("chooses visual scene based on business category", () => {
    const print = buildOpenAiLeafletPrompt(baseInput());
    expect(print.prompt).toContain("printer");

    const art = buildOpenAiLeafletPrompt({
      ...baseInput(),
      businessCategory: "canvas wall art and decor",
      productOrService: "wall art",
    });
    expect(art.prompt).toContain("canvas");

    const food = buildOpenAiLeafletPrompt({
      ...baseInput(),
      businessCategory: "restaurant",
      productOrService: "food",
    });
    expect(food.prompt).toContain("food");
  });

  it("includes brand colours as accents only", () => {
    const { prompt } = buildOpenAiLeafletPrompt(baseInput());
    expect(prompt).toContain("#FF0000");
    expect(prompt).toContain("subtly woven into the scene as accents only");
  });

  it("leaves space for overlay text", () => {
    const { prompt } = buildOpenAiLeafletPrompt(baseInput());
    expect(prompt).toContain("clear empty space");
    expect(prompt).toContain("logo");
    expect(prompt).toContain("headline");
  });
});
