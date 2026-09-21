import { and, eq } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { businesses } from "@db/schema";
import {
  buildBusinessDNASnapshot as buildCanonicalBusinessDnaSnapshot,
  type BusinessDNASnapshot,
} from "./business-dna";
import {
  BusinessDnaSnapshotConflictError,
  getBusinessDnaSnapshotBySnapshotId,
  persistBusinessDnaSnapshot,
  type BusinessDnaStoreDbExecutor,
} from "./business-dna-store";

/**
 * Governed Business DNA materialization boundary (BI-owned).
 *
 * live owned business profile -> readiness validation -> canonical
 * BusinessDNASnapshot -> immutable durable snapshot.
 *
 * Cross-user snapshot creation is impossible: the business row is loaded by
 * BOTH id and owning userId and must be active. Business facts come only from
 * the persisted businesses row and its captured websiteEvidence — nothing is
 * invented. Readiness gates persistence; an unready profile persists nothing.
 *
 * Snapshot identity is evidence-derived (capturedAt never feeds the evidence
 * hash), so unchanged evidence resolves through the existing durable snapshot
 * even when wall-clock time advances. Changed evidence creates a new immutable
 * snapshot authority and historical rows are never overwritten.
 */

export type BusinessDnaGovernanceDbExecutor = BusinessDnaStoreDbExecutor;

export type BusinessDnaReadiness =
  | { readonly ready: true }
  | { readonly ready: false; readonly missing: readonly string[] };

/**
 * Pure readiness gate for a governed Business DNA projection. Only the
 * governed minimum is required: valid business identity, businessName,
 * primaryOffering, at least one productsAndServices entry, and at least one
 * targetCustomerSegments entry. Optional style/profile fields never gate
 * readiness.
 */
export function evaluateBusinessDnaReadiness(
  snapshot: Pick<
    BusinessDNASnapshot,
    | "businessId"
    | "businessName"
    | "primaryOffering"
    | "productsAndServices"
    | "targetCustomerSegments"
  >
): BusinessDnaReadiness {
  const missing: string[] = [];
  if (!Number.isFinite(snapshot.businessId) || snapshot.businessId <= 0) {
    missing.push("businessId");
  }
  if (!snapshot.businessName) missing.push("businessName");
  if (!snapshot.primaryOffering) missing.push("primaryOffering");
  if (snapshot.productsAndServices.length === 0) missing.push("productsAndServices");
  if (snapshot.targetCustomerSegments.length === 0) {
    missing.push("targetCustomerSegments");
  }
  return missing.length === 0 ? { ready: true } : { ready: false, missing };
}

export class BusinessDnaNotFoundError extends Error {
  readonly code = "BUSINESS_DNA_BUSINESS_NOT_FOUND" as const;
  readonly userId: number;
  readonly businessId: number;

  constructor(userId: number, businessId: number) {
    super(`active business ${businessId} not found for user ${userId}`);
    this.name = "BusinessDnaNotFoundError";
    this.userId = userId;
    this.businessId = businessId;
  }
}

export class BusinessDnaReadinessError extends Error {
  readonly code = "BUSINESS_DNA_READINESS_FAILED" as const;
  readonly businessId: number;
  readonly missing: readonly string[];

  constructor(businessId: number, missing: readonly string[]) {
    super(
      `business ${businessId} is not ready for governed Business DNA; missing: ${missing.join(", ")}`
    );
    this.name = "BusinessDnaReadinessError";
    this.businessId = businessId;
    this.missing = missing;
  }
}

export interface MaterializeGovernedBusinessDnaInput {
  readonly userId: number;
  readonly businessId: number;
  /** Capture-time authority; invoked at most once, only when a new snapshot is captured. */
  readonly clock?: () => Date;
  /** Structural executor seam (businesses read + snapshot persistence). */
  readonly executor?: BusinessDnaGovernanceDbExecutor;
}

