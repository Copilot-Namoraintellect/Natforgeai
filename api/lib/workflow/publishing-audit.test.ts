import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.PUBLIC_APP_URL = "https://natforgeai.com";

import { buildGroundedCreativeBrief } from "../creative/brief-grounding";

// Shared test holder: records side-effect ordering, configures the mocked
// provider/credit/downstream behavior, and lets mocks observe commit state.
const h = vi.hoisted(() => ({
  order: [] as string[],
  providerResult: undefined as undefined | { success: boolean; postId?: string; error?: string },
  providerThrow: undefined as undefined | Error,
  deductFail: undefined as undefined | Error,
  ingestFail: false,
  readCommitted: undefined as undefined | (() => boolean),
  committedAtEngineCall: [] as boolean[],
}));

vi.mock("../../queries/connection", () => ({
  getDb: vi.fn(() => {
    throw new Error("getDb must not fall back to a real connection in publishing audit tests");
  }),
}));

vi.mock("../integrations/platforms", () => ({
  publishToFacebook: vi.fn(async () => {
    h.order.push("provider");
    if (h.providerThrow) throw h.providerThrow;
    return h.providerResult ?? { success: true, postId: "fb_123" };
  }),
  publishToInstagram: vi.fn(),
  publishToLinkedIn: vi.fn(),
  publishToTwitter: vi.fn(),
  sendEmail: vi.fn(),
}));

vi.mock("../crypto", () => ({
  decryptToken: vi.fn((token: string | null | undefined) => (token ? `decrypted:${token}` : "")),
}));

vi.mock("../safety/checker", () => ({
  checkContentSafety: vi.fn(async () => ({ riskLevel: "low", reasons: [] })),
}));

vi.mock("../billing/credit-engine", () => ({
  deductCredits: vi.fn(async () => {
    h.order.push("deduction");
    if (h.deductFail) throw h.deductFail;
  }),
}));

vi.mock("../alerts", () => ({
  createAlert: vi.fn(async () => {}),
}));

vi.mock("../rate-limiter", () => ({
  rateLimitUser: vi.fn(async () => {}),
}));

vi.mock("../audience/ingest", () => ({
  ingestAudienceData: vi.fn(async () => {
    if (h.ingestFail) throw new Error("ingest exploded");
  }),
}));

vi.mock("./engine", () => ({
  transitionCampaignState: vi.fn(async () => {
    h.committedAtEngineCall.push(h.readCommitted?.() ?? false);
    return "campaign_live";
  }),
}));

import { getDb } from "../../queries/connection";
import { publishToFacebook } from "../integrations/platforms";
import { deductCredits } from "../billing/credit-engine";
import { createAlert } from "../alerts";
import { ingestAudienceData } from "../audience/ingest";
import { transitionCampaignState } from "./engine";
import { publishSinglePost } from "./publishing-runner";

const CREATED_AT = "2026-07-01T00:00:00.000Z";

function getTableName(table: unknown): string | undefined {
  return (table as Record<symbol, unknown>)[Symbol.for("drizzle:Name") as symbol] as string | undefined;
}

