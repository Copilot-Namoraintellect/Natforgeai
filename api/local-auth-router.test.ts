import { describe, it, expect, vi, beforeEach } from "vitest";
import bcrypt from "bcryptjs";
import { localAuthRouter } from "./local-auth-router";
import { users, twoFactorChallenges } from "@db/schema";

vi.mock("./queries/connection", () => ({
  getDb: vi.fn(),
}));

vi.mock("./lib/email", () => ({
  sendTwoFactorCodeEmail: vi.fn(),
}));

vi.mock("./lib/subscription", () => ({
  ensureFreeSubscription: vi.fn(async () => {}),
}));

vi.mock("./lib/logger", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("./lib/env", () => ({
  env: {
    appSecret: "test-app-secret",
    requireTwoFactor: true,
    ownerUnionId: "",
    isProduction: false,
    databaseUrl: "",
    firebaseServiceAccount: "",
    smtpHost: "",
    smtpPort: 587,
    smtpUser: "",
    smtpPass: "",
    smtpFromEmail: "",
    smtpFromName: "",
    openaiApiKey: "",
    redisUrl: "",
  },
}));

const sendTwoFactorCodeEmail = (await import("./lib/email")).sendTwoFactorCodeEmail as ReturnType<typeof vi.fn>;
const { getDb } = await import("./queries/connection");

function getTableName(table: unknown): string | undefined {
  return (table as Record<symbol, unknown>)[
    Symbol.for("drizzle:Name") as symbol
  ] as string | undefined;
}

type ChallengeRow = {
  id?: number;
  userId: number;
  challengeToken: string;
  otpHash: string;
  expiresAt: Date;
  attempts: number;
  maxAttempts: number;
  consumedAt?: Date | null;
  purpose: string;
  sentToEmail: string;
};

function createMockDb({
  userRows = [] as any[],
  challengeRows = [] as ChallengeRow[],
} = {}) {
  let currentTable: string | undefined;

  const chain = {
    from: vi.fn((table: unknown) => {
      currentTable = getTableName(table);
      return chain;
    }),
    where: vi.fn(() => chain),
    limit: vi.fn(async () => {
      if (currentTable === "users") return userRows;
      if (currentTable === "two_factor_challenges") return challengeRows;
      return [];
    }),
  };

  return {
    users: userRows,
    challenges: challengeRows,
    select: vi.fn(() => chain),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn(async (data: any) => {
        const tableName = getTableName(table);
        if (tableName === "two_factor_challenges") {
          const id = data.id ?? challengeRows.length + 1;
          challengeRows.push({ ...data, id });
          return [{ insertId: id }];
        }
        if (tableName === "users") {
          const id = data.id ?? userRows.length + 1;
          userRows.push({ ...data, id });
          return [{ insertId: id }];
        }
        return [{ insertId: 1 }];
      }),
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((data: any) => ({
        where: vi.fn(async () => {
          const tableName = getTableName(table);
          if (tableName === "two_factor_challenges") {
            challengeRows.forEach((c) => {
              if (!c.consumedAt && c.expiresAt > new Date()) {
                Object.assign(c, data);
              }
            });
          } else if (tableName === "users") {
            userRows.forEach((u) => Object.assign(u, data));
          }
          return [];
        }),
      })),
    })),
  };
}

function buildCtx() {
  return {
    req: new Request("http://localhost/api/trpc"),
    resHeaders: new Headers(),
  };
}

async function makeUser(overrides: any = {}) {
  const password = overrides.password ?? "Password123";
  return {
    id: 1,
    username: "testuser",
    email: "test@example.com",
    name: "Test User",
    role: "user",
    authType: "local",
    passwordHash: await bcrypt.hash(password, 12),
    emailVerifiedAt: null,
    lastTwoFactorVerifiedAt: null,
    twoFactorEnabled: false,
    twoFactorMethod: null,
    ...overrides,
  };
}

async function makeChallenge(overrides: Partial<ChallengeRow> = {}): Promise<ChallengeRow> {
  const code = "123456";
  return {
    userId: 1,
    challengeToken: "token-" + Math.random().toString(36).slice(2),
    otpHash: await bcrypt.hash(code, 10),
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    attempts: 0,
    maxAttempts: 5,
    consumedAt: null,
    purpose: "email_verification",
    sentToEmail: "test@example.com",
    ...overrides,
  };
}

