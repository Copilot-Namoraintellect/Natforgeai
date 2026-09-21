import { describe, expect, it, vi } from "vitest";

// The audit store must never touch a real database in tests. Any code path
// that falls back to the default connection fails loudly here.
vi.mock("../../queries/connection", () => ({
  getDb: vi.fn(() => {
    throw new Error("getDb must not be called in audit-store tests; supply a fake executor");
  }),
}));

import { getDb } from "../../queries/connection";
import type { AuditEventRow, InsertAuditEventRow } from "@db/schema";
import { buildAuditEventFingerprint, createAuditEvent, AuditEventError, type AuditEvent } from "./audit-event";
import { persistAuditEvent, type AuditDbExecutor } from "./audit-store";

const CREATED_AT = "2026-07-01T00:00:00.000Z";

function makeDuplicateKeyError(): Error & { code: string; errno: number } {
  const err = new Error("Duplicate entry 'x' for key 'ae_fingerprint_idx'") as Error & {
    code: string;
    errno: number;
  };
  err.code = "ER_DUP_ENTRY";
  err.errno = 1062;
  return err;
}

interface FakeAuditDbState {
  rows: AuditEventRow[];
  insertedRows: InsertAuditEventRow[];
  selectCalls: number;
  insertCalls: number;
  nextId: number;
}

interface FakeAuditDbOptions {
  /** Rows returned by the first select (pre-existing durable state). */
  existingRows?: AuditEventRow[];
  /** Rows returned by selects after the first (simulated race outcome). */
  raceRows?: AuditEventRow[];
  /** Force every insert to fail with ER_DUP_ENTRY. */
  duplicateOnInsert?: boolean;
  /** Force every insert to fail with a non-duplicate error. */
  insertError?: Error;
}

function makeFakeAuditDb(options: FakeAuditDbOptions = {}): {
  executor: AuditDbExecutor;
  state: FakeAuditDbState;
} {
  const state: FakeAuditDbState = {
    rows: [...(options.existingRows ?? [])],
    insertedRows: [],
    selectCalls: 0,
    insertCalls: 0,
    nextId: 9000,
  };

  const executor = {
    select: (_fields?: unknown) => ({
      from: (_table: unknown) => ({
        where: (_condition: unknown) => ({
          limit: async (_n: number): Promise<AuditEventRow[]> => {
            state.selectCalls += 1;
            const source =
              state.selectCalls === 1 ? (options.existingRows ?? []) : (options.raceRows ?? state.rows);
            return source.map((row) => ({ ...row }));
          },
        }),
      }),
    }),
    insert: (_table: unknown) => ({
      values: async (row: InsertAuditEventRow): Promise<unknown> => {
        state.insertCalls += 1;
        state.insertedRows.push({ ...row });
        if (options.insertError) throw options.insertError;
        if (options.duplicateOnInsert) throw makeDuplicateKeyError();
        if (state.rows.some((r) => r.eventFingerprint === row.eventFingerprint)) {
          throw makeDuplicateKeyError();
        }
        const persisted = {
          id: state.nextId++,
          createdAt: new Date(CREATED_AT),
          ...(row as Record<string, unknown>),
        } as AuditEventRow;
        state.rows.push(persisted);
        return [{ insertId: persisted.id, affectedRows: 1 }];
      },
    }),
  };

  return { executor: executor as unknown as AuditDbExecutor, state };
}

function toSeededRow(event: AuditEvent, overrides: Partial<AuditEventRow> = {}): AuditEventRow {
  return {
    id: 555,
    eventFingerprint: buildAuditEventFingerprint(event),
    schemaVersion: event.schemaVersion,
    eventType: event.eventType,
    occurredAt: event.occurredAt,
    userId: event.userId,
    campaignId: event.campaignId,
    businessId: event.businessId,
    workflowOperationId: event.workflowOperationId,
    workflowAttemptId: event.workflowAttemptId,
    approvalRequestId: event.approvalRequestId,
    artifactId: event.artifactId === null ? null : String(event.artifactId),
    packageId: event.packageId === null ? null : String(event.packageId),
    contentId: event.contentId === null ? null : String(event.contentId),
    source: event.source,
    outcome: event.outcome,
    metadata: JSON.parse(JSON.stringify(event.metadata)) as AuditEventRow["metadata"],
    createdAt: new Date(CREATED_AT),
    ...overrides,
  };
}

