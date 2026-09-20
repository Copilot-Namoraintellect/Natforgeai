import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { businesses, businessDnaSnapshots } from "@db/schema";
import {
  BusinessDnaNotFoundError,
  BusinessDnaReadinessError,
  evaluateBusinessDnaReadiness,
  materializeGovernedBusinessDna,
} from "./business-dna-governance";
import {
  getBusinessDnaSnapshotBySnapshotId,
  type BusinessDnaStoreDbExecutor,
} from "./business-dna-store";

// Pure-fake tests: no database required. Any hidden real-DB escape fails by
// construction because the connection module's getDb throws.
vi.mock("../queries/connection", () => ({
  getDb: vi.fn(() => {
    throw new Error("getDb must not be called in business-dna-governance tests");
  }),
}));

const CLOCK_A = () => new Date("2026-07-01T08:00:00.000Z");
const CLOCK_B = () => new Date("2026-09-15T12:30:00.000Z");

function completeBusinessRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 30,
    userId: 7,
    name: "NatForge Ops",
    industry: "Financial Operations",
    productOrService: "Payout automation",
    targetCustomer: "operations managers",
    targetAudience: null,
    tone: null,
    brandTone: null,
    brandVoiceNotes: null,
    avoidWords: null,
    websiteEvidence: {
      productsServices: ["supplier disbursements", "reconciliation dashboard"],
      targetCustomers: ["operations managers"],
      location: "Johannesburg",
    },
    isActive: true,
    ...overrides,
  };
}

// ─── Two-table in-memory executor fake ───

function compileFragment(fragment: unknown): { sql: string; params: unknown[] } {
  return new MySqlDialect().sqlToQuery(fragment as never);
}

function valuesEqual(actual: unknown, expected: unknown): boolean {
  if (actual === expected) return true;
  if (String(actual) === String(expected)) return true;
  const a = Number(actual);
  const b = Number(expected);
  return Number.isFinite(a) && Number.isFinite(b) && a === b;
}

function rowMatches(row: Record<string, unknown>, cond: unknown): boolean {
  if (!cond) return true;
  const { sql, params } = compileFragment(cond);
  const clauses = sql.split(/\s+AND\s+/i);
  let paramIndex = 0;
  for (const clause of clauses) {
    const match = /`?([A-Za-z_]\w*)`?\s*=\s*\?/.exec(clause);
    if (!match) return false;
    if (!valuesEqual(row[match[1]], params[paramIndex++])) return false;
  }
  return true;
}

function compareRows(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  orderBys: unknown[]
): number {
  for (const orderBy of orderBys) {
    const { sql } = compileFragment(orderBy);
    const match = /`?([A-Za-z_]\w*)`?\s+(desc|asc)$/i.exec(sql.trim());
    if (!match) continue;
    const direction = match[2].toLowerCase() === "desc" ? -1 : 1;
    const av = a[match[1]];
    const bv = b[match[1]];
    if (av instanceof Date && bv instanceof Date) {
      if (av.getTime() !== bv.getTime()) return av.getTime() < bv.getTime() ? -direction : direction;
    } else if (String(av) !== String(bv)) {
      return String(av) < String(bv) ? -direction : direction;
    }
  }
  return 0;
}

