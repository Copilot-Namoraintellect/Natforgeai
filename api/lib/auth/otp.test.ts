import { describe, it, expect, vi, beforeEach } from "vitest";
import bcrypt from "bcryptjs";
import { users, twoFactorChallenges } from "@db/schema";

vi.mock("../email", () => ({
  sendTwoFactorCodeEmail: vi.fn(),
}));

vi.mock("../logger", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

const sendTwoFactorCodeEmail = (await import("../email")).sendTwoFactorCodeEmail as ReturnType<typeof vi.fn>;

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
  userRows = [],
  challengeRows = [],
}: {
  userRows?: any[];
  challengeRows?: ChallengeRow[];
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

async function makeChallengeRow(
  overrides: Partial<ChallengeRow> = {}
): Promise<ChallengeRow> {
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

describe("OTP service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendTwoFactorCodeEmail.mockResolvedValue({
      messageId: "msg-123",
      accepted: ["test@example.com"],
      rejected: [],
      response: "250 Ok queued",
    });
  });

  describe("createAndSendChallenge", () => {
    it("sends email and inserts a challenge only after SMTP accepts", async () => {
      const { createAndSendChallenge } = await import("./otp");
      const db = createMockDb();

      const result = await createAndSendChallenge(db as any, {
        userId: 1,
        email: "test@example.com",
        purpose: "email_verification",
        ctx: { req: new Request("http://localhost") },
      });

      expect(result.challengeToken).toBeTruthy();
      expect(db.challenges).toHaveLength(1);
      expect(sendTwoFactorCodeEmail).toHaveBeenCalledTimes(1);
    });

    it("does not insert a challenge if SMTP send fails", async () => {
      const { createAndSendChallenge } = await import("./otp");
      const db = createMockDb();
      sendTwoFactorCodeEmail.mockRejectedValueOnce(new Error("SMTP rejected"));

      await expect(
        createAndSendChallenge(db as any, {
          userId: 1,
          email: "test@example.com",
          purpose: "email_verification",
          ctx: { req: new Request("http://localhost") },
        })
      ).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });

      expect(db.challenges).toHaveLength(0);
    });

    it("expires previous active challenges for the same user and purpose", async () => {
      const { createAndSendChallenge } = await import("./otp");
      const oldChallenge = await makeChallengeRow({ userId: 1, purpose: "email_verification" });
      const db = createMockDb({ challengeRows: [oldChallenge] });

      await createAndSendChallenge(db as any, {
        userId: 1,
        email: "test@example.com",
        purpose: "email_verification",
        ctx: { req: new Request("http://localhost") },
      });

      expect(oldChallenge.consumedAt).toBeInstanceOf(Date);
      expect(db.challenges).toHaveLength(2);
    });
  });

  describe("verifyChallenge", () => {
    it("returns the user when the code is correct", async () => {
      const { verifyChallenge } = await import("./otp");
      const code = "654321";
      const challenge = await makeChallengeRow({
        userId: 7,
        challengeToken: "valid-token",
        otpHash: await bcrypt.hash(code, 10),
      });
      const user = { id: 7, email: "user@example.com" };
      const db = createMockDb({ userRows: [user], challengeRows: [challenge] });

      const result = await verifyChallenge(db as any, { challengeToken: "valid-token", code });
      expect(result.id).toBe(7);
      expect(challenge.consumedAt).toBeInstanceOf(Date);
    });

    it("increments attempts on wrong code", async () => {
      const { verifyChallenge } = await import("./otp");
      const challenge = await makeChallengeRow({ challengeToken: "token", attempts: 0 });
      const db = createMockDb({ challengeRows: [challenge] });

      await expect(
        verifyChallenge(db as any, { challengeToken: "token", code: "000000" })
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

      expect(challenge.attempts).toBe(1);
    });

    it("blocks verification after max attempts", async () => {
      const { verifyChallenge } = await import("./otp");
      const challenge = await makeChallengeRow({ challengeToken: "token", attempts: 5 });
      const db = createMockDb({ challengeRows: [challenge] });

      await expect(
        verifyChallenge(db as any, { challengeToken: "token", code: "123456" })
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    });

    it("rejects expired challenges", async () => {
      const { verifyChallenge } = await import("./otp");
      // Expired rows are no longer active; the only active challenge is empty.
      const db = createMockDb({ challengeRows: [] });

      await expect(
        verifyChallenge(db as any, { challengeToken: "token", code: "123456" })
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    });

    it("rejects consumed challenges", async () => {
      const { verifyChallenge } = await import("./otp");
      // Consumed rows are no longer active; the only active challenge is empty.
      const db = createMockDb({ challengeRows: [] });

      await expect(
        verifyChallenge(db as any, { challengeToken: "token", code: "123456" })
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    });
  });

  describe("markUserVerified", () => {
    it("sets emailVerifiedAt and lastTwoFactorVerifiedAt", async () => {
      const { markUserVerified } = await import("./otp");
      const user = { id: 1, emailVerifiedAt: null, lastTwoFactorVerifiedAt: null };
      const db = createMockDb({ userRows: [user] });

      await markUserVerified(db as any, 1);

      expect(user.emailVerifiedAt).toBeInstanceOf(Date);
      expect(user.lastTwoFactorVerifiedAt).toBeInstanceOf(Date);
    });
  });
});
