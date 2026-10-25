// ─── R6-C Lead Qualification — bridge unit tests (light; slice 4 covers deep acceptance) ───

import { describe, expect, it } from "vitest";
import {
  bindQualificationStoreExecutor,
  createQualificationBridgeProvider,
  ProviderAuthorityUnavailable,
} from "./qualification-bridge";
import {
  ProviderLeadNotFound,
  ProviderScoreNotFound,
} from "./qualification-service";
import {
  getQualification,
  insertQualification,
  insertReview,
  listQualificationHistory,
  updateReviewResolution,
} from "./qualification-store";
import type { LeadQualificationRow } from "./qualification-store";

const H64 = "ab".repeat(32);
const G64 = "cd".repeat(32);
const E64 = "ef".repeat(32);
const LEAD_ID = `lid1:${H64}`;
const SCORE_ID = `lsc1:${H64}`;
const OPP_ID = `opp1:${"ef".repeat(32)}`;
const HANDOFF_ID = `oph1:${"12".repeat(32)}`;
const NOW = "2026-06-28T12:00:00.000Z";

type Row = Record<string, unknown>;

// ─── Drizzle-SQL-evaluating in-memory fake ───

function evalCond(cond: any, row: Row): boolean {
  let field: string | null = null;
  let ok = true;
  const chunks: any[] = cond?.queryChunks ?? [];
  for (const chunk of chunks) {
    if (chunk === null || chunk === undefined) continue;
    if (Array.isArray(chunk?.queryChunks)) {
      if (!evalCond(chunk, row)) ok = false;
      continue;
    }
    if (typeof chunk === "object") {
      if (typeof chunk.name === "string" && chunk.table) {
        field = chunk.name;
        continue;
      }
      if (
        ["string", "number", "boolean"].includes(typeof chunk.value) &&
        !Array.isArray(chunk.value)
      ) {
        if (row[field ?? ""] !== chunk.value) ok = false;
        field = null;
        continue;
      }
      continue;
    }
    if (["string", "number", "boolean"].includes(typeof chunk)) {
      if (row[field ?? ""] !== chunk) ok = false;
      field = null;
    }
  }
  return ok;
}

function parseOrderTerm(term: any): { field: string; direction: "asc" | "desc" } {
  const chunks: any[] = term?.queryChunks ?? [];
  const column = chunks.find((c) => c && typeof c === "object" && typeof c.name === "string");
  const text = chunks
    .filter((c) => c && Array.isArray(c.value))
    .map((c) => c.value.join(""))
    .join(" ");
  return { field: column?.name ?? "", direction: /\bdesc\b/i.test(text) ? "desc" : "asc" };
}

function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  const av = a instanceof Date ? a.getTime() : a;
  const bv = b instanceof Date ? b.getTime() : b;
  return av < bv ? -1 : 1;
}

function makeFakeDb(seed: Record<string, Row[]>, availableTables: string[]) {
  const duplicateKeyError = () =>
    Object.assign(new Error("Duplicate entry"), { code: "ER_DUP_ENTRY", errno: 1062 });
  const db = {
    select: () => ({
      from: (table: unknown) => {
        const name = (table as Record<symbol, string>)[Symbol.for("drizzle:Name")];
        let rows = [...(seed[name] ?? [])];
        const chain: any = {
          where: (cond: any) => {
            rows = rows.filter((row) => evalCond(cond, row));
            return chain;
          },
          orderBy: (...terms: any[]) => {
            const parsed = terms.map(parseOrderTerm);
            rows = [...rows].sort((a, b) => {
              for (const term of parsed) {
                const cmp = compareValues(a[term.field], b[term.field]);
                if (cmp !== 0) return term.direction === "asc" ? cmp : -cmp;
              }
              return 0;
            });
            return chain;
          },
          limit: (n: number) => Promise.resolve(rows.slice(0, n).map((r) => ({ ...r }))),
          then: (onF: any, onR: any) => Promise.resolve(rows.map((r) => ({ ...r }))).then(onF, onR),
        };
        return chain;
      },
    }),
    insert: (table: unknown) => ({
      values: async (row: Row) => {
        const name = (table as Record<symbol, string>)[Symbol.for("drizzle:Name")];
        const rows = (seed[name] ??= []);
        if (name === "lead_qualifications") {
          if (rows.some((r) => r.userId === row.userId && r.qualificationId === row.qualificationId)) {
            throw duplicateKeyError();
          }
        }
        if (name === "lead_qualification_reviews") {
          if (
            rows.some((r) => r.userId === row.userId && r.reviewId === row.reviewId) ||
            rows.some((r) => r.userId === row.userId && r.qualificationId === row.qualificationId)
          ) {
            throw duplicateKeyError();
          }
        }
        rows.push({ ...row });
        return [{ affectedRows: 1 }];
      },
    }),
    update: (table: unknown) => ({
      set: (patch: Row) => ({
        where: async (cond: any) => {
          const name = (table as Record<symbol, string>)[Symbol.for("drizzle:Name")];
          const rows = seed[name] ?? [];
          let affected = 0;
          for (const row of rows) {
            if (evalCond(cond, row)) {
              Object.assign(row, patch);
              affected += 1;
            }
          }
          return { affectedRows: affected };
        },
      }),
    }),
    execute: async () => [availableTables.map((table_name) => ({ table_name })), []],
  };
  return db;
}

