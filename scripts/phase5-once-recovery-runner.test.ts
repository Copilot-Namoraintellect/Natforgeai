import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const CAMPAIGN_ID = 30;
const USER_ID = 22;
const APPROVAL_ID = 36;
const STRATEGY_RUN_ID = 253;
const EXPECTED_FINGERPRINT =
  "c935ba1009ed5caf2183360b10bbd4e69c20602db023bd73ec9e9af5e848a319";
const IDEMPOTENCY_KEY = `creative-success:${CAMPAIGN_ID}:approval:${APPROVAL_ID}`;

const mockOnStrategyApproved = vi.fn();
const mockGetStrategyApprovalStatus = vi.fn();

let selectCallIndex = 0;
let selectResults: unknown[][] = [];

function nextSelectResult(): unknown[] {
  const result = selectResults[selectCallIndex];
  if (result === undefined) {
    throw new Error(`selectResults index ${selectCallIndex} is undefined`);
  }
  selectCallIndex++;
  return result;
}

function makeQueryResult(result: unknown[]) {
  return {
    limit: vi.fn(() => Promise.resolve(result)),
    orderBy: vi.fn(() => ({
      limit: vi.fn(() => Promise.resolve(result)),
      then: (resolve: (value: unknown[]) => unknown) =>
        Promise.resolve(result).then(resolve),
    })),
    then: (resolve: (value: unknown[]) => unknown) =>
      Promise.resolve(result).then(resolve),
  };
}

const mockWhere = vi.fn(() => makeQueryResult(nextSelectResult()));
const mockFrom = vi.fn(() => ({ where: mockWhere }));
const mockSelect = vi.fn(() => ({ from: mockFrom }));

const mockDb = {
  select: mockSelect,
};

const mockGetDb = vi.fn(() => mockDb);

vi.mock("../api/queries/connection", () => ({
  getDb: mockGetDb,
}));

vi.mock("../db/schema", () => ({
  agentRuns: {},
  approvalRequests: {},
  campaigns: {},
  creativeGenerationClaims: {},
  creditTransactions: {},
  creditWallets: {},
}));

vi.mock("../api/lib/workflow/triggers", () => ({
  onStrategyApproved: mockOnStrategyApproved,
}));

vi.mock("../api/lib/workflow/strategy-approval", () => ({
  getStrategyApprovalStatus: mockGetStrategyApprovalStatus,
}));

