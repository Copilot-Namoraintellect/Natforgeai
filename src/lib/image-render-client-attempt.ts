// Client attempt-token lifecycle for paid premium-image actions (B2A).
//
// Dormant-adoption only: the token is an idempotency correlation value for
// one logical user action — never an authorization credential. Ownership
// remains the server-side user-scoped post lookup, and server-side uniqueness
// enforcement remains a B2B requirement; this frontend guard only reduces
// accidental duplicate submissions and keeps retry identity stable across
// ambiguous outcomes.
//
// Raw refinement/guidance text, raw brand colours and the raw token never
// appear in storage keys or values other than the token field itself.

export const IMAGE_RENDER_OPERATION_KIND = "premium_image" as const;
export const CLIENT_ATTEMPT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export interface ImageRenderMaterialIntentInput {
  regenerate?: boolean | null;
  forceRegenerate?: boolean | null;
  refinementInstruction?: string | null;
  creativeGuidance?: string | null;
  strongerBrandFit?: boolean | null;
  provider?: string | null;
  templateId?: string | null;
  brandColors?: string[] | null;
  creativeType?: string | null;
  allowNoLogo?: boolean | null;
}

// ─── Synchronous SHA-256 (no dependency; mirrors the server canonical digest) ───

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const;

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

export function sha256Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const bitLenHi = Math.floor(bytes.length / 0x20000000);
  const bitLenLo = bytes.length << 3;
  const paddedLen = (((bytes.length + 8) >> 6) + 1) << 6;
  const padded = new Uint8Array(paddedLen);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLen - 8, bitLenHi);
  view.setUint32(paddedLen - 4, bitLenLo);

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;

  const w = new Uint32Array(64);
  for (let block = 0; block < paddedLen; block += 64) {
    for (let t = 0; t < 16; t++) {
      w[t] = view.getUint32(block + t * 4);
    }
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + SHA256_K[t] + w[t]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + temp1) | 0;
      d = c; c = b; b = a; a = (temp1 + temp2) | 0;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
  }

  const out = new DataView(new ArrayBuffer(32));
  out.setUint32(0, h0); out.setUint32(4, h1); out.setUint32(8, h2); out.setUint32(12, h3);
  out.setUint32(16, h4); out.setUint32(20, h5); out.setUint32(24, h6); out.setUint32(28, h7);
  return Array.from(new Uint8Array(out.buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

// ─── Canonicalization (mirrors api/lib/creative/image-render-claim.ts) ───

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    const obj = value as Record<string, unknown>;
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = sortKeys(obj[key]);
    }
    return sorted;
  }
  return value;
}

function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function normalizeOptionalText(value: string | null | undefined): string {
  return (value ?? "").trim();
}

// Renderer semantics: brand colour order is positional (index 0 → primary,
// 1 → secondary, 2 → accent), so order is preserved. Colour semantics are
// case-insensitive (hex parsing in every render consumer), so values are
// uppercased to match the server-side normaliseHex convention.
export function normalizeBrandColors(value: string[] | null | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim().toUpperCase() : ""))
    .filter((entry) => entry.length > 0);
}

/**
 * Normalized canonical form of all ten material intent fields. Raw
 * refinement/guidance text is reduced to an inner digest before it is used
 * anywhere key-shaped, so no raw client text ever leaves this module.
 */
export function canonicalizeMaterialIntent(
  intent: ImageRenderMaterialIntentInput
): Record<string, unknown> {
  return {
    regenerate: intent.regenerate === true,
    forceRegenerate: intent.forceRegenerate === true,
    refinementInstructionHash: sha256Hex(normalizeOptionalText(intent.refinementInstruction)),
    creativeGuidanceHash: sha256Hex(normalizeOptionalText(intent.creativeGuidance)),
    strongerBrandFit: intent.strongerBrandFit === true,
    provider: normalizeOptionalText(intent.provider) || "v2",
    templateId: normalizeOptionalText(intent.templateId) || "auto",
    brandColors: normalizeBrandColors(intent.brandColors),
    creativeType: normalizeOptionalText(intent.creativeType) || "leaflet",
    allowNoLogo: intent.allowNoLogo === true,
  };
}

export function computeMaterialIntentFingerprint(intent: ImageRenderMaterialIntentInput): string {
  return sha256Hex(canonicalize(canonicalizeMaterialIntent(intent)));
}

