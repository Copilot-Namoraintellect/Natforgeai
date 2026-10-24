import { describe, expect, it } from "vitest";
import {
  adaptSocialSignal,
  ATTRIBUTION_TYPE_VALUES,
  NON_TEXT_BEARING_SIGNAL_TYPES,
  PLATFORM_VALUES,
  PROVIDER_VALUES,
  SIGNAL_TYPE_VALUES,
  TEXT_BEARING_SIGNAL_TYPES,
  toCanonicalSignal,
  type SocialSignalRowLike,
} from "./canonical-signal";
import { InterpretationInputError } from "./interpretation-contract";

describe("frozen R5-A vocabularies", () => {
  it("has the 11 frozen signal types with the aligned text-bearing split", () => {
    expect(SIGNAL_TYPE_VALUES).toEqual([
      "comment",
      "reply",
      "mention",
      "reaction",
      "direct_message",
      "repost",
      "follow",
      "unfollow",
      "campaign_response",
      "inbound_message",
      "unknown",
    ]);
    expect(TEXT_BEARING_SIGNAL_TYPES).toEqual([
      "comment",
      "reply",
      "mention",
      "direct_message",
      "campaign_response",
      "inbound_message",
    ]);
    // Derived complement minus unknown.
    expect(NON_TEXT_BEARING_SIGNAL_TYPES).toEqual([
      "reaction",
      "repost",
      "follow",
      "unfollow",
    ]);
  });

  it("has the frozen provider/platform/attribution enums", () => {
    expect(PROVIDER_VALUES).toEqual(["meta", "linkedin", "twitter", "tiktok"]);
    expect(PLATFORM_VALUES).toEqual([
      "facebook",
      "instagram",
      "whatsapp",
      "linkedin",
      "twitter",
      "tiktok",
    ]);
    expect(ATTRIBUTION_TYPE_VALUES).toEqual(["direct", "business", "unattributed"]);
  });
});

describe("aligned input schema", () => {
  it("requires provider and attributionType", () => {
    expect(() =>
      toCanonicalSignal({
        signalId: "sig-x",
        signalVersion: 1,
        signalType: "comment",
        platform: "instagram",
        contentText: "hello",
      } as never)
    ).toThrow(InterpretationInputError);
    expect(() =>
      toCanonicalSignal({
        signalId: "sig-x",
        signalVersion: 1,
        signalType: "comment",
        provider: "meta",
        platform: "instagram",
        attributionType: "guessed",
      } as never)
    ).toThrow(InterpretationInputError);
  });

  it("enforces the frozen 1024-char contentText bound at the schema boundary", () => {
    expect(() =>
      toCanonicalSignal({
        signalId: "sig-x",
        signalVersion: 1,
        signalType: "comment",
        provider: "meta",
        platform: "instagram",
        attributionType: "unattributed",
        contentText: "a".repeat(1025),
      })
    ).toThrow(InterpretationInputError);
  });

  it("validates providerEvidenceHash format when present", () => {
    expect(() =>
      toCanonicalSignal({
        signalId: "sig-x",
        signalVersion: 1,
        signalType: "comment",
        provider: "meta",
        platform: "instagram",
        attributionType: "unattributed",
        providerEvidenceHash: "not-hex",
      })
    ).toThrow(InterpretationInputError);
  });
});

describe("adaptSocialSignal — structural R5-A convergence seam", () => {
  function rowLike(overrides: Partial<SocialSignalRowLike> = {}): SocialSignalRowLike {
    return {
      signalKey: "sigv1:abc123",
      ingestionVersion: 1,
      signalType: "comment",
      provider: "meta",
      platform: "instagram",
      actorReference: "actor-900",
      actorDisplayName: "Jane Q",
      contentText: "Loved the new spring collection",
      contentReference: "https://instagram.example/p/xyz",
      occurredAt: new Date("2026-06-20T12:00:00.000Z"),
      observedAt: "2026-06-20T12:00:07.000Z",
      attributionType: "business",
      sourceCampaignId: 42,
      parentExternalObjectId: "parent-1",
      providerEvidenceHash: "f".repeat(64),
      ...overrides,
    };
  }

  it("maps a row-like fixture onto the aligned input shape (Date → ISO)", () => {
    const adapted = adaptSocialSignal(rowLike());
    expect(adapted).toEqual({
      signalId: "sigv1:abc123",
      signalVersion: 1,
      signalType: "comment",
      provider: "meta",
      platform: "instagram",
      actorReference: "actor-900",
      actorDisplayName: "Jane Q",
      contentText: "Loved the new spring collection",
      contentReference: "https://instagram.example/p/xyz",
      occurredAt: "2026-06-20T12:00:00.000Z",
      observedAt: "2026-06-20T12:00:07.000Z",
      attributionType: "business",
      sourceCampaignId: 42,
      parentExternalObjectId: "parent-1",
      providerEvidenceHash: "f".repeat(64),
    });
    // And the adapted input validates through the strict schema.
    const canonical = toCanonicalSignal(adapted);
    expect(canonical.signalId).toBe("sigv1:abc123");
    expect(canonical.contentText).toBe("Loved the new spring collection");
  });

  it("fails closed on a missing/null signalKey", () => {
    expect(() => adaptSocialSignal(rowLike({ signalKey: null as never }))).toThrowError(
      expect.objectContaining({ code: "INVALID_SIGNAL_INPUT" })
    );
    expect(() => adaptSocialSignal(rowLike({ signalKey: "  " }))).toThrowError(
      expect.objectContaining({ code: "INVALID_SIGNAL_INPUT" })
    );
  });

  it("fails closed on a null required evidence hash and invalid enum values", () => {
    expect(() =>
      adaptSocialSignal(rowLike({ providerEvidenceHash: null as never }))
    ).toThrowError(expect.objectContaining({ code: "INVALID_SIGNAL_INPUT" }));
    expect(() => adaptSocialSignal(rowLike({ provider: "snapchat" }))).toThrowError(
      expect.objectContaining({ code: "INVALID_SIGNAL_INPUT" })
    );
    expect(() => adaptSocialSignal(rowLike({ signalType: "story" }))).toThrowError(
      expect.objectContaining({ code: "UNSUPPORTED_SIGNAL_TYPE" })
    );
  });

  it("rejects invalid Date timestamps fail-closed", () => {
    expect(() =>
      adaptSocialSignal(rowLike({ occurredAt: new Date("not-a-date") }))
    ).toThrowError(expect.objectContaining({ code: "INVALID_SIGNAL_INPUT" }));
  });
});
