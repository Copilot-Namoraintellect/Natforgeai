import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const CAMPAIGN_ID = 30;
const USER_ID = 22;
const APPROVAL_ID = 36;
const STRATEGY_RUN_ID = 253;
const EXPECTED_FINGERPRINT =
  "c935ba1009ed5caf2183360b10bbd4e69c20602db023bd73ec9e9af5e848a319";

const mockOnStrategyApproved = vi.fn();
const mockGetStrategyApprovalStatus = vi.fn();

const mockLimit = vi.fn();
const mockWhere = vi.fn(() => ({ limit: mockLimit }));
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

function setupSuccessMocks() {
  let limitCallIndex = 0;
  const limitResults = [
    [
      {
        id: APPROVAL_ID,
        campaignId: CAMPAIGN_ID,
        approvalType: "strategy_review",
        status: "approved",
      },
    ],
    [
      {
        id: STRATEGY_RUN_ID,
        campaignId: CAMPAIGN_ID,
        status: "completed",
      },
    ],
    [
      {
        id: CAMPAIGN_ID,
        userId: USER_ID,
        workflowContext: {},
      },
    ],
    [],
    [],
    [],
    [{ balance: 10 }],
    [],
  ];
  mockLimit.mockImplementation(() => {
    const result = limitResults[limitCallIndex] ?? [];
    limitCallIndex++;
    return Promise.resolve(result);
  });

  mockGetStrategyApprovalStatus.mockReturnValue({
    lineage: {
      strategyRunId: STRATEGY_RUN_ID,
      approvalRequestId: APPROVAL_ID,
      creativeBriefFingerprint: EXPECTED_FINGERPRINT,
      status: "pending",
    },
    approvedStrategyFingerprint: null,
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
      "03e1060129623e04800430302789d20acfd21101"
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
      "03e1060129623e04800430302789d20acfd21101"
    );
    setupSuccessMocks();
    mockOnStrategyApproved.mockRejectedValue(new Error("recovery failed"));

    const exitCode = await importAndAwaitExit();

    expect(mockOnStrategyApproved).toHaveBeenCalledTimes(1);
    expect(exitCode).toBe(1);
  });
});
