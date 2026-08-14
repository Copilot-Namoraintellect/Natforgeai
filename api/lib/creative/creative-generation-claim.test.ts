import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from "vitest";
import { eq } from "drizzle-orm";
import { env } from "../../lib/env";
import { getDb } from "../../queries/connection";
import { creativeGenerationClaims } from "@db/schema";
import {
  buildActiveCreativeClaimKey,
  acquireCreativeGenerationClaim,
  attachCreativeGenerationOperationReference,
  releaseCreativeGenerationClaim,
  getActiveCreativeGenerationClaim,
  classifyStaleCreativeGenerationClaims,
  type AcquireCreativeGenerationClaimResult,
  type CreativeGenerationClaimAcquisition,
  type CreativeGenerationClaimCollision,
  type CreativeGenerationClaim,
} from "./creative-generation-claim";

const mockGetDb = vi.hoisted(() => vi.fn());

vi.mock("../../queries/connection", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../queries/connection")>();
  const realGetDb = original.getDb;
  mockGetDb.mockImplementation(() => realGetDb());
  return {
    ...original,
    getDb: () => mockGetDb(),
  };
});

function getDatabaseName(): string {
  try {
    const url = new URL(env.databaseUrl);
    return url.pathname.slice(1);
  } catch {
    return "";
  }
}

const dbName = getDatabaseName();
const isSafeTestDatabase =
  dbName.length > 0 &&
  /test|dev|local|staging|tmp|temp/i.test(dbName) &&
  !/prod/i.test(dbName);

const itSafe = isSafeTestDatabase ? it : it.skip;
const itConcurrent = isSafeTestDatabase ? it : it.skip;

