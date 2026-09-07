import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  buildActiveImageRenderClaimKey,
  acquireImageRenderClaim,
  completeImageRenderClaim,
  failImageRenderClaim,
  getActiveImageRenderClaim,
  type AcquireImageRenderClaimResult,
  type TransitionImageRenderClaimResult,
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
