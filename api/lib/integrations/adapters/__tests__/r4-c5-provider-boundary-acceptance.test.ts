import { describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";

import { createPlatformAdapterRegistry } from "../adapter-registry";
import { createFacebookAdapter, type FacebookAdapterDependencies } from "../facebook-adapter";
import {
  classifyProviderErrorMessage,
  derivePublicationOperationId,
  type PublicationOperationIdentity,
} from "../platform-adapter";
import {
  buildPublicationOperationState,
  resolvePublicationExecutionDisposition,
} from "../../../publish/publication-idempotency";
import {
  PUBLICATION_RETRY_DELAYS_MS,
  decidePublicationRecovery,
  resolvePublicationRetryDelayMs,
} from "../../../publish/publication-recovery-policy";
import {
  PUBLICATION_RECEIPT_SCHEMA_VERSION,
  buildPublicationReceipt,
  normalizePublicationReceipt,
} from "../../../publish/publication-receipt";
import {
  buildPublishPackage,
  type PublishPackage,
  type PublishPackageBuildInput,
} from "../../../publish/publish-package-builder";
import { publishPackageToAuthoritativeInput } from "../../../publish/publish-package-adapter-input";
import { assertPersistedPublishPackageIntact } from "../../../publish/publish-package-contract";
import { deriveCreativeArtifactLineageFingerprint } from "../../../creative/artifact-lineage";
import {
  AUTHORITATIVE_TEXT,
  expectNoNetworkCall,
  fakePublishFailure,
  fakePublishSuccess,
  installNoNetworkGuard,
  makeAuthoritativeInput,
} from "./test-utils";

/**
 * R4-C5 acceptance — provider publication boundary semantics, proven with
 * provider fakes/test doubles only. Every provider interaction below goes
 * through an injected `deps.publish` double; the no-network guard fails the
 * suite loudly if any test ever falls through to a live provider function.
 */

const QUEUE_ITEM_ID = 42;
const PLATFORM = "facebook";
const OPERATION_ID = `publication:${PLATFORM}:${QUEUE_ITEM_ID}`;
const PUBLISHED_AT = "2026-07-01T12:00:00.000Z";
const DECISION_NOW = new Date("2026-07-01T12:00:00.000Z");

// Distinctive token value: any assertion that a receipt/request/metadata
// string contains this value fails, proving no credential material leaks
// past the adapter boundary.
const DESTINATION = { accessToken: "decrypted-boundary-token-9f8e7d6c", pageId: "123456789" };

installNoNetworkGuard();

function buildAdapter(publish: NonNullable<FacebookAdapterDependencies["publish"]>) {
  return createFacebookAdapter({ publish });
}

function recoveryFor(provider: {
  category: "auth" | "validation" | "rate_limited" | "network" | "provider" | "unsupported";
  code: string;
  retryable: boolean;
}) {
  return decidePublicationRecovery({
    stage: "provider",
    now: DECISION_NOW,
    retryCount: 0,
    provider,
  });
}

// ─── Governed publish package fixture (mirrors publication-receipt.test.ts) ───

const HASH_A = "a".repeat(64);
const HASH_A2 = "a".repeat(63) + "b";
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);

const STRATEGY = {
  strategySnapshotId: "strategy_snapshot_1",
  strategyVersion: 3,
  businessDnaSnapshotId: "bdna_1",
  strategyHashSha256: HASH_A,
  strategyRunId: 55,
  approvalRequestId: 77,
  creativeBriefFingerprint: "brief_fp_1",
};

const APPROVED_COPY = {
  copyHashSha256: HASH_B,
  copySchemaVersion: "v2",
  approvedRevisionId: "rev-1",
  assessmentHashSha256: HASH_C,
  contextLockId: "ctx-1",
};

function captionLineage() {
  return {
    lineageSchemaVersion: 1,
    artifactKind: "caption_pack",
    artifactId: 501,
    lineageFingerprintSha256: deriveCreativeArtifactLineageFingerprint({
      artifactKind: "caption_pack",
      platform: null,
      parent: null,
      strategy: STRATEGY,
      approvedCopy: APPROVED_COPY,
    }),
    strategy: STRATEGY,
    approvedCopy: APPROVED_COPY,
  };
}

