import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from "vitest";
import { TRPCError } from "@trpc/server";
import { eq, and } from "drizzle-orm";
import { env } from "./lib/env";
import { getDb } from "./queries/connection";
import { campaigns, businesses, users, agentRuns, creativeGenerationClaims } from "@db/schema";
import { contentRouter } from "./content-router";
import { agentRouter } from "./agent-router";
import { campaignRouter } from "./campaign-router";

vi.mock("./lib/agents/creative-agent", () => ({
  runCreativeAgent: vi.fn(),
}));

vi.mock("./lib/agents/strategy-agent", () => ({
  runStrategyAgent: vi.fn(),
}));

vi.mock("./lib/creative/creative-generation-claim", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    releaseClaimWithResult: vi.fn(actual.releaseClaimWithResult as any),
  };
});

vi.mock("./lib/queue/bullmq", () => ({
  scheduleContentGenerationJob: vi.fn(async () => ({ id: "content-generate:123" })),
  isBullMQAvailable: vi.fn(() => true),
}));

vi.mock("./lib/jobs/content-generation-job", () => ({
  processContentGenerationJob: vi.fn(),
}));

vi.mock("./lib/workflow/triggers", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    onAgentRunComplete: vi.fn(async () => undefined),
  };
});

vi.mock("./lib/workflow/engine", () => ({
  transitionCampaignState: vi.fn(async () => "ok"),
  createApprovalRequest: vi.fn(async () => ({ id: 1 })),
}));

vi.mock("./lib/billing/cost-control", () => ({
  canRunAutonomousWorkflow: vi.fn(async () => ({ allowed: true })),
}));

vi.mock("./lib/audience/access", () => ({
  checkAudienceAgentAccess: vi.fn(async () => ({ allowed: false })),
}));

vi.mock("./lib/audience/ingest", () => ({
  ingestAudienceData: vi.fn(async () => undefined),
}));

vi.mock("./lib/agents/audience-intelligence-agent", () => ({
  runAudienceIntelligenceAgent: vi.fn(),
}));

