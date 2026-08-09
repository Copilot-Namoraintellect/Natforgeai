import { describe, it, expect, vi, beforeEach } from "vitest";
import { adminRouter } from "./admin-router";
import { TRPCError } from "@trpc/server";
import type { User } from "@db/schema";

const loggedEvents: any[] = [];
const TEST_EXECUTION_ID = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";

vi.mock("./lib/env", () => ({
  env: {
    get creativeV2DiagnosticHarnessEnabled() {
      return process.env.CREATIVE_V2_DIAGNOSTIC_HARNESS_ENABLED === "true";
    },
  },
}));

vi.mock("./lib/logger", () => ({
  logInfo: vi.fn((message: string, fields?: any) => {
    loggedEvents.push({ level: "info", message, fields });
  }),
  logError: vi.fn((message: string, fields?: any) => {
    loggedEvents.push({ level: "error", message, fields });
  }),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

function buildCtx(user: Partial<User>) {
  return {
    req: new Request("http://localhost/api/trpc"),
    resHeaders: new Headers(),
    user: user as User,
    session: { userId: user.id ?? 1, type: "local" as const, verified: true },
  };
}

function makeCaller(role: "user" | "admin") {
  return adminRouter.createCaller(
    buildCtx({ id: 1, role, name: "Test", email: "test@example.com" })
  );
}

describe("admin.canaryDiagnosticAuthority", () => {
  beforeEach(() => {
    loggedEvents.length = 0;
    vi.unstubAllEnvs();
  });

  it("non-admin user is forbidden", async () => {
    const caller = makeCaller("user");
    await expect(
      caller.canaryDiagnosticAuthority({
        executionId: TEST_EXECUTION_ID,
        fixtureCase: "approved",
      })
    ).rejects.toThrow(TRPCError);

    try {
      await caller.canaryDiagnosticAuthority({
        executionId: TEST_EXECUTION_ID,
        fixtureCase: "approved",
      });
    } catch (err: any) {
      expect(err.code).toBe("FORBIDDEN");
    }
  });

  it("returns SERVICE_UNAVAILABLE when kill switch is missing", async () => {
    delete process.env.CREATIVE_V2_DIAGNOSTIC_HARNESS_ENABLED;
    const caller = makeCaller("admin");
    await expect(
      caller.canaryDiagnosticAuthority({
        executionId: TEST_EXECUTION_ID,
        fixtureCase: "approved",
      })
    ).rejects.toThrow(TRPCError);

    try {
      await caller.canaryDiagnosticAuthority({
        executionId: TEST_EXECUTION_ID,
        fixtureCase: "approved",
      });
    } catch (err: any) {
      expect(err.code).toBe("SERVICE_UNAVAILABLE");
    }
  });

  it("returns SERVICE_UNAVAILABLE when kill switch is false", async () => {
    process.env.CREATIVE_V2_DIAGNOSTIC_HARNESS_ENABLED = "false";
    const caller = makeCaller("admin");
    await expect(
      caller.canaryDiagnosticAuthority({
        executionId: TEST_EXECUTION_ID,
        fixtureCase: "approved",
      })
    ).rejects.toThrow(TRPCError);

    try {
      await caller.canaryDiagnosticAuthority({
        executionId: TEST_EXECUTION_ID,
        fixtureCase: "approved",
      });
    } catch (err: any) {
      expect(err.code).toBe("SERVICE_UNAVAILABLE");
    }
  });

  it("returns SERVICE_UNAVAILABLE when kill switch is '1'", async () => {
    process.env.CREATIVE_V2_DIAGNOSTIC_HARNESS_ENABLED = "1";
    const caller = makeCaller("admin");
    await expect(
      caller.canaryDiagnosticAuthority({
        executionId: TEST_EXECUTION_ID,
        fixtureCase: "approved",
      })
    ).rejects.toThrow(TRPCError);

    try {
      await caller.canaryDiagnosticAuthority({
        executionId: TEST_EXECUTION_ID,
        fixtureCase: "approved",
      });
    } catch (err: any) {
      expect(err.code).toBe("SERVICE_UNAVAILABLE");
    }
  });

  it("returns SERVICE_UNAVAILABLE when kill switch is 'yes'", async () => {
    process.env.CREATIVE_V2_DIAGNOSTIC_HARNESS_ENABLED = "yes";
    const caller = makeCaller("admin");
    await expect(
      caller.canaryDiagnosticAuthority({
        executionId: TEST_EXECUTION_ID,
        fixtureCase: "approved",
      })
    ).rejects.toThrow(TRPCError);

    try {
      await caller.canaryDiagnosticAuthority({
        executionId: TEST_EXECUTION_ID,
        fixtureCase: "approved",
      });
    } catch (err: any) {
      expect(err.code).toBe("SERVICE_UNAVAILABLE");
    }
  });

  it("executes when kill switch is true and user is admin", async () => {
    process.env.CREATIVE_V2_DIAGNOSTIC_HARNESS_ENABLED = "true";
    process.env.CREATIVE_PIPELINE_V2_MODE = "shadow";
    const caller = makeCaller("admin");
    const result = await caller.canaryDiagnosticAuthority({
      executionId: TEST_EXECUTION_ID,
      fixtureCase: "approved",
    });

    expect(result.decision).toBe("approved");
    expect(result.executionMode).toBe("diagnostic_authority");
    expect(result.authorityPathExercised).toBe(true);
    expect(result.productionCanarySelected).toBe(false);
    expect(result.productionMode).toBe("shadow");
    expect(result.legacyFallbackUsed).toBe(false);
    expect(result.billingMutationCount).toBe(0);
    expect(result.artifactMutationCount).toBe(0);
    expect(result.publishingMutationCount).toBe(0);
  });

  it("reports unknown production mode safely", async () => {
    process.env.CREATIVE_V2_DIAGNOSTIC_HARNESS_ENABLED = "true";
    process.env.CREATIVE_PIPELINE_V2_MODE = "invalid_mode";
    const caller = makeCaller("admin");
    const result = await caller.canaryDiagnosticAuthority({
      executionId: TEST_EXECUTION_ID,
      fixtureCase: "approved",
    });

    expect(result.productionMode).toBe("unknown");
    expect(result.decision).toBe("approved");
  });

  it("logs a safe audit event without raw input or PII", async () => {
    process.env.CREATIVE_V2_DIAGNOSTIC_HARNESS_ENABLED = "true";
    process.env.CREATIVE_PIPELINE_V2_MODE = "shadow";
    const caller = makeCaller("admin");
    await caller.canaryDiagnosticAuthority({
      executionId: TEST_EXECUTION_ID,
      fixtureCase: "approved",
    });

    const event = loggedEvents.find(
      (e) => e.fields?.event === "v2_diagnostic_authority_executed"
    );
    expect(event).toBeDefined();
    const fields = event.fields;

    expect(fields.executionId).toBe(TEST_EXECUTION_ID);
    expect(fields.adminUserId).toBe(1);
    expect(fields.fixtureCase).toBe("approved");
    expect(fields.decision).toBe("approved");
    expect(fields.errorStage).toBeNull();
    expect(fields.errorCode).toBeNull();

    expect(fields).not.toHaveProperty("candidateCopy");
    expect(fields).not.toHaveProperty("businessEvidence");
    expect(fields).not.toHaveProperty("email");
    expect(fields).not.toHaveProperty("phone");
    expect(fields).not.toHaveProperty("input");
    expect(fields).not.toHaveProperty("rawError");
    expect(fields).not.toHaveProperty("stack");
  });

  it("rejects malformed input", async () => {
    process.env.CREATIVE_V2_DIAGNOSTIC_HARNESS_ENABLED = "true";
    const caller = makeCaller("admin");
    await expect(
      (caller as any).canaryDiagnosticAuthority({
        executionId: "not-a-uuid",
        fixtureCase: "approved",
      })
    ).rejects.toThrow(TRPCError);
  });
});
