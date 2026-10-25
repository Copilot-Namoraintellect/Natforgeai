/**
 * R6-A — Lead Identity Acceptance Suite (contract §15, A9).
 *
 * Twenty-five deterministic, connected acceptance cases proving the
 * lead-identity authority: genuine R5 opportunity handoff fixtures (minted by
 * the REAL R5-D pipeline: evaluateOpportunity → handoffToR6) are consumed
 * through validation → deterministic resolution → canonical persistence →
 * immutable provenance → downstream-safe projection, plus the adversarial
 * security cases. No real MySQL, no wall-clock reliance (explicit `now`),
 * no model, no scoring/qualification/contact/conversion.
 *
 * Harness design (adapted from api/lib/opportunity/r5-d-acceptance.test.ts):
 * per-table row arrays keyed by drizzle metadata; where-conditions evaluated
 * by walking queryChunks; inserts enforce the durable unique keys
 * (ER_DUP_ENTRY shaped); updates apply patches and resolve affectedRows.
 * Nullable unique members follow MySQL semantics (any NULL member ⇒ distinct).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../queries/connection", () => ({
  getDb: vi.fn(() => {
    throw new Error("getDb must not fall back to a real connection in r6-a acceptance tests");
  }),
}));

import { getDb } from "../../queries/connection";
import {
  evaluateOpportunity,
  handoffToR6,
} from "../opportunity/detector";
import type { CanonicalInterpretationInput } from "../opportunity/canonical-intelligence";
import { HANDOFF_ID_PREFIX } from "../opportunity/opportunity-identity";
import {
  consumeOpportunityHandoff,
  submitIdentityEvidence,
  suppressLeadIdentity,
  archiveLeadIdentity,
  getLeadIdentity,
  listLeadIdentities,
} from "./lead-identity-service";
import {
  validateHandoffEnvelope,
  canonicalJson,
  sha256Hex,
  LeadIdentityOwnershipError,
  LeadIdentityInputError,
  LeadIdentityTamperError,
  LeadIdentityValidationError,
  LeadIdentityStateConflictError,
} from "./lead-identity-contract";

const mockedGetDb = vi.mocked(getDb);

// ─── Fake drizzle harness ───

type FakeRow = Record<string, unknown>;
type FakeTables = Record<string, FakeRow[]>;

function tableName(table: unknown): string {
  return (table as Record<symbol, string>)[Symbol.for("drizzle:Name")] ?? "unknown";
}

function fragText(chunk: unknown): string {
  if (chunk && typeof chunk === "object" && Array.isArray((chunk as { value?: unknown[] }).value)) {
    return ((chunk as { value: string[] }).value[0] ?? "") as string;
  }
  return "";
}

function toEpochMs(value: unknown): number | null {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") {
    const t = Date.parse(value);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

function compareOp(opText: string, rowValue: unknown, param: unknown): boolean {
  const op = opText.includes(">=")
    ? ">="
    : opText.includes("<=")
      ? "<="
      : opText.includes("!=") || opText.includes("<>")
        ? "!="
        : opText.includes("=")
          ? "="
          : opText.includes(">")
            ? ">"
            : opText.includes("<")
              ? "<"
              : "=";
  const rowMs = toEpochMs(rowValue);
  const paramMs = toEpochMs(param);
  const useTime =
    rowMs !== null && paramMs !== null && (rowValue instanceof Date || param instanceof Date);
  const l: unknown = useTime ? rowMs : rowValue;
  const r: unknown = useTime ? paramMs : param;
  switch (op) {
    case ">=":
      return (l as number) >= (r as number);
    case "<=":
      return (l as number) <= (r as number);
    case ">":
      return (l as number) > (r as number);
    case "<":
      return (l as number) < (r as number);
    case "!=":
      return l !== r;
    default:
      return l === r;
  }
}

function evalCond(cond: unknown, row: FakeRow): boolean {
  const chunks: unknown[] = (cond as { queryChunks?: unknown[] })?.queryChunks ?? [];
  if (!Array.isArray(chunks) || chunks.length === 0) return true;
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i] as Record<string, unknown> | undefined;
    if (!chunk || typeof chunk !== "object") continue;
    if (Array.isArray(chunk.queryChunks)) {
      if (!evalCond(chunk, row)) return false;
      continue;
    }
    if (typeof chunk.name === "string" && chunk.table) {
      const opText = fragText(chunks[i + 1]);
      const inMatch = /\bIN\s*\(/i.exec(opText);
      if (inMatch) {
        const listed = Array.from(opText.matchAll(/'([^']*)'/g)).map((m) => m[1]);
        if (!listed.includes(row[chunk.name] as string)) return false;
        i += 1;
        continue;
      }
      const param = chunks[i + 2];
      const value =
        param && typeof param === "object" && "value" in param
          ? (param as { value: unknown }).value
          : param;
      if (!compareOp(opText, row[chunk.name], value)) return false;
      i += 2;
    }
  }
  return true;
}

/** Durable unique keys the fake enforces (mirrors db/schema.ts unique indexes). */
const UNIQUE_CONSTRAINTS: Record<string, string[][]> = {
  opportunity_candidates: [["userId", "opportunityKey"]],
  opportunity_evidence: [["interpretationId", "kind"], ["engagementReceiptId"]],
  opportunity_suppressions: [["interpretationId"]],
  opportunity_handoffs: [
    ["userId", "opportunityId"],
    ["handoffId"],
  ],
  lead_identities: [
    ["userId", "identityKey"],
    ["userId", "leadId"],
    ["userId", "emailIdentityHash"],
    ["userId", "phoneIdentityHash"],
    ["userId", "customerReferenceHash"],
  ],
  lead_identity_provenance: [
    ["userId", "handoffId"],
    ["userId", "kind", "evidenceHash"],
  ],
  lead_identity_merges: [
    ["userId", "mergeId"],
    ["userId", "canonicalLeadId", "absorbedLeadId"],
    ["userId", "mergeHash"],
  ],
  audit_events: [["eventFingerprint"]],
};

function duplicateKeyError(): Error & { code: string } {
  const err = new Error("Duplicate entry (simulated unique-key violation)") as Error & {
    code: string;
  };
  err.code = "ER_DUP_ENTRY";
  return err;
}