function makeGovernanceFake(config: {
  businesses?: Record<string, unknown>[];
} = {}) {
  const businessRows = new Map<number, Record<string, unknown>>();
  const snapshotRows = new Map<number, Record<string, unknown>>();
  const recorded: { op: "select" | "insert"; table: string; detail?: unknown }[] = [];
  let nextSnapshotId = 1;

  for (const row of config.businesses ?? []) {
    businessRows.set(Number(row.id), { ...row });
  }

  const executor = {
    select: vi.fn(() => {
      let table: unknown;
      let cond: unknown;
      let orderBys: unknown[] = [];
      let limit: number | null = null;
      const chain: Record<string, unknown> = {
        from: (t: unknown) => {
          table = t;
          return chain;
        },
        where: (c: unknown) => {
          cond = c;
          return chain;
        },
        orderBy: (...o: unknown[]) => {
          orderBys = o;
          return chain;
        },
        limit: (n: number) => {
          limit = n;
          return chain;
        },
        then: (resolve: (value: unknown) => unknown) => {
          const source =
            table === businesses
              ? businessRows
              : table === businessDnaSnapshots
                ? snapshotRows
                : new Map<number, Record<string, unknown>>();
          let matched = [...source.values()].filter((row) => rowMatches(row, cond));
          matched = matched.map((row) => ({
            ...row,
            snapshot:
              row.snapshot === undefined
                ? undefined
                : JSON.parse(JSON.stringify(row.snapshot)),
          }));
          matched.sort((a, b) => compareRows(a, b, orderBys));
          const limited = limit === null ? matched : matched.slice(0, limit);
          return resolve(limited);
        },
      };
      return chain;
    }),
    insert: vi.fn((table: unknown) => ({
      values: async (values: Record<string, unknown>) => {
        recorded.push({
          op: "insert",
          table: table === businessDnaSnapshots ? "business_dna_snapshots" : "unknown",
          detail: values,
        });
        if (table !== businessDnaSnapshots) {
          throw new Error("governance fake only supports business_dna_snapshots inserts");
        }
        const id = nextSnapshotId++;
        snapshotRows.set(id, {
          id,
          snapshotId: values.snapshotId,
          businessId: values.businessId,
          userId: values.userId,
          version: values.version,
          evidenceHashSha256: values.evidenceHashSha256,
          businessName: values.businessName,
          industry: values.industry,
          primaryOffering: values.primaryOffering,
          snapshot: JSON.parse(JSON.stringify(values.snapshot)),
          capturedAt: values.capturedAt,
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
        });
        return [{ insertId: id, affectedRows: 1 }];
      },
    })),
  };

  return {
    executor: executor as unknown as BusinessDnaStoreDbExecutor,
    recorded,
    updateBusiness(id: number, patch: Record<string, unknown>) {
      const current = businessRows.get(id);
      if (!current) throw new Error(`fake business ${id} not found`);
      businessRows.set(id, { ...current, ...patch });
    },
  };
}

function insertOps(recorded: { op: string; table?: string }[]) {
  return recorded.filter((op) => op.op === "insert");
}

describe("evaluateBusinessDnaReadiness", () => {
  it("accepts a complete governed projection and lists exact missing fields", () => {
    expect(
      evaluateBusinessDnaReadiness({
        businessId: 30,
        businessName: "NatForge Ops",
        primaryOffering: "Payout automation",
        productsAndServices: ["supplier disbursements"],
        targetCustomerSegments: ["operations managers"],
      })
    ).toEqual({ ready: true });

    expect(
      evaluateBusinessDnaReadiness({
        businessId: 0,
        businessName: "",
        primaryOffering: "",
        productsAndServices: [],
        targetCustomerSegments: [],
      })
    ).toEqual({
      ready: false,
      missing: [
        "businessId",
        "businessName",
        "primaryOffering",
        "productsAndServices",
        "targetCustomerSegments",
      ],
    });
  });
});

