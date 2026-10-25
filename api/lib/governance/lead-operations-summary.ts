/**
 * R6-F lead-operations summary rollup (F8).
 *
 * Bounded, business-scoped rollup over the lead-operations projection.
 * Reuses the same collect → derive → derive pipeline per lead; counts DERIVED
 * results (never re-classifies rows) and skips/logs failed leads so one bad
 * lead cannot take down the listing. Read-only.
 */

import { desc, eq } from "drizzle-orm";
import { businesses, leads } from "@db/schema";
import { getDb } from "../../queries/connection";
import { logError } from "../logger";
import {
  projectLeadOperations,
  LEAD_OPERATIONAL_HEALTH,
  type LeadOperationalHealth,
} from "./lead-operations-projection";

type Db = ReturnType<typeof getDb>;

export function clampLeadBusinessLimit(limit: number | undefined | null): number {
  if (typeof limit !== "number" || Number.isNaN(limit)) return 25;
  return Math.min(100, Math.max(1, Math.floor(limit)));
}

export const LEAD_HEALTH_SEVERITY: Record<LeadOperationalHealth, number> = {
  FAIL_CLOSED: 0,
  BLOCKED_OPERATOR: 1,
  BLOCKED_CONFIGURATION: 2,
  AUTO_RECOVERING: 3,
  DEGRADED: 4,
  HEALTHY: 5,
  UNSUPPORTED: 6,
};

export interface LeadBusinessOperationsEntry {
  businessId: number;
  leadsTotal: number;
  byHealth: Record<LeadOperationalHealth, number>;
  byPrivacyState: Record<string, number>;
  blockedLeads: number;
  staleLeads: number;
  operatorActionRequired: number;
  worstHealth: LeadOperationalHealth;
}

export interface LeadGovernanceSummary {
  generatedAt: string;
  businessesEvaluated: number;
  leadsEvaluated: number;
  byHealth: Record<LeadOperationalHealth, number>;
  byPrivacyState: Record<string, number>;
  blockedLeads: number;
  staleLeads: number;
  operatorActionRequired: number;
  businesses: LeadBusinessOperationsEntry[];
  truncated: boolean;
}

function emptyHealth(): Record<LeadOperationalHealth, number> {
  const out = {} as Record<LeadOperationalHealth, number>;
  for (const h of LEAD_OPERATIONAL_HEALTH) out[h] = 0;
  return out;
}

export async function summarizeLeadGovernance(
  db: Db,
  now: Date,
  businessLimit?: number
): Promise<LeadGovernanceSummary> {
  const limit = clampLeadBusinessLimit(businessLimit);

  const businessRows = await db
    .select({ id: businesses.id, userId: businesses.userId })
    .from(businesses)
    .orderBy(desc(businesses.id))
    .limit(limit + 1);
  const truncated = businessRows.length > limit;
  const scoped = businessRows.slice(0, limit);

  const byHealth = emptyHealth();
  const byPrivacyState: Record<string, number> = {};
  const businessEntries: LeadBusinessOperationsEntry[] = [];
  let leadsEvaluated = 0;
  let blockedLeads = 0;
  let staleLeads = 0;
  let operatorActionRequired = 0;

  for (const business of scoped) {
    const leadRows = await db
      .select({ id: leads.id })
      .from(leads)
      .where(eq(leads.businessId, business.id));

    const entry: LeadBusinessOperationsEntry = {
      businessId: business.id,
      leadsTotal: leadRows.length,
      byHealth: emptyHealth(),
      byPrivacyState: {},
      blockedLeads: 0,
      staleLeads: 0,
      operatorActionRequired: 0,
      worstHealth: "HEALTHY",
    };
    let worst = LEAD_HEALTH_SEVERITY.HEALTHY;

    for (const leadRow of leadRows) {
      try {
        const projection = await projectLeadOperations({
          leadId: leadRow.id,
          now,
          executor: db,
        });
        leadsEvaluated += 1;
        entry.byHealth[projection.health] += 1;
        byHealth[projection.health] += 1;
        const privacyStatus = projection.privacy.status;
        entry.byPrivacyState[privacyStatus] = (entry.byPrivacyState[privacyStatus] ?? 0) + 1;
        byPrivacyState[privacyStatus] = (byPrivacyState[privacyStatus] ?? 0) + 1;
        if (projection.health !== "HEALTHY" && projection.health !== "DEGRADED") {
          entry.blockedLeads += 1;
          blockedLeads += 1;
        }
        if (projection.staleness.isStale) {
          entry.staleLeads += 1;
          staleLeads += 1;
        }
        if (projection.operatorActionRequired) {
          entry.operatorActionRequired += 1;
          operatorActionRequired += 1;
        }
        if (LEAD_HEALTH_SEVERITY[projection.health] < worst) {
          worst = LEAD_HEALTH_SEVERITY[projection.health];
          entry.worstHealth = projection.health;
        }
      } catch (err) {
        logError("[R6-F] Failed to project lead for governance summary", {
          event: "r6_lead_governance_summary_lead_failed",
          businessId: business.id,
          leadId: leadRow.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    businessEntries.push(entry);
  }

  return {
    generatedAt: now.toISOString(),
    businessesEvaluated: scoped.length,
    leadsEvaluated,
    byHealth,
    byPrivacyState,
    blockedLeads,
    staleLeads,
    operatorActionRequired,
    businesses: businessEntries,
    truncated,
  };
}
