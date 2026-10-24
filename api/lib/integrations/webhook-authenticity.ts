/**
 * Webhook authenticity primitives shared by inbound pipelines.
 *
 * Meta (`facebook` / `instagram` / `whatsapp`) authenticates webhooks with the
 * `X-Hub-Signature-256` HMAC of the raw request body keyed by the Meta app
 * secret. This module owns the pure cryptographic check so both the
 * engagement inbound pipeline and the R5-A social listening boundary share one
 * implementation. Providers without a verifier are handled fail-closed by
 * their callers — no default trust is provided here.
 */

import { createHmac, timingSafeEqual, createHash } from "crypto";

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Constant-time verification of a Meta webhook signature. Returns false when
 * either side is missing — unverifiable is never authentic.
 */
export function verifyMetaWebhookSignature(
  rawBody: string,
  signature: string,
  appSecret: string
): boolean {
  if (!appSecret || !signature) return false;
  const expected = `sha256=${createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex")}`;
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
