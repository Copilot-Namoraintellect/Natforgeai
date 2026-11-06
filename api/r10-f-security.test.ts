/**
 * R10-F — PRODUCTION SECURITY ROGUE-AGENT SUITE (F10).
 *
 * Assume ONE fully compromised autonomous Mission-Control agent (or a
 * malicious tenant session). Prove every privileged action the mission
 * enumerates fails closed against the REAL production paths:
 *
 *   - no tRPC procedure exposes environment/secrets/credentials anywhere;
 *   - env-var / DB-password / provider-key / backup-key retrieval attempts
 *     have no code path (NOT_FOUND) and no live surface leaks canaries;
 *   - tenant/business switching cannot be forced through router inputs;
 *   - privilege escalation via admin procedures is FORBIDDEN for non-admins;
 *   - client-authority smuggling (decision/risk/override) is rejected by
 *     strict schemas at the boundary;
 *   - arbitrary provider/adapter selection hits the closed registry;
 *   - agents cannot mint a secret broker and cannot be prompted/echoed into
 *     carrying secret-shaped material (runAgent pre/post screens);
 *   - no shell/SQL/eval/dynamic-tool procedure exists;
 *   - no audit/monitoring/backup-disable procedure exists.
 *
 * Real integrated appRouter + real runAgent; in-memory fake DB. Sandbox
 * adapters only. No server, no migration, no deployment. All secret material
 * here is synthetic and fake-valued (canaries).
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

vi.mock("./queries/connection", () => ({
  getDb: vi.fn(),
}));

// Canaries are set BEFORE any app module loads (vi.hoisted runs before the
// static imports below), so env.ts captures them — any leak would surface.
const CANARY = vi.hoisted(() => {
  process.env.APP_SECRET = "CANARY-app-secret-9f8e7d6c5b4a";
  process.env.DATABASE_URL = "mysql://canary_u:canary_p@canary.db.internal:3306/canarydb";
  process.env.REDIS_URL = "redis://canary:canary-redis-pass@canary.redis.internal:6379/0";
  process.env.OPENAI_API_KEY = `sk-${"canaryabcdef0123456789abcdef0123456789abcdef"}`;
  // Concatenated so no Stripe-shaped literal ever lands in the blob
  // (GitHub push protection matches even synthetic sk_live_* fixtures).
  process.env.STRIPE_SECRET_KEY = `sk_${"live_canaryabcdef0123456789abcdef"}`;
  process.env.SMTP_PASS = "canary-smtp-pass-12345";
  process.env.BACKUP_ENCRYPTION_KEY = "canary-backup-key-0123456789abcdef";
  process.env.FIREBASE_SERVICE_ACCOUNT = "/tmp/canary-firebase-service-account.json";
  return {
    APP_SECRET: process.env.APP_SECRET,
    DATABASE_URL: process.env.DATABASE_URL,
    REDIS_URL: process.env.REDIS_URL,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
    SMTP_PASS: process.env.SMTP_PASS,
    BACKUP_ENCRYPTION_KEY: process.env.BACKUP_ENCRYPTION_KEY,
    FIREBASE_SERVICE_ACCOUNT: process.env.FIREBASE_SERVICE_ACCOUNT,
  };
});

vi.mock("ai", () => ({
  generateObject: vi.fn(),
}));

// R10-F must not pollute the shared worker environment: several modules gate
// live behaviour on process.env at CALL time (e.g. the content-safety check
// short-circuits only when OPENAI_API_KEY is unset). Canaries are deleted in
// afterAll so later test files scheduled into the same worker process keep
// the default offline/test behaviour. Assertions use the hoisted snapshot
// strings, not live env, so cleanup cannot weaken them.
const CANARY_ENV_KEYS = [
  "APP_SECRET",
  "DATABASE_URL",
  "REDIS_URL",
  "OPENAI_API_KEY",
  "STRIPE_SECRET_KEY",
  "SMTP_PASS",
  "BACKUP_ENCRYPTION_KEY",
  "FIREBASE_SERVICE_ACCOUNT",
] as const;

import { generateObject } from "ai";
import { getDb } from "./queries/connection";
import { appRouter } from "./router";
import { buildCtx, createFakeDb } from "./r5-test-support";
import { runAgent } from "./lib/agents/runner";
import {
  createSecretBroker,
  ModelPayloadSecretError,
  SecretAccessDeniedError,
  assertSecretFreeModelPayload,
} from "./lib/production-security";
import { resolveAdapterForCapabilities } from "./lib/execution-coordination/execution-adapter-registry";

import { deriveMemoryEvidenceHash } from "./lib/strategic-memory/strategic-memory-identity";

/** Build a strategic-memory row whose immutable-core hash verifies, so the
 *  store's tamper assertion passes and the router projection exercises real
 *  reads. Pure fixture — no upstream authority involved. */
