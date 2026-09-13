import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ImageRenderAttemptController,
  type ClientAttemptStore,
} from "../../lib/image-render-client-attempt";

const here = path.dirname(fileURLToPath(import.meta.url));
const contentStudioSource = readFileSync(
  path.resolve(here, "../ContentStudio.tsx"),
  "utf8"
);

function createMemoryStore(): ClientAttemptStore {
  const map = new Map<string, string>();
  return {
    get: (key) => map.get(key) ?? null,
    set: (key, value) => void map.set(key, value),
    remove: (key) => void map.delete(key),
  };
}

let mintCounter = 0;
function sequentialMint() {
  mintCounter += 1;
  return `lifecycle-token-${mintCounter}`;
}

const scope = {
  userId: 7,
  contentPostId: 13,
  intent: { provider: "ai" as const },
};

describe("ContentStudio attempt controller ownership (B2A wiring)", () => {
  it("keeps one controller instance across render boundaries (lazy-init ref pattern)", () => {
    // Mirrors ContentStudio.tsx:
    //   const premiumAttemptControllerRef = useRef<Controller | null>(null);
    //   if (premiumAttemptControllerRef.current === null) {
    //     premiumAttemptControllerRef.current = new ImageRenderAttemptController();
    //   }
    const ref: { current: ImageRenderAttemptController | null } = { current: null };
    const render = () => {
      if (ref.current === null) {
        ref.current = new ImageRenderAttemptController({
          store: createMemoryStore(),
          mint: sequentialMint,
        });
      }
      return ref.current;
    };

    const firstRender = render();
    const began = firstRender.beginAttempt(scope);
    expect(began.status).toBe("ready");

    // "Rerender": same instance, and its synchronous in-flight state survives.
    const secondRender = render();
    expect(secondRender).toBe(firstRender);
    if (began.status !== "ready") throw new Error("expected ready");
    expect(secondRender.isInFlight(began.storageKey)).toBe(true);
    expect(secondRender.beginAttempt(scope).status).toBe("blocked_in_flight");
  });

  it("wires beginAttempt before mutate and passes the token as clientAttemptId", () => {
    const submitIndex = contentStudioSource.indexOf("const submitPremiumAttempt");
    expect(submitIndex).toBeGreaterThan(-1);
    const beginIndex = contentStudioSource.indexOf(".beginAttempt(", submitIndex);
    const mutateIndex = contentStudioSource.indexOf(
      "generatePremiumLeafletMutation.mutate(",
      submitIndex
    );
    expect(beginIndex).toBeGreaterThan(submitIndex);
    expect(mutateIndex).toBeGreaterThan(beginIndex);
    expect(contentStudioSource).toContain("clientAttemptId: began.token");
    // Blocked attempts return before mutating.
    expect(contentStudioSource).toContain('if (!began || began.status !== "ready")');
  });

  it("wires outcome handlers to the controller lifecycle", () => {
    expect(contentStudioSource).toContain("premiumAttemptControllerRef.current?.succeed(attemptKey)");
    expect(contentStudioSource).toContain(
      "premiumAttemptControllerRef.current?.failDefinitive(attemptKey)"
    );
    expect(contentStudioSource).toContain(
      "premiumAttemptControllerRef.current?.failAmbiguous(attemptKey, variables.clientAttemptId)"
    );
    expect(contentStudioSource).toContain("classifyImageRenderAttemptError(err)");
  });

  it("resolves the user scope from auth.me without a sentinel", () => {
    expect(contentStudioSource).toContain("trpc.auth.me.useQuery");
    expect(contentStudioSource).toContain("typeof userId !== \"number\"");
    expect(contentStudioSource).not.toContain('userId ?? "anonymous"');
    expect(contentStudioSource).not.toContain("userId || 0");
  });
});

describe("ContentStudio B2B-4 machine-readable claim guidance wiring", () => {
  const lifecycleMarker = contentStudioSource.indexOf(
    "Token lifecycle: definitive pre-work rejections retire the token"
  );
  expect(lifecycleMarker).toBeGreaterThan(-1);
  const onErrorStart = contentStudioSource.lastIndexOf("onError:", lifecycleMarker);
  expect(onErrorStart).toBeGreaterThan(-1);
  const onErrorRegion = contentStudioSource.slice(
    onErrorStart,
    contentStudioSource.indexOf("const selectedIteration", lifecycleMarker)
  );

  it("routes claim outcomes through the guidance helper before the generic error chain", () => {
    expect(onErrorRegion).toContain("getImageRenderClaimErrorGuidance(err)");
    const guidanceToast = onErrorRegion.indexOf("toast.error(claimGuidance.message)");
    expect(guidanceToast).toBeGreaterThan(-1);
    // The claim-guidance branch runs before any generic toast handling.
    const genericToast = onErrorRegion.indexOf('code === "PAYMENT_REQUIRED"');
    expect(genericToast).toBeGreaterThan(guidanceToast);
    // The generic fallback chain is preserved for non-claim errors.
    expect(onErrorRegion).toContain("toast.error(message ||");
  });

  it("keeps the token lifecycle routing and never mints or resubmits from onError", () => {
    expect(onErrorRegion).toContain("classifyImageRenderAttemptError(err)");
    expect(onErrorRegion).toContain("premiumAttemptControllerRef.current?.failDefinitive(attemptKey)");
    expect(onErrorRegion).toContain(
      "premiumAttemptControllerRef.current?.failAmbiguous(attemptKey, variables.clientAttemptId)"
    );
    expect(onErrorRegion).not.toContain("beginAttempt(");
    expect(onErrorRegion).not.toContain(".mutate(");
    // A deliberate retry re-enters through the normal submit path.
    expect(contentStudioSource.indexOf("beginAttempt(")).toBeGreaterThan(-1);
  });

  it("contains no internal claim reasons, keys, tokens or identity fields", () => {
    for (const forbidden of [
      "ambiguous_deduction_blocked",
      "legacy_attempt_blocked",
      "completed_without_result",
      "linked_result_missing_or_mismatched",
      "completed_result_not_found",
      "ownerToken",
      "requestAttemptKey",
      "intentFingerprint",
      "deductionKey",
      "activeClaimKey",
      "claimId",
    ]) {
      expect(contentStudioSource).not.toContain(forbidden);
    }
    // Guidance copy is sourced from the client-attempt helper, never inline
    // prose carrying machine internals.
    expect(contentStudioSource).not.toContain("IMAGE_RENDER_CLAIM_BLOCKED");
  });
});
