/**
 * Durable listening-state store (WBS-R5-A A5).
 *
 * One row per social_integrations binding: checkpoint/cursor, last success /
 * failure, failure classification, and operational counters. This is the
 * restart-safe listening progress authority (polling resumes from `cursor`
 * after process restart) and the observability source for A6.
 *
 * Counters and checkpoints are operational metadata — NOT evidence. Canonical
 * evidence lives exclusively in social_signals.
 */

import { eq, sql } from "drizzle-orm";
import { socialListeningStates, type SocialListeningState } from "@db/schema";
import { getDb } from "../../queries/connection";
import type { ListeningFailureClass } from "./failure-classes";

type StateDb = ReturnType<typeof getDb>;

export interface ListeningStateExecutor {
  select: StateDb["select"];
  insert: StateDb["insert"];
  update: StateDb["update"];
}

function resolveDb(executor?: ListeningStateExecutor): ListeningStateExecutor {
  return executor ?? getDb();
}

export type ListeningStatus = "active" | "blocked" | "unsupported" | "stale";
export type ListeningMechanism = "webhook" | "polling" | "unsupported";

export interface EnsureListeningStateInput {
  integrationId: number;
  userId: number;
  businessId: number | null;
  provider: string;
  platform: string;
  providerAccountId: string;
  mechanism: ListeningMechanism;
  status?: ListeningStatus;
}

/** Idempotently create the listening state for a binding; existing rows are
 *  returned untouched (checkpoints and counters survive). */
export async function ensureListeningState(
  input: EnsureListeningStateInput,
  executor?: ListeningStateExecutor
): Promise<{ state: SocialListeningState; inserted: boolean }> {
  const db = resolveDb(executor);

  const [existing] = await db
    .select()
    .from(socialListeningStates)
    .where(eq(socialListeningStates.integrationId, input.integrationId))
    .limit(1);
  if (existing) return { state: existing as SocialListeningState, inserted: false };

  const values = {
    integrationId: input.integrationId,
    userId: input.userId,
    businessId: input.businessId,
    provider: input.provider,
    platform: input.platform,
    providerAccountId: input.providerAccountId,
    mechanism: input.mechanism,
    status: input.status ?? ("active" as ListeningStatus),
  };
  try {
    await db.insert(socialListeningStates).values(values);
  } catch (err: any) {
    if (err?.code !== "ER_DUP_ENTRY" && err?.errno !== 1062) throw err;
    const [raced] = await db
      .select()
      .from(socialListeningStates)
      .where(eq(socialListeningStates.integrationId, input.integrationId))
      .limit(1);
    return { state: raced as SocialListeningState, inserted: false };
  }
  const [persisted] = await db
    .select()
    .from(socialListeningStates)
    .where(eq(socialListeningStates.integrationId, input.integrationId))
    .limit(1);
  return { state: persisted as SocialListeningState, inserted: true };
}

export async function getListeningState(
  integrationId: number,
  executor?: ListeningStateExecutor
): Promise<SocialListeningState | null> {
  const db = resolveDb(executor);
  const [row] = await db
    .select()
    .from(socialListeningStates)
    .where(eq(socialListeningStates.integrationId, integrationId))
    .limit(1);
  return (row as SocialListeningState | undefined) ?? null;
}

/** Advance the durable checkpoint after a successful page fetch. */
export async function advanceCheckpoint(
  integrationId: number,
  cursor: string,
  executor?: ListeningStateExecutor
): Promise<void> {
  const db = resolveDb(executor);
  await db
    .update(socialListeningStates)
    .set({ cursor, cursorUpdatedAt: new Date(), lastSuccessAt: new Date(), status: "active" })
    .where(eq(socialListeningStates.integrationId, integrationId));
}

export type SignalCounterKind = "accepted" | "duplicate" | "rejected";

/** Bump one operational counter after an ingestion outcome. */
export async function incrementSignalCounter(
  integrationId: number,
  kind: SignalCounterKind,
  executor?: ListeningStateExecutor
): Promise<void> {
  const db = resolveDb(executor);
  const column =
    kind === "accepted"
      ? socialListeningStates.acceptedCount
      : kind === "duplicate"
        ? socialListeningStates.duplicateCount
        : socialListeningStates.rejectedCount;
  await db
    .update(socialListeningStates)
    .set({ [column.name]: sql`${column} + 1` } as Partial<SocialListeningState>)
    .where(eq(socialListeningStates.integrationId, integrationId));
}

/** Record a classified failure against the binding. */
export async function recordListeningFailure(
  integrationId: number,
  failure: { class: ListeningFailureClass; code: string; reason: string },
  executor?: ListeningStateExecutor
): Promise<void> {
  const db = resolveDb(executor);
  await db
    .update(socialListeningStates)
    .set({
      lastFailureAt: new Date(),
      lastFailureClass: failure.class,
      lastFailureCode: failure.code.slice(0, 64),
      lastFailureReason: failure.reason.slice(0, 255),
      // AUTO_RECOVER keeps the binding active; operator/authority failures block it.
      status: failure.class === "AUTO_RECOVER" ? "active" : "blocked",
    })
    .where(eq(socialListeningStates.integrationId, integrationId));
}

/** Mark a binding whose mechanism is unsupported — explicit, never fake success. */
export async function markListeningUnsupported(
  integrationId: number,
  executor?: ListeningStateExecutor
): Promise<void> {
  const db = resolveDb(executor);
  await db
    .update(socialListeningStates)
    .set({ status: "unsupported", mechanism: "unsupported" })
    .where(eq(socialListeningStates.integrationId, integrationId));
}
