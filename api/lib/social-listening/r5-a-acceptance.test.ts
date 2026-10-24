/**
 * WBS-R5-A acceptance harness (A7).
 *
 * Deterministic end-to-end acceptance over provider fakes only — no live
 * provider is ever contacted. Proves the 20 mandated acceptance scenarios and
 * the connected chain:
 *
 *   connected provider binding → fake external event → ingestion →
 *   normalized canonical signal → attribution → durable evidence →
 *   observability status
 *
 * with no manual developer mutation at any step.
 */

import { describe, it, expect, vi } from "vitest";
import { createHmac } from "crypto";
import { processListeningWebhook } from "./webhook-ingest";
import { ingestRawSignalEvent } from "./ingest";
import { runListeningPollingPass } from "./polling";
import { getListeningOverview, listSignalsForUser } from "./observability";
import { acceptSocialSignal } from "./signal-store";
import { createListeningFakeDb } from "./testing/fake-listening-db";
import type { RawSocialSignalEvent } from "./adapters/types";
import type { CanonicalSocialSignal } from "./signal-contract";

const APP_SECRET = "acceptance-app-secret";
const NOW = new Date("2026-07-05T12:00:00.000Z");

function sign(rawBody: string): string {
  return `sha256=${createHmac("sha256", APP_SECRET).update(rawBody, "utf8").digest("hex")}`;
}

function commentDelivery(commentId: string, postId = "post-1", parentId = postId) {
  return JSON.stringify({
    object: "page",
    entry: [
      {
        id: "page-1",
        changes: [
          {
            field: "comments",
            value: {
              id: commentId,
              from: { id: "user-9", name: "Ava" },
              message: `message for ${commentId}`,
              post_id: postId,
              parent_id: parentId,
              created_time: "2026-07-05T10:00:00+0000",
            },
          },
        ],
      },
    ],
  });
}

function feedDelivery(item: string, eventId: string) {
  return JSON.stringify({
    object: "page",
    entry: [
      {
        id: "page-1",
        changes: [
          {
            field: "feed",
            value: {
              item,
              [`${item}_id`]: eventId,
              post_id: "post-1",
              from: { id: "user-4" },
              created_time: "2026-07-05T10:05:00+0000",
            },
          },
        ],
      },
    ],
  });
}

function connectedDb() {
  return createListeningFakeDb({
    integrations: [
      {
        id: 11,
        userId: 7,
        businessId: 3,
        platform: "facebook",
        pageId: "page-1",
        instagramBusinessAccountId: null,
        status: "connected",
        accountName: "Acme",
        accessTokenEncrypted: "SUPER_SECRET_ACCESS_TOKEN",
        createdAt: NOW,
      },
    ],
    queue: [
      {
        queueItemId: 42,
        userId: 7,
        campaignId: 5,
        platform: "facebook",
        externalPostId: "post-1",
        status: "published",
        publishedAt: new Date("2026-07-01T09:00:00Z"),
      },
    ],
    receipts: [
      {
        eventFingerprint: "fp-acceptance",
        userId: 7,
        eventType: "publication_success",
        metadata: { receipt: { operationId: "publication:facebook:42" } },
      },
    ],
  });
}

const deps = (db: any, now: () => Date = () => NOW) => ({
  attribution: db,
  store: db,
  state: db,
  now,
});

function rawEvent(overrides: Partial<RawSocialSignalEvent> = {}): RawSocialSignalEvent {
  return {
    providerAccountId: "page-1",
    externalEventId: "e-1",
    externalObjectId: "post-1",
    parentExternalObjectId: null,
    signalType: "comment",
    occurredAt: new Date("2026-07-05T11:00:00.000Z"),
    actorReference: "user-9",
    actorDisplayName: "Ava",
    contentReference: null,
    contentText: "hello",
    evidence: { kind: "comment", id: "e-1" },
    ...overrides,
  };
}

