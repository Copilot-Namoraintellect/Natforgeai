/**
 * WBS-R6-E — Conversion Tracking & Outcome Authority Acceptance Suite.
 *
 * Thirty adversarial acceptance cases over the connected harness:
 *
 *   ingest (verified / reported / unverified) → deterministic identity
 *   → insert-first exact-once persistence → server-derived trust
 *   → reversal lifecycle + guarded outcome transition → R7 projection
 *
 * The harness runs the REAL conversion router + REAL store/service/projection
 * against a pure in-memory fake database that replicates the durable unique
 * indexes (conversion_events, conversion_lifecycle_events, audit_events). No
 * real database, no provider — by construction.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { getTableName } from "drizzle-orm";

vi.mock("./queries/connection", () => ({
  getDb: vi.fn(),
}));

import { getDb } from "./queries/connection";
import { conversionRouter } from "./conversion-router";
import { buildCtx } from "./r5-test-support";
import { PROJECTION_FIELD_KEYS } from "./lib/conversion/conversion-projection";

// ─── In-memory fake database (replicates the DB unique indexes) ───

function evalCond(cond: any, row: any): boolean {
  const chunks: any[] = cond?.queryChunks ?? [];
  if (chunks.length === 0) return true;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (chunk && Array.isArray(chunk.queryChunks)) {
      if (!evalCond(chunk, row)) return false;
      continue;
    }
    if (chunk && typeof chunk === "object" && typeof chunk.name === "string") {
      const op = chunks[i + 1];
      const param = chunks[i + 2];
      const value = param && typeof param === "object" && "value" in param ? param.value : param;
      const rowValue = row[chunk.name];
      const opName =
        typeof op?.operator === "string" ? op.operator : typeof op === "string" ? op : "=";
      if (opName.includes(">") && !opName.includes("=")) {
        if (!(rowValue > value)) return false;
      } else if (opName.includes("<") && !opName.includes("=")) {
        if (!(rowValue < value)) return false;
      } else if (Array.isArray(value)) {
        if (!value.includes(rowValue)) return false;
      } else if (rowValue !== value) {
        return false;
      }
      i += 2;
    }
  }
  return true;
}

/** Durable unique indexes the fake enforces (the exact-once anchors). */
const UNIQUE_CHECKS: Record<string, string[][]> = {
  conversion_events: [["conversionId"], ["userId", "sourceSystem", "externalConversionId"]],
  conversion_lifecycle_events: [["lifecycleEventId"], ["conversionId", "externalLifecycleId"]],
  audit_events: [["eventFingerprint"]],
};

