import { describe, it, expect } from "vitest";
import {
  CLIENT_ATTEMPT_ID_PATTERN,
  ImageRenderAttemptController,
  canonicalizeMaterialIntent,
  classifyImageRenderAttemptError,
  computeClientAttemptStorageKey,
  computeMaterialIntentFingerprint,
  extractImageRenderClaimErrorCode,
  getImageRenderClaimErrorGuidance,
  mintClientAttemptId,
  normalizeBrandColors,
  sha256Hex,
  type ClientAttemptScope,
  type ClientAttemptStore,
  type ImageRenderMaterialIntentInput,
} from "./image-render-client-attempt";
import {
  IMAGE_RENDER_CLAIM_ERROR_CODES,
  isImageRenderClaimErrorCode,
  type ImageRenderClaimErrorCode,
} from "@contracts/image-render-claim-errors";

function createMemoryStore(): ClientAttemptStore & { dump: () => Map<string, string> } {
  const map = new Map<string, string>();
  return {
    get: (key) => map.get(key) ?? null,
    set: (key, value) => void map.set(key, value),
    remove: (key) => void map.delete(key),
    dump: () => new Map(map),
  };
}

let mintCounter = 0;
function sequentialMint() {
  mintCounter += 1;
  return `minted-token-${mintCounter}`;
}

function scope(overrides: Partial<ClientAttemptScope> = {}): ClientAttemptScope {
  return {
    userId: 7,
    contentPostId: 13,
    intent: {
      regenerate: false,
      forceRegenerate: false,
      refinementInstruction: undefined,
      creativeGuidance: undefined,
      strongerBrandFit: false,
      provider: "ai",
      templateId: undefined,
      brandColors: undefined,
      creativeType: undefined,
      allowNoLogo: false,
    },
    ...overrides,
  };
}

