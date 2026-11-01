/**
 * R10-F — Production-security primitives: unit tests (F5).
 *
 * Synthetic fixtures only — no real secrets. Covers: shape detection
 * (incl. prose false-positive guards), deep redaction across all surfaces,
 * the model-payload guard, the F2 classification map and the least-privilege
 * broker (agents denied; break-glass unreadable by any runtime identity).
 */
import { describe, it, expect } from "vitest";
import {
  detectSecretShapes,
  containsSecretShape,
  maskSecretShapes,
  classifyEnvVar,
  mayRead,
  SECRET_CLASS_READERS,
  SERVICE_IDENTITIES,
  redactDeep,
  redactForLog,
  redactForError,
  redactForCallback,
  redactForDiagnostics,
  REDACTED,
  scanPayloadForSecrets,
  assertSecretFreeModelPayload,
  isSecretFreeModelPayload,
  ModelPayloadSecretError,
  createSecretBroker,
  SecretAccessDeniedError,
  type ServiceIdentity,
} from "./index";

// ── Synthetic fixtures (documented, non-real) ──────────────────────────
const SYNTHETIC = {
  openaiLike: "sk-live-abc123def456ghi789",
  googleLike: "AIzaSyD4iE7xn0aF2bC9mK1pL8qR5tW3yU6xZ0ab",
  awsLike: "AKIAIOSFODNN7EXAMPLE",
  githubLike: "ghp_abcdefghij1234567890abcdef",
  // Built by concatenation: the repo must never contain a Stripe-shaped
  // literal (push-protection proves scanners match them even in fixtures).
  stripeLike: `sk_${"live_"}${"4eC39HqLyjWDar"}${"jtT1zdp7dc"}`,
  jwtLike:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c",
  dsnLike: "mysql://app_user:hunter2@db.internal:3306/natforge_prod",
  bearerLike: "Bearer abcdef1234567890abcdef1234567890xyz",
};

describe("secret shape detection", () => {
  it("detects each synthetic vendor shape", () => {
    expect(detectSecretShapes(`key=${SYNTHETIC.openaiLike}`)).toContain("OPENAI_KEY");
    expect(detectSecretShapes(`key: ${SYNTHETIC.googleLike}`)).toContain("GOOGLE_API_KEY");
    expect(detectSecretShapes(SYNTHETIC.awsLike)).toContain("AWS_ACCESS_KEY_ID");
    expect(detectSecretShapes(SYNTHETIC.githubLike)).toContain("GITHUB_PAT");
    expect(detectSecretShapes(SYNTHETIC.stripeLike)).toContain("STRIPE_SECRET_KEY");
    expect(detectSecretShapes(SYNTHETIC.jwtLike)).toContain("JWT");
    expect(detectSecretShapes(SYNTHETIC.dsnLike)).toContain("DATABASE_DSN");
    expect(detectSecretShapes(SYNTHETIC.bearerLike)).toContain("BEARER_TOKEN");
  });

  it("detects private key blocks only with material", () => {
    const bareHeader = "-----BEGIN RSA PRIVATE KEY-----";
    expect(containsSecretShape(bareHeader)).toBe(false);
    const withBody = `${bareHeader}\nMIIEpAIBAAKCAQEA7\nMIIEpAIBAAKCAQEA8`;
    expect(detectSecretShapes(withBody)).toContain("PRIVATE_KEY_BLOCK");
  });

  it("never matches prose words containing sk- fragments", () => {
    expect(containsSecretShape("Risk-Intelligence report")).toBe(false);
    expect(containsSecretShape("zendesk-webhook-signature header")).toBe(false);
    expect(containsSecretShape("x-hub-signature-256")).toBe(false);
  });

  it("ignores empty and non-string input", () => {
    expect(detectSecretShapes("")).toEqual([]);
    expect(containsSecretShape("")).toBe(false);
  });

  it("masks shapes in place preserving context", () => {
    const line = `Authorization: ${SYNTHETIC.bearerLike} done`;
    const masked = maskSecretShapes(line);
    expect(masked).not.toContain("abcdef1234567890abcdef1234567890xyz");
    expect(masked).toContain(REDACTED);
    expect(masked).toContain("Authorization:");
  });
});

