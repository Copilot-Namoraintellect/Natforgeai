import { describe, it, expect } from "vitest";
import { createHash } from "crypto";
import type { ApprovedLearningStrategyInput } from "../learning/learning-strategy-consumption";
import { buildNextCycleIdentity } from "../learning/learning-strategy-consumption";
import { triggerNextCycleAfterLearningPromotion } from "./next-cycle-trigger";

const STRATEGY_HASH = createHash("sha256").update("strategy-material").digest("hex");
const FP_A = createHash("sha256").update("proposal-a").digest("hex");
const FP_B = createHash("sha256").update("proposal-b").digest("hex");

function getTableName(table: unknown): string | undefined {
  return (table as Record<symbol, unknown>)[Symbol.for("drizzle:Name") as symbol] as
    | string
    | undefined;
}

interface FakeRead {
  table: string;
  row: Record<string, unknown> | undefined;
}

function createFakeExecutor(reads: FakeRead[]) {
  const updateCalls: Array<{ set: unknown }> = [];
  let pendingReads = [...reads];

  const executor = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async (_n: number) => {
            const name = getTableName(table) ?? "";
            const index = pendingReads.findIndex(r => r.table === name);
            if (index < 0) return [];
            const [entry] = pendingReads.splice(index, 1);
            return entry.row ? [entry.row] : [];
          },
        }),
      }),
    }),
    update: () => ({
      set: (setPayload: unknown) => ({
        where: async (_conds: unknown) => {
          updateCalls.push({ set: setPayload });
          return [{ affectedRows: 1 }];
        },
      }),
    }),
  } as never;

  return { executor, updateCalls };
}

function approvedInput(fingerprints: string[]): ApprovedLearningStrategyInput {
  return {
    scope: "same-campaign",
    businessId: null,
    promotions: fingerprints.map(proposalFingerprint => ({ proposalFingerprint })),
  } as unknown as ApprovedLearningStrategyInput;
}

function campaignWithContext(workflowContext: unknown): FakeRead {
  return { table: "campaigns", row: { id: 7, userId: 22, workflowContext } };
}

const HASH_CONTEXT = { strategyHashSha256: STRATEGY_HASH };

describe("triggerNextCycleAfterLearningPromotion", () => {
  it("persists a ready instruction carrying the deterministic identity", async () => {
    const fake = createFakeExecutor([
      campaignWithContext(HASH_CONTEXT),
      campaignWithContext(HASH_CONTEXT),
    ]);

    const result = await triggerNextCycleAfterLearningPromotion({
      userId: 22,
      campaignId: 7,
      deps: {
        executor: fake.executor,
        resolveApprovedPromotions: async () => approvedInput([FP_A, FP_B]),
      },
    });

    const expectedIdentity = buildNextCycleIdentity({
      campaignId: 7,
      strategyHashSha256: STRATEGY_HASH,
      proposalFingerprints: [FP_A, FP_B],
    });

    expect(result).toEqual({ outcome: "created", instructionId: expectedIdentity });
    expect(fake.updateCalls).toHaveLength(1);
    const written = fake.updateCalls[0].set as { workflowContext: Record<string, unknown> };
    expect(written.workflowContext.nextCycle).toEqual({
      instructionId: expectedIdentity,
      status: "ready",
    });
  });

  it("replays identical material without creating another cycle regardless of fingerprint order", async () => {
    const identity = buildNextCycleIdentity({
      campaignId: 7,
      strategyHashSha256: STRATEGY_HASH,
      proposalFingerprints: [FP_A, FP_B],
    });
    const fake = createFakeExecutor([
      campaignWithContext(HASH_CONTEXT),
      campaignWithContext(HASH_CONTEXT),
      campaignWithContext(HASH_CONTEXT),
      campaignWithContext({
        ...HASH_CONTEXT,
        nextCycle: { instructionId: identity, status: "ready" },
      }),
    ]);
    let call = 0;
    const resolveApprovedPromotions = async () => {
      call += 1;
      // Different order across calls must still produce the same identity.
      return approvedInput(call === 1 ? [FP_A, FP_B] : [FP_B, FP_A]);
    };

    const first = await triggerNextCycleAfterLearningPromotion({
      userId: 22,
      campaignId: 7,
      deps: { executor: fake.executor, resolveApprovedPromotions },
    });
    const second = await triggerNextCycleAfterLearningPromotion({
      userId: 22,
      campaignId: 7,
      deps: { executor: fake.executor, resolveApprovedPromotions },
    });

    expect(first?.outcome).toBe("created");
    expect(second).toEqual({ outcome: "already_present", instructionId: first!.instructionId });
    // Exactly one durable write across both triggers.
    expect(fake.updateCalls).toHaveLength(1);
  });

  it("does not trigger when nothing is durably approved", async () => {
    const fake = createFakeExecutor([campaignWithContext(HASH_CONTEXT)]);

    const result = await triggerNextCycleAfterLearningPromotion({
      userId: 22,
      campaignId: 7,
      deps: {
        executor: fake.executor,
        resolveApprovedPromotions: async () => approvedInput([]),
      },
    });

    expect(result).toEqual({ outcome: "no_approved_promotions" });
    expect(fake.updateCalls).toHaveLength(0);
  });

  it("returns null for a missing or wrong-owner campaign", async () => {
    const fake = createFakeExecutor([{ table: "campaigns", row: undefined }]);
    let resolved = 0;

    const result = await triggerNextCycleAfterLearningPromotion({
      userId: 22,
      campaignId: 404,
      deps: {
        executor: fake.executor,
        resolveApprovedPromotions: async () => {
          resolved += 1;
          return approvedInput([FP_A]);
        },
      },
    });

    expect(result).toBeNull();
    expect(resolved).toBe(0);
    expect(fake.updateCalls).toHaveLength(0);
  });

  it("fails closed when the campaign has no authoritative strategy hash", async () => {
    const fake = createFakeExecutor([campaignWithContext({ strategyGeneratedAt: "2026-06-12T00:00:00.000Z" })]);

    await expect(
      triggerNextCycleAfterLearningPromotion({
        userId: 22,
        campaignId: 7,
        deps: {
          executor: fake.executor,
          resolveApprovedPromotions: async () => approvedInput([FP_A]),
        },
      })
    ).rejects.toThrow(/strategyHashSha256/);
    expect(fake.updateCalls).toHaveLength(0);
  });

  it("fails closed when a different instruction is already pending", async () => {
    const fake = createFakeExecutor([
      campaignWithContext(HASH_CONTEXT),
      campaignWithContext({
        ...HASH_CONTEXT,
        nextCycle: { instructionId: "next-cycle:v1:other", status: "ready" },
      }),
    ]);

    await expect(
      triggerNextCycleAfterLearningPromotion({
        userId: 22,
        campaignId: 7,
        deps: {
          executor: fake.executor,
          resolveApprovedPromotions: async () => approvedInput([FP_A]),
        },
      })
    ).rejects.toThrow(/different next-cycle instruction/);
    expect(fake.updateCalls).toHaveLength(0);
  });
});
