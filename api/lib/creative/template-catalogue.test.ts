import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const originalEnv = { ...process.env };

function setEnv(patch: Record<string, string>) {
  Object.keys(process.env).forEach((key) => delete process.env[key]);
  Object.assign(process.env, originalEnv, patch);
}

describe("template-catalogue", () => {
  beforeEach(() => {
    vi.resetModules();
    setEnv({
      BANNERBEAR_TEMPLATE_RETAIL_PRODUCT_PROMO: "bb-retail",
      BANNERBEAR_TEMPLATE_SERVICE_BUSINESS_PROMO: "bb-service",
      BANNERBEAR_TEMPLATE_OFFER_DISCOUNT_CAMPAIGN: "bb-offer",
      TEMPLATED_IO_TEMPLATE_RETAIL_PRODUCT_PROMO: "tio-retail",
      TEMPLATED_IO_TEMPLATE_SERVICE_BUSINESS_PROMO: "tio-service",
      TEMPLATED_IO_TEMPLATE_OFFER_DISCOUNT_CAMPAIGN: "tio-offer",
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("lists all premium templates", async () => {
    const { listPremiumTemplates } = await import("./template-catalogue");
    const templates = listPremiumTemplates();
    expect(templates).toHaveLength(3);
    expect(templates.map((t) => t.id)).toEqual([
      "retail_product_promo",
      "service_business_promo",
      "offer_discount_campaign",
    ]);
  });

  it("returns a template by id", async () => {
    const { getPremiumTemplate } = await import("./template-catalogue");
    const template = getPremiumTemplate("retail_product_promo");
    expect(template).toBeDefined();
    expect(template?.defaultFormat).toBe("leaflet");
    expect(template?.formats).toContain("social_square");
  });

  it("resolves Bannerbear template IDs", async () => {
    const { resolveProviderTemplateId } = await import("./template-catalogue");
    expect(resolveProviderTemplateId("bannerbear", "retail_product_promo")).toBe("bb-retail");
    expect(resolveProviderTemplateId("bannerbear", "service_business_promo")).toBe("bb-service");
    expect(resolveProviderTemplateId("bannerbear", "offer_discount_campaign")).toBe("bb-offer");
  });

  it("resolves Templated.io template IDs", async () => {
    const { resolveProviderTemplateId } = await import("./template-catalogue");
    expect(resolveProviderTemplateId("templatedio", "retail_product_promo")).toBe("tio-retail");
    expect(resolveProviderTemplateId("templated.io", "service_business_promo")).toBe("tio-service");
  });

  it("returns undefined for unconfigured providers", async () => {
    const { resolveProviderTemplateId } = await import("./template-catalogue");
    expect(resolveProviderTemplateId("unknown", "retail_product_promo")).toBeUndefined();
  });

  it("resolves aspect ratios by format", async () => {
    const { resolveAspectRatio } = await import("./template-catalogue");
    expect(resolveAspectRatio("retail_product_promo", "leaflet")).toBe("4:5");
    expect(resolveAspectRatio("service_business_promo", "social_square")).toBe("1:1");
    expect(resolveAspectRatio("offer_discount_campaign", "social_story")).toBe("9:16");
  });

  describe("getPremiumTemplateStatus", () => {
    it("returns ready=false when the feature flag is off", async () => {
      setEnv({});
      const { getPremiumTemplateStatus } = await import("./template-catalogue");
      const status = getPremiumTemplateStatus();
      expect(status.ready).toBe(false);
      expect(status.missing).toContain("ENABLE_PREMIUM_TEMPLATE_PROVIDER");
    });

    it("returns ready=false when provider is missing", async () => {
      setEnv({ ENABLE_PREMIUM_TEMPLATE_PROVIDER: "true" });
      const { getPremiumTemplateStatus } = await import("./template-catalogue");
      const status = getPremiumTemplateStatus();
      expect(status.ready).toBe(false);
      expect(status.missing).toContain("PREMIUM_TEMPLATE_PROVIDER");
    });

    it("returns ready=false when Bannerbear API key is missing", async () => {
      setEnv({
        ENABLE_PREMIUM_TEMPLATE_PROVIDER: "true",
        PREMIUM_TEMPLATE_PROVIDER: "bannerbear",
      });
      const { getPremiumTemplateStatus } = await import("./template-catalogue");
      const status = getPremiumTemplateStatus();
      expect(status.ready).toBe(false);
      expect(status.missing).toContain("BANNERBEAR_API_KEY");
    });

    it("returns ready=false when Bannerbear template IDs are missing", async () => {
      setEnv({
        ENABLE_PREMIUM_TEMPLATE_PROVIDER: "true",
        PREMIUM_TEMPLATE_PROVIDER: "bannerbear",
        BANNERBEAR_API_KEY: "bb-key",
      });
      const { getPremiumTemplateStatus } = await import("./template-catalogue");
      const status = getPremiumTemplateStatus();
      expect(status.ready).toBe(false);
      expect(status.missing?.length).toBeGreaterThan(0);
    });

    it("returns ready=true when Bannerbear is fully configured", async () => {
      setEnv({
        ENABLE_PREMIUM_TEMPLATE_PROVIDER: "true",
        PREMIUM_TEMPLATE_PROVIDER: "bannerbear",
        BANNERBEAR_API_KEY: "bb-key",
        BANNERBEAR_TEMPLATE_RETAIL_PRODUCT_PROMO: "bb-retail",
        BANNERBEAR_TEMPLATE_SERVICE_BUSINESS_PROMO: "bb-service",
        BANNERBEAR_TEMPLATE_OFFER_DISCOUNT_CAMPAIGN: "bb-offer",
      });
      const { getPremiumTemplateStatus } = await import("./template-catalogue");
      const status = getPremiumTemplateStatus();
      expect(status.ready).toBe(true);
      expect(status.provider).toBe("bannerbear");
    });

    it("returns ready=true when Templated.io is fully configured", async () => {
      setEnv({
        ENABLE_PREMIUM_TEMPLATE_PROVIDER: "true",
        PREMIUM_TEMPLATE_PROVIDER: "templated.io",
        TEMPLATED_IO_API_KEY: "tio-key",
        TEMPLATED_IO_TEMPLATE_RETAIL_PRODUCT_PROMO: "tio-retail",
        TEMPLATED_IO_TEMPLATE_SERVICE_BUSINESS_PROMO: "tio-service",
        TEMPLATED_IO_TEMPLATE_OFFER_DISCOUNT_CAMPAIGN: "tio-offer",
      });
      const { getPremiumTemplateStatus } = await import("./template-catalogue");
      const status = getPremiumTemplateStatus();
      expect(status.ready).toBe(true);
      expect(status.provider).toBe("templated.io");
    });
  });
});
