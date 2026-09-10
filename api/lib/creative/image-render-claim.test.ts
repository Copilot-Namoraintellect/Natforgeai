import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  buildActiveImageRenderClaimKey,
  acquireImageRenderClaim,
  completeImageRenderClaim,
  failImageRenderClaim,
  getActiveImageRenderClaim,
  deriveImageRenderAttemptIdentity,
  buildImageRenderDeductionKey,
  buildImageRenderRefundKey,
  lookupImageRenderAttempt,
  rearmFailedImageRenderClaim,
  markImageRenderDeductionRecorded,
  completeImageRenderClaimWithResult,
  getCompletedImageRenderResult,
  IMAGE_RENDER_OPERATION_KIND,
  type AcquireImageRenderClaimResult,
  type TransitionImageRenderClaimResult,
  type ImageRenderAttemptIdentityInput,
  type ImageRenderClaim,
  type ImageRenderResultSnapshotInput,
  type ImageRenderClaimDbExecutor,
} from "./image-render-claim";
import { imageRenderClaims, generatedImages } from "@db/schema";

const TABLE_TAGS = new Map<unknown, string>([
  [imageRenderClaims, "image_render_claims"],
  [generatedImages, "generated_images"],
]);

function tableTag(table: unknown): string {
  return TABLE_TAGS.get(table) ?? "unknown";
}

const mockGetDb = vi.hoisted(() => vi.fn());

vi.mock("../../queries/connection", () => ({
  getDb: () => mockGetDb(),
}));

// ─── Deterministic in-memory DB fake ───
//
// The fake implements exactly the drizzle chain surface the primitive uses:
//   select().from().where().limit()
//   insert().values()
//   update().set().where()
// Conditions built with eq/and/isNotNull are interpreted by flattening the
// drizzle SQL chunk tree; no real database, clock control, or sleeps needed.

type Token =
  | { t: "str"; s: string }
  | { t: "col"; name: string }
  | { t: "val"; v: unknown };

function flatten(node: unknown): Token[] {
  const obj = node as Record<string, unknown> & { constructor?: { name?: string } };
  if (obj && Array.isArray(obj.queryChunks)) {
    return (obj.queryChunks as unknown[]).flatMap((chunk) => flatten(chunk));
  }
  if (obj && Array.isArray(obj.value) && obj.value.every((p) => typeof p === "string")) {
    return [{ t: "str", s: (obj.value as string[]).join("") }];
  }
  if (obj && obj.constructor?.name === "Param" && "value" in obj) {
    return [{ t: "val", v: obj.value }];
  }
  if (obj && typeof obj.name === "string" && "table" in obj) {
    return [{ t: "col", name: obj.name }];
  }
  return [];
}

function matchesCondition(cond: unknown, row: Record<string, unknown>): boolean {
  const tokens = flatten(cond);
  const predicates: boolean[] = [];
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token.t === "col") {
      const next = tokens[i + 1];
      if (next && next.t === "str" && next.s.includes("=")) {
        const valueToken = tokens[i + 2];
        predicates.push(
          row[token.name] === (valueToken && valueToken.t === "val" ? valueToken.v : undefined)
        );
        i += 3;
        continue;
      }
      if (next && next.t === "str" && /is not null/i.test(next.s)) {
        predicates.push(row[token.name] !== null && row[token.name] !== undefined);
        i += 2;
        continue;
      }
      if (next && next.t === "str" && /\bis null\b/i.test(next.s)) {
        predicates.push(row[token.name] === null || row[token.name] === undefined);
        i += 2;
        continue;
      }
    }
    i += 1;
  }
  return predicates.every(Boolean);
}

function duplicateKeyError(): Error {
  const err = new Error(
    "Duplicate entry 'active:1:post:1:image' for key 'irc_active_claim_key_idx'"
  ) as Error & { code: string; errno: number };
  err.code = "ER_DUP_ENTRY";
  err.errno = 1062;
  return err;
}

interface FakeDbState {
  rows: Record<string, unknown>[];
  failNextInsertWithDuplicate: boolean;
}

function createFakeDb() {
  const state: FakeDbState = { rows: [], failNextInsertWithDuplicate: false };
  let nextId = 1;

  const valuesImpl = vi.fn(
    async (values: Record<string, unknown>, tag: string) => {
      if (state.failNextInsertWithDuplicate) {
        state.failNextInsertWithDuplicate = false;
        throw duplicateKeyError();
      }
      const activeKey = (values.activeClaimKey ?? null) as string | null;
      if (
        activeKey !== null &&
        state.rows.some((row) => row.activeClaimKey === activeKey)
      ) {
        throw duplicateKeyError();
      }
      const generatedImageId = (values.generatedImageId ?? null) as number | null;
      if (
        generatedImageId !== null &&
        state.rows.some((row) => row.generatedImageId === generatedImageId)
      ) {
        throw duplicateKeyError();
      }
      const now = new Date();
      const row = {
        id: nextId,
        createdAt: now,
        updatedAt: now,
        ...values,
        __table: tag,
      };
      nextId += 1;
      state.rows.push(row);
      return [{ insertId: row.id }];
    }
  );

  const db = {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn((cond: unknown) => ({
          limit: vi.fn(async (n: number) =>
            state.rows
              .filter(
                (row) =>
                  row.__table === undefined || row.__table === tableTag(table)
              )
              .filter((row) => matchesCondition(cond, row))
              .slice(0, n)
          ),
        })),
      })),
    })),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((values: Record<string, unknown>) =>
        valuesImpl(values, tableTag(table))
      ),
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((patch: Record<string, unknown>) => ({
        where: vi.fn(async (cond: unknown) => {
          let affectedRows = 0;
          for (const row of state.rows) {
            if (matchesCondition(cond, row)) {
              const nextActiveKey = (patch.activeClaimKey ?? null) as string | null;
              if (
                nextActiveKey !== null &&
                state.rows.some(
                  (other) => other !== row && other.activeClaimKey === nextActiveKey
                )
              ) {
                throw duplicateKeyError();
              }
              const nextGeneratedImageId = (patch.generatedImageId ??
                null) as number | null;
              if (
                nextGeneratedImageId !== null &&
                state.rows.some(
                  (other) =>
                    other !== row && other.generatedImageId === nextGeneratedImageId
                )
              ) {
                throw duplicateKeyError();
              }
              Object.assign(row, patch, { updatedAt: new Date() });
              affectedRows += 1;
            }
          }
          return [{ affectedRows }];
        }),
      })),
    })),
  };

  return { db, state, valuesImpl };
}

const FUTURE_LEASE = new Date("2999-01-01T00:00:00Z");
const PAST_LEASE = new Date("2000-01-01T00:00:00Z");

function makeOwnerToken(n: number): string {
  return `owner-token-${n}`;
}

function requireAcquired(result: AcquireImageRenderClaimResult): ImageRenderClaim {
  if (!result.acquired) {
    throw new Error(`Expected acquired claim, got ${result.reason}`);
  }
  return result.claim;
}

describe("buildActiveImageRenderClaimKey", () => {
  it("returns the expected key shape without any campaign identity", () => {
    expect(buildActiveImageRenderClaimKey({ userId: 42, contentPostId: 99 })).toBe(
      "active:42:post:99:image"
    );
  });

  it("rejects non-positive userId", () => {
    expect(() => buildActiveImageRenderClaimKey({ userId: 0, contentPostId: 1 })).toThrow(
      /Invalid userId/
    );
  });

  it("rejects non-positive contentPostId", () => {
    expect(() => buildActiveImageRenderClaimKey({ userId: 1, contentPostId: -1 })).toThrow(
      /Invalid contentPostId/
    );
  });
});

describe("acquireImageRenderClaim validation", () => {
  beforeEach(() => {
    const { db } = createFakeDb();
    mockGetDb.mockReturnValue(db);
  });

  it("rejects invalid userId", async () => {
    await expect(
      acquireImageRenderClaim({
        userId: 0,
        contentPostId: 1,
        ownerToken: makeOwnerToken(1),
        leaseExpiresAt: FUTURE_LEASE,
      })
    ).rejects.toThrow(/Invalid userId/);
  });

  it("rejects invalid contentPostId", async () => {
    await expect(
      acquireImageRenderClaim({
        userId: 1,
        contentPostId: 1.5,
        ownerToken: makeOwnerToken(1),
        leaseExpiresAt: FUTURE_LEASE,
      })
    ).rejects.toThrow(/Invalid contentPostId/);
  });

  it("rejects empty ownerToken", async () => {
    await expect(
      acquireImageRenderClaim({
        userId: 1,
        contentPostId: 1,
        ownerToken: "",
        leaseExpiresAt: FUTURE_LEASE,
      })
    ).rejects.toThrow(/Invalid ownerToken/);
  });

  it("rejects a missing or invalid lease expiry", async () => {
    await expect(
      acquireImageRenderClaim({
        userId: 1,
        contentPostId: 1,
        ownerToken: makeOwnerToken(1),
        leaseExpiresAt: new Date("not-a-date"),
      })
    ).rejects.toThrow(/Invalid leaseExpiresAt/);
  });
});

describe("acquireImageRenderClaim concurrency semantics", () => {
  let state: FakeDbState;
  let valuesImpl: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    const fake = createFakeDb();
    state = fake.state;
    valuesImpl = fake.valuesImpl;
    mockGetDb.mockReturnValue(fake.db);
  });

  it("persists a running claim with a database-generated id", async () => {
    const claim = requireAcquired(
      await acquireImageRenderClaim({
        userId: 7,
        contentPostId: 13,
        ownerToken: makeOwnerToken(1),
        leaseExpiresAt: FUTURE_LEASE,
      })
    );

    expect(claim.id).toBe(1);
    expect(claim.status).toBe("running");
    expect(claim.activeClaimKey).toBe("active:7:post:13:image");
    expect(claim.ownerToken).toBe(makeOwnerToken(1));
    expect(claim.leaseExpiresAt).toBe(FUTURE_LEASE);
  });

  it("writes no campaign identity to the claim row", async () => {
    await acquireImageRenderClaim({
      userId: 7,
      contentPostId: 13,
      ownerToken: makeOwnerToken(1),
      leaseExpiresAt: FUTURE_LEASE,
    });

    const written = valuesImpl.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(written).sort()).toEqual(
      ["activeClaimKey", "contentPostId", "leaseExpiresAt", "ownerToken", "status", "userId"].sort()
    );
    expect(written).not.toHaveProperty("campaignId");
  });

  it("classifies a second same-post request as an active conflict with exactly one row", async () => {
    const first = requireAcquired(
      await acquireImageRenderClaim({
        userId: 7,
        contentPostId: 13,
        ownerToken: makeOwnerToken(1),
        leaseExpiresAt: FUTURE_LEASE,
      })
    );

    const second = await acquireImageRenderClaim({
      userId: 7,
      contentPostId: 13,
      ownerToken: makeOwnerToken(2),
      leaseExpiresAt: FUTURE_LEASE,
    });

    expect(second.acquired).toBe(false);
    if (!second.acquired) {
      expect(second.reason).toBe("active_claim_conflict");
      expect(second.existingClaim.id).toBe(first.id);
    }
    expect(state.rows).toHaveLength(1);
  });

  it("uses identical semantics for one-off posts (no campaign anywhere)", async () => {
    const claim = requireAcquired(
      await acquireImageRenderClaim({
        userId: 7,
        contentPostId: 55,
        ownerToken: makeOwnerToken(1),
        leaseExpiresAt: FUTURE_LEASE,
      })
    );

    expect(claim.activeClaimKey).toBe("active:7:post:55:image");
    expect(claim.activeClaimKey).not.toContain("campaign");
  });

  it("does not block different posts for the same user", async () => {
    await acquireImageRenderClaim({
      userId: 7,
      contentPostId: 13,
      ownerToken: makeOwnerToken(1),
      leaseExpiresAt: FUTURE_LEASE,
    });

    const other = await acquireImageRenderClaim({
      userId: 7,
      contentPostId: 14,
      ownerToken: makeOwnerToken(2),
      leaseExpiresAt: FUTURE_LEASE,
    });

    expect(other.acquired).toBe(true);
  });

  it("does not block the same post for a different user", async () => {
    await acquireImageRenderClaim({
      userId: 7,
      contentPostId: 13,
      ownerToken: makeOwnerToken(1),
      leaseExpiresAt: FUTURE_LEASE,
    });

    const other = await acquireImageRenderClaim({
      userId: 8,
      contentPostId: 13,
      ownerToken: makeOwnerToken(2),
      leaseExpiresAt: FUTURE_LEASE,
    });

    expect(other.acquired).toBe(true);
    if (other.acquired) {
      expect(other.claim.activeClaimKey).toBe("active:8:post:13:image");
    }
  });

  it("fails closed on a stale claim without mutating it or authorizing work", async () => {
    const first = requireAcquired(
      await acquireImageRenderClaim({
        userId: 7,
        contentPostId: 13,
        ownerToken: makeOwnerToken(1),
        leaseExpiresAt: PAST_LEASE,
      })
    );
    const before = { ...state.rows[0] };

    const second = await acquireImageRenderClaim({
      userId: 7,
      contentPostId: 13,
      ownerToken: makeOwnerToken(2),
      leaseExpiresAt: FUTURE_LEASE,
    });

    expect(second.acquired).toBe(false);
    if (!second.acquired) {
      expect(second.reason).toBe("stale_claim_conflict");
      expect(second.existingClaim.id).toBe(first.id);
    }
    expect(state.rows[0]).toEqual(before);
    expect(state.rows).toHaveLength(1);
  });

  it("retries the insert once when the active key is freed between duplicate error and lookup", async () => {
    const fake = createFakeDb();
    fake.state.failNextInsertWithDuplicate = true;
    valuesImpl = fake.valuesImpl;
    mockGetDb.mockReturnValue(fake.db);

    const result = await acquireImageRenderClaim({
      userId: 7,
      contentPostId: 13,
      ownerToken: makeOwnerToken(1),
      leaseExpiresAt: FUTURE_LEASE,
    });

    expect(result.acquired).toBe(true);
    expect(valuesImpl).toHaveBeenCalledTimes(2);
  });
});

