import { describe, it, expect } from "vitest";
import { createHmac } from "crypto";
import { processListeningWebhook } from "./webhook-ingest";
import { createListeningFakeDb } from "./testing/fake-listening-db";

const APP_SECRET = "wh-secret";

function sign(rawBody: string): string {
  return `sha256=${createHmac("sha256", APP_SECRET).update(rawBody, "utf8").digest("hex")}`;
}

const commentPayload = {
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
            message: "Love it",
            post_id: "post-1",
            parent_id: "post-1",
            created_time: "2026-07-05T10:00:00+0000",
          },
        },
      ],
    },
  ],
};

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
  });
}

const deps = (db: any) => ({ attribution: db, store: db, state: db });

describe("processListeningWebhook", () => {
  it("401 on unknown platform (fail closed)", async () => {
    const outcome = await processListeningWebhook(
      { platform: "tiktok", rawBody: "{}", signature: "x", appSecret: APP_SECRET },
      deps(seedDb())
    );
    expect(outcome.httpStatus).toBe(401);
    expect(outcome.received).toBe(false);
  });

  it("401 on platform with no webhook verifier (linkedin)", async () => {
    const rawBody = JSON.stringify({ anything: true });
    const outcome = await processListeningWebhook(
      { platform: "linkedin", rawBody, signature: sign(rawBody), appSecret: APP_SECRET },
      deps(seedDb())
    );
    expect(outcome.httpStatus).toBe(401);
    expect(outcome.error).toMatch(/not supported/);
  });

  it("401 on invalid/missing signature and on tampered body", async () => {
    const rawBody = JSON.stringify(commentPayload);
    const bad = await processListeningWebhook(
      { platform: "facebook", rawBody, signature: "sha256=bad", appSecret: APP_SECRET },
      deps(seedDb())
    );
    expect(bad.httpStatus).toBe(401);

    const noSecret = await processListeningWebhook(
      { platform: "facebook", rawBody, signature: sign(rawBody), appSecret: "" },
      deps(seedDb())
    );
    expect(noSecret.httpStatus).toBe(401);

    const tampered = rawBody.replace("Love it", "Hate it");
    const tamperedOutcome = await processListeningWebhook(
      { platform: "facebook", rawBody: tampered, signature: sign(rawBody), appSecret: APP_SECRET },
      deps(seedDb())
    );
    expect(tamperedOutcome.httpStatus).toBe(401);
    expect(tamperedOutcome.received).toBe(false);
  });

  it("400 on malformed JSON", async () => {
    const outcome = await processListeningWebhook(
      { platform: "facebook", rawBody: "{not json", signature: sign("{not json"), appSecret: APP_SECRET },
      deps(seedDb())
    );
    expect(outcome.httpStatus).toBe(400);
  });

  it("200 + accepted disposition on a verified comment; replay collapses to duplicate", async () => {
    const db = seedDb();
    const rawBody = JSON.stringify(commentPayload);

    const first = await processListeningWebhook(
      { platform: "facebook", rawBody, signature: sign(rawBody), appSecret: APP_SECRET },
      deps(db)
    );
    expect(first.httpStatus).toBe(200);
    expect(first.received).toBe(true);
    expect(first.dispositions).toEqual([
      expect.objectContaining({ kind: "accepted" }),
    ]);
    expect(db.signals.size).toBe(1);

    // Provider redelivery of the identical delivery → collapsed, no new row.
    const replay = await processListeningWebhook(
      { platform: "facebook", rawBody, signature: sign(rawBody), appSecret: APP_SECRET },
      deps(db)
    );
    expect(replay.httpStatus).toBe(200);
    expect(replay.dispositions).toEqual([
      expect.objectContaining({ kind: "duplicate", reason: "idempotent_replay" }),
    ]);
    expect(db.signals.size).toBe(1);
  });

  it("rejects events whose binding does not own the account (200 with rejected disposition)", async () => {
    const rawBody = JSON.stringify({
      object: "page",
      entry: [
        {
          id: "page-unknown",
          changes: [
            {
              field: "comments",
              value: {
                id: "c-9",
                from: { id: "user-1" },
                message: "hi",
                post_id: "p",
                parent_id: "p",
                created_time: "2026-07-05T10:00:00+0000",
              },
            },
          ],
        },
      ],
    });
    const outcome = await processListeningWebhook(
      { platform: "facebook", rawBody, signature: sign(rawBody), appSecret: APP_SECRET },
      deps(seedDb())
    );
    expect(outcome.httpStatus).toBe(200);
    expect(outcome.dispositions[0].kind).toBe("rejected");
  });
});
