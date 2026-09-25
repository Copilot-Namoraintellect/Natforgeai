import { describe, expect, it } from "vitest";
import {
  AUDIT_EVENT_TYPES,
  AuditEventError,
  buildAuditEventFingerprint,
  createAuditEvent,
  sanitizeAuditMetadata,
  type CreateAuditEventInput,
} from "./audit-event";

const baseInput: CreateAuditEventInput = {
  eventType: "publication_success",
  occurredAt: "2026-07-01T12:00:00.000Z",
  userId: 22,
  source: "workflow",
  outcome: "succeeded",
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
  metadata: { platform: "instagram", attemptOrdinal: 2 },
};

function expectAuditError(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AuditEventError);
    expect((err as AuditEventError).code).toBe(code);
    return;
  }
  throw new Error(`Expected AuditEventError(${code}) but no error was thrown.`);
}

describe("audit-event taxonomy", () => {
  it("covers the required canonical material-event types", () => {
    expect([...AUDIT_EVENT_TYPES]).toEqual([
      "workflow_transition",
      "approval_requested",
      "approval_resolved",
      "billing_deduction",
      "billing_refund_release",
      "publication_attempt",
      "publication_success",
      "publication_failure",
      "engagement_escalation",
      "learning_record_creation",
      "strategy_snapshot_materialized",
      "learning_promotion_resolved",
    ]);
  });

  it("accepts engagement_escalation as a canonical event type", () => {
    const event = createAuditEvent({
      eventType: "engagement_escalation",
      occurredAt: "2026-07-01T12:00:00.000Z",
      userId: 22,
      source: "system",
      outcome: "succeeded",
    });
    expect(event.eventType).toBe("engagement_escalation");
  });
});

describe("createAuditEvent normalization", () => {
  it("produces deterministic events and fingerprints for the same material input", () => {
    const a = createAuditEvent(baseInput);
    const b = createAuditEvent({ ...baseInput });
    expect(a).toEqual(b);
    expect(buildAuditEventFingerprint(a)).toBe(buildAuditEventFingerprint(b));
    expect(buildAuditEventFingerprint(a)).toHaveLength(64);
  });

  it("normalizes metadata key order so material-equal metadata is identical", () => {
    const a = createAuditEvent({
      ...baseInput,
      metadata: { zeta: 1, alpha: { d: 4, c: 3 }, mid: "x" },
    });
    const b = createAuditEvent({
      ...baseInput,
      metadata: { mid: "x", alpha: { c: 3, d: 4 }, zeta: 1 },
    });
    expect(a.metadata).toEqual({ alpha: { c: 3, d: 4 }, mid: "x", zeta: 1 });
    expect(a.metadata).toEqual(b.metadata);
    expect(buildAuditEventFingerprint(a)).toBe(buildAuditEventFingerprint(b));
  });

  it("returns a deeply frozen (immutable) envelope", () => {
    const event = createAuditEvent(baseInput);
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.metadata)).toBe(true);
    expect(() => {
      (event.metadata as Record<string, unknown>).platform = "tiktok";
    }).toThrow();
  });

  it("accepts every canonical event type", () => {
    for (const eventType of AUDIT_EVENT_TYPES) {
      const event = createAuditEvent({
        eventType,
        occurredAt: "2026-07-01T12:00:00.000Z",
        userId: 22,
        source: "system",
        outcome: "succeeded",
      });
      expect(event.eventType).toBe(eventType);
    }
  });
});

describe("createAuditEvent correlation handling", () => {
  it("preserves correlation identifiers exactly", () => {
    const event = createAuditEvent(baseInput);
    expect(event.workflowOperationId).toBe(baseInput.workflowOperationId);
    expect(event.workflowAttemptId).toBe(baseInput.workflowAttemptId);
    expect(event.approvalRequestId).toBe(36);
    expect(event.campaignId).toBe(30);
    expect(event.businessId).toBe(26);
    expect(event.userId).toBe(22);
  });

  it("keeps null correlation values null instead of inventing identifiers", () => {
    const event = createAuditEvent({
      eventType: "learning_record_creation",
      occurredAt: "2026-07-01T12:00:00.000Z",
      userId: 22,
      source: "system",
      outcome: "succeeded",
      campaignId: null,
      businessId: null,
      workflowOperationId: null,
      workflowAttemptId: null,
      approvalRequestId: null,
      artifactId: null,
      packageId: null,
      contentId: null,
    });
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
      expect(field in event).toBe(true);
      expect(event[field]).toBeNull();
    }
  });

  it("treats omitted correlation fields as null", () => {
    const event = createAuditEvent({
      eventType: "billing_deduction",
      occurredAt: "2026-07-01T12:00:00.000Z",
      userId: 22,
      source: "workflow",
      outcome: "succeeded",
    });
    expect(event.campaignId).toBeNull();
    expect(event.workflowOperationId).toBeNull();
    expect(event.metadata).toEqual({});
  });
});

