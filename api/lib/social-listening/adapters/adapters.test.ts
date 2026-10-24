import { describe, it, expect, vi } from "vitest";
import { createHmac } from "crypto";
import { MetaListeningAdapter } from "./meta-listening-adapter";
import { LinkedInListeningAdapter } from "./linkedin-listening-adapter";
import {
  getListeningAdapter,
  resolveListeningMechanism,
  isPlatformListenable,
} from "./index";
import { MAX_EVENTS_PER_PAYLOAD } from "./types";
import { SignalContractError } from "../signal-contract";

const APP_SECRET = "listening-test-secret";

function sign(rawBody: string): string {
  return `sha256=${createHmac("sha256", APP_SECRET).update(rawBody, "utf8").digest("hex")}`;
}

describe("MetaListeningAdapter authenticity", () => {
  const adapter = new MetaListeningAdapter();
  const rawBody = JSON.stringify({ object: "page", entry: [] });

  it("accepts a valid X-Hub-Signature-256", () => {
    expect(
      adapter.verifyWebhookAuthenticity({
        rawBody,
        headers: { "x-hub-signature-256": sign(rawBody) },
        appSecret: APP_SECRET,
      })
    ).toBe(true);
  });

  it.each([
    ["missing signature", {}],
    ["wrong secret", { "x-hub-signature-256": sign(rawBody) }],
    ["garbage signature", { "x-hub-signature-256": "sha256=deadbeef" }],
  ])("rejects %s", (_label, headers) => {
    const secret = _label === "wrong secret" ? "other-secret" : APP_SECRET;
    expect(
      adapter.verifyWebhookAuthenticity({ rawBody, headers, appSecret: secret })
    ).toBe(false);
  });

  it("fails closed with empty secret", () => {
    expect(
      adapter.verifyWebhookAuthenticity({
        rawBody,
        headers: { "x-hub-signature-256": sign(rawBody) },
        appSecret: "",
      })
    ).toBe(false);
  });
});

describe("MetaListeningAdapter payload parsing", () => {
  const adapter = new MetaListeningAdapter();

  it("normalizes a top-level page comment", () => {
    const payload = {
      object: "page",
      entry: [
        {
          id: "page-1",
          changes: [
            {
              field: "comments",
              value: {
                id: "c-1",
                from: { id: "user-9", name: "Ava" },
                message: "Love this!",
                post_id: "post-1",
                parent_id: "post-1",
                created_time: "2026-07-01T10:00:00+0000",
                permalink_url: "https://facebook.com/post-1/c-1",
              },
            },
          ],
        },
      ],
    };
    const events = adapter.parseWebhookPayload("facebook", payload);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      providerAccountId: "page-1",
      externalEventId: "c-1",
      externalObjectId: "post-1",
      parentExternalObjectId: "post-1",
      signalType: "comment",
      actorReference: "user-9",
      actorDisplayName: "Ava",
      contentReference: "https://facebook.com/post-1/c-1",
      contentText: "Love this!",
    });
    expect(events[0].occurredAt.toISOString()).toBe("2026-07-01T10:00:00.000Z");
  });

  it("normalizes a threaded reply when parent differs from post", () => {
    const payload = {
      object: "page",
      entry: [
        {
          id: "page-1",
          changes: [
            {
              field: "comments",
              value: {
                id: "c-2",
                from: { id: "user-9" },
                message: "replying",
                post_id: "post-1",
                parent_id: "c-1",
                created_time: "2026-07-01T11:00:00+0000",
              },
            },
          ],
        },
      ],
    };
    const [event] = adapter.parseWebhookPayload("facebook", payload);
    expect(event.signalType).toBe("reply");
    expect(event.parentExternalObjectId).toBe("c-1");
  });

  it("normalizes inbound direct messages and skips own echoes", () => {
    const payload = {
      object: "page",
      entry: [
        {
          id: "page-1",
          messaging: [
            {
              sender: { id: "user-9", name: "Ava" },
              message: { mid: "m-1", text: "Do you deliver?" },
              timestamp: 1700000000,
            },
            {
              sender: { id: "page-1" },
              message: { mid: "m-echo", text: "our own outbound" },
              timestamp: 1700000001,
            },
          ],
        },
      ],
    };
    const events = adapter.parseWebhookPayload("whatsapp", payload);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      signalType: "direct_message",
      externalEventId: "m-1",
      contentText: "Do you deliver?",
    });
  });

  it.each([
    ["reaction", "reaction"],
    ["share", "repost"],
    ["mention", "mention"],
    ["unknown_item", "unknown"],
  ])("maps feed item %s → %s", (item, expected) => {
    const payload = {
      object: "page",
      entry: [
        {
          id: "page-1",
          changes: [
            {
              field: "feed",
              value: {
                item,
                post_id: "post-9",
                from: { id: "user-2" },
                created_time: "2026-07-01T12:00:00+0000",
              },
            },
          ],
        },
      ],
    };
    const [event] = adapter.parseWebhookPayload("facebook", payload);
    expect(event.signalType).toBe(expected);
  });

  it("skips events missing identity but fails closed on malformed identity", () => {
    const missing = {
      object: "page",
      entry: [
        {
          id: "page-1",
          changes: [
            { field: "comments", value: { from: { id: "user-2" }, message: "no id" } },
          ],
        },
      ],
    };
    expect(adapter.parseWebhookPayload("facebook", missing)).toHaveLength(0);

    const malformed = {
      object: "page",
      entry: [
        {
          id: "page-1",
          changes: [
            {
              field: "comments",
              value: {
                id: "bad\x00id",
                from: { id: "user-2" },
                message: "tampered",
                post_id: "post-1",
                parent_id: "post-1",
                created_time: "2026-07-01T12:00:00+0000",
              },
            },
          ],
        },
      ],
    };
    expect(() => adapter.parseWebhookPayload("facebook", malformed)).toThrow(
      SignalContractError
    );
  });

  it("ignores unmapped platforms and caps events per payload", () => {
    expect(adapter.parseWebhookPayload("twitter", {})).toHaveLength(0);

    const big = {
      object: "page",
      entry: Array.from({ length: MAX_EVENTS_PER_PAYLOAD + 20 }, (_, i) => ({
        id: `page-${i}`,
        changes: [
          {
            field: "comments",
            value: {
              id: `c-${i}`,
              from: { id: "u" },
              message: "x",
              post_id: "p",
              parent_id: "p",
              created_time: "2026-07-01T12:00:00+0000",
            },
          },
        ],
      })),
    };
    expect(adapter.parseWebhookPayload("facebook", big).length).toBeLessThanOrEqual(
      MAX_EVENTS_PER_PAYLOAD
    );
  });

  it("polling fetch fails closed without a configured seam", async () => {
    await expect(
      adapter.fetchEvents({
        platform: "facebook",
        providerAccountId: "page-1",
        accessToken: "t",
        cursor: null,
        limit: 25,
      })
    ).rejects.toThrow(/LISTENING_NOT_CONFIGURED/);
  });
});