describe("sha256Hex (synchronous digest)", () => {
  it("matches known SHA-256 vectors", () => {
    expect(sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });
});

describe("mintClientAttemptId", () => {
  it("produces UUIDs that satisfy the server pattern and length bound", () => {
    for (let i = 0; i < 25; i++) {
      const token = mintClientAttemptId();
      expect(token).toMatch(CLIENT_ATTEMPT_ID_PATTERN);
      expect(token.length).toBeLessThanOrEqual(64);
    }
    expect(new Set(Array.from({ length: 50 }, () => mintClientAttemptId())).size).toBe(50);
  });
});

describe("computeClientAttemptStorageKey", () => {
  it("differs across user, post, operation and intent", () => {
    const base = computeClientAttemptStorageKey(scope());
    expect(computeClientAttemptStorageKey(scope({ userId: 8 }))).not.toBe(base);
    expect(computeClientAttemptStorageKey(scope({ contentPostId: 14 }))).not.toBe(base);
    const differentIntent = scope();
    differentIntent.intent.provider = "internal";
    expect(computeClientAttemptStorageKey(differentIntent)).not.toBe(base);
  });

  it("is stable for equivalent normalized intent", () => {
    const a = computeClientAttemptStorageKey(
      scope({
        intent: {
          provider: " ai ",
          refinementInstruction: "  tighten  ",
          creativeGuidance: " autumn palette ",
          brandColors: [" #ff0000 ", "#FF0000"],
          creativeType: " leaflet ",
        },
      })
    );
    const b = computeClientAttemptStorageKey(
      scope({
        intent: {
          provider: "ai",
          refinementInstruction: "tighten",
          creativeGuidance: "autumn palette",
          brandColors: ["#FF0000", "#FF0000"],
          creativeType: "leaflet",
        },
      })
    );
    expect(a).toBe(b);
  });

  it("changes for every material intent field", () => {
    const base = computeClientAttemptStorageKey(scope());
    const variants: ImageRenderMaterialIntentInput[] = [
      { provider: "ai", regenerate: true },
      { provider: "ai", forceRegenerate: true },
      { provider: "ai", refinementInstruction: "tighten the headline" },
      { provider: "ai", creativeGuidance: "use the autumn palette" },
      { provider: "ai", strongerBrandFit: true },
      { provider: "internal" },
      { provider: "ai", templateId: "corporate_professional" },
      { provider: "ai", brandColors: ["#0047AB"] },
      { provider: "ai", creativeType: "poster" },
      { provider: "ai", allowNoLogo: true },
    ];
    for (const intent of variants) {
      expect(computeClientAttemptStorageKey(scope({ intent }))).not.toBe(base);
    }
  });

  it("never places raw refinement, guidance or colour text in the key", () => {
    const key = computeClientAttemptStorageKey(
      scope({
        intent: {
          provider: "ai",
          refinementInstruction: "super secret refinement text 123",
          creativeGuidance: "confidential guidance text 456",
          brandColors: ["#0047AB", "#FFD700"],
        },
      })
    );
    expect(key).not.toContain("super secret refinement text 123");
    expect(key).not.toContain("confidential guidance text 456");
    expect(key).not.toContain("#0047AB");
    expect(key).not.toContain("0047AB");
    expect(key).not.toContain("#FFD700");
  });

  it("canonical intent payload holds only inner digests for both text fields", () => {
    const canonical = canonicalizeMaterialIntent({
      provider: "ai",
      refinementInstruction: "super secret refinement text 123",
      creativeGuidance: "confidential guidance text 456",
    });
    expect(canonical).toHaveProperty("refinementInstructionHash");
    expect(canonical).toHaveProperty("creativeGuidanceHash");
    expect(canonical).not.toHaveProperty("refinementInstruction");
    expect(canonical).not.toHaveProperty("creativeGuidance");
    expect(String(canonical.refinementInstructionHash)).toMatch(/^[0-9a-f]{64}$/);
    expect(String(canonical.creativeGuidanceHash)).toMatch(/^[0-9a-f]{64}$/);
    const serialized = JSON.stringify(canonical);
    expect(serialized).not.toContain("super secret refinement text 123");
    expect(serialized).not.toContain("confidential guidance text 456");
    expect(serialized.toLowerCase()).not.toContain("secret");
    expect(serialized.toLowerCase()).not.toContain("confidential");
  });

  it("stored session entry holds the token only, never raw intent text", () => {
    const store = createMemoryStore();
    const controller = new ImageRenderAttemptController({ store, mint: sequentialMint });
    const began = controller.beginAttempt(
      scope({
        intent: {
          provider: "ai",
          refinementInstruction: "super secret refinement text 123",
          creativeGuidance: "confidential guidance text 456",
          brandColors: ["#0047AB"],
        },
      })
    );
    if (began.status !== "ready") throw new Error("expected ready");
    const raw = store.get(began.storageKey) ?? "";
    expect(raw).toContain(began.token);
    expect(raw).not.toContain("super secret refinement text 123");
    expect(raw).not.toContain("confidential guidance text 456");
    expect(raw).not.toContain("#0047AB");
    expect(store.dump().size).toBe(1);
  });

  it("treats brand colour order as material", () => {
    const forward = computeClientAttemptStorageKey(
      scope({ intent: { provider: "ai", brandColors: ["#FF0000", "#00FF00"] } })
    );
    const reversed = computeClientAttemptStorageKey(
      scope({ intent: { provider: "ai", brandColors: ["#00FF00", "#FF0000"] } })
    );
    expect(forward).not.toBe(reversed);
  });
});

describe("normalizeBrandColors", () => {
  it("trims, uppercases, drops empties and preserves order", () => {
    expect(normalizeBrandColors(["  #ff0000 ", "", "  ", "#00Ff00"])).toEqual([
      "#FF0000",
      "#00FF00",
    ]);
    expect(normalizeBrandColors(null)).toEqual([]);
    expect(normalizeBrandColors(undefined)).toEqual([]);
    expect(normalizeBrandColors("not-an-array" as unknown as string[])).toEqual([]);
  });
});

describe("computeMaterialIntentFingerprint", () => {
  it("omitted defaults equal explicit defaults", () => {
    const omitted = computeMaterialIntentFingerprint({ provider: "ai" });
    const explicit = computeMaterialIntentFingerprint({
      provider: "ai",
      regenerate: false,
      forceRegenerate: false,
      refinementInstruction: "",
      creativeGuidance: "",
      strongerBrandFit: false,
      templateId: "auto",
      brandColors: [],
      creativeType: "leaflet",
      allowNoLogo: false,
    });
    expect(omitted).toBe(explicit);
  });
});

describe("classifyImageRenderAttemptError", () => {
  it("classifies proven pre-work rejections as definitive", () => {
    for (const code of ["UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND", "TOO_MANY_REQUESTS", "NOT_IMPLEMENTED"]) {
      expect(classifyImageRenderAttemptError({ data: { code } })).toBe("definitive");
    }
  });

  it("classifies everything else as ambiguous, including PAYMENT_REQUIRED and BAD_REQUEST", () => {
    for (const code of ["PAYMENT_REQUIRED", "BAD_REQUEST", "INTERNAL_SERVER_ERROR", undefined]) {
      expect(classifyImageRenderAttemptError(code ? { data: { code } } : {})).toBe("ambiguous");
    }
    expect(classifyImageRenderAttemptError(new Error("network down"))).toBe("ambiguous");
    expect(classifyImageRenderAttemptError(null)).toBe("ambiguous");
  });
});

describe("ImageRenderAttemptController", () => {
  it("blocks a same-tick duplicate submission with one token and one submit", () => {
    const store = createMemoryStore();
    const controller = new ImageRenderAttemptController({ store, mint: sequentialMint });
    const submissions: string[] = [];

    const first = controller.beginAttempt(scope());
    expect(first.status).toBe("ready");
    if (first.status !== "ready") return;
    submissions.push(first.token);

    // Same tick, same logical submission: blocked before a second mint/submit.
    const second = controller.beginAttempt(scope());
    expect(second).toEqual({ status: "blocked_in_flight", storageKey: first.storageKey });
    expect(submissions).toHaveLength(1);
    expect(controller.isInFlight(first.storageKey)).toBe(true);
  });

  it("retires the token on success and mints a new one for the next action", () => {
    const store = createMemoryStore();
    const controller = new ImageRenderAttemptController({ store, mint: sequentialMint });

    const first = controller.beginAttempt(scope());
    if (first.status !== "ready") throw new Error("expected ready");
    controller.succeed(first.storageKey);
    expect(store.dump().size).toBe(0);
    expect(controller.isInFlight(first.storageKey)).toBe(false);

    const next = controller.beginAttempt(scope());
    if (next.status !== "ready") throw new Error("expected ready");
    expect(next.token).not.toBe(first.token);
    expect(next.reusedRetainedToken).toBe(false);
  });

  it("retires the token on a definitive failure", () => {
    const store = createMemoryStore();
    const controller = new ImageRenderAttemptController({ store, mint: sequentialMint });
    const first = controller.beginAttempt(scope());
    if (first.status !== "ready") throw new Error("expected ready");
    controller.failDefinitive(first.storageKey);
    expect(store.dump().size).toBe(0);

    const retry = controller.beginAttempt(scope());
    if (retry.status !== "ready") throw new Error("expected ready");
    expect(retry.token).not.toBe(first.token);
  });

  it("retains and reuses the token after an ambiguous failure, without expiry", () => {
    const store = createMemoryStore();
    const controller = new ImageRenderAttemptController({ store, mint: sequentialMint });
    const first = controller.beginAttempt(scope());
    if (first.status !== "ready") throw new Error("expected ready");
    // Persisted before transmission with state "in_flight".
    const duringFlight = JSON.parse(store.get(first.storageKey) ?? "null");
    expect(duringFlight.state).toBe("in_flight");
    expect(duringFlight.token).toBe(first.token);

    controller.failAmbiguous(first.storageKey, first.token);
    // Simulate an old updatedAt: retention must not depend on age.
    const stored = JSON.parse(store.get(first.storageKey) ?? "null");
    expect(stored.state).toBe("ambiguous");
    expect(stored.token).toBe(first.token);
    stored.updatedAt = "2000-01-01T00:00:00.000Z";
    store.set(first.storageKey, JSON.stringify(stored));

    // Guard cleared, manual retry possible, token reused for unchanged intent.
    expect(controller.isInFlight(first.storageKey)).toBe(false);
    const retry = controller.beginAttempt(scope());
    if (retry.status !== "ready") throw new Error("expected ready");
    expect(retry.token).toBe(first.token);
    expect(retry.reusedRetainedToken).toBe(true);
  });

  it("rotates the token when material intent changes", () => {
    const store = createMemoryStore();
    const controller = new ImageRenderAttemptController({ store, mint: sequentialMint });
    const first = controller.beginAttempt(scope());
    if (first.status !== "ready") throw new Error("expected ready");
    controller.failAmbiguous(first.storageKey, first.token);

    const changed = scope();
    changed.intent.refinementInstruction = "make it bolder";
    const rotated = controller.beginAttempt(changed);
    if (rotated.status !== "ready") throw new Error("expected ready");
    expect(rotated.token).not.toBe(first.token);
    expect(rotated.storageKey).not.toBe(first.storageKey);
  });

  it("never reuses a token across users or posts", () => {
    const store = createMemoryStore();
    const controller = new ImageRenderAttemptController({ store, mint: sequentialMint });
    const first = controller.beginAttempt(scope());
    if (first.status !== "ready") throw new Error("expected ready");
    controller.failAmbiguous(first.storageKey, first.token);

    const otherUser = controller.beginAttempt(scope({ userId: 99 }));
    if (otherUser.status !== "ready") throw new Error("expected ready");
    expect(otherUser.token).not.toBe(first.token);

    const otherPost = controller.beginAttempt(scope({ contentPostId: 55 }));
    if (otherPost.status !== "ready") throw new Error("expected ready");
    expect(otherPost.token).not.toBe(first.token);
    expect(otherPost.token).not.toBe(otherUser.token);
  });

  it("fails safely on malformed stored data and mints fresh", () => {
    const store = createMemoryStore();
    const key = computeClientAttemptStorageKey(scope());
    store.set(key, "{not json");
    const controller = new ImageRenderAttemptController({ store, mint: sequentialMint });
    const began = controller.beginAttempt(scope());
    if (began.status !== "ready") throw new Error("expected ready");
    expect(began.reusedRetainedToken).toBe(false);
    expect(CLIENT_ATTEMPT_ID_PATTERN.test(began.token)).toBe(true);
  });

  it("storage failure keeps the same-page token without a second mint", () => {
    const throwingStore: ClientAttemptStore = {
      get: () => {
        throw new Error("denied");
      },
      set: () => {
        throw new Error("denied");
      },
      remove: () => {
        throw new Error("denied");
      },
    };
    const controller = new ImageRenderAttemptController({ store: throwingStore, mint: sequentialMint });
    const began = controller.beginAttempt(scope());
    expect(began.status).toBe("ready");
    if (began.status !== "ready") return;
    expect(() => controller.failAmbiguous(began.storageKey, began.token)).not.toThrow();
    expect(controller.isInFlight(began.storageKey)).toBe(false);

    // Same-page retry reuses the in-memory retained token; no second mint.
    const retry = controller.beginAttempt(scope());
    expect(retry.status).toBe("ready");
    if (retry.status !== "ready") return;
    expect(retry.token).toBe(began.token);
    expect(retry.reusedRetainedToken).toBe(true);

    // Confirmed success clears even the in-memory retention.
    controller.succeed(began.storageKey);
    const next = controller.beginAttempt(scope());
    expect(next.status).toBe("ready");
    if (next.status !== "ready") return;
    expect(next.token).not.toBe(began.token);
  });

  it("readRetained returns null for missing or invalid entries", () => {
    const store = createMemoryStore();
    const controller = new ImageRenderAttemptController({ store, mint: sequentialMint });
    const key = computeClientAttemptStorageKey(scope());
    expect(controller.readRetained(key)).toBeNull();
    store.set(key, JSON.stringify({ token: "bad token with spaces", state: "ambiguous", updatedAt: "" }));
    expect(controller.readRetained(key)).toBeNull();
  });
});

describe("persist-before-transmit ordering", () => {
  it("writes the token to storage with state in_flight before submit runs", () => {
    const store = createMemoryStore();
    const controller = new ImageRenderAttemptController({ store, mint: sequentialMint });
    const began = controller.beginAttempt(scope());
    if (began.status !== "ready") throw new Error("expected ready");

    // The caller's submit step observes the persisted entry: storage write
    // happened before transmission, state "in_flight".
    const submit = () =>
      JSON.parse(store.get(began.storageKey) ?? "null") as {
        state: string;
        token: string;
      } | null;
    const observedAtSubmit = submit();
    expect(observedAtSubmit).not.toBeNull();
    expect(observedAtSubmit?.state).toBe("in_flight");
    expect(observedAtSubmit?.token).toBe(began.token);
  });

  it("recovers an in_flight token after refresh via a fresh controller", () => {
    const store = createMemoryStore();
    const firstController = new ImageRenderAttemptController({ store, mint: sequentialMint });
    const first = firstController.beginAttempt(scope());
    if (first.status !== "ready") throw new Error("expected ready");
    // The stored entry at "refresh time" is still "in_flight".
    const stored = JSON.parse(store.get(first.storageKey) ?? "null");
    expect(stored.state).toBe("in_flight");

    // Simulate a browser refresh: brand-new controller, mint would produce a
    // different token. The retained token is reused for unchanged intent.
    const afterRefresh = new ImageRenderAttemptController({ store, mint: sequentialMint });
    const recovered = afterRefresh.beginAttempt(scope());
    if (recovered.status !== "ready") throw new Error("expected ready");
    expect(recovered.token).toBe(first.token);
    expect(recovered.reusedRetainedToken).toBe(true);
  });

  it("ambiguous failure keeps the token and flips stored state to ambiguous", () => {
    const store = createMemoryStore();
    const controller = new ImageRenderAttemptController({ store, mint: sequentialMint });
    const began = controller.beginAttempt(scope());
    if (began.status !== "ready") throw new Error("expected ready");

    controller.failAmbiguous(began.storageKey, began.token);
    const stored = JSON.parse(store.get(began.storageKey) ?? "null");
    expect(stored.state).toBe("ambiguous");
    expect(stored.token).toBe(began.token);
    expect(controller.isInFlight(began.storageKey)).toBe(false);

    const retry = controller.beginAttempt(scope());
    if (retry.status !== "ready") throw new Error("expected ready");
    expect(retry.token).toBe(began.token);
  });

  it("same-tick double submission persists once with one token and one submit", () => {
    const backing = createMemoryStore();
    let setCount = 0;
    const countingStore: ClientAttemptStore = {
      get: (key) => backing.get(key),
      set: (key, value) => {
        setCount += 1;
        backing.set(key, value);
      },
      remove: (key) => backing.remove(key),
    };
    const controller = new ImageRenderAttemptController({ store: countingStore, mint: sequentialMint });
    const submits: string[] = [];

    const first = controller.beginAttempt(scope());
    if (first.status !== "ready") throw new Error("expected ready");
    submits.push(first.token);
    const second = controller.beginAttempt(scope());
    if (second.status === "ready") {
      submits.push(second.token);
    }

    expect(submits).toHaveLength(1);
    expect(setCount).toBe(1);
    expect(second).toEqual({ status: "blocked_in_flight", storageKey: first.storageKey });
  });

  it("success and definitive rejection both remove the stored token", () => {
    const store = createMemoryStore();
    const controller = new ImageRenderAttemptController({ store, mint: sequentialMint });

    const ok = controller.beginAttempt(scope({ contentPostId: 101 }));
    if (ok.status !== "ready") throw new Error("expected ready");
    controller.succeed(ok.storageKey);
    expect(store.get(ok.storageKey)).toBeNull();
    expect(controller.readRetained(ok.storageKey)).toBeNull();

    const rejected = controller.beginAttempt(scope({ contentPostId: 102 }));
    if (rejected.status !== "ready") throw new Error("expected ready");
    controller.failDefinitive(rejected.storageKey);
    expect(store.get(rejected.storageKey)).toBeNull();
    expect(controller.readRetained(rejected.storageKey)).toBeNull();
  });

  it("no automatic expiry: old in_flight and ambiguous entries both remain reusable", () => {
    const store = createMemoryStore();
    const controller = new ImageRenderAttemptController({ store, mint: sequentialMint });
    const began = controller.beginAttempt(scope());
    if (began.status !== "ready") throw new Error("expected ready");
    // Age the entry far into the past; nothing deletes it.
    const stored = JSON.parse(store.get(began.storageKey) ?? "null");
    stored.updatedAt = "1999-12-31T23:59:59.000Z";
    store.set(began.storageKey, JSON.stringify(stored));
    // In-flight guard still blocks the same-tick resubmission...
    expect(controller.beginAttempt(scope()).status).toBe("blocked_in_flight");
    // ...and after the guard clears (ambiguous outcome), the same token is reused.
    controller.failAmbiguous(began.storageKey, began.token);
    const retry = controller.beginAttempt(scope());
    if (retry.status !== "ready") throw new Error("expected ready");
    expect(retry.token).toBe(began.token);
  });
});

// ─── B2B-4: shared machine-code extraction, classification and guidance ───

describe("isImageRenderClaimErrorCode (shared contract predicate)", () => {
  it("accepts exactly the eight public codes and rejects everything else", () => {
    for (const code of IMAGE_RENDER_CLAIM_ERROR_CODES) {
      expect(isImageRenderClaimErrorCode(code)).toBe(true);
    }
    for (const notCode of [
      "ambiguous_deduction_blocked",
      "already_running",
      "TOKEN_REQUIRED ",
      " token_required",
      "AMBIGUOUS",
      "",
      null,
      undefined,
      42,
      {},
    ]) {
      expect(isImageRenderClaimErrorCode(notCode)).toBe(false);
    }
  });
});

describe("extractImageRenderClaimErrorCode", () => {
  it.each(IMAGE_RENDER_CLAIM_ERROR_CODES.map((code) => [code, code] as const))(
    "recognizes %s from a direct message string",
    (_label, code) => {
      expect(extractImageRenderClaimErrorCode({ message: code })).toBe(code);
      expect(extractImageRenderClaimErrorCode(code)).toBe(code);
    }
  );

  it.each(IMAGE_RENDER_CLAIM_ERROR_CODES.map((code) => [code, code] as const))(
    "recognizes %s from a realistic tRPC client error shape",
    (_label, code) => {
      const trpcLike = {
        message: code,
        data: { code: "CONFLICT", httpStatus: 409 },
        cause: undefined,
      };
      expect(extractImageRenderClaimErrorCode(trpcLike)).toBe(code);
      // Also when only the data/cause layer carries readable structure.
      expect(
        extractImageRenderClaimErrorCode({ message: "Request failed", cause: { message: code } })
      ).toBe(code);
    }
  );

  it("does not interpret arbitrary prose or nested internal reasons as machine codes", () => {
    expect(extractImageRenderClaimErrorCode({ message: "Generation failed: ALREADY_RUNNING now" })).toBeNull();
    expect(extractImageRenderClaimErrorCode({ message: "ambiguous_deduction_blocked" })).toBeNull();
    expect(
      extractImageRenderClaimErrorCode({
        message: "Request failed",
        data: { code: "CONFLICT", reason: "ambiguous_deduction_blocked" },
      })
    ).toBeNull();
    expect(extractImageRenderClaimErrorCode(new Error("network down"))).toBeNull();
    expect(extractImageRenderClaimErrorCode(null)).toBeNull();
    expect(extractImageRenderClaimErrorCode(undefined)).toBeNull();
  });

  it("respects the depth bound and never walks cyclic structures forever", () => {
    const deep: Record<string, unknown> = {};
    let current = deep;
    for (let i = 0; i < 20; i += 1) {
      current.cause = {};
      current = current.cause as Record<string, unknown>;
    }
    current.message = "ALREADY_RUNNING";
    expect(extractImageRenderClaimErrorCode(deep)).toBeNull();

    const cyclic: Record<string, unknown> = { message: "nope" };
    cyclic.cause = cyclic;
    expect(extractImageRenderClaimErrorCode(cyclic)).toBeNull();
  });
});

describe("classifyImageRenderAttemptError — B2B-4 machine-code precedence", () => {
  const definitiveCodes: ImageRenderClaimErrorCode[] = [
    "TOKEN_REQUIRED",
    "INVALID_TOKEN",
    "INTENT_CONFLICT",
  ];
  const ambiguousCodes: ImageRenderClaimErrorCode[] = [
    "ALREADY_RUNNING",
    "STALE_BLOCKED",
    "ACTIVE_POST_CONFLICT",
    "AMBIGUOUS_BLOCKED",
    "CLAIM_SUBSYSTEM_UNAVAILABLE",
  ];

  it.each(definitiveCodes.map((code) => [code, code] as const))(
    "%s is definitive (retire the token; next action mints fresh)",
    (_label, code) => {
      expect(classifyImageRenderAttemptError({ message: code })).toBe("definitive");
      expect(
        classifyImageRenderAttemptError({ message: code, data: { code: "CONFLICT" } })
      ).toBe("definitive");
    }
  );

  it.each(ambiguousCodes.map((code) => [code, code] as const))(
    "%s is ambiguous (retain the exact token for an unchanged-intent retry)",
    (_label, code) => {
      expect(classifyImageRenderAttemptError({ message: code })).toBe("ambiguous");
      expect(
        classifyImageRenderAttemptError({ message: code, data: { code: "CONFLICT" } })
      ).toBe("ambiguous");
    }
  );

  it("preserves legacy classification for non-claim errors exactly", () => {
    // Generic BAD_REQUEST and PAYMENT_REQUIRED remain ambiguous.
    expect(classifyImageRenderAttemptError({ data: { code: "BAD_REQUEST" } })).toBe("ambiguous");
    expect(classifyImageRenderAttemptError({ data: { code: "PAYMENT_REQUIRED" } })).toBe("ambiguous");
    // Proven pre-work rejections remain definitive.
    for (const code of ["UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND", "TOO_MANY_REQUESTS", "NOT_IMPLEMENTED"]) {
      expect(classifyImageRenderAttemptError({ data: { code } })).toBe("definitive");
    }
    // Network/5xx/unknown remain ambiguous.
    expect(classifyImageRenderAttemptError(new Error("fetch failed"))).toBe("ambiguous");
    expect(classifyImageRenderAttemptError({ data: { code: "INTERNAL_SERVER_ERROR" } })).toBe("ambiguous");
  });
});

describe("getImageRenderClaimErrorGuidance", () => {
  const EXPECTED_COPY: Record<ImageRenderClaimErrorCode, string> = {
    TOKEN_REQUIRED: "Please try the image generation again to start a fresh request.",
    INVALID_TOKEN: "This image request is no longer valid. Please try again.",
    ALREADY_RUNNING:
      "This image is already being generated. Wait for the current attempt to finish, then try again.",
    STALE_BLOCKED:
      "A previous image request is still locked. No new generation was started. If this persists, contact support.",
    INTENT_CONFLICT:
      "The image settings changed during this attempt. Try again to start a fresh request with the current settings.",
    ACTIVE_POST_CONFLICT:
      "Another image request for this post is already active. Wait for it to finish, then try again.",
    AMBIGUOUS_BLOCKED:
      "We couldn't safely confirm the previous image request's final state. No new render was started. Please avoid repeated retries and contact support if this persists.",
    CLAIM_SUBSYSTEM_UNAVAILABLE:
      "Image generation is temporarily unavailable. Please try again later.",
  };

  it.each(IMAGE_RENDER_CLAIM_ERROR_CODES.map((code) => [code, code] as const))(
    "returns the exact safe copy and disposition for %s",
    (_label, code) => {
      const guidance = getImageRenderClaimErrorGuidance({ message: code });
      expect(guidance).toEqual({
        code,
        message: EXPECTED_COPY[code],
        tokenDisposition:
          code === "TOKEN_REQUIRED" || code === "INVALID_TOKEN" || code === "INTENT_CONFLICT"
            ? "retire"
            : "retain",
      });
    }
  );

  it("returns null for non-claim errors so callers keep generic behavior", () => {
    expect(getImageRenderClaimErrorGuidance(new Error("network down"))).toBeNull();
    expect(getImageRenderClaimErrorGuidance({ message: "ambiguous_deduction_blocked" })).toBeNull();
    expect(getImageRenderClaimErrorGuidance({ data: { code: "PAYMENT_REQUIRED" } })).toBeNull();
    expect(getImageRenderClaimErrorGuidance(null)).toBeNull();
  });

  it("never includes tokens, hashes, claim ids, or raw dependency errors", () => {
    const secretValues = [
      "owner-token-secret",
      "a".repeat(64),
      "img-deduction:" + "b".repeat(64),
      "claim id 777",
      "ER_ACCESS_DENIED",
    ];
    for (const code of IMAGE_RENDER_CLAIM_ERROR_CODES) {
      const guidance = getImageRenderClaimErrorGuidance({
        message: code,
        cause: new Error("ER_ACCESS_DENIED mysql://u:p@h/db"),
      });
      const serialized = JSON.stringify(guidance);
      for (const secret of secretValues) {
        expect(serialized, `${code}:${secret.slice(0, 24)}`).not.toContain(secret);
      }
    }
  });

  it("ambiguous guidance never asserts credit state either way", () => {
    for (const code of ["ALREADY_RUNNING", "STALE_BLOCKED", "ACTIVE_POST_CONFLICT", "AMBIGUOUS_BLOCKED", "CLAIM_SUBSYSTEM_UNAVAILABLE"] as const) {
      const message = getImageRenderClaimErrorGuidance({ message: code })?.message ?? "";
      expect(message.toLowerCase(), code).not.toContain("credits");
      expect(message.toLowerCase(), code).not.toContain("charged");
      expect(message.toLowerCase(), code).not.toContain("refund");
      expect(message.toLowerCase(), code).not.toContain("automatically clear");
      expect(message.toLowerCase(), code).not.toContain("recovered");
    }
  });
});
