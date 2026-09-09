import { describe, it, expect, vi } from "vitest";
import {
  classifyImageRenderAttempt,
  coordinateImageRenderAttempt,
  type ImageRenderClaimCoordinatorDeps,
  type ImageRenderCoordinatorInput,
  type ImageRenderCoordinatorResult,
} from "./image-render-claim-coordinator";
import {
  deriveImageRenderAttemptIdentity,
  type ImageRenderAttemptIdentityInput,
  type ImageRenderAttemptLookup,
  type ImageRenderClaim,
} from "./image-render-claim";

// ─── Deterministic injected fakes ───
//
// No database, sleeps, providers, rendering, billing, or environment changes.
// The coordinator's three dependency operations are plain vi.fn fakes whose
// return values are scripted per test. Array scripts are consumed one entry
// per call (for race re-reads); a rejected promise script surfaces as a
// thrown dependency error, which the coordinator must convert into
// claim_subsystem_unavailable.

const USER_A = 11;
const USER_B = 12;
const POST_A = 22;
const POST_B = 33;
const TOKEN_A = "client-token-alpha-0001";
const OWNER_TOKEN = "owner-token-abc123";

const INTENT = {
  regenerate: false,
  forceRegenerate: false,
  refinementInstruction: null,
  creativeGuidance: null,
  strongerBrandFit: false,
  provider: "v2",
  templateId: "auto",
  brandColors: ["#FF0000", "#00FF00"],
  creativeType: "leaflet",
  allowNoLogo: false,
} satisfies Omit<ImageRenderAttemptIdentityInput, "clientAttemptId">;

function fullAttempt(
  overrides: Partial<ImageRenderAttemptIdentityInput> = {}
): ImageRenderAttemptIdentityInput {
  return { ...INTENT, clientAttemptId: TOKEN_A, ...overrides };
}

function makeInput(
  overrides: Partial<ImageRenderCoordinatorInput> = {}
): ImageRenderCoordinatorInput {
  return {
    userId: USER_A,
    contentPostId: POST_A,
    clientAttemptId: TOKEN_A,
    intent: { ...INTENT },
    ownerToken: OWNER_TOKEN,
    leaseExpiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  };
}

function expectedIdentityFor(input: ImageRenderCoordinatorInput) {
  return deriveImageRenderAttemptIdentity({
    userId: input.userId,
    contentPostId: input.contentPostId,
    attempt: { ...input.intent, clientAttemptId: input.clientAttemptId },
  });
}

function makeLookup(
  input: ImageRenderCoordinatorInput,
  overrides: Partial<ImageRenderAttemptLookup> = {}
): ImageRenderAttemptLookup {
  const identity = expectedIdentityFor(input);
  return {
    found: true,
    claimId: 7,
    userId: input.userId,
    contentPostId: input.contentPostId,
    status: "running",
    intentFingerprint: identity.intentFingerprint,
    intentComparison: "match",
    deductionKey: identity.deductionKey,
    deductionRecorded: false,
    activeClaimKeyPresent: true,
    leaseState: "active",
    ...overrides,
  };
}

function makeClaim(
  input: ImageRenderCoordinatorInput,
  overrides: Partial<ImageRenderClaim> = {}
): ImageRenderClaim {
  const identity = expectedIdentityFor(input);
  return {
    id: 7,
    userId: input.userId,
    contentPostId: input.contentPostId,
    activeClaimKey: `active:${input.userId}:post:${input.contentPostId}:image`,
    ownerToken: input.ownerToken,
    status: "running",
    leaseExpiresAt: input.leaseExpiresAt,
    createdAt: new Date(),
    updatedAt: new Date(),
    requestAttemptKey: identity.requestAttemptKey,
    intentFingerprint: identity.intentFingerprint,
    deductionKey: identity.deductionKey,
    deductionRecorded: false,
    ...overrides,
  } as ImageRenderClaim;
}

interface AcquireArgs {
  userId: number;
  contentPostId: number;
  ownerToken: string;
  leaseExpiresAt: Date;
  identity: ImageRenderAttemptIdentityInput;
}

interface RearmArgs {
  userId: number;
  contentPostId: number;
  requestAttemptKey: string;
  intentFingerprint: string;
  ownerToken: string;
  leaseExpiresAt: Date;
}

function makeClaimForAcquireArgs(args: AcquireArgs): ImageRenderClaim {
  const identity = deriveImageRenderAttemptIdentity({
    userId: args.userId,
    contentPostId: args.contentPostId,
    attempt: args.identity,
  });
  return {
    id: 7,
    userId: args.userId,
    contentPostId: args.contentPostId,
    activeClaimKey: `active:${args.userId}:post:${args.contentPostId}:image`,
    ownerToken: args.ownerToken,
    status: "running",
    leaseExpiresAt: args.leaseExpiresAt,
    createdAt: new Date(),
    updatedAt: new Date(),
    requestAttemptKey: identity.requestAttemptKey,
    intentFingerprint: identity.intentFingerprint,
    deductionKey: identity.deductionKey,
    deductionRecorded: false,
  } as ImageRenderClaim;
}

function makeClaimForRearmArgs(args: RearmArgs): ImageRenderClaim {
  return {
    id: 7,
    userId: args.userId,
    contentPostId: args.contentPostId,
    activeClaimKey: `active:${args.userId}:post:${args.contentPostId}:image`,
    ownerToken: args.ownerToken,
    status: "running",
    leaseExpiresAt: args.leaseExpiresAt,
    createdAt: new Date(),
    updatedAt: new Date(),
    requestAttemptKey: args.requestAttemptKey,
    intentFingerprint: args.intentFingerprint,
    deductionKey: `img-deduction:${args.requestAttemptKey}`,
    deductionRecorded: false,
  } as ImageRenderClaim;
}

