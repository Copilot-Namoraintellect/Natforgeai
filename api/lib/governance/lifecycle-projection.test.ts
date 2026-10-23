import { describe, it, expect } from "vitest";
import {
  deriveLifecycleBlocker,
  projectCampaignLifecycle,
  type LifecycleEvidence,
} from "./lifecycle-projection";

const NOW = new Date("2026-10-23T12:00:00.000Z");

function baseEvidence(overrides: Partial<LifecycleEvidence> = {}): LifecycleEvidence {
  return {
    campaignFound: true,
    contextParseable: true,
    workflowState: "creatives_ready",
    campaignStatus: "active",
    costPause: { present: false, valid: true, kind: null, reason: null },
    nextCycle: { present: false, valid: true, status: null },
    strategy: { snapshotsFound: 1, approvalLineageStatus: "approved", lineageParseable: true },
    approvals: { pendingTypes: [], approvedBudgetIncreasePresent: false },
    creative: { runningClaims: 0, staleRunningClaims: 0 },
    distribution: { queueCounts: {}, openTerminalFailures: 0, openReplayRequests: 0 },
    postLive: { liveAt: null },
    areasUnavailable: [],
    ...overrides,
  };
}

describe("deriveLifecycleBlocker — honest authority surfacing", () => {
  it("missing campaign is unavailable, never guessed", () => {
    const blocker = deriveLifecycleBlocker(baseEvidence({ campaignFound: false }));
    expect(blocker).toEqual({
      classification: "unavailable",
      reason: "campaign_not_found",
      recoverability: "unavailable",
      safeNextAction: "none",
    });
  });

  it("unreadable authority area is surfaced as unavailable", () => {
    const blocker = deriveLifecycleBlocker(
      baseEvidence({ areasUnavailable: ["learning_records", "audit_events"] })
    );
    expect(blocker.classification).toBe("unavailable");
    expect(blocker.reason).toBe("authority_unavailable:learning_records,audit_events");
    expect(blocker.safeNextAction).toBe("none");
  });

  it("malformed workflow context is inconsistent", () => {
    const blocker = deriveLifecycleBlocker(baseEvidence({ contextParseable: false }));
    expect(blocker).toMatchObject({
      classification: "inconsistent",
      reason: "workflow_context_malformed",
      recoverability: "inconsistent_authority",
      safeNextAction: "review_inconsistent_authority",
    });
  });

  it("malformed cost-pause provenance is inconsistent even though a pause is recorded", () => {
    const blocker = deriveLifecycleBlocker(
      baseEvidence({ costPause: { present: true, valid: false, kind: null, reason: null } })
    );
    expect(blocker.reason).toBe("cost_pause_provenance_malformed");
    expect(blocker.classification).toBe("inconsistent");
  });

  it("approved lineage without any strategy snapshot is conflicting authority", () => {
    const blocker = deriveLifecycleBlocker(
      baseEvidence({ strategy: { snapshotsFound: 0, approvalLineageStatus: "approved", lineageParseable: true } })
    );
    expect(blocker.reason).toBe("approved_strategy_without_snapshot");
    expect(blocker.classification).toBe("inconsistent");
  });

  it("post-live phase without the immutable live anchor is inconsistent", () => {
    const blocker = deriveLifecycleBlocker(
      baseEvidence({ workflowState: "campaign_live", postLive: { liveAt: null } })
    );
    expect(blocker).toMatchObject({
      classification: "inconsistent",
      reason: "post_live_anchor_missing",
    });
  });

  it("non-canonical lineage status is inconsistent", () => {
    const blocker = deriveLifecycleBlocker(
      baseEvidence({
        strategy: { snapshotsFound: 1, approvalLineageStatus: "maybe", lineageParseable: false },
      })
    );
    expect(blocker.reason).toBe("strategy_lineage_malformed");
  });
});

