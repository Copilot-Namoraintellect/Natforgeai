import { describe, it, expect } from "vitest";
import { TRPCError } from "@trpc/server";

import { buildPublicationReceipt } from "./publication-receipt";
import {
  buildPublicationOperationState,
  normalizePublicationQueueState,
  resolvePublicationExecutionDisposition,
  resolvePublicationOperationIdentity,
  type PublicationExecutionDisposition,
} from "./publication-idempotency";

const PUBLISHED_AT = "2026-07-01T12:00:00.000Z";
const NEXT_RETRY_AT = new Date("2026-07-01T12:05:00.000Z");
const PKG_ID = "ppv1-a".padEnd(45, "0");
const PKG_FP = "a".repeat(64);
const PKG_ID_2 = "ppv1-b".padEnd(45, "0");
const PKG_FP_2 = "b".repeat(64);

function queueRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
    platform: "instagram",
    status: "approved",
    retryCount: 0,
    maxRetries: 3,
    nextRetryAt: null,
    externalPostId: null,
    publishedAt: null,
    ...overrides,
  };
}

function governedReceipt() {
  return buildPublicationReceipt({
    normalized: {
      operationId: "publication:instagram:42",
      platform: "instagram",
      status: "published",
      externalPostId: "179424343423232",
      externalUrl: "https://www.instagram.com/p/ABC123/",
    },
    queueItemId: 42,
    platform: "instagram",
    publishedAtIso: PUBLISHED_AT,
  });
}

describe("resolvePublicationOperationIdentity", () => {
  it("derives a stable identity for the same queue item and platform", () => {
    const a = resolvePublicationOperationIdentity({ queueItemId: 42, platform: "instagram" });
    const b = resolvePublicationOperationIdentity({ queueItemId: 42, platform: "instagram" });
    expect(a.operationId).toBe("publication:instagram:42");
    expect(a.operationId).toBe(b.operationId);
  });

  it("derives a different identity for a different queue item", () => {
    const a = resolvePublicationOperationIdentity({ queueItemId: 42, platform: "instagram" });
    const b = resolvePublicationOperationIdentity({ queueItemId: 43, platform: "instagram" });
    expect(a.operationId).not.toBe(b.operationId);
  });

  it("keeps the platform inside the identity", () => {
    const instagram = resolvePublicationOperationIdentity({ queueItemId: 42, platform: "instagram" });
    const facebook = resolvePublicationOperationIdentity({ queueItemId: 42, platform: "facebook" });
    expect(instagram.operationId).toBe("publication:instagram:42");
    expect(facebook.operationId).toBe("publication:facebook:42");
    expect(instagram.operationId).not.toBe(facebook.operationId);
  });

  it("fails closed on malformed coordinates", () => {
    expect(() => resolvePublicationOperationIdentity({ queueItemId: 0, platform: "instagram" })).toThrow(
      TRPCError
    );
    expect(() => resolvePublicationOperationIdentity({ queueItemId: 42, platform: " " })).toThrow(
      TRPCError
    );
  });
});

describe("normalizePublicationQueueState", () => {
  it("normalizes a raw row and lowercases the platform", () => {
    const snapshot = normalizePublicationQueueState(queueRow({ platform: "Instagram" }));
    expect(snapshot.queueItemId).toBe(42);
    expect(snapshot.platform).toBe("instagram");
    expect(snapshot.status).toBe("approved");
    expect(snapshot.retryCount).toBe(0);
    expect(snapshot.maxRetries).toBe(3);
  });

  it("rejects unknown statuses and malformed ids", () => {
    expect(() => normalizePublicationQueueState(queueRow({ status: "exploded" }))).toThrow(TRPCError);
    expect(() => normalizePublicationQueueState(queueRow({ id: -1 }))).toThrow(TRPCError);
  });
});