function makeFakeDb(seed: Record<string, Record<string, unknown>[]> = {}) {
  const tables: Record<string, Record<string, unknown>[]> = {
    businesses: [
      { id: 10, userId: 1 },
      { id: 20, userId: 2 },
    ],
    leads: [
      { id: 100, userId: 1, businessId: 10, name: "Jane Doe", status: "new" },
      { id: 101, userId: 1, businessId: 99, name: "Cross Business", status: "new" },
      { id: 102, userId: 2, businessId: 20, name: "Other Tenant", status: "new" },
    ],
    campaigns: [
      { id: 500, userId: 1, businessId: 10 },
      { id: 501, userId: 2, businessId: 20 },
    ],
    opportunity_candidates: [
      { id: 1, opportunityId: "opp1:aaa", userId: 1, businessId: 10 },
      { id: 2, opportunityId: "opp1:bbb", userId: 2, businessId: 20 },
    ],
    engagement_receipts: [{ id: 1, engagementReceiptId: "erec_abc", userId: 1, businessId: 10 }],
    social_signals: [{ id: 1, signalKey: "sigv1:xyz", userId: 1 }],
    lead_scores: [],
    outreach_recommendations: [],
    audit_events: [],
    conversion_events: [],
    conversion_lifecycle_events: [],
    ...seed,
  };
  let autoId = 9000;
  const fake: any = {};

  function selectChain(table: string) {
    const state: { cond?: any; orderDesc?: boolean; limit?: number } = {};
    const c: any = {};
    c.from = () => c;
    c.where = (w: any) => {
      state.cond = w;
      return c;
    };
    // Only orderBy(desc(id)) is used by the conversion store.
    c.orderBy = (_col: any) => {
      state.orderDesc = true;
      return c;
    };
    c.limit = (n: number) => {
      state.limit = n;
      return c;
    };
    c.then = (resolve: (rows: unknown[]) => unknown) => {
      let out = (tables[table] ?? []).slice();
      if (state.cond) out = out.filter((r) => evalCond(state.cond, r));
      if (state.orderDesc) out = out.sort((a, b) => Number(b.id) - Number(a.id));
      if (state.limit != null) out = out.slice(0, state.limit);
      return Promise.resolve(resolve(out));
    };
    return c;
  }

  fake.select = () => ({
    from: (t: unknown) => selectChain(getTableName(t as never)),
  });
  fake.insert = (t: unknown) => ({
    values: async (values: Record<string, unknown>) => {
      const name = getTableName(t as never);
      const row: Record<string, unknown> = { id: ++autoId, ...values };
      for (const keys of UNIQUE_CHECKS[name] ?? []) {
        if (keys.some((k) => row[k] === undefined || row[k] === null)) continue;
        const conflict = (tables[name] ?? []).some((r) => keys.every((k) => r[k] === row[k]));
        if (conflict) {
          const err = new Error(`Duplicate entry '${keys.join("-")}'`) as Error & { code: string };
          err.code = "ER_DUP_ENTRY";
          throw err;
        }
      }
      (tables[name] ?? (tables[name] = [])).push(row);
      return [{ insertId: row.id, affectedRows: 1 }];
    },
  });
  fake.update = (t: unknown) => {
    const name = getTableName(t as never);
    return {
      set: (setValues: Record<string, unknown>) => ({
        where: (cond: any) => {
          let affected = 0;
          for (const row of tables[name] ?? []) {
            if (evalCond(cond, row)) {
              Object.assign(row, setValues);
              affected += 1;
            }
          }
          const header = { affectedRows: affected } as { affectedRows: number; 0?: unknown };
          header[0] = header;
          return Promise.resolve(header);
        },
      }),
    };
  };
  fake._tables = tables;
  return fake;
}

let fakeDb: ReturnType<typeof makeFakeDb>;

const USER1 = { id: 1, role: "user" };
const USER2 = { id: 2, role: "user" };

// A stable past timestamp so the future-occurring boundary never trips and
// replayed inputs reproduce identical evidence material.
const PAST_ISO = new Date(Date.now() - 60 * 60 * 1000).toISOString();

function ingestInput(overrides: Record<string, unknown> = {}) {
  return {
    businessId: 10,
    sourceSystem: "stripe",
    externalConversionId: "evt_default",
    conversionType: "purchase",
    occurredAt: PAST_ISO,
    observedAt: PAST_ISO,
    ...overrides,
  };
}

function conversionRows() {
  return fakeDb._tables.conversion_events as Record<string, unknown>[];
}

beforeEach(() => {
  fakeDb = makeFakeDb();
  vi.mocked(getDb).mockReturnValue(fakeDb as never);
});