describe("classification (F2 taxonomy as code)", () => {
  it("classifies the runtime secret population", () => {
    expect(classifyEnvVar("APP_SECRET")).toBe("APPLICATION_SECRET");
    expect(classifyEnvVar("TOKEN_ENCRYPTION_KEY")).toBe("APPLICATION_SECRET");
    expect(classifyEnvVar("DATABASE_URL")).toBe("DATABASE_SECRET");
    expect(classifyEnvVar("MYSQL_URL")).toBe("DATABASE_SECRET");
    expect(classifyEnvVar("REDIS_URL")).toBe("INFRASTRUCTURE_SECRET");
    expect(classifyEnvVar("OPENAI_API_KEY")).toBe("PROVIDER_SECRET");
    expect(classifyEnvVar("STRIPE_SECRET_KEY")).toBe("PROVIDER_SECRET");
    expect(classifyEnvVar("SMTP_PASS")).toBe("PROVIDER_SECRET");
    expect(classifyEnvVar("FIREBASE_SERVICE_ACCOUNT")).toBe("PROVIDER_SECRET");
    expect(classifyEnvVar("GOOGLE_APPLICATION_CREDENTIALS")).toBe("DEPLOYMENT_SECRET");
    expect(classifyEnvVar("BACKUP_ENCRYPTION_KEY")).toBe("BACKUP_SECRET");
    expect(classifyEnvVar("BREAK_GLASS_ADMIN_PASSWORD")).toBe("BREAK_GLASS_SECRET");
  });

  it("classifies non-secret config as public", () => {
    expect(classifyEnvVar("VITE_FIREBASE_API_KEY")).toBe("PUBLIC_CONFIGURATION");
    expect(classifyEnvVar("PORT")).toBe("PUBLIC_CONFIGURATION");
    expect(classifyEnvVar("ENABLE_PREMIUM_VIDEO")).toBe("PUBLIC_CONFIGURATION");
    expect(classifyEnvVar("PREMIUM_IMAGE_CREDITS")).toBe("PUBLIC_CONFIGURATION");
    expect(classifyEnvVar("CREATIVE_PIPELINE_V2_MODE")).toBe("PUBLIC_CONFIGURATION");
  });

  it("fails closed for unknown secret-looking names", () => {
    expect(classifyEnvVar("MYSTERY_CREDENTIAL")).toBe("PROVIDER_SECRET");
    expect(classifyEnvVar("RANDOM_THING")).toBe("APPLICATION_SECRET");
  });

  it("agent-runtime appears in no secret-class reader list; break-glass has no readers", () => {
    for (const cls of Object.keys(SECRET_CLASS_READERS) as Array<keyof typeof SECRET_CLASS_READERS>) {
      if (cls === "PUBLIC_CONFIGURATION") continue; // public config is not secret material
      expect(SECRET_CLASS_READERS[cls]).not.toContain("agent-runtime");
    }
    expect(SECRET_CLASS_READERS.BREAK_GLASS_SECRET).toHaveLength(0);
    expect(SECRET_CLASS_READERS.DEPLOYMENT_SECRET).toEqual(["deployment"]);
    expect(SECRET_CLASS_READERS.BACKUP_SECRET).toEqual(["backup"]);
  });

  it("application runtime classes exclude admin identities", () => {
    for (const cls of ["APPLICATION_SECRET", "DATABASE_SECRET", "PROVIDER_SECRET", "INFRASTRUCTURE_SECRET"] as const) {
      const readers = SECRET_CLASS_READERS[cls];
      expect(readers).not.toContain("deployment");
      expect(readers).not.toContain("backup");
    }
    // ...except DATABASE/INFRASTRUCTURE which migration-admin legitimately needs.
    expect(SECRET_CLASS_READERS.DATABASE_SECRET).toContain("migration-admin");
    expect(SECRET_CLASS_READERS.INFRASTRUCTURE_SECRET).toContain("migration-admin");
  });
});