describe("terminal transitions", () => {
  let state: FakeDbState;

  async function acquireRunning(userId = 7, contentPostId = 13, tokenN = 1) {
    return requireAcquired(
      await acquireImageRenderClaim({
        userId,
        contentPostId,
        ownerToken: makeOwnerToken(tokenN),
        leaseExpiresAt: FUTURE_LEASE,
      })
    );
  }

  beforeEach(() => {
    const fake = createFakeDb();
    state = fake.state;
    mockGetDb.mockReturnValue(fake.db);
  });

  it("completion clears the active key and preserves history", async () => {
    const claim = await acquireRunning();

    const result = await completeImageRenderClaim({
      claimId: claim.id,
      ownerToken: claim.ownerToken,
    });

    assertTransitioned(result, "completed");
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0].status).toBe("completed");
    expect(state.rows[0].activeClaimKey).toBeNull();
  });

  it("failure clears the active key and preserves history", async () => {
    const claim = await acquireRunning();

    const result = await failImageRenderClaim({
      claimId: claim.id,
      ownerToken: claim.ownerToken,
    });

    assertTransitioned(result, "failed");
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0].status).toBe("failed");
    expect(state.rows[0].activeClaimKey).toBeNull();
  });

  it("allows later regeneration after completion with a new claim id", async () => {
    const first = await acquireRunning();
    await completeImageRenderClaim({ claimId: first.id, ownerToken: first.ownerToken });

    const second = await acquireRunning(7, 13, 2);

    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe("running");
    expect(second.activeClaimKey).toBe("active:7:post:13:image");
    expect(state.rows).toHaveLength(2);
  });

  it("allows a new attempt after failure", async () => {
    const first = await acquireRunning();
    await failImageRenderClaim({ claimId: first.id, ownerToken: first.ownerToken });

    const second = await acquireRunning(7, 13, 2);

    expect(second.id).not.toBe(first.id);
    expect(state.rows).toHaveLength(2);
  });

  it("rejects completion by the wrong owner without mutating the row", async () => {
    const claim = await acquireRunning();
    const before = { ...state.rows[0] };

    const result = await completeImageRenderClaim({
      claimId: claim.id,
      ownerToken: makeOwnerToken(999),
    });

    expect(result).toEqual({ transitioned: false, reason: "not_found_or_unauthorized" });
    expect(state.rows[0]).toEqual(before);
  });

  it("rejects failure by the wrong owner without mutating the row", async () => {
    const claim = await acquireRunning();
    const before = { ...state.rows[0] };

    const result = await failImageRenderClaim({
      claimId: claim.id,
      ownerToken: makeOwnerToken(999),
    });

    expect(result).toEqual({ transitioned: false, reason: "not_found_or_unauthorized" });
    expect(state.rows[0]).toEqual(before);
  });

  it("rejects any transition from an already-terminal claim", async () => {
    const claim = await acquireRunning();
    await completeImageRenderClaim({ claimId: claim.id, ownerToken: claim.ownerToken });

    const again = await completeImageRenderClaim({
      claimId: claim.id,
      ownerToken: claim.ownerToken,
    });
    const failAfterComplete = await failImageRenderClaim({
      claimId: claim.id,
      ownerToken: claim.ownerToken,
    });

    expect(again).toEqual({ transitioned: false, reason: "not_found_or_unauthorized" });
    expect(failAfterComplete).toEqual({
      transitioned: false,
      reason: "not_found_or_unauthorized",
    });
    expect(state.rows[0].status).toBe("completed");
    expect(state.rows).toHaveLength(1);
  });
});

function assertTransitioned(
  result: TransitionImageRenderClaimResult,
  status: "completed" | "failed"
): void {
  if (!result.transitioned) {
    throw new Error(`Expected ${status} transition, got ${result.reason}`);
  }
  expect(result.claim.status).toBe(status);
  expect(result.claim.activeClaimKey).toBeNull();
}

describe("getActiveImageRenderClaim", () => {
  beforeEach(() => {
    const fake = createFakeDb();
    mockGetDb.mockReturnValue(fake.db);
  });

  it("returns the running claim for the user/post pair", async () => {
    const claim = requireAcquired(
      await acquireImageRenderClaim({
        userId: 7,
        contentPostId: 13,
        ownerToken: makeOwnerToken(1),
        leaseExpiresAt: FUTURE_LEASE,
      })
    );

    const active = await getActiveImageRenderClaim({ userId: 7, contentPostId: 13 });

    expect(active?.id).toBe(claim.id);
  });

  it("returns null after the claim is completed", async () => {
    const claim = requireAcquired(
      await acquireImageRenderClaim({
        userId: 7,
        contentPostId: 13,
        ownerToken: makeOwnerToken(1),
        leaseExpiresAt: FUTURE_LEASE,
      })
    );
    await completeImageRenderClaim({ claimId: claim.id, ownerToken: claim.ownerToken });

    expect(await getActiveImageRenderClaim({ userId: 7, contentPostId: 13 })).toBeNull();
  });

  it("returns null for a different post", async () => {
    await acquireImageRenderClaim({
      userId: 7,
      contentPostId: 13,
      ownerToken: makeOwnerToken(1),
      leaseExpiresAt: FUTURE_LEASE,
    });

    expect(await getActiveImageRenderClaim({ userId: 7, contentPostId: 14 })).toBeNull();
  });
});

// ─── B1: dormant request-attempt identity (pure builders) ───

type IntentOverrides = Partial<Omit<ImageRenderAttemptIdentityInput, "clientAttemptId">>;

function deriveAttempt(
  userId = 7,
  contentPostId = 13,
  clientAttemptId = "attempt-token-1",
  intent: IntentOverrides = {}
) {
  return deriveImageRenderAttemptIdentity({
    userId,
    contentPostId,
    attempt: { clientAttemptId, ...intent },
  });
}

const HEX64 = /^[0-9a-f]{64}$/;

describe("deriveImageRenderAttemptIdentity", () => {
  it("derives 64-character lowercase SHA-256 digests for both keys", () => {
    const identity = deriveAttempt();
    expect(identity.requestAttemptKey).toMatch(HEX64);
    expect(identity.intentFingerprint).toMatch(HEX64);
  });

  it("produces stable keys for the same normalized payload", () => {
    const a = deriveAttempt();
    const b = deriveAttempt();
    expect(a).toEqual(b);
  });

  it("changes requestAttemptKey for user, post or clientAttemptId", () => {
    const base = deriveAttempt();
    expect(deriveAttempt(8).requestAttemptKey).not.toBe(base.requestAttemptKey);
    expect(deriveAttempt(7, 14).requestAttemptKey).not.toBe(base.requestAttemptKey);
    expect(deriveAttempt(7, 13, "attempt-token-2").requestAttemptKey).not.toBe(
      base.requestAttemptKey
    );
  });

  it("keeps requestAttemptKey unchanged when only intent changes", () => {
    const base = deriveAttempt();
    const withIntent = deriveAttempt(7, 13, "attempt-token-1", {
      regenerate: true,
      forceRegenerate: true,
      refinementInstruction: "tighten the headline",
      creativeGuidance: "use the autumn palette",
      strongerBrandFit: true,
      provider: "hybrid",
      templateId: "leaflet-a",
    });
    expect(withIntent.requestAttemptKey).toBe(base.requestAttemptKey);
    expect(withIntent.deductionKey).toBe(base.deductionKey);
  });

  it("changes intentFingerprint for every material intent field", () => {
    const base = deriveAttempt();
    const variants: IntentOverrides[] = [
      { regenerate: true },
      { forceRegenerate: true },
      { refinementInstruction: "tighten the headline" },
      { creativeGuidance: "use the autumn palette" },
      { strongerBrandFit: true },
      { provider: "hybrid" },
      { templateId: "leaflet-a" },
    ];
    for (const variant of variants) {
      const derived = deriveAttempt(7, 13, "attempt-token-1", variant);
      expect(derived.intentFingerprint).not.toBe(base.intentFingerprint);
      expect(derived.requestAttemptKey).toBe(base.requestAttemptKey);
    }
  });

  it("changes intentFingerprint when creativeGuidance changes", () => {
    const a = deriveAttempt(7, 13, "tok", { creativeGuidance: "guidance A" });
    const b = deriveAttempt(7, 13, "tok", { creativeGuidance: "guidance B" });
    expect(a.intentFingerprint).not.toBe(b.intentFingerprint);
  });

  it("changes intentFingerprint when refinementInstruction changes", () => {
    const a = deriveAttempt(7, 13, "tok", { refinementInstruction: "refine A" });
    const b = deriveAttempt(7, 13, "tok", { refinementInstruction: "refine B" });
    expect(a.intentFingerprint).not.toBe(b.intentFingerprint);
  });

  it("never places raw refinement or guidance text in any derived key", () => {
    const identity = deriveAttempt(7, 13, "tok-raw", {
      refinementInstruction: "super secret refinement text 123",
      creativeGuidance: "confidential guidance text 456",
    });
    const keys = [
      identity.requestAttemptKey,
      identity.intentFingerprint,
      identity.deductionKey,
      buildImageRenderRefundKey(identity.requestAttemptKey),
    ];
    for (const key of keys) {
      expect(key).not.toContain("super secret refinement text 123");
      expect(key).not.toContain("confidential guidance text 456");
      expect(key.toLowerCase()).not.toContain("secret");
      expect(key.toLowerCase()).not.toContain("confidential");
    }
    // Both text fields are present only as inner SHA-256 digests.
    expect(identity.intentFingerprint).toMatch(HEX64);
  });

  it("is independent of input field order and trims optional text", () => {
    const forward = { clientAttemptId: "tok", regenerate: true, provider: " v2 " };
    const reverse = { provider: "v2", regenerate: true, clientAttemptId: "tok" };
    const a = deriveImageRenderAttemptIdentity({
      userId: 7,
      contentPostId: 13,
      attempt: forward,
    });
    const b = deriveImageRenderAttemptIdentity({
      userId: 7,
      contentPostId: 13,
      attempt: reverse,
    });
    expect(a).toEqual(b);

    const padded = deriveAttempt(7, 13, "tok", {
      refinementInstruction: "  tighten  ",
      creativeGuidance: "  autumn palette  ",
    });
    const trimmed = deriveAttempt(7, 13, "tok", {
      refinementInstruction: "tighten",
      creativeGuidance: "autumn palette",
    });
    expect(padded.intentFingerprint).toBe(trimmed.intentFingerprint);
  });

  it("applies deterministic provider/template defaults", () => {
    const omitted = deriveAttempt(7, 13, "tok");
    const explicit = deriveAttempt(7, 13, "tok", { provider: "v2", templateId: "auto" });
    expect(omitted.intentFingerprint).toBe(explicit.intentFingerprint);
  });

  it("builds billing keys that fit schema limits and stay stable per attempt", () => {
    const identity = deriveAttempt();
    expect(identity.deductionKey).toBe(
      buildImageRenderDeductionKey(identity.requestAttemptKey)
    );
    expect(identity.deductionKey).toBe(`img-deduction:${identity.requestAttemptKey}`);
    expect(buildImageRenderRefundKey(identity.requestAttemptKey)).toBe(
      `img-refund:${identity.requestAttemptKey}`
    );
    expect(identity.deductionKey.length).toBeLessThanOrEqual(191);
    expect(identity.requestAttemptKey.length).toBeLessThanOrEqual(64);
    expect(identity.intentFingerprint.length).toBeLessThanOrEqual(64);
    // Same logical attempt → same billing key; a new deliberate action → new key.
    expect(deriveAttempt().deductionKey).toBe(identity.deductionKey);
    expect(deriveAttempt(7, 13, "attempt-token-2").deductionKey).not.toBe(
      identity.deductionKey
    );
  });

  it("pins the operation kind to premium_image", () => {
    expect(IMAGE_RENDER_OPERATION_KIND).toBe("premium_image");
  });

  it("rejects invalid clientAttemptId values", () => {
    for (const bad of ["", "x".repeat(65), "has space", "has/slash", "has:colon"]) {
      expect(() => deriveAttempt(7, 13, bad)).toThrow(/Invalid clientAttemptId/);
    }
  });

  it("rejects non-positive userId or contentPostId", () => {
    expect(() => deriveAttempt(0)).toThrow(/Invalid userId/);
    expect(() => deriveAttempt(7, 0)).toThrow(/Invalid contentPostId/);
  });
});