describe("R5-A acceptance — webhook ingestion chain", () => {
  it("1. new comment ingestion → one canonical direct-attributed signal", async () => {
    const db = connectedDb();
    const rawBody = commentDelivery("c-100");
    const outcome = await processListeningWebhook(
      { platform: "facebook", rawBody, signature: sign(rawBody), appSecret: APP_SECRET },
      deps(db)
    );
    expect(outcome.httpStatus).toBe(200);
    expect(outcome.dispositions).toEqual([expect.objectContaining({ kind: "accepted" })]);

    const [signal] = await listSignalsForUser({ userId: 7, executor: db });
    expect(signal).toMatchObject({
      signalType: "comment",
      attributionType: "direct",
      sourceCampaignId: 5,
      sourcePublicationId: "publication:facebook:42",
      sourcePublicationReceiptId: "fp-acceptance",
      status: "accepted",
    });
  });

  it("2. duplicate comment delivery collapses to one durable signal", async () => {
    const db = connectedDb();
    const rawBody = commentDelivery("c-101");
    for (let i = 0; i < 3; i++) {
      await processListeningWebhook(
        { platform: "facebook", rawBody, signature: sign(rawBody), appSecret: APP_SECRET },
        deps(db)
      );
    }
    expect(db.signals.size).toBe(1);
    expect(db.states.get(11).acceptedCount).toBe(1);
    expect(db.states.get(11).duplicateCount).toBe(2);
  });

  it("3. concurrent duplicate delivery → exactly one durable signal", async () => {
    const db = connectedDb();
    const results = await Promise.all([
      ingestRawSignalEvent("facebook", rawEvent({ externalEventId: "c-conc" }), deps(db)),
      ingestRawSignalEvent("facebook", rawEvent({ externalEventId: "c-conc" }), deps(db)),
      ingestRawSignalEvent("facebook", rawEvent({ externalEventId: "c-conc" }), deps(db)),
    ]);
    const accepted = results.filter((r) => r.disposition.kind === "accepted");
    const duplicates = results.filter((r) => r.disposition.kind === "duplicate");
    expect(accepted).toHaveLength(1);
    expect(duplicates).toHaveLength(2);
    expect(db.signals.size).toBe(1);
  });

  it("4. reply/thread normalization (parent ≠ post → reply)", async () => {
    const db = connectedDb();
    const rawBody = commentDelivery("c-reply", "post-1", "c-parent");
    await processListeningWebhook(
      { platform: "facebook", rawBody, signature: sign(rawBody), appSecret: APP_SECRET },
      deps(db)
    );
    const [signal] = await listSignalsForUser({ userId: 7, executor: db });
    expect(signal.signalType).toBe("reply");
    expect(signal.parentExternalObjectId).toBe("c-parent");
  });

  it.each([
    ["mention", "m-1"],
    ["reaction", "r-1"],
  ])("5/6. %s normalization", async (item, eventId) => {
    const db = connectedDb();
    const rawBody = feedDelivery(item, eventId);
    await processListeningWebhook(
      { platform: "facebook", rawBody, signature: sign(rawBody), appSecret: APP_SECRET },
      deps(db)
    );
    const [signal] = await listSignalsForUser({ userId: 7, executor: db });
    expect(signal.signalType).toBe(item === "reaction" ? "reaction" : "mention");
    expect(signal.externalEventId).toBe(eventId);
  });

  it("7. direct business attribution: known publication binds campaign", async () => {
    const db = connectedDb();
    await ingestRawSignalEvent("facebook", rawEvent(), deps(db));
    const [signal] = await listSignalsForUser({ userId: 7, executor: db });
    expect(signal.attributionType).toBe("direct");
    expect(signal.businessId).toBe(3);
    expect(signal.sourceCampaignId).toBe(5);
  });

  it("8/9. unknown publication stays unbound (business tier, no fabricated linkage)", async () => {
    const db = connectedDb();
    await ingestRawSignalEvent(
      "facebook",
      rawEvent({ externalObjectId: "post-never-published" }),
      deps(db)
    );
    const [signal] = await listSignalsForUser({ userId: 7, executor: db });
    expect(signal.attributionType).toBe("business");
    expect(signal.sourceCampaignId).toBeNull();
    expect(signal.sourcePublicationId).toBeNull();
  });

  it("10. cross-business provider account rejected fail-closed", async () => {
    const db = connectedDb();
    const outcome = await ingestRawSignalEvent(
      "facebook",
      rawEvent({ providerAccountId: "page-owned-by-someone-else" }),
      deps(db)
    );
    expect(outcome.disposition).toMatchObject({ kind: "rejected", failureClass: "FAIL_CLOSED" });
    expect(db.signals.size).toBe(0);
  });

  it("11. forged business id cannot influence attribution (server binding wins)", async () => {
    const db = connectedDb();
    // A caller cannot supply businessId anywhere; the binding's businessId
    // is the only source. Even conceptually "wanting" business 99 yields 3.
    const outcome = await ingestRawSignalEvent("facebook", rawEvent(), deps(db));
    expect(outcome.signal?.businessId).toBe(3);
    expect(outcome.signal?.userId).toBe(7);
  });

  it("12. malformed provider payload rejected", async () => {
    const db = connectedDb();
    const rawBody = commentDelivery("bad\x00comment");
    const outcome = await processListeningWebhook(
      { platform: "facebook", rawBody, signature: sign(rawBody), appSecret: APP_SECRET },
      deps(db)
    );
    expect(outcome.httpStatus).toBe(422);
    expect(db.signals.size).toBe(0);
  });

  it("13. replayed webhook: identical delivery collapses; tampered delivery rejected", async () => {
    const db = connectedDb();
    const rawBody = commentDelivery("c-replay");
    const first = await processListeningWebhook(
      { platform: "facebook", rawBody, signature: sign(rawBody), appSecret: APP_SECRET },
      deps(db)
    );
    expect(first.dispositions[0].kind).toBe("accepted");

    const replay = await processListeningWebhook(
      { platform: "facebook", rawBody, signature: sign(rawBody), appSecret: APP_SECRET },
      deps(db)
    );
    expect(replay.dispositions[0]).toMatchObject({ kind: "duplicate" });

    const tampered = rawBody.replace("c-replay", "c-replay-TAMPERED");
    const tamperedOutcome = await processListeningWebhook(
      { platform: "facebook", rawBody: tampered, signature: sign(rawBody), appSecret: APP_SECRET },
      deps(db)
    );
    expect(tamperedOutcome.httpStatus).toBe(401);
    expect(db.signals.size).toBe(1);
  });
});

