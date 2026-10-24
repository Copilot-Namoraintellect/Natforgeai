import { describe, it, expect } from "vitest";
import { ingestRawSignalEvent } from "./ingest";
import { createListeningFakeDb } from "./testing/fake-listening-db";
import type { RawSocialSignalEvent } from "./adapters/types";

const NOW = new Date("2026-07-05T12:00:00.000Z");

function rawEvent(overrides: Partial<RawSocialSignalEvent> = {}): RawSocialSignalEvent {
  return {
    providerAccountId: "page-1",
    externalEventId: "c-1",
    externalObjectId: "post-1",
    parentExternalObjectId: null,
    signalType: "comment",
    occurredAt: new Date("2026-07-05T11:00:00.000Z"),
    actorReference: "user-9",
    actorDisplayName: "Ava",
    contentReference: null,
    contentText: "Great post",
    evidence: { kind: "comment", commentId: "c-1", postId: "post-1" },
    ...overrides,
  };
}

function seedDb() {
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
        eventFingerprint: "fp1",
        userId: 7,
        eventType: "publication_success",
        metadata: { receipt: { operationId: "publication:facebook:42" } },
      },
    ],
  });
}

const deps = (db: any) => ({ attribution: db, store: db, state: db, now: () => NOW });

describe("ingestRawSignalEvent", () => {
  it("accepts a comment and persists one canonical direct-attributed signal", async () => {
    const db = seedDb();
    const outcome = await ingestRawSignalEvent("facebook", rawEvent(), deps(db));

    expect(outcome.disposition.kind).toBe("accepted");
    expect(outcome.signal).toMatchObject({
      attributionType: "direct",
      userId: 7,
      businessId: 3,
      sourceCampaignId: 5,
      sourcePublicationId: "publication:facebook:42",
      sourcePublicationReceiptId: "fp1",
      status: "accepted",
      ingestionVersion: 1,
      observedAt: NOW,
    });
    expect(db.signals.size).toBe(1);
    const state = db.states.get(11);
    expect(state.acceptedCount).toBe(1);
    expect(state.mechanism).toBe("webhook");
  });

  it("duplicate delivery returns duplicate with zero additional effect", async () => {
    const db = seedDb();
    const first = await ingestRawSignalEvent("facebook", rawEvent(), deps(db));
    const second = await ingestRawSignalEvent("facebook", rawEvent(), deps(db));

    expect(first.disposition.kind).toBe("accepted");
    expect(second.disposition).toEqual({
      kind: "duplicate",
      signalKey: (first.disposition as any).signalKey,
      reason: "idempotent_replay",
    });
    expect(db.signals.size).toBe(1);
    expect(db.states.get(11).duplicateCount).toBe(1);
    expect(db.states.get(11).acceptedCount).toBe(1);
  });

  it("rejects events for provider accounts with no connected binding (fail closed)", async () => {
    const db = seedDb();
    const outcome = await ingestRawSignalEvent(
      "facebook",
      rawEvent({ providerAccountId: "page-foreign" }),
      deps(db)
    );
    expect(outcome.disposition).toMatchObject({
      kind: "rejected",
      failureClass: "FAIL_CLOSED",
    });
    expect(db.signals.size).toBe(0);
  });

  it("rejects malformed identity material and counts it", async () => {
    const db = seedDb();
    const outcome = await ingestRawSignalEvent(
      "facebook",
      rawEvent({ externalEventId: "bad\x00id" }),
      deps(db)
    );
    expect(outcome.disposition).toMatchObject({
      kind: "rejected",
      failureClass: "FAIL_CLOSED",
    });
    expect(db.states.get(11).rejectedCount).toBe(1);
    expect(db.states.get(11).lastFailureClass).toBe("FAIL_CLOSED");
  });

  it("fails closed on unknown platforms before any binding lookup", async () => {
    const db = seedDb();
    const outcome = await ingestRawSignalEvent("pinterest", rawEvent(), deps(db));
    expect(outcome.disposition).toMatchObject({
      kind: "rejected",
      failureClass: "FAIL_CLOSED",
    });
    expect(db.signals.size).toBe(0);
  });

  it("business attribution when no publication matches; DMs have no object", async () => {
    const db = seedDb();
    const outcome = await ingestRawSignalEvent(
      "facebook",
      rawEvent({ externalObjectId: "post-unknown" }),
      deps(db)
    );
    expect(outcome.disposition.kind).toBe("accepted");
    expect(outcome.signal?.attributionType).toBe("business");
    expect(outcome.signal?.sourceCampaignId).toBeNull();
  });

  it("immutable evidence: replayed identical event reproduces identical hash and row", async () => {
    const db = seedDb();
    const a = await ingestRawSignalEvent("facebook", rawEvent(), deps(db));
    const b = await ingestRawSignalEvent("facebook", rawEvent(), deps(db));
    expect(a.signal?.providerEvidenceHash).toBe(b.signal?.providerEvidenceHash);
    expect(db.signals.size).toBe(1);
    const row = [...db.signals.values()][0];
    expect(row.providerEvidenceHash).toBe(a.signal?.providerEvidenceHash);
  });
});
