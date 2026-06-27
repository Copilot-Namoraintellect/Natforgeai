import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import sharp from "sharp";
import type { TemplateRendererRequest } from "./template-renderer";

const originalEnv = { ...process.env };
delete originalEnv.OPENAI_API_KEY;

function setEnv(patch: Record<string, string>) {
  Object.keys(process.env).forEach((key) => delete process.env[key]);
  Object.assign(process.env, originalEnv, patch);
}

async function createBackgroundBuffer(): Promise<Buffer> {
  return sharp({
    create: { width: 1024, height: 1536, channels: 3, background: { r: 60, g: 80, b: 120 } },
  })
    .png()
    .toBuffer();
}

async function createLogoBuffer(): Promise<Buffer> {
  return sharp({
    create: { width: 200, height: 100, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
  })
    .png()
    .toBuffer();
}

const baseRequest: TemplateRendererRequest = {
  providerTemplateId: "openai-hybrid-service_business_promo",
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
  services: ["Delivery", "Quality", "Support"],
  contact: { website: "https://test.com", whatsapp: "123456" },
};

describe("OpenAiLeafletRenderer", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("is configured when OPENAI_API_KEY is set", async () => {
    setEnv({ OPENAI_API_KEY: "sk-test" });
    const { OpenAiLeafletRenderer } = await import("./openai-leaflet-renderer");
    const renderer = new OpenAiLeafletRenderer();
    expect(renderer.configured).toBe(true);
  });

  it("is not configured when OPENAI_API_KEY is missing", async () => {
    setEnv({});
    const { OpenAiLeafletRenderer } = await import("./openai-leaflet-renderer");
    const renderer = new OpenAiLeafletRenderer();
    expect(renderer.configured).toBe(false);
  });

  it("returns a clear error when not configured", async () => {
    setEnv({});
    const { OpenAiLeafletRenderer } = await import("./openai-leaflet-renderer");
    const renderer = new OpenAiLeafletRenderer();
    const result = await renderer.render(baseRequest);
    expect(result.success).toBe(false);
    expect(result.error).toContain("OpenAI API key is not configured");
  });

  it("returns a composed PNG when OpenAI returns a base64 background", async () => {
    setEnv({ OPENAI_API_KEY: "sk-test" });
    const backgroundBuffer = await createBackgroundBuffer();
    const logoBuffer = await createLogoBuffer();
    const b64 = backgroundBuffer.toString("base64");

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "https://api.openai.com/v1/images/generations") {
        return {
          ok: true,
          json: async () => ({
            data: [{ b64_json: b64 }],
            usage: { total_tokens: 1000 },
          }),
        } as any;
      }
      if (url === "https://example.com/logo.png") {
        return {
          ok: true,
          arrayBuffer: async () => logoBuffer.buffer.slice(logoBuffer.byteOffset, logoBuffer.byteOffset + logoBuffer.byteLength),
        } as any;
      }
      return { ok: false, status: 404 } as any;
    });
    vi.stubGlobal("fetch", fetchMock);

    const { OpenAiLeafletRenderer } = await import("./openai-leaflet-renderer");
    const renderer = new OpenAiLeafletRenderer();
    const result = await renderer.render(baseRequest);

    expect(result.success).toBe(true);
    expect(result.extension).toBe("png");
    expect(result.imageBase64).toBeTruthy();
    expect(result.providerJobId).toBeTruthy();

    const meta = await sharp(Buffer.from(result.imageBase64!, "base64")).metadata();
    expect(meta.format).toBe("png");
    expect(meta.width).toBe(1080);
    expect(meta.height).toBe(1350);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/images/generations",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("returns failure when OpenAI generation fails", async () => {
    setEnv({ OPENAI_API_KEY: "sk-test" });
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 429,
      json: async () => ({ error: { message: "Rate limit" } }),
    } as any));
    vi.stubGlobal("fetch", fetchMock);

    const { OpenAiLeafletRenderer } = await import("./openai-leaflet-renderer");
    const renderer = new OpenAiLeafletRenderer();
    const result = await renderer.render(baseRequest);

    expect(result.success).toBe(false);
    expect(result.error).toContain("Rate limit");
  });
});
