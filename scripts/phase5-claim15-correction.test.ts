import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockExecute = vi.fn();
const mockLimit = vi.fn();
const mockWhere = vi.fn(() => ({ limit: mockLimit }));
const mockFrom = vi.fn(() => ({ where: mockWhere }));
const mockSelect = vi.fn(() => ({ from: mockFrom }));
const mockUpdate = vi.fn(() => ({ set: vi.fn(() => ({ where: mockWhere })) }));

const mockDb = {
  select: mockSelect,
  execute: mockExecute,
  update: mockUpdate,
};

const mockGetDb = vi.fn(() => mockDb);

vi.mock("../api/queries/connection", () => ({
  getDb: mockGetDb,
}));

vi.mock("../db/schema", () => ({
  creativeGenerationClaims: {},
  agentRuns: {},
  creditTransactions: {},
}));

let exitResolve: (code: number) => void;
let exitPromise: Promise<number>;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();

  mockExecute.mockReset().mockResolvedValue([[]]);
  mockLimit.mockReset().mockResolvedValue([]);
  mockUpdate.mockReset().mockReturnValue({ set: vi.fn(() => ({ where: mockWhere })) });

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
});

async function importAndAwaitExit() {
  await import("./phase5-claim15-correction");
  return await exitPromise;
}

function makeMatchingClaim(overrides: Record<string, unknown> = {}) {
  return {
    id: 15,
    userId: 22,
    campaignId: 30,
    operationSource: "approval",
    operationReferenceId: 36,
    status: "completed",
    activeClaimKey: null,
    ...overrides,
  };
}

async function setupAbsentClaim() {
  mockExecute.mockResolvedValue([[]]);
  mockLimit.mockResolvedValue([]);
}

async function setupMatchingClaim(overrides?: Record<string, unknown>) {
  mockExecute.mockResolvedValue([[]]);
  mockLimit
    .mockResolvedValueOnce([makeMatchingClaim(overrides)])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([]);
}

describe("phase5-claim15-correction", () => {
  it("exits 0 and does not mutate when claim 15 is already absent", async () => {
    await setupAbsentClaim();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const exitCode = await importAndAwaitExit();

    expect(exitCode).toBe(0);
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("CLAIM_15_ALREADY_ABSENT")
    );
    logSpy.mockRestore();
  });

  it("exits 0 and marks the matching orphan claim failed even when no reason column exists", async () => {
    await setupMatchingClaim();

    const exitCode = await importAndAwaitExit();

    expect(exitCode).toBe(0);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
  });

  it("exits 0 and marks the matching orphan claim failed when schema supports a reason column", async () => {
    mockExecute.mockResolvedValue([[{ COLUMN_NAME: "metadata" }]]);
    await setupMatchingClaim();

    const exitCode = await importAndAwaitExit();

    expect(exitCode).toBe(0);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
  });

  it("exits 1 when claim 15 exists but does not match the expected campaign", async () => {
    mockExecute.mockResolvedValue([[]]);
    await setupMatchingClaim({ campaignId: 999 });

    const exitCode = await importAndAwaitExit();

    expect(exitCode).toBe(1);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("exits 1 when claim 15 exists but is still active", async () => {
    mockExecute.mockResolvedValue([[]]);
    await setupMatchingClaim({ status: "running", activeClaimKey: "active:22:30:creative" });

    const exitCode = await importAndAwaitExit();

    expect(exitCode).toBe(1);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("exits 1 when claim 15 exists but a correlated creative charge is already present", async () => {
    mockExecute.mockResolvedValue([[]]);
    mockLimit
      .mockResolvedValueOnce([makeMatchingClaim()])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 300 }]);

    const exitCode = await importAndAwaitExit();

    expect(exitCode).toBe(1);
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