function createFakeDb(seed: FakeTables = {}) {
  const tables: FakeTables = {
    audit_events: [],
    opportunity_candidates: [],
    opportunity_evidence: [],
    opportunity_suppressions: [],
    opportunity_handoffs: [],
    lead_identities: [],
    lead_identity_provenance: [],
    lead_identity_merges: [],
    leads: [],
    lead_activities: [],
    lead_scores: [],
    outreach_recommendations: [],
    ...seed,
  };
  const nextIds: Record<string, number> = {};
  for (const name of Object.keys(tables)) {
    const maxId = tables[name].reduce((m, r) => Math.max(m, Number(r.id ?? 0)), 0);
    nextIds[name] = maxId + 1;
  }

  function checkUnique(name: string, row: FakeRow): void {
    for (const cols of UNIQUE_CONSTRAINTS[name] ?? []) {
      // MySQL unique semantics: any NULL member makes the row distinct.
      if (cols.some((c) => row[c] === null || row[c] === undefined)) continue;
      if (tables[name].some((r) => cols.every((c) => r[c] === row[c]))) {
        throw duplicateKeyError();
      }
    }
  }

  const client = {
    select: (fields?: unknown) => ({
      from: (table: unknown) => {
        const name = tableName(table);
        const rows = (): FakeRow[] => tables[name] ?? [];
        const makeResult = (cond: unknown) => {
          const matched = () => rows().filter((r) => evalCond(cond, r));
          const result: {
            limit: (n: number) => Promise<FakeRow[]>;
            then: (onF: unknown, onR: unknown) => Promise<unknown>;
          } = {
            limit: async (n: number) => matched().slice(0, n),
            then: (onF: unknown, onR: unknown) =>
              Promise.resolve(matched()).then(onF as never, onR as never),
          };
          return result;
        };
        return {
          where: (cond: unknown) => makeResult(cond),
          limit: async (n: number) => rows().slice(0, n),
        };
      },
    }),
    insert: (table: unknown) => ({
      values: (values: FakeRow) => {
        const name = tableName(table);
        checkUnique(name, values);
        const row: FakeRow = { ...values };
        if (row.id === undefined) {
          row.id = nextIds[name]++;
        } else {
          nextIds[name] = Math.max(nextIds[name], Number(row.id) + 1);
        }
        tables[name].push(row);
        return Promise.resolve([{ insertId: row.id, affectedRows: 1 }]);
      },
    }),
    update: (table: unknown) => ({
      set: (patch: FakeRow) => ({
        where: (cond: unknown) => {
          const name = tableName(table);
          const matched = (tables[name] ?? []).filter((r) => evalCond(cond, r));
          for (const r of matched) Object.assign(r, patch);
          return Promise.resolve({ affectedRows: matched.length });
        },
      }),
    }),
  };

  return { db: client as never, tables };
}

/** Universal ownership seed: tenant 1 owns business/campaign 1; tenant 2 owns 2. */
function createSeededDb(extraSeed: FakeTables = {}) {
  return createFakeDb({
    businesses: [
      { id: 1, userId: 1 },
      { id: 2, userId: 2 },
      { id: 3, userId: 1 },
    ],
    campaigns: [
      { id: 1, userId: 1 },
      { id: 2, userId: 2 },
    ],
    ...extraSeed,
  });
}

// ─── Fixtures: genuine R5 handoffs via the real R5-D pipeline ───