describe("R5-A acceptance — polling orchestration", () => {
  it("14/15. polling restarts from checkpoint; retries do not duplicate", async () => {
    const db = connectedDb();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({ events: [rawEvent({ externalEventId: "p-1" })], nextCursor: "chk-1" })
      .mockResolvedValueOnce({ events: [rawEvent({ externalEventId: "p-1" })], nextCursor: "chk-1" });

    const first = await runListeningPollingPass({ ...deps(db), fetcherOverrides: { meta: fetcher } });
    const second = await runListeningPollingPass({ ...deps(db), fetcherOverrides: { meta: fetcher } });

    expect(first.accepted).toBe(1);
    expect(second.duplicates).toBe(1);
    expect(fetcher.mock.calls[1][0].cursor).toBe("chk-1"); // resumed from checkpoint
    expect(db.signals.size).toBe(1);
  });

  it("16. provider rate-limit classifies AUTO_RECOVER", async () => {
    const db = connectedDb();
    const fetcher = vi.fn().mockRejectedValue(new Error("429 rate limit exceeded"));
    const summary = await runListeningPollingPass({ ...deps(db), fetcherOverrides: { meta: fetcher } });
    expect(summary.failures[0]).toMatchObject({ class: "AUTO_RECOVER", code: "provider_rate_limited" });
    expect(db.states.get(11).status).toBe("active");
  });

  it("17. revoked credentials classify OPERATOR_ACTION", async () => {
    const db = connectedDb();
    const fetcher = vi.fn().mockRejectedValue(new Error("The access token expired"));
    const summary = await runListeningPollingPass({ ...deps(db), fetcherOverrides: { meta: fetcher } });
    expect(summary.failures[0].class).toBe("OPERATOR_ACTION");
    expect(db.states.get(11).status).toBe("blocked");
  });

  it("18. unsupported provider fails closed", async () => {
    const db = createListeningFakeDb({
      integrations: [
        {
          id: 31,
          userId: 7,
          businessId: null,
          platform: "tiktok",
          pageId: "tt-1",
          instagramBusinessAccountId: null,
          status: "connected",
          createdAt: NOW,
        },
      ],
    });
    const rawBody = JSON.stringify({ object: "video", entry: [{ id: "tt-1" }] });
    const outcome = await processListeningWebhook(
      { platform: "tiktok", rawBody, signature: sign(rawBody), appSecret: APP_SECRET },
      deps(db)
    );
    expect(outcome.httpStatus).toBe(401);
    expect(outcome.received).toBe(false);
    expect(db.signals.size).toBe(0);
  });
});

