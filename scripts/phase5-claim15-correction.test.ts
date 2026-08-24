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

describe("phase5-claim15-correction process termination", () => {
  it("exits 0 on SCHEMA_LIMITATION and does not mutate claim 15", async () => {
    mockExecute.mockResolvedValue([[]]);

    const exitCode = await importAndAwaitExit();

    expect(exitCode).toBe(0);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("exits 0 on successful correction when schema supports reason", async () => {
    mockExecute.mockResolvedValue([[{ COLUMN_NAME: "metadata" }]]);
    mockLimit
      .mockResolvedValueOnce([
        {
          id: 15,
          userId: 22,
          campaignId: 30,
          operationSource: "approval",
          operationReferenceId: 36,
          status: "completed",
          activeClaimKey: null,
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const exitCode = await importAndAwaitExit();

    expect(exitCode).toBe(0);
  });

  it("exits 1 when preconditions fail", async () => {
    mockExecute.mockResolvedValue([[{ COLUMN_NAME: "metadata" }]]);
    mockLimit.mockResolvedValue([]);

    const exitCode = await importAndAwaitExit();

    expect(exitCode).toBe(1);
  });
});