/** Extract the bound value from a drizzle eq() condition (Param chunk). */
function extractEqValue(condition: unknown): unknown {
  const seen = new Set<unknown>();
  const walk = (value: unknown): unknown => {
    if (!value || typeof value !== "object" || seen.has(value)) return undefined;
    seen.add(value);
    const record = value as Record<string, unknown>;
    if (record.constructor && (record.constructor as { name?: string }).name === "Param") {
      return record.value;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = walk(item);
        if (found !== undefined) return found;
      }
      return undefined;
    }
    for (const key of Object.keys(record)) {
      const found = walk(record[key]);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return walk(condition);
}

interface FakeConfig {
  queueItem: Record<string, unknown> | null;
  contentPost?: Record<string, unknown> | null;
  integration?: Record<string, unknown> | null;
  campaign?: Record<string, unknown> | null;
  business?: Record<string, unknown> | null;
  approvals?: Record<string, unknown>[];
  failAllAuditInserts?: Error;
  successUpdateError?: Error;
  contentPostsUpdateError?: Error;
  concurrentPublishedBeforeSuccessUpdate?: boolean;
}

/**
 * Stateful fake: outer operations mutate working stores directly (autocommit
 * model for attempt evidence / finalisation); transaction operations run on
 * tx-local copies that only become durable on commit, so rollback discards
 * them. Transaction semantics are fully observable via state.
 */
function createAuditFakeDb(config: FakeConfig) {
  const state = {
    txLog: [] as string[],
    transactions: 0,
    committed: false,
    rolledBack: false,
    committedQueue: null as Record<string, unknown> | null,
    committedAudits: null as Record<string, unknown>[] | null,
  };

  const working = {
    queue: config.queueItem ? { ...config.queueItem } : null,
    audits: [] as Record<string, unknown>[],
  };

  let publishedFlipApplied = false;

  const makeOps = (stores: { queue: Record<string, unknown> | null; audits: Record<string, unknown>[] }, tag: string | null) => {
    const log = (op: string) => {
      if (tag) state.txLog.push(`${tag}:${op}`);
    };
    const rowsFor = (name: string | undefined, condition?: unknown): Record<string, unknown>[] => {
      if (name === "publishing_queue") return stores.queue ? [{ ...stores.queue }] : [];
      if (name === "audit_events") {
        const fingerprint = condition ? extractEqValue(condition) : undefined;
        const rows = stores.audits.map((a) => ({ ...a }));
        return typeof fingerprint === "string"
          ? rows.filter((row) => row.eventFingerprint === fingerprint)
          : rows;
      }
      if (name === "content_posts") return config.contentPost ? [config.contentPost] : [];
      if (name === "social_integrations") return config.integration ? [config.integration] : [];
      if (name === "campaigns") return config.campaign ? [config.campaign] : [];
      if (name === "businesses") return config.business ? [config.business] : [];
      if (name === "approval_requests") return config.approvals ?? [];
      return [];
    };
    return {
      select: () => ({
        from: (table: unknown) => {
          const name = getTableName(table);
          const makeChain = (condition?: unknown): Record<string, unknown> => {
            const chain: Record<string, unknown> = {
              limit: async () => {
                log("select");
                return rowsFor(name, condition);
              },
              orderBy: () => chain,
              then: (resolve: (value: unknown) => unknown, reject?: (reason?: unknown) => unknown) => {
                log("select");
                return Promise.resolve(rowsFor(name, condition)).then(resolve, reject as never);
              },
              where: (nextCondition: unknown) => makeChain(nextCondition),
            };
            return chain;
          };
          return makeChain(undefined);
        },
      }),
      insert: (table: unknown) => ({
        values: (row: Record<string, unknown>) => {
          log("insert");
          if (getTableName(table) === "audit_events") {
            if (config.failAllAuditInserts) throw config.failAllAuditInserts;
            stores.audits.push({ id: stores.audits.length + 1, createdAt: new Date(CREATED_AT), ...row });
            h.order.push(`audit:${String(row.eventType)}`);
          }
          return Promise.resolve([{ insertId: 1 }]);
        },
      }),
      update: (table: unknown) => ({
        set: (payload: Record<string, unknown>) => ({
          where: () => {
            log("update");
            const name = getTableName(table);
            if (name === "publishing_queue" && stores.queue) {
              if (payload.status === "published") {
                if (config.concurrentPublishedBeforeSuccessUpdate && !publishedFlipApplied) {
                  publishedFlipApplied = true;
                  stores.queue.status = "published";
                  stores.queue.publishedAt = new Date("2026-05-05T05:05:05.000Z");
                  stores.queue.externalPostId = "fb_concurrent_winner";
                }
                const guardOk = stores.queue.status === "approved" || stores.queue.status === "retrying";
                if (!guardOk) return Promise.resolve([{ affectedRows: 0 }]);
                if (config.successUpdateError) throw config.successUpdateError;
                Object.assign(stores.queue, payload);
                return Promise.resolve([{ affectedRows: 1 }]);
              }
              Object.assign(stores.queue, payload);
              return Promise.resolve([{ affectedRows: 1 }]);
            }
            if (name === "content_posts" && config.contentPostsUpdateError) {
              throw config.contentPostsUpdateError;
            }
            return Promise.resolve([{ affectedRows: 1 }]);
          },
        }),
      }),
    };
  };

  const outer = makeOps(working, null);

  const db = {
    ...outer,
    transaction: async (cb: (tx: unknown) => Promise<unknown>) => {
      state.transactions += 1;
      const tag = `tx${state.transactions}`;
      const stores = {
        queue: working.queue ? { ...working.queue } : null,
        audits: working.audits.map((a) => ({ ...a })),
      };
      try {
        const result = await cb(makeOps(stores, tag));
        working.queue = stores.queue;
        working.audits = stores.audits;
        state.committed = true;
        state.committedQueue = stores.queue ? { ...stores.queue } : null;
        state.committedAudits = stores.audits.map((a) => ({ ...a }));
        return result;
      } catch (err) {
        state.rolledBack = true;
        throw err;
      }
    },
  };

  return { db, state, working };
}

const baseQueueItem = {
  id: 1,
  userId: 14,
  campaignId: 27,
  contentPostId: 117,
  platform: "facebook",
  status: "approved",
  safetyStatus: "low",
  retryCount: 0,
  maxRetries: 3,
  scheduledAt: null,
  nextRetryAt: null,
  integrationId: 9,
};

const baseIntegration = {
  id: 9,
  userId: 14,
  platform: "facebook",
  status: "connected",
  accountName: "Test Page",
  pageId: "830205703508466",
  pageAccessTokenEncrypted: "page-token-encrypted",
  accessTokenEncrypted: "user-token-encrypted",
};

const relativeImageUrl = "/generated/images/27/img.png";
const absoluteImageUrl = `https://natforgeai.com${relativeImageUrl}`;

const baseContentPost = {
  id: 117,
  hook: "Hook line",
  caption: "Caption body",
  cta: "Shop now",
  metadata: { imageUrl: relativeImageUrl },
};

const readyCampaign = {
  id: 27,
  userId: 14,
  businessId: 24,
  status: "active",
  productOrService: "Payout platform",
  targetBuyer: "Restaurants and delivery platforms",
  mainPainPoint: "manual payout reconciliation",
  primaryOutcome: "awareness",
  coreMessage: "Faster payouts for frontline teams",
};

const readyBusiness = { id: 24, userId: 14, name: "Zuto Hub", industry: "fintech payouts" };

function currentFingerprintFor(campaign: Record<string, unknown>) {
  return buildGroundedCreativeBrief({ campaign, business: readyBusiness }).fingerprint;
}

function campaignLinkedContentPost(overrides: Record<string, unknown> = {}) {
  return {
    ...baseContentPost,
    campaignId: 27,
    metadata: {
      imageUrl: relativeImageUrl,
      creativeBriefFingerprint: currentFingerprintFor(readyCampaign),
    },
    ...overrides,
  };
}

const approvedLaunchApproval = {
  id: 7,
  userId: 14,
  campaignId: 27,
  approvalType: "campaign_launch",
  status: "approved",
};

const readyCampaignWithApprovedLineage = {
  ...readyCampaign,
  workflowContext: {
    launchApprovalLineage: {
      creativeBriefFingerprint: currentFingerprintFor(readyCampaign),
      approvalRequestId: approvedLaunchApproval.id,
      status: "approved" as const,
    },
  },
};

/** Standard ready-to-publish fixture set (passes readiness + safety). */
function readyConfig(queueOverrides: Record<string, unknown> = {}) {
  return {
    queueItem: { ...baseQueueItem, ...queueOverrides },
    contentPost: campaignLinkedContentPost(),
    integration: baseIntegration,
    campaign: readyCampaignWithApprovedLineage,
    business: readyBusiness,
    approvals: [approvedLaunchApproval],
  };
}

function auditsOfType(state: { committedAudits: Record<string, unknown>[] | null }, eventType: string) {
  return (state.committedAudits ?? []).filter((a) => a.eventType === eventType);
}

function metadataOf(audit: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(audit.metadata)) as Record<string, unknown>;
}

