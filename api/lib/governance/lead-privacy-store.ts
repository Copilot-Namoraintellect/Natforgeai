/**
 * R6-F lead privacy governance store (F3).
 *
 * Durable operational privacy state per lead: ACTIVE / SUPPRESSED /
 * RESTRICTED / RETENTION_PENDING / RETENTION_EXPIRED / ARCHIVED.
 *
 * The table (`lead_privacy_states`, migration artefact 0034 — created, NOT
 * executed) may be absent in pre-migration environments. Every entry point is
 * therefore guarded by an information-schema check: reads degrade to
 * `available: false` (honest, never guessed) and writes/mutations fail closed
 * with LEAD_PRIVACY_SCHEMA_UNAVAILABLE. This mirrors the R5-F stream-evidence
 * bridge discipline.
 *
 * Governance rules enforced here (normative):
 * - transitions follow LEAD_PRIVACY_TRANSITIONS only; the graph has no cycles
 *   back out of ARCHIVED (terminal) and no silent resurrection paths;
 * - every transition is CAS-guarded on the current state → stale requests are
 *   rejected and duplicate/concurrent requests converge;
 * - suppressed / restricted / retention-expired leads are not actionable
 *   (see leadPrivacyGateFor) — nurture/contact streams must consult the gate;
 * - no PII is stored here: references + closed vocabulary + provenance only;
 * - identity history (previousState chain) remains on the durable row.
 */

import { and, eq, sql } from "drizzle-orm";
import { leadPrivacyStates } from "@db/schema";
import type { getDb } from "../../queries/connection";

type Db = ReturnType<typeof getDb>;

/** Structural executor seam: the default client and a transaction client both satisfy it. */
export interface LeadGovernanceDb {
  select: Db["select"];
  insert: Db["insert"];
  update: Db["update"];
  execute: Db["execute"];
}

export const LEAD_PRIVACY_STATES = [
  "ACTIVE",
  "SUPPRESSED",
  "RESTRICTED",
  "RETENTION_PENDING",
  "RETENTION_EXPIRED",
  "ARCHIVED",
] as const;

export type LeadPrivacyState = (typeof LEAD_PRIVACY_STATES)[number];

const LEAD_PRIVACY_STATE_SET: ReadonlySet<string> = new Set(LEAD_PRIVACY_STATES);

export function isLeadPrivacyState(value: unknown): value is LeadPrivacyState {
  return typeof value === "string" && LEAD_PRIVACY_STATE_SET.has(value);
}

/**
 * Allowed governance transitions. Deliberately narrow:
 * - ARCHIVED is terminal (no outgoing edges);
 * - RETENTION_EXPIRED is only reachable from RETENTION_PENDING (via the
 *   deterministic sweep or an explicit governance decision) — leads cannot
 *   jump straight from ACTIVE to expired without a declared retention window;
 * - SUPPRESSED/RESTRICTED lift back to ACTIVE only through an explicit
 *   governance decision (never automatic).
 */
export const LEAD_PRIVACY_TRANSITIONS: Record<LeadPrivacyState, readonly LeadPrivacyState[]> = {
  ACTIVE: ["SUPPRESSED", "RESTRICTED", "RETENTION_PENDING"],
  SUPPRESSED: ["ACTIVE", "RETENTION_PENDING", "ARCHIVED"],
  RESTRICTED: ["ACTIVE", "ARCHIVED"],
  RETENTION_PENDING: ["ACTIVE", "RETENTION_EXPIRED", "ARCHIVED"],
  RETENTION_EXPIRED: ["ARCHIVED"],
  ARCHIVED: [],
};

export function isLeadPrivacyTransitionAllowed(
  from: LeadPrivacyState,
  to: LeadPrivacyState
): boolean {
  return LEAD_PRIVACY_TRANSITIONS[from].includes(to);
}

export class LeadPrivacyGovernanceError extends Error {
  readonly code:
    | "LEAD_PRIVACY_SCHEMA_UNAVAILABLE"
    | "LEAD_PRIVACY_TRANSITION_FORBIDDEN"
    | "LEAD_PRIVACY_STALE_STATE"
    | "LEAD_PRIVACY_VALIDATION";

  constructor(
    code: LeadPrivacyGovernanceError["code"],
    message: string
  ) {
    super(message);
    this.name = "LeadPrivacyGovernanceError";
    this.code = code;
  }
}

const LEAD_PRIVACY_TABLE = "lead_privacy_states";

