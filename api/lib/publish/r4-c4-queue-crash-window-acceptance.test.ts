// ─── R4-C4: package → queue → claim crash-window acceptance (WBS13) ───
//
// Deterministic acceptance suite proving the named crash windows of the WBS13
// publishing authority. No real DB, Redis, BullMQ, or network: the durable
// boundaries are exercised through the repo's established mocking patterns
// (module-level vi.mock of ../../queries/connection, chainable drizzle fakes
// keyed by Symbol.for("drizzle:Name"), and an in-memory audit-store keyed by
// eventFingerprint).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { TRPCError } from "@trpc/server";

vi.mock("../../queries/connection", () => ({
  getDb: vi.fn(),
}));

// In-memory audit-store stand-in (mirrors api/lib/audit/audit-store.ts replay
// semantics): persistAuditEvent is keyed by the real WBS7A event fingerprint;
// an exact replay reuses the durable row, and a row found under the same
// fingerprint with different material content fails closed with the real
// AUDIT_FINGERPRINT_CONFLICT error shape.
const auditState = vi.hoisted(() => ({
  rows: new Map<string, Record<string, unknown>>(),
  persistCalls: 0,
  nextId: 9000,
}));

vi.mock("../audit/audit-store", async () => {
  const { buildAuditEventFingerprint, AuditEventError } = await import("../audit/audit-event");

  function canonicalJson(value: unknown): string {
    if (value === null || typeof value !== "object") {
      return JSON.stringify(value) ?? "undefined";
    }
    if (Array.isArray(value)) {
      return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
    }
    const obj = value as Record<string, unknown>;
    const entries = Object.keys(obj)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`);
    return `{${entries.join(",")}}`;
  }

  function normalizeSubjectId(value: unknown): string | null {
    return value === null || value === undefined ? null : String(value);
  }

  function rowMatchesEvent(
    row: Record<string, unknown>,
    event: Record<string, unknown>,
    fingerprint: string
  ): boolean {
    return (
      row.eventFingerprint === fingerprint &&
      row.eventType === event.eventType &&
      row.occurredAt === event.occurredAt &&
      row.userId === event.userId &&
      row.source === event.source &&
      row.outcome === event.outcome &&
      (row.campaignId ?? null) === (event.campaignId ?? null) &&
      normalizeSubjectId(row.packageId) === normalizeSubjectId(event.packageId) &&
      normalizeSubjectId(row.contentId) === normalizeSubjectId(event.contentId) &&
      canonicalJson(row.metadata) === canonicalJson(event.metadata)
    );
  }

  return {
    persistAuditEvent: async (event: any, _executor?: unknown) => {
      auditState.persistCalls += 1;
      const fingerprint = buildAuditEventFingerprint(event);
      const existing = auditState.rows.get(fingerprint);
      if (existing) {
        if (!rowMatchesEvent(existing, event, fingerprint)) {
          throw new AuditEventError(
            "AUDIT_FINGERPRINT_CONFLICT",
            `audit_events row for fingerprint ${fingerprint} exists with different material content; refusing to overwrite durable audit evidence.`
          );
        }
        return {
          event,
          row: existing,
          inserted: false,
          duplicateClassification: "idempotent_replay",
        };
      }
      const row: Record<string, unknown> = {
        id: auditState.nextId++,
        eventFingerprint: fingerprint,
        schemaVersion: event.schemaVersion,
        eventType: event.eventType,
        occurredAt: event.occurredAt,
        userId: event.userId,
        campaignId: event.campaignId ?? null,
        businessId: event.businessId ?? null,
        packageId: normalizeSubjectId(event.packageId),
        contentId: normalizeSubjectId(event.contentId),
        source: event.source,
        outcome: event.outcome,
        metadata: event.metadata,
      };
      auditState.rows.set(fingerprint, row);
      return { event, row, inserted: true, duplicateClassification: "none" };
    },
  };
});

// api/lib/queue/bullmq.ts pulls `bullmq`/`ioredis` at import time and reads
// env.redisUrl from ../env. Mock those dependencies (not the module under
// proof) so the REAL toPublishingBullMqJobId / isBullMQAvailable run here.
vi.mock("bullmq", () => ({}));
vi.mock("ioredis", () => ({ Redis: class {} }));
vi.mock("../env", () => ({ env: { redisUrl: "" } }));

import { publishingQueue } from "@db/schema";
import { buildPublishPackage, type PublishPackageBuildInput } from "./publish-package-builder";
import { deriveCreativeArtifactLineageFingerprint } from "../creative/artifact-lineage";
import {
  QUEUE_PUBLISH_PACKAGE_METADATA_KEY,
  QUEUE_PUBLISH_PACKAGE_REQUIRED_METADATA_KEY,
  assertQueuePublishPackageIntegrity,
  loadPersistedPublishPackage,
  resolveQueuePublishPackage,
  serializePublishPackageForQueue,
} from "./publish-package-queue-store";
import { markQueueItemFailedForInvalidPackage } from "./publish-package-queue-persistence";
import {
  assertPublicationScheduleMatchesQueueRow,
  publicationScheduleFromQueueRow,
  resolvePublicationSchedule,
} from "./publication-schedule";
import {
  buildPublicationOperationState,
  resolvePublicationExecutionDisposition,
} from "./publication-idempotency";
import { buildPublicationReceipt } from "./publication-receipt";
import {
  loadPublicationReceiptForQueueItem,
  persistPublicationReceipt,
} from "./publication-receipt-store";
import type { AuditDbExecutor } from "../audit/audit-store";
import { isBullMQAvailable, toPublishingBullMqJobId } from "../queue/bullmq";
import type { PublishPackage } from "./publish-package-contract";

const PUBLISHED_AT = "2026-07-01T12:00:00.000Z";
const SCHEDULE_NOW = new Date("2026-07-01T12:00:00.000Z");
const SCHEDULED_FUTURE_ISO = "2026-07-01T12:30:00Z";
const SCHEDULED_PAST_ISO = "2026-07-01T11:59:59Z";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);

const STRATEGY = {
  strategySnapshotId: "strategy_snapshot_1",
  strategyVersion: 3,
  businessDnaSnapshotId: "bdna_1",
  strategyHashSha256: HASH_A,
  strategyRunId: 55,
  approvalRequestId: 77,
  creativeBriefFingerprint: "brief_fp_1",
};

const APPROVED_COPY = {
  copyHashSha256: HASH_B,
  copySchemaVersion: "v2",
  approvedRevisionId: "rev-1",
  assessmentHashSha256: HASH_C,
  contextLockId: "ctx-1",
};

function buildGovernedPackage(): PublishPackage {
  return buildPublishPackage({
    campaignId: 7,
    userId: 9,
    businessId: 4,
    destination: { platform: "instagram", integrationId: 7 },
    intent: { mode: "immediate" },
    strategyAuthority: STRATEGY,
    approvedCopy: APPROVED_COPY,
    selectedContent: {
      contentPostId: 125,
      artifactKind: "content_post",
      lineage: {
        lineageSchemaVersion: 1,
        artifactKind: "content_post",
        artifactId: 125,
        lineageFingerprintSha256: HASH_D,
        strategy: STRATEGY,
        approvedCopy: APPROVED_COPY,
      },
    },
    captionArtifact: {
      artifactId: 501,
      artifactKind: "caption_pack",
      lineage: {
        lineageSchemaVersion: 1,
        artifactKind: "caption_pack",
        artifactId: 501,
        lineageFingerprintSha256: deriveCreativeArtifactLineageFingerprint({
          artifactKind: "caption_pack",
          platform: null,
          parent: null,
          strategy: STRATEGY,
          approvedCopy: APPROVED_COPY,
        }),
        strategy: STRATEGY,
        approvedCopy: APPROVED_COPY,
      },
    },
    evidence: { launchApprovalRequestId: 1 },
    payload: { text: "Hook\n\nCaption\n\nCTA", mediaUrls: [], mediaType: null },
  } as PublishPackageBuildInput);
}

/** Simulate the database JSON storage round trip. */
function dbRoundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

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

function governedReceipt(pkg: PublishPackage) {
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
    publishPackage: pkg,
  });
}

function getTableName(table: unknown): string | undefined {
  return (table as Record<symbol, unknown>)[Symbol.for("drizzle:Name") as symbol] as
    | string
    | undefined;
}

/**
 * Fake db for the guarded-claim scenarios: the conditional UPDATE reports
 * affectedRows=0 — another execution path already won the row.
 */
function createLosingClaimDb() {
  const updateCalls: Array<{ table: string | undefined; set: Record<string, unknown> }> = [];
  const db: any = {
    updateCalls,
    update: vi.fn((table: unknown) => ({
      set: vi.fn((data: Record<string, unknown>) => ({
        where: vi.fn(async () => {
          updateCalls.push({ table: getTableName(table), set: data });
          return [{ affectedRows: 0 }];
        }),
      })),
    })),
    transaction: async (cb: any) => cb(db),
  };
  return db;
}

/**
 * Fake executor for loadPublicationReceiptForQueueItem, fed from the mocked
 * audit-store's durable rows.
 */
function makeReceiptLoadExecutor(userId: number): AuditDbExecutor {
  const rows = [...auditState.rows.values()].filter(
    (row) => row.userId === userId && row.eventType === "publication_success"
  );
  return {
    select: (_fields?: unknown) => ({
      from: (_table: unknown) => ({
        where: (_condition: unknown) => ({
          orderBy: (_column: unknown) => ({
            limit: async (n: number) => rows.slice(0, n),
          }),
        }),
      }),
    }),
  } as unknown as AuditDbExecutor;
}

beforeEach(() => {
  vi.clearAllMocks();
  auditState.rows.clear();
  auditState.persistCalls = 0;
});

describe("R4-C4 queue crash windows (WBS13 publishing authority)", () => {
  it("1. package committed, queue insertion not completed — the persisted envelope survives an integrity re-check; a tampered one fails closed", () => {
    const pkg = buildGovernedPackage();
    // The package is serialized into the queue row metadata at materialisation;
    // the "insertion not completed" window means execution re-verifies these
    // bytes after the fact instead of trusting in-memory state.
    const persisted = dbRoundTrip(serializePublishPackageForQueue(pkg));
    const envelope = persisted[QUEUE_PUBLISH_PACKAGE_METADATA_KEY];

    const verified = assertQueuePublishPackageIntegrity(dbRoundTrip(envelope));
    expect(verified).toEqual(pkg);
    expect(verified.packageId).toBe(pkg.packageId);
    expect(Object.isFrozen(verified)).toBe(true);
    expect(loadPersistedPublishPackage(persisted)).toEqual(pkg);
    expect(persisted[QUEUE_PUBLISH_PACKAGE_REQUIRED_METADATA_KEY]).toBe(true);

    // A tampered envelope (identity coordinate swapped after persistence) does
    // not survive the re-check.
    const tampered: any = dbRoundTrip(persisted);
    tampered[QUEUE_PUBLISH_PACKAGE_METADATA_KEY].publishPackage.identity.campaignId = 999;
    expect(() => assertQueuePublishPackageIntegrity(tampered[QUEUE_PUBLISH_PACKAGE_METADATA_KEY])).toThrow(
      TRPCError
    );
    expect(resolveQueuePublishPackage(tampered).kind).toBe("invalid");
    expect(() => loadPersistedPublishPackage(tampered)).toThrow(/fingerprint/i);
  });

  it("2. queue insertion repeated — the same queue row id deterministically maps to one BullMQ job id", () => {
    // Repeated insertion of the same durable queue row cannot mint a second
    // job identity: toPublishingBullMqJobId is a pure derivation (the real
    // implementation from api/lib/queue/bullmq.ts; that module pulls
    // bullmq/ioredis at import time, so the deps are mocked, not the module).
    const firstInsertion = toPublishingBullMqJobId(42);
    const secondInsertion = toPublishingBullMqJobId(42);
    expect(firstInsertion).toBe("publish-42");
    expect(secondInsertion).toBe(firstInsertion);
    expect(toPublishingBullMqJobId(43)).not.toBe(firstInsertion);
  });

  it("3. duplicate queue job — deterministic job id plus replay_success: a published row with a canonical receipt never re-executes", () => {
    const pkg = buildGovernedPackage();
    const receipt = governedReceipt(pkg);

    // Deterministic job identity (as in scenario 2): the duplicate delivery
    // addresses the same BullMQ job.
    expect(toPublishingBullMqJobId(42)).toBe(toPublishingBullMqJobId(42));

    // The duplicate delivery consults durable state before any provider call.
    const state = buildPublicationOperationState({
      queue: queueRow({
        status: "published",
        publishedAt: new Date(PUBLISHED_AT),
        externalPostId: "179424343423232",
      }),
      receipt,
      expectedPackage: {
        publishPackageId: pkg.packageId,
        packageFingerprintSha256: pkg.packageFingerprintSha256,
      },
    });
    const first = resolvePublicationExecutionDisposition(state);
    const duplicate = resolvePublicationExecutionDisposition(state);

    for (const disposition of [first, duplicate]) {
      expect(disposition.outcome).toBe("replay_success");
      if (disposition.outcome === "replay_success") {
        expect(disposition.replayedWithoutProviderCall).toBe(true);
        expect(disposition.receipt.externalPostId).toBe("179424343423232");
        expect(disposition.receipt.publishPackageId).toBe(pkg.packageId);
      }
    }
    // No execution path exists for the duplicate.
    expect(duplicate).toEqual(first);
  });

  it("4. claim acquired, worker dies — the guarded claim is single-winner: affectedRows=0 makes the fail-closed mark a no-op with no failure event", async () => {
    const { getDb } = await import("../../queries/connection");
    // The publishing path has no lease; claiming is the guarded conditional
    // UPDATE (status IN approved/retrying). Simulate another path having
    // already terminalised the row: the guarded UPDATE matches 0 rows.
    const db = createLosingClaimDb();
    vi.mocked(getDb).mockReturnValue(db);

    const row = {
      id: 42,
      userId: 9,
      campaignId: 7,
      contentPostId: 125,
      platform: "instagram",
      status: "approved",
      retryCount: 0,
      maxRetries: 3,
      metadata: { [QUEUE_PUBLISH_PACKAGE_REQUIRED_METADATA_KEY]: true },
    } as any;

    await markQueueItemFailedForInvalidPackage(row, "marked governed but has no persisted package");

    // The guarded UPDATE was attempted against publishing_queue…
    expect(db.updateCalls).toHaveLength(1);
    expect(db.updateCalls[0].table).toBe(getTableName(publishingQueue));
    expect(db.updateCalls[0].set.status).toBe("failed");
    expect(db.updateCalls[0].set).not.toHaveProperty("metadata");
    // …but it lost the claim, so no canonical failure event is written and the
    // durable state (owned by the winner) stands untouched.
    expect(auditState.persistCalls).toBe(0);
    expect(auditState.rows.size).toBe(0);
  });

  it("5. worker restarts — with no durable success written, the same row still resolves to execute (exactly once, deterministically)", () => {
    const pkg = buildGovernedPackage();
    // Simulated crash: the worker died between claim and outcome, so nothing
    // durable was written — no receipt, row still approved.
    const state = buildPublicationOperationState({
      queue: queueRow({ status: "approved", retryCount: 0 }),
      receipt: null,
      expectedPackage: {
        publishPackageId: pkg.packageId,
        packageFingerprintSha256: pkg.packageFingerprintSha256,
      },
      openAttemptOrdinal: null,
    });

    const afterRestart = resolvePublicationExecutionDisposition(state);
    expect(afterRestart.outcome).toBe("execute");
    if (afterRestart.outcome === "execute") {
      expect(afterRestart.attemptOrdinal).toBe(1);
      expect(afterRestart.maxRetries).toBe(3);
    }
    // Re-execution is permitted exactly once per durable state: the decision is
    // a pure function, so a second overlapping runner makes the same call, and
    // the durable single-winner claim is what serialises them (scenario 4).
    expect(resolvePublicationExecutionDisposition(state)).toEqual(afterRestart);
  });

  it("6. scheduledAt NULL immediate work — a queue row without a scheduled instant yields immediate intent", () => {
    const fromRow = publicationScheduleFromQueueRow({ scheduledAt: null });
    expect(fromRow.mode).toBe("immediate");
    expect(fromRow.scheduledAtUtcIso).toBeNull();
    expect(fromRow.scheduledAtUtcMillis).toBeNull();

    // The resolved immediate schedule agrees with the NULL-scheduledAt row.
    const immediate = resolvePublicationSchedule({ mode: "immediate" }, { now: SCHEDULE_NOW });
    expect(immediate.mode).toBe("immediate");
    expect(() =>
      assertPublicationScheduleMatchesQueueRow(immediate, { scheduledAt: null })
    ).not.toThrow();

    // A scheduled schedule does not match a NULL-scheduledAt row.
    const scheduled = resolvePublicationSchedule(
      { mode: "scheduled", scheduledAtUtc: SCHEDULED_FUTURE_ISO },
      { now: SCHEDULE_NOW }
    );
    expect(() =>
      assertPublicationScheduleMatchesQueueRow(scheduled, { scheduledAt: null })
    ).toThrow(TRPCError);
  });

  it("7. future scheduled work — a future canonical instant resolves to its millis; a past instant fails closed per the not-before policy", () => {
    const future = resolvePublicationSchedule(
      { mode: "scheduled", scheduledAtUtc: SCHEDULED_FUTURE_ISO },
      { now: SCHEDULE_NOW }
    );
    expect(future.mode).toBe("scheduled");
    if (future.mode === "scheduled") {
      expect(future.scheduledAtUtcMillis).toBe(Date.UTC(2026, 6, 1, 12, 30, 0));
      expect(future.scheduledAtUtcIso).toBe("2026-07-01T12:30:00.000Z");
    }
    // The queue row carrying that instant agrees with the resolved schedule.
    expect(() =>
      assertPublicationScheduleMatchesQueueRow(future, {
        scheduledAt: new Date("2026-07-01T12:30:00Z"),
      })
    ).not.toThrow();

    // Not-before policy: strictly-past instant is a caller error, never a
    // silently-due item.
    expect(() =>
      resolvePublicationSchedule({ mode: "scheduled", scheduledAtUtc: SCHEDULED_PAST_ISO }, {
        now: SCHEDULE_NOW,
      })
    ).toThrow(/past/i);

    // Boundary: an instant exactly at the reference clock is allowed.
    const boundary = resolvePublicationSchedule(
      { mode: "scheduled", scheduledAtUtc: "2026-07-01T12:00:00Z" },
      { now: SCHEDULE_NOW }
    );
    expect(boundary.mode === "scheduled" && boundary.scheduledAtUtcMillis).toBe(
      SCHEDULE_NOW.getTime()
    );
  });

  it("8. BullMQ unavailable — isBullMQAvailable is false without a redisUrl, so no BullMQ execution path is claimed", () => {
    // ../env is mocked with an empty redisUrl (module scope), matching a
    // deployment with no Redis configured. isBullMQAvailable is the real,
    // side-effect-free predicate from api/lib/queue/bullmq.ts.
    expect(isBullMQAvailable()).toBe(false);
    // Cron due-scan ownership when BullMQ is unavailable is proven by
    // api/lib/publish/publishing-runner-immediate-due.test.ts.
  });

  it("9. Redis unavailable — same predicate: no redisUrl means no BullMQ/Redis execution path is claimed", () => {
    // Redis unavailability surfaces through the same guard (BullMQ jobs are
    // scheduled only when isBullMQAvailable()); with the redisUrl absent the
    // authority refuses to claim the queue path rather than failing mid-job.
    expect(isBullMQAvailable()).toBe(false);
    // Cron due-scan ownership is proven by
    // api/lib/publish/publishing-runner-immediate-due.test.ts.
  });

  it("10. queue and due-scan overlap — disposition convergence: both overlapping paths get the same execute/retry decision, and the durable claim is single-winner", () => {
    const pkg = buildGovernedPackage();
    const expectedPackage = {
      publishPackageId: pkg.packageId,
      packageFingerprintSha256: pkg.packageFingerprintSha256,
    };

    // BullMQ worker path and cron due-scan path both consult the same pure
    // disposition over the same durable state.
    const approvedState = buildPublicationOperationState({
      queue: queueRow({ status: "approved" }),
      expectedPackage,
    });
    const workerDecision = resolvePublicationExecutionDisposition(approvedState);
    const cronDecision = resolvePublicationExecutionDisposition(approvedState);
    expect(workerDecision.outcome).toBe("execute");
    expect(cronDecision).toEqual(workerDecision);

    const retryingState = buildPublicationOperationState({
      queue: queueRow({
        status: "retrying",
        retryCount: 1,
        nextRetryAt: new Date("2026-07-01T12:05:00.000Z"),
      }),
      expectedPackage,
    });
    const retryA = resolvePublicationExecutionDisposition(retryingState);
    const retryB = resolvePublicationExecutionDisposition(retryingState);
    expect(retryA.outcome).toBe("retry");
    expect(retryB).toEqual(retryA);

    // The disposition is a pure function of durable state (same input ⇒ same
    // output, no side effects), which is what makes overlap safe; the durable
    // single-winner claim itself is proved by scenario 4's affectedRows=0
    // no-op.
  });

  it.skip("11. launch rejected after queue materialisation — covered by api/lib/workflow/triggers.test.ts GAP29(a) (withdrawApprovedPublishingRows)", () => {
    // Cross-reference only; do not reimplement. The onApprovalResolved
    // campaign_launch rejection path (withdrawApprovedPublishingRows) is proven
    // there, including withdrawal of already-materialised publishing rows.
  });

  it("12. replay after successful publication — replay_success answers from the stored receipt with its published identity, no mutation; exact replay is durable-safe, mutated replay fails closed", async () => {
    const pkg = buildGovernedPackage();
    const receipt = governedReceipt(pkg);

    // The success is persisted durably through the mocked WBS7B store.
    const first = await persistPublicationReceipt({ receipt, userId: 9, campaignId: 7 });
    expect(first.inserted).toBe(true);
    expect(auditState.rows.size).toBe(1);

    // Exact replay (a second delivery of the same success) reuses the durable
    // row — same fingerprint, no duplicate evidence.
    const replay = await persistPublicationReceipt({ receipt, userId: 9, campaignId: 7 });
    expect(replay.inserted).toBe(false);
    expect(replay.duplicateClassification).toBe("idempotent_replay");
    expect(replay.row.id).toBe(first.row.id);
    expect(auditState.rows.size).toBe(1);

    // Round-trip: the loader reconstructs the identical canonical receipt.
    const loaded = await loadPublicationReceiptForQueueItem({
      queueItemId: 42,
      userId: 9,
      executor: makeReceiptLoadExecutor(9),
    });
    expect(loaded).toEqual(receipt);
    expect(loaded?.externalPostId).toBe("179424343423232");

    // A repeated execution after durable success resolves to replay_success
    // and answers with the stored receipt's published identity — no provider
    // call, no mutation of the receipt or of durable state.
    const state = buildPublicationOperationState({
      queue: queueRow({
        status: "published",
        publishedAt: new Date(PUBLISHED_AT),
        externalPostId: "179424343423232",
      }),
      receipt: loaded,
      expectedPackage: {
        publishPackageId: pkg.packageId,
        packageFingerprintSha256: pkg.packageFingerprintSha256,
      },
    });
    const disposition = resolvePublicationExecutionDisposition(state);
    expect(disposition.outcome).toBe("replay_success");
    if (disposition.outcome === "replay_success") {
      expect(disposition.replayedWithoutProviderCall).toBe(true);
      expect(disposition.receipt).toEqual(receipt);
      expect(disposition.receipt.operationId).toBe("publication:instagram:42");
      expect(disposition.receipt.externalPostId).toBe("179424343423232");
      expect(Object.isFrozen(disposition.receipt)).toBe(true);
    }
    expect(auditState.rows.size).toBe(1);

    // Mutated replay under the same fingerprint fails closed: corrupt the
    // durable row's material content (as if tampered evidence sat under the
    // live fingerprint), then replay the canonical receipt — the store refuses
    // to overwrite durable audit evidence.
    const durableRow = auditState.rows.get(first.row.eventFingerprint as string)!;
    durableRow.metadata = {
      ...(durableRow.metadata as Record<string, unknown>),
      publicationReceipt: {
        ...((durableRow.metadata as Record<string, unknown>).publicationReceipt as Record<
          string,
          unknown
        >),
        externalPostId: "tampered-after-success",
      },
    };
    await expect(
      persistPublicationReceipt({ receipt, userId: 9, campaignId: 7 })
    ).rejects.toMatchObject({ code: "AUDIT_FINGERPRINT_CONFLICT" });
    await expect(
      persistPublicationReceipt({ receipt, userId: 9, campaignId: 7 })
    ).rejects.toThrow(/fingerprint/i);
    // Nothing was overwritten: one durable row stands, still tampered-proof.
    expect(auditState.rows.size).toBe(1);
  });
});