// ─── Fixtures ───

function identityRow(overrides: Row = {}): Row {
  return {
    id: 1,
    leadId: LEAD_ID,
    identityKey: H64,
    contractVersion: "lead-identity/v1",
    userId: 7,
    businessId: 3,
    primaryIdentityType: "provider_actor",
    identityStatus: "active",
    identityConfidence: "high",
    externalActorReferenceHash: null,
    provider: "meta",
    emailIdentityHash: null,
    phoneIdentityHash: null,
    customerReferenceHash: null,
    sourceOpportunityId: OPP_ID,
    sourceHandoffId: HANDOFF_ID,
    canonicalLeadId: null,
    firstObservedAt: "2026-06-20T10:00:00.000Z",
    lastObservedAt: "2026-06-28T11:00:00.000Z",
    provenanceCount: 2,
    identityEvidenceCount: 0,
    version: 1,
    statusChangedAt: new Date("2026-06-20T10:00:00.000Z"),
    createdAt: new Date("2026-06-20T10:00:00.000Z"),
    updatedAt: new Date("2026-06-28T11:00:00.000Z"),
    ...overrides,
  };
}

function provenanceRow(overrides: Row = {}): Row {
  return {
    id: 1,
    leadRowId: 1,
    leadId: LEAD_ID,
    userId: 7,
    kind: "opportunity_handoff",
    handoffId: HANDOFF_ID,
    opportunityId: OPP_ID,
    provider: "meta",
    campaignId: null,
    publicationId: null,
    evidenceType: "handoff",
    evidenceHash: H64,
    envelopeHash: null,
    occurredAt: "2026-06-20T10:00:00.000Z",
    createdAt: new Date("2026-06-20T10:00:00.000Z"),
    ...overrides,
  };
}

function scoreRow(overrides: Row = {}): Row {
  return {
    id: 1,
    leadScoreId: SCORE_ID,
    evidenceSnapshotId: `lss1:${G64}`,
    scoreContractVersion: "lead-scoring/v1",
    userId: 7,
    businessId: 3,
    leadId: 42, // legacy numeric leads.id
    leadIdentityVersion: `lead-identity-seam/v1:${G64}`,
    scoringVersion: "lead-scoring-engine/v1",
    featureVersion: "lead-scoring-features/v1",
    evidenceSnapshotHash: E64,
    evidenceManifest: [
      { opportunityId: OPP_ID, interpretationId: "i1", signalId: "s1", signalVersion: 1, kind: "intent", occurredAt: "2026-06-27T09:00:00.000Z" },
      { opportunityId: OPP_ID, interpretationId: "i2", signalId: "s2", signalVersion: 1, kind: "intent", occurredAt: "2026-06-28T08:00:00.000Z" },
    ],
    overallScore: 75,
    scoreBand: "HIGH",
    scoreConfidence: "HIGH",
    fitScore: 60,
    intentScore: 60,
    engagementScore: 10,
    recencyScore: 80,
    opportunityScore: 20,
    componentWeights: { fit: 0.2, intent: 0.2, engagement: 0.2, recency: 0.2, opportunity: 0.2 },
    reasonCodes: ["CAMPAIGN_ALIGNED", "RECENT_EVIDENCE"],
    computedAt: new Date(NOW),
    createdAt: new Date(NOW),
    ...overrides,
  };
}

const ALL_TABLES = [
  "lead_identities",
  "lead_identity_provenance",
  "lead_score_snapshots",
  "lead_privacy_states",
];

// ─── Tests ───