export interface MaterializedGovernedBusinessDna {
  readonly status: "created" | "reused";
  readonly snapshot: BusinessDNASnapshot;
  readonly readiness: BusinessDnaReadiness;
}

// Fixed identity anchor: the probe only computes the evidence-derived
// snapshotId; it never becomes a capturedAt authority.
const IDENTITY_PROBE_CAPTURED_AT_ISO = new Date(0).toISOString();

function requirePositiveId(value: number, field: string): number {
  const resolved = Number(value);
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new Error(`materializeGovernedBusinessDna requires a positive numeric ${field}`);
  }
  return resolved;
}

export async function materializeGovernedBusinessDna(
  input: MaterializeGovernedBusinessDnaInput
): Promise<MaterializedGovernedBusinessDna> {
  const userId = requirePositiveId(input.userId, "userId");
  const businessId = requirePositiveId(input.businessId, "businessId");
  const db = input.executor ?? getDb();

  // Owned-active boundary: a row is visible only for the owning user. A wrong
  // user and a missing/inactive business are indistinguishable, and both fail
  // before any snapshot persistence.
  const [business] = await db
    .select()
    .from(businesses)
    .where(
      and(
        eq(businesses.id, businessId),
        eq(businesses.userId, userId),
        eq(businesses.isActive, true)
      )
    )
    .limit(1);

  if (!business) {
    throw new BusinessDnaNotFoundError(userId, businessId);
  }

  // Probe with a fixed anchor to learn the evidence-derived snapshot identity
  // without touching the clock. Snapshot identity never depends on time.
  const probe = buildCanonicalBusinessDnaSnapshot({
    business,
    capturedAtIso: IDENTITY_PROBE_CAPTURED_AT_ISO,
  });

  // Readiness gates materialization before anything is persisted.
  const readiness = evaluateBusinessDnaReadiness(probe);
  if (!readiness.ready) {
    throw new BusinessDnaReadinessError(businessId, readiness.missing);
  }

  // Unchanged evidence: reuse the existing immutable authority. No new
  // capturedAt-only variant is manufactured.
  const existing = await getBusinessDnaSnapshotBySnapshotId(probe.snapshotId, db);
  if (existing) {
    return { status: "reused", snapshot: existing, readiness };
  }

  // Changed (or first-seen) evidence: capture exactly once through the clock
  // seam and persist immutably. A concurrent winner resolves as a replayed
  // reuse through persistBusinessDnaSnapshot.
  const clock = input.clock ?? (() => new Date());
  const capturedAtIso = clock().toISOString();
  const snapshot = buildCanonicalBusinessDnaSnapshot({ business, capturedAtIso });
  try {
    const persisted = await persistBusinessDnaSnapshot({ snapshot, userId }, db);
    return {
      status: persisted.status === "inserted" ? "created" : "reused",
      snapshot: persisted.snapshot,
      readiness,
    };
  } catch (error) {
    if (!(error instanceof BusinessDnaSnapshotConflictError)) {
      throw error;
    }

    /*
     * Two materializers can observe the same pre-commit state, derive the same
     * evidence identity, and capture different wall-clock times. The store
     * correctly rejects those canonical payloads as different.
     *
     * Resolve only that governance-level race by adopting the committed
     * winner's capture time, then replay through the store again. The store's
     * existing exact canonical comparison remains the authority: if anything
     * other than capturedAtIso differs, this second persistence attempt still
     * fails closed with BusinessDnaSnapshotConflictError.
     */
    const winner = await getBusinessDnaSnapshotBySnapshotId(
      snapshot.snapshotId,
      db
    );

    if (!winner) {
      throw error;
    }

    const winnerAlignedSnapshot: BusinessDNASnapshot = {
      ...snapshot,
      capturedAtIso: winner.capturedAtIso,
    };

    const replayed = await persistBusinessDnaSnapshot(
      { snapshot: winnerAlignedSnapshot, userId },
      db
    );

    return {
      status: "reused",
      snapshot: replayed.snapshot,
      readiness,
    };
  }
}