describe("deriveLifecycleBlocker — blocker classification and recovery", () => {
  it("valid cost pause with an approved budget increase is resumable via the governed continuation", () => {
    const blocker = deriveLifecycleBlocker(
      baseEvidence({
        workflowState: "launch_approval_required",
        costPause: { present: true, valid: true, kind: "agent_run_complete", reason: "monthly spend limit reached" },
        approvals: { pendingTypes: [], approvedBudgetIncreasePresent: true },
      })
    );
    expect(blocker).toEqual({
      classification: "blocked",
      reason: "cost_pause:monthly spend limit reached",
      recoverability: "recoverable_budget_resume",
      safeNextAction: "resume_budget_continuation",
    });
  });

  it("valid cost pause without an approved increase awaits the user", () => {
    const blocker = deriveLifecycleBlocker(
      baseEvidence({
        costPause: { present: true, valid: true, kind: "strategy_approval", reason: "limit" },
      })
    );
    expect(blocker).toMatchObject({
      classification: "blocked",
      recoverability: "blocked_awaiting_user",
      safeNextAction: "await_budget_approval",
    });
  });

  it("pending strategy review blocks the strategy phase", () => {
    const blocker = deriveLifecycleBlocker(
      baseEvidence({
        workflowState: "strategy_generated",
        approvals: { pendingTypes: ["strategy_review"], approvedBudgetIncreasePresent: false },
      })
    );
    expect(blocker).toMatchObject({
      classification: "blocked",
      reason: "pending_strategy_review_approval",
      recoverability: "recoverable_user_approval",
      safeNextAction: "inspect_pending_approval",
    });
  });

  it("pending launch approval blocks the launch gate", () => {
    const blocker = deriveLifecycleBlocker(
      baseEvidence({
        workflowState: "launch_approval_required",
        approvals: { pendingTypes: ["campaign_launch"], approvedBudgetIncreasePresent: false },
      })
    );
    expect(blocker).toMatchObject({
      classification: "blocked",
      reason: "pending_launch_approval",
      safeNextAction: "inspect_pending_approval",
    });
  });

  it("open terminal failures expose governed replay as the safe action", () => {
    const noReplay = deriveLifecycleBlocker(
      baseEvidence({
        workflowState: "publication_pending",
        distribution: { queueCounts: {}, openTerminalFailures: 2, openReplayRequests: 0 },
      })
    );
    expect(noReplay).toMatchObject({
      classification: "blocked",
      reason: "terminal_queue_failures_open",
      recoverability: "recoverable_operator_action",
      safeNextAction: "request_terminal_replay",
    });

    const replayPending = deriveLifecycleBlocker(
      baseEvidence({
        workflowState: "publication_pending",
        distribution: { queueCounts: {}, openTerminalFailures: 2, openReplayRequests: 1 },
      })
    );
    expect(replayPending.safeNextAction).toBe("await_terminal_replay");
  });

  it("failed queue items block publication progress", () => {
    const blocker = deriveLifecycleBlocker(
      baseEvidence({
        workflowState: "publication_pending",
        distribution: { queueCounts: { failed: 3 }, openTerminalFailures: 0, openReplayRequests: 0 },
      })
    );
    expect(blocker).toMatchObject({
      classification: "blocked",
      reason: "publishing_queue_failures",
      safeNextAction: "inspect_publishing_queue",
    });
  });

  it("stale creative claims during generation expose the governed sweep", () => {
    const blocker = deriveLifecycleBlocker(
      baseEvidence({
        workflowState: "creatives_generating",
        creative: { runningClaims: 2, staleRunningClaims: 2 },
      })
    );
    expect(blocker).toMatchObject({
      classification: "blocked",
      reason: "stale_creative_generation_claims",
      safeNextAction: "sweep_stale_creative_claims",
    });
  });

  it("a healthy live campaign is not blocked", () => {
    const blocker = deriveLifecycleBlocker(
      baseEvidence({
        workflowState: "campaign_live",
        postLive: { liveAt: "2026-10-01T00:00:00.000Z" },
      })
    );
    expect(blocker).toEqual({
      classification: "none",
      reason: null,
      recoverability: "not_blocked",
      safeNextAction: "none",
    });
  });

  it("a completed campaign is not blocked", () => {
    const blocker = deriveLifecycleBlocker(baseEvidence({ workflowState: "completed" }));
    expect(blocker.classification).toBe("none");
  });
});