interface FakeDeps {
  deps: ImageRenderClaimCoordinatorDeps;
  lookupAttempt: ReturnType<typeof vi.fn>;
  acquireClaim: ReturnType<typeof vi.fn>;
  rearmFailedClaim: ReturnType<typeof vi.fn>;
}

function makeDeps(overrides: {
  lookup?: unknown;
  acquire?: unknown;
  rearm?: unknown;
} = {}): FakeDeps {
  const consume = (script: unknown, fallback: () => unknown): unknown => {
    if (Array.isArray(script)) {
      const entry = script.length > 0 ? script.shift() : undefined;
      return entry !== undefined ? entry : fallback();
    }
    return script !== undefined ? script : fallback();
  };

  const lookupAttempt = vi.fn(
    async (): Promise<unknown> => consume(overrides.lookup, () => ({ found: false }))
  );
  const acquireClaim = vi.fn(
    async (args: AcquireArgs): Promise<unknown> =>
      consume(overrides.acquire, () => ({
        acquired: true,
        claim: makeClaimForAcquireArgs(args),
      }))
  );
  const rearmFailedClaim = vi.fn(
    async (args: RearmArgs): Promise<unknown> =>
      consume(overrides.rearm, () => ({
        rearmed: true,
        claim: makeClaimForRearmArgs(args),
      }))
  );
  return {
    deps: {
      lookupAttempt: lookupAttempt as ImageRenderClaimCoordinatorDeps["lookupAttempt"],
      acquireClaim: acquireClaim as ImageRenderClaimCoordinatorDeps["acquireClaim"],
      rearmFailedClaim:
        rearmFailedClaim as ImageRenderClaimCoordinatorDeps["rearmFailedClaim"],
    },
    lookupAttempt,
    acquireClaim,
    rearmFailedClaim,
  };
}

function expectBlockedWithNoSensitiveData(
  result: ImageRenderCoordinatorResult,
  forbidden: string[]
) {
  expect(result.outcome).not.toBe("acquired");
  expect(result.outcome).not.toBe("rearmed");
  expect("owner" in result).toBe(false);
  const serialized = JSON.stringify(result);
  for (const secret of forbidden) {
    expect(serialized).not.toContain(secret);
  }
}

describe("classifyImageRenderAttempt — pure decision precedence", () => {
  const base = makeLookup(makeInput());

  it("absent attempt => acquire", () => {
    expect(classifyImageRenderAttempt({ found: false })).toEqual({
      kind: "acquire",
    });
  });

  it("running with active lease and matching intent => already_running", () => {
    expect(classifyImageRenderAttempt(base)).toEqual({
      kind: "blocked",
      outcome: "already_running",
    });
  });

  it("running with stale lease and matching intent => stale_blocked", () => {
    expect(
      classifyImageRenderAttempt({ ...base, leaseState: "stale" })
    ).toEqual({ kind: "blocked", outcome: "stale_blocked" });
  });

  it("intent conflict outranks running status", () => {
    expect(
      classifyImageRenderAttempt({ ...base, intentComparison: "conflict" })
    ).toEqual({ kind: "blocked", outcome: "intent_conflict" });
  });

  it("unknown/null legacy intent => legacy_attempt_blocked", () => {
    expect(
      classifyImageRenderAttempt({
        ...base,
        intentComparison: "unknown",
        intentFingerprint: null,
      })
    ).toEqual({ kind: "blocked", outcome: "legacy_attempt_blocked" });
  });

  it("completed with matching intent => completed_replay_required", () => {
    expect(
      classifyImageRenderAttempt({
        ...base,
        status: "completed",
        activeClaimKeyPresent: false,
        leaseState: "none",
      })
    ).toEqual({ kind: "blocked", outcome: "completed_replay_required" });
  });

  it("completed with conflicting intent => intent_conflict (precedence over completed)", () => {
    expect(
      classifyImageRenderAttempt({
        ...base,
        status: "completed",
        activeClaimKeyPresent: false,
        leaseState: "none",
        intentComparison: "conflict",
      })
    ).toEqual({ kind: "blocked", outcome: "intent_conflict" });
  });

  it("completed with unknown legacy intent => legacy_attempt_blocked", () => {
    expect(
      classifyImageRenderAttempt({
        ...base,
        status: "completed",
        activeClaimKeyPresent: false,
        leaseState: "none",
        intentComparison: "unknown",
        intentFingerprint: null,
      })
    ).toEqual({ kind: "blocked", outcome: "legacy_attempt_blocked" });
  });

  it("failed with matching intent and deductionRecorded=false => rearm", () => {
    expect(
      classifyImageRenderAttempt({
        ...base,
        status: "failed",
        activeClaimKeyPresent: false,
        leaseState: "none",
      })
    ).toEqual({ kind: "rearm" });
  });

  it("failed with deductionRecorded=true => ambiguous_deduction_blocked (never rearm)", () => {
    expect(
      classifyImageRenderAttempt({
        ...base,
        status: "failed",
        activeClaimKeyPresent: false,
        leaseState: "none",
        deductionRecorded: true,
      })
    ).toEqual({ kind: "blocked", outcome: "ambiguous_deduction_blocked" });
  });

  it("failed with conflicting intent => intent_conflict (precedence over rearm)", () => {
    expect(
      classifyImageRenderAttempt({
        ...base,
        status: "failed",
        activeClaimKeyPresent: false,
        leaseState: "none",
        intentComparison: "conflict",
      })
    ).toEqual({ kind: "blocked", outcome: "intent_conflict" });
  });
});