describe("createQualificationBridgeProvider — availability guard", () => {
  it("fails closed with ProviderAuthorityUnavailable when the identity schema is absent", async () => {
    const provider = createQualificationBridgeProvider(makeFakeDb({}, []) as never, 7);
    await expect(provider.getIdentityProjection(LEAD_ID)).rejects.toBeInstanceOf(
      ProviderAuthorityUnavailable
    );
    await expect(provider.getScorePayload(SCORE_ID)).rejects.toBeInstanceOf(
      ProviderAuthorityUnavailable
    );
  });

  it("probes availability once per instance (memoized)", async () => {
    let executeCalls = 0;
    const db = makeFakeDb({ lead_score_snapshots: [scoreRow()] }, ALL_TABLES);
    const counting = {
      ...db,
      execute: async (...args: unknown[]) => {
        executeCalls += 1;
        return db.execute(...(args as []));
      },
    };
    const provider = createQualificationBridgeProvider(counting as never, 7);
    await provider.getPrivacyState(LEAD_ID);
    await provider.getScorePayload(SCORE_ID);
    expect(executeCalls).toBe(1);
  });

  it("privacy degrades to null when the privacy table is absent (ACTIVE per F semantics)", async () => {
    const provider = createQualificationBridgeProvider(
      makeFakeDb({}, ALL_TABLES.filter((t) => t !== "lead_privacy_states")) as never,
      7
    );
    expect(await provider.getPrivacyState(LEAD_ID)).toBeNull();
  });
});

describe("createQualificationBridgeProvider — identity projection", () => {
  it("maps the upstream rows to the exact 14-key projection (provenance oldest-first)", async () => {
    const seed: Record<string, Row[]> = {
      lead_identities: [identityRow()],
      lead_identity_provenance: [
        provenanceRow({ id: 2, evidenceHash: G64, occurredAt: "2026-06-27T10:00:00.000Z", createdAt: new Date("2026-06-27T10:00:00.000Z") }),
        provenanceRow({ id: 1, evidenceHash: H64, occurredAt: "2026-06-20T10:00:00.000Z", createdAt: new Date("2026-06-20T10:00:00.000Z") }),
      ],
    };
    const provider = createQualificationBridgeProvider(makeFakeDb(seed, ALL_TABLES) as never, 7);
    const projection = (await provider.getIdentityProjection(LEAD_ID)) as Record<string, unknown>;

    expect(Object.keys(projection).sort()).toEqual(
      [
        "businessId",
        "canonicalLeadId",
        "externalActorReferenceHash",
        "firstObservedAt",
        "identityConfidence",
        "identityStatus",
        "lastObservedAt",
        "leadId",
        "leadIdentityVersion",
        "primaryIdentityType",
        "provider",
        "provenance",
        "sourceHandoffId",
        "sourceOpportunityId",
      ].sort()
    );
    expect(projection.leadId).toBe(LEAD_ID);
    expect(projection.businessId).toBe(3);
    expect(projection.leadIdentityVersion).toBe("lead-identity/v1");
    expect(projection.provenance).toEqual([
      { kind: "opportunity_handoff", handoffId: HANDOFF_ID, opportunityId: OPP_ID, evidenceType: "handoff", occurredAt: "2026-06-20T10:00:00.000Z" },
      { kind: "opportunity_handoff", handoffId: HANDOFF_ID, opportunityId: OPP_ID, evidenceType: "handoff", occurredAt: "2026-06-27T10:00:00.000Z" },
    ]);
  });

  it("throws ProviderLeadNotFound when the lead row is absent (tenant-anchored)", async () => {
    const provider = createQualificationBridgeProvider(
      makeFakeDb({ lead_identities: [identityRow({ userId: 99 })] }, ALL_TABLES) as never,
      7
    );
    await expect(provider.getIdentityProjection(LEAD_ID)).rejects.toBeInstanceOf(
      ProviderLeadNotFound
    );
  });
});