function makeMemoryRow(opts: { id: number; userId: number; businessId: number; memoryId: string }) {
  const input = {
    userId: opts.userId,
    businessId: opts.businessId,
    memoryType: "BUSINESS_ASSUMPTION" as const,
    subjectType: "BUSINESS" as const,
    subjectId: `biz:${opts.businessId}`,
    statementType: "ASSUMPTION" as const,
    statement: "synthetic fixture memory for r10-f security tests",
    evidenceRefs: [`ev:${opts.memoryId}`],
    sourceAuthority: "operator_attestation" as const,
    sourceVersion: "v1",
    sourceIdentity: `op:${opts.memoryId}`,
    confidenceClass: "PROVISIONAL" as const,
    basis: "OPERATOR_JUDGMENT",
    limitations: ["synthetic fixture only"],
    validFrom: "2026-01-01T00:00:00.000Z",
    validUntil: null,
    observedAt: "2026-01-01T00:00:00.000Z",
    supersedesMemoryId: null,
    contradictsMemoryIds: [] as string[],
    contextScope: {
      scopeType: "BUSINESS" as const,
      campaignId: null,
      businessDnaSnapshotId: null,
    },
  };
  return {
    id: opts.id,
    ...input,
    memoryId: opts.memoryId,
    factStatus: "CURRENT",
    evidenceHash: deriveMemoryEvidenceHash(input),
    version: 1,
  };
}

const USER1 = { id: 1, role: "user" };
const USER2 = { id: 2, role: "user" };
const ADMIN = { id: 99, role: "admin" };

const SYNTHETIC_LEAK = {
  openai: "sk-live-abc123def456ghi789",
  jwt: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c",
};

function collectPaths(router: any, prefix: string, out: string[] = []): string[] {
  for (const [key, node] of Object.entries(router._def?.procedures ?? {})) {
    const path = prefix ? `${prefix}.${key}` : key;
    const def: any = node;
    if (def._def?.procedures) {
      collectPaths(def, path, out);
    } else {
      out.push(path);
    }
  }
  return out;
}

function expectNoCanary(value: unknown, canaries: string[] = Object.values(CANARY)) {
  const text = JSON.stringify(value);
  for (const canary of canaries) {
    expect(text).not.toContain(canary);
  }
}

/** Asserts the promise rejects with a TRPCError carrying the exact code. */
async function expectTrpcCode(promise: Promise<unknown>, code: string): Promise<void> {
  let err: any = null;
  try {
    await promise;
  } catch (e) {
    err = e;
  }
  expect(err).toBeTruthy();
  expect(err.code, `expected TRPCError code ${code}, got: ${err?.message}`).toBe(code);
}

