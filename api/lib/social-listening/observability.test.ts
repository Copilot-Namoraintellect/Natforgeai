import { describe, it, expect } from "vitest";
import { getListeningOverview, listSignalsForUser } from "./observability";
import { classifyListeningFailure } from "./failure-classes";
import { createListeningFakeDb } from "./testing/fake-listening-db";

const NOW = new Date("2026-07-05T12:00:00.000Z");
const RECENT = new Date("2026-07-05T11:00:00.000Z");
const OLD = new Date("2026-07-01T00:00:00.000Z");

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
        accountName: "Acme Page",
        createdAt: RECENT,
      },
      {
        id: 12,
        userId: 8,
        businessId: 9,
        platform: "twitter",
        pageId: "tw-1",
        instagramBusinessAccountId: null,
        status: "connected",
        accountName: "Other Tenant",
        createdAt: RECENT,
      },
    ],
    listeningStates: [
      {
        integrationId: 11,
        userId: 7,
        businessId: 3,
        provider: "meta",
        platform: "facebook",
        providerAccountId: "page-1",
        mechanism: "webhook",
        status: "active",
        cursor: null,
        lastSuccessAt: RECENT,
        lastFailureAt: null,
        lastFailureClass: null,
        lastFailureCode: null,
        lastFailureReason: null,
        acceptedCount: 4,
        duplicateCount: 2,
        rejectedCount: 1,
      },
      {
        integrationId: 12,
        userId: 8,
        businessId: 9,
        provider: "twitter",
        platform: "twitter",
        providerAccountId: "tw-1",
        mechanism: "unsupported",
        status: "unsupported",
        cursor: null,
        lastSuccessAt: null,
        lastFailureAt: RECENT,
        lastFailureClass: "OPERATOR_ACTION",
        lastFailureCode: "LISTENING_NOT_CONFIGURED",
        lastFailureReason: "provider listening setup missing",
        acceptedCount: 0,
        duplicateCount: 0,
        rejectedCount: 0,
      },
    ],
    signals: [
      {
        id: 1,
        signalKey: "sigv1:a",
        userId: 7,
        businessId: 3,
        provider: "meta",
        platform: "facebook",
        integrationId: 11,
        providerAccountId: "page-1",
        externalEventId: "e-1",
        signalType: "comment",
        occurredAt: RECENT,
        observedAt: RECENT,
        attributionType: "direct",
        status: "accepted",
        ingestionVersion: 1,
        providerEvidenceHash: "h",
        createdAt: RECENT,
      },
      {
        id: 2,
        signalKey: "sigv1:b",
        userId: 7,
        businessId: 3,
        provider: "meta",
        platform: "facebook",
        integrationId: 11,
        providerAccountId: "page-1",
        externalEventId: "e-2",
        signalType: "comment",
        occurredAt: OLD,
        observedAt: OLD,
        attributionType: "business",
        status: "accepted",
        ingestionVersion: 1,
        providerEvidenceHash: "h",
        createdAt: OLD,
      },
    ],
  });
}

describe("getListeningOverview", () => {
  it("tenant-scoped overview: only the caller's bindings, with status + counters", async () => {
    const db = seedDb();
    const overview = await getListeningOverview({ userId: 7, executor: db, now: NOW });

    expect(overview).toHaveLength(1);
    const binding = overview[0];
    expect(binding).toMatchObject({
      integrationId: 11,
      provider: "meta",
      platform: "facebook",
      providerAccountId: "page-1",
      mechanism: "webhook",
      status: "active",
      capability: { webhook: "supported", polling: "supported" },
      acceptedCount: 4,
      duplicateCount: 2,
      rejectedCount: 1,
      stale: false,
      unsupported: false,
      configurationBlocker: null,
    });
    // recentSignalCount counts only signals observed in the last 24h.
    expect(binding.recentSignalCount).toBe(1);
  });

  it("unsupported platform surfaces unsupported + blocker, never fake success", async () => {
    const db = seedDb();
    const overview = await getListeningOverview({ userId: 8, executor: db, now: NOW });
    expect(overview[0]).toMatchObject({
      platform: "twitter",
      unsupported: true,
      mechanism: "unsupported",
      status: "unsupported",
      capability: { webhook: "unsupported", polling: "unsupported" },
      configurationBlocker: "listening unsupported for this platform",
    });
  });

  it("stale-listening warning when last success is older than 24h", async () => {
    const db = seedDb();
    const overview = await getListeningOverview({
      userId: 7,
      executor: db,
      now: new Date(NOW.getTime() + 25 * 60 * 60 * 1000),
    });
    expect(overview[0].stale).toBe(true);
  });

  it("admin view spans tenants", async () => {
    const db = seedDb();
    const overview = await getListeningOverview({ executor: db, now: NOW });
    expect(overview.map((b) => b.integrationId).sort()).toEqual([11, 12]);
  });
});

describe("listSignalsForUser", () => {
  it("returns only the caller's signals, optionally filtered", async () => {
    const db = seedDb();
    const all = await listSignalsForUser({ userId: 7, executor: db });
    expect(all).toHaveLength(2);

    const directOnly = await listSignalsForUser({
      userId: 7,
      attributionType: "direct",
      executor: db,
    });
    expect(directOnly).toHaveLength(1);
    expect(directOnly[0].attributionType).toBe("direct");

    const otherTenant = await listSignalsForUser({ userId: 8, executor: db });
    expect(otherTenant).toHaveLength(0); // strict tenant isolation
  });
});

describe("classifyListeningFailure (A6 failure classes)", () => {
  it.each([
    [new Error("429 Too Many Requests"), "AUTO_RECOVER"],
    [new Error("fetch failed: ETIMEDOUT"), "AUTO_RECOVER"],
    [new Error("invalid token: session expired"), "OPERATOR_ACTION"],
    [new Error("LISTENING_NOT_CONFIGURED: no seam"), "OPERATOR_ACTION"],
    [new Error("permission scope pages_read_engagement missing"), "OPERATOR_ACTION"],
  ])("classifies %s → %s", (err, expected) => {
    expect(classifyListeningFailure(err).class).toBe(expected);
  });
});