// ─── B2A correction: complete the dormant intent identity ───
//
// brandColors, creativeType and allowNoLogo materially change the paid render
// and therefore belong in intentFingerprint. requestAttemptKey must stay
// invariant under any intent change.

describe("deriveImageRenderAttemptIdentity material intent completion (B2A)", () => {
  it("changes intentFingerprint for each of the three corrected fields", () => {
    const base = deriveAttempt();
    const variants: IntentOverrides[] = [
      { brandColors: ["#0047AB"] },
      { creativeType: "poster" },
      { allowNoLogo: true },
    ];
    for (const variant of variants) {
      const derived = deriveAttempt(7, 13, "attempt-token-1", variant);
      expect(derived.intentFingerprint).not.toBe(base.intentFingerprint);
      expect(derived.requestAttemptKey).toBe(base.requestAttemptKey);
      expect(derived.deductionKey).toBe(base.deductionKey);
    }
  });

  it("treats brand colour order as material (positional renderer semantics)", () => {
    const forward = deriveAttempt(7, 13, "tok", {
      brandColors: ["#FF0000", "#00FF00", "#0000FF"],
    });
    const reversed = deriveAttempt(7, 13, "tok", {
      brandColors: ["#0000FF", "#00FF00", "#FF0000"],
    });
    expect(forward.intentFingerprint).not.toBe(reversed.intentFingerprint);
    // Order is preserved: the same ordered list normalizes to itself.
    expect(forward.intentFingerprint).toBe(
      deriveAttempt(7, 13, "tok", {
        brandColors: ["#FF0000", "#00FF00", "#0000FF"],
      }).intentFingerprint
    );
  });

  it("normalizes brand colour case and whitespace deterministically", () => {
    const messy = deriveAttempt(7, 13, "tok", {
      brandColors: ["  #ff0000 ", "#Ff0000", "#ff0000"],
    });
    const clean = deriveAttempt(7, 13, "tok", {
      brandColors: ["#FF0000", "#FF0000", "#FF0000"],
    });
    expect(messy.intentFingerprint).toBe(clean.intentFingerprint);
  });

  it("drops empty and non-string brand colour entries", () => {
    const withEmpties = deriveAttempt(7, 13, "tok", {
      brandColors: ["", "   ", "#FF0000", null as unknown as string],
    });
    const clean = deriveAttempt(7, 13, "tok", { brandColors: ["#FF0000"] });
    expect(withEmpties.intentFingerprint).toBe(clean.intentFingerprint);
  });

  it("applies deterministic defaults equal to explicit default values", () => {
    const omitted = deriveAttempt(7, 13, "tok");
    const explicit = deriveAttempt(7, 13, "tok", {
      brandColors: [],
      creativeType: "leaflet",
      allowNoLogo: false,
    });
    expect(omitted.intentFingerprint).toBe(explicit.intentFingerprint);
    // creativeType whitespace-normalizes to the router default.
    const padded = deriveAttempt(7, 13, "tok", { creativeType: "  leaflet  " });
    expect(padded.intentFingerprint).toBe(omitted.intentFingerprint);
  });

  it("never places raw brand colour values in any derived key", () => {
    const identity = deriveAttempt(7, 13, "tok-raw", {
      brandColors: ["#0047AB", "#FFD700"],
    });
    for (const key of [
      identity.requestAttemptKey,
      identity.intentFingerprint,
      identity.deductionKey,
    ]) {
      expect(key).not.toContain("#0047AB");
      expect(key).not.toContain("#FFD700");
      expect(key).not.toContain("0047AB");
    }
  });

  it("keeps billing key derivation unchanged by the correction", () => {
    const identity = deriveAttempt(7, 13, "tok", {
      brandColors: ["#FF0000"],
      creativeType: "poster",
      allowNoLogo: true,
    });
    expect(identity.deductionKey).toBe(
      buildImageRenderDeductionKey(identity.requestAttemptKey)
    );
    expect(identity.deductionKey).toBe(`img-deduction:${identity.requestAttemptKey}`);
    expect(buildImageRenderRefundKey(identity.requestAttemptKey)).toBe(
      `img-refund:${identity.requestAttemptKey}`
    );
    expect(identity.deductionKey.length).toBeLessThanOrEqual(191);
  });

  it("keeps requestAttemptKey invariant when corrected intent fields change", () => {
    const base = deriveAttempt();
    const changed = deriveAttempt(7, 13, "attempt-token-1", {
      brandColors: ["#FF0000", "#00FF00"],
      creativeType: "event_announcement",
      allowNoLogo: true,
    });
    expect(changed.requestAttemptKey).toBe(base.requestAttemptKey);
  });
});

// ─── B1: identity-aware acquisition ───

describe("acquireImageRenderClaim with attempt identity", () => {
  let state: FakeDbState;
  let valuesImpl: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    const fake = createFakeDb();
    state = fake.state;
    valuesImpl = fake.valuesImpl;
    mockGetDb.mockReturnValue(fake.db);
  });

  it("persists the derived identity columns with deductionRecorded false", async () => {
    const attempt: ImageRenderAttemptIdentityInput = {
      clientAttemptId: "attempt-token-1",
      regenerate: true,
      refinementInstruction: "tighten the headline",
    };
    const expected = deriveImageRenderAttemptIdentity({
      userId: 7,
      contentPostId: 13,
      attempt,
    });

    const claim = requireAcquired(
      await acquireImageRenderClaim({
        userId: 7,
        contentPostId: 13,
        ownerToken: makeOwnerToken(1),
        leaseExpiresAt: FUTURE_LEASE,
        identity: attempt,
      })
    );

    expect(claim.requestAttemptKey).toBe(expected.requestAttemptKey);
    expect(claim.intentFingerprint).toBe(expected.intentFingerprint);
    expect(claim.deductionKey).toBe(expected.deductionKey);
    expect(claim.deductionRecorded).toBe(false);
    expect(claim.status).toBe("running");
  });

  it("writes exactly the identity columns on top of the legacy insert", async () => {
    await acquireImageRenderClaim({
      userId: 7,
      contentPostId: 13,
      ownerToken: makeOwnerToken(1),
      leaseExpiresAt: FUTURE_LEASE,
      identity: { clientAttemptId: "attempt-token-1" },
    });

    const written = valuesImpl.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(written).sort()).toEqual(
      [
        "activeClaimKey",
        "contentPostId",
        "deductionKey",
        "deductionRecorded",
        "intentFingerprint",
        "leaseExpiresAt",
        "ownerToken",
        "requestAttemptKey",
        "status",
        "userId",
      ].sort()
    );
    expect(written).not.toHaveProperty("clientAttemptId");
    expect(written).not.toHaveProperty("campaignId");
    expect(written).not.toHaveProperty("refinementInstruction");
    expect(written).not.toHaveProperty("creativeGuidance");
  });

  it("keeps identity columns absent for legacy dormant acquisitions", async () => {
    const claim = requireAcquired(
      await acquireImageRenderClaim({
        userId: 7,
        contentPostId: 13,
        ownerToken: makeOwnerToken(1),
        leaseExpiresAt: FUTURE_LEASE,
      })
    );

    expect(claim.requestAttemptKey ?? null).toBeNull();
    expect(claim.intentFingerprint ?? null).toBeNull();
    expect(claim.deductionKey ?? null).toBeNull();
    expect(claim.deductionRecorded ?? false).toBe(false);
  });
});

// ─── B1: dormant request-attempt lookup ───