// ─── IO shell over a condition-evaluating fake executor ───

function tableName(table: unknown): string {
  return (table as Record<symbol, string>)[Symbol.for("drizzle:Name")] ?? "unknown";
}

function evalCond(cond: any, row: any): boolean {
  const chunks: any[] = cond?.queryChunks ?? [];
  if (chunks.length === 0) return true;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    // Nested and(...) / or(...) groups.
    if (chunk && Array.isArray(chunk.queryChunks)) {
      if (!evalCond(chunk, row)) return false;
      continue;
    }
    if (chunk && typeof chunk === "object" && typeof chunk.name === "string" && chunk.table) {
      const param = chunks[i + 2];
      const value = param && typeof param === "object" && "value" in param ? param.value : param;
      if (Array.isArray(value)) {
        if (!value.includes(row[chunk.name])) return false;
      } else if (row[chunk.name] !== value) {
        return false;
      }
      i += 2;
    }
  }
  return true;
}

function createFakeExecutor(seed: Record<string, Record<string, unknown>[]>) {
  const executor = {
    select: (_fields?: unknown) => ({
      from: (table: unknown) => {
        const name = tableName(table);
        const rows = () => seed[name] ?? [];
        const chain: Record<string, unknown> = {
          where: (cond: unknown) => ({
            orderBy: (order: unknown) => ({
              limit: async (n: number) => {
                const specs = (((order as any)?.queryChunks ?? []) as any[])
                  .filter((c: any) => c && typeof c === "object" && typeof c.name === "string")
                  .map((c: any) => ({ column: c.name, dir: "desc" as const }));
                return rows()
                  .filter((r) => evalCond(cond, r))
                  .sort((a, b) => {
                    for (const spec of specs) {
                      const av = (a[spec.column]?.valueOf?.() ?? a[spec.column] ?? 0) as number;
                      const bv = (b[spec.column]?.valueOf?.() ?? b[spec.column] ?? 0) as number;
                      if (av !== bv) return spec.dir === "desc" ? bv - av : av - bv;
                    }
                    return 0;
                  })
                  .slice(0, n);
              },
            }),
            limit: async (n: number) => rows().filter((r) => evalCond(cond, r)).slice(0, n),
          }),
          orderBy: (order: unknown) => ({
            limit: async (n: number) => {
              void order;
              return rows().slice(0, n);
            },
          }),
          limit: async (n: number) => rows().slice(0, n),
        };
        return chain;
      },
    }),
  };
  // The real executor type is the full drizzle builder surface; the fake
  // only needs to satisfy it structurally at runtime.
  return executor as never;
}

const campaignRow = (context: unknown) => ({
  id: 42,
  userId: 18,
  businessId: 7,
  name: "Autumn Launch",
  status: "active",
  workflowState: "launch_approval_required",
  workflowContext: context,
  approvalMode: "assisted",
  autoPublish: false,
});