function governedInput(overrides: Record<string, unknown> = {}): PublishPackageBuildInput {
  return {
    campaignId: 7,
    userId: 9,
    businessId: 4,
    destination: { platform: PLATFORM, integrationId: 7 },
    intent: { mode: "immediate" },
    strategyAuthority: STRATEGY,
    approvedCopy: APPROVED_COPY,
    selectedContent: {
      contentPostId: 125,
      artifactKind: "content_post",
      lineage: {
        lineageSchemaVersion: 1,
        artifactKind: "content_post",
        artifactId: 125,
        lineageFingerprintSha256: HASH_D,
        strategy: STRATEGY,
        approvedCopy: APPROVED_COPY,
      },
    },
    captionArtifact: { artifactId: 501, artifactKind: "caption_pack", lineage: captionLineage() },
    evidence: { launchApprovalRequestId: 1 },
    payload: {
      text: AUTHORITATIVE_TEXT,
      mediaUrls: ["https://cdn.example.com/assets/spring-launch.png"],
      mediaType: "image",
    },
    ...overrides,
  } as PublishPackageBuildInput;
}

function buildGovernedPackage(): PublishPackage {
  return buildPublishPackage(governedInput());
}

function normalizedReceipt(overrides: Record<string, unknown> = {}) {
  return {
    operationId: OPERATION_ID,
    platform: PLATFORM,
    status: "published" as const,
    externalPostId: "ext_post_42",
    externalUrl: "https://provider.example/p/ext_post_42",
    ...overrides,
  };
}

