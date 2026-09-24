// ─── Publication schedule authority (WBS13.2) ───
//
// Deterministic, timezone-safe scheduling authority for Distribution. Produces
// exactly one canonical resolved schedule record per publication intent,
// before any work enters durable execution (publishing_queue / BullMQ).
//
// Modes:
//   immediate — explicit; carries no scheduled timestamp.
//   scheduled — declared local wall time + declared IANA timezone, or an
//               explicit UTC instant, resolved to one canonical UTC instant.
//
// Guarantees:
//   - Fail closed. No silent server-timezone fallback. A local time without a
//     declared timezone, an invalid timezone, an invalid/nonexistent local
//     timestamp, malformed input, or a scheduled instant that violates the
//     not-before policy is rejected with BAD_REQUEST.
//   - DST safe. UTC conversion runs through explicit IANA zone offsets. Fold
//     (ambiguous) wall times resolve deterministically to the earlier UTC
//     instant and are annotated; gap (nonexistent) wall times are rejected.
//   - Machine-local independence. Resolution uses only Date.UTC arithmetic
//     and Intl.DateTimeFormat with an explicit timeZone — never the server's
//     local timezone, so results do not vary between machines or TZ settings.
//   - Replay determinism. The same input (including the policy clock) always
//     resolves to the identical frozen canonical record.
//
// Canonical instant representation: whole-second ISO 8601 "Z" form
// (Date.prototype.toISOString of a second-aligned instant). The existing
// publishing_queue.scheduledAt column is a MySQL timestamp without fractional
// seconds, so the schedule record, the queue row, and the PublishPackage
// intent must all compare equal at second precision.
//
// Persistence note: pure module — no database, provider, adapter, or queue
// calls. Binding to publishing_queue rows and PublishPackage intents happens
// through the pure helpers at the bottom of this file; production wiring of
// those helpers into the routers/runner is a later convergence step.

import { TRPCError } from "@trpc/server";
import type { PublishPackageIntent } from "./publish-package-contract";

export const PUBLICATION_SCHEDULE_SCHEMA_VERSION = 1 as const;

export type PublicationScheduleMode = "immediate" | "scheduled";

/** How a scheduled instant was requested. */
export type PublicationScheduleSource = "local" | "instant";

/** Fold (fall-back) ambiguity handling annotation for local-time schedules. */
export type PublicationScheduleDstAmbiguity =
  | "none"
  | "fold-resolved-to-earlier-instant";

interface ResolvedPublicationScheduleBase {
  readonly schemaVersion: typeof PUBLICATION_SCHEDULE_SCHEMA_VERSION;
}

/**
 * Canonical resolved schedule for an explicit immediate publication. Carries
 * no scheduled timestamp, so there is no immediate-mode timestamp ambiguity.
 */
export interface ImmediatePublicationSchedule extends ResolvedPublicationScheduleBase {
  readonly mode: "immediate";
  readonly requestedVia: "immediate";
  readonly scheduledAtUtcIso: null;
  readonly scheduledAtUtcMillis: null;
  readonly requestedLocalDateTime: null;
  readonly requestedTimezone: null;
  readonly resolvedOffsetUtc: null;
  readonly dstAmbiguity: "none";
}

/**
 * Canonical resolved schedule for a scheduled publication. scheduledAtUtcIso /
 * scheduledAtUtcMillis are the single deterministic UTC instant of
 * publication; requestedLocalDateTime / requestedTimezone preserve the
 * original local request when one was declared (null for instant-form input).
 */
export interface ScheduledPublicationSchedule extends ResolvedPublicationScheduleBase {
  readonly mode: "scheduled";
  readonly requestedVia: PublicationScheduleSource;
  readonly scheduledAtUtcIso: string;
  readonly scheduledAtUtcMillis: number;
  readonly requestedLocalDateTime: string | null;
  readonly requestedTimezone: string | null;
  readonly resolvedOffsetUtc: string | null;
  readonly dstAmbiguity: PublicationScheduleDstAmbiguity;
}

export type ResolvedPublicationSchedule =
  | ImmediatePublicationSchedule
  | ScheduledPublicationSchedule;