const T0 = new Date("2026-10-20T12:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;

let seq = 0;
function makeInterpretation(
  overrides: Partial<CanonicalInterpretationInput> = {}
): CanonicalInterpretationInput {
  seq += 1;
  return {
    interpretationId: `int-${seq}`,
    classifierVersion: "intent-sentiment-classifier/v1",
    userId: 1,
    businessId: 1,
    signalId: `sig-${seq}`,
    signalVersion: 1,
    signalType: "comment",
    provider: "meta",
    platform: "instagram",
    actorReference: "actor-1",
    parentExternalObjectId: "thread-1",
    externalObjectId: `comment-${seq}`,
    sourceCampaignId: 1,
    source: "MODEL",
    intent: "purchase_interest",
    sentiment: "positive",
    urgency: "normal",
    relevance: "relevant",
    overallConfidence: "medium",
    topics: ["pricing"],
    riskFlags: [],
    opportunityIndicators: [{ indicator: "purchase_intent_detected", evidence: "asks price" }],
    recommendedHandling: "opportunity_candidate",
    occurredAt: "2026-10-20T10:00:00.000Z",
    createdAt: "2026-10-20T10:00:01.000Z",
    ...overrides,
  };
}

/** Mint one authentic R5 opportunity handoff envelope. */
async function mintHandoff(
  fake: ReturnType<typeof createSeededDb>,
  overrides: Partial<CanonicalInterpretationInput> = {},
  opts: { userId?: number; now?: Date } = {}
) {
  const userId = opts.userId ?? 1;
  const now = opts.now ?? T0;
  const interpretation = makeInterpretation({ userId, ...overrides });
  const evaluated = await evaluateOpportunity({
    interpretation,
    userId,
    now,
    executor: fake.db,
  });
  if (evaluated.kind !== "candidate_created" && evaluated.kind !== "candidate_strengthened") {
    throw new Error(`fixture setup expected a candidate, got ${evaluated.kind}`);
  }
  const handed = await handoffToR6({
    opportunityId: evaluated.opportunityId,
    userId,
    now: new Date(now.getTime() + HOUR_MS),
    executor: fake.db,
  });
  return handed.envelope;
}

/** Handcraft a structurally valid envelope (for forged/tampered/stale cases). */
function buildCraftedEnvelope(overrides: Record<string, unknown> = {}) {
  const evidence = [
    { interpretationId: "int-x", signalId: "sig-x", signalVersion: 1, occurredAt: "2026-10-20T10:00:00.000Z" },
  ];
  const content = {
    handoffEnvelopeVersion: "opportunity-to-lead-autonomy/v1",
    handoffId: "placeholder",
    opportunityId: `opp1:${"a".repeat(64)}`,
    opportunityKey: "b".repeat(64),
    userId: 1,
    businessId: 1,
    opportunityType: "purchase_interest",
    opportunityStatusAtHandoff: "candidate",
    confidenceClass: "MEDIUM",
    evidenceStrength: "MEDIUM",
    urgency: "normal",
    topic: "pricing",
    topicKey: "c".repeat(64),
    actorKey: "d".repeat(64),
    threadKey: "e".repeat(64),
    campaignId: 1,
    publicationId: null,
    provider: "meta",
    externalActorReference: null,
    evidenceCount: 1,
    contradictionCount: 0,
    firstObservedAt: "2026-10-20T09:00:00.000Z",
    lastObservedAt: "2026-10-20T10:00:00.000Z",
    detectorRulesVersion: "opportunity-detector/v1",
    classifierVersions: ["intent-sentiment-classifier/v1"],
    evidence,
    evidenceSnapshotHash: sha256Hex(canonicalJson(evidence)),
    handedOffAt: "2026-10-20T12:00:00.000Z",
    ...overrides,
  };
  const { handoffId: _omit, ...rest } = content;
  void _omit;
  const handoffId = `${HANDOFF_ID_PREFIX}${sha256Hex(canonicalJson(rest))}`;
  return { ...rest, handoffId };
}

const LEAD_IDENTITY_AUDIT_TYPES = [
  "lead_identity_created",
  "lead_identity_observed",
  "lead_identity_evidence_attached",
  "lead_identity_merged",
  "lead_identity_conflict",
  "lead_identity_suppressed",
  "lead_identity_archived",
] as const;

const OPPORTUNITY_AUDIT_TYPES = [
  "opportunity_detected",
  "opportunity_suppressed",
  "opportunity_state_changed",
  "opportunity_handed_off",
] as const;

function scanRowsFor(tables: FakeTables, names: string[], needle: string): string[] {
  const hits: string[] = [];
  for (const name of names) {
    for (const row of tables[name] ?? []) {
      if (JSON.stringify(row).includes(needle)) hits.push(name);
    }
  }
  return hits;
}

const R6_TABLES = ["lead_identities", "lead_identity_provenance", "lead_identity_merges"];
const DEMO_TABLES = ["leads", "lead_activities", "lead_scores", "outreach_recommendations"];
const TOKEN_LIKE = /(bearer\s+[a-z0-9._-]{10,}|sk-[a-z0-9]{10,}|eyJ[a-zA-Z0-9_-]{10,})/i;

beforeEach(() => vi.clearAllMocks());

// ─── A9 1–5: creation, replay, concurrency, actor resolution ───

describe("A9 cases 1–5 — intake, exact-once, actor resolution", () => {
  it("case 1: first opportunity handoff creates one canonical lead identity", async () => {
    const fake = createSeededDb();
    const envelope = await mintHandoff(fake);
    const outcome = await consumeOpportunityHandoff({
      envelope,
      userId: 1,
      now: new Date(T0.getTime() + 2 * HOUR_MS),
      executor: fake.db,
    });
    expect(outcome.result).toBe("NO_MATCH");
    expect(outcome.duplicateClassification).toBe("none");
    expect(outcome.leadId).toMatch(/^lid1:[a-f0-9]{64}$/);
    expect(outcome.identityStatus).toBe("active");
    expect(outcome.identityConfidence).toBe("low");
    expect(fake.tables.lead_identities).toHaveLength(1);
    expect(fake.tables.lead_identity_provenance).toHaveLength(1);
    expect(fake.tables.lead_identities[0].sourceHandoffId).toBe(envelope.handoffId);
    // Lead identity ≠ CRM lead: no downstream entities are ever created.
    for (const table of DEMO_TABLES) expect(fake.tables[table]).toHaveLength(0);
    for (const row of fake.tables.audit_events) {
      expect([...LEAD_IDENTITY_AUDIT_TYPES, ...OPPORTUNITY_AUDIT_TYPES]).toContain(row.eventType);
    }
    expect(mockedGetDb).not.toHaveBeenCalled();
  });

  it("case 2: replayed handoff returns the same lead (idempotent_replay)", async () => {
    const fake = createSeededDb();
    const envelope = await mintHandoff(fake);
    const first = await consumeOpportunityHandoff({
      envelope,
      userId: 1,
      now: new Date(T0.getTime() + 2 * HOUR_MS),
      executor: fake.db,
    });
    const replay = await consumeOpportunityHandoff({
      envelope,
      userId: 1,
      now: new Date(T0.getTime() + 3 * HOUR_MS),
      executor: fake.db,
    });
    expect(replay.result).toBe("MATCH");
    expect(replay.duplicateClassification).toBe("idempotent_replay");
    expect(replay.leadId).toBe(first.leadId);
    expect(fake.tables.lead_identities).toHaveLength(1);
    expect(fake.tables.lead_identity_provenance).toHaveLength(1);
    // Exactly one lead_identity_created audit; the replay emits nothing.
    const created = fake.tables.audit_events.filter((e) => e.eventType === "lead_identity_created");
    expect(created).toHaveLength(1);
  });

  it("case 3: concurrent duplicate handoff converges to one lead", async () => {
    const fake = createSeededDb();
    const envelope = await mintHandoff(fake);
    const now = new Date(T0.getTime() + 2 * HOUR_MS);
    const [a, b] = await Promise.all([
      consumeOpportunityHandoff({ envelope, userId: 1, now, executor: fake.db }),
      consumeOpportunityHandoff({ envelope, userId: 1, now, executor: fake.db }),
    ]);
    expect(a.leadId).toBe(b.leadId);
    expect(fake.tables.lead_identities).toHaveLength(1);
    expect(fake.tables.lead_identity_provenance).toHaveLength(1);
    expect([a.duplicateClassification, b.duplicateClassification].sort()).toEqual([
      "idempotent_replay",
      "none",
    ]);
  });

  it("case 4: second opportunity from the same provider actor resolves to the same lead", async () => {
    const fake = createSeededDb();
    const first = await mintHandoff(fake, { externalObjectId: "comment-a", parentExternalObjectId: "thread-a" });
    const second = await mintHandoff(fake, { externalObjectId: "comment-b", parentExternalObjectId: "thread-b" });
    const o1 = await consumeOpportunityHandoff({
      envelope: first,
      userId: 1,
      now: new Date(T0.getTime() + 2 * HOUR_MS),
      executor: fake.db,
    });
    const o2 = await consumeOpportunityHandoff({
      envelope: second,
      userId: 1,
      now: new Date(T0.getTime() + 3 * HOUR_MS),
      executor: fake.db,
    });
    expect(o2.leadId).toBe(o1.leadId);
    expect(o2.result).toBe("MATCH");
    expect(fake.tables.lead_identities).toHaveLength(1);
    const lead = fake.tables.lead_identities[0];
    expect(lead.provenanceCount).toBe(2);
    expect(lead.identityConfidence).toBe("medium"); // repeat observation
    expect(fake.tables.lead_identity_provenance).toHaveLength(2);
  });

  it("case 5: unrelated actor creates a distinct lead", async () => {
    const fake = createSeededDb();
    const first = await mintHandoff(fake, { actorReference: "actor-1" });
    const second = await mintHandoff(fake, { actorReference: "actor-2" });
    const o1 = await consumeOpportunityHandoff({
      envelope: first,
      userId: 1,
      now: new Date(T0.getTime() + 2 * HOUR_MS),
      executor: fake.db,
    });
    const o2 = await consumeOpportunityHandoff({
      envelope: second,
      userId: 1,
      now: new Date(T0.getTime() + 2 * HOUR_MS),
      executor: fake.db,
    });
    expect(o2.leadId).not.toBe(o1.leadId);
    expect(fake.tables.lead_identities).toHaveLength(2);
  });
});

// ─── A9 6–10: isolation, cross-provider, merge, conflict ───

describe("A9 cases 6–10 — isolation, cross-provider rules, merge, conflict", () => {
  it("case 6: cross-tenant / cross-business actor never merges", async () => {
    const fake = createSeededDb();
    const t1 = await mintHandoff(fake, { actorReference: "actor-x", userId: 1, businessId: 1, sourceCampaignId: 1 }, { userId: 1 });
    const t2 = await mintHandoff(
      fake,
      { actorReference: "actor-x", userId: 2, businessId: 2, sourceCampaignId: 2, interpretationId: "int-t2", signalId: "sig-t2" },
      { userId: 2 }
    );
    const o1 = await consumeOpportunityHandoff({ envelope: t1, userId: 1, now: new Date(T0.getTime() + 2 * HOUR_MS), executor: fake.db });
    const o2 = await consumeOpportunityHandoff({ envelope: t2, userId: 2, now: new Date(T0.getTime() + 2 * HOUR_MS), executor: fake.db });
    expect(o1.leadId).not.toBe(o2.leadId);
    expect(fake.tables.lead_identities).toHaveLength(2);
    expect(fake.tables.lead_identity_merges).toHaveLength(0);

    // Same tenant, different business scope: still distinct.
    const b3 = await mintHandoff(fake, { actorReference: "actor-x", businessId: 3, sourceCampaignId: 1 });
    const o3 = await consumeOpportunityHandoff({ envelope: b3, userId: 1, now: new Date(T0.getTime() + 2 * HOUR_MS), executor: fake.db });
    expect(o3.leadId).not.toBe(o1.leadId);
    expect(fake.tables.lead_identities).toHaveLength(3);
  });

  it("case 7: same actor ID on different providers does not merge automatically", async () => {
    const fake = createSeededDb();
    const meta = await mintHandoff(fake, { actorReference: "actor-cross", provider: "meta", platform: "instagram" });
    const linkedin = await mintHandoff(fake, {
      actorReference: "actor-cross",
      provider: "linkedin",
      platform: "linkedin",
      externalObjectId: "comment-li",
      parentExternalObjectId: "thread-li",
    });
    const o1 = await consumeOpportunityHandoff({ envelope: meta, userId: 1, now: new Date(T0.getTime() + 2 * HOUR_MS), executor: fake.db });
    const o2 = await consumeOpportunityHandoff({ envelope: linkedin, userId: 1, now: new Date(T0.getTime() + 2 * HOUR_MS), executor: fake.db });
    expect(o1.leadId).not.toBe(o2.leadId);
    expect(fake.tables.lead_identities).toHaveLength(2);
    expect(fake.tables.lead_identity_merges).toHaveLength(0);
    // Actor keys differ because provider|platform is bound inside the hash.
    const a = fake.tables.lead_identities.find((r) => r.leadId === o1.leadId);
    const b = fake.tables.lead_identities.find((r) => r.leadId === o2.leadId);
    expect(a.externalActorReferenceHash).not.toBe(b.externalActorReferenceHash);
  });

  it("case 8: verified shared email hash may merge across providers", async () => {
    const fake = createSeededDb();
    const meta = await mintHandoff(fake, { actorReference: "actor-m", provider: "meta", platform: "instagram" });
    const linkedin = await mintHandoff(fake, {
      actorReference: "actor-l",
      provider: "linkedin",
      platform: "linkedin",
      externalObjectId: "comment-li2",
      parentExternalObjectId: "thread-li2",
    });
    const o1 = await consumeOpportunityHandoff({ envelope: meta, userId: 1, now: new Date(T0.getTime() + 2 * HOUR_MS), executor: fake.db });
    const o2 = await consumeOpportunityHandoff({ envelope: linkedin, userId: 1, now: new Date(T0.getTime() + 2 * HOUR_MS), executor: fake.db });

    const attach1 = await submitIdentityEvidence({
      userId: 1,
      leadId: o1.leadId,
      evidenceType: "email",
      value: "Buyer@Example.com",
      now: new Date(T0.getTime() + 3 * HOUR_MS),
      executor: fake.db,
    });
    expect(attach1.result).toBe("ATTACHED");

    const attach2 = await submitIdentityEvidence({
      userId: 1,
      leadId: o2.leadId,
      evidenceType: "email",
      value: "buyer@example.com", // normalization converges the same hash
      now: new Date(T0.getTime() + 4 * HOUR_MS),
      executor: fake.db,
    });
    expect(attach2.result).toBe("MERGED");
    expect(attach2.merge).toBeDefined();
    expect(attach2.merge!.canonicalLeadId).toBe(o1.leadId); // older identity is canonical
    expect(attach2.merge!.absorbedLeadId).toBe(o2.leadId);
    expect(attach2.leadId).toBe(o1.leadId);

    const absorbed = fake.tables.lead_identities.find((r) => r.leadId === o2.leadId)!;
    const canonical = fake.tables.lead_identities.find((r) => r.leadId === o1.leadId)!;
    expect(absorbed.identityStatus).toBe("merged");
    expect(absorbed.canonicalLeadId).toBe(o1.leadId);
    expect(absorbed.emailIdentityHash).toBeNull(); // key ownership moved
    expect(canonical.emailIdentityHash).not.toBeNull();
    expect(fake.tables.lead_identity_merges).toHaveLength(1);
    // History preserved: absorbed lead's provenance is untouched.
    const absorbedProvenance = fake.tables.lead_identity_provenance.filter((p) => p.leadId === o2.leadId);
    expect(absorbedProvenance.length).toBeGreaterThan(0);
  });

  it("case 9: verified shared phone hash may merge", async () => {
    const fake = createSeededDb();
    const a = await mintHandoff(fake, { actorReference: "actor-p1", externalObjectId: "c-p1", parentExternalObjectId: "t-p1" });
    const b = await mintHandoff(fake, { actorReference: "actor-p2", externalObjectId: "c-p2", parentExternalObjectId: "t-p2" });
    const oa = await consumeOpportunityHandoff({ envelope: a, userId: 1, now: new Date(T0.getTime() + 2 * HOUR_MS), executor: fake.db });
    const ob = await consumeOpportunityHandoff({ envelope: b, userId: 1, now: new Date(T0.getTime() + 2 * HOUR_MS), executor: fake.db });
    await submitIdentityEvidence({
      userId: 1, leadId: oa.leadId, evidenceType: "phone", value: "+1 (555) 123-4567",
      now: new Date(T0.getTime() + 3 * HOUR_MS), executor: fake.db,
    });
    const merged = await submitIdentityEvidence({
      userId: 1, leadId: ob.leadId, evidenceType: "phone", value: "+15551234567",
      now: new Date(T0.getTime() + 4 * HOUR_MS), executor: fake.db,
    });
    expect(merged.result).toBe("MERGED");
    expect(fake.tables.lead_identity_merges).toHaveLength(1);
    expect(fake.tables.lead_identities.filter((r) => r.identityStatus === "merged")).toHaveLength(1);
  });

  it("case 10: conflicting identifiers create a conflict — never a silent merge", async () => {
    const fake = createSeededDb();
    // Lead A in business 1 and lead C in business 3 (both tenant 1).
    const envA = await mintHandoff(fake, { actorReference: "actor-ca", externalObjectId: "c-ca", parentExternalObjectId: "t-ca" });
    const envC = await mintHandoff(fake, { actorReference: "actor-cc", businessId: 3, externalObjectId: "c-cc", parentExternalObjectId: "t-cc" });
    const oa = await consumeOpportunityHandoff({ envelope: envA, userId: 1, now: new Date(T0.getTime() + 2 * HOUR_MS), executor: fake.db });
    const oc = await consumeOpportunityHandoff({ envelope: envC, userId: 1, now: new Date(T0.getTime() + 2 * HOUR_MS), executor: fake.db });
    await submitIdentityEvidence({
      userId: 1, leadId: oa.leadId, evidenceType: "email", value: "shared@example.com",
      now: new Date(T0.getTime() + 3 * HOUR_MS), executor: fake.db,
    });
    const conflict = await submitIdentityEvidence({
      userId: 1, leadId: oc.leadId, evidenceType: "email", value: "shared@example.com",
      now: new Date(T0.getTime() + 4 * HOUR_MS), executor: fake.db,
    });
    expect(conflict.result).toBe("CONFLICT");
    expect(conflict.conflict).toBeDefined();
    expect(conflict.conflict!.withLeadId).toBe(oa.leadId);
    expect(fake.tables.lead_identity_merges).toHaveLength(0);
    const a = fake.tables.lead_identities.find((r) => r.leadId === oa.leadId)!;
    const c = fake.tables.lead_identities.find((r) => r.leadId === oc.leadId)!;
    expect(c.identityStatus).toBe("conflicting");
    expect(a.identityStatus).toBe("conflicting");
    // Immutable conflict provenance recorded.
    const conflicts = fake.tables.lead_identity_provenance.filter((p) => p.kind === "conflict");
    expect(conflicts).toHaveLength(1);
    const audits = fake.tables.audit_events.filter((e) => e.eventType === "lead_identity_conflict");
    expect(audits).toHaveLength(1);
  });
});

// ─── A9 11–16: adversarial security cases ───

describe("A9 cases 11–16 — adversarial security", () => {
  it("case 11: forged handoff (id from a different envelope) is rejected", async () => {
    const fake = createSeededDb();
    const genuine = await mintHandoff(fake);
    const crafted = buildCraftedEnvelope();
    // Swap in the genuine handoff id: id no longer matches content.
    const forged = { ...crafted, handoffId: genuine.handoffId };
    await expect(
      consumeOpportunityHandoff({ envelope: forged, userId: 1, now: new Date(T0.getTime() + 2 * HOUR_MS), executor: fake.db })
    ).rejects.toThrow(LeadIdentityTamperError);
    expect(fake.tables.lead_identities).toHaveLength(0);
  });

  it("case 11b: handoff without durable lineage (fabricated opportunity id) fails closed", async () => {
    const fake = createSeededDb();
    const crafted = buildCraftedEnvelope(); // valid, self-consistent, but never minted by R5-D
    await expect(
      consumeOpportunityHandoff({ envelope: crafted, userId: 1, now: new Date(T0.getTime() + 2 * HOUR_MS), executor: fake.db })
    ).rejects.toThrow(LeadIdentityInputError);
    expect(fake.tables.lead_identities).toHaveLength(0);
  });

  it("case 12: tampered actor reference is rejected", async () => {
    const fake = createSeededDb();
    const envelope = await mintHandoff(fake);
    const tampered = { ...envelope, actorKey: "f".repeat(64) };
    await expect(
      consumeOpportunityHandoff({ envelope: tampered, userId: 1, now: new Date(T0.getTime() + 2 * HOUR_MS), executor: fake.db })
    ).rejects.toThrow(LeadIdentityTamperError);
    // Schema-level malformed actor reference also rejected before any I/O.
    const malformed = buildCraftedEnvelope({ actorKey: "not-hex" });
    expect(() => validateHandoffEnvelope(malformed)).toThrow(LeadIdentityValidationError);
  });

  it("case 13: stale handoff (evidence fully out of window) is rejected", async () => {
    const fake = createSeededDb();
    const envelope = await mintHandoff(fake);
    const late = new Date(T0.getTime() + 40 * 24 * HOUR_MS); // beyond the 336h default
    await expect(
      consumeOpportunityHandoff({ envelope, userId: 1, now: late, executor: fake.db })
    ).rejects.toThrow(LeadIdentityInputError);
    expect(fake.tables.lead_identities).toHaveLength(0);
  });

  it("case 13b: lineage tampering (candidate no longer handed_off_to_r6) fails closed", async () => {
    const fake = createSeededDb();
    const envelope = await mintHandoff(fake);
    fake.tables.opportunity_candidates[0].opportunityStatus = "candidate";
    await expect(
      consumeOpportunityHandoff({ envelope, userId: 1, now: new Date(T0.getTime() + 2 * HOUR_MS), executor: fake.db })
    ).rejects.toMatchObject({ code: "STALE_HANDOFF" });
  });

  it("case 14: malformed identity evidence is rejected before hashing", async () => {
    const fake = createSeededDb();
    const envelope = await mintHandoff(fake);
    const outcome = await consumeOpportunityHandoff({
      envelope,
      userId: 1,
      now: new Date(T0.getTime() + 2 * HOUR_MS),
      executor: fake.db,
    });
    await expect(
      submitIdentityEvidence({ userId: 1, leadId: outcome.leadId, evidenceType: "email", value: "nope", executor: fake.db })
    ).rejects.toThrow(LeadIdentityInputError);
    await expect(
      submitIdentityEvidence({
        userId: 1, leadId: outcome.leadId, evidenceType: "email",
        value: "x".repeat(600), executor: fake.db,
      })
    ).rejects.toThrow(LeadIdentityInputError);
    expect(fake.tables.lead_identity_provenance.filter((p) => p.kind === "identity_evidence")).toHaveLength(0);
  });

  it("case 15: client cannot supply or force a leadId", async () => {
    const fake = createSeededDb();
    const envelope = await mintHandoff(fake);
    // An injected leadId field inside envelope content breaks the content hash
    // (strict schema rejects it first — unknown keys are refused).
    const injected = { ...envelope, leadId: "lid1:" + "e".repeat(64) };
    expect(() => validateHandoffEnvelope(injected)).toThrow(LeadIdentityValidationError);
    // The intake API has no leadId parameter at all — identity is server-derived.
    const outcome = await consumeOpportunityHandoff({
      envelope,
      userId: 1,
      now: new Date(T0.getTime() + 2 * HOUR_MS),
      executor: fake.db,
    });
    const derived = fake.tables.lead_identities[0];
    expect(derived.leadId).toBe(outcome.leadId);
    expect(outcome.leadId).not.toBe(injected.leadId);
  });

  it("case 16: client cannot force a merge — no merge-by-request authority exists", async () => {
    const service = await import("./lead-identity-service");
    expect((service as Record<string, unknown>).mergeLeadIdentities).toBeUndefined();
    expect((service as Record<string, unknown>).mergeIdentities).toBeUndefined();
    // Merge outcomes occur only through the evidence-driven deterministic path.
    const fake = createSeededDb();
    const envA = await mintHandoff(fake, { actorReference: "actor-ma", externalObjectId: "c-ma", parentExternalObjectId: "t-ma" });
    const envB = await mintHandoff(fake, { actorReference: "actor-mb", externalObjectId: "c-mb", parentExternalObjectId: "t-mb" });
    const oa = await consumeOpportunityHandoff({ envelope: envA, userId: 1, now: new Date(T0.getTime() + 2 * HOUR_MS), executor: fake.db });
    const ob = await consumeOpportunityHandoff({ envelope: envB, userId: 1, now: new Date(T0.getTime() + 2 * HOUR_MS), executor: fake.db });
    // Cross-business merge is impossible even via direct service calls.
    const envC = await mintHandoff(fake, { actorReference: "actor-mc", businessId: 3, externalObjectId: "c-mc", parentExternalObjectId: "t-mc" });
    const oc = await consumeOpportunityHandoff({ envelope: envC, userId: 1, now: new Date(T0.getTime() + 2 * HOUR_MS), executor: fake.db });
    await submitIdentityEvidence({ userId: 1, leadId: oa.leadId, evidenceType: "email", value: "m@example.com", executor: fake.db, now: new Date(T0.getTime() + 3 * HOUR_MS) });
    const blocked = await submitIdentityEvidence({ userId: 1, leadId: oc.leadId, evidenceType: "email", value: "m@example.com", executor: fake.db, now: new Date(T0.getTime() + 4 * HOUR_MS) });
    expect(blocked.result).toBe("CONFLICT");
    // And a terminal lead blocks automatic merges (owner ineligible → conflict).
    const envD = await mintHandoff(fake, { actorReference: "actor-md", externalObjectId: "c-md", parentExternalObjectId: "t-md" });
    const od = await consumeOpportunityHandoff({ envelope: envD, userId: 1, now: new Date(T0.getTime() + 2 * HOUR_MS), executor: fake.db });
    await submitIdentityEvidence({ userId: 1, leadId: od.leadId, evidenceType: "email", value: "suppressed@example.com", executor: fake.db, now: new Date(T0.getTime() + 3 * HOUR_MS) });
    await suppressLeadIdentity({ userId: 1, leadId: od.leadId, reason: "privacy_request", executor: fake.db, now: new Date(T0.getTime() + 5 * HOUR_MS) });
    const envE = await mintHandoff(fake, { actorReference: "actor-me", externalObjectId: "c-me", parentExternalObjectId: "t-me" });
    const oe = await consumeOpportunityHandoff({ envelope: envE, userId: 1, now: new Date(T0.getTime() + 2 * HOUR_MS), executor: fake.db });
    const terminalBlocked = await submitIdentityEvidence({ userId: 1, leadId: oe.leadId, evidenceType: "email", value: "suppressed@example.com", executor: fake.db, now: new Date(T0.getTime() + 6 * HOUR_MS) });
    expect(terminalBlocked.result).toBe("CONFLICT");
    expect(fake.tables.lead_identity_merges).toHaveLength(0);
    void ob;
  });
});

// ─── A9 17–19: privacy / security minimization ───

describe("A9 cases 17–19 — privacy minimization and leakage absence", () => {
  it("case 17: no sensitive-trait inference exists in stored identity state", async () => {
    const fake = createSeededDb();
    // R5-B content labels ride the interpretation upstream; a negative-sentiment
    // (contradiction-carrying) interpretation still produces a weak candidate
    // that is handoff-eligible.
    const envelope = await mintHandoff(fake, {
      sentiment: "negative",
      intent: "purchase_interest",
    });
    await consumeOpportunityHandoff({
      envelope,
      userId: 1,
      now: new Date(T0.getTime() + 2 * HOUR_MS),
      executor: fake.db,
    });
    // R6-A tables store hashes/references/closed labels only — R5-B content
    // labels (sentiment/risk flags) never enter identity storage.
    for (const table of R6_TABLES) {
      for (const row of fake.tables[table]) {
        const serialized = JSON.stringify(row);
        expect(serialized).not.toContain("sentiment");
        expect(serialized).not.toContain("riskFlags");
        expect(serialized).not.toContain("negative");
      }
    }
  });

  it("case 18: raw actor references and credentials never leak into identity storage or audit", async () => {
    const fake = createSeededDb();
    const envelope = await mintHandoff(fake, { actorReference: "raw-handle-xyz" });
    await consumeOpportunityHandoff({
      envelope,
      userId: 1,
      now: new Date(T0.getTime() + 2 * HOUR_MS),
      executor: fake.db,
    });
    const everywhere = [...R6_TABLES, "audit_events"];
    expect(scanRowsFor(fake.tables, everywhere, "raw-handle-xyz")).toEqual([]);
    for (const table of everywhere) {
      for (const row of fake.tables[table]) {
        expect(JSON.stringify(row)).not.toMatch(TOKEN_LIKE);
      }
    }
  });

  it("case 19: raw PII is minimized to hashes", async () => {
    const fake = createSeededDb();
    const envelope = await mintHandoff(fake);
    const outcome = await consumeOpportunityHandoff({
      envelope,
      userId: 1,
      now: new Date(T0.getTime() + 2 * HOUR_MS),
      executor: fake.db,
    });
    await submitIdentityEvidence({
      userId: 1,
      leadId: outcome.leadId,
      evidenceType: "email",
      value: "Real.Person@Example.COM",
      now: new Date(T0.getTime() + 3 * HOUR_MS),
      executor: fake.db,
    });
    await submitIdentityEvidence({
      userId: 1,
      leadId: outcome.leadId,
      evidenceType: "phone",
      value: "+1 (555) 999-8888",
      now: new Date(T0.getTime() + 4 * HOUR_MS),
      executor: fake.db,
    });
    const everywhere = [...R6_TABLES, "audit_events"];
    expect(scanRowsFor(fake.tables, everywhere, "real.person@example.com")).toEqual([]);
    expect(scanRowsFor(fake.tables, everywhere, "Real.Person@Example.COM")).toEqual([]);
    expect(scanRowsFor(fake.tables, everywhere, "5559998888")).toEqual([]);
    const lead = fake.tables.lead_identities[0];
    expect(lead.emailIdentityHash).toMatch(/^[a-f0-9]{64}$/);
    expect(lead.phoneIdentityHash).toMatch(/^[a-f0-9]{64}$/);
  });
});

// ─── A9 20–25: merge lineage, convergence, restart, anonymity, downstream surface ───

describe("A9 cases 20–25 — lineage, convergence, restart, anonymity, surface", () => {
  it("case 20: merge preserves historical provenance and designates one canonical lead", async () => {
    const fake = createSeededDb();
    const envA = await mintHandoff(fake, { actorReference: "actor-20a", externalObjectId: "c-20a", parentExternalObjectId: "t-20a" });
    const envB = await mintHandoff(fake, { actorReference: "actor-20b", externalObjectId: "c-20b", parentExternalObjectId: "t-20b" });
    const oa = await consumeOpportunityHandoff({ envelope: envA, userId: 1, now: new Date(T0.getTime() + 2 * HOUR_MS), executor: fake.db });
    const ob = await consumeOpportunityHandoff({ envelope: envB, userId: 1, now: new Date(T0.getTime() + 2 * HOUR_MS), executor: fake.db });
    await submitIdentityEvidence({ userId: 1, leadId: oa.leadId, evidenceType: "phone", value: "+15550001111", executor: fake.db, now: new Date(T0.getTime() + 3 * HOUR_MS) });
    const merged = await submitIdentityEvidence({ userId: 1, leadId: ob.leadId, evidenceType: "phone", value: "+15550001111", executor: fake.db, now: new Date(T0.getTime() + 4 * HOUR_MS) });
    expect(merged.result).toBe("MERGED");

    const merge = fake.tables.lead_identity_merges[0];
    expect(merge.canonicalLeadId).toBe(oa.leadId);
    expect(merge.absorbedLeadId).toBe(ob.leadId);
    expect(merge.linkingEvidenceType).toBe("phone_hash");
    expect(merge.linkingEvidenceHash).toMatch(/^[a-f0-9]{64}$/);

    // Absorbed lead's full history (handoff provenance) is preserved.
    const absorbedHistory = fake.tables.lead_identity_provenance.filter((p) => p.leadId === ob.leadId && p.kind === "opportunity_handoff");
    expect(absorbedHistory).toHaveLength(1);
    // Merge lineage recorded on both identities.
    const mergeLineage = fake.tables.lead_identity_provenance.filter((p) => p.kind === "merge");
    expect(mergeLineage.length).toBeGreaterThanOrEqual(2);
    // No destructive deletion: row count only grows.
    const absorbedRow = fake.tables.lead_identities.find((r) => r.leadId === ob.leadId)!;
    expect(absorbedRow.sourceHandoffId).toBe(envB.handoffId);
  });

  it("case 21: repeated merge request converges (idempotent replay)", async () => {
    const fake = createSeededDb();
    const envA = await mintHandoff(fake, { actorReference: "actor-21a", externalObjectId: "c-21a", parentExternalObjectId: "t-21a" });
    const envB = await mintHandoff(fake, { actorReference: "actor-21b", externalObjectId: "c-21b", parentExternalObjectId: "t-21b" });
    const oa = await consumeOpportunityHandoff({ envelope: envA, userId: 1, now: new Date(T0.getTime() + 2 * HOUR_MS), executor: fake.db });
    const ob = await consumeOpportunityHandoff({ envelope: envB, userId: 1, now: new Date(T0.getTime() + 2 * HOUR_MS), executor: fake.db });
    await submitIdentityEvidence({ userId: 1, leadId: oa.leadId, evidenceType: "email", value: "again@example.com", executor: fake.db, now: new Date(T0.getTime() + 3 * HOUR_MS) });
    const m1 = await submitIdentityEvidence({ userId: 1, leadId: ob.leadId, evidenceType: "email", value: "again@example.com", executor: fake.db, now: new Date(T0.getTime() + 4 * HOUR_MS) });
    expect(m1.result).toBe("MERGED");
    // The absorbed lead now chains to canonical; the same key resolves to replay.
    const m2 = await submitIdentityEvidence({ userId: 1, leadId: ob.leadId, evidenceType: "email", value: "again@example.com", executor: fake.db, now: new Date(T0.getTime() + 5 * HOUR_MS) });
    expect(m2.result).toBe("IDEMPOTENT_REPLAY");
    expect(m2.leadId).toBe(oa.leadId);
    expect(fake.tables.lead_identity_merges).toHaveLength(1);
    // Re-consuming the absorbed lead's handoff follows the chain to canonical.
    const replay = await consumeOpportunityHandoff({ envelope: envB, userId: 1, now: new Date(T0.getTime() + 6 * HOUR_MS), executor: fake.db });
    expect(replay.duplicateClassification).toBe("idempotent_replay");
    expect(replay.leadId).toBe(oa.leadId);
  });

  it("case 22: process restart after persistence returns the same lead", async () => {
    const fake = createSeededDb();
    const envelope = await mintHandoff(fake);
    const now = new Date(T0.getTime() + 2 * HOUR_MS);
    const first = await consumeOpportunityHandoff({ envelope, userId: 1, now, executor: fake.db });
    // Simulate a restart: state is durable-only; a fresh call with the same
    // envelope re-derives identity from rows and replays to the same lead.
    const afterRestart = await consumeOpportunityHandoff({ envelope, userId: 1, now, executor: fake.db });
    expect(afterRestart.leadId).toBe(first.leadId);
    expect(afterRestart.duplicateClassification).toBe("idempotent_replay");
    expect(fake.tables.lead_identities).toHaveLength(1);
  });

  it("case 23: anonymous/thread-only opportunity remains an anonymous lead", async () => {
    const fake = createSeededDb();
    const envelope = await mintHandoff(fake, {
      actorReference: null,
      externalObjectId: "c-anon",
      parentExternalObjectId: "t-anon",
    });
    const outcome = await consumeOpportunityHandoff({
      envelope,
      userId: 1,
      now: new Date(T0.getTime() + 2 * HOUR_MS),
      executor: fake.db,
    });
    expect(outcome.identityStatus).toBe("anonymous");
    expect(outcome.identityConfidence).toBe("unknown");
    expect(outcome.primaryIdentityType).toBe("anonymous_thread");
    const lead = fake.tables.lead_identities[0];
    expect(lead.externalActorReferenceHash).toBeNull();
  });

  it("case 24: later authoritative evidence resolves an anonymous lead safely", async () => {
    const fake = createSeededDb();
    const envelope = await mintHandoff(fake, {
      actorReference: null,
      externalObjectId: "c-anon2",
      parentExternalObjectId: "t-anon2",
    });
    const outcome = await consumeOpportunityHandoff({
      envelope,
      userId: 1,
      now: new Date(T0.getTime() + 2 * HOUR_MS),
      executor: fake.db,
    });
    const attached = await submitIdentityEvidence({
      userId: 1,
      leadId: outcome.leadId,
      evidenceType: "authenticated_customer_reference",
      value: "CUST-9001",
      now: new Date(T0.getTime() + 3 * HOUR_MS),
      executor: fake.db,
    });
    expect(attached.result).toBe("ATTACHED");
    expect(attached.leadId).toBe(outcome.leadId); // same lead — safe resolution, no new identity
    expect(attached.identityStatus).toBe("resolved");
    expect(attached.identityConfidence).toBe("high");
    expect(attached.primaryIdentityType).toBe("authenticated_customer_reference");
    expect(fake.tables.lead_identities).toHaveLength(1);
    // CRM reference (weaker tier) keeps authenticated tier as primary.
    const crm = await submitIdentityEvidence({
      userId: 1,
      leadId: outcome.leadId,
      evidenceType: "crm_external_reference",
      value: "CRM-9001",
      now: new Date(T0.getTime() + 4 * HOUR_MS),
      executor: fake.db,
    });
    expect(crm.result).toBe("ATTACHED");
    expect(crm.primaryIdentityType).toBe("authenticated_customer_reference");
    expect(crm.identityStatus).toBe("resolved");
  });

  it("case 25: downstream read surface exposes only permitted identity fields", async () => {
    const fake = createSeededDb();
    const envelope = await mintHandoff(fake);
    const outcome = await consumeOpportunityHandoff({
      envelope,
      userId: 1,
      now: new Date(T0.getTime() + 2 * HOUR_MS),
      executor: fake.db,
    });
    await submitIdentityEvidence({
      userId: 1,
      leadId: outcome.leadId,
      evidenceType: "email",
      value: "safe@example.com",
      now: new Date(T0.getTime() + 3 * HOUR_MS),
      executor: fake.db,
    });
    const projection = await getLeadIdentity(1, outcome.leadId, fake.db);
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
        "provenance",
        "provider",
        "sourceHandoffId",
        "sourceOpportunityId",
      ].sort()
    );
    expect(projection.leadIdentityVersion).toBe("lead-identity/v1");
    expect(projection.provenance.length).toBeGreaterThanOrEqual(2);
    for (const ref of projection.provenance) {
      expect(Object.keys(ref).sort()).toEqual(["evidenceType", "handoffId", "kind", "occurredAt", "opportunityId"].sort());
    }
    // No score/qualification/pipeline fields exist on the surface.
    expect(JSON.stringify(projection)).not.toContain("score");
    expect(JSON.stringify(projection)).not.toContain("qualified");

    const list = await listLeadIdentities(1, {}, 50, fake.db);
    expect(list).toHaveLength(1);
    expect(list[0].leadId).toBe(outcome.leadId);
  });
});