describe("buildPublicationOperationState", () => {
  it("binds a stored receipt to the same queue item and platform", () => {
    const state = buildPublicationOperationState({
      queue: queueRow({ status: "published", publishedAt: new Date(PUBLISHED_AT) }),
      receipt: governedReceipt(),
    });
    expect(state.receipt?.queueItemId).toBe(42);
    expect(state.operationId).toBe("publication:instagram:42");
  });

  it("rejects a receipt bound to a different queue item", () => {
    const foreign = buildPublicationReceipt({
      normalized: {
        operationId: "publication:instagram:77",
        platform: "instagram",
        status: "published",
        externalPostId: "x",
      },
      queueItemId: 77,
      platform: "instagram",
      publishedAtIso: PUBLISHED_AT,
    });
    expect(() =>
      buildPublicationOperationState({
        queue: queueRow({ status: "published", publishedAt: new Date(PUBLISHED_AT) }),
        receipt: foreign,
      })
    ).toThrow(TRPCError);
  });

  it("rejects a malformed expected package binding", () => {
    expect(() =>
      buildPublicationOperationState({
        queue: queueRow(),
        expectedPackage: { publishPackageId: PKG_ID, packageFingerprintSha256: "nope" },
      })
    ).toThrow(TRPCError);
  });
});