describe("deep redaction (logs / errors / callbacks / diagnostics)", () => {
  it("redacts sensitive keys at every nesting level", () => {
    const payload = {
      stage: "render",
      config: { nested: { password: "hunter2-hunter2", apiKey: null, note: "ok" } },
      list: [{ clientSecret: "abcd1234abcd1234abcd1234" }],
    };
    const out = redactDeep(payload) as any;
    expect(out.config.nested.password).toBe(REDACTED);
    expect(out.config.nested.apiKey).toBe(null); // empty stays
    expect(out.config.nested.note).toBe("ok");
    expect(out.list[0].clientSecret).toBe(REDACTED);
    expect(out.stage).toBe("render");
  });

  it("masks secret shapes inside larger string values", () => {
    const out = redactForLog({
      providerResponse: `failed with key ${SYNTHETIC.openaiLike} for user`,
      bareKey: SYNTHETIC.openaiLike,
    }) as any;
    expect(String(out.providerResponse)).not.toContain("abc123def456ghi789");
    expect(String(out.providerResponse)).toContain("for user");
    expect(out.bareKey).toBe(REDACTED);
  });

  it("masks URL query credentials", () => {
    const out = redactForLog({ url: "https://api.example.com/v1?api_key=supersecretvalue123&x=1" }) as any;
    expect(String(out.url)).not.toContain("supersecretvalue123");
    expect(String(out.url)).toContain("x=1");
  });

  it("error surface carries message only, masked", () => {
    const err = new Error(`connect failed password=hunter2andmore using ${SYNTHETIC.bearerLike}`);
    (err as any).stack = "SECRET_STACK";
    (err as any).extra = { password: "x" };
    const safe = redactForError(err);
    expect(safe.message).not.toContain("hunter2andmore");
    expect(safe.message).not.toContain("abcdef1234567890");
    expect(JSON.stringify(safe)).not.toContain("SECRET_STACK");
    expect(JSON.stringify(safe)).not.toContain('"extra"');
  });

  it("callback and diagnostics surfaces redact deeply", () => {
    const callback = { entry: [{ headers: { authorization: `Bearer ${SYNTHETIC.jwtLike}` } }] };
    const cb = redactForCallback(callback) as any;
    expect(String(cb.entry[0].headers.authorization)).toBe(REDACTED);

    const diag = redactForDiagnostics({ env: { DATABASE_URL: SYNTHETIC.dsnLike } }) as any;
    expect(diag.env.DATABASE_URL).toBe(REDACTED);
  });

  it("is cycle-safe and depth-capped and never throws", () => {
    const a: any = { name: "a" };
    a.self = a;
    const out: any = redactDeep(a);
    expect(out.self).toBe("[CIRCULAR]");

    let deep: any = { v: "x" };
    for (let i = 0; i < 40; i++) deep = { child: deep };
    const deepOut: any = redactDeep(deep);
    let cursor = deepOut;
    let depth = 0;
    while (cursor && typeof cursor === "object" && cursor.child && cursor.child !== "[MAX_DEPTH]") {
      cursor = cursor.child;
      depth++;
    }
    expect(depth).toBeLessThanOrEqual(13);
  });
});