describe("projectCampaignLifecycle — read model assembly", () => {
  it("rejects non-positive campaign ids before touching the database", async () => {
    await expect(projectCampaignLifecycle({ campaignId: 0, executor: createFakeExecutor({}) })).rejects.toThrow(
      TypeError
    );
    await expect(
      projectCampaignLifecycle({ campaignId: 4.5, executor: createFakeExecutor({}) })
    ).rejects.toThrow(TypeError);
  });

  it("unknown campaign surfaces unavailable, never guessed", async () => {
    const projection = await projectCampaignLifecycle({
      campaignId: 999,
      executor: createFakeExecutor({}),
      now: NOW,
    });
    expect(projection.campaign).toBeNull();
    expect(projection.status).toBe("unavailable");
    expect(projection.blocker.reason).toBe("campaign_not_found");
  });

  it("derives a launch-gated campaign with cost pause and queue evidence", async () => {
    const staleLease = new Date("2026-10-23T11:00:00.000Z"); // 1h before NOW
    const executor = createFakeExecutor({
      campaigns: [
        campaignRow({
          costPause: {
            kind: "agent_run_complete",
            continuationId: 7,
            reason: "monthly spend limit reached",
            recordedAt: "2026-10-22T10:00:00.000Z",
            workflowState: "creatives_generating",
          },
          campaignLiveAt: null,
        }),
      ],
      strategy_snapshots: [
        { version: 3, snapshotId: "snap-3", campaignId: 42, capturedAt: new Date("2026-10-20T00:00:00Z") },
      ],
      approval_requests: [
        { approvalType: "budget_increase", status: "approved", campaignId: 42, createdAt: new Date("2026-10-22T11:00:00Z") },
        { approvalType: "campaign_launch", status: "pending", campaignId: 42, createdAt: new Date("2026-10-21T11:00:00Z") },
      ],
      creative_generation_claims: [
        { status: "running", campaignId: 42, leaseExpiresAt: staleLease },
        { status: "running", campaignId: 42, leaseExpiresAt: null },
        { status: "failed", campaignId: 42, leaseExpiresAt: null },
      ],
      agent_runs: [
        { status: "completed", agentType: "audience", campaignId: 42, createdAt: new Date("2026-10-22T12:00:00Z") },
      ],
      publishing_queue: [
        { status: "failed", campaignId: 42, externalPostId: null },
        { status: "published", campaignId: 42, externalPostId: "ext-1" },
      ],
      queue_terminal_failures: [{ id: 501, campaignId: 42, status: "open" }],
      queue_replay_requests: [],
      learning_records: [],
      credit_reservations: [{ state: "reserved", campaignId: 42, reservedAmount: 250 }],
      analytics: [{ date: "2026-10-22", campaignId: 42 }],
      audit_events: [{ occurredAt: "2026-10-22T13:00:00.000Z", campaignId: 42 }],
    });

    const projection = await projectCampaignLifecycle({ campaignId: 42, executor, now: NOW });

    expect(projection.status).toBe("blocked");
    expect(projection.blocker).toEqual({
      classification: "blocked",
      reason: "cost_pause:monthly spend limit reached",
      recoverability: "recoverable_budget_resume",
      safeNextAction: "resume_budget_continuation",
    });
    expect(projection.campaign).toMatchObject({ id: 42, userId: 18, workflowState: "launch_approval_required" });
    expect(projection.strategy).toMatchObject({ snapshotsFound: 1, latestVersion: 3 });
    expect(projection.approvals.pendingCount).toBe(1);
    expect(projection.approvals.pendingTypes).toEqual(["campaign_launch"]);
    expect(projection.approvals.latestDecision).toEqual({ type: "budget_increase", status: "approved" });
    expect(projection.creative).toMatchObject({ runningClaims: 2, staleRunningClaims: 2, failedClaims: 1 });
    expect(projection.distribution.openTerminalFailures).toBe(1);
    expect(projection.publication).toMatchObject({ publishedCount: 1, publishedWithExternalId: 1 });
    expect(projection.budget).toMatchObject({ costPaused: true, openReservations: 1, reservedCredits: 250 });
    expect(projection.postLive.lastObservedAt).toBe("2026-10-22T00:00:00.000Z");
    expect(projection.lastAutonomousActivity).toBe("2026-10-22T13:00:00.000Z");
  });

  it("surfaces an unreadable authority area as unavailable with the area named", async () => {
    const brokenExecutor = {
      select: () => {
        throw new Error("authority down");
      },
    } as never;
    const projection = await projectCampaignLifecycle({
      campaignId: 42,
      executor: brokenExecutor,
      now: NOW,
    });
    expect(projection.status).toBe("unavailable");
    expect(projection.blocker.classification).toBe("unavailable");
    expect(projection.blocker.reason).toContain("authority_unavailable:campaigns");
  });
});