/** The canonical WBS13.8 recovery-decision fields embedded in failure metadata. */
function recoveryDecisionOf(audit: Record<string, unknown>): Record<string, unknown> {
  const metadata = metadataOf(audit);
  return {
    recoveryClass: metadata.recoveryClass,
    action: metadata.action,
    retryable: metadata.retryable,
    callProviderAgain: metadata.callProviderAgain,
    retryCount: metadata.retryCount,
    nextRetryCount: metadata.nextRetryCount,
    maxRetries: metadata.maxRetries,
    delayMs: metadata.delayMs,
    nextRetryAt: metadata.nextRetryAt,
    terminal: metadata.terminal,
    terminalStatus: metadata.terminalStatus,
    escalationRequired: metadata.escalationRequired,
    escalationChannel: metadata.escalationChannel,
    safeReason: metadata.safeReason,
    providerErrorCode: metadata.providerErrorCode,
  };
}

describe("publishSinglePost governed audit (WBS7C3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.order = [];
    h.providerResult = undefined;
    h.providerThrow = undefined;
    h.deductFail = undefined;
    h.ingestFail = false;
    h.readCommitted = undefined;
    h.committedAtEngineCall = [];
  });

  it("persists publication_attempt before credit deduction and the provider call, with full lineage", async () => {
    const { db, state } = createAuditFakeDb(readyConfig());
    vi.mocked(getDb).mockReturnValue(db as never);

    const result = await publishSinglePost(1);

    expect(result.status).toBe("published");
    expect(h.order.indexOf("audit:publication_attempt")).toBeGreaterThanOrEqual(0);
    expect(h.order.indexOf("audit:publication_attempt")).toBeLessThan(h.order.indexOf("deduction"));
    expect(h.order.indexOf("deduction")).toBeLessThan(h.order.indexOf("provider"));

    const attempt = auditsOfType(state, "publication_attempt")[0]!;
    expect(state.committedAudits!.filter((a) => a.eventType === "publication_attempt")).toHaveLength(1);
    expect(attempt.userId).toBe(14);
    expect(attempt.campaignId).toBe(27);
    expect(attempt.contentId).toBe("117"); // subject ids persist as text
    expect(attempt.businessId).toBe(24);
    expect(attempt.source).toBe("workflow");
    expect(attempt.outcome).toBe("succeeded");
    expect(metadataOf(attempt)).toEqual({
      queueItemId: 1,
      platform: "facebook",
      attemptOrdinal: 1,
      queueStatusAtAttempt: "approved",
    });
  });

  it("attempt persistence failure: provider never called, no success evidence, execution propagates failure", async () => {
    const { db, state } = createAuditFakeDb({
      ...readyConfig(),
      failAllAuditInserts: new Error("audit store exploded"),
    });
    vi.mocked(getDb).mockReturnValue(db as never);

    await expect(publishSinglePost(1)).rejects.toMatchObject({ message: "audit store exploded" });
    expect(publishToFacebook).not.toHaveBeenCalled();
    expect(state.committedAudits ?? []).toHaveLength(0);
    expect(state.committedQueue).toBeNull();
  });

  it("success: queue published and publication_success commit in one transaction; publishedAt equals occurredAt", async () => {
    const { db, state } = createAuditFakeDb(readyConfig());
    vi.mocked(getDb).mockReturnValue(db as never);
    h.readCommitted = () => state.committed;

    const result = await publishSinglePost(1);

    expect(result.status).toBe("published");
    expect(state.txLog).toEqual([
      "tx1:update", // guarded queue publish
      "tx1:select", // audit pre-check
      "tx1:insert", // durable success event
      "tx1:select", // audit durability read
    ]);
    expect(state.committedQueue!.status).toBe("published");
    expect(state.committedQueue!.externalPostId).toBe("fb_123");
    expect(state.committedQueue!.lastError).toBeNull();

    const success = auditsOfType(state, "publication_success")[0]!;
    expect(auditsOfType(state, "publication_success")).toHaveLength(1);
    expect(success.occurredAt).toBe((state.committedQueue!.publishedAt as Date).toISOString());
    expect(success.userId).toBe(14);
    expect(success.campaignId).toBe(27);
    expect(success.contentId).toBe("117"); // subject ids persist as text
    expect(success.outcome).toBe("succeeded");
    // WBS13.7: the single durable success evidence IS the canonical receipt.
    expect(metadataOf(success)).toEqual({
      publicationReceipt: {
        schemaVersion: 1,
        operationId: "publication:facebook:1",
        queueItemId: 1,
        platform: "facebook",
        status: "published",
        externalPostId: "fb_123",
        externalUrl: null,
        publishedAtIso: success.occurredAt,
        classification: "legacy",
        publishPackageId: null,
        packageFingerprintSha256: null,
        receivedAtIso: null,
      },
    });
  });

  it("success audit metadata contains no payload, token, or content body", async () => {
    const { db, state } = createAuditFakeDb(readyConfig());
    vi.mocked(getDb).mockReturnValue(db as never);

    await publishSinglePost(1);

    const success = auditsOfType(state, "publication_success")[0]!;
    const serialized = JSON.stringify({ metadata: success.metadata, occurredAt: success.occurredAt });
    expect(serialized).not.toContain("Hook line");
    expect(serialized).not.toContain("Caption body");
    expect(serialized).not.toContain("Shop now");
    expect(serialized).not.toContain("decrypted:");
    expect(Object.keys(metadataOf(success)).sort()).toEqual(["publicationReceipt"]);
  });

  it("success transaction failure: no finalization, no ingestion, failure propagates", async () => {
    const { db, state } = createAuditFakeDb({
      ...readyConfig(),
      successUpdateError: new Error("queue publish exploded"),
    });
    vi.mocked(getDb).mockReturnValue(db as never);
    h.readCommitted = () => state.committed;

    await expect(publishSinglePost(1)).rejects.toMatchObject({ message: "queue publish exploded" });
    expect(state.committedQueue).toBeNull();
    expect(state.committedAudits).toBeNull();
    expect(transitionCampaignState).not.toHaveBeenCalled();
    expect(ingestAudienceData).not.toHaveBeenCalled();
  });

  it("already-compatible published replay: no conflicting rewrite, no duplicate incompatible evidence", async () => {
    const { db, state } = createAuditFakeDb({
      ...readyConfig(),
      concurrentPublishedBeforeSuccessUpdate: true,
    });
    vi.mocked(getDb).mockReturnValue(db as never);

    const result = await publishSinglePost(1);

    expect(result.status).toBe("published");
    expect(state.committedQueue!.publishedAt).toEqual(new Date("2026-05-05T05:05:05.000Z"));
    expect(state.committedQueue!.externalPostId).toBe("fb_concurrent_winner");
    const successes = auditsOfType(state, "publication_success");
    expect(successes).toHaveLength(1);
    expect(successes[0]!.occurredAt).toBe("2026-05-05T05:05:05.000Z");
    // Reconciled through the durable row's original success evidence: an
    // honest legacy receipt (no fabricated package correlation).
    expect(metadataOf(successes[0]!)).toEqual({
      publicationReceipt: {
        schemaVersion: 1,
        operationId: "publication:facebook:1",
        queueItemId: 1,
        platform: "facebook",
        status: "published",
        externalPostId: "fb_concurrent_winner",
        externalUrl: null,
        publishedAtIso: "2026-05-05T05:05:05.000Z",
        classification: "legacy",
        publishPackageId: null,
        packageFingerprintSha256: null,
        receivedAtIso: null,
      },
    });
  });

  it("transient provider failure: queue retrying with publication_failure in the same tx (terminal=false)", async () => {
    h.providerResult = { success: false, error: "provider boom" };
    const { db, state } = createAuditFakeDb(readyConfig());
    vi.mocked(getDb).mockReturnValue(db as never);

    const result = await publishSinglePost(1);

    expect(result.status).toBe("retrying");
    expect(state.txLog).toEqual(["tx1:update", "tx1:select", "tx1:insert", "tx1:select"]);
    expect(state.committedQueue!.status).toBe("retrying");
    expect(state.committedQueue!.retryCount).toBe(1);
    expect(state.committedQueue!.lastError).toBe("provider boom");
    const failure = auditsOfType(state, "publication_failure")[0]!;
    expect(auditsOfType(state, "publication_failure")).toHaveLength(1);
    expect(metadataOf(failure)).toEqual(
      expect.objectContaining({
        queueItemId: 1,
        platform: "facebook",
        attemptOrdinal: 1,
        terminal: false,
        nextState: "retrying",
        failureStage: "provider",
      })
    );
    // WBS13.8: the canonical recovery decision is embedded in the failure evidence.
    expect(recoveryDecisionOf(failure)).toEqual({
      recoveryClass: "rate_limited",
      action: "retry",
      retryable: true,
      callProviderAgain: true,
      retryCount: 0,
      nextRetryCount: 1,
      maxRetries: 3,
      delayMs: 60_000,
      nextRetryAt: expect.any(String),
      terminal: false,
      terminalStatus: null,
      escalationRequired: false,
      escalationChannel: null,
      safeReason: "Provider rate limit reached; a bounded retry is scheduled.",
      providerErrorCode: "provider_error",
    });
  });

  it("exhausted provider failure: queue failed with terminal publication_failure and alert", async () => {
    h.providerResult = { success: false, error: "provider boom" };
    const { db, state } = createAuditFakeDb(readyConfig({ retryCount: 2 }));
    vi.mocked(getDb).mockReturnValue(db as never);

    const result = await publishSinglePost(1);

    expect(result.status).toBe("failed");
    expect(state.committedQueue!.status).toBe("failed");
    expect(state.committedQueue!.retryCount).toBe(3);
    const failure = auditsOfType(state, "publication_failure")[0]!;
    expect(metadataOf(failure)).toEqual(
      expect.objectContaining({
        queueItemId: 1,
        platform: "facebook",
        attemptOrdinal: 3,
        terminal: true,
        nextState: "failed",
        failureStage: "provider",
      })
    );
    // Exhaustion escalates exactly once, through the canonical policy.
    expect(recoveryDecisionOf(failure)).toEqual({
      recoveryClass: "rate_limited",
      action: "escalate",
      retryable: false,
      callProviderAgain: false,
      retryCount: 2,
      nextRetryCount: 3,
      maxRetries: 3,
      delayMs: null,
      nextRetryAt: null,
      terminal: true,
      terminalStatus: "failed",
      escalationRequired: true,
      escalationChannel: { severity: "warning", category: "publishing" },
      safeReason:
        "Publication failed after 3 of 3 attempts; the retry budget is exhausted and the item is escalated for operator recovery.",
      providerErrorCode: "provider_error",
    });
    expect(createAlert).toHaveBeenCalledTimes(1);
  });

  it("billing block: provider not called, failure stage=billing, queue retrying", async () => {
    h.deductFail = new Error("insufficient credits");
    const { db, state } = createAuditFakeDb(readyConfig());
    vi.mocked(getDb).mockReturnValue(db as never);

    const result = await publishSinglePost(1);

    expect(result.status).toBe("retrying");
    expect(publishToFacebook).not.toHaveBeenCalled();
    expect(state.committedQueue!.status).toBe("retrying");
    expect(state.committedQueue!.lastError).toContain("Publishing blocked:");
    const failure = auditsOfType(state, "publication_failure")[0]!;
    expect(metadataOf(failure).failureStage).toBe("billing");
    expect(metadataOf(failure).terminal).toBe(false);
  });

  it("thrown provider failure follows the same governed failure persistence with stage=runtime", async () => {
    h.providerThrow = new Error("provider transport exploded");
    const { db, state } = createAuditFakeDb(readyConfig());
    vi.mocked(getDb).mockReturnValue(db as never);

    const result = await publishSinglePost(1);

    expect(result.status).toBe("retrying");
    expect(state.committedQueue!.status).toBe("retrying");
    expect(state.committedQueue!.retryCount).toBe(1);
    const failure = auditsOfType(state, "publication_failure")[0]!;
    expect(metadataOf(failure)).toEqual(
      expect.objectContaining({
        queueItemId: 1,
        platform: "facebook",
        attemptOrdinal: 1,
        terminal: false,
        nextState: "retrying",
        failureStage: "runtime",
      })
    );
    expect(recoveryDecisionOf(failure)).toEqual({
      recoveryClass: "rate_limited",
      action: "retry",
      retryable: true,
      callProviderAgain: true,
      retryCount: 0,
      nextRetryCount: 1,
      maxRetries: 3,
      delayMs: 60_000,
      nextRetryAt: expect.any(String),
      terminal: false,
      terminalStatus: null,
      escalationRequired: false,
      escalationChannel: null,
      safeReason: "Provider rate limit reached; a bounded retry is scheduled.",
      providerErrorCode: "provider_error",
    });
  });

  it("missing integration: queue failure preserved, stage=integration, no attempt, provider not called", async () => {
    const { db, state } = createAuditFakeDb({ ...readyConfig(), integration: null });
    vi.mocked(getDb).mockReturnValue(db as never);

    const result = await publishSinglePost(1);

    expect(result.status).toBe("precondition_failed");
    expect(result.unrecoverable).toBe(true);
    expect(publishToFacebook).not.toHaveBeenCalled();
    expect(state.committedQueue!.status).toBe("failed");
    expect(auditsOfType(state, "publication_attempt")).toHaveLength(0);
    const failure = auditsOfType(state, "publication_failure")[0]!;
    expect(metadataOf(failure).failureStage).toBe("integration");
    expect(metadataOf(failure).terminal).toBe(true);
    // Auth-class failures are reconnect-terminal and never consume retry budget.
    expect(recoveryDecisionOf(failure)).toEqual({
      recoveryClass: "auth",
      action: "reconnect",
      retryable: false,
      callProviderAgain: false,
      retryCount: 0,
      nextRetryCount: 0,
      maxRetries: 3,
      delayMs: null,
      nextRetryAt: null,
      terminal: true,
      terminalStatus: "failed",
      escalationRequired: false,
      escalationChannel: null,
      safeReason:
        "Publication credential failure: the platform integration is disconnected or its token expired or was revoked. Reconnect the integration to recover.",
      providerErrorCode: null,
    });
  });

  it("invalid media: queue failure preserved, stage=media, no attempt, provider not called", async () => {
    const { db, state } = createAuditFakeDb({
      ...readyConfig(),
      contentPost: campaignLinkedContentPost({
        metadata: {
          imageUrl: "blob:https://natforgeai.com/abc",
          creativeBriefFingerprint: currentFingerprintFor(readyCampaign),
        },
      }),
    });
    vi.mocked(getDb).mockReturnValue(db as never);

    const result = await publishSinglePost(1);

    expect(result.status).toBe("precondition_failed");
    expect(result.unrecoverable).toBe(true);
    expect(publishToFacebook).not.toHaveBeenCalled();
    expect(state.committedQueue!.status).toBe("failed");
    expect(auditsOfType(state, "publication_attempt")).toHaveLength(0);
    const failure = auditsOfType(state, "publication_failure")[0]!;
    expect(metadataOf(failure).failureStage).toBe("media");
    // Local media checks stay silent (no operator escalation).
    expect(recoveryDecisionOf(failure)).toEqual({
      recoveryClass: "provider_rejection",
      action: "fail_terminal",
      retryable: false,
      callProviderAgain: false,
      retryCount: 0,
      nextRetryCount: 0,
      maxRetries: 3,
      delayMs: null,
      nextRetryAt: null,
      terminal: true,
      terminalStatus: "failed",
      escalationRequired: false,
      escalationChannel: null,
      safeReason:
        "Publication payload failed a local media check and was never sent to the provider. The item is terminal until the payload is fixed and it is manually requeued.",
      providerErrorCode: null,
    });
  });

  it("readiness failure: approval-authority block routes to pending_approval, no attempt fabricated, provider not called", async () => {
    const { db, state } = createAuditFakeDb({ ...readyConfig(), approvals: [] });
    vi.mocked(getDb).mockReturnValue(db as never);

    const result = await publishSinglePost(1);

    expect(result.status).toBe("pending_approval");
    expect(publishToFacebook).not.toHaveBeenCalled();
    // WBS13.8: an approval-authority precondition parks the row awaiting a
    // human decision instead of fabricating a durable failure.
    expect(state.committedQueue!.status).toBe("pending_approval");
    expect(auditsOfType(state, "publication_attempt")).toHaveLength(0);
    const failure = auditsOfType(state, "publication_failure")[0]!;
    expect(metadataOf(failure)).toEqual(
      expect.objectContaining({
        queueItemId: 1,
        platform: "facebook",
        attemptOrdinal: 1,
        terminal: true,
        nextState: "pending_approval",
        failureStage: "precondition",
      })
    );
    expect(recoveryDecisionOf(failure)).toEqual({
      recoveryClass: "precondition",
      action: "require_approval",
      retryable: false,
      callProviderAgain: false,
      retryCount: 0,
      nextRetryCount: 0,
      maxRetries: 3,
      delayMs: null,
      nextRetryAt: null,
      terminal: true,
      terminalStatus: "pending_approval",
      escalationRequired: false,
      escalationChannel: null,
      safeReason:
        "Publication authority is incomplete: a required approval is missing. A human approval decision is required before this item can publish or be recovered.",
      providerErrorCode: null,
    });
  });

  it("safety_blocked stays safety_blocked and is not represented as a publication outcome", async () => {
    const { db, state, working } = createAuditFakeDb(readyConfig({ safetyStatus: "high" }));
    vi.mocked(getDb).mockReturnValue(db as never);

    const result = await publishSinglePost(1);

    expect(result.status).toBe("safety_blocked");
    expect(publishToFacebook).not.toHaveBeenCalled();
    expect(working.queue!.status).toBe("safety_blocked"); // outer-db state update by design
    expect(state.committedAudits ?? []).toHaveLength(0);
  });

  it("medium-risk retrying item becomes pending_approval, unchanged semantically, no publication audit", async () => {
    const { db, state, working } = createAuditFakeDb(readyConfig({ safetyStatus: "medium", status: "retrying" }));
    vi.mocked(getDb).mockReturnValue(db as never);

    const result = await publishSinglePost(1);

    expect(result.status).toBe("pending_approval");
    expect(publishToFacebook).not.toHaveBeenCalled();
    expect(working.queue!.status).toBe("pending_approval"); // outer-db state update by design
    expect(working.queue!.approvalRequired).toBe(true);
    expect(state.committedAudits ?? []).toHaveLength(0);
  });

  it("finalizeCampaignPublishState runs only after the committed success transaction", async () => {
    const { db, state } = createAuditFakeDb({
      ...readyConfig(),
      campaign: { ...readyCampaignWithApprovedLineage, workflowState: "publication_pending" },
    });
    vi.mocked(getDb).mockReturnValue(db as never);
    h.readCommitted = () => state.committed;

    await publishSinglePost(1);

    expect(transitionCampaignState).toHaveBeenCalledTimes(1);
    expect(transitionCampaignState).toHaveBeenCalledWith(27, 14, "go_live");
    expect(h.committedAtEngineCall).toEqual([true]);
    // The go_live authority is the WBS7C1 engine audit; no extra workflow
    // transition event is emitted from the publishing runner.
    expect(auditsOfType(state, "workflow_transition")).toHaveLength(0);
  });

  it("retry/failure paths never trigger campaign finalization", async () => {
    h.providerResult = { success: false, error: "provider boom" };
    const { db, state } = createAuditFakeDb({
      ...readyConfig(),
      campaign: { ...readyCampaignWithApprovedLineage, workflowState: "publication_pending" },
    });
    vi.mocked(getDb).mockReturnValue(db as never);
    h.readCommitted = () => state.committed;

    await publishSinglePost(1);

    expect(transitionCampaignState).not.toHaveBeenCalled();
    expect(ingestAudienceData).not.toHaveBeenCalled();
  });

  it("finalization failure after committed success does not undo publication evidence", async () => {
    const { db, state } = createAuditFakeDb({
      ...readyConfig(),
      campaign: { ...readyCampaignWithApprovedLineage, workflowState: "publication_pending" },
      contentPostsUpdateError: new Error("content post metadata exploded"),
    });
    vi.mocked(getDb).mockReturnValue(db as never);
    h.readCommitted = () => state.committed;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await publishSinglePost(1);

    expect(result.status).toBe("published");
    expect(state.committedQueue!.status).toBe("published");
    expect(auditsOfType(state, "publication_success")).toHaveLength(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("finalizeCampaignPublishState failed"),
      "content post metadata exploded"
    );
    errorSpy.mockRestore();
  });

  it("audience-ingestion failure after committed success does not undo publication evidence", async () => {
    h.ingestFail = true;
    const { db, state } = createAuditFakeDb(readyConfig());
    vi.mocked(getDb).mockReturnValue(db as never);
    h.readCommitted = () => state.committed;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await publishSinglePost(1);

    expect(result.status).toBe("published");
    expect(state.committedQueue!.status).toBe("published");
    expect(auditsOfType(state, "publication_success")).toHaveLength(1);
    await new Promise((resolve) => setImmediate(resolve));
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Post-publish audience ingestion failed"),
      "ingest exploded"
    );
    errorSpy.mockRestore();
  });
});