describe("LinkedInListeningAdapter", () => {
  it("reports webhook unsupported and fails closed", () => {
    const adapter = new LinkedInListeningAdapter();
    expect(
      adapter.verifyWebhookAuthenticity({
        rawBody: "{}",
        headers: {},
        appSecret: "x",
      })
    ).toBe(false);
    expect(adapter.parseWebhookPayload()).toEqual([]);
  });

  it("polling fails closed without injected fetcher, uses it when present", async () => {
    const bare = new LinkedInListeningAdapter();
    await expect(
      bare.fetchEvents({
        platform: "linkedin",
        providerAccountId: "org-1",
        accessToken: "t",
        cursor: null,
        limit: 10,
      })
    ).rejects.toThrow(SignalContractError);

    const fetcher = vi.fn().mockResolvedValue({ events: [], nextCursor: "c2" });
    const injected = new LinkedInListeningAdapter(fetcher);
    const out = await injected.fetchEvents({
      platform: "linkedin",
      providerAccountId: "org-1",
      accessToken: "t",
      cursor: "c1",
      limit: 10,
    });
    expect(out.nextCursor).toBe("c2");
    expect(fetcher).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: "c1", limit: 10 })
    );
  });
});

describe("adapter registry", () => {
  it("resolves registered providers and fails closed on unknown", () => {
    expect(getListeningAdapter("meta").provider).toBe("meta");
    expect(getListeningAdapter("linkedin").provider).toBe("linkedin");
    try {
      getListeningAdapter("myspace");
      expect.unreachable("expected SignalContractError");
    } catch (err) {
      expect(err).toBeInstanceOf(SignalContractError);
      expect((err as SignalContractError).code).toBe("UNKNOWN_PROVIDER");
    }
  });

  it("resolves per-platform mechanisms, unsupported otherwise", () => {
    expect(resolveListeningMechanism("meta", "facebook")).toMatchObject({
      kind: "supported",
      capability: { webhook: "supported", polling: "supported" },
    });
    expect(resolveListeningMechanism("linkedin", "linkedin")).toMatchObject({
      kind: "supported",
      capability: { webhook: "unsupported", polling: "supported" },
    });
    expect(resolveListeningMechanism("meta", "pinterest")).toMatchObject({
      kind: "unsupported",
    });
    expect(resolveListeningMechanism("nope", "facebook")).toMatchObject({
      kind: "unsupported",
    });
    expect(isPlatformListenable("meta", "whatsapp")).toBe(true);
    expect(isPlatformListenable("twitter", "twitter")).toBe(false);
  });
});
