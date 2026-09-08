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
  IMAGE_RENDER_OPERATION_KIND,
  type AcquireImageRenderClaimResult,
  type TransitionImageRenderClaimResult,
  type ImageRenderAttemptIdentityInput,
  type ImageRenderClaim,
} from "./image-render-claim";

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

  const valuesImpl = vi.fn(async (values: Record<string, unknown>) => {
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
    const now = new Date();
    const row = { id: nextId, createdAt: now, updatedAt: now, ...values };
    nextId += 1;
    state.rows.push(row);
    return [{ insertId: row.id }];
  });

  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn((cond: unknown) => ({
          limit: vi.fn(async (n: number) =>
            state.rows.filter((row) => matchesCondition(cond, row)).slice(0, n)
          ),
        })),
      })),
    })),
    insert: vi.fn(() => ({ values: valuesImpl })),
    update: vi.fn(() => ({
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
    for (const key of [
      identity.requestAttemptKey,
      identity.intentFingerprint,
      identity.deductionKey,
    ]) {
      expect(key).not.toContain("super secret refinement text 123");
      expect(key).not.toContain("confidential guidance text 456");
      expect(key.toLowerCase()).not.toContain("secret");
      expect(key.toLowerCase()).not.toContain("confidential");
    }
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
