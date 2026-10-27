// ─── R6-C Lead Qualification — production authority bridge ───
//
// Binds the QualificationAuthorityProvider seam to the real upstream tables
// and adapts a Drizzle client/transaction to the qualification store's
// structural executor seam.
//
// FROZEN-CONTRACT MIRRORS: the R6-A lead_identities / lead_identity_provenance
// (ded8f2876e7c), R6-B lead_score_snapshots (259dc88) and R6-F
// lead_privacy_states (c4932c6) tables are NOT in this branch's schema.ts, so
// the column-set mirrors below were extracted verbatim from the frozen
// upstream commits. They are frozen-contract mirrors, replaced by canonical
// @db/schema imports at R6-X convergence — never edit them locally.
//
// Guarded degradation: table availability is probed once per provider
// instance through information_schema and memoized. A read against an absent
// upstream schema fails closed with ProviderAuthorityUnavailable (mapped by
// the service to QUALIFICATION_AUTHORITY_UNAVAILABLE). Privacy also fails
// closed when its schema or authoritative identity mapping is unavailable.
//
// The provider is tenant-anchored: every query predicates eq(userId) with the
// authenticated tenant supplied at construction — upstream rows are untrusted
// until the C seams re-validate them.

import { and, eq as drizzleEq, sql, type SQL } from "drizzle-orm";
import {
  bigint,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  serial,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";
import { getDb } from "../../queries/connection";
import {
  ProviderLeadNotFound,
  ProviderPrivacyScopeMismatch,
  ProviderScoreNotFound,
  type QualificationAuthorityProvider,
  type QualificationPrivacyScope,
} from "./qualification-service";
import { leadPrivacyEvidenceFromRow } from "./qualification-governance-seam";
import type {
  QualificationRowQuery,
  QualificationSelectTarget,
  QualificationStoreExecutor,
  QualificationTableHandle,
  StoreOrderTerm,
  StorePredicate,
} from "./qualification-store";

// ─── Frozen-contract mirror tables (upstream column sets, verbatim) ───
// Replaced by canonical @db/schema imports at R6-X convergence.

const IDENTITY_TYPE_VALUES = [
  "provider_actor",
  "email_hash",
  "phone_hash",
  "authenticated_customer_reference",
  "crm_external_reference",
  "anonymous_thread",
  "unknown",
] as const;

const IDENTITY_STATUS_VALUES = [
  "active",
  "anonymous",
  "partially_identified",
  "resolved",
  "conflicting",
  "suppressed",
  "merged",
  "archived",
] as const;

const IDENTITY_CONFIDENCE_VALUES = ["unknown", "low", "medium", "high"] as const;

const leadIdentitiesMirror = mysqlTable(
  "lead_identities",
  {
    id: serial("id").primaryKey(),
    leadId: varchar("leadId", { length: 69 }).notNull(),
    identityKey: varchar("identityKey", { length: 64 }).notNull(),
    contractVersion: varchar("contractVersion", { length: 40 }).notNull(),
    userId: bigint("userId", { mode: "number", unsigned: true }).notNull(),
    businessId: bigint("businessId", { mode: "number", unsigned: true }),
    primaryIdentityType: mysqlEnum("primaryIdentityType", IDENTITY_TYPE_VALUES).notNull(),
    identityStatus: mysqlEnum("identityStatus", IDENTITY_STATUS_VALUES).notNull(),
    identityConfidence: mysqlEnum("identityConfidence", IDENTITY_CONFIDENCE_VALUES).notNull(),
    externalActorReferenceHash: varchar("externalActorReferenceHash", { length: 64 }),
    provider: mysqlEnum("provider", ["meta", "linkedin", "twitter", "tiktok"]),
    emailIdentityHash: varchar("emailIdentityHash", { length: 64 }),
    phoneIdentityHash: varchar("phoneIdentityHash", { length: 64 }),
    customerReferenceHash: varchar("customerReferenceHash", { length: 64 }),
    sourceOpportunityId: varchar("sourceOpportunityId", { length: 69 }).notNull(),
    sourceHandoffId: varchar("sourceHandoffId", { length: 69 }).notNull(),
    canonicalLeadId: varchar("canonicalLeadId", { length: 69 }),
    firstObservedAt: varchar("firstObservedAt", { length: 32 }).notNull(),
    lastObservedAt: varchar("lastObservedAt", { length: 32 }).notNull(),
    provenanceCount: int("provenanceCount").notNull().default(1),
    identityEvidenceCount: int("identityEvidenceCount").notNull().default(0),
    version: int("version").notNull().default(1),
    statusChangedAt: timestamp("statusChangedAt").defaultNow().notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (table) => ({
    userIdentityUnique: uniqueIndex("li_user_identity_uidx").on(table.userId, table.identityKey),
    userLeadUnique: uniqueIndex("li_user_lead_uidx").on(table.userId, table.leadId),
    userEmailUnique: uniqueIndex("li_user_email_uidx").on(table.userId, table.emailIdentityHash),
    userPhoneUnique: uniqueIndex("li_user_phone_uidx").on(table.userId, table.phoneIdentityHash),
    userCustomerRefUnique: uniqueIndex("li_user_custref_uidx").on(table.userId, table.customerReferenceHash),
    userStatusIdx: index("li_user_status_idx").on(table.userId, table.identityStatus),
  })
);

type LeadIdentitiesMirrorRow = typeof leadIdentitiesMirror.$inferSelect;

const LEAD_PROVENANCE_KIND_VALUES = [
  "opportunity_handoff",
  "identity_evidence",
  "merge",
  "conflict",
] as const;

const leadIdentityProvenanceMirror = mysqlTable(
  "lead_identity_provenance",
  {
    id: serial("id").primaryKey(),
    leadRowId: bigint("leadRowId", { mode: "number", unsigned: true }).notNull(),
    leadId: varchar("leadId", { length: 69 }).notNull(),
    userId: bigint("userId", { mode: "number", unsigned: true }).notNull(),
    kind: mysqlEnum("kind", LEAD_PROVENANCE_KIND_VALUES).notNull(),
    handoffId: varchar("handoffId", { length: 69 }),
    opportunityId: varchar("opportunityId", { length: 69 }),
    provider: mysqlEnum("provider", ["meta", "linkedin", "twitter", "tiktok"]),
    campaignId: bigint("campaignId", { mode: "number", unsigned: true }),
    publicationId: varchar("publicationId", { length: 128 }),
    evidenceType: varchar("evidenceType", { length: 40 }),
    evidenceHash: varchar("evidenceHash", { length: 64 }).notNull(),
    envelopeHash: varchar("envelopeHash", { length: 64 }),
    occurredAt: varchar("occurredAt", { length: 32 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    userHandoffUnique: uniqueIndex("lip_user_handoff_uidx").on(table.userId, table.handoffId),
    userKindHashUnique: uniqueIndex("lip_user_kind_hash_uidx").on(table.userId, table.kind, table.evidenceHash),
    leadRowIdx: index("lip_lead_row_idx").on(table.leadRowId),
  })
);

type LeadIdentityProvenanceMirrorRow = typeof leadIdentityProvenanceMirror.$inferSelect;

const leadScoreSnapshotsMirror = mysqlTable(
  "lead_score_snapshots",
  {
    id: serial("id").primaryKey(),
    leadScoreId: varchar("leadScoreId", { length: 69 }).notNull(),
    evidenceSnapshotId: varchar("evidenceSnapshotId", { length: 69 }).notNull(),
    scoreContractVersion: varchar("scoreContractVersion", { length: 64 }).notNull(),
    userId: bigint("userId", { mode: "number", unsigned: true }).notNull(),
    businessId: bigint("businessId", { mode: "number", unsigned: true }),
    leadId: bigint("leadId", { mode: "number", unsigned: true }).notNull(),
    leadIdentityVersion: varchar("leadIdentityVersion", { length: 96 }).notNull(),
    scoringVersion: varchar("scoringVersion", { length: 64 }).notNull(),
    featureVersion: varchar("featureVersion", { length: 64 }).notNull(),
    evidenceSnapshotHash: varchar("evidenceSnapshotHash", { length: 64 }).notNull(),
    evidenceManifest: json("evidenceManifest").notNull(),
    overallScore: int("overallScore").notNull(),
    scoreBand: mysqlEnum("scoreBand", ["VERY_LOW", "LOW", "MEDIUM", "HIGH", "VERY_HIGH"]).notNull(),
    scoreConfidence: mysqlEnum("scoreConfidence", ["LOW", "MEDIUM", "HIGH", "UNKNOWN"]).notNull(),
    fitScore: int("fitScore").notNull(),
    intentScore: int("intentScore").notNull(),
    engagementScore: int("engagementScore").notNull(),
    recencyScore: int("recencyScore").notNull(),
    opportunityScore: int("opportunityScore").notNull(),
    componentWeights: json("componentWeights").notNull(),
    reasonCodes: json("reasonCodes").notNull(),
    computedAt: timestamp("computedAt").defaultNow().notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    convergenceUnique: uniqueIndex("lss_convergence_uidx").on(
      table.userId,
      table.leadId,
      table.evidenceSnapshotHash,
      table.scoringVersion
    ),
    leadScoreIdUnique: uniqueIndex("lss_score_id_uidx").on(table.leadScoreId),
    snapshotIdIdx: index("lss_snapshot_id_idx").on(table.evidenceSnapshotId),
    userLeadIdx: index("lss_user_lead_idx").on(table.userId, table.leadId),
  })
);

type LeadScoreSnapshotsMirrorRow = typeof leadScoreSnapshotsMirror.$inferSelect;

const leadPrivacyStatesMirror = mysqlTable(
  "lead_privacy_states",
  {
    id: serial("id").primaryKey(),
    leadId: bigint("leadId", { mode: "number", unsigned: true }).notNull(),
    userId: bigint("userId", { mode: "number", unsigned: true }).notNull(),
    businessId: bigint("businessId", { mode: "number", unsigned: true }),
    privacyState: mysqlEnum("privacyState", [
      "ACTIVE",
      "SUPPRESSED",
      "RESTRICTED",
      "RETENTION_PENDING",
      "RETENTION_EXPIRED",
      "ARCHIVED",
    ])
      .default("ACTIVE")
      .notNull(),
    previousState: mysqlEnum("previousState", [
      "ACTIVE",
      "SUPPRESSED",
      "RESTRICTED",
      "RETENTION_PENDING",
      "RETENTION_EXPIRED",
      "ARCHIVED",
    ]),
    reason: varchar("reason", { length: 500 }),
    retentionDeadlineAt: timestamp("retentionDeadlineAt"),
    source: varchar("source", { length: 32 }).default("operator").notNull(),
    actorUserId: bigint("actorUserId", { mode: "number", unsigned: true }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (table) => ({
    leadUnique: uniqueIndex("lps_lead_uidx").on(table.leadId),
    userIdx: index("lps_user_idx").on(table.userId),
    businessIdx: index("lps_business_idx").on(table.businessId),
    stateIdx: index("lps_state_idx").on(table.privacyState),
  })
);

type LeadPrivacyStatesMirrorRow = typeof leadPrivacyStatesMirror.$inferSelect;

// ─── Provider ───

export class ProviderAuthorityUnavailable extends Error {
  readonly tables: readonly string[];
  constructor(tables: readonly string[]) {
    super(`qualification authority tables unavailable: ${tables.join(", ")}`);
    this.name = "ProviderAuthorityUnavailable";
    this.tables = tables;
  }
}

const AUTHORITY_TABLES = [
  "lead_identities",
  "lead_identity_provenance",
  "lead_score_snapshots",
  "lead_privacy_states",
] as const;
type AuthorityTable = (typeof AUTHORITY_TABLES)[number];

/**
 * Structural db seam: the default getDb() client and a Drizzle transaction
 * client both satisfy it; the test fake binds a scripted in-memory client.
 * Loosely typed so both dialects fit — every use is internal and translated.
 */
export interface QualificationBridgeDb {
  readonly select: (...args: never[]) => any;
  readonly execute: (query: SQL) => Promise<unknown>;
}

class QualificationBridgeProvider implements QualificationAuthorityProvider {
  private availability: Promise<ReadonlySet<string>> | null = null;
  private readonly db: QualificationBridgeDb;
  private readonly userId: number;

  constructor(db: QualificationBridgeDb, userId: number) {
    this.db = db;
    this.userId = userId;
  }

  private availableTables(): Promise<ReadonlySet<string>> {
    if (!this.availability) {
      this.availability = this.probeTables().catch((err) => {
        // A failed probe must not be memoized as a permanent outage.
        this.availability = null;
        throw err;
      });
    }
    return this.availability;
  }

  private async probeTables(): Promise<ReadonlySet<string>> {
    const result: unknown = await this.db.execute(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = DATABASE() AND table_name IN (${sql.join(
        AUTHORITY_TABLES.map((table) => sql`${table}`),
        sql`, `
      )})
    `);
    const first: unknown = Array.isArray(result) ? result[0] : undefined;
    const rows: unknown[] = Array.isArray(first) ? first : [];
    return new Set(
      rows.map((row) => String((row as { table_name?: unknown }).table_name ?? ""))
    );
  }

  private async requireTables(...tables: readonly AuthorityTable[]): Promise<void> {
    const available = await this.availableTables();
    const missing = tables.filter((table) => !available.has(table));
    if (missing.length > 0) {
      throw new ProviderAuthorityUnavailable(missing);
    }
  }

  async getIdentityProjection(leadId: string): Promise<unknown> {
    await this.requireTables("lead_identities", "lead_identity_provenance");
    const [row] = (await this.db
      .select()
      .from(leadIdentitiesMirror)
      .where(
        and(
          drizzleEq(leadIdentitiesMirror.userId, this.userId),
          drizzleEq(leadIdentitiesMirror.leadId, leadId)
        )
      )
      .limit(1)) as Array<LeadIdentitiesMirrorRow | undefined>;
    if (!row) {
      throw new ProviderLeadNotFound(leadId);
    }
    const provenanceRows = (await this.db
      .select()
      .from(leadIdentityProvenanceMirror)
      .where(
        and(
          drizzleEq(leadIdentityProvenanceMirror.userId, this.userId),
          drizzleEq(leadIdentityProvenanceMirror.leadId, leadId)
        )
      )
      .orderBy(asc(leadIdentityProvenanceMirror.createdAt))) as LeadIdentityProvenanceMirrorRow[];
    // The exact 14-key R6-A projection the identity seam re-validates.
    return {
      leadId: row.leadId,
      businessId: row.businessId,
      leadIdentityVersion: row.contractVersion,
      identityStatus: row.identityStatus,
      identityConfidence: row.identityConfidence,
      primaryIdentityType: row.primaryIdentityType,
      externalActorReferenceHash: row.externalActorReferenceHash,
      provider: row.provider,
      sourceOpportunityId: row.sourceOpportunityId,
      sourceHandoffId: row.sourceHandoffId,
      canonicalLeadId: row.canonicalLeadId,
      firstObservedAt: row.firstObservedAt,
      lastObservedAt: row.lastObservedAt,
      provenance: provenanceRows.map((entry) => ({
        kind: entry.kind,
        handoffId: entry.handoffId,
        opportunityId: entry.opportunityId,
        evidenceType: entry.evidenceType,
        occurredAt: entry.occurredAt,
      })),
    };
  }

  async getScorePayload(leadScoreId: string): Promise<unknown> {
    await this.requireTables("lead_score_snapshots");
    const [row] = (await this.db
      .select()
      .from(leadScoreSnapshotsMirror)
      .where(
        and(
          drizzleEq(leadScoreSnapshotsMirror.userId, this.userId),
          drizzleEq(leadScoreSnapshotsMirror.leadScoreId, leadScoreId)
        )
      )
      .limit(1)) as Array<LeadScoreSnapshotsMirrorRow | undefined>;
    if (!row) {
      throw new ProviderScoreNotFound(leadScoreId);
    }
    return toScorePayload(row);
  }

  async getPrivacyState(scope: QualificationPrivacyScope): Promise<unknown> {
    const available = await this.availableTables();
    if (!available.has("lead_privacy_states")) {
      throw new ProviderAuthorityUnavailable(["lead_privacy_states"]);
    }
    // Authoritative chain binding (blocker 2): the numeric key into the
    // numeric-keyed R6-F table arrives only inside the re-validated R6-B
    // score binding (scoreLeadId), within the exact tenant + business scope
    // already established against the R6-A identity. The lid1 identity id
    // has no row in this table and a bare client numeric id is never
    // trusted — an unestablished binding fails closed instead of guessing.
    const numericLeadKey =
      typeof scope.scoreLeadId === "string" &&
      /^[1-9]\d*$/.test(scope.scoreLeadId) &&
      Number.isSafeInteger(Number(scope.scoreLeadId))
        ? Number(scope.scoreLeadId)
        : null;
    if (numericLeadKey === null) {
      throw new ProviderAuthorityUnavailable(["lead_privacy_states"]);
    }
    const [row] = (await this.db
      .select()
      .from(leadPrivacyStatesMirror)
      .where(
        and(
          drizzleEq(leadPrivacyStatesMirror.userId, this.userId),
          // Only a score-validated legacy numeric key can reach this query.
          drizzleEq(leadPrivacyStatesMirror.leadId, numericLeadKey)
        )
      )
      .orderBy(desc(leadPrivacyStatesMirror.createdAt))
      .limit(1)) as Array<LeadPrivacyStatesMirrorRow | undefined>;
    if (
      row &&
      row.businessId !== null &&
      scope.businessId !== null &&
      row.businessId !== scope.businessId
    ) {
      // A privacy record for a different business context must not govern
      // this qualification chain.
      throw new ProviderPrivacyScopeMismatch(String(numericLeadKey));
    }
    return leadPrivacyEvidenceFromRow(row ?? null);
  }
}

function toIso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/**
 * Adapts the frozen R6-B row into the exact key set the C scoring seam
 * re-validates. `leadId` is the legacy numeric leads.id, carried verbatim —
 * C binds score→identity by tenant + business scope, never by leadId
 * equality. `scoreContentHash` is intentionally absent: it is not a B column;
 * the seam recomputes it. `evidenceFreshness.latestObservedAt` is the max
 * manifest occurredAt (B contract §12); `duplicateClassification` is not a B
 * column — a read of a committed row is not a replay.
 */
function toScorePayload(row: LeadScoreSnapshotsMirrorRow): Record<string, unknown> {
  const manifest: unknown[] = Array.isArray(row.evidenceManifest) ? row.evidenceManifest : [];
  let latestObservedAt: string | null = null;
  for (const entry of manifest) {
    const occurredAt = (entry as { occurredAt?: unknown } | null)?.occurredAt;
    if (typeof occurredAt === "string" && (latestObservedAt === null || occurredAt > latestObservedAt)) {
      latestObservedAt = occurredAt;
    }
  }
  const computedAt = toIso(row.computedAt);
  return {
    leadScoreId: row.leadScoreId,
    leadId: row.leadId,
    leadIdentityVersion: row.leadIdentityVersion,
    scoringVersion: row.scoringVersion,
    featureVersion: row.featureVersion,
    scoreContractVersion: row.scoreContractVersion,
    evidenceSnapshotId: row.evidenceSnapshotId,
    evidenceSnapshotHash: row.evidenceSnapshotHash,
    overallScore: row.overallScore,
    scoreBand: row.scoreBand,
    scoreConfidence: row.scoreConfidence,
    fitScore: row.fitScore,
    intentScore: row.intentScore,
    engagementScore: row.engagementScore,
    recencyScore: row.recencyScore,
    opportunityScore: row.opportunityScore,
    componentWeights: row.componentWeights,
    reasonCodes: row.reasonCodes,
    evidenceFreshness: { latestObservedAt, computedAt },
    computedAt,
    createdAt: toIso(row.createdAt),
    businessId: row.businessId,
    userId: row.userId,
    duplicateClassification: "none",
  };
}

/**
 * Production QualificationAuthorityProvider: tenant-anchored by the
 * authenticated user id; every upstream query predicates eq(userId).
 */
export function createQualificationBridgeProvider(
  db: QualificationBridgeDb = getDb(),
  userId: number
): QualificationAuthorityProvider {
  return new QualificationBridgeProvider(db, userId);
}

// ─── Store executor binding ───
//
// Translates the store's local predicate descriptors into Drizzle SQL over
// the canonical @db/schema tables so a real Drizzle client/transaction (or
// the in-memory fake) can serve the structural QualificationStoreExecutor
// seam. Loose typing: both dialects fit; all access is internal.

function columnOf(table: unknown, field: string): any {
  const column = (table as Record<string, unknown>)[field];
  if (column === undefined || column === null) {
    throw new Error(`qualification bridge: unknown column ${field} on table handle`);
  }
  return column;
}

const asc = (column: unknown): SQL => sql`${column as never} asc`;
const desc = (column: unknown): SQL => sql`${column as never} desc`;

function toSqlPredicate(table: unknown, predicate: StorePredicate): SQL {
  // The audit ledger speaks native Drizzle SQL through the same adapted
  // executor (see asAuditExecutor in qualification-service); only the
  // qualification store's local descriptors need translation.
  if (!isStorePredicate(predicate)) {
    return predicate as unknown as SQL;
  }
  if (predicate.kind === "eq") {
    return drizzleEq(columnOf(table, predicate.field), predicate.value);
  }
  return and(
    ...predicate.conditions.map((condition) => toSqlPredicate(table, condition))
  ) as SQL;
}

function isStorePredicate(value: unknown): value is StorePredicate {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    ((value as { kind: unknown }).kind === "eq" || (value as { kind: unknown }).kind === "and")
  );
}

function toSqlOrder(table: unknown, term: StoreOrderTerm): SQL {
  const column = columnOf(table, term.field);
  return term.direction === "asc" ? asc(column) : desc(column);
}

/**
 * Binds a Drizzle-shaped client (real client, transaction callback, or the
 * in-memory fake) to the qualification store's structural executor seam.
 */
export function bindQualificationStoreExecutor(client: unknown): QualificationStoreExecutor {
  const db = client as {
    select: () => { from: (table: unknown) => any };
    insert: (table: unknown) => { values: (row: Record<string, unknown>) => unknown };
    update: (table: unknown) => {
      set: (patch: Record<string, unknown>) => { where: (cond: unknown) => unknown };
    };
  };

  const adapt = (table: unknown, query: any): QualificationRowQuery => ({
    all: async () => await query,
    limit: async (n: number) => await query.limit(n),
    orderBy: (...terms: StoreOrderTerm[]) =>
      adapt(table, query.orderBy(...terms.map((term) => toSqlOrder(table, term)))),
  });

  return {
    select: () => ({
      from: (table: QualificationTableHandle): QualificationSelectTarget => {
        const target = db.select().from(table);
        return {
          where: (predicate: StorePredicate) => adapt(table, target.where(toSqlPredicate(table, predicate))),
          orderBy: (...terms: StoreOrderTerm[]) =>
            adapt(table, target.orderBy(...terms.map((term) => toSqlOrder(table, term)))),
          all: async () => await target,
          limit: async (n: number) => await target.limit(n),
        };
      },
    }),
    insert: (table: QualificationTableHandle) => ({
      values: async (row: Record<string, unknown>) => await db.insert(table).values(row),
    }),
    update: (table: QualificationTableHandle) => ({
      set: (patch: Record<string, unknown>) => ({
        where: async (predicate: StorePredicate) =>
          await db.update(table).set(patch).where(toSqlPredicate(table, predicate)),
      }),
    }),
  };
}