describe("lookupImageRenderAttempt", () => {
  let state: FakeDbState;

  beforeEach(() => {
    const fake = createFakeDb();
    state = fake.state;
    mockGetDb.mockReturnValue(fake.db);
  });

  function seedRow(overrides: Record<string, unknown>): Record<string, unknown> {
    const now = new Date();
    const identity = deriveAttempt();
    const row = {
      id: state.rows.length + 1,
      userId: 7,
      contentPostId: 13,
      activeClaimKey: "active:7:post:13:image",
      ownerToken: makeOwnerToken(1),
      status: "running",
      leaseExpiresAt: FUTURE_LEASE,
      createdAt: now,
      updatedAt: now,
      requestAttemptKey: identity.requestAttemptKey,
      intentFingerprint: identity.intentFingerprint,
      deductionKey: identity.deductionKey,
      deductionRecorded: false,
      ...overrides,
    };
    state.rows.push(row);
    return row;
  }

  it("returns found:false for an absent requestAttemptKey", async () => {
    const result = await lookupImageRenderAttempt({
      requestAttemptKey: deriveAttempt().requestAttemptKey,
    });
    expect(result).toEqual({ found: false });
  });

  it("classifies a running claim with matching intent without mutating rows", async () => {
    const row = seedRow({});
    const before = { ...row };

    const result = await lookupImageRenderAttempt({
      requestAttemptKey: deriveAttempt().requestAttemptKey,
      expectedIntentFingerprint: deriveAttempt().intentFingerprint,
    });

    expect(result.found).toBe(true);
    expect(result.claimId).toBe(row.id);
    expect(result.status).toBe("running");
    expect(result.intentComparison).toBe("match");
    expect(result.deductionRecorded).toBe(false);
    expect(result.leaseState).toBe("active");
    expect(result.activeClaimKeyPresent).toBe(true);
    expect(state.rows[0]).toEqual(before);
  });

  it("classifies conflicting intent for the same requestAttemptKey", async () => {
    seedRow({});
    const otherIntent = deriveAttempt(7, 13, "attempt-token-1", {
      regenerate: true,
    });

    const result = await lookupImageRenderAttempt({
      requestAttemptKey: deriveAttempt().requestAttemptKey,
      expectedIntentFingerprint: otherIntent.intentFingerprint,
    });

    expect(result.found).toBe(true);
    expect(result.intentComparison).toBe("conflict");
  });

  it("classifies failed and completed rows with leaseState none", async () => {
    seedRow({ id: 1, status: "failed", activeClaimKey: null });
    seedRow({
      id: 2,
      status: "completed",
      activeClaimKey: null,
      requestAttemptKey: deriveAttempt(7, 13, "attempt-token-2").requestAttemptKey,
    });

    const failed = await lookupImageRenderAttempt({
      requestAttemptKey: deriveAttempt().requestAttemptKey,
    });
    expect(failed.status).toBe("failed");
    expect(failed.leaseState).toBe("none");
    expect(failed.activeClaimKeyPresent).toBe(false);

    const completed = await lookupImageRenderAttempt({
      requestAttemptKey: deriveAttempt(7, 13, "attempt-token-2").requestAttemptKey,
    });
    expect(completed.status).toBe("completed");
    expect(completed.leaseState).toBe("none");
  });

  it("exposes deductionRecorded and classifies a stale lease without mutation", async () => {
    const row = seedRow({ leaseExpiresAt: PAST_LEASE, deductionRecorded: true });
    const before = { ...row };

    const result = await lookupImageRenderAttempt({
      requestAttemptKey: deriveAttempt().requestAttemptKey,
    });

    expect(result.deductionRecorded).toBe(true);
    expect(result.leaseState).toBe("stale");
    expect(state.rows[0]).toEqual(before);
  });

  it("never exposes ownerToken in the lookup result", async () => {
    seedRow({});
    const result = await lookupImageRenderAttempt({
      requestAttemptKey: deriveAttempt().requestAttemptKey,
    });
    expect(Object.keys(result)).not.toContain("ownerToken");
    expect(Object.keys(result)).not.toContain("activeClaimKey");
  });

  it("rejects malformed requestAttemptKey values", async () => {
    await expect(
      lookupImageRenderAttempt({ requestAttemptKey: "not-a-sha256" })
    ).rejects.toThrow(/Invalid requestAttemptKey/);
  });
});

// ─── B1: dormant failed-pre-deduction rearm ───

describe("rearmFailedImageRenderClaim", () => {
  let state: FakeDbState;

  beforeEach(() => {
    const fake = createFakeDb();
    state = fake.state;
    mockGetDb.mockReturnValue(fake.db);
  });

  function seedFailedIdentityRow(overrides: Record<string, unknown> = {}) {
    const createdAt = new Date("2026-01-01T00:00:00Z");
    const identity = deriveAttempt();
    const row: Record<string, unknown> = {
      id: state.rows.length + 1,
      userId: 7,
      contentPostId: 13,
      activeClaimKey: null,
      ownerToken: "owner-old",
      status: "failed",
      leaseExpiresAt: PAST_LEASE,
      createdAt,
      updatedAt: createdAt,
      requestAttemptKey: identity.requestAttemptKey,
      intentFingerprint: identity.intentFingerprint,
      deductionKey: identity.deductionKey,
      deductionRecorded: false,
      ...overrides,
    };
    state.rows.push(row);
    return { row, identity };
  }

  it("rearms a failed pre-deduction row while preserving identity and history", async () => {
    const { row, identity } = seedFailedIdentityRow();
    const beforeCount = state.rows.length;

    const result = await rearmFailedImageRenderClaim({
      userId: 7,
      contentPostId: 13,
      requestAttemptKey: identity.requestAttemptKey,
      intentFingerprint: identity.intentFingerprint,
      ownerToken: makeOwnerToken(9),
      leaseExpiresAt: FUTURE_LEASE,
    });

    expect(result.rearmed).toBe(true);
    if (!result.rearmed) return;
    const claim = result.claim;
    expect(claim.id).toBe(row.id);
    expect(claim.status).toBe("running");
    expect(claim.activeClaimKey).toBe("active:7:post:13:image");
    expect(claim.ownerToken).toBe(makeOwnerToken(9));
    expect(claim.leaseExpiresAt).toBe(FUTURE_LEASE);
    expect(claim.requestAttemptKey).toBe(identity.requestAttemptKey);
    expect(claim.intentFingerprint).toBe(identity.intentFingerprint);
    expect(claim.deductionKey).toBe(identity.deductionKey);
    expect(claim.deductionRecorded).toBe(false);
    expect(claim.createdAt).toEqual(row.createdAt);
    expect(state.rows).toHaveLength(beforeCount);
  });

  it("rearms end-to-end after an identity-aware acquisition fails pre-deduction", async () => {
    const attempt: ImageRenderAttemptIdentityInput = {
      clientAttemptId: "attempt-token-1",
      regenerate: true,
    };
    const identity = deriveImageRenderAttemptIdentity({
      userId: 7,
      contentPostId: 13,
      attempt,
    });

    const first = requireAcquired(
      await acquireImageRenderClaim({
        userId: 7,
        contentPostId: 13,
        ownerToken: makeOwnerToken(1),
        leaseExpiresAt: FUTURE_LEASE,
        identity: attempt,
      })
    );
    await failImageRenderClaim({ claimId: first.id, ownerToken: first.ownerToken });

    const result = await rearmFailedImageRenderClaim({
      userId: 7,
      contentPostId: 13,
      requestAttemptKey: identity.requestAttemptKey,
      intentFingerprint: identity.intentFingerprint,
      ownerToken: makeOwnerToken(2),
      leaseExpiresAt: FUTURE_LEASE,
    });

    expect(result.rearmed).toBe(true);
    if (result.rearmed) {
      expect(result.claim.id).toBe(first.id);
      expect(result.claim.deductionKey).toBe(identity.deductionKey);
      expect(result.claim.deductionRecorded).toBe(false);
    }
    expect(state.rows).toHaveLength(1);
  });

  it("reports active_key_occupied when another claim holds the user/post key", async () => {
    // A legacy running claim holds the active key for the same user/post.
    requireAcquired(
      await acquireImageRenderClaim({
        userId: 7,
        contentPostId: 13,
        ownerToken: makeOwnerToken(1),
        leaseExpiresAt: FUTURE_LEASE,
      })
    );
    const { row, identity } = seedFailedIdentityRow();
    const before = { ...row };

    const result = await rearmFailedImageRenderClaim({
      userId: 7,
      contentPostId: 13,
      requestAttemptKey: identity.requestAttemptKey,
      intentFingerprint: identity.intentFingerprint,
      ownerToken: makeOwnerToken(2),
      leaseExpiresAt: FUTURE_LEASE,
    });

    expect(result).toEqual({ rearmed: false, reason: "active_key_occupied" });
    expect(state.rows.find((r) => r.id === row.id)).toEqual(before);
  });

  it("blocks rearm on conflicting intent without mutation", async () => {
    const { row, identity } = seedFailedIdentityRow();
    const before = { ...row };
    const otherIntent = deriveAttempt(7, 13, "attempt-token-1", { regenerate: true });

    const result = await rearmFailedImageRenderClaim({
      userId: 7,
      contentPostId: 13,
      requestAttemptKey: identity.requestAttemptKey,
      intentFingerprint: otherIntent.intentFingerprint,
      ownerToken: makeOwnerToken(2),
      leaseExpiresAt: FUTURE_LEASE,
    });

    expect(result).toEqual({ rearmed: false, reason: "intent_conflict" });
    expect(state.rows.find((r) => r.id === row.id)).toEqual(before);
  });

  it("blocks rearm for a wrong user or post scope", async () => {
    const { row, identity } = seedFailedIdentityRow();
    const before = { ...row };

    const wrongUser = await rearmFailedImageRenderClaim({
      userId: 8,
      contentPostId: 13,
      requestAttemptKey: identity.requestAttemptKey,
      intentFingerprint: identity.intentFingerprint,
      ownerToken: makeOwnerToken(2),
      leaseExpiresAt: FUTURE_LEASE,
    });
    expect(wrongUser).toEqual({ rearmed: false, reason: "not_found" });

    const wrongPost = await rearmFailedImageRenderClaim({
      userId: 7,
      contentPostId: 99,
      requestAttemptKey: identity.requestAttemptKey,
      intentFingerprint: identity.intentFingerprint,
      ownerToken: makeOwnerToken(2),
      leaseExpiresAt: FUTURE_LEASE,
    });
    expect(wrongPost).toEqual({ rearmed: false, reason: "not_found" });
    expect(state.rows.find((r) => r.id === row.id)).toEqual(before);
  });

  it("blocks rearm when a deduction was recorded for the row", async () => {
    const { row, identity } = seedFailedIdentityRow({ deductionRecorded: true });
    const before = { ...row };

    const result = await rearmFailedImageRenderClaim({
      userId: 7,
      contentPostId: 13,
      requestAttemptKey: identity.requestAttemptKey,
      intentFingerprint: identity.intentFingerprint,
      ownerToken: makeOwnerToken(2),
      leaseExpiresAt: FUTURE_LEASE,
    });

    expect(result).toEqual({ rearmed: false, reason: "deduction_recorded" });
    expect(state.rows.find((r) => r.id === row.id)).toEqual(before);
  });

  it("blocks rearm for running, completed and stale-running rows", async () => {
    const { identity } = seedFailedIdentityRow();

    // Re-seed as running with an unexpired lease.
    state.rows[0].status = "running";
    state.rows[0].activeClaimKey = "active:7:post:13:image";
    state.rows[0].leaseExpiresAt = FUTURE_LEASE;
    const running = await rearmFailedImageRenderClaim({
      userId: 7,
      contentPostId: 13,
      requestAttemptKey: identity.requestAttemptKey,
      intentFingerprint: identity.intentFingerprint,
      ownerToken: makeOwnerToken(2),
      leaseExpiresAt: FUTURE_LEASE,
    });
    expect(running).toEqual({ rearmed: false, reason: "not_failed" });

    // Stale running rows must never be rearmed either.
    state.rows[0].leaseExpiresAt = PAST_LEASE;
    const staleRunning = await rearmFailedImageRenderClaim({
      userId: 7,
      contentPostId: 13,
      requestAttemptKey: identity.requestAttemptKey,
      intentFingerprint: identity.intentFingerprint,
      ownerToken: makeOwnerToken(2),
      leaseExpiresAt: FUTURE_LEASE,
    });
    expect(staleRunning).toEqual({ rearmed: false, reason: "not_failed" });

    state.rows[0].status = "completed";
    state.rows[0].activeClaimKey = null;
    const completed = await rearmFailedImageRenderClaim({
      userId: 7,
      contentPostId: 13,
      requestAttemptKey: identity.requestAttemptKey,
      intentFingerprint: identity.intentFingerprint,
      ownerToken: makeOwnerToken(2),
      leaseExpiresAt: FUTURE_LEASE,
    });
    expect(completed).toEqual({ rearmed: false, reason: "not_failed" });
    expect(state.rows).toHaveLength(1);
  });

  it("returns not_found when no row carries the requestAttemptKey", async () => {
    const identity = deriveAttempt();
    const result = await rearmFailedImageRenderClaim({
      userId: 7,
      contentPostId: 13,
      requestAttemptKey: identity.requestAttemptKey,
      intentFingerprint: identity.intentFingerprint,
      ownerToken: makeOwnerToken(2),
      leaseExpiresAt: FUTURE_LEASE,
    });
    expect(result).toEqual({ rearmed: false, reason: "not_found" });
  });

  it("rejects malformed keys and invalid scope before touching the database", async () => {
    const identity = deriveAttempt();
    await expect(
      rearmFailedImageRenderClaim({
        userId: 7,
        contentPostId: 13,
        requestAttemptKey: "bad-key",
        intentFingerprint: identity.intentFingerprint,
        ownerToken: makeOwnerToken(2),
        leaseExpiresAt: FUTURE_LEASE,
      })
    ).rejects.toThrow(/Invalid requestAttemptKey/);
    await expect(
      rearmFailedImageRenderClaim({
        userId: 7,
        contentPostId: 13,
        requestAttemptKey: identity.requestAttemptKey,
        intentFingerprint: "bad-fingerprint",
        ownerToken: makeOwnerToken(2),
        leaseExpiresAt: FUTURE_LEASE,
      })
    ).rejects.toThrow(/Invalid intentFingerprint/);
    expect(state.rows).toHaveLength(0);
  });
});

