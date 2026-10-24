import { describe, it, expect, vi } from "vitest";
import { acceptSocialSignal, SignalStoreError } from "./signal-store";
import type { CanonicalSocialSignal } from "./signal-contract";

function makeSignal(overrides: Partial<CanonicalSocialSignal> = {}): CanonicalSocialSignal {
  const occurredAt = new Date("2026-07-01T10:00:00.000Z");
  return {
    signalKey: "sigv1:abc",
    userId: 7,
    businessId: 3,
    provider: "meta",
    platform: "facebook",
    integrationId: 11,
    providerAccountId: "page-1",
    externalEventId: "c-1",
    externalObjectId: "post-1",
    parentExternalObjectId: null,
    signalType: "comment",
    occurredAt,
    observedAt: new Date("2026-07-01T10:00:05.000Z"),
    sourceCampaignId: null,
    sourcePublicationId: null,
    sourcePublicationReceiptId: null,
    actorReference: "user-9",
    actorDisplayName: "Ava",
    contentReference: null,
    contentText: "Love this",
    providerEvidenceHash: "e".repeat(64),
    attributionType: "business",
    status: "accepted",
    ingestionVersion: 1,
    createdAt: new Date("2026-07-01T10:00:05.000Z"),
    ...overrides,
  };
}

function naturalKeyOf(row: any): string {
  return `${row.provider}|${row.providerAccountId}|${row.externalEventId}`;
}

/**
 * Stateful fake for the social_signals slice. Honors the unique natural key
 * and can simulate a lost select→insert race so replay/duplicate semantics
 * are exercised against real dedup behavior, not mocks of it.
 */
function createFakeSignalDb(options: {
  seededRows?: any[];
  failInsertWithDup?: boolean;
  revealSeededRowAfterSelects?: number;
}) {
  const rows = new Map<string, any>();
  for (const seed of options.seededRows ?? []) {
    rows.set(naturalKeyOf(seed), { ...seed });
  }
  let selectCalls = 0;
  const insertedValues: any[] = [];

  const db: any = {
    rows,
    insertedValues,
    /** Tests set this to emulate the natural-key WHERE filter. */
    matchRow: undefined as undefined | ((row: any) => boolean),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => {
            selectCalls += 1;
            if (
              options.revealSeededRowAfterSelects !== undefined &&
              selectCalls <= options.revealSeededRowAfterSelects &&
              rows.size > 0
            ) {
              return []; // earlier selects see nothing (mid-write window)
            }
            const all = [...rows.values()];
            return db.matchRow ? all.filter(db.matchRow) : all;
          }),
        })),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(async (values: any) => {
        insertedValues.push(values);
        if (options.failInsertWithDup) {
          const err: any = new Error("Duplicate entry for key 'ss_natural_key_uidx'");
          err.code = "ER_DUP_ENTRY";
          throw err;
        }
        const key = naturalKeyOf(values);
        if (rows.has(key)) {
          const err: any = new Error("Duplicate entry for key 'ss_natural_key_uidx'");
          err.code = "ER_DUP_ENTRY";
          throw err;
        }
        rows.set(key, { ...values });
      }),
    })),
    // Tripwire: the store must never update or delete durable evidence.
    update: vi.fn(() => {
      throw new Error("social_signals must never be updated");
    }),
  };
  return db;
}

