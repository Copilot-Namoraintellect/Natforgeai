import { describe, expect, it, vi } from "vitest";
import {
  updateProviderDispatchState,
  updateCircuitState,
} from "./provider-resilience-store";

// Query-boundary checks only. No database connection or migration is executed.
function executor(affectedRows: number) {
  const set = vi.fn((_values: Record<string, unknown>) => ({
    where: async () => [{ affectedRows }],
  }));
  const limit = vi.fn(async () => [
    { userId: 1, requestId: "request", circuitId: "circuit", version: 2 },
  ]);
  return {
    set,
    limit,
    db: {
      update: () => ({ set }),
      select: () => ({ from: () => ({ where: () => ({ limit }) }) }),
    } as any,
  };
}
describe("provider persistence mutation boundary", () => {
  it.each([updateProviderDispatchState, updateCircuitState])(
    "lifecycle updates cannot rewrite identity, tenant, account or payload binding",
    async update => {
      const f = executor(1);
      await update(
        1,
        "request",
        1,
        {
          state: "UNCERTAIN",
          circuitState: "OPEN",
          userId: 2,
          businessId: 22,
          requestId: "substitute",
          circuitId: "substitute",
          providerAccountId: "other",
          parametersHash: "other",
          bindingId: "other",
          version: 99,
        } as any,
        f.db
      );
      const written = f.set.mock.calls[0][0] as Record<string, unknown>;
      for (const key of [
        "userId",
        "businessId",
        "requestId",
        "circuitId",
        "providerAccountId",
        "parametersHash",
        "bindingId",
      ])
        expect(written).not.toHaveProperty(key);
      expect(written.version).toBe(2);
    }
  );
  it.each([updateProviderDispatchState, updateCircuitState])(
    "a stale CAS cannot report a successful write",
    async update => {
      const f = executor(0);
      await expect(update(1, "request", 1, {}, f.db)).rejects.toThrow(
        "CAS failed"
      );
      expect(f.limit).not.toHaveBeenCalled();
    }
  );
});