// ─── Cross-tenant adversarial cases (mandatory security standard) ───

describe("Cross-tenant adversarial cases", () => {
  it("cross-tenant handoff consumption fails closed (OWNERSHIP_MISMATCH)", async () => {
    const fake = createSeededDb();
    const tenant2 = await mintHandoff(
      fake,
      { actorReference: "actor-ct", userId: 2, businessId: 2, sourceCampaignId: 2, interpretationId: "int-ct", signalId: "sig-ct", externalObjectId: "c-ct", parentExternalObjectId: "t-ct" },
      { userId: 2 }
    );
    // Tenant 1 attempts to consume tenant 2's durable envelope.
    await expect(
      consumeOpportunityHandoff({ envelope: tenant2, userId: 1, now: new Date(T0.getTime() + 2 * HOUR_MS), executor: fake.db })
    ).rejects.toThrow(LeadIdentityOwnershipError);
    expect(fake.tables.lead_identities).toHaveLength(0);
  });

  it("cross-business handoff fails closed even within one tenant", async () => {
    const fake = createSeededDb();
    const crafted = buildCraftedEnvelope({ userId: 1, businessId: 2, campaignId: 1 });
    fake.tables.opportunity_candidates.push({
      id: 900,
      userId: 1,
      opportunityId: crafted.opportunityId,
      opportunityStatus: "handed_off_to_r6",
    });
    await expect(
      consumeOpportunityHandoff({ envelope: crafted, userId: 1, now: new Date(T0.getTime() + 2 * HOUR_MS), executor: fake.db })
    ).rejects.toThrow(LeadIdentityOwnershipError);
    expect(fake.tables.lead_identities).toHaveLength(0);
  });

  it("forged campaign lineage fails closed", async () => {
    const fake = createSeededDb();
    const crafted = buildCraftedEnvelope({ userId: 1, businessId: 1, campaignId: 99 });
    fake.tables.opportunity_candidates.push({
      id: 901,
      userId: 1,
      opportunityId: crafted.opportunityId,
      opportunityStatus: "handed_off_to_r6",
    });
    await expect(
      consumeOpportunityHandoff({ envelope: crafted, userId: 1, now: new Date(T0.getTime() + 2 * HOUR_MS), executor: fake.db })
    ).rejects.toThrow(LeadIdentityOwnershipError);
  });

  it("governance: suppression and archival are terminal and audited; terminal leads reject enrichment", async () => {
    const fake = createSeededDb();
    const envelope = await mintHandoff(fake);
    const outcome = await consumeOpportunityHandoff({
      envelope,
      userId: 1,
      now: new Date(T0.getTime() + 2 * HOUR_MS),
      executor: fake.db,
    });
    const suppressed = await suppressLeadIdentity({
      userId: 1,
      leadId: outcome.leadId,
      reason: "privacy_request",
      now: new Date(T0.getTime() + 3 * HOUR_MS),
      executor: fake.db,
    });
    expect(suppressed.identityStatus).toBe("suppressed");
    await expect(
      submitIdentityEvidence({
        userId: 1,
        leadId: outcome.leadId,
        evidenceType: "email",
        value: "blocked@example.com",
        executor: fake.db,
      })
    ).rejects.toThrow(LeadIdentityStateConflictError);
    // Suppressed is terminal: a further governance transition fails closed.
    await expect(
      archiveLeadIdentity({
        userId: 1,
        leadId: outcome.leadId,
        now: new Date(T0.getTime() + 4 * HOUR_MS),
        executor: fake.db,
      })
    ).rejects.toThrow(LeadIdentityStateConflictError);

    // A separate active identity can be archived directly.
    const envelope2 = await mintHandoff(fake, {
      actorReference: "actor-gov2",
      externalObjectId: "c-gov2",
      parentExternalObjectId: "t-gov2",
    });
    const outcome2 = await consumeOpportunityHandoff({
      envelope: envelope2,
      userId: 1,
      now: new Date(T0.getTime() + 2 * HOUR_MS),
      executor: fake.db,
    });
    const archived = await archiveLeadIdentity({
      userId: 1,
      leadId: outcome2.leadId,
      now: new Date(T0.getTime() + 4 * HOUR_MS),
      executor: fake.db,
    });
    expect(archived.identityStatus).toBe("archived");
    const audits = fake.tables.audit_events.filter((e) =>
      ["lead_identity_suppressed", "lead_identity_archived"].includes(e.eventType as string)
    );
    expect(audits).toHaveLength(2);
    // Audit metadata carries ids/closed labels only.
    for (const audit of audits) {
      expect(JSON.stringify(audit.metadata)).not.toMatch(TOKEN_LIKE);
    }
  });
});