async function leadPrivacyTableAvailable(db: LeadGovernanceDb): Promise<boolean> {
  const result = await db.execute(sql`
    SELECT COUNT(*) AS c
    FROM information_schema.tables
    WHERE table_schema = DATABASE() AND table_name = ${LEAD_PRIVACY_TABLE}
  `);
  const rows = (result as unknown as { c?: number | string | bigint }[][] | undefined)?.[0];
  const first = Array.isArray(rows) ? rows[0] : undefined;
  const count = first?.c === undefined ? 0 : Number(first.c);
  return count > 0;
}

export interface LeadPrivacyEvidence {
  /** False when the 0034 migration has not executed (table absent). */
  available: boolean;
  reason?: string;
  /** Current operational state. "ACTIVE" is also the implicit default when no row exists. */
  state: LeadPrivacyState;
  /** True when a durable privacy row exists for the lead. */
  explicit: boolean;
  retentionDeadlineAt: Date | null;
  previousState: LeadPrivacyState | null;
  source: string | null;
  actorUserId: number | null;
  updatedAt: Date | null;
}

const PRIVACY_SELECT = {
  leadId: leadPrivacyStates.leadId,
  privacyState: leadPrivacyStates.privacyState,
  previousState: leadPrivacyStates.previousState,
  retentionDeadlineAt: leadPrivacyStates.retentionDeadlineAt,
  source: leadPrivacyStates.source,
  actorUserId: leadPrivacyStates.actorUserId,
  updatedAt: leadPrivacyStates.updatedAt,
} as const;

export async function readLeadPrivacyEvidence(
  db: LeadGovernanceDb,
  leadId: number
): Promise<LeadPrivacyEvidence> {
  if (!(await leadPrivacyTableAvailable(db))) {
    return {
      available: false,
      reason: "privacy_table_absent",
      state: "ACTIVE",
      explicit: false,
      retentionDeadlineAt: null,
      previousState: null,
      source: null,
      actorUserId: null,
      updatedAt: null,
    };
  }
  const [row] = await db
    .select(PRIVACY_SELECT)
    .from(leadPrivacyStates)
    .where(eq(leadPrivacyStates.leadId, leadId))
    .limit(1);
  if (!row) {
    return {
      available: true,
      state: "ACTIVE",
      explicit: false,
      retentionDeadlineAt: null,
      previousState: null,
      source: null,
      actorUserId: null,
      updatedAt: null,
    };
  }
  return {
    available: true,
    state: row.privacyState,
    explicit: true,
    retentionDeadlineAt: row.retentionDeadlineAt ?? null,
    previousState: row.previousState ?? null,
    source: row.source,
    actorUserId: row.actorUserId ?? null,
    updatedAt: row.updatedAt ?? null,
  };
}

export interface LeadPrivacyGate {
  state: LeadPrivacyState;
  /** False ⇒ nurture sequences must not run against this lead. */
  nurtureAllowed: boolean;
  /** False ⇒ direct contact (email/phone/social) must not be attempted. */
  contactAllowed: boolean;
  /** False ⇒ the lead must not appear in actionable work queues. */
  actionable: boolean;
  /** Closed blocker class when the gate is closed, else null. */
  blockedReason: "PRIVACY_SUPPRESSED" | "RETENTION_EXPIRED" | null;
}

/**
 * Privacy gate consulted by nurture/contact surfaces (and by F's own
 * recovery classifier). Suppressed and retention-expired leads cannot be
 * nurtured or contacted; the classification is deterministic over the state.
 */
export function leadPrivacyGateFor(state: LeadPrivacyState): LeadPrivacyGate {
  switch (state) {
    case "ACTIVE":
      return { state, nurtureAllowed: true, contactAllowed: true, actionable: true, blockedReason: null };
    case "SUPPRESSED":
      return { state, nurtureAllowed: false, contactAllowed: false, actionable: false, blockedReason: "PRIVACY_SUPPRESSED" };
    case "RESTRICTED":
      return { state, nurtureAllowed: false, contactAllowed: false, actionable: false, blockedReason: "PRIVACY_SUPPRESSED" };
    case "RETENTION_PENDING":
      return { state, nurtureAllowed: true, contactAllowed: true, actionable: true, blockedReason: null };
    case "RETENTION_EXPIRED":
      return { state, nurtureAllowed: false, contactAllowed: false, actionable: false, blockedReason: "RETENTION_EXPIRED" };
    case "ARCHIVED":
      return { state, nurtureAllowed: false, contactAllowed: false, actionable: false, blockedReason: "RETENTION_EXPIRED" };
  }
}

export interface TransitionLeadPrivacyInput {
  leadId: number;
  userId: number;
  businessId: number | null;
  targetState: LeadPrivacyState;
  /** Bounded governance reason (≤500). Required when closing/lifting processing. */
  reason?: string | null;
  /** Required when targetState is RETENTION_PENDING; must be in the future. */
  retentionDeadlineAt?: Date | null;
  source: string;
  actorUserId: number | null;
  now: Date;
}

