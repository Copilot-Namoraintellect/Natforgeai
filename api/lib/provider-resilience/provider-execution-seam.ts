// Read-only frozen R9 seam. Missing tables and query errors fail closed.
import { and, eq } from "drizzle-orm";
import { executionActions, executionAttempts } from "@db/schema";
import { getDb } from "../../queries/connection";
import { ProviderUpstreamError } from "./provider-resilience-contract";
import type {
  ProviderExecutionActionView,
  ProviderExecutionAttemptView,
} from "./provider-binding";
export interface ProviderExecutionAuthority {
  getExecutionAction(
    userId: number,
    actionId: string
  ): Promise<ProviderExecutionActionView | null>;
  getExecutionAttempt(
    userId: number,
    actionId: string,
    attemptId: string
  ): Promise<ProviderExecutionAttemptView | null>;
}
export function createInMemoryExecutionAuthority(seed: {
  actions: readonly ProviderExecutionActionView[];
  attempts: readonly ProviderExecutionAttemptView[];
}): ProviderExecutionAuthority {
  return {
    async getExecutionAction(userId, actionId) {
      return structuredClone(
        seed.actions.find(
          a => a.userId === userId && a.executionActionId === actionId
        ) ?? null
      );
    },
    async getExecutionAttempt(userId, actionId, attemptId) {
      if (
        !seed.actions.some(
          a => a.userId === userId && a.executionActionId === actionId
        )
      )
        return null;
      return structuredClone(
        seed.attempts.find(
          a => a.executionActionId === actionId && a.attemptId === attemptId
        ) ?? null
      );
    },
  };
}
export function createGuardedExecutionAuthority(): ProviderExecutionAuthority {
  async function guarded<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch {
      throw new ProviderUpstreamError(
        "EXECUTION_AUTHORITY_UNAVAILABLE",
        "execution authority unavailable"
      );
    }
  }
  return {
    getExecutionAction: (userId, actionId) =>
      guarded(async () => {
        const [row] = await getDb()
          .select()
          .from(executionActions)
          .where(
            and(
              eq(executionActions.userId, userId),
              eq(executionActions.executionActionId, actionId)
            )
          )
          .limit(1);
        return row ?? null;
      }),
    getExecutionAttempt: (userId, actionId, attemptId) =>
      guarded(async () => {
        const [row] = await getDb()
          .select()
          .from(executionAttempts)
          .where(
            and(
              eq(executionAttempts.userId, userId),
              eq(executionAttempts.executionActionId, actionId),
              eq(executionAttempts.attemptId, attemptId)
            )
          )
          .limit(1);
        return row ?? null;
      }),
  };
}
export async function loadExecutionActionOrThrow(
  authority: ProviderExecutionAuthority,
  userId: number,
  actionId: string
) {
  const row = await authority.getExecutionAction(userId, actionId);
  if (!row)
    throw new ProviderUpstreamError(
      "EXECUTION_ACTION_NOT_FOUND",
      "execution action not found"
    );
  return row;
}
export async function loadExecutionAttemptOrThrow(
  authority: ProviderExecutionAuthority,
  userId: number,
  actionId: string,
  attemptId: string
) {
  const row = await authority.getExecutionAttempt(userId, actionId, attemptId);
  if (!row)
    throw new ProviderUpstreamError(
      "EXECUTION_ATTEMPT_NOT_FOUND",
      "execution attempt not found"
    );
  return row;
}