describe("createQualificationBridgeProvider — score payload", () => {
  it("maps the frozen B row into the seam key set (freshness from the manifest, no scoreContentHash)", async () => {
    const seed: Record<string, Row[]> = { lead_score_snapshots: [scoreRow()] };
    const provider = createQualificationBridgeProvider(makeFakeDb(seed, ALL_TABLES) as never, 7);
    const payload = (await provider.getScorePayload(SCORE_ID)) as Record<string, unknown>;

    expect(payload.leadScoreId).toBe(SCORE_ID);
    expect(payload.leadId).toBe(42); // legacy numeric id carried verbatim
    expect(payload.leadIdentityVersion).toBe(`lead-identity-seam/v1:${G64}`);
    expect(payload.evidenceFreshness).toEqual({
      latestObservedAt: "2026-06-28T08:00:00.000Z",
      computedAt: NOW,
    });
    expect(payload.duplicateClassification).toBe("none");
    expect(payload).not.toHaveProperty("scoreContentHash");
    expect(payload).not.toHaveProperty("evidenceManifest");
    expect(payload).not.toHaveProperty("id");
  });

  it("throws ProviderScoreNotFound when the score row is absent", async () => {
    const provider = createQualificationBridgeProvider(makeFakeDb({}, ALL_TABLES) as never, 7);
    await expect(provider.getScorePayload(SCORE_ID)).rejects.toBeInstanceOf(
      ProviderScoreNotFound
    );
  });

  it("passes the latest privacy row through the governance seam shape", async () => {
    const seed: Record<string, Row[]> = {
      lead_privacy_states: [
        {
          id: 1,
          leadId: LEAD_ID,
          userId: 7,
          businessId: 3,
          privacyState: "SUPPRESSED",
          previousState: "ACTIVE",
          reason: "opt-out",
          retentionDeadlineAt: null,
          source: "operator",
          actorUserId: 7,
          createdAt: new Date("2026-06-25T10:00:00.000Z"),
          updatedAt: new Date("2026-06-25T10:00:00.000Z"),
        },
      ],
    };
    const provider = createQualificationBridgeProvider(makeFakeDb(seed, ALL_TABLES) as never, 7);
    expect(await provider.getPrivacyState(LEAD_ID)).toEqual({ state: "SUPPRESSED" });
  });
});

describe("bindQualificationStoreExecutor", () => {
  function qualificationRow(overrides: Partial<LeadQualificationRow> = {}): LeadQualificationRow {
    return {
      qualificationId: `lqu1:${H64}`,
      contractVersion: "lead-qualification/v1",
      engineVersion: "lead-qualification-engine/v1",
      userId: 7,
      businessId: 3,
      leadId: LEAD_ID,
      leadIdentityVersion: "lead-identity/v1",
      identityReference: G64,
      leadScoreId: SCORE_ID,
      scoringVersion: "lead-scoring-engine/v1",
      scoreContentHash: E64,
      qualificationPolicyVersion: "lead-qualification-policy/v1",
      evidenceSnapshotHash: H64,
      evidenceSnapshot: { assembledAt: NOW, entries: [] },
      decision: "QUALIFIED",
      reasonCodes: ["POLICY_REQUIREMENTS_MET"],
      confidenceScore: 10000,
      reviewRequired: false,
      evaluatedAt: NOW,
      validUntil: "2026-07-05T12:00:00.000Z",
      createdAt: NOW,
      ...overrides,
    };
  }

  it("serves the store seam over the canonical schema tables (insert, read, CAS update)", async () => {
    const seed: Record<string, Row[]> = { lead_qualifications: [], lead_qualification_reviews: [] };
    const executor = bindQualificationStoreExecutor(makeFakeDb(seed, []));

    const row = qualificationRow();
    await insertQualification(row, executor);
    const fetched = await getQualification(7, row.qualificationId, executor);
    expect(fetched.qualificationId).toBe(row.qualificationId);
    expect(await listQualificationHistory(7, LEAD_ID, executor)).toHaveLength(1);

    // Replay converges through the errno-1062 path.
    const replay = await insertQualification(qualificationRow(), executor);
    expect(replay.duplicateClassification).toBe("idempotent_replay");

    // Review insert + optimistic-CAS resolution through translated SQL.
    await insertReview(
      {
        reviewId: `lqr1:${G64}`,
        userId: 7,
        businessId: 3,
        leadId: LEAD_ID,
        qualificationId: row.qualificationId,
        decisionBindingHash: E64,
        status: "pending",
        triggerReasonCodes: ["REVIEW_TRIGGERED_BY_POLICY"],
        resolvedBy: null,
        resolvedAt: null,
        resolutionReason: null,
        version: 1,
        createdAt: NOW,
        updatedAt: NOW,
      },
      executor
    );
    const updated = await updateReviewResolution(
      7,
      `lqr1:${G64}`,
      1,
      { status: "progress_authorized", resolvedBy: 7, resolvedAt: NOW, resolutionReason: "verified" },
      executor
    );
    expect(updated.status).toBe("progress_authorized");
    expect(updated.version).toBe(2);
  });
});