export interface LeadPrivacyTransitionResult {
  outcome: "transitioned" | "already_applied";
  before: LeadPrivacyState;
  after: LeadPrivacyState;
  retentionDeadlineAt: Date | null;
}

function validateTransitionInput(input: TransitionLeadPrivacyInput): void {
  if (!Number.isInteger(input.leadId) || input.leadId <= 0) {
    throw new LeadPrivacyGovernanceError("LEAD_PRIVACY_VALIDATION", "leadId must be a positive integer.");
  }
  if (!Number.isInteger(input.userId) || input.userId <= 0) {
    throw new LeadPrivacyGovernanceError("LEAD_PRIVACY_VALIDATION", "userId must be a positive integer.");
  }
  if (input.targetState === "RETENTION_PENDING") {
    const deadline = input.retentionDeadlineAt;
    if (!(deadline instanceof Date) || Number.isNaN(deadline.getTime())) {
      throw new LeadPrivacyGovernanceError(
        "LEAD_PRIVACY_VALIDATION",
        "retentionDeadlineAt is required when targetState is RETENTION_PENDING."
      );
    }
    if (deadline.getTime() <= input.now.getTime()) {
      throw new LeadPrivacyGovernanceError(
        "LEAD_PRIVACY_VALIDATION",
        "retentionDeadlineAt must be in the future."
      );
    }
  }
}

/**
 * CAS-governed privacy state transition. Idempotent: re-applying the current
 * target converges to `already_applied` without writing. Stale/concurrent
 * requests fail closed or converge through the state guard.
 */
export async function transitionLeadPrivacyState(
  db: LeadGovernanceDb,
  input: TransitionLeadPrivacyInput
): Promise<LeadPrivacyTransitionResult> {
  validateTransitionInput(input);
  if (!(await leadPrivacyTableAvailable(db))) {
    throw new LeadPrivacyGovernanceError(
      "LEAD_PRIVACY_SCHEMA_UNAVAILABLE",
      "lead privacy governance schema is not migrated; refusing to mutate (see docs/recovery/r6-f-unexecuted-migrations.md)."
    );
  }

  const current = await readLeadPrivacyEvidence(db, input.leadId);
  const from = current.state;

  if (from === input.targetState) {
    return {
      outcome: "already_applied",
      before: from,
      after: from,
      retentionDeadlineAt: current.retentionDeadlineAt,
    };
  }
  if (!isLeadPrivacyTransitionAllowed(from, input.targetState)) {
    throw new LeadPrivacyGovernanceError(
      "LEAD_PRIVACY_TRANSITION_FORBIDDEN",
      `transition ${from} → ${input.targetState} is not an allowed governance transition.`
    );
  }

  const keepDeadline =
    input.targetState === "RETENTION_PENDING" || input.targetState === "RETENTION_EXPIRED";
  const nextDeadline = keepDeadline
    ? (input.retentionDeadlineAt ?? current.retentionDeadlineAt)
    : null;
  const setValues = {
    privacyState: input.targetState,
    previousState: from,
    reason: input.reason?.trim() ? input.reason.trim().slice(0, 500) : null,
    retentionDeadlineAt: nextDeadline,
    source: input.source,
    actorUserId: input.actorUserId,
    updatedAt: input.now,
  };

  if (!current.explicit) {
    try {
      await db.insert(leadPrivacyStates).values({
        leadId: input.leadId,
        userId: input.userId,
        businessId: input.businessId,
        ...setValues,
      });
    } catch (err) {
      // Lost an insert race on lps_lead_uidx: re-read and converge honestly.
      if (!isDuplicateKeyError(err)) throw err;
      const raced = await readLeadPrivacyEvidence(db, input.leadId);
      if (raced.state === input.targetState) {
        return {
          outcome: "already_applied",
          before: raced.state,
          after: raced.state,
          retentionDeadlineAt: raced.retentionDeadlineAt,
        };
      }
      throw new LeadPrivacyGovernanceError(
        "LEAD_PRIVACY_STALE_STATE",
        `concurrent privacy transition detected; current state is ${raced.state}.`
      );
    }
    return { outcome: "transitioned", before: from, after: input.targetState, retentionDeadlineAt: nextDeadline };
  }

  const result = await db
    .update(leadPrivacyStates)
    .set(setValues)
    .where(
      and(
        eq(leadPrivacyStates.leadId, input.leadId),
        eq(leadPrivacyStates.privacyState, from)
      )
    );
  const affected = affectedRowsOf(result);
  if (affected > 0) {
    return { outcome: "transitioned", before: from, after: input.targetState, retentionDeadlineAt: nextDeadline };
  }

  // CAS lost: re-read and converge or fail closed on genuine staleness.
  const raced = await readLeadPrivacyEvidence(db, input.leadId);
  if (raced.state === input.targetState) {
    return {
      outcome: "already_applied",
      before: raced.state,
      after: raced.state,
      retentionDeadlineAt: raced.retentionDeadlineAt,
    };
  }
  throw new LeadPrivacyGovernanceError(
    "LEAD_PRIVACY_STALE_STATE",
    `stale privacy state: current state is ${raced.state}.`
  );
}