describe("resolvePublicationExecutionDisposition", () => {
  it("allows a first execution on an approved queue item", () => {
    const disposition = resolvePublicationExecutionDisposition(
      buildPublicationOperationState({ queue: queueRow() })
    );
    expect(disposition.outcome).toBe("execute");
    if (disposition.outcome === "execute") {
      expect(disposition.attemptOrdinal).toBe(1);
      expect(disposition.maxRetries).toBe(3);
    }
  });

  it("exposes an in-flight attempt ordinal without turning it into success", () => {
    const disposition = resolvePublicationExecutionDisposition(
      buildPublicationOperationState({ queue: queueRow(), openAttemptOrdinal: 1 })
    );
    expect(disposition.outcome).toBe("execute");
    if (disposition.outcome === "execute") {
      expect(disposition.openAttemptOrdinal).toBe(1);
      expect(disposition.attemptOrdinal).toBe(1);
    }
  });

  it("allows a retry on a retryable failure with budget remaining", () => {
    const disposition = resolvePublicationExecutionDisposition(
      buildPublicationOperationState({
        queue: queueRow({
          status: "retrying",
          retryCount: 1,
          nextRetryAt: NEXT_RETRY_AT,
          lastError: "provider network timeout",
        }),
      })
    );
    expect(disposition.outcome).toBe("retry");
    if (disposition.outcome === "retry") {
      expect(disposition.attemptOrdinal).toBe(2);
      expect(disposition.retryCount).toBe(1);
      expect(disposition.maxRetries).toBe(3);
      expect(disposition.nextRetryAt).toEqual(NEXT_RETRY_AT);
    }
  });

  it("treats an exhausted retry budget as terminal, never as success", () => {
    const disposition = resolvePublicationExecutionDisposition(
      buildPublicationOperationState({
        queue: queueRow({ status: "retrying", retryCount: 3, maxRetries: 3 }),
      })
    );
    expect(disposition).toMatchObject({ outcome: "terminal", reason: "attempts_exhausted" });
  });

  it("handles terminal failures distinctly from retryable ones", () => {
    const failed = resolvePublicationExecutionDisposition(
      buildPublicationOperationState({ queue: queueRow({ status: "failed", retryCount: 3 }) })
    );
    const blocked = resolvePublicationExecutionDisposition(
      buildPublicationOperationState({ queue: queueRow({ status: "safety_blocked" }) })
    );
    const retrying = resolvePublicationExecutionDisposition(
      buildPublicationOperationState({ queue: queueRow({ status: "retrying", retryCount: 1 }) })
    );
    expect(failed).toMatchObject({ outcome: "terminal", reason: "already_terminal" });
    expect(blocked).toMatchObject({ outcome: "terminal", reason: "already_terminal" });
    expect(retrying.outcome).toBe("retry");
    expect(failed.outcome).not.toBe(retrying.outcome);
  });

  it("refuses execution for not-ready queue states", () => {
    for (const status of ["draft", "pending_approval"] as const) {
      const disposition = resolvePublicationExecutionDisposition(
        buildPublicationOperationState({ queue: queueRow({ status }) })
      );
      expect(disposition).toMatchObject({ outcome: "terminal", reason: "not_ready" });
    }
  });

  it("replays a durable success without any provider execution", () => {
    const state = buildPublicationOperationState({
      queue: queueRow({
        status: "published",
        publishedAt: new Date(PUBLISHED_AT),
        externalPostId: "179424343423232",
      }),
      receipt: governedReceipt(),
    });
    const first = resolvePublicationExecutionDisposition(state);
    const second = resolvePublicationExecutionDisposition(state);
    for (const disposition of [first, second]) {
      expect(disposition.outcome).toBe("replay_success");
      if (disposition.outcome === "replay_success") {
        expect(disposition.replayedWithoutProviderCall).toBe(true);
        expect(disposition.receipt.externalPostId).toBe("179424343423232");
        expect(disposition.receipt.status).toBe("published");
      }
    }
  });

  it("hydrates a legacy receipt from the published row when none was stored", () => {
    const disposition = resolvePublicationExecutionDisposition(
      buildPublicationOperationState({
        queue: queueRow({
          status: "published",
          publishedAt: new Date(PUBLISHED_AT),
          externalPostId: "179424343423232",
        }),
      })
    );
    expect(disposition.outcome).toBe("replay_success");
    if (disposition.outcome === "replay_success") {
      expect(disposition.receipt.classification).toBe("legacy");
      expect(disposition.receipt.publishPackageId).toBeNull();
      expect(disposition.receipt.externalPostId).toBe("179424343423232");
    }
  });

  it("replays a governed success only for the package it was recorded under", () => {
    const governed = {
      schemaVersion: 1,
      operationId: "publication:instagram:42",
      queueItemId: 42,
      platform: "instagram",
      status: "published",
      externalPostId: "179424343423232",
      externalUrl: "https://www.instagram.com/p/ABC123/",
      publishedAtIso: PUBLISHED_AT,
      classification: "governed",
      publishPackageId: PKG_ID,
      packageFingerprintSha256: PKG_FP,
      receivedAtIso: null,
    };
    const disposition = resolvePublicationExecutionDisposition(
      buildPublicationOperationState({
        queue: queueRow({ status: "published", publishedAt: new Date(PUBLISHED_AT) }),
        receipt: governed,
        expectedPackage: { publishPackageId: PKG_ID, packageFingerprintSha256: PKG_FP },
      })
    );
    expect(disposition.outcome).toBe("replay_success");
    if (disposition.outcome === "replay_success") {
      expect(disposition.receipt.publishPackageId).toBe(PKG_ID);
      expect(disposition.receipt.packageFingerprintSha256).toBe(PKG_FP);
    }
  });

  it("fails closed when the attempted package mismatches the recorded success", () => {
    const governed = {
      schemaVersion: 1,
      operationId: "publication:instagram:42",
      queueItemId: 42,
      platform: "instagram",
      status: "published",
      externalPostId: "179424343423232",
      externalUrl: "https://www.instagram.com/p/ABC123/",
      publishedAtIso: PUBLISHED_AT,
      classification: "governed",
      publishPackageId: PKG_ID,
      packageFingerprintSha256: PKG_FP,
      receivedAtIso: null,
    };
    for (const expectedPackage of [
      { publishPackageId: PKG_ID_2, packageFingerprintSha256: PKG_FP },
      { publishPackageId: PKG_ID, packageFingerprintSha256: PKG_FP_2 },
    ]) {
      const disposition = resolvePublicationExecutionDisposition(
        buildPublicationOperationState({
          queue: queueRow({ status: "published", publishedAt: new Date(PUBLISHED_AT) }),
          receipt: governed,
          expectedPackage,
        })
      );
      expect(disposition).toMatchObject({ outcome: "terminal", reason: "package_mismatch" });
    }
  });

  it("never borrows a success receipt for a governed package that cannot be proven", () => {
    // Governed attempt against a legacy (package-less) durable success.
    const legacyDisposition = resolvePublicationExecutionDisposition(
      buildPublicationOperationState({
        queue: queueRow({
          status: "published",
          publishedAt: new Date(PUBLISHED_AT),
          externalPostId: "179424343423232",
        }),
        expectedPackage: { publishPackageId: PKG_ID, packageFingerprintSha256: PKG_FP },
      })
    );
    expect(legacyDisposition).toMatchObject({
      outcome: "terminal",
      reason: "package_mismatch",
    });

    // Governed attempt against a published row with no stored receipt at all.
    const noReceiptDisposition = resolvePublicationExecutionDisposition(
      buildPublicationOperationState({
        queue: queueRow({ status: "published", publishedAt: new Date(PUBLISHED_AT) }),
        receipt: null,
        expectedPackage: { publishPackageId: PKG_ID, packageFingerprintSha256: PKG_FP },
      })
    );
    expect(noReceiptDisposition).toMatchObject({
      outcome: "terminal",
      reason: "package_mismatch",
    });
  });

  it("treats a success receipt with an unpublished queue row as drift, not as executable", () => {
    const disposition = resolvePublicationExecutionDisposition(
      buildPublicationOperationState({
        queue: queueRow({ status: "retrying", retryCount: 1 }),
        receipt: governedReceipt(),
      })
    );
    expect(disposition).toMatchObject({ outcome: "terminal", reason: "receipt_state_drift" });
  });

  it("treats a published row without a publication timestamp as drift", () => {
    const disposition = resolvePublicationExecutionDisposition(
      buildPublicationOperationState({
        queue: queueRow({ status: "published", publishedAt: null }),
      })
    );
    expect(disposition).toMatchObject({ outcome: "terminal", reason: "receipt_state_drift" });
  });

  it("lets a different queue item execute while another is published", () => {
    const publishedState = buildPublicationOperationState({
      queue: queueRow({
        id: 42,
        status: "published",
        publishedAt: new Date(PUBLISHED_AT),
        externalPostId: "179424343423232",
      }),
    });
    const freshState = buildPublicationOperationState({ queue: queueRow({ id: 43 }) });

    const publishedDisposition = resolvePublicationExecutionDisposition(publishedState);
    const freshDisposition = resolvePublicationExecutionDisposition(freshState);

    expect(publishedDisposition.outcome).toBe("replay_success");
    expect(freshDisposition.outcome).toBe("execute");
    if (freshDisposition.outcome === "execute" && publishedDisposition.outcome === "replay_success") {
      expect(freshDisposition.operationId).toBe("publication:instagram:43");
      expect(publishedDisposition.operationId).toBe("publication:instagram:42");
    }
  });

  it("keeps the same operation identity stable across the whole retry lifecycle", () => {
    const identities = [
      queueRow({ status: "approved" }),
      queueRow({ status: "retrying", retryCount: 1, nextRetryAt: NEXT_RETRY_AT }),
      queueRow({ status: "published", publishedAt: new Date(PUBLISHED_AT), externalPostId: "x" }),
    ].map(
      (row) =>
        resolvePublicationExecutionDisposition(buildPublicationOperationState({ queue: row }))
          .operationId
    );
    expect(new Set(identities).size).toBe(1);
    expect(identities[0]).toBe("publication:instagram:42");
  });

  it("produces outcome types that never allow a provider call on replay or terminal", () => {
    const outcomes: PublicationExecutionDisposition["outcome"][] = [
      resolvePublicationExecutionDisposition(buildPublicationOperationState({ queue: queueRow() })).outcome,
      resolvePublicationExecutionDisposition(
        buildPublicationOperationState({
          queue: queueRow({ status: "published", publishedAt: new Date(PUBLISHED_AT) }),
        })
      ).outcome,
      resolvePublicationExecutionDisposition(
        buildPublicationOperationState({ queue: queueRow({ status: "failed", retryCount: 3 }) })
      ).outcome,
    ];
    expect(outcomes).toEqual(["execute", "replay_success", "terminal"]);
  });
});
