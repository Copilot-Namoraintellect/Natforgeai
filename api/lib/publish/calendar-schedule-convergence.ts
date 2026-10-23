/**
 * Calendar schedule → publishing queue convergence (WBS-R3.2 / GAP24).
 *
 * Closes the disjoint scheduling surface identified by the R1.7 audit: a
 * campaign-linked content post scheduled through schedule.create was gated by
 * the same launch-approval/readiness authority as the publishing queue, but
 * landed in the `schedules` table, which has no execution path — a dead-end
 * governed intake next to the real executor (`publishing_queue`).
 *
 * Convergence model:
 * - `publishing_queue` remains the SINGLE execution authority for the
 *   "publish content post at time T" transition (BullMQ job + due-scan both
 *   funnel into publishSinglePost; nothing new is scheduled here);
 * - the `schedules` row remains the planning/calendar display record;
 * - this module is the intake bridge: it resolves the declared calendar wall
 *   time through the existing WBS13.2 publication schedule authority (never
 *   ad-hoc date math), inserts one durable queue row, and schedules the
 *   existing BullMQ job. Retries of the same intake collapse onto the same
 *   queue row (deterministic replay key: user + content post + platform +
 *   canonical instant, excluding terminally failed attempts).
 *
 * Scope limits (repository-evidenced, not invented):
 * - Only campaign-linked content posts execute: publishing_queue.campaignId
 *   is NOT NULL, so the queue authority is campaign-scoped. One-off
 *   non-campaign posts stay planning-only records.
 * - Past instants are rejected by the not-before policy of the schedule
 *   authority (fail closed), consistent with publishing-router intake.
 * - schedule.update does not retro-move queue rows; execution truth lives in
 *   the queue (documented in docs/recovery/r3.2-gap24-scheduling-convergence.md).
 */

import { and, eq, isNull, ne } from "drizzle-orm";
import { publishingQueue } from "@db/schema";
import { getDb } from "../../queries/connection";
import {
  resolvePublicationSchedule,
  type ResolvedPublicationSchedule,
} from "./publication-schedule";
import { isBullMQAvailable, schedulePublishingJob } from "../queue/bullmq";

type Executor = Pick<ReturnType<typeof getDb>, "select" | "insert">;

export interface CalendarScheduleEnqueueInput {
  executor?: Executor;
  userId: number;
  campaignId: number;
  contentPostId: number;
  platform: string;
  scheduledDate: string;
  scheduledTime?: string | null;
  timezone?: string | null;
  /** Reference clock for the not-before policy; tests inject a fixed Date. */
  now?: Date;
}

export interface CalendarScheduleEnqueueResult {
  queueItemId: number;
  /** False when an equivalent live queue row already existed (idempotent replay). */
  created: boolean;
  schedule: ResolvedPublicationSchedule;
}

/**
 * Resolves the calendar intake (date + optional wall time + declared
 * timezone) through the WBS13.2 schedule authority. A missing wall time is
 * an explicit immediate publication (mirrors createPublishingQueue).
 */
export function resolveCalendarIntakeSchedule(input: {
  scheduledDate: string;
  scheduledTime?: string | null;
  timezone?: string | null;
  now?: Date;
}): ResolvedPublicationSchedule {
  const time = input.scheduledTime?.trim();
  if (!time) {
    return resolvePublicationSchedule({ mode: "immediate" }, { now: input.now });
  }
  return resolvePublicationSchedule(
    {
      mode: "scheduled",
      localDateTime: `${input.scheduledDate}T${time}`,
      timeZone: input.timezone?.trim() ? input.timezone : "UTC",
    },
    { now: input.now }
  );
}

function resolveExecutor(executor?: Executor): Executor {
  return executor ?? getDb();
}

/**
 * Deterministic replay key lookup: same user + content post + platform +
 * canonical instant, excluding terminally failed attempts (a failed attempt
 * must be re-intakeable).
 */
async function findLiveQueueRow(
  db: Executor,
  input: { userId: number; contentPostId: number; platform: string; scheduledAt: Date | null }
): Promise<{ id: number } | undefined> {
  const scheduledAtCondition = input.scheduledAt
    ? eq(publishingQueue.scheduledAt, input.scheduledAt)
    : isNull(publishingQueue.scheduledAt);
  const [row] = await db
    .select({ id: publishingQueue.id })
    .from(publishingQueue)
    .where(
      and(
        eq(publishingQueue.userId, input.userId),
        eq(publishingQueue.contentPostId, input.contentPostId),
        eq(publishingQueue.platform, input.platform),
        scheduledAtCondition,
        ne(publishingQueue.status, "failed")
      )
    )
    .limit(1);
  return row;
}

/**
 * Enqueue a calendar-scheduled campaign content post into the single
 * execution authority. Idempotent: an equivalent live queue row wins and is
 * returned with created=false. BullMQ scheduling is best-effort — with Redis
 * unavailable the approved row is still picked up by the existing due-scan
 * (buildDuePostsCondition), so there is no BullMQ-down stall.
 */
export async function enqueueCalendarScheduledPublication(
  input: CalendarScheduleEnqueueInput
): Promise<CalendarScheduleEnqueueResult> {
  const db = resolveExecutor(input.executor);
  const schedule = resolveCalendarIntakeSchedule(input);
  const canonicalScheduledAt =
    schedule.mode === "scheduled" ? new Date(schedule.scheduledAtUtcMillis) : null;
  // The durable platform convention is lowercase (runner switch, integrations).
  const platform = input.platform.trim().toLowerCase();

  const existing = await findLiveQueueRow(db, {
    userId: input.userId,
    contentPostId: input.contentPostId,
    platform,
    scheduledAt: canonicalScheduledAt,
  });
  if (existing) {
    return { queueItemId: existing.id, created: false, schedule };
  }

  const [result] = await db.insert(publishingQueue).values({
    userId: input.userId,
    campaignId: input.campaignId,
    contentPostId: input.contentPostId,
    platform,
    scheduledAt: canonicalScheduledAt,
    status: "approved",
    approvalRequired: false,
    maxRetries: 3,
    retryCount: 0,
  });
  const queueItemId = Number(result.insertId);

  if (canonicalScheduledAt && isBullMQAvailable()) {
    try {
      await schedulePublishingJob(queueItemId, input.userId, platform, canonicalScheduledAt);
    } catch (err: any) {
      console.error(
        `[CalendarSchedule] Failed to schedule BullMQ job for ${queueItemId}:`,
        err?.message
      );
    }
  }

  return { queueItemId, created: true, schedule };
}
