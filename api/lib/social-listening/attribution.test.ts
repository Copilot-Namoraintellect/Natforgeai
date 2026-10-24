import { describe, it, expect, vi } from "vitest";
import {
  resolveSignalAttribution,
  resolveBindingForProviderAccount,
} from "./attribution";
import { derivePublicationOperationId } from "../integrations/adapters/platform-adapter";

interface FakeTableRows {
  social_integrations?: any[];
  publishing_queue?: any[];
  audit_events?: any[];
}

function createFakeDb(rows: FakeTableRows) {
  const db: any = {
    select: vi.fn(() => ({
      from: vi.fn((table: any) => {
        const name = table[Symbol.for("drizzle:Name")];
        // Emulate the predicates the attribution queries rely on.
        const tableRows =
          name === "social_integrations"
            ? (rows.social_integrations ?? []).filter((r) => r.status === "connected")
            : name === "publishing_queue"
              ? (rows.publishing_queue ?? []).filter((r) => r.status === "published")
              : name === "audit_events"
                ? rows.audit_events ?? []
                : [];
        const query = {
          where: vi.fn(() => ({
            limit: vi.fn(async () => tableRows),
            orderBy: vi.fn(() => ({
              limit: vi.fn(async () => tableRows),
            })),
          })),
        };
        return query;
      }),
    })),
  };
  return db;
}

const integration = { id: 11, userId: 7, businessId: 3 };

describe("resolveSignalAttribution", () => {
  it("DIRECT: published post under the same tenant binds campaign + receipt", async () => {
    const db = createFakeDb({
      publishing_queue: [
        {
          queueItemId: 42,
          userId: 7,
          campaignId: 5,
          status: "published",
          publishedAt: new Date("2026-07-01T09:00:00Z"),
        },
      ],
      audit_events: [
        {
          eventFingerprint: "fp1",
          metadata: { receipt: { operationId: "publication:facebook:42" } },
        },
      ],
    });

    const result = await resolveSignalAttribution({
      integration,
      platform: "facebook",
      externalObjectId: "post-1",
      executor: db,
    });

    expect(result).toEqual({
      attributionType: "direct",
      businessId: 3,
      sourceCampaignId: 5,
      sourcePublicationId: "publication:facebook:42",
      sourcePublicationReceiptId: "fp1",
    });
  });

  it("DIRECT (legacy): queue success without a canonical receipt keeps receipt id null", async () => {
    const db = createFakeDb({
      publishing_queue: [{ queueItemId: 43, userId: 7, campaignId: 8, status: "published", publishedAt: new Date() }],
      audit_events: [],
    });

    const result = await resolveSignalAttribution({
      integration,
      platform: "facebook",
      externalObjectId: "post-legacy",
      executor: db,
    });

    expect(result.attributionType).toBe("direct");
    expect(result.sourceCampaignId).toBe(8);
    expect(result.sourcePublicationId).toBe("publication:facebook:43");
    expect(result.sourcePublicationReceiptId).toBeNull();
  });

  it("foreign publication (different tenant) is not bound — unattributed, no throw", async () => {
    const db = createFakeDb({
      publishing_queue: [{ queueItemId: 44, userId: 99, campaignId: 5, status: "published", publishedAt: new Date() }],
    });

    const result = await resolveSignalAttribution({
      integration,
      platform: "facebook",
      externalObjectId: "post-foreign",
      executor: db,
    });

    expect(result).toEqual({
      attributionType: "business",
      businessId: 3,
      sourceCampaignId: null,
      sourcePublicationId: null,
      sourcePublicationReceiptId: null,
    });
  });

  it("BUSINESS: unknown post with a business binding", async () => {
    const db = createFakeDb({});
    const result = await resolveSignalAttribution({
      integration,
      platform: "facebook",
      externalObjectId: "post-unknown",
      executor: db,
    });
    expect(result.attributionType).toBe("business");
    expect(result.businessId).toBe(3);
    expect(result.sourceCampaignId).toBeNull();
  });

  it("UNATTRIBUTED: unknown post without a business binding; direct message shape", async () => {
    const db = createFakeDb({});
    const noBusiness = await resolveSignalAttribution({
      integration: { id: 11, userId: 7, businessId: null },
      platform: "facebook",
      externalObjectId: "post-unknown",
      executor: db,
    });
    expect(noBusiness.attributionType).toBe("unattributed");
    expect(noBusiness.businessId).toBeNull();

    const dm = await resolveSignalAttribution({
      integration,
      platform: "whatsapp",
      externalObjectId: null,
      executor: db,
    });
    expect(dm.attributionType).toBe("business");
    expect(dm.sourcePublicationId).toBeNull();
  });

  it("unpublished / failed queue rows never bind", async () => {
    const db = createFakeDb({
      publishing_queue: [{ queueItemId: 45, userId: 7, campaignId: 5, status: "failed" }],
    });
    const result = await resolveSignalAttribution({
      integration,
      platform: "facebook",
      externalObjectId: "post-1",
      executor: db,
    });
    expect(result.attributionType).toBe("business");
    expect(result.sourcePublicationId).toBeNull();
  });
});

describe("resolveBindingForProviderAccount", () => {
  it("binds by page id or instagram business account id, connected only", async () => {
    const rows = [
      { id: 1, userId: 7, businessId: 3, pageId: "page-1", instagramBusinessAccountId: null, status: "connected", platform: "facebook" },
      { id: 2, userId: 8, businessId: 4, pageId: "page-2", instagramBusinessAccountId: "ig-9", status: "connected", platform: "instagram" },
      { id: 3, userId: 9, businessId: null, pageId: "page-3", instagramBusinessAccountId: null, status: "disconnected", platform: "facebook" },
    ];
    const db = createFakeDb({ social_integrations: rows });

    const byPage = await resolveBindingForProviderAccount({
      platform: "facebook",
      providerAccountId: "page-1",
      executor: db,
    });
    expect(byPage?.id).toBe(1);

    const byIg = await resolveBindingForProviderAccount({
      platform: "instagram",
      providerAccountId: "ig-9",
      executor: db,
    });
    expect(byIg?.id).toBe(2);

    // Disconnected binding does not own the account → null (fail closed).
    const disconnected = await resolveBindingForProviderAccount({
      platform: "facebook",
      providerAccountId: "page-3",
      executor: db,
    });
    expect(disconnected).toBeNull();

    const unknown = await resolveBindingForProviderAccount({
      platform: "facebook",
      providerAccountId: "page-nope",
      executor: db,
    });
    expect(unknown).toBeNull();
  });
});

describe("publication operation identity reuse", () => {
  it("uses the R4-C receipt identity formula", () => {
    expect(derivePublicationOperationId({ platform: "facebook", queueItemId: 42 })).toBe(
      "publication:facebook:42"
    );
  });
});
