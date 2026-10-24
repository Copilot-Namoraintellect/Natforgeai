import { describe, it, expect } from "vitest";
import {
  deriveSignalKey,
  deriveSignalKeyParts,
  buildProviderEvidenceHash,
  canonicalizeForHash,
  normalizeExternalIdentity,
  sanitizeContentText,
  sanitizeBoundedText,
  timestampFromEpochSeconds,
  timestampFromIsoDateTime,
  isSocialSignalProvider,
  isSocialSignalPlatform,
  isSocialSignalType,
  isSocialSignalAttributionType,
  SIGNAL_KEY_PREFIX,
  SignalContractError,
} from "./signal-contract";

describe("signal identity formula", () => {
  it("is deterministic for the same logical provider event", () => {
    const a = deriveSignalKey({
      provider: "meta",
      providerAccountId: "page-1",
      externalEventId: "comment-9",
    });
    const b = deriveSignalKey({
      provider: "meta",
      providerAccountId: "page-1",
      externalEventId: "comment-9",
    });
    expect(a).toBe(b);
    expect(a.startsWith(SIGNAL_KEY_PREFIX)).toBe(true);
    expect(a.length).toBe(6 + 64);
  });

  it("differs across providers, accounts, and event ids (no collisions)", () => {
    const base = { provider: "meta", providerAccountId: "page-1", externalEventId: "ev-1" };
    const key = deriveSignalKey(base);
    expect(deriveSignalKey({ ...base, provider: "linkedin" })).not.toBe(key);
    expect(deriveSignalKey({ ...base, providerAccountId: "page-2" })).not.toBe(key);
    expect(deriveSignalKey({ ...base, externalEventId: "ev-2" })).not.toBe(key);
    // Same external id from a different provider/account never collides (A3 req 6).
    expect(deriveSignalKey({ ...base, externalEventId: "ev-1" })).toBe(key);
  });

  it("delimiter-bearing components never collide across different triples", () => {
    expect(deriveSignalKeyParts({ provider: "a", providerAccountId: "b|c", externalEventId: "d" }))
      .not.toBe(deriveSignalKeyParts({ provider: "a|b", providerAccountId: "c", externalEventId: "d" }));
  });
});

describe("provider evidence hash", () => {
  it("is stable regardless of key order", () => {
    const a = buildProviderEvidenceHash({ b: 2, a: { d: 4, c: 3 } });
    const b = buildProviderEvidenceHash({ a: { c: 3, d: 4 }, b: 2 });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when evidence content changes (immutability tripwire)", () => {
    const a = buildProviderEvidenceHash({ text: "hello" });
    const b = buildProviderEvidenceHash({ text: "hellO" });
    expect(a).not.toBe(b);
  });

  it("canonicalizeForHash sorts nested keys", () => {
    expect(canonicalizeForHash({ x: [{ k: 1, j: 2 }] })).toBe(
      '{"x":[{"j":2,"k":1}]}'
    );
  });
});

describe("external identity normalization (fail closed)", () => {
  it("accepts clean ids", () => {
    expect(normalizeExternalIdentity(" comment-42 ", "externalEventId")).toBe("comment-42");
  });

  it.each([
    ["non-string", 42],
    ["empty", "   "],
    ["oversized", "x".repeat(256)],
    ["control characters", "bad\x00id"],
    ["newline injection", "bad\nid"],
  ])("rejects %s", (_label, value) => {
    try {
      normalizeExternalIdentity(value, "externalEventId");
      expect.unreachable("expected SignalContractError");
    } catch (err) {
      expect(err).toBeInstanceOf(SignalContractError);
      expect((err as SignalContractError).code).toBe("MALFORMED_SIGNAL");
    }
  });
});

describe("content text sanitization (bounded, minimized)", () => {
  it("bounds text to the documented maximum with ellipsis", () => {
    const long = "a".repeat(2000);
    const out = sanitizeContentText(long)!;
    expect(out.length).toBe(1024);
    expect(out.endsWith("...")).toBe(true);
  });

  it("strips control characters and null bytes, nulls empty", () => {
    expect(sanitizeContentText("hi\x00there\x0b")).toBe("hithere");
    expect(sanitizeContentText("   ")).toBeNull();
    expect(sanitizeContentText(null)).toBeNull();
    expect(sanitizeContentText(undefined)).toBeNull();
    expect(sanitizeContentText(42 as unknown)).toBeNull();
  });
});

describe("bounded text fields", () => {
  it("rejects oversized display names / references", () => {
    expect(() => sanitizeBoundedText("x".repeat(256), 255, "actorDisplayName")).toThrow(
      SignalContractError
    );
    expect(sanitizeBoundedText("Ava", 255, "actorDisplayName")).toBe("Ava");
    expect(sanitizeBoundedText(null, 255, "actorDisplayName")).toBeNull();
    expect(() => sanitizeBoundedText(7 as unknown, 255, "actorDisplayName")).toThrow(
      SignalContractError
    );
  });
});

describe("timestamp conversion", () => {
  it("converts valid epoch seconds", () => {
    expect(timestampFromEpochSeconds(1700000000, "ts").toISOString()).toBe(
      new Date(1700000000000).toISOString()
    );
  });

  it("fails closed on invalid timestamps by default", () => {
    expect(() => timestampFromEpochSeconds("abc", "ts")).toThrow(SignalContractError);
    expect(() => timestampFromEpochSeconds(-5, "ts")).toThrow(SignalContractError);
    expect(() => timestampFromIsoDateTime("not-a-date", "ts")).toThrow(SignalContractError);
  });

  it("supports explicit now fallback only when opted in", () => {
    const before = Date.now();
    expect(timestampFromEpochSeconds(undefined, "ts", "now").getTime()).toBeGreaterThanOrEqual(before);
    expect(timestampFromIsoDateTime(undefined, "ts", "now")).toBeInstanceOf(Date);
  });
});

describe("enum guards", () => {
  it("accepts known values and rejects unknown", () => {
    expect(isSocialSignalProvider("meta")).toBe(true);
    expect(isSocialSignalProvider("facebook")).toBe(false);
    expect(isSocialSignalPlatform("instagram")).toBe(true);
    expect(isSocialSignalPlatform("pinterest")).toBe(false);
    expect(isSocialSignalType("comment")).toBe(true);
    expect(isSocialSignalType("smile")).toBe(false);
    expect(isSocialSignalAttributionType("direct")).toBe(true);
    expect(isSocialSignalAttributionType("guessed")).toBe(false);
  });
});