// ─── B1: dormant confirmed-deduction marker ───

describe("markImageRenderDeductionRecorded", () => {
  let state: FakeDbState;

  function seedRunningIdentityRow(overrides: Record<string, unknown> = {}) {
    const now = new Date();
    const identity = deriveAttempt();
    const row: Record<string, unknown> = {
      id: state.rows.length + 1,
      userId: 7,
      contentPostId: 13,
      activeClaimKey: "active:7:post:13:image",
      ownerToken: makeOwnerToken(1),
      status: "running",
      leaseExpiresAt: FUTURE_LEASE,
      createdAt: now,
      updatedAt: now,
      requestAttemptKey: identity.requestAttemptKey,
      intentFingerprint: identity.intentFingerprint,
      deductionKey: identity.deductionKey,
      deductionRecorded: false,
      ...overrides,
    };
    state.rows.push(row);
    return { row, identity };
  }

  beforeEach(() => {
    const fake = createFakeDb();
    state = fake.state;
    mockGetDb.mockReturnValue(fake.db);
  });

  it("flips deductionRecorded false→true exactly once for the authorized owner", async () => {
    const { row, identity } = seedRunningIdentityRow();

    const result = await markImageRenderDeductionRecorded({
      claimId: row.id as number,
      ownerToken: makeOwnerToken(1),
      requestAttemptKey: identity.requestAttemptKey,
      deductionKey: identity.deductionKey,
    });

    expect(result).toEqual({ recorded: true });
    expect(state.rows[0].deductionRecorded).toBe(true);
  });

  it("a repeated call does not change state and cannot reset the flag", async () => {
    const { row, identity } = seedRunningIdentityRow();
    const params = {
      claimId: row.id as number,
      ownerToken: makeOwnerToken(1),
      requestAttemptKey: identity.requestAttemptKey,
      deductionKey: identity.deductionKey,
    };

    await markImageRenderDeductionRecorded(params);
    const second = await markImageRenderDeductionRecorded(params);

    expect(second).toEqual({ recorded: false, reason: "not_found_or_unauthorized" });
    expect(state.rows[0].deductionRecorded).toBe(true);
  });

  it("rejects a wrong owner without mutation", async () => {
    const { row, identity } = seedRunningIdentityRow();
    const before = { ...state.rows[0] };

    const result = await markImageRenderDeductionRecorded({
      claimId: row.id as number,
      ownerToken: makeOwnerToken(999),
      requestAttemptKey: identity.requestAttemptKey,
      deductionKey: identity.deductionKey,
    });

    expect(result).toEqual({ recorded: false, reason: "not_found_or_unauthorized" });
    expect(state.rows[0]).toEqual(before);
  });

  it("rejects terminal claims", async () => {
    const { row, identity } = seedRunningIdentityRow();
    state.rows[0].status = "failed";
    state.rows[0].activeClaimKey = null;

    const result = await markImageRenderDeductionRecorded({
      claimId: row.id as number,
      ownerToken: makeOwnerToken(1),
      requestAttemptKey: identity.requestAttemptKey,
      deductionKey: identity.deductionKey,
    });

    expect(result).toEqual({ recorded: false, reason: "not_found_or_unauthorized" });
    expect(state.rows[0].deductionRecorded).toBe(false);
  });

  it("rejects a mismatched requestAttemptKey or deductionKey", async () => {
    const { row, identity } = seedRunningIdentityRow();
    const other = deriveAttempt(7, 13, "attempt-token-2");

    const wrongKey = await markImageRenderDeductionRecorded({
      claimId: row.id as number,
      ownerToken: makeOwnerToken(1),
      requestAttemptKey: other.requestAttemptKey,
      deductionKey: identity.deductionKey,
    });
    expect(wrongKey).toEqual({ recorded: false, reason: "not_found_or_unauthorized" });

    const wrongDeduction = await markImageRenderDeductionRecorded({
      claimId: row.id as number,
      ownerToken: makeOwnerToken(1),
      requestAttemptKey: identity.requestAttemptKey,
      deductionKey: other.deductionKey,
    });
    expect(wrongDeduction).toEqual({
      recorded: false,
      reason: "not_found_or_unauthorized",
    });
    expect(state.rows[0].deductionRecorded).toBe(false);
  });

  it("rejects malformed keys before touching the database", async () => {
    const { row, identity } = seedRunningIdentityRow();
    await expect(
      markImageRenderDeductionRecorded({
        claimId: row.id as number,
        ownerToken: makeOwnerToken(1),
        requestAttemptKey: "bad-key",
        deductionKey: identity.deductionKey,
      })
    ).rejects.toThrow(/Invalid requestAttemptKey/);
    await expect(
      markImageRenderDeductionRecorded({
        claimId: row.id as number,
        ownerToken: makeOwnerToken(1),
        requestAttemptKey: identity.requestAttemptKey,
        deductionKey: "",
      })
    ).rejects.toThrow(/Invalid deductionKey/);
    expect(state.rows[0].deductionRecorded).toBe(false);
  });
});


// ─── B2B-2A: dormant durable result linkage + replay snapshot ───

const RESULT_COMPLETED_AT = new Date("2026-06-01T00:00:00.000Z");

function makeResult(
  overrides: Partial<ImageRenderResultSnapshotInput> = {}
): ImageRenderResultSnapshotInput {
  return {
    generatedImageId: 5000,
    imageUrl: "/generated/images/7/premium-leaflet-v2_asset.png",
    provider: "v2",
    providerJobId: "premium-v2-123",
    creditsCharged: 12,
    qualityTier: "premium",
    qualityLabel: "Premium Marketing Leaflet",
    isDraft: false,
    completedAt: RESULT_COMPLETED_AT,
    ...overrides,
  };
}