describe("R4-C5 — provider publication boundary acceptance (provider fakes only)", () => {
  describe("A — operation identity and idempotent receipts", () => {
    it("1 — derives the operation id from the queue item identity BEFORE any provider call; stable across retries", async () => {
      // Identity is a pure derivation over durable coordinates — available
      // before the provider is ever touched, and identical on every retry.
      const operation: PublicationOperationIdentity = {
        operationId: derivePublicationOperationId({ platform: PLATFORM, queueItemId: QUEUE_ITEM_ID }),
      };
      expect(operation.operationId).toBe(OPERATION_ID);
      expect(
        derivePublicationOperationId({ platform: PLATFORM, queueItemId: QUEUE_ITEM_ID })
      ).toBe(operation.operationId);
      // A different queue item is a different operation.
      expect(derivePublicationOperationId({ platform: PLATFORM, queueItemId: 43 })).not.toBe(
        operation.operationId
      );

      const publish = vi
        .fn()
        .mockResolvedValueOnce(fakePublishFailure("ETIMEDOUT connection timed out"))
        .mockResolvedValueOnce(fakePublishSuccess());
      const adapter = buildAdapter(publish);
      const input = makeAuthoritativeInput(operation.operationId);
      const request = adapter.buildProviderRequest(input, DESTINATION);

      // The pre-derived identity is the identity the failure AND the later
      // successful retry are both submitted under — no provider call can
      // change it, no retry can regenerate it.
      await expect(adapter.publish(request, DESTINATION, input)).rejects.toMatchObject({
        operationId: operation.operationId,
        category: "network",
      });
      const receipt = await adapter.publish(request, DESTINATION, input);
      expect(receipt.operationId).toBe(operation.operationId);
      // Deriving again after execution still yields the same identity.
      expect(
        derivePublicationOperationId({ platform: PLATFORM, queueItemId: QUEUE_ITEM_ID })
      ).toBe(operation.operationId);
      expectNoNetworkCall();
    });

    it("2 — adapter success yields a normalized receipt carrying platform, operationId, status, externalPostId and externalUrl", async () => {
      const publish = vi.fn().mockResolvedValue(
        fakePublishSuccess({
          postId: "ext_post_42",
          url: "https://provider.example/p/ext_post_42",
        })
      );
      const adapter = buildAdapter(publish);
      const input = makeAuthoritativeInput(OPERATION_ID);
      const request = adapter.buildProviderRequest(input, DESTINATION);

      const receipt = await adapter.publish(request, DESTINATION, input);

      expect(receipt).toEqual({
        platform: PLATFORM,
        operationId: OPERATION_ID,
        status: "published",
        externalPostId: "ext_post_42",
        externalUrl: "https://provider.example/p/ext_post_42",
      });
      expectNoNetworkCall();
    });
  });

  describe("B — ambiguous and malformed provider outcomes fail closed", () => {
    it("3 — provider success with a crash before DB acknowledgement replays from the stored canonical receipt; the disposition layer authorizes no second provider call", async () => {
      // The provider call succeeded, but the process died before the success
      // was durably acknowledged. On re-entry the durable state is: published
      // queue row + stored canonical receipt. The idempotency authority must
      // answer replay_success from that receipt — a second provider call would
      // double-publish.
      const storedReceipt = buildPublicationReceipt({
        normalized: normalizedReceipt(),
        queueItemId: QUEUE_ITEM_ID,
        platform: PLATFORM,
        publishedAtIso: PUBLISHED_AT,
      });
      const state = buildPublicationOperationState({
        queue: {
          id: QUEUE_ITEM_ID,
          platform: PLATFORM,
          status: "published",
          retryCount: 0,
          maxRetries: 3,
          nextRetryAt: null,
          externalPostId: "ext_post_42",
          publishedAt: new Date(PUBLISHED_AT),
        },
        receipt: storedReceipt,
      });

      const publish = vi.fn().mockResolvedValue(fakePublishSuccess());
      const disposition = resolvePublicationExecutionDisposition(state);

      expect(disposition.outcome).toBe("replay_success");
      // Only "execute"/"retry" permit a provider call — replay_success never does.
      expect(disposition.outcome).not.toBe("execute");
      expect(disposition.outcome).not.toBe("retry");
      if (disposition.outcome === "replay_success") {
        expect(disposition.replayedWithoutProviderCall).toBe(true);
        expect(disposition.receipt).toEqual(storedReceipt);
        expect(disposition.receipt.operationId).toBe(OPERATION_ID);
        expect(disposition.receipt.status).toBe("published");
        expect(disposition.receipt.externalPostId).toBe("ext_post_42");
      }
      expect(publish).not.toHaveBeenCalled();
      expectNoNetworkCall();
    });

    it("4 — an ambiguous provider timeout classifies as network and the recovery policy authorizes a bounded retry under the same identity, never a fabricated success", async () => {
      // Timeout at the adapter boundary: classified retryable network, the
      // operation identity echoed so the retry is the SAME publication.
      const publish = vi.fn().mockResolvedValue(fakePublishFailure("ETIMEDOUT connection timed out"));
      const adapter = buildAdapter(publish);
      const input = makeAuthoritativeInput(OPERATION_ID);
      const request = adapter.buildProviderRequest(input, DESTINATION);

      await expect(adapter.publish(request, DESTINATION, input)).rejects.toMatchObject({
        operationId: OPERATION_ID,
        category: "network",
        code: "provider_network",
        retryable: true,
      });

      // Recovery policy: the ambiguous outcome maps to a re-attempt under the
      // same identity (action "retry") — not to any success fabrication. The
      // decision type has no success representation; a bounded retry with
      // callProviderAgain under the same operationId is the only forward path.
      const classified = classifyProviderErrorMessage("ETIMEDOUT connection timed out");
      expect(classified).toEqual({ category: "network", code: "provider_network", retryable: true });
      const decision = recoveryFor(classified);
      expect(decision).toMatchObject({
        recoveryClass: "network",
        action: "retry",
        retryable: true,
        callProviderAgain: true,
        terminal: false,
        terminalStatus: null,
        retryCount: 0,
        nextRetryCount: 1,
        delayMs: PUBLICATION_RETRY_DELAYS_MS[0],
        mutationAuthorized: false,
      });
      expect(decision.nextRetryAt).toEqual(
        new Date(DECISION_NOW.getTime() + PUBLICATION_RETRY_DELAYS_MS[0])
      );
      expectNoNetworkCall();
    });

    it("5 — a malformed provider response is rejected fail-closed with a validation classification, non-retryable", async () => {
      // Provider answered, but the payload is not a usable publication
      // result. The adapter fails closed through normalizeAdapterError:
      // deterministic classification, no retry of an identical doomed request.
      const publish = vi
        .fn()
        .mockResolvedValue(fakePublishFailure("400 Bad Request: invalid response body, missing required field postId"));
      const adapter = buildAdapter(publish);
      const input = makeAuthoritativeInput(OPERATION_ID);
      const request = adapter.buildProviderRequest(input, DESTINATION);

      await expect(adapter.publish(request, DESTINATION, input)).rejects.toMatchObject({
        platform: PLATFORM,
        operationId: OPERATION_ID,
        category: "validation",
        code: "provider_validation",
        retryable: false,
      });

      // Policy level: a validation-classified provider rejection is a
      // provider_rejection — terminal, no further provider call.
      const decision = recoveryFor({
        category: "validation",
        code: "provider_validation",
        retryable: false,
      });
      expect(decision).toMatchObject({
        recoveryClass: "provider_rejection",
        action: "fail_terminal",
        retryable: false,
        callProviderAgain: false,
        terminal: true,
        terminalStatus: "failed",
      });
      expectNoNetworkCall();
    });

    it("6 — rejected credentials classify as auth, are non-retryable, and recover through reconnect — never a silent retry", async () => {
      const publish = vi.fn().mockResolvedValue(fakePublishFailure("401 Unauthorized: invalid token"));
      const adapter = buildAdapter(publish);
      const input = makeAuthoritativeInput(OPERATION_ID);
      const request = adapter.buildProviderRequest(input, DESTINATION);

      await expect(adapter.publish(request, DESTINATION, input)).rejects.toMatchObject({
        platform: PLATFORM,
        operationId: OPERATION_ID,
        category: "auth",
        code: "provider_auth",
        retryable: false,
      });

      const decision = recoveryFor({ category: "auth", code: "provider_auth", retryable: false });
      expect(decision.action).toBe("reconnect");
      expect(decision).toMatchObject({
        recoveryClass: "auth",
        retryable: false,
        callProviderAgain: false,
        terminal: true,
        terminalStatus: "failed",
        retryCount: 0,
        nextRetryCount: 0, // fail-fast: auth failures never consume retry budget
      });
      expect(decision.action).not.toBe("retry");
      expectNoNetworkCall();
    });
  });

  describe("C — retry and duplicate execution converge on one identity", () => {
    it("7 — a retry after a transient network failure re-enters under the SAME operation id, and the recovery policy consumes retry budget exactly per PUBLICATION_RETRY_DELAYS_MS", async () => {
      // The canonical schedule: ordinal 1→1min, 2→5min, 3→15min, clamped.
      expect(resolvePublicationRetryDelayMs(1)).toBe(PUBLICATION_RETRY_DELAYS_MS[0]);
      expect(resolvePublicationRetryDelayMs(2)).toBe(PUBLICATION_RETRY_DELAYS_MS[1]);
      expect(resolvePublicationRetryDelayMs(3)).toBe(PUBLICATION_RETRY_DELAYS_MS[2]);
      expect(resolvePublicationRetryDelayMs(4)).toBe(PUBLICATION_RETRY_DELAYS_MS[2]);

      const networkFailure = { category: "network" as const, code: "provider_network", retryable: true };
      const publish = vi
        .fn()
        .mockResolvedValueOnce(fakePublishFailure("ETIMEDOUT connection timed out"))
        .mockResolvedValueOnce(
          fakePublishSuccess({
            postId: "ext_post_42",
            url: "https://provider.example/p/ext_post_42",
          })
        );
      const adapter = buildAdapter(publish);
      const input = makeAuthoritativeInput(OPERATION_ID);
      const request = adapter.buildProviderRequest(input, DESTINATION);

      // Attempt 1: transient network failure under the operation identity.
      await expect(adapter.publish(request, DESTINATION, input)).rejects.toMatchObject({
        operationId: OPERATION_ID,
        category: "network",
        retryable: true,
      });
      const firstDecision = decidePublicationRecovery({
        stage: "provider",
        now: DECISION_NOW,
        retryCount: 0,
        provider: networkFailure,
      });
      expect(firstDecision).toMatchObject({
        action: "retry",
        nextRetryCount: 1,
        delayMs: PUBLICATION_RETRY_DELAYS_MS[0],
      });
      expect(firstDecision.nextRetryAt).toEqual(
        new Date(DECISION_NOW.getTime() + PUBLICATION_RETRY_DELAYS_MS[0])
      );

      // Attempt 2: re-enters under the SAME operation id and succeeds.
      const receipt = await adapter.publish(request, DESTINATION, input);
      expect(receipt.operationId).toBe(OPERATION_ID);
      expect(receipt.status).toBe("published");
      expect(publish).toHaveBeenCalledTimes(2);
      // Both submissions transported the identical authoritative copy.
      expect(publish).toHaveBeenLastCalledWith(
        DESTINATION.accessToken,
        DESTINATION.pageId,
        expect.objectContaining({ text: AUTHORITATIVE_TEXT })
      );

      // Budget consumed exactly per schedule: attempt ordinal 2 waits the
      // second slot; the slot after the last budgeted attempt escalates.
      const secondDecision = decidePublicationRecovery({
        stage: "provider",
        now: DECISION_NOW,
        retryCount: 1,
        provider: networkFailure,
      });
      expect(secondDecision).toMatchObject({
        action: "retry",
        nextRetryCount: 2,
        delayMs: PUBLICATION_RETRY_DELAYS_MS[1],
      });
      expect(secondDecision.nextRetryAt).toEqual(
        new Date(DECISION_NOW.getTime() + PUBLICATION_RETRY_DELAYS_MS[1])
      );
      const exhaustedDecision = decidePublicationRecovery({
        stage: "provider",
        now: DECISION_NOW,
        retryCount: 2,
        provider: networkFailure,
      });
      expect(exhaustedDecision).toMatchObject({
        action: "escalate",
        terminal: true,
        terminalStatus: "failed",
        nextRetryCount: 3,
        callProviderAgain: false,
        delayMs: null,
        nextRetryAt: null,
      });
      expectNoNetworkCall();
    });

    it("8 — duplicate worker executions converge: two adapter calls under the same operation id both produce same-operationId receipts", async () => {
      // Two executions of the same queue item (e.g. a duplicate worker
      // delivery) submit under one operation identity; receipt identity is
      // therefore idempotent under duplicate execution. The durable
      // published-claim arbitration — which of the two executions owns the
      // queue row's guarded UPDATE — belongs to the publishing runner; see
      // api/lib/workflow/__tests__/publishing-runner-wbs13-wiring.test.ts.
      const publish = vi
        .fn()
        .mockResolvedValue(
          fakePublishSuccess({
            postId: "ext_post_42",
            url: "https://provider.example/p/ext_post_42",
          })
        );
      const adapter = buildAdapter(publish);
      const input = makeAuthoritativeInput(OPERATION_ID);
      const request = adapter.buildProviderRequest(input, DESTINATION);

      const [first, second] = await Promise.all([
        adapter.publish(request, DESTINATION, input),
        adapter.publish(request, DESTINATION, input),
      ]);

      expect(publish).toHaveBeenCalledTimes(2);
      expect(first.operationId).toBe(OPERATION_ID);
      expect(second.operationId).toBe(OPERATION_ID);
      expect(second).toEqual(first);
      expectNoNetworkCall();
    });
  });

  describe("D — governance at the provider boundary", () => {
    it("9 — a receipt built against a tampered publish package is rejected fail-closed by buildPublicationReceipt", () => {
      const pkg = buildGovernedPackage();
      // Tamper: fingerprint no longer matches the package's own identity.
      const tampered = { ...pkg, packageFingerprintSha256: HASH_A2 };
      expect(() => assertPersistedPublishPackageIntact(tampered as PublishPackage)).toThrow(
        TRPCError
      );
      expect(() =>
        buildPublicationReceipt({
          normalized: normalizedReceipt(),
          queueItemId: QUEUE_ITEM_ID,
          platform: PLATFORM,
          publishedAtIso: PUBLISHED_AT,
          publishPackage: tampered as PublishPackage,
        })
      ).toThrow(TRPCError);

      // Sanity: the intact package still builds a governed receipt recording
      // its identity — the gate blocks only the tampered one.
      const receipt = buildPublicationReceipt({
        normalized: normalizedReceipt(),
        queueItemId: QUEUE_ITEM_ID,
        platform: PLATFORM,
        publishedAtIso: PUBLISHED_AT,
        publishPackage: pkg,
      });
      expect(receipt.classification).toBe("governed");
      expect(receipt.publishPackageId).toBe(pkg.packageId);
      expect(receipt.packageFingerprintSha256).toBe(pkg.packageFingerprintSha256);
    });

    it("10 — an unsupported provider resolves to a normalized provider_unsupported error, non-retryable", () => {
      const registry = createPlatformAdapterRegistry();

      expect(() => registry.resolve("pinterest")).toThrowError();
      let caught: unknown;
      try {
        registry.resolve("pinterest");
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({
        platform: "pinterest",
        category: "unsupported",
        code: "provider_unsupported",
        retryable: false,
      });
      expect((caught as { message: string }).message).toMatch(/not supported/);

      // Policy level: unsupported is a provider_rejection — terminal, the
      // runner must not keep calling an unmapped provider.
      const decision = recoveryFor({
        category: "unsupported",
        code: "provider_unsupported",
        retryable: false,
      });
      expect(decision).toMatchObject({
        recoveryClass: "provider_rejection",
        action: "fail_terminal",
        retryable: false,
        callProviderAgain: false,
        terminal: true,
      });
    });

    it("11 — the normalized receipt and operation metadata expose no credential material", async () => {
      const sensitiveKeyPattern = /token|secret|password|credential/i;
      const pkg = buildGovernedPackage();

      // The package → adapter-input seam carries content + identity only.
      const input = publishPackageToAuthoritativeInput(pkg, QUEUE_ITEM_ID);
      expect(input.operationId).toBe(OPERATION_ID);
      expect(Object.keys(input).sort()).toEqual(["content", "operationId"]);
      for (const key of Object.keys(input.content)) {
        expect(key).not.toMatch(sensitiveKeyPattern);
      }

      // Operation metadata is exactly one identity field.
      const operation: PublicationOperationIdentity = { operationId: input.operationId };
      expect(Object.keys(operation)).toEqual(["operationId"]);

      // The provider request embeds routing + authoritative content only; the
      // decrypted token travels solely as the separate destination argument
      // to publish() — the existing auth seam.
      const publish = vi
        .fn()
        .mockResolvedValue(
          fakePublishSuccess({
            postId: "ext_post_42",
            url: "https://provider.example/p/ext_post_42",
          })
        );
      const adapter = buildAdapter(publish);
      const request = adapter.buildProviderRequest(input, DESTINATION);
      expect(Object.keys(request).sort()).toEqual(["content", "pageId"]);
      expect(JSON.stringify(request)).not.toContain(DESTINATION.accessToken);

      const receipt = await adapter.publish(request, DESTINATION, input);

      // No field named like credential material…
      for (const key of Object.keys(receipt)) {
        expect(key).not.toMatch(sensitiveKeyPattern);
      }
      // …and no credential VALUE anywhere in the receipt or the operation
      // metadata, even though the token legitimately entered publish().
      expect(JSON.stringify(receipt)).not.toContain(DESTINATION.accessToken);
      expect(JSON.stringify(operation)).not.toContain(DESTINATION.accessToken);
      expect(publish).toHaveBeenCalledWith(
        DESTINATION.accessToken,
        DESTINATION.pageId,
        expect.objectContaining({ text: AUTHORITATIVE_TEXT })
      );
      expectNoNetworkCall();
    });

    it("12 — a receipt string field containing a token-like pattern is rejected by normalizePublicationReceipt", async () => {
      const validLegacy = {
        schemaVersion: PUBLICATION_RECEIPT_SCHEMA_VERSION,
        operationId: OPERATION_ID,
        queueItemId: QUEUE_ITEM_ID,
        platform: PLATFORM,
        status: "published",
        externalPostId: "ext_post_42",
        externalUrl: "https://provider.example/p/ext_post_42",
        publishedAtIso: PUBLISHED_AT,
        classification: "legacy",
        publishPackageId: null,
        packageFingerprintSha256: null,
        receivedAtIso: null,
      };
      // Mirrors the sensitive-pattern cases from publication-receipt.test.ts.
      expect(() =>
        normalizePublicationReceipt({
          ...validLegacy,
          externalUrl: "https://graph.facebook.com/v19/me?access_token=EAAGsecret",
        })
      ).toThrow(/sensitive material/);
      expect(() =>
        normalizePublicationReceipt({
          ...validLegacy,
          externalPostId: "post_123_session_cookie_abc",
        })
      ).toThrow(/sensitive material/);

      // Same leak through the adapter boundary: a provider-returned URL
      // carrying a token must not survive into a durable publication receipt.
      const publish = vi
        .fn()
        .mockResolvedValue(
          fakePublishSuccess({
            postId: "ext_post_42",
            url: "https://graph.facebook.com/v19/me?access_token=EAAGsecret",
          })
        );
      const adapter = buildAdapter(publish);
      const input = makeAuthoritativeInput(OPERATION_ID);
      const request = adapter.buildProviderRequest(input, DESTINATION);
      const normalized = await adapter.publish(request, DESTINATION, input);
      expect(normalized.externalUrl).toContain("access_token=");
      expect(() =>
        buildPublicationReceipt({
          normalized,
          queueItemId: QUEUE_ITEM_ID,
          platform: PLATFORM,
          publishedAtIso: PUBLISHED_AT,
        })
      ).toThrow(/sensitive material/);
      expectNoNetworkCall();
    });
  });
});