let exitResolve: (code: number) => void;
let exitPromise: Promise<number>;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();

  let resolveFn: (code: number) => void;
  exitPromise = new Promise<number>((resolve) => {
    resolveFn = resolve;
  });
  exitResolve = resolveFn!;

  vi.stubGlobal("process", {
    ...process,
    exit: (code: number) => {
      exitResolve(code);
      return undefined as never;
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function makeSelectResults(
  overrides: { postRecoveryCampaign?: unknown; postRecoveryLineageStatus?: string } = {}
): unknown[][] {
  const postRecoveryCampaign = overrides.postRecoveryCampaign ?? {
    id: CAMPAIGN_ID,
    userId: USER_ID,
    workflowState: "creatives_complete",
    workflowContext: {
      approvedStrategyFingerprint: EXPECTED_FINGERPRINT,
      strategyApprovalLineage: {
        strategyRunId: STRATEGY_RUN_ID,
        approvalRequestId: APPROVAL_ID,
        creativeBriefFingerprint: EXPECTED_FINGERPRINT,
        status: overrides.postRecoveryLineageStatus ?? "approved",
      },
    },
  };

  return [
    // 1. approval
    [
      {
        id: APPROVAL_ID,
        campaignId: CAMPAIGN_ID,
        approvalType: "strategy_review",
        status: "approved",
      },
    ],
    // 2. strategy run
    [
      {
        id: STRATEGY_RUN_ID,
        campaignId: CAMPAIGN_ID,
        status: "completed",
      },
    ],
    // 3. campaign (pre-recovery)
    [
      {
        id: CAMPAIGN_ID,
        userId: USER_ID,
        workflowContext: {
          strategyApprovalLineage: {
            strategyRunId: STRATEGY_RUN_ID,
            approvalRequestId: APPROVAL_ID,
            creativeBriefFingerprint: EXPECTED_FINGERPRINT,
            status: "pending",
          },
        },
      },
    ],
    // 4. no newer strategy run
    [],
    // 5. no creative run after baseline
    [],
    // 6. no existing charge
    [],
    // 7. wallet
    [{ balance: 10 }],
    // 8. no active creative claim
    [],
    // 9. campaign (post-recovery)
    [postRecoveryCampaign],
    // 10. one new creative run
    [
      {
        id: 244,
        campaignId: CAMPAIGN_ID,
        userId: USER_ID,
        agentType: "creative",
        status: "completed",
      },
    ],
    // 11. one successful -5 charge
    [
      {
        id: 300,
        userId: USER_ID,
        type: "agent_deduction",
        amount: -5,
        status: "completed",
        idempotencyKey: IDEMPOTENCY_KEY,
      },
    ],
    // 12. one terminal completed claim
    [
      {
        id: 16,
        userId: USER_ID,
        campaignId: CAMPAIGN_ID,
        operationSource: "approval",
        operationReferenceId: APPROVAL_ID,
        status: "completed",
        activeClaimKey: null,
      },
    ],
  ];
}

function setupSuccessMocks() {
  selectCallIndex = 0;
  selectResults = makeSelectResults();

  mockGetStrategyApprovalStatus
    .mockReturnValueOnce({
      lineage: {
        strategyRunId: STRATEGY_RUN_ID,
        approvalRequestId: APPROVAL_ID,
        creativeBriefFingerprint: EXPECTED_FINGERPRINT,
        status: "pending",
      },
      approvedStrategyFingerprint: null,
    })
    .mockReturnValueOnce({
      lineage: {
        strategyRunId: STRATEGY_RUN_ID,
        approvalRequestId: APPROVAL_ID,
        creativeBriefFingerprint: EXPECTED_FINGERPRINT,
        status: "approved",
      },
      approvedStrategyFingerprint: EXPECTED_FINGERPRINT,
    });

  mockOnStrategyApproved.mockResolvedValue(undefined);
}

async function importAndAwaitExit() {
  await import("./phase5-once-recovery-runner");
  return await exitPromise;
}

describe("phase5-once-recovery-runner process termination", () => {
  it("exits 1 when PHASE5_RECOVERY_EXPECTED_HEAD is missing", async () => {
    vi.stubEnv("PHASE5_RECOVERY_EXPECTED_HEAD", "");

    const exitCode = await importAndAwaitExit();

    expect(mockOnStrategyApproved).not.toHaveBeenCalled();
    expect(exitCode).toBe(1);
  });

  it("exits 0 on successful recovery", async () => {
    vi.stubEnv(
      "PHASE5_RECOVERY_EXPECTED_HEAD",
      "20048f4e32d063a470f784bdce770aaa7dc84cd0"
    );
    setupSuccessMocks();

    const exitCode = await importAndAwaitExit();

    expect(mockOnStrategyApproved).toHaveBeenCalledTimes(1);
    expect(mockOnStrategyApproved).toHaveBeenCalledWith(
      CAMPAIGN_ID,
      USER_ID,
      APPROVAL_ID
    );
    expect(exitCode).toBe(0);
  });

  it("exits 1 when onStrategyApproved rejects", async () => {
    vi.stubEnv(
      "PHASE5_RECOVERY_EXPECTED_HEAD",
      "20048f4e32d063a470f784bdce770aaa7dc84cd0"
    );
    setupSuccessMocks();
    mockOnStrategyApproved.mockRejectedValue(new Error("recovery failed"));

    const exitCode = await importAndAwaitExit();

    expect(mockOnStrategyApproved).toHaveBeenCalledTimes(1);
    expect(exitCode).toBe(1);
  });

  it("exits 1 when onStrategyApproved returns without creating run/charge", async () => {
    vi.stubEnv(
      "PHASE5_RECOVERY_EXPECTED_HEAD",
      "20048f4e32d063a470f784bdce770aaa7dc84cd0"
    );
    setupSuccessMocks();
    // Simulate the pre-recovery state persisting after onStrategyApproved returns.
    selectResults = makeSelectResults({
      postRecoveryLineageStatus: "pending",
    });
    mockGetStrategyApprovalStatus.mockReset();
    mockGetStrategyApprovalStatus.mockReturnValue({
      lineage: {
        strategyRunId: STRATEGY_RUN_ID,
        approvalRequestId: APPROVAL_ID,
        creativeBriefFingerprint: EXPECTED_FINGERPRINT,
        status: "pending",
      },
      approvedStrategyFingerprint: null,
    });

    const exitCode = await importAndAwaitExit();

    expect(mockOnStrategyApproved).toHaveBeenCalledTimes(1);
    expect(exitCode).toBe(1);
  });
});
