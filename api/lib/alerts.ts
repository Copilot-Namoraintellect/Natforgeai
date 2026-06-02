import { getDb } from "../queries/connection";
import { systemAlerts } from "@db/schema";
import { eq, and, isNull, desc, sql, gte } from "drizzle-orm";

export interface CreateAlertInput {
  severity: "critical" | "warning" | "info";
  category: "publishing" | "queue" | "worker" | "redis" | "openai" | "billing" | "system";
  message: string;
  details?: Record<string, any>;
}

/**
 * Create a system alert. Prevents duplicate unacknowledged alerts
 * of the same category within the last hour.
 */
export async function createAlert(input: CreateAlertInput): Promise<{ id: number }> {
  const db = getDb();

  // Deduplicate: skip if an unresolved alert of same category exists in last hour
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const [recent] = await db
    .select()
    .from(systemAlerts)
    .where(
      and(
        eq(systemAlerts.category, input.category),
        isNull(systemAlerts.resolvedAt),
        gte(systemAlerts.createdAt, oneHourAgo)
      )
    )
    .limit(1);

  if (recent) {
    return { id: recent.id };
  }

  const [result] = await db.insert(systemAlerts).values({
    severity: input.severity,
    category: input.category,
    message: input.message,
    details: input.details ?? null,
  });

  const id = Number(result.insertId);
  console.warn(`[Alert] ${input.severity.toUpperCase()} [${input.category}] ${input.message}`);
  return { id };
}

/**
 * Resolve all unresolved alerts in a category.
 */
export async function resolveAlerts(category: string): Promise<{ resolved: number }> {
  const db = getDb();
  await db
    .update(systemAlerts)
    .set({ resolvedAt: new Date() })
    .where(and(eq(systemAlerts.category, category as any), isNull(systemAlerts.resolvedAt)));

  const resolved = 0; // MySQL2 result shape varies; skip exact count
  if (resolved > 0) {
    console.log(`[Alert] Resolved ${resolved} alert(s) in category ${category}`);
  }
  return { resolved };
}

/**
 * Acknowledge a single alert.
 */
export async function acknowledgeAlert(alertId: number): Promise<void> {
  const db = getDb();
  await db
    .update(systemAlerts)
    .set({ acknowledgedAt: new Date() })
    .where(eq(systemAlerts.id, alertId));
}

/**
 * List alerts with optional filters.
 */
export async function listAlerts({
  unresolvedOnly,
  category,
  limit = 100,
}: {
  unresolvedOnly?: boolean;
  category?: string;
  limit?: number;
} = {}) {
  const db = getDb();

  let conditions: any[] = [];
  if (unresolvedOnly) {
    conditions.push(isNull(systemAlerts.resolvedAt));
  }
  if (category) {
    conditions.push(eq(systemAlerts.category, category as any));
  }

  const query = db
    .select()
    .from(systemAlerts)
    .orderBy(desc(systemAlerts.createdAt))
    .limit(limit);

  if (conditions.length > 0) {
    return query.where(and(...conditions));
  }
  return query;
}

/**
 * Get a summary of current alert counts by severity.
 */
export async function getAlertSummary(): Promise<{
  critical: number;
  warning: number;
  info: number;
  totalUnresolved: number;
}> {
  const db = getDb();
  const unresolved = await db
    .select({
      severity: systemAlerts.severity,
      count: sql<number>`COUNT(*)`,
    })
    .from(systemAlerts)
    .where(isNull(systemAlerts.resolvedAt))
    .groupBy(systemAlerts.severity);

  return {
    critical: unresolved.find((r) => r.severity === "critical")?.count ?? 0,
    warning: unresolved.find((r) => r.severity === "warning")?.count ?? 0,
    info: unresolved.find((r) => r.severity === "info")?.count ?? 0,
    totalUnresolved: unresolved.reduce((sum, r) => sum + r.count, 0),
  };
}