describe("coordinateImageRenderAttempt — input validation before dependencies", () => {
  it.each([
    ["empty", ""],
    ["whitespace-containing", "bad token"],
    ["slash-containing", "bad/token"],
    ["colon-containing", "bad:token"],
    ["invalid characters", "bad[token]"],
    ["oversized", "a".repeat(65)],
  ])(
    "rejects malformed clientAttemptId (%s) before any dependency call",
    async (_label, token) => {
      const { deps, lookupAttempt, acquireClaim, rearmFailedClaim } = makeDeps();
      await expect(
        coordinateImageRenderAttempt(makeInput({ clientAttemptId: token }), deps)
      ).rejects.toThrow();
      expect(lookupAttempt).not.toHaveBeenCalled();
      expect(acquireClaim).not.toHaveBeenCalled();
      expect(rearmFailedClaim).not.toHaveBeenCalled();
    }
  );

  it.each([[0], [-1], [Number.NaN], [1.5], [Number.MAX_SAFE_INTEGER + 1]])(
    "rejects invalid userId (%s) before any dependency call",
    async (userId) => {
      const { deps, lookupAttempt } = makeDeps();
      await expect(
        coordinateImageRenderAttempt(makeInput({ userId }), deps)
      ).rejects.toThrow();
      expect(lookupAttempt).not.toHaveBeenCalled();
    }
  );

  it.each([[0], [-3], [Number.NaN]])(
    "rejects invalid contentPostId (%s) before any dependency call",
    async (contentPostId) => {
      const { deps, lookupAttempt } = makeDeps();
      await expect(
        coordinateImageRenderAttempt(makeInput({ contentPostId }), deps)
      ).rejects.toThrow();
      expect(lookupAttempt).not.toHaveBeenCalled();
    }
  );

  it("rejects empty and oversized ownerToken before any dependency call", async () => {
    for (const ownerToken of ["", "o".repeat(65)]) {
      const { deps, lookupAttempt } = makeDeps();
      await expect(
        coordinateImageRenderAttempt(makeInput({ ownerToken }), deps)
      ).rejects.toThrow();
      expect(lookupAttempt).not.toHaveBeenCalled();
    }
  });

  it("rejects invalid lease expiry before any dependency call", async () => {
    const { deps, lookupAttempt } = makeDeps();
    await expect(
      coordinateImageRenderAttempt(
        makeInput({ leaseExpiresAt: new Date(Number.NaN) }),
        deps
      )
    ).rejects.toThrow();
    expect(lookupAttempt).not.toHaveBeenCalled();
  });
});