describe("model payload guard (prompt/context exclusion + output screening)", () => {
  it("passes clean business payloads", () => {
    expect(isSecretFreeModelPayload({ prompt: "Write an Instagram caption for a coffee shop" })).toBe(true);
    assertSecretFreeModelPayload({ context: { audience: "runners in Cape Town" } });
  });

  it("fails closed on secret shapes with path, without the value", () => {
    const findings = scanPayloadForSecrets({ context: { notes: `use ${SYNTHETIC.openaiLike}` } });
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].path).toBe("payload.context.notes");

    let thrown: ModelPayloadSecretError | null = null;
    try {
      assertSecretFreeModelPayload({ notes: SYNTHETIC.awsLike });
    } catch (err) {
      thrown = err as ModelPayloadSecretError;
    }
    expect(thrown).toBeInstanceOf(ModelPayloadSecretError);
    expect(thrown!.code).toBe("MODEL_PAYLOAD_SECRET_DETECTED");
    expect(thrown!.message).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(thrown!.message).toContain("payload.notes");
  });

  it("flags sensitive keys with non-trivial values (key smuggling)", () => {
    const findings = scanPayloadForSecrets({
      prompt: "format my api response",
      responseShape: { apiKey: "abcdefghijklmnopqrstuv" },
    });
    expect(findings.some((f) => f.kind === "SENSITIVE_KEY_VALUE")).toBe(true);
  });

  it("treats model output as untrusted: shapes in output are findings", () => {
    const out = isSecretFreeModelPayload({ caption: "CTA: visit us", leak: `token ${SYNTHETIC.jwtLike}` });
    expect(out).toBe(false);
  });
});

describe("secret broker (least privilege, deny by default)", () => {
  const source = (name: string): string | undefined =>
    ({
      APP_SECRET: "synthetic-app-secret",
      DATABASE_URL: "mysql://u:p@h/db",
      OPENAI_API_KEY: "sk-live-abc123def456ghi789",
      GOOGLE_APPLICATION_CREDENTIALS: "/tmp/gcp.json",
      BACKUP_ENCRYPTION_KEY: "synthetic-backup-key",
    })[name];

  it("web-api reads application/database/provider secrets it needs", () => {
    const broker = createSecretBroker("web-api", source);
    expect(broker.read("APP_SECRET")).toBe("synthetic-app-secret");
    expect(broker.read("DATABASE_URL")).toBe("mysql://u:p@h/db");
    expect(broker.read("OPENAI_API_KEY")).toBe("sk-live-abc123def456ghi789");
  });

  it("denies deployment/backup/break-glass material to the application runtime", () => {
    const broker = createSecretBroker("web-api", source);
    expect(() => broker.read("GOOGLE_APPLICATION_CREDENTIALS")).toThrow(SecretAccessDeniedError);
    expect(() => broker.read("BACKUP_ENCRYPTION_KEY")).toThrow(SecretAccessDeniedError);
    expect(() => broker.read("BREAK_GLASS_ADMIN_PASSWORD")).toThrow(SecretAccessDeniedError);
  });

  it("agent-runtime cannot mint a broker at all", () => {
    expect(() => createSecretBroker("agent-runtime" as ServiceIdentity, source)).toThrow(SecretAccessDeniedError);
  });

  it("unknown identity cannot mint a broker", () => {
    expect(() => createSecretBroker("not-a-service" as ServiceIdentity, source)).toThrow(SecretAccessDeniedError);
  });

  it("backup identity reads backup material but not application secrets", () => {
    const backup = createSecretBroker("backup", source);
    expect(backup.read("BACKUP_ENCRYPTION_KEY")).toBe("synthetic-backup-key");
    expect(() => backup.read("APP_SECRET")).toThrow(SecretAccessDeniedError);
  });

  it("no runtime identity can read break-glass material", () => {
    for (const identity of SERVICE_IDENTITIES) {
      if (identity === "agent-runtime") continue; // cannot even mint
      const broker = createSecretBroker(identity, source);
      expect(() => broker.read("BREAK_GLASS_ADMIN_PASSWORD")).toThrow(SecretAccessDeniedError);
    }
  });

  it("required() fails closed on unset secrets without leaking values", () => {
    const broker = createSecretBroker("web-api", source);
    expect(() => broker.required("UNSET_SECRET_THING")).toThrow();
    try {
      broker.required("UNSET_SECRET_THING");
    } catch (err) {
      expect(String((err as Error).message)).not.toContain("synthetic-app-secret");
    }
  });

  it("public configuration is not brokered as secret", () => {
    const broker = createSecretBroker("web-api", source);
    expect(broker.classify("PORT")).toBe("PUBLIC_CONFIGURATION");
    expect(mayRead("web-api", "PUBLIC_CONFIGURATION")).toBe(true);
  });
});
