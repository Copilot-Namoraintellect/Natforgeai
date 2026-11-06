// Durable MySQL implementation. Construction performs no I/O; migration is never run here.
import { and, asc, eq } from "drizzle-orm";
import { getDb } from "../../queries/connection";
import {
  providerCircuitBreakerStates,
  providerDispatchRequests,
  providerCallbackEvents,
} from "@db/schema";
import * as store from "./provider-resilience-store";
import { deriveProviderCircuitId } from "./provider-resilience-identity";
import {
  emptyCircuitState,
  type CircuitStateView,
} from "./provider-circuit-breaker";
import type {
  ProviderRepository,
  ProviderTransaction,
} from "./provider-resilience-service";
import type { ProviderBindingView } from "./provider-binding";

/** Tenant lock rows serialize claims, callback convergence, circuits and all rate scopes.
 * Transactions commit claims BEFORE adapter invocation. A crash leaves DISPATCHED
 * unresolved; repeat dispatch returns that receipt and never resends it. */
export function createMySqlProviderRepository(): ProviderRepository {
  return {
    async transaction(userId, work) {
      if (!Number.isSafeInteger(userId) || userId <= 0)
        throw new Error("invalid tenant");
      return getDb().transaction(async tx => {
        const db = tx as unknown as ReturnType<typeof getDb>;
        const lockScope = {
          tenantUserId: userId,
          providerId: "scope_lock",
          providerAccountId: "tenant",
          actionType: "LOCK",
        };
        const circuitId = deriveProviderCircuitId(lockScope);
        await tx
          .insert(providerCircuitBreakerStates)
          .values({
            circuitId,
            userId,
            providerId: lockScope.providerId,
            providerAccountId: lockScope.providerAccountId,
            actionType: lockScope.actionType,
            ...emptyCircuitState(0),
            version: 1,
          })
          .onDuplicateKeyUpdate({ set: { circuitId } });
        // The INSERT/UPDATE owns this row's write lock until transaction commit.
        const port: ProviderTransaction = {
          async binding(id) {
            return (await store.getProviderAccountBindingById(
              userId,
              id,
              db
            )) as ProviderBindingView | null;
          },
          request: id => store.getProviderDispatchRequestById(userId, id, db),
          async attempt(actionId, attemptId) {
            const [row] = await tx
              .select()
              .from(providerDispatchRequests)
              .where(
                and(
                  eq(providerDispatchRequests.userId, userId),
                  eq(providerDispatchRequests.executionActionId, actionId),
                  eq(providerDispatchRequests.attemptId, attemptId)
                )
              )
              .limit(1);
            return row ?? null;
          },
          requests: providerId =>
            tx
              .select()
              .from(providerDispatchRequests)
              .where(
                and(
                  eq(providerDispatchRequests.userId, userId),
                  eq(providerDispatchRequests.providerId, providerId)
                )
              ),
          actionRequests: actionId =>
            tx
              .select()
              .from(providerDispatchRequests)
              .where(
                and(
                  eq(providerDispatchRequests.userId, userId),
                  eq(providerDispatchRequests.executionActionId, actionId)
                )
              ),
          async saveRequest(row, insert) {
            if (row.userId !== userId) throw new Error("tenant mismatch");
            if (insert) await store.insertProviderDispatchRequest(row, db);
            else
              await store.updateProviderDispatchState(
                userId,
                row.requestId,
                row.version - 1,
                row,
                db
              );
          },
          async callback(provider, account, event) {
            const [row] = await tx
              .select()
              .from(providerCallbackEvents)
              .where(
                and(
                  eq(providerCallbackEvents.userId, userId),
                  eq(providerCallbackEvents.providerId, provider),
                  eq(providerCallbackEvents.providerAccountId, account),
                  eq(providerCallbackEvents.providerEventId, event)
                )
              )
              .orderBy(asc(providerCallbackEvents.id))
              .limit(1);
            return row
              ? { ...row, requestId: row.requestId!, bindingId: row.bindingId! }
              : null;
          },
          async saveCallback(row) {
            await store.insertProviderCallbackEvent(row, db);
          },
          async saveEvidence(row) {
            await store.insertProviderReconciliationRecord(row, db);
          },
          circuit: id =>
            store.getCircuitStateById(
              userId,
              id,
              db
            ) as Promise<CircuitStateView | null>,
          async saveCircuit(id, scope, row) {
            const current = await store.getCircuitStateById(userId, id, db);
            if (current)
              await store.updateCircuitState(
                userId,
                id,
                current.version,
                row,
                db
              );
            else
              await store.getOrInsertCircuitState(
                { circuitId: id, userId, ...scope, ...row, version: 1 },
                db
              );
          },
        };
        return work(port);
      });
    },
  };
}