// ─── Storage ───

export interface ClientAttemptStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

/**
 * sessionStorage-backed store, fail-safe by design: any storage failure
 * (private mode, quota, disabled cookies, SSR) degrades to an in-memory
 * fallback so the image-generation UI never crashes. sessionStorage is
 * probed before use and accessed only behind a window guard.
 */
export function createClientAttemptStore(): ClientAttemptStore {
  const memory = new Map<string, string>();
  let session: Storage | null = null;
  try {
    if (typeof window !== "undefined" && window.sessionStorage) {
      const probe = "__natforge_client_attempt_probe__";
      window.sessionStorage.setItem(probe, "1");
      window.sessionStorage.removeItem(probe);
      session = window.sessionStorage;
    }
  } catch {
    session = null;
  }
  return {
    get(key) {
      try {
        if (session) return session.getItem(key);
      } catch {
        // fall through to memory
      }
      return memory.get(key) ?? null;
    },
    set(key, value) {
      try {
        if (session) {
          session.setItem(key, value);
          return;
        }
      } catch {
        // fall through to memory
      }
      memory.set(key, value);
    },
    remove(key) {
      try {
        session?.removeItem(key);
      } catch {
        // ignore
      }
      memory.delete(key);
    },
  };
}

export interface ClientAttemptScope {
  userId: number;
  contentPostId: number;
  intent: ImageRenderMaterialIntentInput;
}

export function computeClientAttemptStorageKey(scope: ClientAttemptScope): string {
  return [
    "natforge",
    "client-attempt",
    "v1",
    `u${scope.userId}`,
    `p${scope.contentPostId}`,
    `op:${IMAGE_RENDER_OPERATION_KIND}`,
    `fp:${computeMaterialIntentFingerprint(scope.intent)}`,
  ].join(":");
}

interface StoredClientAttempt {
  token: string;
  state: "in_flight" | "ambiguous";
  updatedAt: string;
}

function parseStoredAttempt(raw: string | null): StoredClientAttempt | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredClientAttempt>;
    if (
      typeof parsed?.token === "string" &&
      CLIENT_ATTEMPT_ID_PATTERN.test(parsed.token) &&
      (parsed.state === "in_flight" || parsed.state === "ambiguous")
    ) {
      return {
        token: parsed.token,
        state: parsed.state,
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
      };
    }
  } catch {
    // malformed entries fail safe
  }
  return null;
}

// ─── Error classification ───
//
// Definitive = the current boundary proves no paid work started: authn/authz,
// rate limit, post not found, and provider-not-configured all reject before
// rendering. Everything else — including PAYMENT_REQUIRED (which can also
// originate at the post-render deduction step), BAD_REQUEST content-policy
// rejections, INTERNAL_SERVER_ERROR and every transport/gateway failure — is
// ambiguous, because the client cannot prove the render/deduction boundary
// was not crossed. "Not charged" is never inferred from a message substring.

export type ClientAttemptErrorClassification = "definitive" | "ambiguous";

export function classifyImageRenderAttemptError(
  err: unknown
): ClientAttemptErrorClassification {
  const code =
    (err as { data?: { code?: string } } | null | undefined)?.data?.code ??
    (err as { code?: string } | null | undefined)?.code;
  switch (code) {
    case "UNAUTHORIZED":
    case "FORBIDDEN":
    case "NOT_FOUND":
    case "TOO_MANY_REQUESTS":
    case "NOT_IMPLEMENTED":
      return "definitive";
    default:
      return "ambiguous";
  }
}

// ─── Controller ───

export type BeginAttemptResult =
  | { status: "ready"; storageKey: string; token: string; reusedRetainedToken: boolean }
  | { status: "blocked_in_flight"; storageKey: string };

/**
 * Small deterministic controller; storage, mint and submit are injectable for
 * tests. The in-flight map is a plain synchronous Map (not React state), so
 * two clicks in the same render tick observe the first submission and submit
 * exactly once with one token.
 */
export class ImageRenderAttemptController {
  private readonly store: ClientAttemptStore;
  private readonly mint: () => string;
  private readonly inFlight = new Map<string, string>();
  // In-memory retention mirror. sessionStorage is best-effort: when it is
  // unavailable or failing, retained tokens still live here for the current
  // page so a same-page retry never mints a second token. Refresh recovery
  // is simply unavailable in that browser condition.
  private readonly memoryRetained = new Map<string, string>();

