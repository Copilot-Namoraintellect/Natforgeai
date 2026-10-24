import { describe, expect, it } from "vitest";
import { InterpretationInputError } from "./interpretation-contract";
import { toCanonicalSignal } from "./canonical-signal";
import { MAX_SOCIAL_TEXT_CHARS, excerptOf, sanitizeSignalText, sanitizeSocialText } from "./input-safety";

describe("sanitizeSocialText", () => {
  it("NFC-normalizes decomposed unicode", () => {
    const decomposed = "café".normalize("NFD");
    expect(decomposed).not.toBe("café");
    const sanitized = sanitizeSocialText(decomposed);
    expect(sanitized).toBe("café");
    expect(sanitized.normalize("NFC")).toBe(sanitized);
  });

  it("strips zero-width and Unicode Cf format characters", () => {
    const withZeroWidth = "hel\u200Blo wor\u200Dld\uFEFF";
    expect(sanitizeSocialText(withZeroWidth)).toBe("hello world");
  });

  it("strips C0 control characters except tab and newline", () => {
    const noisy = "a\x00b\x01c\x07d\re\tf\ng";
    expect(sanitizeSocialText(noisy)).toBe("abcde\tf\ng");
  });

  it("rejects lone high surrogates with MALFORMED_UNICODE", () => {
    try {
      sanitizeSocialText("hello \uD800 world");
      expect.unreachable("expected malformed-unicode rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(InterpretationInputError);
      expect((error as InterpretationInputError).code).toBe("MALFORMED_UNICODE");
    }
  });

  it("rejects lone low surrogates with MALFORMED_UNICODE", () => {
    expect(() => sanitizeSocialText("trailing \uDC00")).toThrowError(
      expect.objectContaining({ code: "MALFORMED_UNICODE" })
    );
  });

  it("accepts well-formed surrogate pairs (emoji)", () => {
    expect(sanitizeSocialText("love this 😀 product")).toBe("love this 😀 product");
  });

  it("enforces the 4000-char post-normalization cap with OVERSIZED_INPUT", () => {
    const oversize = "a".repeat(MAX_SOCIAL_TEXT_CHARS + 1);
    try {
      sanitizeSocialText(oversize);
      expect.unreachable("expected oversize rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(InterpretationInputError);
      expect((error as InterpretationInputError).code).toBe("OVERSIZED_INPUT");
    }
  });

  it("allows text exactly at the cap and allows an empty result", () => {
    expect(sanitizeSocialText("a".repeat(MAX_SOCIAL_TEXT_CHARS))).toHaveLength(MAX_SOCIAL_TEXT_CHARS);
    expect(sanitizeSocialText("\u200B\u200B")).toBe("");
  });
});

describe("sanitizeSignalText", () => {
  it("maps null text to the empty string and keeps other canonical fields", () => {
    const signal = toCanonicalSignal({
      signalId: "sig-1",
      signalVersion: 2,
      signalType: "reaction",
      platform: "facebook",
      text: null,
    });
    const sanitized = sanitizeSignalText(signal);
    expect(sanitized.text).toBe("");
    expect(sanitized.signalId).toBe("sig-1");
    expect(sanitized.signalVersion).toBe(2);
    expect(sanitized.actorHandle).toBeNull();
    expect(sanitized.occurredAt).toBeNull();
  });

  it("sanitizes present text and rejects oversize text", () => {
    const signal = toCanonicalSignal({
      signalId: "sig-2",
      signalVersion: 1,
      signalType: "comment",
      platform: "twitter",
      text: "hi\u200B there",
    });
    expect(sanitizeSignalText(signal).text).toBe("hi there");
    const oversize = toCanonicalSignal({
      signalId: "sig-3",
      signalVersion: 1,
      signalType: "comment",
      platform: "twitter",
      text: "b".repeat(MAX_SOCIAL_TEXT_CHARS + 1),
    });
    expect(() => sanitizeSignalText(oversize)).toThrowError(
      expect.objectContaining({ code: "OVERSIZED_INPUT" })
    );
  });
});

describe("excerptOf", () => {
  it("returns trimmed text when within bounds", () => {
    expect(excerptOf("  short text  ")).toBe("short text");
    expect(excerptOf("x".repeat(160))).toHaveLength(160);
  });

  it("bounds long text to maxLen and never splits a surrogate pair", () => {
    const long = "ab".repeat(200); // 400 chars
    const excerpt = excerptOf(long);
    expect(excerpt.length).toBeLessThanOrEqual(160);

    const emojiHeavy = "😀".repeat(100); // 200 code units, all surrogate pairs
    const emojiExcerpt = excerptOf(emojiHeavy);
    expect(emojiExcerpt.length).toBeLessThanOrEqual(160);
    expect(emojiExcerpt.length % 2).toBe(0);
    expect(() => sanitizeSocialText(emojiExcerpt)).not.toThrow();
  });

  it("honours a custom maxLen", () => {
    const excerpt = excerptOf("word ".repeat(50), 20);
    expect(excerpt.length).toBeLessThanOrEqual(20);
  });
});