describe("materializeGovernedBusinessDna", () => {
  it("persists a governed snapshot for an owned complete business", async () => {
    const { executor, recorded } = makeGovernanceFake({
      businesses: [completeBusinessRow()],
    });

    const result = await materializeGovernedBusinessDna({
      userId: 7,
      businessId: 30,
      clock: CLOCK_A,
      executor,
    });

    expect(result.status).toBe("created");
    expect(result.readiness).toEqual({ ready: true });
    expect(result.snapshot.businessId).toBe(30);
    expect(result.snapshot.businessName).toBe("NatForge Ops");
    expect(result.snapshot.primaryOffering).toBe("Payout automation");
    expect(result.snapshot.capturedAtIso).toBe("2026-07-01T08:00:00.000Z");
    expect(result.snapshot.snapshotId).toMatch(/^shadow-bdna-30-[a-f0-9]{16}$/);
    expect(insertOps(recorded)).toHaveLength(1);
  });

  it("blocks a wrong user before any snapshot persistence", async () => {
    const { executor, recorded } = makeGovernanceFake({
      businesses: [completeBusinessRow({ userId: 7 })],
    });

    await expect(
      materializeGovernedBusinessDna({
        userId: 8,
        businessId: 30,
        clock: CLOCK_A,
        executor,
      })
    ).rejects.toMatchObject({
      code: "BUSINESS_DNA_BUSINESS_NOT_FOUND",
    });
    await expect(
      materializeGovernedBusinessDna({
        userId: 8,
        businessId: 30,
        clock: CLOCK_A,
        executor,
      })
    ).rejects.toBeInstanceOf(BusinessDnaNotFoundError);
    expect(insertOps(recorded)).toHaveLength(0);
  });

  it("blocks a missing or inactive business before any snapshot persistence", async () => {
    const { executor, recorded } = makeGovernanceFake({
      businesses: [
        completeBusinessRow({ id: 31, isActive: false }),
      ],
    });

    await expect(
      materializeGovernedBusinessDna({ userId: 7, businessId: 999, clock: CLOCK_A, executor })
    ).rejects.toBeInstanceOf(BusinessDnaNotFoundError);
    await expect(
      materializeGovernedBusinessDna({ userId: 7, businessId: 31, clock: CLOCK_A, executor })
    ).rejects.toBeInstanceOf(BusinessDnaNotFoundError);
    expect(insertOps(recorded)).toHaveLength(0);
  });

  it("blocks readiness with the exact missing field when businessName is absent", async () => {
    const { executor, recorded } = makeGovernanceFake({
      businesses: [completeBusinessRow({ name: "" })],
    });

    await expect(
      materializeGovernedBusinessDna({ userId: 7, businessId: 30, clock: CLOCK_A, executor })
    ).rejects.toMatchObject({
      code: "BUSINESS_DNA_READINESS_FAILED",
      missing: ["businessName"],
    });
    expect(insertOps(recorded)).toHaveLength(0);
  });

  it("blocks readiness when the primary offering is absent", async () => {
    const { executor, recorded } = makeGovernanceFake({
      businesses: [completeBusinessRow({ productOrService: "" })],
    });

    try {
      await materializeGovernedBusinessDna({
        userId: 7,
        businessId: 30,
        clock: CLOCK_A,
        executor,
      });
      expect.unreachable("expected readiness failure");
    } catch (error) {
      expect(error).toBeInstanceOf(BusinessDnaReadinessError);
      expect((error as BusinessDnaReadinessError).missing).toEqual(["primaryOffering"]);
    }
    expect(insertOps(recorded)).toHaveLength(0);
  });

  it("blocks readiness when the products/services catalogue is empty", async () => {
    const { executor, recorded } = makeGovernanceFake({
      businesses: [
        completeBusinessRow({
          productOrService: "",
          websiteEvidence: {
            productsServices: [],
            targetCustomers: ["operations managers"],
            location: "Johannesburg",
          },
        }),
      ],
    });

    await expect(
      materializeGovernedBusinessDna({ userId: 7, businessId: 30, clock: CLOCK_A, executor })
    ).rejects.toMatchObject({
      missing: ["primaryOffering", "productsAndServices"],
    });
    expect(insertOps(recorded)).toHaveLength(0);
  });

  it("blocks readiness when target customer segments are empty", async () => {
    const { executor, recorded } = makeGovernanceFake({
      businesses: [
        completeBusinessRow({
          targetCustomer: "",
          websiteEvidence: {
            productsServices: ["supplier disbursements"],
            targetCustomers: [],
            location: "Johannesburg",
          },
        }),
      ],
    });

    await expect(
      materializeGovernedBusinessDna({ userId: 7, businessId: 30, clock: CLOCK_A, executor })
    ).rejects.toMatchObject({
      missing: ["targetCustomerSegments"],
    });
    expect(insertOps(recorded)).toHaveLength(0);
  });

  it("never lets optional style/profile fields gate readiness", async () => {
    const { executor, recorded } = makeGovernanceFake({
      businesses: [
        completeBusinessRow({
          industry: "",
          tone: null,
          brandTone: null,
          brandVoiceNotes: null,
          avoidWords: null,
          websiteEvidence: { productsServices: ["payout automation"], targetCustomers: [] },
        }),
      ],
    });

    // industry empty, no brand fields, no evidence location: still ready.
    const result = await materializeGovernedBusinessDna({
      userId: 7,
      businessId: 30,
      clock: CLOCK_A,
      executor,
    });
    expect(result.status).toBe("created");
    expect(result.snapshot.industry).toBe("");
    expect(result.snapshot.brandLanguageConstraints).toEqual([]);
    expect(result.snapshot.prohibitedClaims).toEqual([]);
    expect(insertOps(recorded)).toHaveLength(1);
  });

  it("represents brand tone and voice notes deterministically and hashes them", async () => {
    const { executor, updateBusiness } = makeGovernanceFake({
      businesses: [
        completeBusinessRow({
          tone: "  premium ",
          brandTone: "bold",
          brandVoiceNotes: "Short sentences. No slang.",
        }),
      ],
    });

    const first = await materializeGovernedBusinessDna({
      userId: 7,
      businessId: 30,
      clock: CLOCK_A,
      executor,
    });
    expect(first.snapshot.brandLanguageConstraints).toEqual([
      "premium",
      "bold",
      "Short sentences. No slang.",
    ]);

    // Unchanged evidence (including brand fields) reuses the authority even
    // though wall-clock time advanced.
    const second = await materializeGovernedBusinessDna({
      userId: 7,
      businessId: 30,
      clock: CLOCK_B,
      executor,
    });
    expect(second.status).toBe("reused");
    expect(second.snapshot.brandLanguageConstraints).toEqual([
      "premium",
      "bold",
      "Short sentences. No slang.",
    ]);

    // A material brand change participates in the evidence hash: different
    // durable identity.
    updateBusiness(30, { tone: "playful" });
    const third = await materializeGovernedBusinessDna({
      userId: 7,
      businessId: 30,
      clock: CLOCK_B,
      executor,
    });
    expect(third.status).toBe("created");
    expect(third.snapshot.snapshotId).not.toBe(first.snapshot.snapshotId);
    expect(third.snapshot.evidenceHashSha256).not.toBe(
      first.snapshot.evidenceHashSha256
    );
    expect(third.snapshot.brandLanguageConstraints[0]).toBe("playful");
  });

  it("keeps avoidWords as prohibited claims/language", async () => {
    const { executor } = makeGovernanceFake({
      businesses: [
        completeBusinessRow({ avoidWords: [" guaranteed results ", "risk free", "guaranteed results"] }),
      ],
    });

    const result = await materializeGovernedBusinessDna({
      userId: 7,
      businessId: 30,
      clock: CLOCK_A,
      executor,
    });
    expect(result.snapshot.prohibitedClaims).toEqual([
      "guaranteed results",
      "risk free",
    ]);
    expect(
      result.snapshot.prohibitedClaims.some((claim) =>
        result.snapshot.brandLanguageConstraints.includes(claim)
      )
    ).toBe(false);
  });

  it("drives catalogue and segments from website evidence without inventing facts", async () => {
    const { executor } = makeGovernanceFake({
      businesses: [completeBusinessRow()],
    });

    const { snapshot } = await materializeGovernedBusinessDna({
      userId: 7,
      businessId: 30,
      clock: CLOCK_A,
      executor,
    });

    expect(snapshot.productsAndServices).toEqual([
      "supplier disbursements",
      "reconciliation dashboard",
      "Payout automation",
    ]);
    expect(snapshot.targetCustomerSegments).toEqual(["operations managers"]);
    expect(snapshot.verifiedUseCases).toEqual([
      "supplier disbursements",
      "reconciliation dashboard",
    ]);
    expect(snapshot.approvedClaims).toEqual([]);
    expect(snapshot.supportedOutcomes).toEqual([]);
    expect(snapshot.customerPainPoints).toEqual([]);
    expect(snapshot.evidenceReferences).toEqual(["Johannesburg"]);

    const serialized = JSON.stringify(snapshot).toLowerCase();
    expect(serialized).not.toContain("unknown");
    expect(serialized).not.toContain("placeholder");
    expect(serialized).not.toContain("assume");
  });

  it("reuses the existing immutable snapshot when evidence is unchanged", async () => {
    const clockA = vi.fn(CLOCK_A);
    const clockB = vi.fn(CLOCK_B);
    const { executor, recorded } = makeGovernanceFake({
      businesses: [completeBusinessRow()],
    });

    const first = await materializeGovernedBusinessDna({
      userId: 7,
      businessId: 30,
      clock: clockA,
      executor,
    });
    expect(first.status).toBe("created");
    expect(clockA).toHaveBeenCalledTimes(1);

    const second = await materializeGovernedBusinessDna({
      userId: 7,
      businessId: 30,
      clock: clockB,
      executor,
    });
    expect(second.status).toBe("reused");
    expect(second.snapshot).toEqual(first.snapshot);
    expect(second.snapshot.capturedAtIso).toBe("2026-07-01T08:00:00.000Z");
    // Reuse must not manufacture a second capturedAt-only variant.
    expect(insertOps(recorded)).toHaveLength(1);
    // The reuse path never consults the clock.
    expect(clockB).toHaveBeenCalledTimes(0);
  });

  it("creates a new immutable identity when governed evidence changes", async () => {
    const { executor, recorded, updateBusiness } = makeGovernanceFake({
      businesses: [completeBusinessRow()],
    });

    const first = await materializeGovernedBusinessDna({
      userId: 7,
      businessId: 30,
      clock: CLOCK_A,
      executor,
    });

    updateBusiness(30, {
      websiteEvidence: {
        productsServices: ["supplier disbursements", "collections workflow"],
        targetCustomers: ["operations managers"],
        location: "Johannesburg",
      },
    });

    const second = await materializeGovernedBusinessDna({
      userId: 7,
      businessId: 30,
      clock: CLOCK_B,
      executor,
    });
    expect(second.status).toBe("created");
    expect(second.snapshot.snapshotId).not.toBe(first.snapshot.snapshotId);
    expect(second.snapshot.capturedAtIso).toBe("2026-09-15T12:30:00.000Z");
    expect(insertOps(recorded)).toHaveLength(2);
  });

  it("retains the historical snapshot unchanged after a new identity is created", async () => {
    const { executor, updateBusiness } = makeGovernanceFake({
      businesses: [completeBusinessRow()],
    });

    const first = await materializeGovernedBusinessDna({
      userId: 7,
      businessId: 30,
      clock: CLOCK_A,
      executor,
    });
    const historical = first.snapshot;

    updateBusiness(30, {
      websiteEvidence: {
        productsServices: ["supplier disbursements", "collections workflow"],
        targetCustomers: ["operations managers"],
        location: "Johannesburg",
      },
    });
    await materializeGovernedBusinessDna({
      userId: 7,
      businessId: 30,
      clock: CLOCK_B,
      executor,
    });

    const rereadHistorical = await getBusinessDnaSnapshotBySnapshotId(
      historical.snapshotId,
      executor
    );
    expect(rereadHistorical).toEqual(historical);
    expect(rereadHistorical?.capturedAtIso).toBe("2026-07-01T08:00:00.000Z");
  });

  it("gates reuse on current-evidence readiness rather than serving stale authority", async () => {
    const { executor, updateBusiness } = makeGovernanceFake({
      businesses: [completeBusinessRow()],
    });

    await materializeGovernedBusinessDna({
      userId: 7,
      businessId: 30,
      clock: CLOCK_A,
      executor,
    });

    // Evidence degrades: catalogue becomes empty.
    updateBusiness(30, {
      productOrService: "",
      websiteEvidence: { productsServices: [], targetCustomers: ["operations managers"] },
    });

    await expect(
      materializeGovernedBusinessDna({ userId: 7, businessId: 30, clock: CLOCK_B, executor })
    ).rejects.toBeInstanceOf(BusinessDnaReadinessError);
  });

  it("captures time from exactly one clock authority on the create path", async () => {
    const clock = vi.fn(() => new Date("2026-03-04T10:20:30.123Z"));
    const { executor } = makeGovernanceFake({
      businesses: [completeBusinessRow()],
    });

    const result = await materializeGovernedBusinessDna({
      userId: 7,
      businessId: 30,
      clock,
      executor,
    });

    expect(clock).toHaveBeenCalledTimes(1);
    expect(result.snapshot.capturedAtIso).toBe("2026-03-04T10:20:30.123Z");
  });

  it("does not import or call Strategy campaign machinery", () => {
    const moduleSource = readFileSync(
      fileURLToPath(new URL("./business-dna-governance.ts", import.meta.url)),
      "utf8"
    );
    expect(moduleSource).not.toMatch(/strategy-agent/i);
    expect(moduleSource).not.toMatch(/campaignStrategy|buildCampaignStrategy/i);
  });

  it("resolves getDb lazily and fails when no executor is supplied in tests", async () => {
    await expect(
      materializeGovernedBusinessDna({ userId: 7, businessId: 30, clock: CLOCK_A })
    ).rejects.toThrow(/getDb/);
  });
});
