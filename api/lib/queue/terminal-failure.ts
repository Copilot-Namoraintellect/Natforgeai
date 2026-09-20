import { UnrecoverableError } from "bullmq";
import { eq } from "drizzle-orm";
import { queueTerminalFailures, type QueueTerminalFailure } from "@db/schema";
import { getDb } from "../../queries/connection";
import { createAlert } from "../alerts";
import type { ContentGenerationJobData, PublishingJobData } from "./bullmq";

/**
 * Durable terminal-failure authority for BullMQ jobs.
 *
 * Persists exactly one queue_terminal_failures row per terminally-failed job
 * (UnrecoverableError, or ordinary error with retry attempts exhausted).
 * Transient/retryable failures never produce a row here.
 */

export type TerminalQueueName = "publishing" | "content_generation";
export type TerminalReason = "unrecoverable" | "retries_exhausted";

export interface QueueJobFailureInput {
  attemptsMade: number;
  attemptsConfigured?: number | null;
  unrecoverable: boolean;
}

export type TerminalClassification =
  | { terminal: true; terminalReason: TerminalReason }
  | { terminal: false };

/**
 * Pure terminal classifier for a BullMQ `failed` event.
 *
 * - UnrecoverableError is terminal immediately, even with attempts remaining.
 * - An ordinary error is terminal only when no configured attempts remain.
 * - Absent attemptsConfigured uses BullMQ's effective single-attempt default.
 * - Malformed (negative / non-integer / NaN) attempt data is rejected.
 */
export function classifyQueueJobFailure(input: QueueJobFailureInput): TerminalClassification {
  const { attemptsMade, unrecoverable } = input;
  const attemptsConfigured = input.attemptsConfigured ?? 1;

  if (!Number.isInteger(attemptsMade) || attemptsMade < 1) {
    throw new TypeError(`Malformed attemptsMade: ${String(attemptsMade)}`);
  }
  if (!Number.isInteger(attemptsConfigured) || attemptsConfigured < 1) {
    throw new TypeError(`Malformed attemptsConfigured: ${String(input.attemptsConfigured)}`);
  }

  if (unrecoverable) {
    return { terminal: true, terminalReason: "unrecoverable" };
  }
  if (attemptsMade >= attemptsConfigured) {
    return { terminal: true, terminalReason: "retries_exhausted" };
  }
  return { terminal: false };
}

export function isUnrecoverableJobError(error: unknown): boolean {
  return (
    error instanceof UnrecoverableError ||
    (error instanceof Error && error.name === "UnrecoverableError")
  );
}

/**
 * Deterministic durable identity for a terminal failure. The queue name
 * namespaces the BullMQ job id so identical textual ids on different queues
 * can never collide. No timestamps or random material.
 */
export function buildTerminalFailureKey(
  queueName: TerminalQueueName,
  bullmqJobId: string
): string {
  return `qtf:v1:${queueName}:${bullmqJobId}`;
}

const REDACTION_PATTERNS: Array<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]"],
  [
    /\b(token|password|passwd|secret|authorization|credential|api[\s_-]?key)\b(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi,
    "$1$2[redacted]",
  ],
];

/**
 * Bounded, redacted error summary. Never persists stack traces; only a
 * sanitized rendering of the error message.
 */