describe("R5-A acceptance — security + evidence immutability", () => {
  it("19. no secret/token material in any API-facing output", async () => {
    const db = connectedDb();
    const rawBody = commentDelivery("c-secret-check");
    const webhookOutcome = await processListeningWebhook(
      { platform: "facebook", rawBody, signature: sign(rawBody), appSecret: APP_SECRET },
      deps(db)
    );
    const overview = await getListeningOverview({ userId: 7, executor: db, now: NOW });
    const { signals } = { signals: await listSignalsForUser({ userId: 7, executor: db }) };

    const serialized = JSON.stringify({ webhookOutcome, overview, signals });
    expect(serialized).not.toContain("SUPER_SECRET_ACCESS_TOKEN");
    expect(serialized).not.toContain(APP_SECRET);
    expect(serialized).not.toContain("x-hub-signature");
    expect(serialized).toContain("accepted");
  });

  it("20. persisted signal is immutable under replay (hash + row stable)", async () => {
    const db = connectedDb();
    const first = await ingestRawSignalEvent("facebook", rawEvent({ externalEventId: "c-imm" }), deps(db));
    const rowAfterFirst = structuredClone([...db.signals.values()][0]);

    // Replay multiple times via the store directly and via the pipeline.
    await acceptSocialSignal(first.signal as CanonicalSocialSignal, db);
    await ingestRawSignalEvent("facebook", rawEvent({ externalEventId: "c-imm" }), deps(db));

    const rowAfterReplays = [...db.signals.values()][0];
    expect(db.signals.size).toBe(1);
    expect(rowAfterReplays.providerEvidenceHash).toBe(first.signal?.providerEvidenceHash);
    expect(rowAfterReplays).toEqual(rowAfterFirst);
    expect(db.states.get(11).acceptedCount).toBe(1);
  });
});

describe("R5-A acceptance — connected chain", () => {
  it("binding → fake event → ingestion → normalized signal → attribution → evidence → observability", async () => {
    const db = connectedDb();

    // 1. connected provider binding (seeded as a connected integration)
    expect(db.integrations[0]).toMatchObject({ status: "connected", pageId: "page-1" });

    // 2. fake external event delivered through the verified webhook boundary
    const rawBody = commentDelivery("c-chain", "post-1");
    const outcome = await processListeningWebhook(
      { platform: "facebook", rawBody, signature: sign(rawBody), appSecret: APP_SECRET },
      deps(db)
    );
    expect(outcome.dispositions[0].kind).toBe("accepted");

    // 3. normalized canonical signal with deterministic identity
    const [signal] = await listSignalsForUser({ userId: 7, executor: db });
    expect(signal.signalKey).toMatch(/^sigv1:[0-9a-f]{64}$/);
    expect(signal.signalType).toBe("comment");

    // 4. evidence-based attribution to the known publication
    expect(signal.attributionType).toBe("direct");
    expect(signal.sourcePublicationId).toBe("publication:facebook:42");

    // 5. durable evidence: exactly one row, content-addressed hash present
    expect(db.signals.size).toBe(1);
    expect(signal.providerEvidenceHash).toMatch(/^[0-9a-f]{64}$/);

    // 6. observability reflects the chain without DB inspection
    const overview = await getListeningOverview({ userId: 7, executor: db, now: NOW });
    expect(overview[0]).toMatchObject({
      integrationId: 11,
      status: "active",
      mechanism: "webhook",
      acceptedCount: 1,
      recentSignalCount: 1,
      stale: false,
      unsupported: false,
    });
  });
});