describe("F10 rogue-agent security", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterAll(() => {
    for (const key of CANARY_ENV_KEYS) {
      delete process.env[key];
    }
  });

  describe("procedure surface: no secret/env/shell path exists", () => {
    const paths = collectPaths(appRouter, "");

    it("appRouter exposes a walkable procedure map", () => {
      expect(paths.length).toBeGreaterThan(200);
    });

    it("no procedure path suggests secret/env/shell/sql access", () => {
      const deny = /(^|\.)(env|secrets?|credentials?|processEnv|getEnv|config|shell|exec|eval|sql|queryDb|dumpEnv|system|runtime)(\.|$)|secret|credential|apikey/i;
      const offenders = paths.filter((p) => deny.test(p));
      expect(offenders).toEqual([]);
    });

    it("every top-level router is a known closed namespace", () => {
      const allowed = new Set([
        "ping", "firebaseStatus", "auth", "business", "campaign", "content", "lead", "schedule",
        "automation", "analytics", "template", "image", "subscription", "admin", "banking", "agent",
        "approval", "autonomousWorkflow", "integration", "publishing", "conversation", "billing",
        "health", "operations", "leadGovernance", "video", "learning", "learningPromotion",
        "listening", "intelligence", "policy", "engagement", "opportunity", "leadIdentity", "scoring",
        "conversion", "qualification", "nurture", "outcome", "attribution", "businessLearning",
        "optimisationGovernance", "strategicGovernance", "experimentation", "budgetPortfolio",
        "strategicMemory", "businessChange", "marketSignal", "strategicReasoning",
        "strategicOpportunityRisk", "missionAuthority", "missionGovernance", "missionPlanning",
        "missionScheduling", "execution", "missionStateRecovery", "observability",
      ]);
      const topLevel = paths.map((p) => p.split(".")[0]);
      expect(new Set(topLevel).size).toBeGreaterThan(40);
      for (const t of new Set(topLevel)) {
        expect(allowed.has(t)).toBe(true);
      }
    });
  });

  describe("secret retrieval attempts fail closed", () => {
    it("nonexistent secret-ish procedures cannot be invoked (NOT_FOUND)", async () => {
      const caller = appRouter.createCaller(buildCtx(USER1));
      for (const attempt of ["system.env", "admin.getEnv", "agent.secrets", "config.secret", "system.shell", "db.query"]) {
        const parts = attempt.split(".");
        let target: any = caller;
        for (const part of parts) target = target?.[part];
        await expect(target?.({})).rejects.toThrowError(/No (procedure|query|mutation) found|not a function/i);
      }
    });

    it("public surfaces never echo canary secrets", async () => {
      const anon = appRouter.createCaller(buildCtx(null));
      const ping = await anon.ping();
      expectNoCanary(ping);
      const status = await anon.firebaseStatus();
      expect(status).toBeTruthy();
      // firebaseStatus touches only the firebase path; it must not leak
      // unrelated canaries, and its error path must not embed the service
      // account VALUE (the canary here is a path string, assert absence).
      expectNoCanary(status, [CANARY.APP_SECRET, CANARY.DATABASE_URL, CANARY.STRIPE_SECRET_KEY, CANARY.SMTP_PASS]);
    });

    it("unauthenticated callers are refused on every authed namespace", async () => {
      const anon = appRouter.createCaller(buildCtx(null));
      const probes: Array<[any, (c: any) => Promise<unknown>]> = [
        ["agent", (c) => c.agent.getAgentRuns({})],
        ["admin", (c) => c.admin.users({})],
        ["strategicMemory", (c) => c.strategicMemory.list({})],
        ["missionGovernance", (c) => c.missionGovernance.listDecisions({})],
        ["execution", (c) => c.execution.get({})],
        ["banking", (c) => c.banking.list()],
      ];
      for (const [ns, call] of probes) {
        await expectTrpcCode(call(anon), "UNAUTHORIZED");
      }
    });

    it("non-admin cannot list users or change roles (privilege escalation blocked)", async () => {
      const { db } = createFakeDb({});
      vi.mocked(getDb).mockReturnValue(db as never);
      const userCaller = appRouter.createCaller(buildCtx(USER1));
      await expectTrpcCode(userCaller.admin.users({}), "FORBIDDEN");
      await expectTrpcCode(userCaller.admin.updateUserRole({ userId: USER2.id, role: "admin" }), "FORBIDDEN");
    });
  });

  describe("tenant / business isolation cannot be forced", () => {
    it("cross-tenant strategic memory read returns NOT_FOUND", async () => {
      const { db } = createFakeDb({
        strategic_memory_records: [
          makeMemoryRow({ id: 1, userId: 2, businessId: 20, memoryId: "mem1:owner2secret" }),
        ],
        strategic_memory_lifecycle_events: [],
      });
      vi.mocked(getDb).mockReturnValue(db as never);
      const caller1 = appRouter.createCaller(buildCtx(USER1));
      await expectTrpcCode(caller1.strategicMemory.get({ memoryId: "mem1:owner2secret" }), "NOT_FOUND");
      const caller2 = appRouter.createCaller(buildCtx(USER2));
      await expect(caller2.strategicMemory.get({ memoryId: "mem1:owner2secret" })).resolves.toBeTruthy();
    });

    it("business switch attempt cannot reach another tenant's same-keyed business rows", async () => {
      const { db } = createFakeDb({
        strategic_memory_records: [
          makeMemoryRow({ id: 1, userId: 1, businessId: 10, memoryId: "mem1:biz10" }),
          makeMemoryRow({ id: 2, userId: 1, businessId: 20, memoryId: "mem1:biz20" }),
        ],
        strategic_memory_lifecycle_events: [],
      });
      vi.mocked(getDb).mockReturnValue(db as never);
      const caller1 = appRouter.createCaller(buildCtx(USER1));
      // Filtering to business 10 must not surface business 20's memory.
      const list = await caller1.strategicMemory.list({ businessId: 10 });
      expect(JSON.stringify(list)).toContain("mem1:biz10");
      expect(JSON.stringify(list)).not.toContain("mem1:biz20");
    });
  });

  describe("client-authority smuggling rejected at the boundary", () => {
    it("missionGovernance.evaluate rejects client-supplied decision/risk fields", async () => {
      const { db } = createFakeDb({});
      vi.mocked(getDb).mockReturnValue(db as never);
      const caller = appRouter.createCaller(buildCtx(USER1));
      await expect(
        caller.missionGovernance.evaluate({
          subjectClass: "MISSION_PROPOSAL",
          actionType: "MUTATE_DATA",
          actionParams: {},
          summary: "rogue attempt",
          declaredRisk: "low",
          decision: "ALLOW",
        } as any)
      ).rejects.toThrowError(/invalid|unknown|unrecognized/i);
    });

    it("policy.setPolicy cannot target a business the caller does not own", async () => {
      const { db } = createFakeDb({
        businesses: [{ id: 20, userId: 2, name: "Other tenant business" }],
      });
      vi.mocked(getDb).mockReturnValue(db as never);
      const caller = appRouter.createCaller(buildCtx(USER1));
      // USER1 attempts to overwrite the policy of USER2's business 20.
      await expectTrpcCode(
        caller.policy.setPolicy({ businessId: 20, config: { autonomyCeiling: "critical" } }),
        "FORBIDDEN"
      );
    });

    it("policy.setPolicy rejects client-authority smuggling via strict schema", async () => {
      const { db } = createFakeDb({ businesses: [{ id: 10, userId: 1, name: "Mine" }] });
      vi.mocked(getDb).mockReturnValue(db as never);
      const caller = appRouter.createCaller(buildCtx(USER1));
      await expect(
        caller.policy.setPolicy({
          businessId: 10,
          config: {},
          policyVersion: "v999",
          approved: true,
          decision: "ALLOW_AUTONOMOUS",
        } as any)
      ).rejects.toThrowError(/invalid|unrecognized|too many|not allowed/i);
    });
  });

  describe("provider / adapter selection is a closed registry", () => {
    it("unknown capability cannot resolve an adapter", () => {
      let outcome: unknown = null;
      try {
        outcome = resolveAdapterForCapabilities({
          requiredCapabilities: ["INVOKE_ARBITRARY_EXTERNAL_URL" as never],
          supportedCapabilities: [],
        });
      } catch (err) {
        outcome = err;
      }
      expect(outcome instanceof Error || outcome === null || outcome === undefined).toBe(true);
      if (!(outcome instanceof Error)) {
        expect(JSON.stringify(outcome)).not.toContain("INVOKE_ARBITRARY_EXTERNAL_URL");
      }
    });
  });

  describe("agent secret boundary (broker + model payload guard)", () => {
    it("agent-runtime identity cannot mint a broker", () => {
      expect(() => createSecretBroker("agent-runtime" as never)).toThrow(SecretAccessDeniedError);
      expect(() => createSecretBroker("agent-runtime" as never)).toThrowError(/denied/i);
    });

    it("no runtime identity can read backup or break-glass canary classes", () => {
      for (const identity of ["web-api", "worker", "scheduler", "provider-adapter", "monitoring"] as const) {
        const broker = createSecretBroker(identity as never);
        expect(() => broker.read("BACKUP_ENCRYPTION_KEY")).toThrow(SecretAccessDeniedError);
        expect(() => broker.read("BREAK_GLASS_ADMIN_PASSWORD")).toThrow(SecretAccessDeniedError);
      }
    });

    it("prompt carrying secret-shaped material fails before any model call or run record", async () => {
      const { db, seed } = createFakeDb({ agent_runs: [] });
      vi.mocked(getDb).mockReturnValue(db as never);
      const generate = vi.mocked(generateObject);
      generate.mockClear();

      await expect(
        runAgent({
          userId: USER1.id,
          agentType: "creative",
          prompt: `Summarise this key: ${SYNTHETIC_LEAK.openai}`,
          schema: z.object({ caption: z.string() }),
          skipBilling: true,
        })
      ).rejects.toThrow(ModelPayloadSecretError);

      expect(generate).not.toHaveBeenCalled();
      expect(seed.agent_runs ?? []).toHaveLength(0);
    });

    it("model output carrying secret-shaped material is blocked before return", async () => {
      const { db } = createFakeDb({ agent_runs: [] });
      vi.mocked(getDb).mockReturnValue(db as never);
      const generate = vi.mocked(generateObject);
      generate.mockResolvedValue({
        object: { caption: `Visit us. token ${SYNTHETIC_LEAK.jwt}` },
        usage: { promptTokens: 10, completionTokens: 5 },
      } as never);

      await expect(
        runAgent({
          userId: USER1.id,
          agentType: "creative",
          prompt: "Write a caption for a coffee shop",
          schema: z.object({ caption: z.string() }),
          skipBilling: true,
        })
      ).rejects.toThrow(ModelPayloadSecretError);
      expect(generate).toHaveBeenCalledTimes(1);
    });

    it("guard error messages name paths, never values", () => {
      let err: unknown;
      try {
        assertSecretFreeModelPayload({ notes: `key ${SYNTHETIC_LEAK.openai}` });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ModelPayloadSecretError);
      const message = (err as Error).message;
      expect(message).not.toContain(SYNTHETIC_LEAK.openai);
      expect(message).toContain("payload.notes");
    });
  });

  describe("no shell / SQL / eval / audit-disable surface in agent-facing code", () => {
    const SCAN_DIRS = ["api/lib/agents", "api/lib/execution-coordination", "api/lib/mission-authority"];
    const FORBIDDEN = /\b(process\.env\.(APP_SECRET|DATABASE_URL|REDIS_URL|STRIPE_SECRET_KEY|SMTP_PASS|BACKUP_|BREAK_GLASS|GOOGLE_APPLICATION_CREDENTIALS|TOKEN_ENCRYPTION_KEY|FIREBASE_SERVICE_ACCOUNT|META_APP_SECRET|LINKEDIN_CLIENT_SECRET|CREATIFY_API_KEY|BANNERBEAR_API_KEY|TEMPLATED_IO_API_KEY|OPENAI_API_KEY|HEYGEN_API_KEY|RUNWAY_API_KEY))\b|child_process|execSync|\beval\(|new Function\(|require\(/i;
    const ALLOWED = /process\.env\.(NATFORGE_TEST_MODE|VITEST|NODE_ENV|AI_PROVIDER_TIMEOUT_MS|LIVE_EXECUTION|ENABLE_HYBRID_LEAFLET_PIPELINE|HYBRID_LEAFLET_|OPENAI_IMAGE_|IMAGE_RENDER_CLAIMS_MODE|CREATIVE_V2_DIAGNOSTIC_HARNESS_ENABLED|POST_LIVE_|SOCIAL_LISTENING_|ENGAGEMENT_PROVIDER_TRANSPORT_ENABLED|RENDERED_FIDELITY_GATE_MODE|QUALITY_AUTHORITY_MODE|VISUAL_QUALITY_GATE_MODE|TERMINAL_REPLAY_ADMIN_ENABLED|WBS|PHASE|ENABLE_PREMIUM_|ENABLE_BASIC_DRAFT_VIDEO|PREMIUM_LEAFLET_PROVIDER|VIDEO_PROVIDER)/;

    function collectTsFiles(dir: string): string[] {
      const out: string[] = [];
      for (const entry of readdirSync(dir)) {
        if (entry.includes("node_modules")) continue;
        const full = join(dir, entry);
        const st = statSync(full);
        if (st.isDirectory()) out.push(...collectTsFiles(full));
        else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(full);
      }
      return out;
    }

    it("agent-facing modules never read privileged env names or spawn/eval", () => {
      const offenders: string[] = [];
      for (const dir of SCAN_DIRS) {
        for (const file of collectTsFiles(dir)) {
          const text = readFileSync(file, "utf8");
          const lines = text.split("\n");
          lines.forEach((line, i) => {
            if (FORBIDDEN.test(line) && !ALLOWED.test(line)) {
              offenders.push(`${file}:${i + 1}`);
            }
          });
        }
      }
      expect(offenders).toEqual([]);
    });

    it("no audit/monitoring/backup-disable procedure exists in the router map", () => {
      const paths = collectPaths(appRouter, "");
      // Narrow: only procedures that DISABLE audit/monitoring/backup matter.
      // (auth.disableTwoFactor is a user-facing account feature, not a
      // platform-integrity kill switch.)
      const deny = /(audit|monitoring|backup).{0,24}(disable|stop|pause|suppress|delete)|(disable|stop|pause|suppress).{0,12}(audit|monitoring|backup)/i;
      expect(paths.filter((p) => deny.test(p))).toEqual([]);
    });
  });

  describe("admin surface does not leak canary material", () => {
    it("admin stats/users responses are free of secret canaries", async () => {
      const { db } = createFakeDb({
        users: [{ id: 1, role: "user", name: "U1", email: "u1@example.com" }],
        campaigns: [],
        leads: [],
        content_posts: [],
        businesses: [],
      });
      vi.mocked(getDb).mockReturnValue(db as never);
      const admin = appRouter.createCaller(buildCtx(ADMIN));
      const users = await admin.admin.users({});
      expectNoCanary(users);
    });
  });
});
