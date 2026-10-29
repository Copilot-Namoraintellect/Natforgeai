/**
 * R7-X X3 — Canonical Outcome → Attribution Binding acceptance.
 *
 * Proves R7-B's production outcome port binds the ACTUAL integrated R7-A
 * authority (X3): reads through A's store, A's immutable-core integrity
 * assertion, and A's canonical projection builder — then re-validates against
 * B's frozen consumption contract. Verified behaviours:
 *
 *  - R7-A business outcome (exact tenant + business) → frozen projection →
 *    validated consumption by R7-B;
 *  - real lifecycle facts flow, newest-first (A's canonical ordering);
 *  - VERIFIED / PROVISIONAL status preserved verbatim;
 *  - reversed outcomes expose reversal history to downstream interpretation;
 *  - hash-drifted (tampered) outcome rows fail closed before B consumes them;
 *  - monetary amount remains a read-only reference — attribution evaluation
 *    never mutates the R7-A row and writes only attribution tables;
 *  - association remains distinct from causation (disclaimers verbatim);
 *  - missing/partial canonical tables degrade fail-closed to "no outcome".
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./queries/connection", () => ({
  getDb: vi.fn(() => {
    throw new Error("getDb must not fall back to a real connection in R7-X binding tests");
  }),
}));

import { getDb } from "./queries/connection";
import { createFakeDb } from "./r5-test-support";
import { deriveOutcomeEvidenceHash } from "./lib/outcome/outcome-identity";
import { OUTCOME_PROJECTION_FIELD_KEYS } from "./lib/outcome/outcome-projection";

function hashFor(row: Record<string, unknown>): string {
  return deriveOutcomeEvidenceHash({
    userId: row.userId as number,
    businessId: row.businessId as number,
    leadId: (row.leadId as number | null) ?? null,
    leadIdentityVersion: (row.leadIdentityVersion as string | null) ?? null,
    conversionId: row.conversionId as string,
    outcomeType: row.outcomeType as string,
    valueType: row.valueType as string,
    amountMinor: (row.amountMinor as number | null) ?? null,
    currency: (row.currency as string | null) ?? null,
    quantity: (row.quantity as number | null) ?? null,
    metricUnit: (row.metricUnit as string | null) ?? null,
    evidenceSource: row.evidenceSource as string,
    evidenceAuthority: row.evidenceAuthority as string,
    evidenceIdentity: row.evidenceIdentity as string,
    occurredAt: row.occurredAt as string,
    recordedAt: row.recordedAt as string,
    reversesOutcomeId: (row.reversesOutcomeId as string | null) ?? null,
    renewsOutcomeId: (row.renewsOutcomeId as string | null) ?? null,
    supersedesOutcomeId: (row.supersedesOutcomeId as string | null) ?? null,
  });
}

function makeOutcomeRow(overrides: Record<string, unknown> = {}) {
  const row: Record<string, unknown> = {
    id: 1,
    outcomeId: `out1:${"b".repeat(64)}`,
    userId: 1,
    businessId: 10,
    leadId: null,
    leadIdentityVersion: null,
    conversionId: `cnv1:${"a".repeat(64)}`,
    outcomeType: "SALE",
    outcomeStatus: "VERIFIED",
    valueType: "MONETARY",
    amountMinor: 25000,
    currency: "USD",
    quantity: null,
    metricUnit: null,
    evidenceSource: "payment_processor",
    evidenceAuthority: "VERIFIED_PAYMENT",
    evidenceIdentity: "inv-a",
    occurredAt: "2026-10-01T10:00:00.000Z",
    recordedAt: "2026-10-01T10:01:00.000Z",
    reversesOutcomeId: null,
    renewsOutcomeId: null,
    supersedesOutcomeId: null,
    version: 2,
    createdAt: "2026-10-01T10:01:00.000Z",
    ...overrides,
  };
  row.evidenceHash = hashFor(row);
  return row;
}

function makeLifecycleFact(outcomeId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    outcomeLifecycleEventId: `obf1:${"c".repeat(64)}`,
    outcomeId,
    userId: 1,
    lifecycleType: "VERIFICATION",
    outcomeStatus: "VERIFIED",
    amountMinor: null,
    currency: null,
    externalLifecycleId: null,
    occurredAt: "2026-10-01T11:00:00.000Z",
    reasonCode: null,
    createdAt: "2026-10-01T11:00:00.000Z",
    ...overrides,
  };
}

describe("R7-X X3: canonical outcome → attribution binding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  function seedWith(outcomes: any[], lifecycle: any[], tableCount = 2) {
    const env = createFakeDb({
      business_outcomes: outcomes,
      business_outcome_lifecycle_events: lifecycle,
    });
    (env.db.execute as ReturnType<typeof vi.fn>).mockResolvedValue([{ c: tableCount }]);
    (getDb as unknown as ReturnType<typeof vi.fn>).mockReturnValue(env.db);
    return env;
  }

  it("reads through the integrated R7-A store with REAL lifecycle facts", async () => {
    const { createOutcomeAuthorityPort } = await import("./lib/attribution/attribution-outcome-seam");
    const outcome = makeOutcomeRow();
    const fact1 = makeLifecycleFact(outcome.outcomeId as string, {
      id: 1,
      outcomeStatus: "PROVISIONAL",
      lifecycleType: "RECORDING",
      outcomeLifecycleEventId: `obf1:${"d".repeat(64)}`,
    });
    const fact2 = makeLifecycleFact(outcome.outcomeId as string, { id: 2, outcomeStatus: "VERIFIED" });
    const env = seedWith([outcome], [fact1, fact2]);

    const port = createOutcomeAuthorityPort(env.db as never);
    const projection = await port.getOutcomeForAttribution(1, outcome.outcomeId as string);

    expect(projection).not.toBeNull();
    // Exact tenant/business binding surfaced from the durable A row.
    expect(projection!.businessId).toBe(10);
    expect(projection!.outcomeStatus).toBe("VERIFIED");
    // Real lifecycle history — not the isolated-era single-status stub.
    // A's canonical ordering is newest-first (desc id).
    expect(projection!.lifecycle.eventCount).toBe(2);
    expect(projection!.lifecycle.statuses).toEqual(["VERIFIED", "PROVISIONAL"]);
    expect(projection!.lifecycle.currentStatus).toBe("VERIFIED");
    // Frozen contract shape preserved end to end.
    expect(Object.keys(projection!).sort()).toEqual([...OUTCOME_PROJECTION_FIELD_KEYS].sort());
  });

  it("PROVISIONAL status is preserved conservatively (no silent upgrade)", async () => {
    const { createOutcomeAuthorityPort } = await import("./lib/attribution/attribution-outcome-seam");
    const outcome = makeOutcomeRow({
      outcomeStatus: "PROVISIONAL",
      evidenceAuthority: "USER_ATTESTATION",
      evidenceSource: "user_attestation",
      version: 1,
    });
    const env = seedWith([outcome], []);

    const port = createOutcomeAuthorityPort(env.db as never);
    const projection = await port.getOutcomeForAttribution(1, outcome.outcomeId as string);

    expect(projection!.outcomeStatus).toBe("PROVISIONAL");
    expect(projection!.evidenceAuthority).toBe("USER_ATTESTATION");
  });

  it("reversed outcome exposes reversal history to downstream interpretation", async () => {
    const { createOutcomeAuthorityPort } = await import("./lib/attribution/attribution-outcome-seam");
    const outcome = makeOutcomeRow({ outcomeStatus: "REVERSED" });
    const factV = makeLifecycleFact(outcome.outcomeId as string, { id: 1, outcomeStatus: "VERIFIED" });
    const factR = makeLifecycleFact(outcome.outcomeId as string, {
      id: 2,
      outcomeStatus: "REVERSED",
      lifecycleType: "REVERSAL",
      amountMinor: -25000,
    });
    const env = seedWith([outcome], [factV, factR]);

    const port = createOutcomeAuthorityPort(env.db as never);
    const projection = await port.getOutcomeForAttribution(1, outcome.outcomeId as string);

    expect(projection!.outcomeStatus).toBe("REVERSED");
    expect(projection!.lifecycle.statuses).toEqual(["REVERSED", "VERIFIED"]);
    expect(projection!.lifecycle.currentStatus).toBe("REVERSED");
  });

  it("hash-drifted (tampered) outcome row fails closed before R7-B consumes it", async () => {
    const { createOutcomeAuthorityPort } = await import("./lib/attribution/attribution-outcome-seam");
    const outcome = makeOutcomeRow();
    outcome.amountMinor = 999999; // tamper after hashing — drift, not authority
    const env = seedWith([outcome], []);

    const port = createOutcomeAuthorityPort(env.db as never);
    await expect(
      port.getOutcomeForAttribution(1, outcome.outcomeId as string)
    ).rejects.toThrow(/hash drift detected/);
  });

  it("monetary amount remains read-only: evaluation writes only attribution tables", async () => {
    const { createOutcomeAuthorityPort } = await import("./lib/attribution/attribution-outcome-seam");
    const { evaluateAttribution } = await import("./lib/attribution/attribution-service");
    const outcome = makeOutcomeRow();
    const env = seedWith([outcome], [makeLifecycleFact(outcome.outcomeId as string)]);
    // Business ownership re-verification + empty journey sources.
    env.seed.businesses = [{ id: 10, userId: 1 }];
    for (const t of [
      "campaigns",
      "content_posts",
      "engagement_executions",
      "opportunity_candidates",
      "nurture_touch_records",
      "sales_handoffs",
    ]) {
      env.seed[t] = env.seed[t] ?? [];
    }
    const outcomeBefore = structuredClone(env.seed.business_outcomes[0]);

    const result = await evaluateAttribution(
      env.db as never,
      { outcomeAuthority: createOutcomeAuthorityPort(env.db as never) },
      { userId: 1 },
      { outcomeId: outcome.outcomeId, modelType: "LAST_TOUCH" },
      "2026-10-02T12:00:00.000Z"
    );

    expect(result.result.attributionId).toMatch(/^atr1:[a-f0-9]{64}$/);
    // No eligible journey evidence → honest insufficient-evidence classification.
    expect(result.result.evidenceClass).toBe("INSUFFICIENT_EVIDENCE");
    // Attribution association never claims causation.
    expect(result.projection.causationClaimed).toBe(false);
    // The R7-A durable row is byte-identical after evaluation.
    expect(env.seed.business_outcomes[0]).toEqual(outcomeBefore);
    expect(env.seed.business_outcome_lifecycle_events).toHaveLength(1);
    // Only attribution tables gained rows.
    expect(env.seed.attribution_results).toHaveLength(1);
    expect(result.result.outcomeAmountMinor).toBe(25000);
  });

  it("cross-tenant outcome read returns null (existence never revealed)", async () => {
    const { createOutcomeAuthorityPort } = await import("./lib/attribution/attribution-outcome-seam");
    const outcome = makeOutcomeRow({ userId: 2, outcomeId: `out1:${"e".repeat(64)}` });
    const env = seedWith([outcome], []);

    const port = createOutcomeAuthorityPort(env.db as never);
    expect(await port.getOutcomeForAttribution(1, outcome.outcomeId as string)).toBeNull();
  });

  it("missing canonical tables degrade fail-closed to no outcome", async () => {
    const { createOutcomeAuthorityPort } = await import("./lib/attribution/attribution-outcome-seam");
    const outcome = makeOutcomeRow();
    const env = seedWith([outcome], [], 0);

    const port = createOutcomeAuthorityPort(env.db as never);
    expect(await port.getOutcomeForAttribution(1, outcome.outcomeId as string)).toBeNull();
  });

  it("partial canonical table pair degrades fail-closed to no outcome", async () => {
    const { createOutcomeAuthorityPort } = await import("./lib/attribution/attribution-outcome-seam");
    const outcome = makeOutcomeRow();
    const env = seedWith([outcome], [], 1);

    const port = createOutcomeAuthorityPort(env.db as never);
    expect(await port.getOutcomeForAttribution(1, outcome.outcomeId as string)).toBeNull();
  });
});
