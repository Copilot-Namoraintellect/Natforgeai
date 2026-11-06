/**
 * Retention prune-plan computation (pure).
 *
 * Policy: keep the newest `daily` sets (one per day), plus one set per ISO
 * week for `weekly` weeks, plus one per month for `monthly` months — always
 * preferring the newest set in each bucket and never pruning anything that
 * a wider bucket still claims. Deterministic for a given input list.
 */

export interface RetentionPolicy {
  daily: number;
  weekly: number;
  monthly: number;
}

export interface RetentionCandidate {
  id: string;
  createdAt: Date;
}

export interface PrunePlan {
  keep: string[];
  prune: string[];
  reason: Record<string, "daily" | "weekly" | "monthly" | "expired">;
}

export const DEFAULT_RETENTION: RetentionPolicy = { daily: 14, weekly: 8, monthly: 12 };

function isoWeek(d: Date): string {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (date.getUTCDay() + 6) % 7; // Monday = 0
  date.setUTCDate(date.getUTCDate() - dayNum + 3); // Thursday of this week
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const fDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - fDayNum + 3);
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 24 * 3600 * 1000));
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function prunePlan(sets: RetentionCandidate[], policy: RetentionPolicy): PrunePlan {
  const sorted = [...sets].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const keep = new Set<string>();
  const reason: PrunePlan["reason"] = {};

  // Daily: the newest set within each of the last `daily` distinct UTC days.
  const dailyDays = new Set<string>();
  for (const s of sorted) {
    const day = s.createdAt.toISOString().slice(0, 10);
    if (dailyDays.size >= policy.daily) break;
    if (!dailyDays.has(day)) {
      dailyDays.add(day);
      keep.add(s.id);
      reason[s.id] = "daily";
    }
  }

  // Weekly: one set per ISO week beyond the daily window. Bucket quota
  // counts only NEW claims — weeks already represented by a daily-kept set
  // do not consume weekly budget (monotonic: widening a bucket never prunes
  // a set another bucket preserved).
  const weeks = new Set<string>();
  let weeklyClaims = 0;
  for (const s of sorted) {
    if (weeklyClaims >= policy.weekly) break;
    const wk = isoWeek(s.createdAt);
    if (!weeks.has(wk)) {
      weeks.add(wk);
      if (!keep.has(s.id)) {
        keep.add(s.id);
        reason[s.id] = "weekly";
        weeklyClaims += 1;
      }
    }
  }

  // Monthly: one set per month beyond weekly, same quota rule.
  const months = new Set<string>();
  let monthlyClaims = 0;
  for (const s of sorted) {
    if (monthlyClaims >= policy.monthly) break;
    const mk = monthKey(s.createdAt);
    if (!months.has(mk)) {
      months.add(mk);
      if (!keep.has(s.id)) {
        keep.add(s.id);
        reason[s.id] = "monthly";
        monthlyClaims += 1;
      }
    }
  }

  const prune = sorted.filter((s) => !keep.has(s.id)).map((s) => s.id);
  for (const id of prune) reason[id] = "expired";
  return {
    keep: sorted.filter((s) => keep.has(s.id)).map((s) => s.id),
    prune,
    reason,
  };
}