describe("localAuthRouter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendTwoFactorCodeEmail.mockResolvedValue({
      messageId: "msg-123",
      accepted: ["test@example.com"],
      rejected: [],
      response: "250 Ok queued",
    });
  });

  describe("register", () => {
    it("creates a new user and sends an OTP", async () => {
      const db = createMockDb();
      vi.mocked(getDb).mockReturnValue(db as any);
      const caller = localAuthRouter.createCaller(buildCtx());

      const result = await caller.register({
        username: "newuser",
        email: "new@example.com",
        password: "Password123",
        name: "New User",
      });

      expect(result.requiresTwoFactor).toBe(true);
      expect(result.purpose).toBe("email_verification");
      expect(result.challengeToken).toBeTruthy();
      expect(sendTwoFactorCodeEmail).toHaveBeenCalledTimes(1);
    });

    it("returns account exists for an existing verified user", async () => {
      const user = await makeUser({ emailVerifiedAt: new Date() });
      const db = createMockDb({ userRows: [user] });
      vi.mocked(getDb).mockReturnValue(db as any);
      const caller = localAuthRouter.createCaller(buildCtx());

      await expect(
        caller.register({
          username: "otheruser",
          email: "test@example.com",
          password: "Password123",
          name: "Test",
        })
      ).rejects.toMatchObject({
        code: "CONFLICT",
        message: "Account already exists, please log in",
      });

      expect(sendTwoFactorCodeEmail).not.toHaveBeenCalled();
    });

    it("resends OTP for an existing unverified user", async () => {
      const user = await makeUser({ emailVerifiedAt: null });
      const oldChallenge = await makeChallenge({ userId: 1, purpose: "email_verification" });
      const db = createMockDb({ userRows: [user], challengeRows: [oldChallenge] });
      vi.mocked(getDb).mockReturnValue(db as any);
      const caller = localAuthRouter.createCaller(buildCtx());

      const result = await caller.register({
        username: "otheruser",
        email: "test@example.com",
        password: "Password123",
        name: "Test",
      });

      expect(result.requiresTwoFactor).toBe(true);
      expect(result.purpose).toBe("email_verification");
      expect(result.message).toContain("not verified");
      expect(oldChallenge.consumedAt).toBeInstanceOf(Date);
      expect(sendTwoFactorCodeEmail).toHaveBeenCalledTimes(1);
    });
  });

  describe("login", () => {
    it("resends OTP and shows verification state for correct password + unverified user", async () => {
      const user = await makeUser({ emailVerifiedAt: null });
      const db = createMockDb({ userRows: [user] });
      vi.mocked(getDb).mockReturnValue(db as any);
      const caller = localAuthRouter.createCaller(buildCtx());

      const result = await caller.login({
        usernameOrEmail: "test@example.com",
        password: "Password123",
      });

      expect(result.requiresTwoFactor).toBe(true);
      expect(result.purpose).toBe("email_verification");
      expect(result.message).toContain("Account not verified");
      expect(sendTwoFactorCodeEmail).toHaveBeenCalledTimes(1);
    });

    it("returns invalid credentials for wrong password", async () => {
      const user = await makeUser();
      const db = createMockDb({ userRows: [user] });
      vi.mocked(getDb).mockReturnValue(db as any);
      const caller = localAuthRouter.createCaller(buildCtx());

      await expect(
        caller.login({
          usernameOrEmail: "test@example.com",
          password: "WrongPassword",
        })
      ).rejects.toMatchObject({
        code: "UNAUTHORIZED",
        message: "Invalid username or password",
      });

      expect(sendTwoFactorCodeEmail).not.toHaveBeenCalled();
    });

    it("issues a token for a verified user when 2FA is not required", async () => {
      const user = await makeUser({ emailVerifiedAt: new Date(), twoFactorEnabled: false });
      const db = createMockDb({ userRows: [user] });
      vi.mocked(getDb).mockReturnValue(db as any);
      const caller = localAuthRouter.createCaller(buildCtx());

      // Override env.requireTwoFactor to false via the mocked module.
      const { env } = await import("./lib/env");
      (env as any).requireTwoFactor = false;

      const result = await caller.login({
        usernameOrEmail: "test@example.com",
        password: "Password123",
      });

      expect("token" in result).toBe(true);
      expect(sendTwoFactorCodeEmail).not.toHaveBeenCalled();

      (env as any).requireTwoFactor = true;
    });
  });

  describe("resendVerificationCode", () => {
    it("expires old challenge and creates a new one", async () => {
      const user = await makeUser();
      const oldChallenge = await makeChallenge({ userId: 1, purpose: "email_verification" });
      const db = createMockDb({ userRows: [user], challengeRows: [oldChallenge] });
      vi.mocked(getDb).mockReturnValue(db as any);
      const caller = localAuthRouter.createCaller(buildCtx());

      const result = await caller.resendVerificationCode({
        challengeToken: oldChallenge.challengeToken,
      });

      expect(result.challengeToken).toBeTruthy();
      expect(result.challengeToken).not.toBe(oldChallenge.challengeToken);
      expect(oldChallenge.consumedAt).toBeInstanceOf(Date);
      expect(sendTwoFactorCodeEmail).toHaveBeenCalledTimes(1);
    });
  });

  describe("verifyTwoFactor", () => {
    it("marks account verified and consumes the challenge on success", async () => {
      const code = "654321";
      const user = await makeUser({ emailVerifiedAt: null });
      const challenge = await makeChallenge({
        userId: 1,
        challengeToken: "verify-token",
        otpHash: await bcrypt.hash(code, 10),
      });
      const db = createMockDb({ userRows: [user], challengeRows: [challenge] });
      vi.mocked(getDb).mockReturnValue(db as any);
      const caller = localAuthRouter.createCaller(buildCtx());

      const result = await caller.verifyTwoFactor({ challengeToken: "verify-token", otpCode: code });

      expect("token" in result).toBe(true);
      expect(user.emailVerifiedAt).toBeInstanceOf(Date);
      expect(challenge.consumedAt).toBeInstanceOf(Date);
    });
  });
});