describe("createAuditEvent fail-closed validation", () => {
  it("rejects unknown or blank event types", () => {
    expectAuditError(
      () => createAuditEvent({ ...baseInput, eventType: "not_a_real_event" as never }),
      "INVALID_AUDIT_EVENT_TYPE"
    );
    expectAuditError(
      () => createAuditEvent({ ...baseInput, eventType: "   " as never }),
      "INVALID_AUDIT_EVENT_TYPE"
    );
  });

  it("rejects unknown or blank sources and outcomes", () => {
    expectAuditError(
      () => createAuditEvent({ ...baseInput, source: "hacker" as never }),
      "INVALID_AUDIT_EVENT_SOURCE"
    );
    expectAuditError(
      () => createAuditEvent({ ...baseInput, source: "" as never }),
      "INVALID_AUDIT_EVENT_SOURCE"
    );
    expectAuditError(
      () => createAuditEvent({ ...baseInput, outcome: "maybe" as never }),
      "INVALID_AUDIT_EVENT_OUTCOME"
    );
  });

  it("rejects malformed, missing, or unparseable occurredAt", () => {
    for (const occurredAt of [
      "not-a-timestamp",
      "2026-07-01 12:00:00",
      "2026-13-40T99:99:99Z",
      "",
      undefined as never,
      12345 as never,
    ]) {
      expectAuditError(
        () => createAuditEvent({ ...baseInput, occurredAt }),
        "INVALID_AUDIT_OCCURRED_AT"
      );
    }
  });

  it("rejects malformed userId and correlation identifiers", () => {
    for (const userId of [0, -1, 2.5, "22" as never, NaN]) {
      expectAuditError(() => createAuditEvent({ ...baseInput, userId }), "INVALID_AUDIT_USER_ID");
    }
    expectAuditError(
      () => createAuditEvent({ ...baseInput, workflowOperationId: "   " }),
      "INVALID_AUDIT_CORRELATION_ID"
    );
    expectAuditError(
      () => createAuditEvent({ ...baseInput, workflowAttemptId: 12 as never }),
      "INVALID_AUDIT_CORRELATION_ID"
    );
    expectAuditError(
      () => createAuditEvent({ ...baseInput, approvalRequestId: -3 }),
      "INVALID_AUDIT_CORRELATION_ID"
    );
    expectAuditError(
      () => createAuditEvent({ ...baseInput, artifactId: {} as never }),
      "INVALID_AUDIT_CORRELATION_ID"
    );
  });

  it("rejects non-structured metadata containers", () => {
    for (const metadata of [[1, 2], "payload", 42, new Date()]) {
      expectAuditError(
        () => createAuditEvent({ ...baseInput, metadata: metadata as never }),
        "INVALID_AUDIT_METADATA"
      );
    }
  });

  it("rejects Error objects, functions, and class instances in metadata", () => {
    class RequestLike {
      headers = { authorization: "Bearer xyz" };
      body = { password: "hunter2" };
    }
    expectAuditError(
      () => createAuditEvent({ ...baseInput, metadata: { err: new Error("boom") } }),
      "AUDIT_METADATA_ERROR_VALUE"
    );
    expectAuditError(
      () => createAuditEvent({ ...baseInput, metadata: { cb: () => 1 } }),
      "INVALID_AUDIT_METADATA"
    );
    expectAuditError(
      () => createAuditEvent({ ...baseInput, metadata: { req: new RequestLike() } }),
      "INVALID_AUDIT_METADATA"
    );
    expectAuditError(
      () => createAuditEvent({ ...baseInput, metadata: { "   ": 1 } }),
      "INVALID_AUDIT_METADATA_KEY"
    );
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 12; i++) deep = { nest: deep };
    expectAuditError(
      () => createAuditEvent({ ...baseInput, metadata: deep }),
      "INVALID_AUDIT_METADATA"
    );
  });
});

describe("audit-event metadata hygiene", () => {
  it("removes sensitive keys deterministically at every nesting level", () => {
    const event = createAuditEvent({
      ...baseInput,
      metadata: {
        token: "abc123",
        nested: { password: "hunter2", authorization: "Bearer xyz", note: "ok" },
        keep: 1,
      },
    });
    expect(event.metadata).toEqual({ keep: 1, nested: { note: "ok" } });
    const again = createAuditEvent({
      ...baseInput,
      metadata: {
        token: "abc123",
        nested: { password: "hunter2", authorization: "Bearer xyz", note: "ok" },
        keep: 1,
      },
    });
    expect(event.metadata).toEqual(again.metadata);
  });

  it("removes sensitive keys case-insensitively", () => {
    const event = createAuditEvent({
      ...baseInput,
      metadata: { ApiKey: "k", SESSION_ID: "s", SECRET_TOKEN: "t", safe: true },
    });
    expect(event.metadata).toEqual({ safe: true });
  });

  it("sanitizeAuditMetadata is pure and returns a fresh sorted object", () => {
    const input = { b: 2, a: 1 };
    const out = sanitizeAuditMetadata(input);
    expect(out).toEqual({ a: 1, b: 2 });
    expect(out).not.toBe(input);
    expect(Object.keys(out)).toEqual(["a", "b"]);
    expect(sanitizeAuditMetadata(null)).toEqual({});
    expect(sanitizeAuditMetadata(undefined)).toEqual({});
  });
});

describe("audit-event occurredAt handling", () => {
  it("uses the explicit occurredAt verbatim and never invents a timestamp", () => {
    const explicit = "2026-03-04T05:06:07.890Z";
    const event = createAuditEvent({ ...baseInput, occurredAt: explicit });
    expect(event.occurredAt).toBe(explicit);
    const sameAgain = createAuditEvent({ ...baseInput, occurredAt: explicit });
    expect(sameAgain.occurredAt).toBe(explicit);
    expect(buildAuditEventFingerprint(sameAgain)).toBe(buildAuditEventFingerprint(event));
  });

  it("fingerprints differ when the supplied occurredAt differs", () => {
    const a = createAuditEvent({ ...baseInput, occurredAt: "2026-07-01T12:00:00.000Z" });
    const b = createAuditEvent({ ...baseInput, occurredAt: "2026-07-01T12:00:01.000Z" });
    expect(buildAuditEventFingerprint(a)).not.toBe(buildAuditEventFingerprint(b));
  });
});
