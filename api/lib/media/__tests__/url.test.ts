import { describe, it, expect } from "vitest";
import { resolvePublicImageUrl } from "../url";

const BASE_URL = "https://natforgeai.com";

describe("resolvePublicImageUrl", () => {
  it("returns null for empty/null URLs", () => {
    expect(resolvePublicImageUrl(null, BASE_URL)).toEqual({
      publicUrl: null,
      isAbsoluteUrl: false,
      valid: true,
    });
    expect(resolvePublicImageUrl("", BASE_URL)).toEqual({
      publicUrl: null,
      isAbsoluteUrl: false,
      valid: true,
    });
  });

  it("turns a relative /generated/images path into an absolute public URL", () => {
    const result = resolvePublicImageUrl(
      "/generated/images/27/premium-leaflet-ai_38f59991-4a9a-4f2e-aa47-c47efdb72924.png",
      BASE_URL
    );
    expect(result.isAbsoluteUrl).toBe(false);
    expect(result.valid).toBe(true);
    expect(result.publicUrl).toBe(
      "https://natforgeai.com/generated/images/27/premium-leaflet-ai_38f59991-4a9a-4f2e-aa47-c47efdb72924.png"
    );
  });

  it("keeps an absolute HTTPS URL as-is", () => {
    const url = "https://cdn.example.com/image.png";
    const result = resolvePublicImageUrl(url, BASE_URL);
    expect(result.publicUrl).toBe(url);
    expect(result.isAbsoluteUrl).toBe(true);
    expect(result.valid).toBe(true);
  });

  it("rejects localhost URLs", () => {
    expect(resolvePublicImageUrl("http://localhost:5173/image.png", BASE_URL).valid).toBe(false);
    expect(resolvePublicImageUrl("https://127.0.0.1/image.png", BASE_URL).valid).toBe(false);
  });

  it("rejects blob URLs", () => {
    expect(resolvePublicImageUrl("blob:https://natforgeai.com/abc", BASE_URL).valid).toBe(false);
  });

  it("rejects data URLs", () => {
    expect(resolvePublicImageUrl("data:image/png;base64,abc", BASE_URL).valid).toBe(false);
  });

  it("rejects Windows-style local paths", () => {
    expect(resolvePublicImageUrl("C:\\Users\\image.png", BASE_URL).valid).toBe(false);
    expect(resolvePublicImageUrl("\\\\server\\share\\image.png", BASE_URL).valid).toBe(false);
  });

  it("rejects malformed URLs", () => {
    expect(resolvePublicImageUrl("not a valid url", BASE_URL).valid).toBe(false);
  });
});
