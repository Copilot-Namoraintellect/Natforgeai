import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { TemplateRendererRequest } from "./template-renderer";

const baseRequest: TemplateRendererRequest = {
  providerTemplateId: "test-template",
  format: "leaflet",
  outputFormat: "png",
  aspectRatio: "4:5",
  businessName: "Test Business",
  logoUrl: "https://example.com/logo.png",
  brandColors: ["#FF0000", "#00FF00", "#0000FF"],
  headline: "Big Sale",
  offer: "50% off",
  subheadline: "This weekend only",
  cta: "Shop now",
  services: ["Delivery", "Quality", "Support", "Returns", "Extra"],
  contact: { website: "https://test.com", whatsapp: "123456", email: "hi@test.com", location: "Cape Town" },
  backgroundImageUrl: "https://example.com/bg.png",
};

const originalEnv = { ...process.env };

function setEnv(patch: Record<string, string>) {
  Object.keys(process.env).forEach((key) => delete process.env[key]);
  Object.assign(process.env, originalEnv, patch);
}

async function importRenderer(name: "bannerbear" | "templatedio" | "internal" | "placeholder") {
  if (name === "bannerbear") {
    const { BannerbearTemplateRenderer } = await import("./bannerbear-template-renderer");
    return new BannerbearTemplateRenderer();
  }
  if (name === "templatedio") {
    const { TemplatedIoTemplateRenderer } = await import("./templatedio-template-renderer");
    return new TemplatedIoTemplateRenderer();
  }
  if (name === "internal") {
    const { InternalTemplateRenderer } = await import("./internal-template-renderer");
    return new InternalTemplateRenderer();
  }
  const { PlaceholderTemplateRenderer } = await import("./placeholder-template-renderer");
  return new PlaceholderTemplateRenderer("bannerbear");
}

describe("PlaceholderTemplateRenderer", () => {
  beforeEach(() => {
    setEnv({});
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("is never configured", async () => {
    const renderer = await importRenderer("placeholder");
    expect(renderer.configured).toBe(false);
  });

  it("returns a clear error message", async () => {
    const renderer = await importRenderer("placeholder");
    const result = await renderer.render(baseRequest);
    expect(result.success).toBe(false);
    expect(result.error).toContain("bannerbear is not configured");
  });
});

describe("BannerbearTemplateRenderer", () => {
  beforeEach(() => {
    vi.resetModules();
    setEnv({ BANNERBEAR_API_KEY: "bb-test-key" });
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("reports configured when API key is set", async () => {
    const renderer = await importRenderer("bannerbear");
    expect(renderer.configured).toBe(true);
  });

  it("returns success with image URL on successful render", async () => {
    const { BANNERBEAR_API_BASE } = await import("./bannerbear-template-renderer");
    const fetchMock = vi.mocked(global.fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ uid: "bb-job-1", image_url_png: "https://cdn.bannerbear.com/output.png" }),
    } as any);

    const renderer = await importRenderer("bannerbear");
    const result = await renderer.render(baseRequest);

    expect(result.success).toBe(true);
    expect(result.imageUrl).toBe("https://cdn.bannerbear.com/output.png");
    expect(result.extension).toBe("png");
    expect(result.providerJobId).toBe("bb-job-1");
    expect(fetchMock).toHaveBeenCalledWith(
      `${BANNERBEAR_API_BASE}/images`,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer bb-test-key" }),
      })
    );
  });

  it("maps NatForgeAI fields to the fixed Bannerbear layer names", async () => {
    const fetchMock = vi.mocked(global.fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ uid: "bb-job-2", image_url_png: "https://cdn.bannerbear.com/output.png" }),
    } as any);

    const renderer = await importRenderer("bannerbear");
    await renderer.render(baseRequest);

    const call = fetchMock.mock.calls[0];
    const body = JSON.parse((call[1] as any).body);
    const modifications = body.modifications;
    const names = modifications.map((m: any) => m.name);

    expect(names).toContain("logo");
    expect(names).toContain("businessName");
    expect(names).toContain("headline");
    expect(names).toContain("offer");
    expect(names).toContain("subheadline");
    expect(names).toContain("cta");
    expect(names).toContain("service1");
    expect(names).toContain("service2");
    expect(names).toContain("service3");
    expect(names).toContain("service4");
    expect(names).not.toContain("service5");
    expect(names).toContain("website");
    expect(names).toContain("whatsapp");
    expect(names).toContain("email");
    expect(names).toContain("location");
    expect(names).toContain("primaryColor");
    expect(names).toContain("secondaryColor");
    expect(names).toContain("accentColor");
    expect(names).toContain("backgroundImage");

    const logoLayer = modifications.find((m: any) => m.name === "logo");
    expect(logoLayer.image_url).toBe(baseRequest.logoUrl);
  });

  it("returns failure without charging on provider error", async () => {
    vi.mocked(global.fetch).mockResolvedValue({
      ok: false,
      status: 422,
      json: async () => ({ message: "Template not found" }),
    } as any);

    const renderer = await importRenderer("bannerbear");
    const result = await renderer.render(baseRequest);

    expect(result.success).toBe(false);
    expect(result.error).toContain("Template not found");
    expect(result.imageUrl).toBeUndefined();
  });

  it("returns failure when no image URL is returned", async () => {
    vi.mocked(global.fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ uid: "bb-job-2" }),
    } as any);

    const renderer = await importRenderer("bannerbear");
    const result = await renderer.render(baseRequest);

    expect(result.success).toBe(false);
    expect(result.error).toContain("no image URL");
  });
});