describe("acceptSocialSignal — exact-once acceptance", () => {
  it("inserts a new signal exactly once and reads it back", async () => {
    const db = createFakeSignalDb({});
    const signal = makeSignal();
    const result = await acceptSocialSignal(signal, db);

    expect(result.inserted).toBe(true);
    expect(result.duplicateClassification).toBe("none");
    expect(db.rows.size).toBe(1);
    expect(db.insertedValues[0]).toMatchObject({
      signalKey: signal.signalKey,
      externalEventId: "c-1",
      providerEvidenceHash: signal.providerEvidenceHash,
    });
  });

  it("duplicate delivery returns the existing row (idempotent replay)", async () => {
    const signal = makeSignal();
    const existing = { id: 1, ...structuredClone({ ...signal }) };
    const db = createFakeSignalDb({ seededRows: [existing] });

    const result = await acceptSocialSignal(signal, db);
    expect(result.inserted).toBe(false);
    expect(result.duplicateClassification).toBe("idempotent_replay");
    expect(result.row.id).toBe(1);
    expect(db.insertedValues).toHaveLength(0);
    expect(db.rows.size).toBe(1); // no duplicate effect
  });

  it("same external id from a different provider/account does not collide", async () => {
    const db = createFakeSignalDb({});
    const first = makeSignal();
    const second = makeSignal({
      provider: "linkedin",
      platform: "linkedin",
      providerAccountId: "org-1",
      signalKey: "sigv1:other",
    });
    db.matchRow = (row: any) =>
      row.provider === first.provider &&
      row.providerAccountId === first.providerAccountId &&
      row.externalEventId === first.externalEventId;
    await acceptSocialSignal(first, db);
    db.matchRow = (row: any) =>
      row.provider === second.provider &&
      row.providerAccountId === second.providerAccountId &&
      row.externalEventId === second.externalEventId;
    const result = await acceptSocialSignal(second, db);
    expect(result.inserted).toBe(true);
    expect(db.rows.size).toBe(2);
  });

  it("conflicting replay under the same identity fails closed", async () => {
    const signal = makeSignal();
    const tampered = { id: 1, ...structuredClone({ ...signal }), contentText: "different" };
    const db = createFakeSignalDb({ seededRows: [tampered] });

    try {
      await acceptSocialSignal(signal, db);
      expect.unreachable("expected SignalStoreError");
    } catch (err) {
      expect(err).toBeInstanceOf(SignalStoreError);
      expect((err as SignalStoreError).code).toBe("SIGNAL_FINGERPRINT_CONFLICT");
    }
    expect(db.rows.size).toBe(1);
    expect(db.rows.get("meta|page-1|c-1").contentText).toBe("different"); // untouched
  });

  it("lost select→insert race re-reads and verifies the committed row", async () => {
    const signal = makeSignal();
    const raced = { id: 5, ...structuredClone({ ...signal }) };
    const db = createFakeSignalDb({
      seededRows: [raced],
      failInsertWithDup: true,
      revealSeededRowAfterSelects: 1,
    });

    const result = await acceptSocialSignal(signal, db);
    expect(result.inserted).toBe(false);
    expect(result.duplicateClassification).toBe("idempotent_replay");
    expect(result.row.id).toBe(5);
  });

  it("raced row with mismatched content fails closed", async () => {
    const signal = makeSignal();
    const raced = { id: 5, ...structuredClone({ ...signal }), signalType: "reaction" };
    const db = createFakeSignalDb({
      seededRows: [raced],
      failInsertWithDup: true,
      revealSeededRowAfterSelects: 1,
    });

    await expect(acceptSocialSignal(signal, db)).rejects.toMatchObject({
      code: "SIGNAL_FINGERPRINT_CONFLICT",
    });
  });

  it("process dies after persist → retry returns existing result", async () => {
    const signal = makeSignal();
    // First attempt persists (insert succeeds). "Process dies." Retry:
    const db = createFakeSignalDb({ seededRows: [{ id: 9, ...structuredClone({ ...signal }) }] });
    const retry = await acceptSocialSignal(signal, db);
    expect(retry.inserted).toBe(false);
    expect(retry.row.id).toBe(9);
  });

  it("rejects an invalid signal envelope", async () => {
    const db = createFakeSignalDb({});
    await expect(
      acceptSocialSignal(null as unknown as CanonicalSocialSignal, db)
    ).rejects.toMatchObject({ code: "INVALID_SIGNAL" });
  });
});
