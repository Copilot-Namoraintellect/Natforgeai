import * as jose from "jose";
import { env } from "./env";

const JWT_ALG = "HS256";
const JWT_SECRET = () => new TextEncoder().encode(env.appSecret + "_local");

export interface LocalSessionPayload {
  userId: number;
  type: "local" | "google" | "firebase";
}

export async function signLocalToken(payload: LocalSessionPayload): Promise<string> {
  return new jose.SignJWT({ ...payload })
    .setProtectedHeader({ alg: JWT_ALG })
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(JWT_SECRET());
}

export async function verifyLocalToken(
  token: string
): Promise<LocalSessionPayload | null> {
  if (!token) return null;
  try {
    const { payload } = await jose.jwtVerify(token, JWT_SECRET(), {
      algorithms: [JWT_ALG],
      clockTolerance: 60,
    });
    if (!payload.userId || !payload.type) return null;
    return { userId: payload.userId as number, type: payload.type as "local" | "google" | "firebase" };
  } catch {
    return null;
  }
}