describe("TemplatedIoTemplateRenderer", () => {
  beforeEach(() => {
    vi.resetModules();
    setEnv({ TEMPLATED_IO_API_KEY: "tio-test-key" });
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("reports configured when API key is set", async () => {
    const renderer = await importRenderer("templatedio");
    expect(renderer.configured).toBe(true);
  });

  it("returns success with image URL on successful render", async () => {
    const { TEMPLATED_IO_API_BASE } = await import("./templatedio-template-renderer");
    const fetchMock = vi.mocked(global.fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ id: "tio-job-1", url: "https://cdn.templated.io/output.png" }),
    } as any);

    const renderer = await importRenderer("templatedio");
    const result = await renderer.render(baseRequest);

    expect(result.success).toBe(true);
    expect(result.imageUrl).toBe("https://cdn.templated.io/output.png");
    expect(result.providerJobId).toBe("tio-job-1");
    expect(fetchMock).toHaveBeenCalledWith(
      `${TEMPLATED_IO_API_BASE}/render`,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer tio-test-key" }),
      })
    );
  });

  it("returns failure without charging on provider error", async () => {
    vi.mocked(global.fetch).mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ message: "Invalid template" }),
    } as any);

    const renderer = await importRenderer("templatedio");
    const result = await renderer.render(baseRequest);

    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid template");
  });
});

describe("InternalTemplateRenderer", () => {
  beforeEach(() => {
    vi.resetModules();
    setEnv({});
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("is always configured", async () => {
    const renderer = await importRenderer("internal");
    expect(renderer.configured).toBe(true);
    expect(renderer.name).toBe("internal-template");
  });

  it("returns success with a base64 PNG buffer", async () => {
    const renderer = await importRenderer("internal");
    const request: TemplateRendererRequest = {
      ...baseRequest,
      logoUrl: "",
      providerTemplateId: "service_business_promo",
    };
    const result = await renderer.render(request);

    expect(result.success).toBe(true);
    expect(result.imageBase64).toBeTruthy();
    expect(result.extension).toBe("png");
    expect(result.providerJobId).toMatch(/^nf-internal-/);
  });

  it("renders with a fetched logo", async () => {
    // 1x1 transparent PNG
    const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const logoBuf = Buffer.from(pngBase64, "base64");
    vi.mocked(global.fetch).mockResolvedValue({
      ok: true,
      arrayBuffer: async () => logoBuf.buffer.slice(logoBuf.byteOffset, logoBuf.byteOffset + logoBuf.byteLength),
    } as any);

    const renderer = await importRenderer("internal");
    const request: TemplateRendererRequest = {
      ...baseRequest,
      providerTemplateId: "retail_product_promo",
    };
    const result = await renderer.render(request);

    expect(result.success).toBe(true);
    expect(result.imageBase64).toBeTruthy();
  });

  it("returns failure for an unknown template", async () => {
    const renderer = await importRenderer("internal");
    const request: TemplateRendererRequest = {
      ...baseRequest,
      providerTemplateId: "unknown_template",
    };
    const result = await renderer.render(request);

    expect(result.success).toBe(false);
    expect(result.error).toContain("Unknown internal template");
  });
});