  constructor(deps: { store?: ClientAttemptStore; mint?: () => string } = {}) {
    this.store = deps.store ?? createClientAttemptStore();
    this.mint = deps.mint ?? (() => crypto.randomUUID());
  }

  // Storage failures must never crash the image-generation UI, even when a
  // custom store is injected; the default store is itself fail-safe.
  private safeGet(key: string): string | null {
    try {
      return this.store.get(key);
    } catch {
      return null;
    }
  }

  private safeSet(key: string, value: string): void {
    try {
      this.store.set(key, value);
    } catch {
      // ignore — retention is best-effort
    }
  }

  private safeRemove(key: string): void {
    try {
      this.store.remove(key);
    } catch {
      // ignore
    }
  }

  private readRetainedEntry(key: string): StoredClientAttempt | null {
    const fromStore = parseStoredAttempt(this.safeGet(key));
    if (fromStore) return fromStore;
    const token = this.memoryRetained.get(key);
    return token ? { token, state: "ambiguous", updatedAt: "" } : null;
  }

  private writeRetained(
    key: string,
    token: string,
    state: StoredClientAttempt["state"]
  ): void {
    this.memoryRetained.set(key, token);
    const entry: StoredClientAttempt = {
      token,
      state,
      updatedAt: new Date().toISOString(),
    };
    this.safeSet(key, JSON.stringify(entry));
  }

  private clearRetained(key: string): void {
    this.memoryRetained.delete(key);
    this.safeRemove(key);
  }

  /**
   * Ordered submission contract (all steps synchronous, before `.mutate()`):
   * 1. caller validated the action and resolved the authoritative user id;
   * 2. the intent-scoped storage key is computed here;
   * 3. the synchronous in-flight guard is checked;
   * 4. a retained token for this exact key is reused, else one is minted;
   * 5. the token is persisted with state "in_flight" BEFORE transmission, so
   *    a refresh/navigate/close/response-loss can recover it as ambiguous;
   * 6. the in-flight guard is set;
   * 7. the caller invokes the mutation exactly once with this token.
   */
  beginAttempt(scope: ClientAttemptScope): BeginAttemptResult {
    const storageKey = computeClientAttemptStorageKey(scope);
    // Synchronous same-tick guard: same logical submission already pending.
    if (this.inFlight.has(storageKey)) {
      return { status: "blocked_in_flight", storageKey };
    }
    const retained = this.readRetainedEntry(storageKey);
    const token = retained?.token ?? this.mint();
    this.writeRetained(storageKey, token, "in_flight");
    this.inFlight.set(storageKey, token);
    return {
      status: "ready",
      storageKey,
      token,
      reusedRetainedToken: retained !== null,
    };
  }

  /** Confirmed success: remove the stored token and clear the in-flight guard. */
  succeed(storageKey: string): void {
    this.inFlight.delete(storageKey);
    this.clearRetained(storageKey);
  }

  /** Definitive pre-work rejection: remove the stored token, clear the guard. */
  failDefinitive(storageKey: string): void {
    this.inFlight.delete(storageKey);
    this.clearRetained(storageKey);
  }

  /**
   * Ambiguous outcome (timeout, 5xx, transport failure, ...): retain the same
   * token under its intent-scoped key and mark it "ambiguous" so an
   * unchanged-intent retry reuses it. No TTL is applied — retained entries
   * never expire automatically; an "in_flight" entry left behind by a
   * refresh is treated as ambiguous on recovery.
   */
  failAmbiguous(storageKey: string, token: string): void {
    this.inFlight.delete(storageKey);
    this.writeRetained(storageKey, token, "ambiguous");
  }

  isInFlight(storageKey: string): boolean {
    return this.inFlight.has(storageKey);
  }

  readRetained(storageKey: string): { token: string } | null {
    const retained = this.readRetainedEntry(storageKey);
    return retained ? { token: retained.token } : null;
  }
}

/** Mint a fresh client attempt token (crypto.randomUUID, no new dependency). */
export function mintClientAttemptId(): string {
  return crypto.randomUUID();
}