const fullEventInput = {
  eventType: "publication_success" as const,
  occurredAt: "2026-03-04T05:06:07.890+02:00",
  userId: 22,
  source: "workflow" as const,
  outcome: "succeeded" as const,
  campaignId: 30,
  businessId: 26,
  workflowOperationId:
    "2c70a2b9a54856ad2ccc6b0a1a78ef39e785d8f22e3c8f0f15d9d0d7d4f6a101",
  workflowAttemptId:
    "8f14e45fceea167a5a36dedd4bea2543a0a8a1a2f9f0d9c8b7a6e5d4c3b2a198",
  approvalRequestId: 36,
  artifactId: "artifact-9",
  packageId: 7,
  contentId: "content-3",
  metadata: { platform: "instagram", detail: { note: "ok", b: 2, a: 1 } },
};

function makeEvent(overrides: Partial<typeof fullEventInput> = {}): AuditEvent {
  return createAuditEvent({ ...fullEventInput, ...overrides });
}

describe("persistAuditEvent", () => {
  it("first persistence inserts exactly one durable row", async () => {
    const event = makeEvent();
    const { executor, state } = makeFakeAuditDb();

    const result = await persistAuditEvent(event, executor);

    expect(result.inserted).toBe(true);
    expect(result.duplicateClassification).toBe("none");
    expect(result.event).toBe(event);
    expect(state.insertCalls).toBe(1);
    expect(state.insertedRows).toHaveLength(1);
    expect(state.rows).toHaveLength(1);

    const row = result.row;
    expect(row.eventFingerprint).toBe(buildAuditEventFingerprint(event));
    expect(row.eventType).toBe("publication_success");
    expect(row.source).toBe("workflow");
    expect(row.outcome).toBe("succeeded");
    expect(row.userId).toBe(22);
    expect(row.metadata).toEqual({ detail: { a: 1, b: 2, note: "ok" }, platform: "instagram" });
  });

  it("exact replay reuses the existing row and never creates a second row", async () => {
    const event = makeEvent();
    const { executor, state } = makeFakeAuditDb({ existingRows: [toSeededRow(event)] });

    const replayed = createAuditEvent({ ...fullEventInput }); // same material input
    expect(buildAuditEventFingerprint(replayed)).toBe(buildAuditEventFingerprint(event));

    const first = await persistAuditEvent(event, executor);
    const second = await persistAuditEvent(replayed, executor);

    for (const result of [first, second]) {
      expect(result.inserted).toBe(false);
      expect(result.duplicateClassification).toBe("idempotent_replay");
      expect(result.row).toEqual(toSeededRow(event));
    }
    expect(state.insertCalls).toBe(0);
    expect(state.rows).toHaveLength(1);
  });

  it("fails closed when stored content under the same fingerprint does not match", async () => {
    const event = makeEvent();
    const tampered = toSeededRow(event, {
      occurredAt: "2027-01-01T00:00:00.000Z",
      outcome: "failed",
    });
    const { executor, state } = makeFakeAuditDb({ existingRows: [tampered] });

    await expect(persistAuditEvent(event, executor)).rejects.toMatchObject({
      name: "AuditEventError",
      code: "AUDIT_FINGERPRINT_CONFLICT",
    });
    expect(state.insertCalls).toBe(0);
    expect(state.rows).toEqual([tampered]);
  });

  it("replays an insert race when the committed row matches", async () => {
    const event = makeEvent();
    const committed = toSeededRow(event, { id: 4242 });
    const { executor, state } = makeFakeAuditDb({
      duplicateOnInsert: true,
      raceRows: [committed],
    });

    const result = await persistAuditEvent(event, executor);

    expect(result.inserted).toBe(false);
    expect(result.duplicateClassification).toBe("idempotent_replay");
    expect(result.row).toEqual(committed);
    expect(state.insertCalls).toBe(1);
    expect(state.rows).toHaveLength(0); // the racing insert did not land in this executor
  });

  it("fails closed on an insert race whose committed row conflicts", async () => {
    const event = makeEvent();
    const conflicting = toSeededRow(event, { userId: 999 });
    const { executor, state } = makeFakeAuditDb({
      duplicateOnInsert: true,
      raceRows: [conflicting],
    });

    await expect(persistAuditEvent(event, executor)).rejects.toMatchObject({
      code: "AUDIT_FINGERPRINT_CONFLICT",
    });
    expect(state.insertCalls).toBe(1);
    expect(state.rows).toHaveLength(0);
  });

  it("propagates non-duplicate persistence errors unchanged", async () => {
    const event = makeEvent();
    const outage = new Error("connection lost");
    const { executor, state } = makeFakeAuditDb({ insertError: outage });

    await expect(persistAuditEvent(event, executor)).rejects.toBe(outage);
    expect(state.rows).toHaveLength(0);
  });

  it("preserves correlation identifiers and occurredAt exactly on insert", async () => {
    const event = makeEvent();
    const { executor, state } = makeFakeAuditDb();

    const result = await persistAuditEvent(event, executor);
    const row = result.row;

    expect(row.occurredAt).toBe("2026-03-04T05:06:07.890+02:00"); // verbatim, no TZ round-trip
    expect(row.createdAt).not.toEqual(row.occurredAt); // persistence time is separate
    expect(row.campaignId).toBe(30);
    expect(row.businessId).toBe(26);
    expect(row.workflowOperationId).toBe(fullEventInput.workflowOperationId);
    expect(row.workflowAttemptId).toBe(fullEventInput.workflowAttemptId);
    expect(row.approvalRequestId).toBe(36);
    expect(row.artifactId).toBe("artifact-9");
    expect(row.packageId).toBe("7"); // numeric envelope subject id normalized to text
    expect(row.contentId).toBe("content-3");

    const inserted = state.insertedRows[0];
    expect(inserted?.occurredAt).toBe(event.occurredAt);
    expect(inserted?.workflowOperationId).toBe(event.workflowOperationId);
  });

  it("persists null correlation values as null without inventing identifiers", async () => {
    const sparse = createAuditEvent({
      eventType: "learning_record_creation",
      occurredAt: "2026-07-01T12:00:00.000Z",
      userId: 22,
      source: "system",
      outcome: "succeeded",
    });
    const { executor, state } = makeFakeAuditDb();

    const result = await persistAuditEvent(sparse, executor);

    const row = result.row;
    for (const field of [
      "campaignId",
      "businessId",
      "workflowOperationId",
      "workflowAttemptId",
      "approvalRequestId",
      "artifactId",
      "packageId",
      "contentId",
    ] as const) {
      expect(field in row).toBe(true);
      expect(row[field]).toBeNull();
    }
    expect(state.insertedRows[0]?.campaignId).toBeNull();
  });

  it("persists only WBS7A-sanitized canonical metadata", async () => {
    const event = makeEvent();
    const { executor, state } = makeFakeAuditDb();

    await persistAuditEvent(event, executor);

    expect(state.insertedRows[0]?.metadata).toEqual({
      detail: { a: 1, b: 2, note: "ok" },
      platform: "instagram",
    });
  });

  it("rejects non-canonical candidates fail-closed and persists nothing", async () => {
    const event = makeEvent();
    const { executor, state } = makeFakeAuditDb();

    // Not an AuditEvent at all.
    await expect(
      persistAuditEvent(null as unknown as AuditEvent, executor)
    ).rejects.toMatchObject({ name: "AuditEventError", code: "INVALID_AUDIT_EVENT" });

    // Structurally invalid envelope.
    const invalid = { ...event, occurredAt: "yesterday" };
    await expect(persistAuditEvent(invalid, executor)).rejects.toMatchObject({
      code: "INVALID_AUDIT_EVENT",
    });

    // Unsanitized metadata (sensitive key) would not survive WBS7A construction.
    const withSecret = { ...event, metadata: { ...event.metadata, password: "hunter2" } };
    await expect(persistAuditEvent(withSecret, executor)).rejects.toMatchObject({
      code: "NONCANONICAL_AUDIT_EVENT",
    });

    // Unnormalized metadata key order is not the canonical form.
    const reordered = { ...event, metadata: { z: 1, a: 2 } };
    await expect(persistAuditEvent(reordered, executor)).rejects.toMatchObject({
      code: "NONCANONICAL_AUDIT_EVENT",
    });

    expect(state.selectCalls).toBe(0);
    expect(state.insertCalls).toBe(0);
    expect(state.rows).toHaveLength(0);
  });

  it("uses the supplied executor and never the default connection", async () => {
    const event = makeEvent();
    const { executor, state } = makeFakeAuditDb();

    const result = await persistAuditEvent(event, executor);

    expect(result.inserted).toBe(true);
    expect(state.insertCalls).toBe(1);
    expect(state.selectCalls).toBeGreaterThan(0);
    expect(getDb).not.toHaveBeenCalled();
  });
});

describe("AuditEventError surface", () => {
  it("exposes coded errors for conflict and validation failures", () => {
    expect(new AuditEventError("AUDIT_FINGERPRINT_CONFLICT", "x")).toBeInstanceOf(Error);
    expect(new AuditEventError("AUDIT_FINGERPRINT_CONFLICT", "x").name).toBe("AuditEventError");
  });
});