describe("completeImageRenderClaimWithResult", () => {
  let state: FakeDbState;
  let updateSpy: ReturnType<typeof vi.fn>;
  let selectSpy: ReturnType<typeof vi.fn>;

  function seedRunningClaim(overrides: Record<string, unknown> = {}) {
    const now = new Date("2026-05-01T00:00:00.000Z");
    const identity = deriveAttempt();
    const row: Record<string, unknown> = {
      id: state.rows.length + 1,
      userId: 7,
      contentPostId: 13,
      activeClaimKey: "active:7:post:13:image",
      ownerToken: makeOwnerToken(1),
      status: "running",
      leaseExpiresAt: FUTURE_LEASE,
      createdAt: now,
      updatedAt: now,
      requestAttemptKey: identity.requestAttemptKey,
      intentFingerprint: identity.intentFingerprint,
      deductionKey: identity.deductionKey,
      deductionRecorded: false,
      generatedImageId: null,
      resultImageUrl: null,
      resultProvider: null,
      resultProviderJobId: null,
      resultCreditsCharged: null,
      resultQualityTier: null,
      resultQualityLabel: null,
      resultIsDraft: null,
      completedAt: null,
      ...overrides,
    };
    state.rows.push(row);
    return { row, identity };
  }

  function completionParams(identity: ReturnType<typeof deriveAttempt>) {
    return {
      claimId: 1,
      ownerToken: makeOwnerToken(1),
      userId: 7,
      contentPostId: 13,
      requestAttemptKey: identity.requestAttemptKey,
      intentFingerprint: identity.intentFingerprint,
      deductionKey: identity.deductionKey,
      result: makeResult(),
    };
  }

  beforeEach(() => {
    const fake = createFakeDb();
    state = fake.state;
    updateSpy = fake.db.update;
    selectSpy = fake.db.select;
    mockGetDb.mockReturnValue(fake.db);
  });

  it("successfully completes a running claim with one atomic snapshot+link+completion", async () => {
    const { identity } = seedRunningClaim();

    const result = await completeImageRenderClaimWithResult(
      completionParams(identity)
    );

    expect(result.completed).toBe(true);
    if (!result.completed) throw new Error("expected completion");
    expect(result.claim.status).toBe("completed");
    expect(result.claim.activeClaimKey).toBeNull();
    expect(result.claim.generatedImageId).toBe(5000);
    expect(result.claim.resultImageUrl).toBe(makeResult().imageUrl);
    expect(result.claim.resultProvider).toBe("v2");
    expect(result.claim.resultProviderJobId).toBe("premium-v2-123");
    expect(result.claim.resultCreditsCharged).toBe(12);
    expect(result.claim.resultQualityTier).toBe("premium");
    expect(result.claim.resultQualityLabel).toBe("Premium Marketing Leaflet");
    expect(result.claim.resultIsDraft).toBe(false);
    expect(result.claim.completedAt).toEqual(RESULT_COMPLETED_AT);

    const stored = state.rows[0];
    expect(stored.status).toBe("completed");
    expect(stored.activeClaimKey).toBeNull();
    expect(stored.generatedImageId).toBe(5000);
    // Exactly one UPDATE performed the snapshot, link, completion and
    // active-key clearing; the only SELECT is the success read-back.
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(selectSpy).toHaveBeenCalledTimes(1);
  });

  it("preserves deductionRecorded while completing with result", async () => {
    const { identity } = seedRunningClaim({ deductionRecorded: true });

    const result = await completeImageRenderClaimWithResult(
      completionParams(identity)
    );

    expect(result.completed).toBe(true);
    expect(state.rows[0].deductionRecorded).toBe(true);
  });

  it("classifies a repeated same-result completion as deterministic and non-mutating", async () => {
    const { identity } = seedRunningClaim();
    const params = completionParams(identity);

    const first = await completeImageRenderClaimWithResult(params);
    expect(first.completed).toBe(true);
    const afterFirst = { ...state.rows[0] };

    const second = await completeImageRenderClaimWithResult(params);
    expect(second).toEqual({
      completed: false,
      reason: "already_completed_with_same_result",
    });
    expect(state.rows[0]).toEqual(afterFirst);
  });

  it("never overwrites an attached result with a different generatedImageId", async () => {
    const { identity } = seedRunningClaim();
    const first = await completeImageRenderClaimWithResult(
      completionParams(identity)
    );
    expect(first.completed).toBe(true);
    const afterFirst = { ...state.rows[0] };

    const conflicting = await completeImageRenderClaimWithResult({
      ...completionParams(identity),
      result: makeResult({ generatedImageId: 5001 }),
    });

    expect(conflicting).toEqual({
      completed: false,
      reason: "result_already_attached",
    });
    expect(state.rows[0]).toEqual(afterFirst);
    expect(state.rows[0].generatedImageId).toBe(5000);
  });

  it("rejects a changed snapshot with the same generatedImageId as idempotent", async () => {
    const { identity } = seedRunningClaim();
    const first = await completeImageRenderClaimWithResult(
      completionParams(identity)
    );
    expect(first.completed).toBe(true);

    const changedSnapshot = await completeImageRenderClaimWithResult({
      ...completionParams(identity),
      result: makeResult({ creditsCharged: 99 }),
    });

    expect(changedSnapshot).toEqual({
      completed: false,
      reason: "result_already_attached",
    });
    expect(state.rows[0].resultCreditsCharged).toBe(12);
  });

  it("rejects a wrong owner with not_found_or_unauthorized", async () => {
    const { identity } = seedRunningClaim();
    const result = await completeImageRenderClaimWithResult({
      ...completionParams(identity),
      ownerToken: makeOwnerToken(999),
    });
    expect(result).toEqual({
      completed: false,
      reason: "not_found_or_unauthorized",
    });
    expect(state.rows[0].status).toBe("running");
  });

  it("rejects a wrong user with identity_mismatch", async () => {
    const { identity } = seedRunningClaim();
    const result = await completeImageRenderClaimWithResult({
      ...completionParams(identity),
      userId: 8,
    });
    expect(result).toEqual({ completed: false, reason: "identity_mismatch" });
    expect(state.rows[0].status).toBe("running");
  });

  it("rejects a wrong content post with identity_mismatch", async () => {
    const { identity } = seedRunningClaim();
    const result = await completeImageRenderClaimWithResult({
      ...completionParams(identity),
      contentPostId: 14,
    });
    expect(result).toEqual({ completed: false, reason: "identity_mismatch" });
    expect(state.rows[0].status).toBe("running");
  });

  it("rejects a wrong requestAttemptKey with identity_mismatch", async () => {
    const { identity } = seedRunningClaim();
    const other = deriveAttempt(7, 13, "attempt-token-2");
    const result = await completeImageRenderClaimWithResult({
      ...completionParams(identity),
      requestAttemptKey: other.requestAttemptKey,
      deductionKey: other.deductionKey,
    });
    expect(result).toEqual({ completed: false, reason: "identity_mismatch" });
    expect(state.rows[0].status).toBe("running");
  });

  it("rejects an intentFingerprint mismatch with identity_mismatch", async () => {
    const { identity } = seedRunningClaim();
    const other = deriveAttempt(7, 13, "attempt-token-1", { regenerate: true });
    const result = await completeImageRenderClaimWithResult({
      ...completionParams(identity),
      intentFingerprint: other.intentFingerprint,
    });
    expect(result).toEqual({ completed: false, reason: "identity_mismatch" });
    expect(state.rows[0].status).toBe("running");
  });

  it("rejects a failed claim without mutation", async () => {
    const { identity } = seedRunningClaim({ status: "failed", activeClaimKey: null });
    const result = await completeImageRenderClaimWithResult(
      completionParams(identity)
    );
    expect(result).toEqual({
      completed: false,
      reason: "not_found_or_unauthorized",
    });
    expect(state.rows[0].status).toBe("failed");
    expect(state.rows[0].generatedImageId).toBeNull();
  });

  it("fails closed on an already-completed legacy claim without a link", async () => {
    const { identity } = seedRunningClaim({
      status: "completed",
      activeClaimKey: null,
    });
    const result = await completeImageRenderClaimWithResult(
      completionParams(identity)
    );
    expect(result).toEqual({
      completed: false,
      reason: "not_found_or_unauthorized",
    });
    expect(state.rows[0].generatedImageId).toBeNull();
  });

  it("fails closed on a partial stored snapshot instead of accepting idempotency", async () => {
    const { identity } = seedRunningClaim();
    const first = await completeImageRenderClaimWithResult(
      completionParams(identity)
    );
    expect(first.completed).toBe(true);

    // Corrupt the stored snapshot (partial/null replay field).
    state.rows[0].resultQualityLabel = null;

    const repeated = await completeImageRenderClaimWithResult(
      completionParams(identity)
    );
    expect(repeated).toEqual({
      completed: false,
      reason: "result_already_attached",
    });
    expect(state.rows[0].resultQualityLabel).toBeNull();
  });

  it("maps the unique image-link collision to result_already_attached", async () => {
    const first = seedRunningClaim({ id: 1 });
    const second = seedRunningClaim({
      id: 2,
      activeClaimKey: "active:7:post:14:image",
      contentPostId: 14,
    });
    const firstParams = completionParams(first.identity);
    const secondParams = {
      ...completionParams(second.identity),
      claimId: 2,
      contentPostId: 14,
      deductionKey: second.identity.deductionKey,
    };

    const firstResult = await completeImageRenderClaimWithResult(firstParams);
    expect(firstResult.completed).toBe(true);

    const secondResult = await completeImageRenderClaimWithResult(secondParams);
    expect(secondResult).toEqual({
      completed: false,
      reason: "result_already_attached",
    });
    expect(state.rows[1].status).toBe("running");
  });

  it("does not leak raw database error text on a subsystem exception", async () => {
    seedRunningClaim();
    mockGetDb.mockReturnValue({
      update: vi.fn(() => {
        throw new Error("raw db exploded: connection reset by peer");
      }),
    });

    await expect(
      completeImageRenderClaimWithResult(completionParams(deriveAttempt()))
    ).rejects.toThrow(/Image render claim completion failed/);
    await expect(
      completeImageRenderClaimWithResult(completionParams(deriveAttempt()))
    ).rejects.not.toThrow(/raw db exploded/);
  });

  it("performs at most one reread and never retries the UPDATE after a zero-row CAS", async () => {
    const { identity } = seedRunningClaim();
    const before = { ...state.rows[0] };

    // Zero-row CAS (wrong owner) followed by exactly one classification reread.
    const result = await completeImageRenderClaimWithResult({
      ...completionParams(identity),
      ownerToken: makeOwnerToken(999),
    });

    expect(result).toEqual({
      completed: false,
      reason: "not_found_or_unauthorized",
    });
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(selectSpy).toHaveBeenCalledTimes(1);
    expect(state.rows[0]).toEqual(before);
  });

  it("rejects malformed snapshot inputs before touching the database", async () => {
    const { identity } = seedRunningClaim();
    const params = completionParams(identity);

    await expect(
      completeImageRenderClaimWithResult({
        ...params,
        result: makeResult({ generatedImageId: 0 }),
      })
    ).rejects.toThrow(/Invalid generatedImageId/);
    await expect(
      completeImageRenderClaimWithResult({
        ...params,
        result: makeResult({ imageUrl: "" }),
      })
    ).rejects.toThrow(/Invalid imageUrl/);
    await expect(
      completeImageRenderClaimWithResult({
        ...params,
        result: makeResult({ imageUrl: "x".repeat(2049) }),
      })
    ).rejects.toThrow(/Invalid imageUrl/);
    await expect(
      completeImageRenderClaimWithResult({
        ...params,
        result: makeResult({ provider: "" }),
      })
    ).rejects.toThrow(/Invalid provider/);
    await expect(
      completeImageRenderClaimWithResult({
        ...params,
        result: makeResult({ providerJobId: "" }),
      })
    ).rejects.toThrow(/Invalid providerJobId/);
    await expect(
      completeImageRenderClaimWithResult({
        ...params,
        result: makeResult({ creditsCharged: -1 }),
      })
    ).rejects.toThrow(/Invalid creditsCharged/);
    await expect(
      completeImageRenderClaimWithResult({
        ...params,
        result: makeResult({ creditsCharged: 1.5 }),
      })
    ).rejects.toThrow(/Invalid creditsCharged/);
    await expect(
      completeImageRenderClaimWithResult({
        ...params,
        result: makeResult({ qualityTier: "" }),
      })
    ).rejects.toThrow(/Invalid qualityTier/);
    await expect(
      completeImageRenderClaimWithResult({
        ...params,
        result: makeResult({ qualityLabel: "" }),
      })
    ).rejects.toThrow(/Invalid qualityLabel/);
    await expect(
      completeImageRenderClaimWithResult({
        ...params,
        result: makeResult({ isDraft: "yes" as unknown as boolean }),
      })
    ).rejects.toThrow(/Invalid isDraft/);
    await expect(
      completeImageRenderClaimWithResult({
        ...params,
        result: makeResult({ completedAt: new Date("not-a-date") }),
      })
    ).rejects.toThrow(/Invalid completedAt/);

    expect(updateSpy).not.toHaveBeenCalled();
    expect(state.rows[0].status).toBe("running");
  });
});

