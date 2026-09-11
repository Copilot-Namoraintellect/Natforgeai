import { describe, it, expect, vi, afterEach } from "vitest";
import * as claimModule from "./image-render-claim";
import {
  deriveImageRenderAttemptIdentity,
  type ImageRenderAttemptIdentityInput,
  type ImageRenderReplayResult,
} from "./image-render-claim";
import {
  evaluateImageRenderClaimGate,
  createDefaultImageRenderClaimGateDeps,
  IMAGE_RENDER_CLAIM_GATE_UNAVAILABLE_REASON,
  type ImageRenderClaimGateDeps,
  type ImageRenderClaimGateInput,
  type ImageRenderClaimGateResult,
} from "./image-render-claim-gate";
import {
  coordinateImageRenderAttempt,
  type ImageRenderClaimOwnerContext,
  type ImageRenderCoordinatorResult,
} from "./image-render-claim-coordinator";

// ─── Deterministic injected fakes ───
//
// No database, sleeps, timers, providers, rendering, billing, environment or
// global-state mutation. The injected coordinator and completed-result lookup
// are plain vi.fn fakes scripted per test; thrown Error scripts surface as
// dependency exceptions, which the gate must convert to unavailable without
// retry and without leaking error text.

const USER_A = 11;
const USER_B = 12;
const POST_A = 22;
const POST_B = 33;
const TOKEN_A = "client-token-alpha-0001";
const OWNER_TOKEN = "owner-token-abc123";
const REFINEMENT_TEXT = "make it bolder — secret refinement phrase";
const GUIDANCE_TEXT = "use more contrast — confidential guidance";
const DEPENDENCY_ERROR_TEXT =
  "ER_ACCESS_DENIED: image claims database exploded for user root";
const GENERATED_IMAGE_ID = 987654;
const COMPLETED_AT_ISO = "2026-06-01T00:00:00.000Z";

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
} satisfies ImageRenderClaimGateInput["intent"];

function fullAttempt(
  overrides: Partial<ImageRenderAttemptIdentityInput> = {}
): ImageRenderAttemptIdentityInput {
  return { ...INTENT, clientAttemptId: TOKEN_A, ...overrides };
}