describe("R6-E conversion acceptance", () => {
  it("1. verified purchase persists (stripe)", async () => {
    const caller = conversionRouter.createCaller(buildCtx(USER1));
    const res = await caller.ingest(ingestInput({ amount: 5000, currency: "USD" }) as never);
    expect(res.duplicateClassification).toBe("none");
    expect(res.conversion.sourceTrustClass).toBe("VERIFIED_PAYMENT");
    expect(res.conversion.outcomeStatus).toBe("CONFIRMED");
    expect(res.conversion.amount).toBe(5000);
    expect(conversionRows()).toHaveLength(1);
    // Audit emitted for the durable effect.
    const audit = fakeDb._tables.audit_events as any[];
    expect(audit.filter((e) => e.eventType === "conversion_recorded")).toHaveLength(1);
  });

  it("2. duplicate event converges to idempotent replay", async () => {
    const caller = conversionRouter.createCaller(buildCtx(USER1));
    const input = ingestInput({ externalConversionId: "evt_dup", amount: 100, currency: "USD" });
    await caller.ingest(input as never);
    const res2 = await caller.ingest(input as never);
    expect(res2.duplicateClassification).toBe("idempotent_replay");
    expect(conversionRows()).toHaveLength(1);
    // The audit ledger also converges: one deterministic audit row per conversion.
    const audit = fakeDb._tables.audit_events as any[];
    expect(audit.filter((e) => e.eventType === "conversion_recorded")).toHaveLength(1);
  });

  it("3. concurrent duplicate converges to one row", async () => {
    const caller = conversionRouter.createCaller(buildCtx(USER1));
    const input = ingestInput({ externalConversionId: "evt_conc", amount: 100, currency: "USD" });
    const [a, b] = await Promise.all([
      caller.ingest(input as never),
      caller.ingest(input as never),
    ]);
    expect(a.conversion.conversionId).toBe(b.conversion.conversionId);
    expect(conversionRows()).toHaveLength(1);
  });

  it("4. restart (fresh caller) returns the existing conversion", async () => {
    const first = await conversionRouter.createCaller(buildCtx(USER1)).ingest(
      ingestInput({ externalConversionId: "evt_restart" }) as never
    );
    const second = await conversionRouter
      .createCaller(buildCtx(USER1))
      .ingest(ingestInput({ externalConversionId: "evt_restart" }) as never);
    expect(second.duplicateClassification).toBe("idempotent_replay");
    expect(second.conversion.conversionId).toBe(first.conversion.conversionId);
  });

  it("5. trusted CRM outcome accepted (salesforce consultation)", async () => {
    const caller = conversionRouter.createCaller(buildCtx(USER1));
    const res = await caller.ingest(
      ingestInput({ sourceSystem: "salesforce", externalConversionId: "sf_1", conversionType: "consultation" }) as never
    );
    expect(res.conversion.sourceTrustClass).toBe("VERIFIED_CRM");
    expect(res.conversion.outcomeStatus).toBe("CONFIRMED");
  });

  it("6. trusted payment value is verified in the projection (paypal subscription)", async () => {
    const caller = conversionRouter.createCaller(buildCtx(USER1));
    const res = await caller.ingest(
      ingestInput({
        sourceSystem: "paypal",
        externalConversionId: "pp_1",
        conversionType: "subscription",
        amount: 9900,
        currency: "USD",
      }) as never
    );
    const { projection } = await caller.get({ conversionId: res.conversion.conversionId } as never);
    expect(projection.verifiedAmount).toBe(9900);
    expect(projection.verifiedCurrency).toBe("USD");
    expect(projection.reportedAmount).toBeNull();
    expect(projection.currencyExponent).toBe(2);
  });

  it("7. user-reported outcome is non-authoritative", async () => {
    const caller = conversionRouter.createCaller(buildCtx(USER1));
    const res = await caller.ingest(
      ingestInput({ sourceSystem: "user_report", externalConversionId: "ur_1", amount: 1000, currency: "USD" }) as never
    );
    const { projection } = await caller.get({ conversionId: res.conversion.conversionId } as never);
    expect(projection.sourceTrustClass).toBe("USER_REPORTED");
    expect(projection.verifiedAmount).toBeNull();
    expect(projection.verifiedCurrency).toBeNull();
    expect(projection.reportedAmount).toBe(1000);
    expect(projection.reportedCurrency).toBe("USD");
  });

  it("8. fabricated revenue (client trust/verified fields) rejected, no row", async () => {
    const caller = conversionRouter.createCaller(buildCtx(USER1));
    for (const forged of [
      { trustClass: "VERIFIED_PAYMENT" },
      { sourceTrustClass: "VERIFIED_PAYMENT" },
      { verifiedAmount: 5000 },
      { outcomeStatus: "CONFIRMED" },
    ]) {
      await expect(
        caller.ingest({ ...ingestInput(), ...forged } as never)
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    expect(conversionRows()).toHaveLength(0);
  });

  it("9. invalid amount rejected (out of bounds and non-integer), no row", async () => {
    const caller = conversionRouter.createCaller(buildCtx(USER1));
    await expect(
      caller.ingest({ ...ingestInput(), amount: 1e16, currency: "USD" } as never)
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.ingest({ ...ingestInput(), amount: 10.5, currency: "USD" } as never)
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    // Negative on a non-reversal type is also rejected.
    await expect(
      caller.ingest({ ...ingestInput(), amount: -5, currency: "USD" } as never)
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(conversionRows()).toHaveLength(0);
  });

  it("10. invalid currency rejected (unknown code and lowercase)", async () => {
    const caller = conversionRouter.createCaller(buildCtx(USER1));
    await expect(
      caller.ingest({ ...ingestInput(), amount: 100, currency: "XXX" } as never)
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.ingest({ ...ingestInput(), amount: 100, currency: "usd" } as never)
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(conversionRows()).toHaveLength(0);
  });

  it("11. cross-business lead linkage rejected", async () => {
    const caller = conversionRouter.createCaller(buildCtx(USER1));
    await expect(caller.ingest({ ...ingestInput(), leadId: 101 } as never)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(conversionRows()).toHaveLength(0);
  });

  it("12. forged (cross-tenant) lead rejected", async () => {
    const caller = conversionRouter.createCaller(buildCtx(USER1));
    await expect(caller.ingest({ ...ingestInput(), leadId: 102 } as never)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(conversionRows()).toHaveLength(0);
  });

  it("13. authoritative lead linkage succeeds", async () => {
    const caller = conversionRouter.createCaller(buildCtx(USER1));
    const res = await caller.ingest({ ...ingestInput(), leadId: 100 } as never);
    expect(res.conversion.leadId).toBe(100);
    const { projection } = await caller.get({ conversionId: res.conversion.conversionId } as never);
    expect(projection.leadId).toBe(100);
  });

  it("14. fuzzy/name-only matching never links a lead", async () => {
    const caller = conversionRouter.createCaller(buildCtx(USER1));
    const res = await caller.ingest({
      ...ingestInput(),
      evidenceReference: "inbound from Jane Doe",
    } as never);
    // No leadId supplied; nothing invents a linkage from a name.
    expect(res.conversion.leadId).toBeNull();
  });

  it("15. unlinked conversion remains valid", async () => {
    const caller = conversionRouter.createCaller(buildCtx(USER1));
    const res = await caller.ingest(ingestInput() as never);
    expect(res.conversion.leadId).toBeNull();
    const { projection } = await caller.get({ conversionId: res.conversion.conversionId } as never);
    expect(projection.leadId).toBeNull();
  });

  it("16. campaign provenance preserved and projected", async () => {
    const caller = conversionRouter.createCaller(buildCtx(USER1));
    const res = await caller.ingest({ ...ingestInput(), sourceCampaignId: 500 } as never);
    expect(res.conversion.sourceCampaignId).toBe(500);
    const { projection } = await caller.get({ conversionId: res.conversion.conversionId } as never);
    expect(projection.provenance.sourceCampaignId).toBe(500);
  });

  it("17. provenance does not become causation (exact key set, no causal fields)", async () => {
    const caller = conversionRouter.createCaller(buildCtx(USER1));
    const res = await caller.ingest({ ...ingestInput(), sourceCampaignId: 500 } as never);
    const { projection } = await caller.get({ conversionId: res.conversion.conversionId } as never);
    expect(projection.causationClaimed).toBe(false);
    expect(projection.causationDisclaimer).toMatch(/does not assert/);
    expect(Object.keys(projection).sort()).toEqual([...PROJECTION_FIELD_KEYS].sort());
    const serialized = JSON.stringify(projection);
    expect(serialized).not.toMatch(/attributedCampaignId|attributionScore|causalStrength/i);
  });

  it("18. refund references original and flips its outcome", async () => {
    const caller = conversionRouter.createCaller(buildCtx(USER1));
    const original = await caller.ingest(
      ingestInput({ externalConversionId: "evt_orig", amount: 5000, currency: "USD" }) as never
    );
    const refund = await caller.ingest(
      ingestInput({
        externalConversionId: "evt_refund_1",
        conversionType: "refund",
        amount: -5000,
        currency: "USD",
        reversesConversionId: original.conversion.conversionId,
      }) as never
    );
    expect(refund.conversion.reversesConversionId).toBe(original.conversion.conversionId);

    const lifecycle = await caller.listLifecycle({ conversionId: original.conversion.conversionId } as never);
    expect(
      lifecycle.some((l) => l.lifecycleType === "refund" && l.outcomeStatus === "REFUNDED")
    ).toBe(true);
    const after = await caller.get({ conversionId: original.conversion.conversionId } as never);
    expect(after.conversion.outcomeStatus).toBe("REFUNDED");
  });

  it("19. duplicate refund converges to a single lifecycle fact", async () => {
    const caller = conversionRouter.createCaller(buildCtx(USER1));
    const original = await caller.ingest(
      ingestInput({ externalConversionId: "evt_orig2", amount: 5000, currency: "USD" }) as never
    );
    const refundInput = ingestInput({
      externalConversionId: "evt_refund_2",
      conversionType: "refund",
      amount: -5000,
      currency: "USD",
      reversesConversionId: original.conversion.conversionId,
    });
    await caller.ingest(refundInput as never);
    const replay = await caller.ingest(refundInput as never);
    expect(replay.duplicateClassification).toBe("idempotent_replay");
    const lifecycle = await caller.listLifecycle({ conversionId: original.conversion.conversionId } as never);
    expect(lifecycle.filter((l) => l.lifecycleType === "refund")).toHaveLength(1);
  });

  it("20. reversal preserves the original evidence material", async () => {
    const caller = conversionRouter.createCaller(buildCtx(USER1));
    const original = await caller.ingest(
      ingestInput({ externalConversionId: "evt_orig3", amount: 5000, currency: "USD" }) as never
    );
    const before = await caller.get({ conversionId: original.conversion.conversionId } as never);
    await caller.ingest(
      ingestInput({
        externalConversionId: "evt_refund_3",
        conversionType: "refund",
        amount: -5000,
        currency: "USD",
        reversesConversionId: original.conversion.conversionId,
      }) as never
    );
    const after = await caller.get({ conversionId: original.conversion.conversionId } as never);
    expect(after.conversion.conversionId).toBe(before.conversion.conversionId);
    expect(after.conversion.amount).toBe(before.conversion.amount);
    expect(after.conversion.evidenceHash).toBe(before.conversion.evidenceHash);
    expect(after.conversion.occurredAt).toBe(before.conversion.occurredAt);
  });

  it("21. cross-tenant collision is impossible and reads are tenant-scoped", async () => {
    const res1 = await conversionRouter
      .createCaller(buildCtx(USER1))
      .ingest(ingestInput({ externalConversionId: "evt_shared" }) as never);
    const res2 = await conversionRouter
      .createCaller(buildCtx(USER2))
      .ingest({ ...ingestInput({ externalConversionId: "evt_shared" }), businessId: 20 } as never);
    expect(res2.conversion.conversionId).not.toBe(res1.conversion.conversionId);
    expect(conversionRows()).toHaveLength(2);
    // Each tenant can only read its own row.
    await expect(
      conversionRouter.createCaller(buildCtx(USER1)).get({ conversionId: res2.conversion.conversionId } as never)
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("22. source-system collision yields distinct conversions for one tenant", async () => {
    const caller = conversionRouter.createCaller(buildCtx(USER1));
    const a = await caller.ingest(
      ingestInput({ sourceSystem: "stripe", externalConversionId: "evt_multi" }) as never
    );
    const b = await caller.ingest(
      ingestInput({ sourceSystem: "paypal", externalConversionId: "evt_multi" }) as never
    );
    expect(a.conversion.conversionId).not.toBe(b.conversion.conversionId);
    expect(conversionRows()).toHaveLength(2);
  });

  it("23. payment-credential leak rejected with no row", async () => {
    const caller = conversionRouter.createCaller(buildCtx(USER1));
    await expect(
      caller.ingest({ ...ingestInput(), evidenceReference: "card 4111111111111111" } as never)
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("CONVERSION_PAYMENT_CREDENTIAL_REJECTED"),
    });
    // A bare 16-digit external id is also card-shaped and rejected.
    await expect(
      caller.ingest({ ...ingestInput(), externalConversionId: "4111111111111111" } as never)
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(conversionRows()).toHaveLength(0);
  });

  it("24. PII minimized (no name/email/phone on row or projection)", async () => {
    const caller = conversionRouter.createCaller(buildCtx(USER1));
    const res = await caller.ingest({ ...ingestInput(), leadId: 100 } as never);
    const rowKeys = Object.keys(res.conversion);
    for (const pii of ["name", "email", "phone", "company"]) {
      expect(rowKeys).not.toContain(pii);
    }
    const { projection } = await caller.get({ conversionId: res.conversion.conversionId } as never);
    for (const pii of ["name", "email", "phone", "company"]) {
      expect(Object.keys(projection)).not.toContain(pii);
    }
    expect(JSON.stringify(fakeDb._tables.conversion_events)).not.toMatch(/Jane Doe/);
  });

  it("25. R7 projection field allowlist is exact", async () => {
    const caller = conversionRouter.createCaller(buildCtx(USER1));
    await caller.ingest(ingestInput({ externalConversionId: "evt_keys", amount: 100, currency: "JPY" }) as never);
    const projections = await caller.r7Projections({});
    expect(projections).toHaveLength(1);
    expect(Object.keys(projections[0]).sort()).toEqual([...PROJECTION_FIELD_KEYS].sort());
    expect(projections[0].currencyExponent).toBe(0); // JPY zero-decimal
  });

  it("26. no qualification/nurture/outreach side effects", async () => {
    const caller = conversionRouter.createCaller(buildCtx(USER1));
    const leadCountBefore = (fakeDb._tables.leads as unknown[]).length;
    const lead100Before = { ...(fakeDb._tables.leads as any[]).find((l) => l.id === 100) };
    await caller.ingest({ ...ingestInput(), leadId: 100 } as never);
    // Leads table unchanged: no new rows, lead 100 untouched.
    expect(fakeDb._tables.leads as unknown[]).toHaveLength(leadCountBefore);
    const lead100After = (fakeDb._tables.leads as any[]).find((l) => l.id === 100);
    expect(lead100After.status).toBe(lead100Before.status);
    expect(lead100After.name).toBe(lead100Before.name);
    // No scores or outreach recommendations created.
    expect(fakeDb._tables.lead_scores as unknown[]).toHaveLength(0);
    expect(fakeDb._tables.outreach_recommendations as unknown[]).toHaveLength(0);
  });

  it("27. unknown/extra client fields (attribution or authority) rejected, no row", async () => {
    const caller = conversionRouter.createCaller(buildCtx(USER1));
    for (const forged of [
      { attributedCampaignId: 500 },
      { causalScore: 0.9 },
      { attributionScore: 0.9 },
      { trustClass: "VERIFIED_PAYMENT" },
    ]) {
      await expect(
        caller.ingest({ ...ingestInput(), ...forged } as never)
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    expect(conversionRows()).toHaveLength(0);
  });

  it("28. agent cannot self-mark an unverified outcome authoritative", async () => {
    const caller = conversionRouter.createCaller(buildCtx(USER1));
    await expect(
      caller.ingest({
        ...ingestInput({ sourceSystem: "unverified_webhook", externalConversionId: "uw_1" }),
        outcomeStatus: "CONFIRMED",
      } as never)
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(conversionRows()).toHaveLength(0);
    // A clean unverified_webhook ingest (no smuggled status) lands PENDING.
    const res = await caller.ingest(
      ingestInput({ sourceSystem: "unverified_webhook", externalConversionId: "uw_2" }) as never
    );
    expect(res.conversion.outcomeStatus).toBe("PENDING");
    expect(res.conversion.sourceTrustClass).toBe("UNVERIFIED_EXTERNAL");
  });

  it("29. cross-tenant provenance reference rejected", async () => {
    const caller = conversionRouter.createCaller(buildCtx(USER1));
    await expect(
      caller.ingest({ ...ingestInput(), sourceOpportunityId: "opp1:bbb" } as never)
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(conversionRows()).toHaveLength(0);
  });

  it("30. client-supplied leadIdentityVersion is opaque and never affects authority", async () => {
    const caller = conversionRouter.createCaller(buildCtx(USER1));
    const res = await caller.ingest(
      ingestInput({
        sourceSystem: "user_report",
        externalConversionId: "ur_leadver",
        amount: 2000,
        currency: "USD",
        leadId: 100,
        leadIdentityVersion: "leadver:v1:xyz",
      }) as never
    );
    // Stored verbatim on the durable row...
    expect(res.conversion.leadIdentityVersion).toBe("leadver:v1:xyz");
    // ...but trust/authority are unchanged: user_report stays non-authoritative.
    expect(res.conversion.sourceTrustClass).toBe("USER_REPORTED");
    const { projection } = await caller.get({ conversionId: res.conversion.conversionId } as never);
    expect(projection.sourceTrustClass).toBe("USER_REPORTED");
    expect(projection.verifiedAmount).toBeNull();
    expect(projection.reportedAmount).toBe(2000);
    // The projection exposes the server-verified linkage as opaque references
    // only — identity/version carry no trust or authority of their own.
    expect(projection.leadId).toBe(100);
    expect(projection.leadIdentityVersion).toBe("leadver:v1:xyz");
  });
});