describe("coordinateImageRenderAttempt — B1 identity delegation", () => {
  it("delegates derivation to the B1 helper: lookup receives the derived key and fingerprint", async () => {
    const input = makeInput();
    const identity = expectedIdentityFor(input);
    const { deps, lookupAttempt } = makeDeps();
    await coordinateImageRenderAttempt(input, deps);
    expect(lookupAttempt).toHaveBeenCalledTimes(1);
    expect(lookupAttempt).toHaveBeenCalledWith({
      requestAttemptKey: identity.requestAttemptKey,
      expectedIntentFingerprint: identity.intentFingerprint,
    });
    expect(identity.requestAttemptKey).toMatch(/^[0-9a-f]{64}$/);
    expect(identity.intentFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(identity.deductionKey).toBe(
      `img-deduction:${identity.requestAttemptKey}`
    );
  });

  it("passes the complete ten-field attempt identity to acquisition", async () => {
    const input = makeInput();
    const identity = expectedIdentityFor(input);
    const { deps, acquireClaim } = makeDeps();
    const result = await coordinateImageRenderAttempt(input, deps);
    expect(result.outcome).toBe("acquired");
    expect(acquireClaim).toHaveBeenCalledTimes(1);
    const args = acquireClaim.mock.calls[0][0] as AcquireArgs;
    expect(args.userId).toBe(USER_A);
    expect(args.contentPostId).toBe(POST_A);
    expect(args.ownerToken).toBe(OWNER_TOKEN);
    expect(args.leaseExpiresAt).toBe(input.leaseExpiresAt);
    expect(args.identity).toEqual(fullAttempt());
    expect(args.identity.clientAttemptId).toBe(TOKEN_A);
    expect(identity.requestAttemptKey).toBe(
      deriveImageRenderAttemptIdentity({
        userId: USER_A,
        contentPostId: POST_A,
        attempt: args.identity,
      }).requestAttemptKey
    );
  });

  it.each([
    ["regenerate", { regenerate: true }],
    ["forceRegenerate", { forceRegenerate: true }],
    ["refinementInstruction", { refinementInstruction: "make it bolder" }],
    ["creativeGuidance", { creativeGuidance: "use more contrast" }],
    ["strongerBrandFit", { strongerBrandFit: true }],
    ["provider", { provider: "openai" }],
    ["templateId", { templateId: "template-9" }],
    ["brandColors", { brandColors: ["#0000FF"] }],
    ["creativeType", { creativeType: "poster" }],
    ["allowNoLogo", { allowNoLogo: true }],
  ])(
    "changing material intent field %s changes the fingerprint delegated to lookup",
    async (_field, intentOverride) => {
      const input = makeInput({
        intent: { ...INTENT, ...intentOverride },
      });
      const identity = expectedIdentityFor(input);
      const { deps, lookupAttempt } = makeDeps();
      await coordinateImageRenderAttempt(input, deps);
      expect(lookupAttempt).toHaveBeenCalledWith({
        requestAttemptKey: identity.requestAttemptKey,
        expectedIntentFingerprint: identity.intentFingerprint,
      });
    }
  );

  it("requestAttemptKey is invariant to intent changes but varies with user, post, and token", () => {
    const base = expectedIdentityFor(makeInput());
    for (const intentOverride of [
      { regenerate: true },
      { refinementInstruction: "different text entirely" },
      { brandColors: ["#123456", "#ABCDEF"] },
      { allowNoLogo: true, creativeType: "poster", provider: "openai" },
    ]) {
      const changed = expectedIdentityFor(
        makeInput({ intent: { ...INTENT, ...intentOverride } })
      );
      expect(changed.requestAttemptKey).toBe(base.requestAttemptKey);
      expect(changed.intentFingerprint).not.toBe(base.intentFingerprint);
    }
    expect(
      expectedIdentityFor(makeInput({ userId: USER_B })).requestAttemptKey
    ).not.toBe(base.requestAttemptKey);
    expect(
      expectedIdentityFor(makeInput({ contentPostId: POST_B })).requestAttemptKey
    ).not.toBe(base.requestAttemptKey);
    expect(
      expectedIdentityFor(
        makeInput({ clientAttemptId: "client-token-beta-0002" })
      ).requestAttemptKey
    ).not.toBe(base.requestAttemptKey);
  });

  it("same token under another user derives a different key and cannot inspect the first user's row", async () => {
    const inputB = makeInput({ userId: USER_B });
    const identityB = expectedIdentityFor(inputB);
    const { deps, lookupAttempt, acquireClaim } = makeDeps();
    await coordinateImageRenderAttempt(inputB, deps);
    expect(lookupAttempt).toHaveBeenCalledWith({
      requestAttemptKey: identityB.requestAttemptKey,
      expectedIntentFingerprint: identityB.intentFingerprint,
    });
    expect(acquireClaim).toHaveBeenCalledTimes(1);
    expect((acquireClaim.mock.calls[0][0] as AcquireArgs).userId).toBe(USER_B);
  });

  it("same token for another content post derives a different key", async () => {
    const inputB = makeInput({ contentPostId: POST_B });
    const identityB = expectedIdentityFor(inputB);
    const { deps, lookupAttempt } = makeDeps();
    await coordinateImageRenderAttempt(inputB, deps);
    expect(lookupAttempt).toHaveBeenCalledWith({
      requestAttemptKey: identityB.requestAttemptKey,
      expectedIntentFingerprint: identityB.intentFingerprint,
    });
  });

  it("a found row belonging to a different user fails closed instead of leaking classification", async () => {
    const input = makeInput();
    const { deps, acquireClaim } = makeDeps({
      lookup: makeLookup(input, { userId: USER_B }),
    });
    const result = await coordinateImageRenderAttempt(input, deps);
    expect(result.outcome).toBe("claim_subsystem_unavailable");
    expect(acquireClaim).not.toHaveBeenCalled();
  });
});

describe("coordinateImageRenderAttempt — decision table states", () => {
  it("state 1: absent attempt, acquisition succeeds => acquired with owner context", async () => {
    const input = makeInput();
    const identity = expectedIdentityFor(input);
    const { deps, lookupAttempt, acquireClaim, rearmFailedClaim } = makeDeps();
    const result = await coordinateImageRenderAttempt(input, deps);
    expect(result.outcome).toBe("acquired");
    if (result.outcome !== "acquired") throw new Error("unreachable");
    expect(result.owner.claimId).toBe(7);
    expect(result.owner.ownerToken).toBe(OWNER_TOKEN);
    expect(result.owner.requestAttemptKey).toBe(identity.requestAttemptKey);
    expect(result.owner.intentFingerprint).toBe(identity.intentFingerprint);
    expect(result.owner.deductionKey).toBe(identity.deductionKey);
    expect(Object.isFrozen(result.owner)).toBe(true);
    expect(lookupAttempt).toHaveBeenCalledTimes(1);
    expect(acquireClaim).toHaveBeenCalledTimes(1);
    expect(rearmFailedClaim).not.toHaveBeenCalled();
  });

  it("state 2: same key, same intent, running, active lease => already_running, no mutation", async () => {
    const input = makeInput();
    const { deps, lookupAttempt, acquireClaim, rearmFailedClaim } = makeDeps({
      lookup: makeLookup(input, { status: "running", leaseState: "active" }),
    });
    const result = await coordinateImageRenderAttempt(input, deps);
    expect(result.outcome).toBe("already_running");
    expect(lookupAttempt).toHaveBeenCalledTimes(1);
    expect(acquireClaim).not.toHaveBeenCalled();
    expect(rearmFailedClaim).not.toHaveBeenCalled();
  });

  it("state 3: same key, same intent, running, stale lease => stale_blocked, no mutation, no takeover", async () => {
    const input = makeInput();
    const { deps, lookupAttempt, acquireClaim, rearmFailedClaim } = makeDeps({
      lookup: makeLookup(input, { status: "running", leaseState: "stale" }),
    });
    const result = await coordinateImageRenderAttempt(input, deps);
    expect(result.outcome).toBe("stale_blocked");
    expect(lookupAttempt).toHaveBeenCalledTimes(1);
    expect(acquireClaim).not.toHaveBeenCalled();
    expect(rearmFailedClaim).not.toHaveBeenCalled();
  });

  it("state 4: same key, different intent => intent_conflict, no mutation", async () => {
    const input = makeInput();
    const { deps, lookupAttempt, acquireClaim, rearmFailedClaim } = makeDeps({
      lookup: makeLookup(input, { intentComparison: "conflict" }),
    });
    const result = await coordinateImageRenderAttempt(input, deps);
    expect(result.outcome).toBe("intent_conflict");
    expect(lookupAttempt).toHaveBeenCalledTimes(1);
    expect(acquireClaim).not.toHaveBeenCalled();
    expect(rearmFailedClaim).not.toHaveBeenCalled();
  });

  it("state 5: same key with unknown/null legacy intent => legacy_attempt_blocked, no mutation", async () => {
    const input = makeInput();
    const { deps, lookupAttempt, acquireClaim, rearmFailedClaim } = makeDeps({
      lookup: makeLookup(input, {
        intentComparison: "unknown",
        intentFingerprint: null,
      }),
    });
    const result = await coordinateImageRenderAttempt(input, deps);
    expect(result.outcome).toBe("legacy_attempt_blocked");
    expect(lookupAttempt).toHaveBeenCalledTimes(1);
    expect(acquireClaim).not.toHaveBeenCalled();
    expect(rearmFailedClaim).not.toHaveBeenCalled();
  });

  it("state 6: failed, same intent, deductionRecorded=false => rearmed same row with preserved identity", async () => {
    const input = makeInput();
    const identity = expectedIdentityFor(input);
    const { deps, lookupAttempt, acquireClaim, rearmFailedClaim } = makeDeps({
      lookup: makeLookup(input, {
        status: "failed",
        activeClaimKeyPresent: false,
        leaseState: "none",
      }),
    });
    const result = await coordinateImageRenderAttempt(input, deps);
    expect(result.outcome).toBe("rearmed");
    if (result.outcome !== "rearmed") throw new Error("unreachable");
    expect(result.owner.claimId).toBe(7);
    expect(result.owner.requestAttemptKey).toBe(identity.requestAttemptKey);
    expect(result.owner.intentFingerprint).toBe(identity.intentFingerprint);
    expect(result.owner.deductionKey).toBe(identity.deductionKey);
    expect(rearmFailedClaim).toHaveBeenCalledTimes(1);
    expect(rearmFailedClaim).toHaveBeenCalledWith({
      userId: USER_A,
      contentPostId: POST_A,
      requestAttemptKey: identity.requestAttemptKey,
      intentFingerprint: identity.intentFingerprint,
      ownerToken: OWNER_TOKEN,
      leaseExpiresAt: input.leaseExpiresAt,
    });
    expect(lookupAttempt).toHaveBeenCalledTimes(1);
    expect(acquireClaim).not.toHaveBeenCalled();
  });

  it("state 7: failed with deductionRecorded=true => ambiguous_deduction_blocked, no rearm", async () => {
    const input = makeInput();
    const { deps, lookupAttempt, acquireClaim, rearmFailedClaim } = makeDeps({
      lookup: makeLookup(input, {
        status: "failed",
        activeClaimKeyPresent: false,
        leaseState: "none",
        deductionRecorded: true,
      }),
    });
    const result = await coordinateImageRenderAttempt(input, deps);
    expect(result.outcome).toBe("ambiguous_deduction_blocked");
    expect(lookupAttempt).toHaveBeenCalledTimes(1);
    expect(acquireClaim).not.toHaveBeenCalled();
    expect(rearmFailedClaim).not.toHaveBeenCalled();
  });

  it("state 8: completed, same intent => completed_replay_required, no acquire, no work authority", async () => {
    const input = makeInput();
    const { deps, lookupAttempt, acquireClaim, rearmFailedClaim } = makeDeps({
      lookup: makeLookup(input, {
        status: "completed",
        activeClaimKeyPresent: false,
        leaseState: "none",
      }),
    });
    const result = await coordinateImageRenderAttempt(input, deps);
    expect(result.outcome).toBe("completed_replay_required");
    expect(lookupAttempt).toHaveBeenCalledTimes(1);
    expect(acquireClaim).not.toHaveBeenCalled();
    expect(rearmFailedClaim).not.toHaveBeenCalled();
  });

  it("state 9: completed with conflicting intent => intent_conflict", async () => {
    const input = makeInput();
    const { deps } = makeDeps({
      lookup: makeLookup(input, {
        status: "completed",
        activeClaimKeyPresent: false,
        leaseState: "none",
        intentComparison: "conflict",
      }),
    });
    const result = await coordinateImageRenderAttempt(input, deps);
    expect(result.outcome).toBe("intent_conflict");
  });

  it("state 10a: acquisition conflict with active lease, no same-attempt row => active_post_conflict", async () => {
    const input = makeInput();
    const { deps, lookupAttempt, acquireClaim } = makeDeps({
      lookup: [
        { found: false },
        { found: false }, // race re-read: our attempt has no row; occupant is another attempt
      ],
      acquire: {
        acquired: false,
        existingClaim: makeClaim(input, { id: 99 }),
        reason: "active_claim_conflict",
      },
    });
    const result = await coordinateImageRenderAttempt(input, deps);
    expect(result.outcome).toBe("active_post_conflict");
    expect(acquireClaim).toHaveBeenCalledTimes(1);
    expect(lookupAttempt).toHaveBeenCalledTimes(2); // initial + exactly one re-read
  });

  it("state 10b: acquisition conflict with stale lease, no same-attempt row => stale_blocked (never takeover)", async () => {
    const input = makeInput();
    const { deps } = makeDeps({
      lookup: [{ found: false }, { found: false }],
      acquire: {
        acquired: false,
        existingClaim: makeClaim(input, { id: 99 }),
        reason: "stale_claim_conflict",
      },
    });
    const result = await coordinateImageRenderAttempt(input, deps);
    expect(result.outcome).toBe("stale_blocked");
  });

  it("state 11: legacy active claim with null requestAttemptKey keeps occupancy blocking (no takeover path exists)", async () => {
    const input = makeInput();
    const { deps } = makeDeps({
      lookup: [{ found: false }, { found: false }],
      acquire: {
        acquired: false,
        existingClaim: makeClaim(input, {
          id: 55,
          requestAttemptKey: null,
          intentFingerprint: null,
          deductionKey: null,
        }),
        reason: "stale_claim_conflict",
      },
    });
    const result = await coordinateImageRenderAttempt(input, deps);
    expect(result.outcome).toBe("stale_blocked");
    expect("owner" in result).toBe(false);
  });

  it("state 14: duplicate-key race with same-attempt row now running => already_running, never two owners", async () => {
    const input = makeInput();
    const { deps, lookupAttempt, acquireClaim } = makeDeps({
      lookup: [
        { found: false },
        makeLookup(input, { status: "running", leaseState: "active" }),
      ],
      acquire: {
        acquired: false,
        existingClaim: makeClaim(input),
        reason: "active_claim_conflict",
      },
    });
    const result = await coordinateImageRenderAttempt(input, deps);
    expect(result.outcome).toBe("already_running");
    expect("owner" in result).toBe(false);
    expect(lookupAttempt).toHaveBeenCalledTimes(2);
    expect(acquireClaim).toHaveBeenCalledTimes(1);
  });

  it("state 14b: duplicate-key race, re-read shows failed with deductionRecorded => ambiguous_deduction_blocked", async () => {
    const input = makeInput();
    const { deps } = makeDeps({
      lookup: [
        { found: false },
        makeLookup(input, {
          status: "failed",
          activeClaimKeyPresent: false,
          leaseState: "none",
          deductionRecorded: true,
        }),
      ],
      acquire: {
        acquired: false,
        existingClaim: makeClaim(input),
        reason: "active_claim_conflict",
      },
    });
    const result = await coordinateImageRenderAttempt(input, deps);
    expect(result.outcome).toBe("ambiguous_deduction_blocked");
  });

  it("state 15a: rearm race (not_failed), re-read shows running active => already_running", async () => {
    const input = makeInput();
    const { deps, lookupAttempt, rearmFailedClaim } = makeDeps({
      lookup: [
        makeLookup(input, {
          status: "failed",
          activeClaimKeyPresent: false,
          leaseState: "none",
        }),
        makeLookup(input, { status: "running", leaseState: "active" }),
      ],
      rearm: { rearmed: false, reason: "not_failed" },
    });
    const result = await coordinateImageRenderAttempt(input, deps);
    expect(result.outcome).toBe("already_running");
    expect(rearmFailedClaim).toHaveBeenCalledTimes(1);
    expect(lookupAttempt).toHaveBeenCalledTimes(2);
  });

  it("state 15b: rearm race (not_found), re-read finds nothing => claim_subsystem_unavailable (fail closed)", async () => {
    const input = makeInput();
    const { deps } = makeDeps({
      lookup: [
        makeLookup(input, {
          status: "failed",
          activeClaimKeyPresent: false,
          leaseState: "none",
        }),
        { found: false },
      ],
      rearm: { rearmed: false, reason: "not_found" },
    });
    const result = await coordinateImageRenderAttempt(input, deps);
    expect(result.outcome).toBe("claim_subsystem_unavailable");
  });

  it("state 15c: rearm race (not_found), re-read shows completed => completed_replay_required", async () => {
    const input = makeInput();
    const { deps } = makeDeps({
      lookup: [
        makeLookup(input, {
          status: "failed",
          activeClaimKeyPresent: false,
          leaseState: "none",
        }),
        makeLookup(input, {
          status: "completed",
          activeClaimKeyPresent: false,
          leaseState: "none",
        }),
      ],
      rearm: { rearmed: false, reason: "not_found" },
    });
    const result = await coordinateImageRenderAttempt(input, deps);
    expect(result.outcome).toBe("completed_replay_required");
  });

  it("state 15d: rearm active-key race => active_post_conflict, no extra re-read", async () => {
    const input = makeInput();
    const { deps, lookupAttempt, rearmFailedClaim } = makeDeps({
      lookup: makeLookup(input, {
        status: "failed",
        activeClaimKeyPresent: false,
        leaseState: "none",
      }),
      rearm: { rearmed: false, reason: "active_key_occupied" },
    });
    const result = await coordinateImageRenderAttempt(input, deps);
    expect(result.outcome).toBe("active_post_conflict");
    expect(rearmFailedClaim).toHaveBeenCalledTimes(1);
    expect(lookupAttempt).toHaveBeenCalledTimes(1);
  });

  it("state 15e: rearm returns deduction_recorded => ambiguous_deduction_blocked", async () => {
    const input = makeInput();
    const { deps, rearmFailedClaim } = makeDeps({
      lookup: makeLookup(input, {
        status: "failed",
        activeClaimKeyPresent: false,
        leaseState: "none",
      }),
      rearm: { rearmed: false, reason: "deduction_recorded" },
    });
    const result = await coordinateImageRenderAttempt(input, deps);
    expect(result.outcome).toBe("ambiguous_deduction_blocked");
    expect(rearmFailedClaim).toHaveBeenCalledTimes(1);
  });

  it("state 15f: rearm returns intent_conflict => intent_conflict", async () => {
    const input = makeInput();
    const { deps } = makeDeps({
      lookup: makeLookup(input, {
        status: "failed",
        activeClaimKeyPresent: false,
        leaseState: "none",
      }),
      rearm: { rearmed: false, reason: "intent_conflict" },
    });
    const result = await coordinateImageRenderAttempt(input, deps);
    expect(result.outcome).toBe("intent_conflict");
  });
});

describe("coordinateImageRenderAttempt — subsystem uncertainty fails closed", () => {
  it("lookup failure => claim_subsystem_unavailable, no mutation attempted", async () => {
    const { deps, lookupAttempt, acquireClaim, rearmFailedClaim } = makeDeps({
      lookup: Promise.reject(new Error("connection lost")),
    });
    const result = await coordinateImageRenderAttempt(makeInput(), deps);
    expect(result.outcome).toBe("claim_subsystem_unavailable");
    expect(lookupAttempt).toHaveBeenCalledTimes(1);
    expect(acquireClaim).not.toHaveBeenCalled();
    expect(rearmFailedClaim).not.toHaveBeenCalled();
  });

  it("acquire failure of unknown type => claim_subsystem_unavailable", async () => {
    const { deps, lookupAttempt } = makeDeps({
      acquire: Promise.reject(new Error("ER_DUP_ENTRY: something odd")),
    });
    const result = await coordinateImageRenderAttempt(makeInput(), deps);
    expect(result.outcome).toBe("claim_subsystem_unavailable");
    expect(lookupAttempt).toHaveBeenCalledTimes(1);
  });

  it("rearm failure of unknown type => claim_subsystem_unavailable", async () => {
    const input = makeInput();
    const { deps } = makeDeps({
      lookup: makeLookup(input, {
        status: "failed",
        activeClaimKeyPresent: false,
        leaseState: "none",
      }),
      rearm: Promise.reject(new Error("deadlock")),
    });
    const result = await coordinateImageRenderAttempt(input, deps);
    expect(result.outcome).toBe("claim_subsystem_unavailable");
  });

  it("malformed lookup result => claim_subsystem_unavailable", async () => {
    const { deps, acquireClaim } = makeDeps({
      lookup: { found: true, status: undefined },
    });
    const result = await coordinateImageRenderAttempt(makeInput(), deps);
    expect(result.outcome).toBe("claim_subsystem_unavailable");
    expect(acquireClaim).not.toHaveBeenCalled();
  });

  it("lookup row belonging to a different user => claim_subsystem_unavailable (integrity failure)", async () => {
    const input = makeInput();
    const { deps, acquireClaim } = makeDeps({
      lookup: makeLookup(input, { userId: USER_B }),
    });
    const result = await coordinateImageRenderAttempt(input, deps);
    expect(result.outcome).toBe("claim_subsystem_unavailable");
    expect(acquireClaim).not.toHaveBeenCalled();
  });

  it("malformed acquired claim (missing identity columns) => claim_subsystem_unavailable", async () => {
    const input = makeInput();
    const { deps } = makeDeps({
      acquire: {
        acquired: true,
        claim: makeClaim(input, { requestAttemptKey: null }),
      },
    });
    const result = await coordinateImageRenderAttempt(input, deps);
    expect(result.outcome).toBe("claim_subsystem_unavailable");
  });

  it("acquired claim for a different attempt key => claim_subsystem_unavailable", async () => {
    const input = makeInput();
    const { deps } = makeDeps({
      acquire: {
        acquired: true,
        claim: makeClaim(input, {
          requestAttemptKey: "f".repeat(64),
          intentFingerprint: "e".repeat(64),
          deductionKey: "img-deduction:zzz",
        }),
      },
    });
    const result = await coordinateImageRenderAttempt(input, deps);
    expect(result.outcome).toBe("claim_subsystem_unavailable");
  });

  it("unknown acquire conflict reason => claim_subsystem_unavailable", async () => {
    const input = makeInput();
    const { deps } = makeDeps({
      lookup: [{ found: false }, { found: false }],
      acquire: {
        acquired: false,
        existingClaim: makeClaim(input),
        reason: "something_unexpected",
      },
    });
    const result = await coordinateImageRenderAttempt(input, deps);
    expect(result.outcome).toBe("claim_subsystem_unavailable");
  });

  it("unknown rearm failure reason => claim_subsystem_unavailable", async () => {
    const input = makeInput();
    const { deps } = makeDeps({
      lookup: makeLookup(input, {
        status: "failed",
        activeClaimKeyPresent: false,
        leaseState: "none",
      }),
      rearm: { rearmed: false, reason: "mystery" },
    });
    const result = await coordinateImageRenderAttempt(input, deps);
    expect(result.outcome).toBe("claim_subsystem_unavailable");
  });
});

describe("coordinateImageRenderAttempt — security boundary of results", () => {
  const SENSITIVE_TEXT = ["make it bolder", "use more contrast"];

  function sensitiveInput(): ImageRenderCoordinatorInput {
    return makeInput({
      intent: {
        ...INTENT,
        refinementInstruction: "make it bolder",
        creativeGuidance: "use more contrast",
      },
    });
  }

  const scenarios: Array<{
    name: string;
    run: (
      input: ImageRenderCoordinatorInput
    ) => Promise<ImageRenderCoordinatorResult>;
  }> = [
    {
      name: "completed_replay_required",
      run: (input) =>
        coordinateImageRenderAttempt(
          input,
          makeDeps({
            lookup: makeLookup(input, {
              status: "completed",
              activeClaimKeyPresent: false,
              leaseState: "none",
            }),
          }).deps
        ),
    },
    {
      name: "already_running",
      run: (input) =>
        coordinateImageRenderAttempt(
          input,
          makeDeps({ lookup: makeLookup(input) }).deps
        ),
    },
    {
      name: "stale_blocked",
      run: (input) =>
        coordinateImageRenderAttempt(
          input,
          makeDeps({
            lookup: makeLookup(input, { leaseState: "stale" }),
          }).deps
        ),
    },
    {
      name: "intent_conflict",
      run: (input) =>
        coordinateImageRenderAttempt(
          input,
          makeDeps({
            lookup: makeLookup(input, { intentComparison: "conflict" }),
          }).deps
        ),
    },
    {
      name: "active_post_conflict",
      run: (input) =>
        coordinateImageRenderAttempt(
          input,
          makeDeps({
            lookup: [{ found: false }, { found: false }],
            acquire: {
              acquired: false,
              existingClaim: makeClaim(input),
              reason: "active_claim_conflict",
            },
          }).deps
        ),
    },
    {
      name: "ambiguous_deduction_blocked",
      run: (input) =>
        coordinateImageRenderAttempt(
          input,
          makeDeps({
            lookup: makeLookup(input, {
              status: "failed",
              activeClaimKeyPresent: false,
              leaseState: "none",
              deductionRecorded: true,
            }),
          }).deps
        ),
    },
    {
      name: "legacy_attempt_blocked",
      run: (input) =>
        coordinateImageRenderAttempt(
          input,
          makeDeps({
            lookup: makeLookup(input, {
              intentComparison: "unknown",
              intentFingerprint: null,
            }),
          }).deps
        ),
    },
    {
      name: "claim_subsystem_unavailable (lookup throw)",
      run: (input) =>
        coordinateImageRenderAttempt(
          input,
          makeDeps({
            lookup: Promise.reject(new Error("ER_DUP_ENTRY secret-leak probe")),
          }).deps
        ),
    },
    {
      name: "claim_subsystem_unavailable (rearm race, re-read empty)",
      run: (input) =>
        coordinateImageRenderAttempt(
          input,
          makeDeps({
            lookup: [
              makeLookup(input, {
                status: "failed",
                activeClaimKeyPresent: false,
                leaseState: "none",
              }),
              { found: false },
            ],
            rearm: { rearmed: false, reason: "not_found" },
          }).deps
        ),
    },
  ];

  for (const { name, run } of scenarios) {
    it(`blocked outcome ${name} carries no owner context and no sensitive values`, async () => {
      const input = sensitiveInput();
      const identity = expectedIdentityFor(input);
      const result = await run(input);
      expectBlockedWithNoSensitiveData(result, [
        input.clientAttemptId,
        input.ownerToken,
        ...SENSITIVE_TEXT,
        identity.requestAttemptKey,
        identity.intentFingerprint,
        identity.deductionKey,
      ]);
    });
  }

  it("dependency error text is never returned verbatim", async () => {
    const { deps } = makeDeps({
      lookup: Promise.reject(new Error("raw mysql packet 0x3f detail")),
    });
    const result = await coordinateImageRenderAttempt(makeInput(), deps);
    expect(result.outcome).toBe("claim_subsystem_unavailable");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("mysql");
    expect(serialized).not.toContain("0x3f");
  });
});

describe("coordinateImageRenderAttempt — bounded work (no loops, no extra re-reads)", () => {
  it("never performs more than one mutation or more than two lookups even across races", async () => {
    const input = makeInput();
    const { deps, lookupAttempt, acquireClaim, rearmFailedClaim } = makeDeps({
      lookup: [
        { found: false },
        makeLookup(input, { leaseState: "stale" }), // re-read also conflicts
      ],
      acquire: {
        acquired: false,
        existingClaim: makeClaim(input),
        reason: "active_claim_conflict",
      },
    });
    const result = await coordinateImageRenderAttempt(input, deps);
    expect(result.outcome).toBe("stale_blocked");
    expect(lookupAttempt).toHaveBeenCalledTimes(2);
    expect(acquireClaim).toHaveBeenCalledTimes(1);
    expect(rearmFailedClaim).not.toHaveBeenCalled();
  });

  it("rearm path performs exactly one lookup and one rearm on the happy path", async () => {
    const input = makeInput();
    const { deps, lookupAttempt, acquireClaim, rearmFailedClaim } = makeDeps({
      lookup: makeLookup(input, {
        status: "failed",
        activeClaimKeyPresent: false,
        leaseState: "none",
      }),
    });
    const result = await coordinateImageRenderAttempt(input, deps);
    expect(result.outcome).toBe("rearmed");
    expect(lookupAttempt).toHaveBeenCalledTimes(1);
    expect(rearmFailedClaim).toHaveBeenCalledTimes(1);
    expect(acquireClaim).not.toHaveBeenCalled();
  });
});