describe("getCompletedImageRenderResult", () => {
  let state: FakeDbState;

  function seedCompletedClaim(overrides: Record<string, unknown> = {}) {
    const now = new Date("2026-05-01T00:00:00.000Z");
    const identity = deriveAttempt();
    const row: Record<string, unknown> = {
      id: state.rows.length + 1,
      userId: 7,
      contentPostId: 13,
      activeClaimKey: null,
      ownerToken: makeOwnerToken(1),
      status: "completed",
      leaseExpiresAt: FUTURE_LEASE,
      createdAt: now,
      updatedAt: now,
      requestAttemptKey: identity.requestAttemptKey,
      intentFingerprint: identity.intentFingerprint,
      deductionKey: identity.deductionKey,
      deductionRecorded: true,
      generatedImageId: 5000,
      resultImageUrl: makeResult().imageUrl,
      resultProvider: "v2",
      resultProviderJobId: "premium-v2-123",
      resultCreditsCharged: 12,
      resultQualityTier: "premium",
      resultQualityLabel: "Premium Marketing Leaflet",
      resultIsDraft: false,
      completedAt: RESULT_COMPLETED_AT,
      ...overrides,
    };
    state.rows.push(row);
    return { row, identity };
  }

  function seedGeneratedImage(overrides: Record<string, unknown> = {}) {
    const row: Record<string, unknown> = {
      id: 5000,
      userId: 7,
      contentPostId: 13,
      url: makeResult().imageUrl,
      status: "completed",
      __table: "generated_images",
      ...overrides,
    };
    state.rows.push(row);
    return row;
  }

  function lookupParams(identity: ReturnType<typeof deriveAttempt>) {
    return {
      userId: 7,
      contentPostId: 13,
      requestAttemptKey: identity.requestAttemptKey,
      intentFingerprint: identity.intentFingerprint,
    };
  }

  beforeEach(() => {
    const fake = createFakeDb();
    state = fake.state;
    mockGetDb.mockReturnValue(fake.db);
  });

  it("returns the exact replayable projection for a completed linked claim", async () => {
    const { identity } = seedCompletedClaim();
    seedGeneratedImage();

    const result = await getCompletedImageRenderResult(lookupParams(identity));

    expect(result).toEqual({
      replayable: true,
      result: {
        generatedImageId: 5000,
        imageUrl: makeResult().imageUrl,
        provider: "v2",
        providerJobId: "premium-v2-123",
        creditsCharged: 12,
        qualityTier: "premium",
        qualityLabel: "Premium Marketing Leaflet",
        isDraft: false,
        completedAt: RESULT_COMPLETED_AT,
      },
    });
  });

  it("returns null providerJobId when the stored snapshot has none", async () => {
    const { identity } = seedCompletedClaim({ resultProviderJobId: null });
    seedGeneratedImage();

    const result = await getCompletedImageRenderResult(lookupParams(identity));

    expect(result.replayable).toBe(true);
    if (result.replayable) {
      expect(result.result.providerJobId).toBeNull();
    }
  });

  it("rejects a conflicting intent fingerprint", async () => {
    const { identity } = seedCompletedClaim();
    seedGeneratedImage();
    const other = deriveAttempt(7, 13, "attempt-token-1", { regenerate: true });

    const result = await getCompletedImageRenderResult({
      ...lookupParams(identity),
      intentFingerprint: other.intentFingerprint,
    });

    expect(result).toEqual({ replayable: false, reason: "intent_conflict" });
  });

  it("rejects a wrong user or post as not_completed_or_not_found", async () => {
    const { identity } = seedCompletedClaim();
    seedGeneratedImage();

    const wrongUser = await getCompletedImageRenderResult({
      ...lookupParams(identity),
      userId: 8,
    });
    expect(wrongUser).toEqual({
      replayable: false,
      reason: "not_completed_or_not_found",
    });

    const wrongPost = await getCompletedImageRenderResult({
      ...lookupParams(identity),
      contentPostId: 14,
    });
    expect(wrongPost).toEqual({
      replayable: false,
      reason: "not_completed_or_not_found",
    });
  });

  it("rejects running or failed claims as not_completed_or_not_found", async () => {
    const running = seedCompletedClaim({ id: 1, status: "running" });
    const failed = seedCompletedClaim({
      id: 2,
      status: "failed",
      requestAttemptKey: deriveAttempt(7, 13, "attempt-token-2").requestAttemptKey,
    });

    const runningResult = await getCompletedImageRenderResult(
      lookupParams(running.identity)
    );
    expect(runningResult).toEqual({
      replayable: false,
      reason: "not_completed_or_not_found",
    });

    const failedResult = await getCompletedImageRenderResult(
      lookupParams(failed.identity)
    );
    expect(failedResult).toEqual({
      replayable: false,
      reason: "not_completed_or_not_found",
    });
  });

  it("fails closed on completed claims without a result link", async () => {
    const { identity } = seedCompletedClaim({
      generatedImageId: null,
      resultImageUrl: null,
      resultProvider: null,
      resultProviderJobId: null,
      resultCreditsCharged: null,
      resultQualityTier: null,
      resultQualityLabel: null,
      resultIsDraft: null,
      completedAt: null,
    });

    const result = await getCompletedImageRenderResult(lookupParams(identity));

    expect(result).toEqual({ replayable: false, reason: "completed_without_result" });
  });

  it("fails closed on a partial stored snapshot", async () => {
    const { identity } = seedCompletedClaim({ resultQualityLabel: null });

    const result = await getCompletedImageRenderResult(lookupParams(identity));

    expect(result).toEqual({ replayable: false, reason: "completed_without_result" });
  });

  it("rejects a missing generated_images row", async () => {
    const { identity } = seedCompletedClaim();

    const result = await getCompletedImageRenderResult(lookupParams(identity));

    expect(result).toEqual({
      replayable: false,
      reason: "linked_result_missing_or_mismatched",
    });
  });

  it("rejects a linked row owned by a different user", async () => {
    const { identity } = seedCompletedClaim();
    seedGeneratedImage({ userId: 8 });

    const result = await getCompletedImageRenderResult(lookupParams(identity));

    expect(result).toEqual({
      replayable: false,
      reason: "linked_result_missing_or_mismatched",
    });
  });

  it("rejects a linked row attached to a different content post", async () => {
    const { identity } = seedCompletedClaim();
    seedGeneratedImage({ contentPostId: 14 });

    const result = await getCompletedImageRenderResult(lookupParams(identity));

    expect(result).toEqual({
      replayable: false,
      reason: "linked_result_missing_or_mismatched",
    });
  });

  it("rejects a linked row with a null contentPostId", async () => {
    const { identity } = seedCompletedClaim();
    seedGeneratedImage({ contentPostId: null });

    const result = await getCompletedImageRenderResult(lookupParams(identity));

    expect(result).toEqual({
      replayable: false,
      reason: "linked_result_missing_or_mismatched",
    });
  });

  it("never uses latest-image ordering: returns the linked result, not the newest row", async () => {
    const { identity } = seedCompletedClaim();
    seedGeneratedImage({ id: 5000, url: makeResult().imageUrl });
    seedGeneratedImage({
      id: 5001,
      url: makeResult().imageUrl,
    });

    const result = await getCompletedImageRenderResult(lookupParams(identity));

    expect(result.replayable).toBe(true);
    if (result.replayable) {
      // The replayed identity is the linked image (5000), never the newest row.
      expect(result.result.generatedImageId).toBe(5000);
      expect(result.result.generatedImageId).not.toBe(5001);
      expect(result.result.imageUrl).toBe(makeResult().imageUrl);
    }
  });

  it("never exposes internal identity or ownership fields in any outcome", async () => {
    const { identity } = seedCompletedClaim();
    // No generated image row: blocked outcome.
    const blocked = await getCompletedImageRenderResult(lookupParams(identity));
    expect(blocked.replayable).toBe(false);
    expect(Object.keys(blocked).sort()).toEqual(["reason", "replayable"]);

    const serializedBlocked = JSON.stringify(blocked);
    expect(serializedBlocked).not.toContain(makeOwnerToken(1));
    expect(serializedBlocked).not.toContain("active:7:post:13:image");
    expect(serializedBlocked).not.toContain(identity.requestAttemptKey);
    expect(serializedBlocked).not.toContain(identity.intentFingerprint);
    expect(serializedBlocked).not.toContain(identity.deductionKey);
    expect(serializedBlocked).not.toContain("deductionRecorded");

    seedGeneratedImage();
    const replayable = await getCompletedImageRenderResult(lookupParams(identity));
    expect(Object.keys(replayable).sort()).toEqual(["replayable", "result"]);
    if (replayable.replayable) {
      expect(Object.keys(replayable.result).sort()).toEqual([
        "completedAt",
        "creditsCharged",
        "generatedImageId",
        "imageUrl",
        "isDraft",
        "provider",
        "providerJobId",
        "qualityLabel",
        "qualityTier",
      ]);
      const serializedReplayable = JSON.stringify(replayable);
      expect(serializedReplayable).not.toContain(makeOwnerToken(1));
      expect(serializedReplayable).not.toContain(identity.requestAttemptKey);
      expect(serializedReplayable).not.toContain(identity.intentFingerprint);
      expect(serializedReplayable).not.toContain(identity.deductionKey);
    }
  });

  it("rejects malformed keys before touching the database", async () => {
    const { identity } = seedCompletedClaim();
    await expect(
      getCompletedImageRenderResult({
        userId: 7,
        contentPostId: 13,
        requestAttemptKey: "bad-key",
        intentFingerprint: identity.intentFingerprint,
      })
    ).rejects.toThrow(/Invalid requestAttemptKey/);
    await expect(
      getCompletedImageRenderResult({
        userId: 7,
        contentPostId: 13,
        requestAttemptKey: identity.requestAttemptKey,
        intentFingerprint: "bad-key",
      })
    ).rejects.toThrow(/Invalid intentFingerprint/);
  });
});


// ─── B2B-2A correction: executor seam, deduction identity, linked-result validation ───

function asExecutor(fake: ReturnType<typeof createFakeDb>): ImageRenderClaimDbExecutor {
  return fake.db as unknown as ImageRenderClaimDbExecutor;
}

describe("executor seam (B2B-2A correction)", () => {
  let state: FakeDbState;
  let fake: ReturnType<typeof createFakeDb>;

  function seedRunningClaim(overrides: Record<string, unknown> = {}) {
    const now = new Date("2026-05-01T00:00:00.000Z");
    const identity = deriveAttempt();
    const row: Record<string, unknown> = {
      id: state.rows.length + 1,
      userId: 7,
      contentPostId: 13,
      activeClaimKey: "active:7:post:13:image",
      ownerToken: makeOwnerToken(1),
      status: "running",
      leaseExpiresAt: FUTURE_LEASE,
      createdAt: now,
      updatedAt: now,
      requestAttemptKey: identity.requestAttemptKey,
      intentFingerprint: identity.intentFingerprint,
      deductionKey: identity.deductionKey,
      deductionRecorded: false,
      generatedImageId: null,
      resultImageUrl: null,
      resultProvider: null,
      resultProviderJobId: null,
      resultCreditsCharged: null,
      resultQualityTier: null,
      resultQualityLabel: null,
      resultIsDraft: null,
      completedAt: null,
      ...overrides,
    };
    state.rows.push(row);
    return { row, identity };
  }

  function completionParams(identity: ReturnType<typeof deriveAttempt>) {
    return {
      claimId: 1,
      ownerToken: makeOwnerToken(1),
      userId: 7,
      contentPostId: 13,
      requestAttemptKey: identity.requestAttemptKey,
      intentFingerprint: identity.intentFingerprint,
      deductionKey: identity.deductionKey,
      result: makeResult(),
    };
  }

  beforeEach(() => {
    fake = createFakeDb();
    state = fake.state;
    mockGetDb.mockReturnValue(fake.db);
  });

  it("uses the supplied executor for completion and never calls getDb", async () => {
    const { identity } = seedRunningClaim();
    mockGetDb.mockClear();

    const result = await completeImageRenderClaimWithResult({
      ...completionParams(identity),
      executor: asExecutor(fake),
    });

    expect(result.completed).toBe(true);
    expect(fake.db.update).toHaveBeenCalledTimes(1);
    expect(fake.db.select).toHaveBeenCalledTimes(1);
    expect(mockGetDb).not.toHaveBeenCalled();
  });

  it("uses the supplied executor for the zero-row reread without calling getDb", async () => {
    const { identity } = seedRunningClaim();
    mockGetDb.mockClear();

    const result = await completeImageRenderClaimWithResult({
      ...completionParams(identity),
      ownerToken: makeOwnerToken(999),
      executor: asExecutor(fake),
    });

    expect(result).toEqual({
      completed: false,
      reason: "not_found_or_unauthorized",
    });
    // One UPDATE attempt plus exactly one classification reread, both through
    // the supplied executor.
    expect(fake.db.update).toHaveBeenCalledTimes(1);
    expect(fake.db.select).toHaveBeenCalledTimes(1);
    expect(mockGetDb).not.toHaveBeenCalled();
  });

  it("uses the supplied executor for replay lookup (claim + image queries) without getDb", async () => {
    const now = new Date("2026-05-01T00:00:00.000Z");
    const identity = deriveAttempt();
    state.rows.push({
      id: 1,
      userId: 7,
      contentPostId: 13,
      activeClaimKey: null,
      ownerToken: makeOwnerToken(1),
      status: "completed",
      leaseExpiresAt: FUTURE_LEASE,
      createdAt: now,
      updatedAt: now,
      requestAttemptKey: identity.requestAttemptKey,
      intentFingerprint: identity.intentFingerprint,
      deductionKey: identity.deductionKey,
      deductionRecorded: true,
      generatedImageId: 5000,
      resultImageUrl: makeResult().imageUrl,
      resultProvider: "v2",
      resultProviderJobId: "premium-v2-123",
      resultCreditsCharged: 12,
      resultQualityTier: "premium",
      resultQualityLabel: "Premium Marketing Leaflet",
      resultIsDraft: false,
      completedAt: RESULT_COMPLETED_AT,
    });
    state.rows.push({
      id: 5000,
      userId: 7,
      contentPostId: 13,
      url: makeResult().imageUrl,
      status: "completed",
      __table: "generated_images",
    });
    mockGetDb.mockClear();

    const result = await getCompletedImageRenderResult({
      userId: 7,
      contentPostId: 13,
      requestAttemptKey: identity.requestAttemptKey,
      intentFingerprint: identity.intentFingerprint,
      executor: asExecutor(fake),
    });

    expect(result.replayable).toBe(true);
    // Claim lookup + linked-image query, both through the supplied executor.
    expect(fake.db.select).toHaveBeenCalledTimes(2);
    expect(mockGetDb).not.toHaveBeenCalled();
  });

  it("routes every query of one operation through the same executor instance", async () => {
    const { identity } = seedRunningClaim();
    mockGetDb.mockClear();

    await completeImageRenderClaimWithResult({
      ...completionParams(identity),
      executor: asExecutor(fake),
    });

    // The mutation and the success read-back both ran on the fake's spies,
    // proving a single executor instance handled the whole operation.
    expect(fake.db.update.mock.invocationCallOrder[0]).toBeLessThan(
      fake.db.select.mock.invocationCallOrder[0]
    );
    expect(mockGetDb).not.toHaveBeenCalled();
  });

  it("preserves getDb() default behavior when no executor is supplied", async () => {
    const { identity } = seedRunningClaim();
    mockGetDb.mockClear();

    const result = await completeImageRenderClaimWithResult(
      completionParams(identity)
    );

    expect(result.completed).toBe(true);
    expect(mockGetDb).toHaveBeenCalled();
  });

  it("sanitizes executor errors without leaking raw error text", async () => {
    seedRunningClaim();
    const brokenExecutor = {
      select: (() => {
        throw new Error("should not be called");
      }) as unknown as ImageRenderClaimDbExecutor["select"],
      update: (() => {
        throw new Error("tx aborted: deadlock found");
      }) as unknown as ImageRenderClaimDbExecutor["update"],
    };

    await expect(
      completeImageRenderClaimWithResult({
        ...completionParams(deriveAttempt()),
        executor: brokenExecutor,
      })
    ).rejects.toThrow(/Image render claim completion failed/);
    await expect(
      completeImageRenderClaimWithResult({
        ...completionParams(deriveAttempt()),
        executor: brokenExecutor,
      })
    ).rejects.not.toThrow(/deadlock/);
  });
});