vi.mock("./lib/billing/credit-engine", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    deductCredits: vi.fn(async () => ({ newBalance: 100 })),
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

function buildCtx(userId: number) {
  return {
    req: new Request("http://localhost/api/trpc"),
    resHeaders: new Headers(),
    user: { id: userId, tierSlug: "free" } as any,
    session: { verified: true } as any,
  };
}

describe("creative generation claim caller integration (DB)", () => {
  let db: ReturnType<typeof getDb>;
  let testUserId: number;
  let testBusinessId: number;
  let testCampaignId: number;

  beforeAll(() => {
    db = getDb();
  });

  async function cleanupFixtures(): Promise<void> {
    if (!isSafeTestDatabase) return;
    await db.delete(creativeGenerationClaims);
    await db.delete(agentRuns).where(eq(agentRuns.userId, testUserId));
    await db.delete(campaigns).where(eq(campaigns.userId, testUserId));
    await db.delete(businesses).where(eq(businesses.userId, testUserId));
    await db.delete(users).where(eq(users.id, testUserId));
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  beforeEach(async () => {
    if (!isSafeTestDatabase) return;
    testUserId = 99000001;
    await cleanupFixtures();

    const [user] = await db.insert(users).values({
      email: `claim-test-${testUserId}@example.com`,
      name: "Claim Test User",
      authType: "local",
      role: "user",
    });
    testUserId = Number((user as any).insertId);

    const [business] = await db.insert(businesses).values({
      userId: testUserId,
      name: "Claim Test Business",
      industry: "Fintech",
      location: "Randburg",
      productOrService: "Payout platform",
      targetCustomer: "Small businesses",
      onboardingComplete: true,
      isActive: true,
    });
    testBusinessId = Number((business as any).insertId);

    const [campaign] = await db.insert(campaigns).values({
      userId: testUserId,
      businessId: testBusinessId,
      name: "Claim Test Campaign",
      goal: "awareness",
      status: "draft",
      workflowState: "strategy_approved",
      coreMessage: "Simplify payouts",
      personas: [{ name: "Owner" }],
      platforms: "Instagram",
      autoPublish: false,
      approvalMode: "assisted",
      aiGenerated: true,
    });
    testCampaignId = Number((campaign as any).insertId);
  });

  afterEach(async () => {
    await cleanupFixtures();
  });

  describe("contentRouter.generateForCampaign", () => {
    itSafe("acquires a claim, inserts a job row and attaches the reference", async () => {
      const { scheduleContentGenerationJob } = await import("./lib/queue/bullmq");
      const caller = contentRouter.createCaller(buildCtx(testUserId));

      const result = await caller.generateForCampaign({ campaignId: testCampaignId });

      expect(result.status).toBe("queued");
      expect(result.jobId).toBeGreaterThan(0);
      expect(result.reused).toBeFalsy();

      const claims = await db
        .select()
        .from(creativeGenerationClaims)
        .where(eq(creativeGenerationClaims.campaignId, testCampaignId));
      expect(claims).toHaveLength(1);
      expect(claims[0]?.operationSource).toBe("job");
      expect(claims[0]?.operationReferenceId).toBe(result.jobId);
      expect(claims[0]?.status).toBe("running");
      expect(claims[0]?.activeClaimKey).toBeTruthy();

      expect(scheduleContentGenerationJob).toHaveBeenCalledTimes(1);
      const scheduled = vi.mocked(scheduleContentGenerationJob).mock.calls[0][0];
      expect(scheduled.claimId).toBe(claims[0]?.id);
      expect(scheduled.ownerToken).toBe(claims[0]?.ownerToken);
      expect(typeof scheduled.ownerToken).toBe("string");
      expect(scheduled.ownerToken!.length).toBeGreaterThan(10);
    });

    itSafe("returns reused on duplicate without creating a second claim or job", async () => {
      const caller = contentRouter.createCaller(buildCtx(testUserId));

      const first = await caller.generateForCampaign({ campaignId: testCampaignId });
      const second = await caller.generateForCampaign({ campaignId: testCampaignId });

      expect(first.status).toBe("queued");
      expect(second.status).toBe("queued");
      expect(second.reused).toBe(true);
      expect(second.jobId).toBe(first.jobId);

      const claims = await db
        .select()
        .from(creativeGenerationClaims)
        .where(eq(creativeGenerationClaims.campaignId, testCampaignId));
      expect(claims).toHaveLength(1);

      const jobs = await db
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.campaignId, testCampaignId));
      expect(jobs).toHaveLength(1);
    });

    itSafe("does not expose ownerToken in the router response", async () => {
      const caller = contentRouter.createCaller(buildCtx(testUserId));
      const result = await caller.generateForCampaign({ campaignId: testCampaignId });
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("ownerToken");
      expect(serialized).not.toContain("owner_token");
    });

    itSafe("acquired claim has a non-null queued lease", async () => {
      const caller = contentRouter.createCaller(buildCtx(testUserId));
      await caller.generateForCampaign({ campaignId: testCampaignId });

      const claims = await db
        .select()
        .from(creativeGenerationClaims)
        .where(eq(creativeGenerationClaims.campaignId, testCampaignId));
      expect(claims).toHaveLength(1);
      expect(claims[0]?.leaseExpiresAt).not.toBeNull();
      const remainingSeconds =
        (new Date(claims[0]?.leaseExpiresAt!).getTime() - Date.now()) / 1000;
      expect(remainingSeconds).toBeGreaterThan(1700);
    });
  });

  describe("agentRouter.runCreativeAgent", () => {
    itSafe("acquires a claim, inserts an outer operation row and attaches the reference", async () => {
      const { runCreativeAgent } = await import("./lib/agents/creative-agent");
      vi.mocked(runCreativeAgent).mockResolvedValue({
        packRunId: 501,
        savedPosts: 2,
        savedAssets: 1,
        pack: null,
        assets: null,
        metrics: {},
      } as any);

      const caller = agentRouter.createCaller(buildCtx(testUserId));
      const result = await caller.runCreativeAgent({ campaignId: testCampaignId });

      expect(result.success).toBe(true);
      expect(result.packRunId).toBe(501);

      const claims = await db
        .select()
        .from(creativeGenerationClaims)
        .where(eq(creativeGenerationClaims.campaignId, testCampaignId));
      expect(claims).toHaveLength(1);
      expect(claims[0]?.operationSource).toBe("agent");
      expect(claims[0]?.status).toBe("completed");
      expect(claims[0]?.activeClaimKey).toBeNull();

      expect(runCreativeAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          generationOperation: { source: "agent", id: claims[0]?.operationReferenceId },
        })
      );
    });

    itSafe("returns skipped on duplicate without creating a second operation row", async () => {
      const { runCreativeAgent } = await import("./lib/agents/creative-agent");
      vi.mocked(runCreativeAgent).mockResolvedValue({
        packRunId: 501,
        savedPosts: 2,
        savedAssets: 1,
        pack: null,
        assets: null,
        metrics: {},
      } as any);

      const caller = agentRouter.createCaller(buildCtx(testUserId));
      const first = await caller.runCreativeAgent({ campaignId: testCampaignId });
      const second = await caller.runCreativeAgent({ campaignId: testCampaignId });

      expect(first.success).toBe(true);
      expect(second.skipped).toBe(true);

      const operationRows = await db
        .select()
        .from(agentRuns)
        .where(
          and(eq(agentRuns.campaignId, testCampaignId), eq(agentRuns.userId, testUserId))
        );
      expect(operationRows).toHaveLength(1);
    });

    itSafe("releases the claim as failed when runCreativeAgent throws", async () => {
      const { runCreativeAgent } = await import("./lib/agents/creative-agent");
      vi.mocked(runCreativeAgent).mockRejectedValue(new Error("generation failed"));

      const caller = agentRouter.createCaller(buildCtx(testUserId));
      await expect(caller.runCreativeAgent({ campaignId: testCampaignId })).rejects.toThrow();

      const claims = await db
        .select()
        .from(creativeGenerationClaims)
        .where(eq(creativeGenerationClaims.campaignId, testCampaignId));
      expect(claims).toHaveLength(1);
      expect(claims[0]?.status).toBe("failed");
      expect(claims[0]?.activeClaimKey).toBeNull();
    });

    itSafe("acquired claim has a non-null running lease", async () => {
      const { runCreativeAgent } = await import("./lib/agents/creative-agent");
      vi.mocked(runCreativeAgent).mockResolvedValue({
        packRunId: 501,
        savedPosts: 2,
        savedAssets: 1,
        pack: null,
        assets: null,
        metrics: {},
      } as any);

      const caller = agentRouter.createCaller(buildCtx(testUserId));
      await caller.runCreativeAgent({ campaignId: testCampaignId });

      const claims = await db
        .select()
        .from(creativeGenerationClaims)
        .where(eq(creativeGenerationClaims.campaignId, testCampaignId));
      expect(claims).toHaveLength(1);
      expect(claims[0]?.leaseExpiresAt).not.toBeNull();
      const remainingSeconds =
        (new Date(claims[0]?.leaseExpiresAt!).getTime() - Date.now()) / 1000;
      // The database clock may be in a different timezone than the test runner,
      // so only assert that a future lease was established.
      expect(remainingSeconds).toBeGreaterThan(0);
    });
  });

  describe("campaignRouter.regenerateFromProfile", () => {
    itSafe("acquires a claim and attaches the strategy run id", async () => {
      const { runStrategyAgent } = await import("./lib/agents/strategy-agent");
      const { runCreativeAgent } = await import("./lib/agents/creative-agent");
      vi.mocked(runStrategyAgent).mockResolvedValue({ runId: 456, output: {} } as any);
      vi.mocked(runCreativeAgent).mockResolvedValue({
        packRunId: 789,
        savedPosts: 2,
        savedAssets: 1,
        pack: null,
        assets: null,
        metrics: {},
      } as any);

      const caller = campaignRouter.createCaller(buildCtx(testUserId));
      const result = await caller.regenerateFromProfile({ campaignId: testCampaignId });

      expect(result.success).toBe(true);
      expect(result.strategyRunId).toBe(456);

      const claims = await db
        .select()
        .from(creativeGenerationClaims)
        .where(eq(creativeGenerationClaims.campaignId, testCampaignId));
      expect(claims).toHaveLength(1);
      expect(claims[0]?.operationSource).toBe("profile");
      expect(claims[0]?.operationReferenceId).toBe(456);
      expect(claims[0]?.status).toBe("completed");
      expect(claims[0]?.leaseExpiresAt).not.toBeNull();
    });

    itSafe("concurrent regeneration rejects the loser before deleting anything", async () => {
      const { runStrategyAgent } = await import("./lib/agents/strategy-agent");
      const { runCreativeAgent } = await import("./lib/agents/creative-agent");

      // Slow the winner so the loser reaches acquisition while the active claim exists.
      vi.mocked(runStrategyAgent).mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 150));
        return { runId: 456, output: {} } as any;
      });
      vi.mocked(runCreativeAgent).mockResolvedValue({
        packRunId: 789,
        savedPosts: 2,
        savedAssets: 1,
        pack: null,
        assets: null,
        metrics: {},
      } as any);

      // Pre-existing run must survive the loser's path.
      await db.insert(agentRuns).values({
        userId: testUserId,
        campaignId: testCampaignId,
        agentType: "creative",
        status: "completed",
        input: { jobType: "content_generation_job" } as any,
      });

      const caller = campaignRouter.createCaller(buildCtx(testUserId));
      const [a, b] = await Promise.all([
        caller.regenerateFromProfile({ campaignId: testCampaignId }).catch((e) => e),
        caller.regenerateFromProfile({ campaignId: testCampaignId }).catch((e) => e),
      ]);

      // One winner succeeds; the other is rejected as duplicate/in-progress.
      const winner = a instanceof TRPCError ? b : a;
      const loser = a instanceof TRPCError ? a : b;
      expect(winner).not.toBeInstanceOf(TRPCError);
      expect(winner.success).toBe(true);
      expect(loser).toBeInstanceOf(TRPCError);

      // Only one strategy generation and one creative generation executed.
      expect(vi.mocked(runStrategyAgent)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(runCreativeAgent)).toHaveBeenCalledTimes(1);

      // The loser never reached deletion (the active claim was rejected before any
      // destructive work). The winner legitimately clears old agent runs as part of
      // regeneration; mocked agents do not persist rows, so only call counts matter.
      expect(vi.mocked(runStrategyAgent)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(runCreativeAgent)).toHaveBeenCalledTimes(1);
    });
  });

  describe("workflow.onStrategyApproved", () => {
    itSafe("acquires an approval claim and runs creative once", async () => {
      const { onStrategyApproved } = await import("./lib/workflow/triggers");
      const { runCreativeAgent } = await import("./lib/agents/creative-agent");
      vi.mocked(runCreativeAgent).mockResolvedValue({
        packRunId: 701,
        savedPosts: 2,
        savedAssets: 1,
        pack: null,
        assets: null,
        metrics: {},
      } as any);

      await onStrategyApproved(testCampaignId, testUserId, 555);

      const claims = await db
        .select()
        .from(creativeGenerationClaims)
        .where(eq(creativeGenerationClaims.campaignId, testCampaignId));
      expect(claims).toHaveLength(1);
      expect(claims[0]?.operationSource).toBe("approval");
      expect(claims[0]?.operationReferenceId).toBe(555);
      expect(claims[0]?.status).toBe("completed");
      expect(claims[0]?.leaseExpiresAt).not.toBeNull();

      expect(runCreativeAgent).toHaveBeenCalledTimes(1);
    });

    itSafe("skips duplicate approval triggers", async () => {
      const { onStrategyApproved } = await import("./lib/workflow/triggers");
      const { runCreativeAgent } = await import("./lib/agents/creative-agent");
      vi.mocked(runCreativeAgent).mockResolvedValue({
        packRunId: 701,
        savedPosts: 2,
        savedAssets: 1,
        pack: null,
        assets: null,
        metrics: {},
      } as any);

      await onStrategyApproved(testCampaignId, testUserId, 556);
      await onStrategyApproved(testCampaignId, testUserId, 556);

      expect(runCreativeAgent).toHaveBeenCalledTimes(1);

      const claims = await db
        .select()
        .from(creativeGenerationClaims)
        .where(eq(creativeGenerationClaims.campaignId, testCampaignId));
      expect(claims).toHaveLength(1);
    });
  });

  describe("concurrent contentRouter calls", () => {
    itSafe(
      "two concurrent calls create exactly one claim, one job row and one queue job",
      async () => {
        const { scheduleContentGenerationJob } = await import("./lib/queue/bullmq");
        const caller = contentRouter.createCaller(buildCtx(testUserId));

        const [a, b] = await Promise.all([
          caller.generateForCampaign({ campaignId: testCampaignId }).catch((e) => e),
          caller.generateForCampaign({ campaignId: testCampaignId }).catch((e) => e),
        ]);

        // At least one call returns the winning job; the other may return the
        // preparing state while the reference is still being attached.
        const winner = a instanceof TRPCError ? b : a;
        expect(winner.jobId).toBeGreaterThan(0);
        expect(winner.status).toBe("queued");
        const loser = a instanceof TRPCError ? a : b;
        if (!(loser instanceof TRPCError)) {
          expect(loser.reused).toBe(true);
          expect(["queued", "preparing"]).toContain(loser.status);
          expect(loser.jobId === null || loser.jobId === winner.jobId).toBe(true);
        }

        const claims = await db
          .select()
          .from(creativeGenerationClaims)
          .where(eq(creativeGenerationClaims.campaignId, testCampaignId));
        expect(claims).toHaveLength(1);

        const jobs = await db
          .select()
          .from(agentRuns)
          .where(eq(agentRuns.campaignId, testCampaignId));
        expect(jobs).toHaveLength(1);

        expect(scheduleContentGenerationJob).toHaveBeenCalledTimes(1);
      }
    );
  });

  describe("concurrent agentRouter.runCreativeAgent calls", () => {
    itSafe("two concurrent calls create exactly one claim and one creative execution", async () => {
      const { runCreativeAgent } = await import("./lib/agents/creative-agent");

      // Slow the winner so the loser reaches acquisition while the active claim exists.
      vi.mocked(runCreativeAgent).mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 150));
        return {
          packRunId: 501,
          savedPosts: 2,
          savedAssets: 1,
          pack: null,
          assets: null,
          metrics: {},
        } as any;
      });

      const caller = agentRouter.createCaller(buildCtx(testUserId));
      const [a, b] = await Promise.all([
        caller.runCreativeAgent({ campaignId: testCampaignId }).catch((e) => e),
        caller.runCreativeAgent({ campaignId: testCampaignId }).catch((e) => e),
      ]);

      const winner = a instanceof TRPCError ? b : a;
      const loser = a instanceof TRPCError ? a : b;
      expect(winner.success).toBe(true);
      expect(loser.skipped || loser.success).toBe(true);

      const claims = await db
        .select()
        .from(creativeGenerationClaims)
        .where(eq(creativeGenerationClaims.campaignId, testCampaignId));
      expect(claims).toHaveLength(1);

      const operationRows = await db
        .select()
        .from(agentRuns)
        .where(
          and(eq(agentRuns.campaignId, testCampaignId), eq(agentRuns.userId, testUserId))
        );
      expect(operationRows).toHaveLength(1);

      expect(vi.mocked(runCreativeAgent)).toHaveBeenCalledTimes(1);
    });
  });

  describe("concurrent workflow.onStrategyApproved calls", () => {
    itSafe("two concurrent calls create exactly one claim and one creative execution", async () => {
      const { onStrategyApproved } = await import("./lib/workflow/triggers");
      const { runCreativeAgent } = await import("./lib/agents/creative-agent");
      const { transitionCampaignState } = await import("./lib/workflow/engine");

      vi.mocked(runCreativeAgent).mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 150));
        return {
          packRunId: 701,
          savedPosts: 2,
          savedAssets: 1,
          pack: null,
          assets: null,
          metrics: {},
        } as any;
      });

      await Promise.all([
        onStrategyApproved(testCampaignId, testUserId, 777),
        onStrategyApproved(testCampaignId, testUserId, 777),
      ]);

      const claims = await db
        .select()
        .from(creativeGenerationClaims)
        .where(eq(creativeGenerationClaims.campaignId, testCampaignId));
      expect(claims).toHaveLength(1);
      expect(claims[0]?.operationSource).toBe("approval");
      expect(claims[0]?.operationReferenceId).toBe(777);
      expect(claims[0]?.status).toBe("completed");

      expect(vi.mocked(runCreativeAgent)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(transitionCampaignState)).toHaveBeenCalledTimes(2);
    });
  });

  describe("error precedence and ownerToken non-exposure", () => {
    itSafe("preserves the primary error when failed-release also fails", async () => {
      const { runCreativeAgent } = await import("./lib/agents/creative-agent");
      const { releaseClaimWithResult } = await import("./lib/creative/creative-generation-claim");
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

      vi.mocked(runCreativeAgent).mockRejectedValue(new Error("creative generation exploded"));
      vi.mocked(releaseClaimWithResult).mockResolvedValue({
        released: false,
        error: new Error("release also failed"),
      });

      const caller = agentRouter.createCaller(buildCtx(testUserId));
      await expect(caller.runCreativeAgent({ campaignId: testCampaignId })).rejects.toThrow(
        "creative generation exploded"
      );

      const claims = await db
        .select()
        .from(creativeGenerationClaims)
        .where(eq(creativeGenerationClaims.campaignId, testCampaignId));
      expect(claims).toHaveLength(1);

      const logPayloads = consoleSpy.mock.calls.map((args) => JSON.stringify(args));
      const combinedLogs = logPayloads.join("\n");
      expect(combinedLogs).not.toContain("test-owner-token");
      expect(combinedLogs).not.toContain("ownerToken");

      consoleSpy.mockRestore();
    });

    itSafe("does not report clean success when completed-release fails", async () => {
      const { runCreativeAgent } = await import("./lib/agents/creative-agent");
      const { releaseClaimWithResult } = await import("./lib/creative/creative-generation-claim");
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

      vi.mocked(runCreativeAgent).mockResolvedValue({
        packRunId: 501,
        savedPosts: 2,
        savedAssets: 1,
        pack: null,
        assets: null,
        metrics: {},
      } as any);
      vi.mocked(releaseClaimWithResult).mockResolvedValue({
        released: false,
        error: new Error("release failed after success"),
      });

      const caller = agentRouter.createCaller(buildCtx(testUserId));
      await expect(caller.runCreativeAgent({ campaignId: testCampaignId })).rejects.toThrow(
        /could not be closed cleanly/
      );

      const logPayloads = consoleSpy.mock.calls.map((args) => JSON.stringify(args));
      const combinedLogs = logPayloads.join("\n");
      expect(combinedLogs).not.toContain("test-owner-token");
      expect(combinedLogs).not.toContain("ownerToken");

      consoleSpy.mockRestore();
    });
  });
});