function makeOwnerToken(): string {
  return `owner-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function requireAcquiredClaim(
  result: AcquireCreativeGenerationClaimResult
): CreativeGenerationClaim {
  if (!result.acquired) {
    throw new Error(
      `Expected acquired claim but got collision: ${result.reason}`
    );
  }
  return result.claim;
}

function requireCollision(
  result: AcquireCreativeGenerationClaimResult
): CreativeGenerationClaimCollision {
  if (result.acquired) {
    throw new Error("Expected claim collision but claim was acquired");
  }
  return result;
}

describe("buildActiveCreativeClaimKey", () => {
  it("returns the expected key shape", () => {
    expect(buildActiveCreativeClaimKey(42, 99)).toBe("active:42:99:creative");
  });

  it("rejects non-positive userId", () => {
    expect(() => buildActiveCreativeClaimKey(0, 1)).toThrow(/Invalid userId/);
  });

  it("rejects non-positive campaignId", () => {
    expect(() => buildActiveCreativeClaimKey(1, 0)).toThrow(/Invalid campaignId/);
  });
});

describe("acquireCreativeGenerationClaim input validation", () => {
  it("rejects invalid userId", async () => {
    await expect(
      acquireCreativeGenerationClaim({
        userId: 0,
        campaignId: 1,
        operationSource: "job",
        ownerToken: makeOwnerToken(),
      })
    ).rejects.toThrow(/Invalid userId/);
  });

  it("rejects invalid campaignId", async () => {
    await expect(
      acquireCreativeGenerationClaim({
        userId: 1,
        campaignId: -1,
        operationSource: "job",
        ownerToken: makeOwnerToken(),
      })
    ).rejects.toThrow(/Invalid campaignId/);
  });

  it("rejects invalid operationSource", async () => {
    await expect(
      acquireCreativeGenerationClaim({
        userId: 1,
        campaignId: 1,
        operationSource: "invalid" as any,
        ownerToken: makeOwnerToken(),
      })
    ).rejects.toThrow(/Invalid operationSource/);
  });

  it("rejects invalid ownerToken", async () => {
    await expect(
      acquireCreativeGenerationClaim({
        userId: 1,
        campaignId: 1,
        operationSource: "job",
        ownerToken: "",
      })
    ).rejects.toThrow(/Invalid ownerToken/);
  });

  it("rejects invalid operationReferenceId", async () => {
    await expect(
      acquireCreativeGenerationClaim({
        userId: 1,
        campaignId: 1,
        operationSource: "job",
        operationReferenceId: 0,
        ownerToken: makeOwnerToken(),
      })
    ).rejects.toThrow(/Invalid operationReferenceId/);
  });

  it("rejects invalid leaseExpiresAt", async () => {
    await expect(
      acquireCreativeGenerationClaim({
        userId: 1,
        campaignId: 1,
        operationSource: "job",
        ownerToken: makeOwnerToken(),
        leaseExpiresAt: new Date("invalid"),
      })
    ).rejects.toThrow(/Invalid leaseExpiresAt/);
  });
});

describe("acquireCreativeGenerationClaim missing-table handling", () => {
  it("fails closed on a missing-table error", async () => {
    const missingTableError = new Error("Table 'creative_generation_claims' doesn't exist");
    (missingTableError as any).code = "ER_NO_SUCH_TABLE";
    (missingTableError as any).errno = 1146;

    mockGetDb.mockImplementationOnce(() => ({
      insert: () => ({
        values: vi.fn(async () => {
          throw missingTableError;
        }),
      }),
    }) as any);

    await expect(
      acquireCreativeGenerationClaim({
        userId: 1,
        campaignId: 1,
        operationSource: "job",
        ownerToken: makeOwnerToken(),
      })
    ).rejects.toThrow(/ER_NO_SUCH_TABLE|doesn't exist/);
  });
});

describe("creative generation claim primitive (DB)", () => {
  const testUserId = 99000001;
  const testCampaignId = 88000001;
  let db: ReturnType<typeof getDb>;
  let createdClaimIds: number[] = [];

  beforeAll(() => {
    db = getDb();
  });

  async function cleanupClaims(): Promise<void> {
    // Clear every claim row created by this test file. The test database is
    // isolated and no other test file touches this table.
    await db.delete(creativeGenerationClaims);
    createdClaimIds = [];
  }

  beforeEach(async () => {
    await cleanupClaims();
  });

  afterEach(async () => {
    await cleanupClaims();
  });

  async function acquire(
    overrides: Partial<Parameters<typeof acquireCreativeGenerationClaim>[0]> = {}
  ): Promise<CreativeGenerationClaim> {
    const result = await acquireCreativeGenerationClaim({
      userId: testUserId,
      campaignId: testCampaignId,
      operationSource: "job",
      ownerToken: makeOwnerToken(),
      ...overrides,
    });
    if (!result.acquired) {
      throw new Error(`Expected acquired claim but got ${result.reason}`);
    }
    createdClaimIds.push(result.claim.id);
    return result.claim;
  }

  itSafe("successfully acquires a claim", async () => {
    const claim = await acquire({ operationReferenceId: 1001 });

    expect(claim.userId).toBe(testUserId);
    expect(claim.campaignId).toBe(testCampaignId);
    expect(claim.operationSource).toBe("job");
    expect(claim.operationReferenceId).toBe(1001);
    expect(claim.activeClaimKey).toBe(
      buildActiveCreativeClaimKey(testUserId, testCampaignId)
    );
    expect(claim.ownerToken).toBeTruthy();
    expect(claim.status).toBe("running");
  });

  itSafe("returns the winner when a duplicate active key is attempted", async () => {
    const first = await acquire();

    const second = await acquireCreativeGenerationClaim({
      userId: testUserId,
      campaignId: testCampaignId,
      operationSource: "agent",
      operationReferenceId: 2002,
      ownerToken: makeOwnerToken(),
    });
    const collision = requireCollision(second);

    expect(collision.existingClaim.id).toBe(first.id);
    expect(collision.reason).toBe("active_claim_collision");
  });

  itSafe("returns the existing logical operation for a duplicate source/reference", async () => {
    const referenceId = 3003;

    const first = await acquire({
      operationSource: "approval",
      operationReferenceId: referenceId,
    });

    await releaseCreativeGenerationClaim({
      claimId: first.id,
      ownerToken: first.ownerToken,
      status: "completed",
    });

    const second = await acquireCreativeGenerationClaim({
      userId: testUserId,
      campaignId: testCampaignId,
      operationSource: "approval",
      operationReferenceId: referenceId,
      ownerToken: makeOwnerToken(),
    });
    const collision = requireCollision(second);

    expect(collision.existingClaim.id).toBe(first.id);
    expect(collision.reason).toBe("operation_reference_collision");
  });

  itSafe("allows independent claims for different user or campaign", async () => {
    const claimA = await acquire();

    const claimB = await acquire({
      userId: testUserId + 1,
      campaignId: testCampaignId + 1,
    });

    expect(claimB.id).not.toBe(claimA.id);
  });

  itSafe("attaches operation reference only with matching owner", async () => {
    const claim = await acquire();

    await attachCreativeGenerationOperationReference({
      claimId: claim.id,
      ownerToken: claim.ownerToken,
      operationReferenceId: 4004,
    });

    const updated = await db
      .select()
      .from(creativeGenerationClaims)
      .where(eq(creativeGenerationClaims.id, claim.id))
      .limit(1);

    expect(updated[0]?.operationReferenceId).toBe(4004);
  });

  itSafe("rejects attachment with mismatched owner", async () => {
    const claim = await acquire();

    await expect(
      attachCreativeGenerationOperationReference({
        claimId: claim.id,
        ownerToken: "wrong-owner",
        operationReferenceId: 5005,
      })
    ).rejects.toThrow(/Claim attachment failed/);
  });

  itSafe("releases only with matching claimId and owner", async () => {
    const claim = await acquire();

    await releaseCreativeGenerationClaim({
      claimId: claim.id,
      ownerToken: claim.ownerToken,
      status: "completed",
    });

    const released = await db
      .select()
      .from(creativeGenerationClaims)
      .where(eq(creativeGenerationClaims.id, claim.id))
      .limit(1);

    expect(released[0]?.status).toBe("completed");
    expect(released[0]?.activeClaimKey).toBeNull();
    expect(released[0]?.releasedAt).toBeTruthy();
  });

  itSafe("rejects release with mismatched owner", async () => {
    const claim = await acquire();

    await expect(
      releaseCreativeGenerationClaim({
        claimId: claim.id,
        ownerToken: "wrong-owner",
        status: "completed",
      })
    ).rejects.toThrow(/Claim release failed/);
  });

  itSafe("rejects release of an already-released claim", async () => {
    const claim = await acquire();

    await releaseCreativeGenerationClaim({
      claimId: claim.id,
      ownerToken: claim.ownerToken,
      status: "completed",
    });

    await expect(
      releaseCreativeGenerationClaim({
        claimId: claim.id,
        ownerToken: claim.ownerToken,
        status: "completed",
      })
    ).rejects.toThrow(/Claim release failed/);
  });

  itSafe("getActiveCreativeGenerationClaim returns the running claim", async () => {
    const claim = await acquire();

    const active = await getActiveCreativeGenerationClaim({
      userId: testUserId,
      campaignId: testCampaignId,
    });

    expect(active?.id).toBe(claim.id);
  });

  itSafe("getActiveCreativeGenerationClaim returns null after release", async () => {
    const claim = await acquire();

    await releaseCreativeGenerationClaim({
      claimId: claim.id,
      ownerToken: claim.ownerToken,
      status: "completed",
    });

    const active = await getActiveCreativeGenerationClaim({
      userId: testUserId,
      campaignId: testCampaignId,
    });

    expect(active).toBeNull();
  });

  itSafe("classifyStaleCreativeGenerationClaims never mutates", async () => {
    const claim = await acquire({ leaseExpiresAt: new Date(Date.now() - 1000) });

    const stale = await classifyStaleCreativeGenerationClaims({
      staleBefore: new Date(),
    });

    expect(stale.some((c) => c.id === claim.id)).toBe(true);

    const after = await db
      .select()
      .from(creativeGenerationClaims)
      .where(eq(creativeGenerationClaims.id, claim.id))
      .limit(1);

    expect(after[0]?.status).toBe("running");
    expect(after[0]?.activeClaimKey).not.toBeNull();
  });

  itSafe("classifies stale claims by updatedAt when leaseExpiresAt is null", async () => {
    const claim = await acquire();

    // A brand-new claim must not be classified as stale.
    const fresh = await classifyStaleCreativeGenerationClaims({
      staleBefore: new Date(Date.now() + 60_000),
    });
    expect(fresh.some((c) => c.id === claim.id)).toBe(false);

    // Manually age the row so the updatedAt-based fallback classifies it as stale.
    await db
      .update(creativeGenerationClaims)
      .set({ updatedAt: new Date(Date.now() - 60_000) })
      .where(eq(creativeGenerationClaims.id, claim.id));

    const staleForced = await classifyStaleCreativeGenerationClaims({
      staleBefore: new Date(Date.now() - 1),
    });
    expect(staleForced.some((c) => c.id === claim.id)).toBe(true);
  });

  itConcurrent(
    "two concurrent acquisitions return exactly one winner (database concurrency proof)",
    async () => {
      const userId = testUserId + 5000;
      const campaignId = testCampaignId + 5000;

      const attempts = Array.from({ length: 5 }, (_, i) =>
        acquireCreativeGenerationClaim({
          userId,
          campaignId,
          operationSource: "job",
          ownerToken: makeOwnerToken(),
        })
      );

      const results = await Promise.all(attempts);

      const winners = results.filter((r) => r.acquired);
      const losers = results.filter((r) => !r.acquired);

      expect(winners.length).toBe(1);
      expect(losers.length).toBe(4);

      const winnerClaim = requireAcquiredClaim(winners[0]!);
      for (const loser of losers) {
        const collision = requireCollision(loser);
        expect(collision.existingClaim.id).toBe(winnerClaim.id);
        expect(collision.reason).toBe("active_claim_collision");
      }

      await db
        .delete(creativeGenerationClaims)
        .where(eq(creativeGenerationClaims.userId, userId));
    }
  );
});

describe("creative generation claim database safety guard", () => {
  it("reports the configured database name without printing credentials", () => {
    expect(dbName).toBeTruthy();
    expect(dbName).not.toMatch(/:\/\//);
  });
});