function makeInput(
  overrides: Partial<ImageRenderClaimGateInput> = {}
): ImageRenderClaimGateInput {
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

function sensitiveInput(
  overrides: Partial<ImageRenderClaimGateInput> = {}
): ImageRenderClaimGateInput {
  return makeInput({
    intent: {
      ...INTENT,
      refinementInstruction: REFINEMENT_TEXT,
      creativeGuidance: GUIDANCE_TEXT,
    },
    ...overrides,
  });
}

function expectedIdentityFor(input: ImageRenderClaimGateInput) {
  return deriveImageRenderAttemptIdentity({
    userId: input.userId,
    contentPostId: input.contentPostId,
    attempt: { ...input.intent, clientAttemptId: input.clientAttemptId },
  });
}

function activeKeyFor(input: ImageRenderClaimGateInput): string {
  return `active:${input.userId}:post:${input.contentPostId}:image`;
}

function makeOwner(
  input: ImageRenderClaimGateInput,
  overrides: Partial<ImageRenderClaimOwnerContext> = {}
): ImageRenderClaimOwnerContext {
  const identity = expectedIdentityFor(input);
  return Object.freeze({
    claimId: 7,
    ownerToken: input.ownerToken,
    requestAttemptKey: identity.requestAttemptKey,
    intentFingerprint: identity.intentFingerprint,
    deductionKey: identity.deductionKey,
    ...overrides,
  });
}

function makeReplayResult(
  overrides: Partial<ImageRenderReplayResult> = {}
): ImageRenderReplayResult {
  return {
    generatedImageId: GENERATED_IMAGE_ID,
    imageUrl: "https://cdn.example.com/premium-asset.png",
    provider: "premium-v2-hybrid",
    providerJobId: "job-123",
    creditsCharged: 5,
    qualityTier: "premium",
    qualityLabel: "Premium Marketing Leaflet",
    isDraft: false,
    completedAt: new Date(COMPLETED_AT_ISO),
    ...overrides,
  };
}

interface FakeDeps {
  deps: ImageRenderClaimGateDeps;
  coordinate: ReturnType<typeof vi.fn>;
  getCompletedResult: ReturnType<typeof vi.fn>;
}

function makeDeps(script: { coordinate?: unknown; replay?: unknown } = {}): FakeDeps {
  const consume = (value: unknown, fallback: () => unknown): unknown => {
    if (Array.isArray(value)) {
      const entry = value.length > 0 ? value.shift() : undefined;
      if (entry === undefined) return fallback();
      if (entry instanceof Error) throw entry;
      return entry;
    }
    if (value === undefined) return fallback();
    if (value instanceof Error) throw value;
    return value;
  };

  const coordinate = vi.fn(
    async (coordinatorInput: unknown): Promise<unknown> =>
      consume(script.coordinate, () => ({
        outcome: "acquired",
        owner: makeOwner(coordinatorInput as ImageRenderClaimGateInput),
      }))
  );
  const getCompletedResult = vi.fn(async (): Promise<unknown> =>
    consume(script.replay, () => ({
      replayable: true,
      result: makeReplayResult(),
    }))
  );

  return {
    deps: {
      coordinateImageRenderAttempt:
        coordinate as unknown as ImageRenderClaimGateDeps["coordinateImageRenderAttempt"],
      coordinatorDeps:
        {} as ImageRenderClaimGateDeps["coordinatorDeps"],
      getCompletedImageRenderResult:
        getCompletedResult as unknown as ImageRenderClaimGateDeps["getCompletedImageRenderResult"],
    },
    coordinate,
    getCompletedResult,
  };
}

// ─── Exposure helpers ───

function internalSecretValues(input: ImageRenderClaimGateInput): string[] {
  const identity = expectedIdentityFor(input);
  return [
    input.ownerToken,
    activeKeyFor(input),
    identity.requestAttemptKey,
    identity.intentFingerprint,
    identity.deductionKey,
    "deductionRecorded",
    "claimId",
    "generatedImageId",
    "completedAt",
    "ownerToken",
    "activeClaimKey",
    "requestAttemptKey",
    "intentFingerprint",
    "deductionKey",
    DEPENDENCY_ERROR_TEXT,
    String(GENERATED_IMAGE_ID),
    COMPLETED_AT_ISO,
  ];
}

function rawSecretValues(input: ImageRenderClaimGateInput): string[] {
  return [
    input.clientAttemptId,
    REFINEMENT_TEXT,
    GUIDANCE_TEXT,
    activeKeyFor(input),
    DEPENDENCY_ERROR_TEXT,
  ];
}

/** Blocked, unavailable and replay results must expose no internals at all. */
function expectClosedResult(
  result: ImageRenderClaimGateResult,
  input: ImageRenderClaimGateInput
) {
  expect(result.status).not.toBe("proceed");
  expect("owner" in result).toBe(false);
  if (result.status === "replay") {
    expect(Object.keys(result.response).sort()).toEqual(
      [
        "creditsCharged",
        "imageUrl",
        "isDraft",
        "jobId",
        "provider",
        "qualityLabel",
        "qualityTier",
        "success",
      ].sort()
    );
  } else {
    expect(Object.keys(result).sort()).toEqual(["reason", "status"]);
  }
  const serialized = JSON.stringify(result);
  for (const secret of internalSecretValues(input)) {
    expect(serialized).not.toContain(secret);
  }
  for (const secret of rawSecretValues(input)) {
    expect(serialized).not.toContain(secret);
  }
}

/** Proceed may carry the opaque owner context but never raw secrets. */
function expectProceedFreeOfRawSecrets(
  result: ImageRenderClaimGateResult,
  input: ImageRenderClaimGateInput
) {
  expect(result.status).toBe("proceed");
  const serialized = JSON.stringify(result);
  for (const secret of rawSecretValues(input)) {
    expect(serialized).not.toContain(secret);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("evaluateImageRenderClaimGate — input validation before any dependency call", () => {
  it.each([
    ["zero", 0],
    ["negative", -1],
    ["NaN", Number.NaN],
    ["fractional", 1.5],
    ["Infinity", Infinity],
    ["beyond MAX_SAFE_INTEGER", Number.MAX_SAFE_INTEGER + 1],
    ["string", "11"],
    ["null", null],
  ])("rejects invalid userId (%s) before any dependency call", async (_label, userId) => {
    const { deps, coordinate, getCompletedResult } = makeDeps();
    await expect(
      evaluateImageRenderClaimGate(makeInput({ userId: userId as number }), deps)
    ).rejects.toThrow();
    expect(coordinate).not.toHaveBeenCalled();
    expect(getCompletedResult).not.toHaveBeenCalled();
  });

  it.each([
    ["zero", 0],
    ["negative", -3],
    ["NaN", Number.NaN],
    ["fractional", 2.5],
    ["string", "22"],
  ])(
    "rejects invalid contentPostId (%s) before any dependency call",
    async (_label, contentPostId) => {
      const { deps, coordinate, getCompletedResult } = makeDeps();
      await expect(
        evaluateImageRenderClaimGate(
          makeInput({ contentPostId: contentPostId as number }),
          deps
        )
      ).rejects.toThrow();
      expect(coordinate).not.toHaveBeenCalled();
      expect(getCompletedResult).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["empty", ""],
    ["whitespace", "bad token"],
    ["slash", "bad/token"],
    ["colon", "bad:token"],
    ["open bracket", "bad[token"],
    ["close bracket", "bad]token"],
    ["backslash", "bad\\token"],
    ["caret", "bad^token"],
    ["backtick", "bad`token"],
    ["single [", "["],
    ["single \\", "\\"],
    ["single ]", "]"],
    ["single ^", "^"],
    ["single backtick", "`"],
    ["single /", "/"],
    ["single :", ":"],
    ["single space", " "],
    ["oversized 65", "a".repeat(65)],
    ["null", null],
    ["number", 123],
  ])(
    "rejects malformed clientAttemptId (%s) before any dependency call",
    async (_label, clientAttemptId) => {
      const { deps, coordinate, getCompletedResult } = makeDeps();
      await expect(
        evaluateImageRenderClaimGate(
          makeInput({ clientAttemptId: clientAttemptId as string }),
          deps
        )
      ).rejects.toThrow();
      expect(coordinate).not.toHaveBeenCalled();
      expect(getCompletedResult).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["empty", ""],
    ["oversized 65", "o".repeat(65)],
    ["number", 456],
  ])("rejects invalid ownerToken (%s) before any dependency call", async (_label, ownerToken) => {
    const { deps, coordinate, getCompletedResult } = makeDeps();
    await expect(
      evaluateImageRenderClaimGate(makeInput({ ownerToken: ownerToken as string }), deps)
    ).rejects.toThrow();
    expect(coordinate).not.toHaveBeenCalled();
    expect(getCompletedResult).not.toHaveBeenCalled();
  });

  it.each([
    ["NaN Date", new Date(Number.NaN)],
    ["string", "2030-01-01"],
    ["null", null],
    ["number", 1_000_000],
  ])(
    "rejects invalid leaseExpiresAt (%s) before any dependency call",
    async (_label, leaseExpiresAt) => {
      const { deps, coordinate, getCompletedResult } = makeDeps();
      await expect(
        evaluateImageRenderClaimGate(
          makeInput({ leaseExpiresAt: leaseExpiresAt as Date }),
          deps
        )
      ).rejects.toThrow();
      expect(coordinate).not.toHaveBeenCalled();
      expect(getCompletedResult).not.toHaveBeenCalled();
    }
  );

  it("accepts boundary-valid ids, 64-char token, 64-char ownerToken and concrete Date", async () => {
    const { deps, coordinate, getCompletedResult } = makeDeps();
    const result = await evaluateImageRenderClaimGate(
      makeInput({
        userId: 1,
        contentPostId: 1,
        clientAttemptId: "a".repeat(64),
        ownerToken: "o".repeat(64),
      }),
      deps
    );
    expect(result.status).toBe("proceed");
    expect(coordinate).toHaveBeenCalledTimes(1);
    expect(getCompletedResult).not.toHaveBeenCalled();
  });
});

describe("evaluateImageRenderClaimGate — proceed behavior", () => {
  it.each([["acquired"], ["rearmed"]] as const)(
    "coordinator %s maps to proceed with the exact frozen owner object",
    async (outcome) => {
      const input = sensitiveInput();
      const owner = makeOwner(input);
      const { deps, coordinate, getCompletedResult } = makeDeps({
        coordinate: { outcome, owner },
      });
      const result = await evaluateImageRenderClaimGate(input, deps);

      expect(result.status).toBe("proceed");
      if (result.status !== "proceed") throw new Error("unreachable");
      // Exact object identity — never cloned, reconstructed, or widened.
      expect(result.owner).toBe(owner);
      expect(Object.isFrozen(result.owner)).toBe(true);
      expect(Object.keys(result.owner).sort()).toEqual(
        [
          "claimId",
          "deductionKey",
          "intentFingerprint",
          "ownerToken",
          "requestAttemptKey",
        ].sort()
      );

      expect(coordinate).toHaveBeenCalledTimes(1);
      expect(getCompletedResult).not.toHaveBeenCalled();
      expectProceedFreeOfRawSecrets(result, input);
    }
  );

  it("proceed carries exactly { status, owner } and no billing authorization fields", async () => {
    const { deps } = makeDeps();
    const result = await evaluateImageRenderClaimGate(makeInput(), deps);
    expect(Object.keys(result).sort()).toEqual(["owner", "status"]);
    expect("creditsCharged" in result).toBe(false);
    expect("billingAuthorized" in result).toBe(false);
    expect("deductionRecorded" in result).toBe(false);
    if (result.status !== "proceed") throw new Error("unreachable");
    // The owner context is the coordinator's opaque credential set only.
    expect(Object.keys(result.owner).sort()).toEqual(
      [
        "claimId",
        "deductionKey",
        "intentFingerprint",
        "ownerToken",
        "requestAttemptKey",
      ].sort()
    );
  });

  it("proceed does not invoke the replay lookup", async () => {
    const input = makeInput();
    const { deps, coordinate, getCompletedResult } = makeDeps({
      coordinate: { outcome: "rearmed", owner: makeOwner(input) },
    });
    const result = await evaluateImageRenderClaimGate(input, deps);
    expect(result.status).toBe("proceed");
    expect(coordinate).toHaveBeenCalledTimes(1);
    expect(getCompletedResult).not.toHaveBeenCalled();
  });
});

describe("evaluateImageRenderClaimGate — replay behavior", () => {
  it("completed_replay_required invokes the lookup exactly once with the derived identity", async () => {
    const input = sensitiveInput();
    const identity = expectedIdentityFor(input);
    const { deps, coordinate, getCompletedResult } = makeDeps({
      coordinate: { outcome: "completed_replay_required" },
    });
    const result = await evaluateImageRenderClaimGate(input, deps);

    expect(result.status).toBe("replay");
    expect(coordinate).toHaveBeenCalledTimes(1);
    expect(getCompletedResult).toHaveBeenCalledTimes(1);
    const args = getCompletedResult.mock.calls[0][0];
    expect(Object.keys(args).sort()).toEqual(
      ["contentPostId", "intentFingerprint", "requestAttemptKey", "userId"].sort()
    );
    expect(args).toEqual({
      userId: USER_A,
      contentPostId: POST_A,
      requestAttemptKey: identity.requestAttemptKey,
      intentFingerprint: identity.intentFingerprint,
    });
    expectClosedResult(result, input);
  });

  it("replayable maps all eight established response fields exactly", async () => {
    const input = makeInput();
    const stored = makeReplayResult();
    const { deps } = makeDeps({
      coordinate: { outcome: "completed_replay_required" },
      replay: { replayable: true, result: stored },
    });
    const result = await evaluateImageRenderClaimGate(input, deps);
    if (result.status !== "replay") throw new Error("unreachable");
    expect(result.response).toEqual({
      success: true,
      imageUrl: stored.imageUrl,
      provider: stored.provider,
      jobId: "job-123",
      creditsCharged: stored.creditsCharged,
      qualityTier: stored.qualityTier,
      qualityLabel: stored.qualityLabel,
      isDraft: stored.isDraft,
    });
  });

  it.each([
    ["present providerJobId maps directly", "job-abc-123", "job-abc-123"],
    ["null providerJobId maps to premium", null, "premium"],
    ["empty providerJobId maps to premium", "", "premium"],
  ])("jobId mapping: %s", async (_label, providerJobId, expectedJobId) => {
    const { deps } = makeDeps({
      coordinate: { outcome: "completed_replay_required" },
      replay: {
        replayable: true,
        result: makeReplayResult({ providerJobId }),
      },
    });
    const result = await evaluateImageRenderClaimGate(makeInput(), deps);
    if (result.status !== "replay") throw new Error("unreachable");
    expect(result.response.jobId).toBe(expectedJobId);
  });

  it.each([["zero", 0], ["positive", 7]] as const)(
    "replay preserves the original stored creditsCharged (%s)",
    async (_label, creditsCharged) => {
      const { deps } = makeDeps({
        coordinate: { outcome: "completed_replay_required" },
        replay: {
          replayable: true,
          result: makeReplayResult({ creditsCharged }),
        },
      });
      const result = await evaluateImageRenderClaimGate(makeInput(), deps);
      if (result.status !== "replay") throw new Error("unreachable");
      expect(result.response.creditsCharged).toBe(creditsCharged);
    }
  );

  it("replay response excludes generatedImageId and completedAt", async () => {
    const input = sensitiveInput();
    const { deps } = makeDeps({
      coordinate: { outcome: "completed_replay_required" },
    });
    const result = await evaluateImageRenderClaimGate(input, deps);
    if (result.status !== "replay") throw new Error("unreachable");
    expect("generatedImageId" in result.response).toBe(false);
    expect("completedAt" in result.response).toBe(false);
    expectClosedResult(result, input);
  });

  it("replay carries no owner context", async () => {
    const input = sensitiveInput();
    const { deps } = makeDeps({
      coordinate: { outcome: "completed_replay_required" },
    });
    const result = await evaluateImageRenderClaimGate(input, deps);
    expect(result.status).toBe("replay");
    expect("owner" in result).toBe(false);
    expectClosedResult(result, input);
  });
});

describe("evaluateImageRenderClaimGate — replay failure mapping (no second lookup, no proceed)", () => {
  it.each([
    ["intent_conflict", "intent_conflict"],
    ["completed_without_result", "completed_without_result"],
    [
      "linked_result_missing_or_mismatched",
      "linked_result_missing_or_mismatched",
    ],
    // Source reason "not_completed_or_not_found" is surfaced under the stable
    // gate reason "completed_result_not_found".
    ["not_completed_or_not_found", "completed_result_not_found"],
  ] as const)(
    "replay %s maps to blocked %s exactly once",
    async (sourceReason, gateReason) => {
      const input = sensitiveInput();
      const { deps, coordinate, getCompletedResult } = makeDeps({
        coordinate: { outcome: "completed_replay_required" },
        replay: { replayable: false, reason: sourceReason },
      });
      const result = await evaluateImageRenderClaimGate(input, deps);

      expect(result).toEqual({ status: "blocked", reason: gateReason });
      expect(coordinate).toHaveBeenCalledTimes(1);
      expect(getCompletedResult).toHaveBeenCalledTimes(1);
      expectClosedResult(result, input);
    }
  );
});

describe("evaluateImageRenderClaimGate — coordinator blocked mapping (lookup never invoked)", () => {
  it.each([
    ["already_running", "blocked", "already_running"],
    ["stale_blocked", "blocked", "stale_blocked"],
    ["intent_conflict", "blocked", "intent_conflict"],
    ["active_post_conflict", "blocked", "active_post_conflict"],
    ["ambiguous_deduction_blocked", "blocked", "ambiguous_deduction_blocked"],
    ["legacy_attempt_blocked", "blocked", "legacy_attempt_blocked"],
  ] as const)(
    "coordinator %s maps to %s/%s with zero replay lookups",
    async (outcome, status, reason) => {
      const input = sensitiveInput();
      const { deps, coordinate, getCompletedResult } = makeDeps({
        coordinate: { outcome },
      });
      const result = await evaluateImageRenderClaimGate(input, deps);

      expect(result).toEqual({ status, reason });
      expect(coordinate).toHaveBeenCalledTimes(1);
      expect(getCompletedResult).not.toHaveBeenCalled();
      expectClosedResult(result, input);
    }
  );

  it("coordinator claim_subsystem_unavailable maps to unavailable with zero replay lookups", async () => {
    const input = sensitiveInput();
    const { deps, coordinate, getCompletedResult } = makeDeps({
      coordinate: { outcome: "claim_subsystem_unavailable" },
    });
    const result = await evaluateImageRenderClaimGate(input, deps);

    expect(result).toEqual({
      status: "unavailable",
      reason: IMAGE_RENDER_CLAIM_GATE_UNAVAILABLE_REASON,
    });
    expect(coordinate).toHaveBeenCalledTimes(1);
    expect(getCompletedResult).not.toHaveBeenCalled();
    expectClosedResult(result, input);
  });
});

describe("evaluateImageRenderClaimGate — dependency failures (unavailable, no retry, no error text)", () => {
  it("coordinator throw maps to unavailable without retry and without error text", async () => {
    const input = sensitiveInput();
    const { deps, coordinate, getCompletedResult } = makeDeps({
      coordinate: new Error(DEPENDENCY_ERROR_TEXT),
    });
    const result = await evaluateImageRenderClaimGate(input, deps);

    expect(result).toEqual({
      status: "unavailable",
      reason: IMAGE_RENDER_CLAIM_GATE_UNAVAILABLE_REASON,
    });
    expect(coordinate).toHaveBeenCalledTimes(1);
    expect(getCompletedResult).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(DEPENDENCY_ERROR_TEXT);
    expectClosedResult(result, input);
  });

  it("replay lookup throw maps to unavailable without retry and without error text", async () => {
    const input = sensitiveInput();
    const { deps, coordinate, getCompletedResult } = makeDeps({
      coordinate: { outcome: "completed_replay_required" },
      replay: new Error(DEPENDENCY_ERROR_TEXT),
    });
    const result = await evaluateImageRenderClaimGate(input, deps);

    expect(result).toEqual({
      status: "unavailable",
      reason: IMAGE_RENDER_CLAIM_GATE_UNAVAILABLE_REASON,
    });
    expect(coordinate).toHaveBeenCalledTimes(1);
    expect(getCompletedResult).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain(DEPENDENCY_ERROR_TEXT);
    expectClosedResult(result, input);
  });

  it("malformed coordinator outcome fails closed to unavailable, never proceed", async () => {
    const input = sensitiveInput();
    const { deps, getCompletedResult } = makeDeps({
      coordinate: { outcome: "something_unexpected" },
    });
    const result = await evaluateImageRenderClaimGate(input, deps);

    expect(result.status).toBe("unavailable");
    expect(result.status).not.toBe("proceed");
    expect(getCompletedResult).not.toHaveBeenCalled();
    expectClosedResult(result, input);
  });

  it("malformed replay outcome fails closed to unavailable, never proceed", async () => {
    const input = sensitiveInput();
    const { deps } = makeDeps({
      coordinate: { outcome: "completed_replay_required" },
      replay: { replayable: false },
    });
    const result = await evaluateImageRenderClaimGate(input, deps);

    expect(result.status).toBe("unavailable");
    expect(result.status).not.toBe("proceed");
    expectClosedResult(result, input);
  });
});

describe("evaluateImageRenderClaimGate — identity derivation and call bounds", () => {
  it("derives attempt identity exactly once per evaluation", async () => {
    const input = makeInput();
    const owner = makeOwner(input);
    const replay = { replayable: true, result: makeReplayResult() };
    const derivationSpy = vi.spyOn(
      claimModule,
      "deriveImageRenderAttemptIdentity"
    );

    const coordinateA = vi.fn(async () => ({
      outcome: "acquired",
      owner,
    })) as unknown as ImageRenderClaimGateDeps["coordinateImageRenderAttempt"];
    const depsA: ImageRenderClaimGateDeps = {
      coordinateImageRenderAttempt: coordinateA,
      coordinatorDeps: {} as ImageRenderClaimGateDeps["coordinatorDeps"],
      getCompletedImageRenderResult: vi.fn() as unknown as ImageRenderClaimGateDeps["getCompletedImageRenderResult"],
    };
    await evaluateImageRenderClaimGate(input, depsA);
    expect(derivationSpy).toHaveBeenCalledTimes(1);

    const coordinateB = vi.fn(async () => ({
      outcome: "completed_replay_required",
    })) as unknown as ImageRenderClaimGateDeps["coordinateImageRenderAttempt"];
    const getCompletedB = vi.fn(async () => replay) as unknown as ImageRenderClaimGateDeps["getCompletedImageRenderResult"];
    const depsB: ImageRenderClaimGateDeps = {
      coordinateImageRenderAttempt: coordinateB,
      coordinatorDeps: {} as ImageRenderClaimGateDeps["coordinatorDeps"],
      getCompletedImageRenderResult: getCompletedB,
    };
    await evaluateImageRenderClaimGate(input, depsB);
    expect(derivationSpy).toHaveBeenCalledTimes(2);
    expect(getCompletedB).toHaveBeenCalledTimes(1);
  });

  it("coordinator receives authoritative ids, validated token, complete intent, ownerToken and lease", async () => {
    const input = sensitiveInput();
    const { deps, coordinate } = makeDeps();
    await evaluateImageRenderClaimGate(input, deps);

    expect(coordinate).toHaveBeenCalledTimes(1);
    const [coordinatorInput, coordinatorDepsArg] = coordinate.mock.calls[0];
    expect(coordinatorInput).toEqual({
      userId: USER_A,
      contentPostId: POST_A,
      clientAttemptId: TOKEN_A,
      intent: input.intent,
      ownerToken: OWNER_TOKEN,
      leaseExpiresAt: input.leaseExpiresAt,
    });
    expect(coordinatorInput.leaseExpiresAt).toBe(input.leaseExpiresAt);
    // Coordinator dependency wiring is passed through untouched.
    expect(coordinatorDepsArg).toBe(deps.coordinatorDeps);
  });

  it("replay lookup receives only the derived requestAttemptKey and intentFingerprint — no caller-supplied key is accepted", async () => {
    const input = makeInput();
    const identity = expectedIdentityFor(input);
    const forgedRequestAttemptKey = "f".repeat(64);
    const forgedIntentFingerprint = "e".repeat(64);
    const forgedInput = {
      ...input,
      requestAttemptKey: forgedRequestAttemptKey,
      intentFingerprint: forgedIntentFingerprint,
      deductionKey: "img-deduction:forged",
    } as ImageRenderClaimGateInput;

    const { deps, getCompletedResult } = makeDeps({
      coordinate: { outcome: "completed_replay_required" },
    });
    await evaluateImageRenderClaimGate(forgedInput, deps);

    expect(getCompletedResult).toHaveBeenCalledTimes(1);
    const args = getCompletedResult.mock.calls[0][0];
    expect(args.requestAttemptKey).toBe(identity.requestAttemptKey);
    expect(args.intentFingerprint).toBe(identity.intentFingerprint);
    expect(args.requestAttemptKey).not.toBe(forgedRequestAttemptKey);
    expect(args.intentFingerprint).not.toBe(forgedIntentFingerprint);
    expect(args).toEqual({
      userId: USER_A,
      contentPostId: POST_A,
      requestAttemptKey: identity.requestAttemptKey,
      intentFingerprint: identity.intentFingerprint,
    });
  });

  it("changed material intent produces changed identity through the existing derivation", async () => {
    const inputA = makeInput({ intent: { ...INTENT, creativeType: "leaflet" } });
    const inputB = makeInput({ intent: { ...INTENT, creativeType: "poster" } });
    const identityA = expectedIdentityFor(inputA);
    const identityB = expectedIdentityFor(inputB);
    expect(identityA.intentFingerprint).not.toBe(identityB.intentFingerprint);

    const { deps: depsA, getCompletedResult: lookupA } = makeDeps({
      coordinate: { outcome: "completed_replay_required" },
    });
    await evaluateImageRenderClaimGate(inputA, depsA);
    const { deps: depsB, getCompletedResult: lookupB } = makeDeps({
      coordinate: { outcome: "completed_replay_required" },
    });
    await evaluateImageRenderClaimGate(inputB, depsB);

    expect(lookupA.mock.calls[0][0].intentFingerprint).toBe(identityA.intentFingerprint);
    expect(lookupB.mock.calls[0][0].intentFingerprint).toBe(identityB.intentFingerprint);
    expect(lookupA.mock.calls[0][0].requestAttemptKey).toBe(identityA.requestAttemptKey);
    expect(lookupB.mock.calls[0][0].requestAttemptKey).toBe(identityB.requestAttemptKey);
  });

  it("authoritative userId and contentPostId reach both dependencies unchanged", async () => {
    const input = makeInput({ userId: USER_B, contentPostId: POST_B });
    const identity = expectedIdentityFor(input);
    const { deps, coordinate, getCompletedResult } = makeDeps({
      coordinate: { outcome: "completed_replay_required" },
    });
    await evaluateImageRenderClaimGate(input, deps);

    expect(coordinate.mock.calls[0][0].userId).toBe(USER_B);
    expect(coordinate.mock.calls[0][0].contentPostId).toBe(POST_B);
    expect(getCompletedResult.mock.calls[0][0]).toEqual({
      userId: USER_B,
      contentPostId: POST_B,
      requestAttemptKey: identity.requestAttemptKey,
      intentFingerprint: identity.intentFingerprint,
    });
  });
});

describe("evaluateImageRenderClaimGate — raw sensitive intent text never appears in any result", () => {
  it.each([
    ["proceed (acquired)", { outcome: "acquired" }],
    ["proceed (rearmed)", { outcome: "rearmed" }],
    ["replay", { outcome: "completed_replay_required" }],
    ["blocked (already_running)", { outcome: "already_running" }],
    ["blocked (intent_conflict)", { outcome: "intent_conflict" }],
    ["blocked (legacy_attempt_blocked)", { outcome: "legacy_attempt_blocked" }],
    [
      "unavailable (claim_subsystem_unavailable)",
      { outcome: "claim_subsystem_unavailable" },
    ],
  ] as const)("serializes %s without raw secrets", async (_label, coordinatorScript) => {
    const input = sensitiveInput();
    const script =
      coordinatorScript.outcome === "acquired" ||
      coordinatorScript.outcome === "rearmed"
        ? {
            coordinate: {
              outcome: coordinatorScript.outcome,
              owner: makeOwner(input),
            },
          }
        : { coordinate: coordinatorScript };
    const { deps } = makeDeps(script);
    const result = await evaluateImageRenderClaimGate(input, deps);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(REFINEMENT_TEXT);
    expect(serialized).not.toContain(GUIDANCE_TEXT);
    expect(serialized).not.toContain(TOKEN_A);
  });
});

describe("createDefaultImageRenderClaimGateDeps — dormant wiring", () => {
  it("composes the established coordinator and lookup primitives", () => {
    const deps = createDefaultImageRenderClaimGateDeps();
    expect(deps.coordinateImageRenderAttempt).toBe(coordinateImageRenderAttempt);
    expect(typeof deps.getCompletedImageRenderResult).toBe("function");
    expect(typeof deps.coordinatorDeps.lookupAttempt).toBe("function");
    expect(typeof deps.coordinatorDeps.acquireClaim).toBe("function");
    expect(typeof deps.coordinatorDeps.rearmFailedClaim).toBe("function");
  });
});