/** Typed request shapes; the resolver itself accepts unknown and fails closed. */
export type PublicationScheduleInput =
  | { readonly mode: "immediate" }
  | {
      readonly mode: "scheduled";
      readonly localDateTime: string;
      readonly timeZone: string;
    }
  | { readonly mode: "scheduled"; readonly scheduledAtUtc: string };

export interface ResolvePublicationScheduleOptions {
  /**
   * Reference clock for the not-before policy gate. Defaults to the real
   * clock. Inject a fixed Date in tests so resolution is fully deterministic.
   */
  readonly now?: Date;
}

// ─── Fail-closed helpers ───

function failClosed(message: string): never {
  throw new TRPCError({
    code: "BAD_REQUEST",
    message: `Publication schedule: ${message}`,
  });
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null;
}

// ─── Calendar validation (deterministic, no ICU, no local time) ───

interface DateTimeComponents {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  switch (month) {
    case 2:
      return isLeapYear(year) ? 29 : 28;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    default:
      return 31;
  }
}

function assertValidComponents(c: DateTimeComponents, what: string): void {
  if (c.month < 1 || c.month > 12) {
    failClosed(`${what} has an invalid month (expected 01-12)`);
  }
  if (c.day < 1 || c.day > daysInMonth(c.year, c.month)) {
    failClosed(`${what} is not a real calendar date`);
  }
  if (c.hour > 23 || c.minute > 59 || c.second > 59) {
    failClosed(`${what} has an out-of-range time component`);
  }
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

// ─── Local wall-time parsing (never interpreted in the server timezone) ───

const LOCAL_DATE_TIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

function parseLocalDateTime(value: unknown): {
  readonly canonical: string;
  readonly components: DateTimeComponents;
} {
  if (typeof value !== "string") {
    failClosed("expected localDateTime as a string");
  }
  const match = LOCAL_DATE_TIME_RE.exec(value);
  if (!match) {
    failClosed(
      "malformed localDateTime: expected YYYY-MM-DDTHH:mm[:ss] wall time without an offset"
    );
  }
  const components: DateTimeComponents = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: match[6] !== undefined ? Number(match[6]) : 0,
  };
  assertValidComponents(components, "localDateTime");
  const canonical = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${
    match[5]
  }:${pad2(components.second)}`;
  return { canonical, components };
}

// ─── Explicit UTC instant parsing (explicit offset designator required) ───
//
// An offset-less ISO string would be interpreted against the server local
// timezone by Date parsing APIs, which is exactly the nondeterminism this
// authority exists to prevent, so an explicit "Z" or ±hh:mm designator is
// mandatory and the instant is built arithmetically from the captured fields.

const UTC_INSTANT_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(?:Z|([+-])(\d{2}):(\d{2}))$/;

function parseUtcInstant(value: unknown): { readonly millis: number } {
  if (typeof value !== "string") {
    failClosed("expected a UTC instant string");
  }
  const match = UTC_INSTANT_RE.exec(value);
  if (!match) {
    failClosed(
      "malformed UTC instant: expected an ISO 8601 timestamp with an explicit Z or ±hh:mm offset"
    );
  }
  const components: DateTimeComponents = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: match[6] !== undefined ? Number(match[6]) : 0,
  };
  assertValidComponents(components, "UTC instant");
  const fractionMillis =
    match[7] !== undefined ? Number(match[7].padEnd(3, "0")) : 0;
  let offsetMinutes = 0;
  if (match[8] !== undefined) {
    const offsetHour = Number(match[9]);
    const offsetMinute = Number(match[10]);
    if (offsetHour > 14 || offsetMinute > 59) {
      failClosed("UTC instant has an out-of-range numeric offset");
    }
    offsetMinutes = offsetHour * 60 + offsetMinute;
    if (match[8] === "-") offsetMinutes = -offsetMinutes;
  }
  const asUtc = Date.UTC(
    components.year,
    components.month - 1,
    components.day,
    components.hour,
    components.minute,
    components.second,
    fractionMillis
  );
  // publishing_queue.scheduledAt stores whole seconds; the canonical schedule
  // instant is second-aligned so queue, schedule, and intent compare equal.
  const millis = Math.floor((asUtc - offsetMinutes * 60_000) / 1000) * 1000;
  return { millis };
}

// ─── IANA timezone validation ───

/**
 * Validates the declared timezone and returns its canonical IANA identifier.
 * Fails closed when the timezone is missing or unknown; never falls back to
 * the server timezone.
 */
function canonicalTimeZone(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    failClosed(
      "a declared timezone is required when scheduling by local time; refusing to assume the server timezone"
    );
  }
  const requested = value.trim();
  let canonical: string;
  try {
    canonical = new Intl.DateTimeFormat("en-US", {
      timeZone: requested,
    }).resolvedOptions().timeZone;
  } catch {
    failClosed(`invalid timezone "${requested}"`);
  }
  if (!canonical) {
    failClosed(`invalid timezone "${requested}"`);
  }
  return canonical;
}

// ─── Zone offset machinery (explicit timeZone only, machine-local never used) ───

const zoneFormatterCache = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = zoneFormatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    zoneFormatterCache.set(timeZone, formatter);
  }
  return formatter;
}

function zonedComponents(
  timeZone: string,
  utcMillis: number
): DateTimeComponents {
  const parts = zoneFormatter(timeZone).formatToParts(new Date(utcMillis));
  let year = 0;
  let month = 0;
  let day = 0;
  let hour = 0;
  let minute = 0;
  let second = 0;
  for (const part of parts) {
    switch (part.type) {
      case "year":
        year = Number(part.value);
        break;
      case "month":
        month = Number(part.value);
        break;
      case "day":
        day = Number(part.value);
        break;
      case "hour":
        hour = Number(part.value);
        break;
      case "minute":
        minute = Number(part.value);
        break;
      case "second":
        second = Number(part.value);
        break;
      default:
        break;
    }
  }
  return { year, month, day, hour, minute, second };
}

function sameComponents(a: DateTimeComponents, b: DateTimeComponents): boolean {
  return (
    a.year === b.year &&
    a.month === b.month &&
    a.day === b.day &&
    a.hour === b.hour &&
    a.minute === b.minute &&
    a.second === b.second
  );
}

/** Zone offset (wall-minus-UTC) in milliseconds at the given UTC instant. */
function zoneOffsetMillisAt(timeZone: string, utcMillis: number): number {
  const wall = zonedComponents(timeZone, utcMillis);
  return (
    Date.UTC(
      wall.year,
      wall.month - 1,
      wall.day,
      wall.hour,
      wall.minute,
      wall.second
    ) - utcMillis
  );
}

function formatOffsetUtc(offsetMillis: number): string {
  const sign = offsetMillis < 0 ? "-" : "+";
  const abs = Math.abs(offsetMillis);
  const hours = Math.floor(abs / 3_600_000);
  const minutes = (abs % 3_600_000) / 60_000;
  return `${sign}${pad2(hours)}:${pad2(minutes)}`;
}

// ─── Local wall time → UTC (DST-safe) ───

/**
 * Converts declared local wall time to a UTC instant using explicit IANA zone
 * arithmetic. Gap (nonexistent) wall times fail closed. Fold (ambiguous) wall
 * times resolve deterministically to the earlier UTC instant; the ambiguity is
 * reported so the canonical record can annotate it.
 */
function resolveLocalWallTimeToUtc(
  timeZone: string,
  local: DateTimeComponents
): { readonly utcMillis: number; readonly foldAmbiguous: boolean } {
  const guess = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute,
    local.second
  );
  // Fixed-point refinement: the offset depends on the instant, and the
  // instant depends on the offset. Converges within a few iterations for
  // real zones; bounded here for determinism.
  let candidate = guess - zoneOffsetMillisAt(timeZone, guess);
  for (let i = 0; i < 3; i += 1) {
    const refined = guess - zoneOffsetMillisAt(timeZone, candidate);
    if (refined === candidate) break;
    candidate = refined;
  }
  const wall = zonedComponents(timeZone, candidate);
  if (!sameComponents(wall, local)) {
    failClosed(`local time does not exist in timezone "${timeZone}" (DST gap)`);
  }
  // Fold detection: if the same wall clock reads at any nearby distinct
  // instant, the wall time occurs twice (fall-back overlap). Probe both
  // directions; real-world transitions are at most two hours.
  let earliest = candidate;
  let foldAmbiguous = false;
  for (const deltaMinutes of [30, 45, 60, 90, 120]) {
    for (const direction of [-1, 1]) {
      const probe = candidate + direction * deltaMinutes * 60_000;
      if (probe === candidate) continue;
      if (sameComponents(zonedComponents(timeZone, probe), local)) {
        foldAmbiguous = true;
        if (probe < earliest) earliest = probe;
      }
    }
  }
  return { utcMillis: earliest, foldAmbiguous };
}

// ─── Policy ───
//
// Not-before publication policy: a scheduled instant strictly before the
// reference clock is a caller error, not a silently-due item. This matches the
// durable execution semantics, where publishing_queue.scheduledAt <= now means
// already due; an already-due instant must never be enqueued as a future
// schedule. An instant exactly at the clock is allowed (boundary due).

function assertNotBeforePolicy(utcMillis: number, now: Date): void {
  const nowMillis = now.getTime();
  if (!Number.isFinite(nowMillis)) {
    failClosed("reference clock is not a valid Date");
  }
  if (utcMillis < nowMillis) {
    failClosed(
      "scheduled instant is in the past per the not-before publication policy"
    );
  }
}

// ─── Record construction ───

function toCanonicalUtcIso(utcMillis: number): string {
  return new Date(utcMillis).toISOString();
}

function buildImmediateSchedule(): ImmediatePublicationSchedule {
  return deepFreeze({
    schemaVersion: PUBLICATION_SCHEDULE_SCHEMA_VERSION,
    mode: "immediate",
    requestedVia: "immediate",
    scheduledAtUtcIso: null,
    scheduledAtUtcMillis: null,
    requestedLocalDateTime: null,
    requestedTimezone: null,
    resolvedOffsetUtc: null,
    dstAmbiguity: "none",
  }) as ImmediatePublicationSchedule;
}

function buildScheduledSchedule(input: {
  readonly requestedVia: PublicationScheduleSource;
  readonly utcMillis: number;
  readonly requestedLocalDateTime: string | null;
  readonly requestedTimezone: string | null;
  readonly resolvedOffsetUtc: string | null;
  readonly dstAmbiguity: PublicationScheduleDstAmbiguity;
}): ScheduledPublicationSchedule {
  const utcMillis = Math.floor(input.utcMillis / 1000) * 1000;
  return deepFreeze({
    schemaVersion: PUBLICATION_SCHEDULE_SCHEMA_VERSION,
    mode: "scheduled",
    requestedVia: input.requestedVia,
    scheduledAtUtcIso: toCanonicalUtcIso(utcMillis),
    scheduledAtUtcMillis: utcMillis,
    requestedLocalDateTime: input.requestedLocalDateTime,
    requestedTimezone: input.requestedTimezone,
    resolvedOffsetUtc: input.resolvedOffsetUtc,
    dstAmbiguity: input.dstAmbiguity,
  }) as ScheduledPublicationSchedule;
}

// ─── Resolution entry point ───

/**
 * Resolves a publication schedule request into the single canonical schedule
 * record for the publication. Fail closed on malformed input, missing or
 * invalid timezone, nonexistent local timestamps, and policy violations.
 * Pure and deterministic for a fixed input (including options.now).
 */
export function resolvePublicationSchedule(
  input: unknown,
  options?: ResolvePublicationScheduleOptions
): ResolvedPublicationSchedule {
  const now = options?.now ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    failClosed("reference clock is not a valid Date");
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    failClosed("malformed schedule input: expected an object");
  }
  const request = input as Record<string, unknown>;
  if (request.mode !== "immediate" && request.mode !== "scheduled") {
    failClosed('schedule mode must be "immediate" or "scheduled"');
  }

  if (request.mode === "immediate") {
    if (
      isPresent(request.localDateTime) ||
      isPresent(request.timeZone) ||
      isPresent(request.scheduledAtUtc)
    ) {
      failClosed("immediate mode must not carry a scheduled timestamp");
    }
    return buildImmediateSchedule();
  }

  const hasLocal = isPresent(request.localDateTime);
  const hasInstant = isPresent(request.scheduledAtUtc);
  if (hasLocal && hasInstant) {
    failClosed(
      "scheduled mode accepts either localDateTime or scheduledAtUtc, not both"
    );
  }
  if (!hasLocal && !hasInstant) {
    failClosed(
      "scheduled mode requires localDateTime + timeZone, or an explicit scheduledAtUtc instant"
    );
  }

  if (hasInstant) {
    const { millis } = parseUtcInstant(request.scheduledAtUtc);
    assertNotBeforePolicy(millis, now);
    return buildScheduledSchedule({
      requestedVia: "instant",
      utcMillis: millis,
      requestedLocalDateTime: null,
      requestedTimezone: null,
      resolvedOffsetUtc: null,
      dstAmbiguity: "none",
    });
  }

  const local = parseLocalDateTime(request.localDateTime);
  const timeZone = canonicalTimeZone(request.timeZone);
  const { utcMillis, foldAmbiguous } = resolveLocalWallTimeToUtc(
    timeZone,
    local.components
  );
  assertNotBeforePolicy(utcMillis, now);
  return buildScheduledSchedule({
    requestedVia: "local",
    utcMillis,
    requestedLocalDateTime: local.canonical,
    requestedTimezone: timeZone,
    resolvedOffsetUtc: formatOffsetUtc(zoneOffsetMillisAt(timeZone, utcMillis)),
    dstAmbiguity: foldAmbiguous ? "fold-resolved-to-earlier-instant" : "none",
  });
}

// ─── Canonical comparison / replay ───

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    const obj = value as Record<string, unknown>;
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = sortKeys(obj[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Deterministic canonical key for a resolved schedule record. Identical
 * records always produce identical keys regardless of construction order;
 * resolving the same input twice yields the same key.
 */
export function canonicalPublicationScheduleKey(
  schedule: ResolvedPublicationSchedule
): string {
  return JSON.stringify(sortKeys(schedule));
}

/** Exact canonical equality (every record field). */
export function publicationScheduleEquals(
  a: ResolvedPublicationSchedule,
  b: ResolvedPublicationSchedule
): boolean {
  return (
    canonicalPublicationScheduleKey(a) === canonicalPublicationScheduleKey(b)
  );
}

/**
 * Instant-level equality: mode and resolved UTC instant only. This is the
 * equality that durable records can prove — publishing_queue rows store only
 * the resolved instant, and PublishPackageIntent carries exactly mode +
 * scheduledAtIso.
 */
export function publicationScheduleInstantEquals(
  a: ResolvedPublicationSchedule,
  b: ResolvedPublicationSchedule
): boolean {
  return a.mode === b.mode && a.scheduledAtUtcMillis === b.scheduledAtUtcMillis;
}

// ─── PublishPackage intent binding (contract untouched) ───

/**
 * Projects a resolved schedule onto the exact PublishPackageIntent shape, so
 * the immutable package carries the same canonical schedule the authority
 * resolved — without modifying the WBS13.1 contract.
 */
export function toPublishPackageIntent(
  schedule: ResolvedPublicationSchedule
): PublishPackageIntent {
  if (schedule.mode === "immediate") {
    return { mode: "immediate", scheduledAtIso: null };
  }
  return { mode: "scheduled", scheduledAtIso: schedule.scheduledAtUtcIso };
}

/**
 * Fail-closed proof that a resolved schedule and a PublishPackageIntent agree:
 * same mode, and for scheduled mode the same resolved UTC instant. The intent
 * timestamp is parsed strictly (explicit offset required), so a malformed or
 * server-local-dependent intent fails closed instead of comparing loosely.
 */
export function assertPublicationScheduleMatchesPackageIntent(
  schedule: ResolvedPublicationSchedule,
  intent: unknown
): void {
  if (!intent || typeof intent !== "object" || Array.isArray(intent)) {
    failClosed("malformed publish package intent: expected an object");
  }
  const candidate = intent as { mode?: unknown; scheduledAtIso?: unknown };
  if (candidate.mode !== "immediate" && candidate.mode !== "scheduled") {
    failClosed("publish package intent has an invalid mode");
  }
  if (schedule.mode !== candidate.mode) {
    failClosed(
      `schedule mode "${schedule.mode}" does not match package intent mode "${candidate.mode}"`
    );
  }
  if (candidate.mode === "immediate") {
    if (isPresent(candidate.scheduledAtIso)) {
      failClosed(
        "immediate package intent must not carry a scheduledAtIso timestamp"
      );
    }
    return;
  }
  if (!isPresent(candidate.scheduledAtIso)) {
    failClosed("scheduled package intent is missing scheduledAtIso");
  }
  const { millis } = parseUtcInstant(candidate.scheduledAtIso);
  if (schedule.scheduledAtUtcMillis !== millis) {
    failClosed(
      `resolved UTC instant ${schedule.scheduledAtUtcIso} does not match package intent scheduledAtIso ${candidate.scheduledAtIso}`
    );
  }
}

// ─── publishing_queue binding ───

export interface PublicationQueueScheduleRow {
  /** publishing_queue.scheduledAt (MySQL timestamp, UTC-normalized). */
  readonly scheduledAt: Date | null;
}

/**
 * Reconstructs the canonical schedule coordinates a queue row carries. A null
 * scheduledAt means immediate; a Date means scheduled at that resolved UTC
 * instant. The queue row has no declared local time/timezone columns, so
 * those fields are null here — instant-level equality is the consistency
 * proof the durable records support. The not-before policy is not re-applied:
 * a persisted row may legitimately be due or past.
 */
export function publicationScheduleFromQueueRow(
  row: PublicationQueueScheduleRow
): ResolvedPublicationSchedule {
  if (!row || typeof row !== "object") {
    failClosed("malformed publishing queue row: expected an object");
  }
  if (!isPresent(row.scheduledAt)) {
    return buildImmediateSchedule();
  }
  const at = row.scheduledAt;
  if (!(at instanceof Date) || !Number.isFinite(at.getTime())) {
    failClosed("publishing queue scheduledAt is not a valid Date");
  }
  return buildScheduledSchedule({
    requestedVia: "instant",
    utcMillis: Math.floor(at.getTime() / 1000) * 1000,
    requestedLocalDateTime: null,
    requestedTimezone: null,
    resolvedOffsetUtc: null,
    dstAmbiguity: "none",
  });
}

/**
 * Fail-closed proof that a resolved schedule agrees with the schedule
 * coordinates persisted on a publishing_queue row (mode + resolved UTC
 * instant — exactly what the row and the PublishPackageIntent both carry).
 */
export function assertPublicationScheduleMatchesQueueRow(
  schedule: ResolvedPublicationSchedule,
  row: PublicationQueueScheduleRow
): void {
  const fromRow = publicationScheduleFromQueueRow(row);
  if (!publicationScheduleInstantEquals(schedule, fromRow)) {
    failClosed(
      `resolved publication schedule (${schedule.mode}, ${schedule.scheduledAtUtcIso}) does not match publishing_queue scheduledAt ${fromRow.scheduledAtUtcIso}`
    );
  }
}

// ─── Standalone policy gate for replay validation ───

/**
 * Re-applies the not-before policy to an already-resolved schedule. Useful
 * when a durable execution step wants to prove a persisted schedule was not
 * enqueued in the past relative to its own reference clock.
 */
export function assertPublicationScheduleNotInPast(
  schedule: ResolvedPublicationSchedule,
  now: Date = new Date()
): void {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    failClosed("reference clock is not a valid Date");
  }
  if (schedule.mode === "scheduled") {
    assertNotBeforePolicy(schedule.scheduledAtUtcMillis, now);
  }
}