describe("deduction identity hardening (B2B-2A correction)", () => {
  let state: FakeDbState;

  function seedRunningClaim(overrides: Record<string, unknown> = {}) {
    const now = new Date("2026-05-01T00:00:00.000Z");
    const identity = deriveAttempt();
    const row: Record<string, unknown> = {
      id: state.rows.length + 1,
      userId: 7,
      contentPostId: 13,
      activeClaimKey: "active:7:post:13:image",
      ownerToken: makeOwnerToken(1),
      status: "running",
      leaseExpiresAt: FUTURE_LEASE,
      createdAt: now,
      updatedAt: now,
      requestAttemptKey: identity.requestAttemptKey,
      intentFingerprint: identity.intentFingerprint,
      deductionKey: identity.deductionKey,
      deductionRecorded: false,
      generatedImageId: null,
      resultImageUrl: null,
      resultProvider: null,
      resultProviderJobId: null,
      resultCreditsCharged: null,
      resultQualityTier: null,
      resultQualityLabel: null,
      resultIsDraft: null,
      completedAt: null,
      ...overrides,
    };
    state.rows.push(row);
    return { row, identity };
  }

  function completionParams(identity: ReturnType<typeof deriveAttempt>) {
    return {
      claimId: 1,
      ownerToken: makeOwnerToken(1),
      userId: 7,
      contentPostId: 13,
      requestAttemptKey: identity.requestAttemptKey,
      intentFingerprint: identity.intentFingerprint,
      deductionKey: identity.deductionKey,
      result: makeResult(),
    };
  }

  beforeEach(() => {
    const fake = createFakeDb();
    state = fake.state;
    mockGetDb.mockReturnValue(fake.db);
  });

  it("completes successfully with the correctly derived deductionKey", async () => {
    const { identity } = seedRunningClaim();

    const result = await completeImageRenderClaimWithResult(
      completionParams(identity)
    );

    expect(result.completed).toBe(true);
    expect(state.rows[0].status).toBe("completed");
  });

  it("rejects a malformed deductionKey before any mutation", async () => {
    const { identity } = seedRunningClaim();
    const fakeDb = mockGetDb();
    const updateSpy = fakeDb.update as ReturnType<typeof vi.fn>;

    await expect(
      completeImageRenderClaimWithResult({
        ...completionParams(identity),
        deductionKey: "",
      })
    ).rejects.toThrow(/Invalid deductionKey/);
    await expect(
      completeImageRenderClaimWithResult({
        ...completionParams(identity),
        deductionKey: "x".repeat(192),
      })
    ).rejects.toThrow(/Invalid deductionKey/);

    expect(updateSpy).not.toHaveBeenCalled();
    expect(state.rows[0].status).toBe("running");
  });

  it("rejects a valid-format but incorrectly derived deductionKey before mutation", async () => {
    const { identity } = seedRunningClaim();
    const fakeDb = mockGetDb();
    const updateSpy = fakeDb.update as ReturnType<typeof vi.fn>;
    // Format-valid, derived from a DIFFERENT attempt key.
    const foreign = deriveAttempt(7, 13, "attempt-token-2");

    await expect(
      completeImageRenderClaimWithResult({
        ...completionParams(identity),
        deductionKey: foreign.deductionKey,
      })
    ).rejects.toThrow(/does not match the derived attempt identity/);

    expect(updateSpy).not.toHaveBeenCalled();
    expect(state.rows[0].status).toBe("running");
  });

  it("prevents completion when the persisted deductionKey is NULL", async () => {
    const { identity } = seedRunningClaim({ deductionKey: null });

    const result = await completeImageRenderClaimWithResult(
      completionParams(identity)
    );

    expect(result).toEqual({ completed: false, reason: "identity_mismatch" });
    expect(state.rows[0].status).toBe("running");
    expect(state.rows[0].generatedImageId).toBeNull();
  });

  it("prevents completion when the persisted deductionKey is mismatched", async () => {
    const { identity } = seedRunningClaim({
      deductionKey: `img-deduction:${"b".repeat(64)}`,
    });

    const result = await completeImageRenderClaimWithResult(
      completionParams(identity)
    );

    expect(result).toEqual({ completed: false, reason: "identity_mismatch" });
    expect(state.rows[0].status).toBe("running");
  });

  it("classifies a zero-row reread with mismatched persisted deductionKey as identity_mismatch", async () => {
    const { identity } = seedRunningClaim();
    // Complete once legitimately, then corrupt the persisted deduction key and
    // retry with the (correctly derived) original key.
    const first = await completeImageRenderClaimWithResult(
      completionParams(identity)
    );
    expect(first.completed).toBe(true);

    state.rows[0].deductionKey = `img-deduction:${"c".repeat(64)}`;
    const retry = await completeImageRenderClaimWithResult(
      completionParams(identity)
    );

    expect(retry).toEqual({ completed: false, reason: "identity_mismatch" });
  });

  it("never classifies a mismatched persisted deductionKey as idempotent success", async () => {
    const { identity } = seedRunningClaim();
    const first = await completeImageRenderClaimWithResult(
      completionParams(identity)
    );
    expect(first.completed).toBe(true);

    // Snapshot still matches fully, but the persisted deduction key drifted:
    // must fail closed as identity_mismatch, never already_completed_with_same_result.
    state.rows[0].deductionKey = `img-deduction:${"d".repeat(64)}`;
    const retry = await completeImageRenderClaimWithResult(
      completionParams(identity)
    );

    expect(retry).toEqual({ completed: false, reason: "identity_mismatch" });
    expect(retry).not.toEqual({
      completed: false,
      reason: "already_completed_with_same_result",
    });
  });

  it("leaves deductionRecorded unchanged by completion", async () => {
    const { identity } = seedRunningClaim({ deductionRecorded: true });

    const result = await completeImageRenderClaimWithResult(
      completionParams(identity)
    );

    expect(result.completed).toBe(true);
    expect(state.rows[0].deductionRecorded).toBe(true);
  });

  it("leaves deductionRecorded false when it was never recorded", async () => {
    const { identity } = seedRunningClaim({ deductionRecorded: false });

    const result = await completeImageRenderClaimWithResult(
      completionParams(identity)
    );

    expect(result.completed).toBe(true);
    expect(state.rows[0].deductionRecorded).toBe(false);
  });
});

describe("linked-result validation hardening (B2B-2A correction)", () => {
  let state: FakeDbState;

  function seedCompletedClaim(overrides: Record<string, unknown> = {}) {
    const now = new Date("2026-05-01T00:00:00.000Z");
    const identity = deriveAttempt();
    const row: Record<string, unknown> = {
      id: state.rows.length + 1,
      userId: 7,
      contentPostId: 13,
      activeClaimKey: null,
      ownerToken: makeOwnerToken(1),
      status: "completed",
      leaseExpiresAt: FUTURE_LEASE,
      createdAt: now,
      updatedAt: now,
      requestAttemptKey: identity.requestAttemptKey,
      intentFingerprint: identity.intentFingerprint,
      deductionKey: identity.deductionKey,
      deductionRecorded: true,
      generatedImageId: 5000,
      resultImageUrl: makeResult().imageUrl,
      resultProvider: "v2",
      resultProviderJobId: "premium-v2-123",
      resultCreditsCharged: 12,
      resultQualityTier: "premium",
      resultQualityLabel: "Premium Marketing Leaflet",
      resultIsDraft: false,
      completedAt: RESULT_COMPLETED_AT,
      ...overrides,
    };
    state.rows.push(row);
    return { row, identity };
  }

  function seedGeneratedImage(overrides: Record<string, unknown> = {}) {
    const row: Record<string, unknown> = {
      id: 5000,
      userId: 7,
      contentPostId: 13,
      url: makeResult().imageUrl,
      status: "completed",
      __table: "generated_images",
      ...overrides,
    };
    state.rows.push(row);
    return row;
  }

  function lookupParams(identity: ReturnType<typeof deriveAttempt>) {
    return {
      userId: 7,
      contentPostId: 13,
      requestAttemptKey: identity.requestAttemptKey,
      intentFingerprint: identity.intentFingerprint,
    };
  }

  beforeEach(() => {
    const fake = createFakeDb();
    state = fake.state;
    mockGetDb.mockReturnValue(fake.db);
  });

  it("replays a completed linked image with matching URL", async () => {
    const { identity } = seedCompletedClaim();
    seedGeneratedImage({ status: "completed", url: makeResult().imageUrl });

    const result = await getCompletedImageRenderResult(lookupParams(identity));

    expect(result.replayable).toBe(true);
    if (result.replayable) {
      expect(result.result.generatedImageId).toBe(5000);
      expect(result.result.imageUrl).toBe(makeResult().imageUrl);
    }
  });

  it("rejects a pending linked image", async () => {
    const { identity } = seedCompletedClaim();
    seedGeneratedImage({ status: "pending" });

    const result = await getCompletedImageRenderResult(lookupParams(identity));

    expect(result).toEqual({
      replayable: false,
      reason: "linked_result_missing_or_mismatched",
    });
  });

  it("rejects a failed linked image", async () => {
    const { identity } = seedCompletedClaim();
    seedGeneratedImage({ status: "failed" });

    const result = await getCompletedImageRenderResult(lookupParams(identity));

    expect(result).toEqual({
      replayable: false,
      reason: "linked_result_missing_or_mismatched",
    });
  });

  it("rejects a linked image whose URL differs from the snapshot", async () => {
    const { identity } = seedCompletedClaim();
    seedGeneratedImage({ url: "/generated/images/7/rewritten-later.png" });

    const result = await getCompletedImageRenderResult(lookupParams(identity));

    expect(result).toEqual({
      replayable: false,
      reason: "linked_result_missing_or_mismatched",
    });
  });

  it("requires the exact linked ID and never falls back to a newer row", async () => {
    const { identity } = seedCompletedClaim();
    // Only a newer, fully-valid row exists; the linked id 5000 is absent.
    seedGeneratedImage({ id: 5001 });

    const result = await getCompletedImageRenderResult(lookupParams(identity));

    expect(result).toEqual({
      replayable: false,
      reason: "linked_result_missing_or_mismatched",
    });
  });

  it("rejects a linked row owned by a different user", async () => {
    const { identity } = seedCompletedClaim();
    seedGeneratedImage({ userId: 8 });

    const result = await getCompletedImageRenderResult(lookupParams(identity));

    expect(result).toEqual({
      replayable: false,
      reason: "linked_result_missing_or_mismatched",
    });
  });

  it("rejects a linked row attached to a different content post", async () => {
    const { identity } = seedCompletedClaim();
    seedGeneratedImage({ contentPostId: 14 });

    const result = await getCompletedImageRenderResult(lookupParams(identity));

    expect(result).toEqual({
      replayable: false,
      reason: "linked_result_missing_or_mismatched",
    });
  });

  it("returns a projection with no full row and no internal identity fields", async () => {
    const { identity } = seedCompletedClaim();
    seedGeneratedImage({
      prompt: "raw prompt text",
      metadata: { secret: "internal" },
      providerJobId: "internal-job",
    });

    const result = await getCompletedImageRenderResult(lookupParams(identity));

    expect(result.replayable).toBe(true);
    if (result.replayable) {
      expect(Object.keys(result.result).sort()).toEqual([
        "completedAt",
        "creditsCharged",
        "generatedImageId",
        "imageUrl",
        "isDraft",
        "provider",
        "providerJobId",
        "qualityLabel",
        "qualityTier",
      ]);
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("raw prompt text");
      expect(serialized).not.toContain("internal-job");
      expect(serialized).not.toContain("secret");
      expect(serialized).not.toContain(identity.requestAttemptKey);
      expect(serialized).not.toContain(identity.intentFingerprint);
      expect(serialized).not.toContain(identity.deductionKey);
    }
  });
});