export interface LeadRetentionSweepInput {
  businessId: number;
  now: Date;
}

export interface LeadRetentionSweepResult {
  /** RETENTION_PENDING rows evaluated for this business. */
  evaluatedCount: number;
  /** Rows transitioned RETENTION_PENDING → RETENTION_EXPIRED by this run. */
  expiredCount: number;
  /** True when the sweep found nothing to expire (idempotent convergence). */
  converged: boolean;
}

/**
 * Deterministic retention reconciliation (F6's backed-by-real-authority
 * recovery operation): every RETENTION_PENDING lead owned by the business
 * whose retentionDeadlineAt has passed transitions to RETENTION_EXPIRED via
 * an exact CAS guard. Re-runs converge (converged=true, expiredCount=0);
 * concurrent sweeps serialize on the row CAS.
 */
export async function sweepLeadRetention(
  db: LeadGovernanceDb,
  input: LeadRetentionSweepInput
): Promise<LeadRetentionSweepResult> {
  if (!Number.isInteger(input.businessId) || input.businessId <= 0) {
    throw new LeadPrivacyGovernanceError("LEAD_PRIVACY_VALIDATION", "businessId must be a positive integer.");
  }
  if (!(await leadPrivacyTableAvailable(db))) {
    throw new LeadPrivacyGovernanceError(
      "LEAD_PRIVACY_SCHEMA_UNAVAILABLE",
      "lead privacy governance schema is not migrated; refusing to run retention sweep."
    );
  }

  const pending = await db
    .select({
      leadId: leadPrivacyStates.leadId,
      retentionDeadlineAt: leadPrivacyStates.retentionDeadlineAt,
    })
    .from(leadPrivacyStates)
    .where(
      and(
        eq(leadPrivacyStates.businessId, input.businessId),
        eq(leadPrivacyStates.privacyState, "RETENTION_PENDING")
      )
    );

  let expiredCount = 0;
  for (const row of pending) {
    const deadline = row.retentionDeadlineAt;
    if (!(deadline instanceof Date) || Number.isNaN(deadline.getTime())) continue;
    if (deadline.getTime() > input.now.getTime()) continue;
    const result = await db
      .update(leadPrivacyStates)
      .set({
        privacyState: "RETENTION_EXPIRED",
        previousState: "RETENTION_PENDING",
        updatedAt: input.now,
      })
      .where(
        and(
          eq(leadPrivacyStates.leadId, row.leadId),
          eq(leadPrivacyStates.privacyState, "RETENTION_PENDING")
        )
      );
    const affected = affectedRowsOf(result);
    if (affected > 0) expiredCount += 1;
  }

  return {
    evaluatedCount: pending.length,
    expiredCount,
    converged: expiredCount === 0,
  };
}

/**
 * Reads the affected-rows count from either mysql2 ResultSetHeader shape
 * (`result.affectedRows`) or the `[ResultSetHeader]` tuple shape
 * (`result[0].affectedRows`). Unknown shapes ⇒ 0.
 */
function affectedRowsOf(result: unknown): number {
  const direct = (result as { affectedRows?: unknown } | null | undefined)?.affectedRows;
  if (typeof direct === "number") return direct;
  const first = Array.isArray(result)
    ? (result as Array<{ affectedRows?: unknown }>)[0]
    : undefined;
  return typeof first?.affectedRows === "number" ? first.affectedRows : 0;
}

function isDuplicateKeyError(err: unknown): boolean {
  const e = err as { code?: unknown; errno?: unknown } | null;
  let depth = 0;
  let current: unknown = err;
  const seen = new WeakSet<object>();
  while (current !== null && typeof current === "object" && depth < 5) {
    if (seen.has(current as object)) break;
    seen.add(current as object);
    const code = (current as { code?: unknown }).code;
    const errno = (current as { errno?: unknown }).errno;
    if (code === "ER_DUP_ENTRY" || errno === 1062) return true;
    current = (current as { cause?: unknown }).cause;
    depth += 1;
  }
  return e?.code === "ER_DUP_ENTRY" || e?.errno === 1062;
}