export function sanitizeErrorSummary(message: unknown, maxLength = 1000): string | null {
  if (message == null) return null;
  let text = String(message);
  for (const [pattern, replacement] of REDACTION_PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  if (text.length > maxLength) {
    text = `${text.slice(0, maxLength)}[truncated]`;
  }
  return text.trim().length > 0 ? text : null;
}

export function sanitizeBoundedText(value: unknown, maxLength: number): string | null {
  if (value == null) return null;
  const text = String(value);
  return text.length > 0 ? text.slice(0, maxLength) : null;
}

export interface TerminalFailureContext {
  queueName: TerminalQueueName;
  bullmqJobId: string;
  userId: number;
  campaignId: number | null;
  publishingQueueItemId: number | null;
  agentRunId: number | null;
}

/** Controlled identifiers from the publishing job contract only. */
export function publishingTerminalContext(
  job: { id?: string },
  data: PublishingJobData
): TerminalFailureContext {
  return {
    queueName: "publishing",
    bullmqJobId: String(job.id),
    userId: data.userId,
    campaignId: (data as { campaignId?: number | null }).campaignId ?? null,
    publishingQueueItemId: data.queueItemId,
    agentRunId: null,
  };
}

/** Controlled identifiers from the content-generation job contract only. */
export function contentGenerationTerminalContext(
  job: { id?: string },
  data: ContentGenerationJobData
): TerminalFailureContext {
  return {
    queueName: "content_generation",
    bullmqJobId: String(job.id),
    userId: data.userId,
    campaignId: data.campaignId ?? null,
    publishingQueueItemId: null,
    agentRunId: data.jobId,
  };
}

export interface PersistTerminalQueueFailureInput extends TerminalFailureContext {
  terminalReason: TerminalReason;
  attemptsMade: number;
  attemptsConfigured: number;
  errorName?: string | null;
  errorCode?: string | null;
  errorSummary?: string | null;
  failedAt: Date;
}

export interface PersistTerminalQueueFailureResult {
  record: QueueTerminalFailure;
  alreadyRecorded: boolean;
}

type DbClient = ReturnType<typeof getDb>;

/**
 * Structural executor seam, consistent with the billing executor pattern: the
 * default getDb() client and a Drizzle transaction client both satisfy it.
 */
export interface TerminalFailureExecutor {
  select: DbClient["select"];
  insert: DbClient["insert"];
}

/** Narrow local duplicate-key detector (MySQL ER_DUP_ENTRY / errno 1062). */
export function isMySqlDuplicateKeyError(err: unknown): boolean {
  const seen = new WeakSet<object>();
  let current: unknown = err;
  let depth = 0;
  while (current && typeof current === "object" && depth < 5) {
    if (seen.has(current)) break;
    seen.add(current);
    const e = current as Record<string, unknown>;
    if (e.code === "ER_DUP_ENTRY" || e.errno === 1062) return true;
    current = e.cause;
    depth++;
  }
  return false;
}

export class TerminalFailureIdentityConflictError extends Error {
  readonly failureKey: string;
  readonly committed: QueueTerminalFailure;
  readonly attempted: PersistTerminalQueueFailureInput;

  constructor(
    failureKey: string,
    committed: QueueTerminalFailure,
    attempted: PersistTerminalQueueFailureInput
  ) {
    super(
      `Terminal failure identity conflict for ${failureKey}: committed queue/job/domain identity differs`
    );
    this.name = "TerminalFailureIdentityConflictError";
    this.failureKey = failureKey;
    this.committed = committed;
    this.attempted = attempted;
  }
}

function normalizeNullableId(value: number | null | undefined): number | null {
  return value == null ? null : value;
}

function assertIdentityMatch(
  committed: QueueTerminalFailure,
  attempted: PersistTerminalQueueFailureInput
): void {
  const same =
    committed.queueName === attempted.queueName &&
    committed.bullmqJobId === attempted.bullmqJobId &&
    committed.userId === attempted.userId &&
    normalizeNullableId(committed.campaignId) === normalizeNullableId(attempted.campaignId) &&
    normalizeNullableId(committed.publishingQueueItemId) ===
      normalizeNullableId(attempted.publishingQueueItemId) &&
    normalizeNullableId(committed.agentRunId) === normalizeNullableId(attempted.agentRunId);
  if (!same) {
    throw new TerminalFailureIdentityConflictError(
      buildTerminalFailureKey(attempted.queueName, attempted.bullmqJobId),
      committed,
      attempted
    );
  }
}

/**
 * Persist (or reuse) the single durable terminal-failure row for a job.
 *
 * The unique constraint on failureKey is the concurrency authority: an exact
 * duplicate replay (or a duplicate-key race) reuses the committed row; a
 * conflicting immutable identity fails closed. No select-then-insert race is
 * relied upon.
 */
export async function persistTerminalQueueFailure(
  input: PersistTerminalQueueFailureInput,
  executor?: TerminalFailureExecutor
): Promise<PersistTerminalQueueFailureResult> {
  const db = executor ?? getDb();
  const failureKey = buildTerminalFailureKey(input.queueName, input.bullmqJobId);
  const values = {
    failureKey,
    queueName: input.queueName,
    bullmqJobId: input.bullmqJobId,
    terminalReason: input.terminalReason,
    attemptsMade: input.attemptsMade,
    attemptsConfigured: input.attemptsConfigured,
    userId: input.userId,
    campaignId: input.campaignId,
    publishingQueueItemId: input.publishingQueueItemId,
    agentRunId: input.agentRunId,
    errorName: input.errorName ?? null,
    errorCode: input.errorCode ?? null,
    errorSummary: input.errorSummary ?? null,
    failedAt: input.failedAt,
    status: "open" as const,
  };

  try {
    const [header] = await db.insert(queueTerminalFailures).values(values);
    const record = { ...values, id: Number((header as { insertId?: number }).insertId) };
    return { record: record as QueueTerminalFailure, alreadyRecorded: false };
  } catch (error) {
    if (!isMySqlDuplicateKeyError(error)) throw error;
    const [existing] = await db
      .select()
      .from(queueTerminalFailures)
      .where(eq(queueTerminalFailures.failureKey, failureKey))
      .limit(1);
    if (!existing) throw error;
    assertIdentityMatch(existing, input);
    return { record: existing, alreadyRecorded: true };
  }
}

export type TerminalPersistenceOutcome =
  | { kind: "transient" }
  | { kind: "recorded"; failureKey: string }
  | { kind: "replayed"; failureKey: string };

interface FailedJobShape<TData> {
  id?: string;
  attemptsMade: number;
  opts?: { attempts?: number };
  data: TData;
}

function errorMaterial(error: unknown): {
  errorName: string | null;
  errorCode: string | null;
  errorSummary: string | null;
} {
  const err = error as { name?: unknown; code?: unknown; message?: unknown } | null | undefined;
  return {
    errorName: sanitizeBoundedText(err?.name, 128),
    errorCode: sanitizeErrorSummary(err?.code, 64),
    errorSummary: sanitizeErrorSummary(err?.message),
  };
}

async function persistTerminalForJob(
  context: TerminalFailureContext,
  classification: Extract<TerminalClassification, { terminal: true }>,
  job: { attemptsMade: number; opts?: { attempts?: number } },
  error: unknown,
  failedAt: Date,
  executor?: TerminalFailureExecutor
): Promise<TerminalPersistenceOutcome> {
  const failureKey = buildTerminalFailureKey(context.queueName, context.bullmqJobId);
  const result = await persistTerminalQueueFailure(
    {
      ...context,
      terminalReason: classification.terminalReason,
      attemptsMade: job.attemptsMade,
      attemptsConfigured: job.opts?.attempts ?? 1,
      ...errorMaterial(error),
      failedAt,
    },
    executor
  );
  return { kind: result.alreadyRecorded ? "replayed" : "recorded", failureKey };
}

/** Classify + persist for a publishing failed event. */
export async function handleTerminalPublishingFailure({
  job,
  error,
  failedAt = new Date(),
  executor,
}: {
  job: FailedJobShape<PublishingJobData> | null | undefined;
  error: unknown;
  failedAt?: Date;
  executor?: TerminalFailureExecutor;
}): Promise<TerminalPersistenceOutcome> {
  if (!job?.id || !job.data) return { kind: "transient" };
  const classification = classifyQueueJobFailure({
    attemptsMade: job.attemptsMade,
    attemptsConfigured: job.opts?.attempts,
    unrecoverable: isUnrecoverableJobError(error),
  });
  if (!classification.terminal) return { kind: "transient" };
  return persistTerminalForJob(
    publishingTerminalContext(job, job.data),
    classification,
    job,
    error,
    failedAt,
    executor
  );
}

/** Classify + persist for a content-generation failed event. */
export async function handleTerminalContentGenerationFailure({
  job,
  error,
  failedAt = new Date(),
  executor,
}: {
  job: FailedJobShape<ContentGenerationJobData> | null | undefined;
  error: unknown;
  failedAt?: Date;
  executor?: TerminalFailureExecutor;
}): Promise<TerminalPersistenceOutcome> {
  if (!job?.id || !job.data) return { kind: "transient" };
  const classification = classifyQueueJobFailure({
    attemptsMade: job.attemptsMade,
    attemptsConfigured: job.opts?.attempts,
    unrecoverable: isUnrecoverableJobError(error),
  });
  if (!classification.terminal) return { kind: "transient" };
  return persistTerminalForJob(
    contentGenerationTerminalContext(job, job.data),
    classification,
    job,
    error,
    failedAt,
    executor
  );
}

/**
 * Containment wrapper for worker `failed` listeners: a persistence failure
 * must never crash the callback or surface as an unhandled rejection. It is
 * logged and escalated through the existing alert authority instead.
 */
export async function runContainedTerminalPersistence(
  attempt: () => Promise<TerminalPersistenceOutcome>,
  alertContext: { queueName: TerminalQueueName; bullmqJobId: string | undefined }
): Promise<void> {
  try {
    await attempt();
  } catch (persistError) {
    const reason = (persistError as Error)?.message ?? String(persistError);
    console.error(
      `[TerminalFailure] Failed to persist terminal ${alertContext.queueName} job ${alertContext.bullmqJobId ?? "unknown"}:`,
      reason
    );
    await createAlert({
      severity: "critical",
      category: "queue",
      message: `Failed to persist queue terminal failure (${alertContext.queueName} job ${
        alertContext.bullmqJobId ?? "unknown"
      })`,
      details: {
        queueName: alertContext.queueName,
        bullmqJobId: alertContext.bullmqJobId ?? null,
        error: reason.slice(0, 500),
      },
    }).catch(() => {});
  }
}
