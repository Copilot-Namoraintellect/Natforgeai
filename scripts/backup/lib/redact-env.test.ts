import { describe, expect, it } from "vitest";
import { redactEnv } from "./redact-env";

describe("redact-env", () => {
  it("redacts secret values and keeps flags/numbers/urls", () => {
    const env = [
      "# comment",
      "APP_SECRET=topsecretvalue",
      "DATABASE_URL=mysql://u:p@h:3306/db",
      "ENABLE_PREMIUM_VIDEO=true",
      "SMTP_PORT=587",
      "PUBLIC_APP_URL=https://natforgeai.com",
      "OPENAI_IMAGE_MODEL=gpt-image-1",
      "META_APP_SECRET=abc123",
      "EMPTY_VAR=",
    ].join("\n");
    const inv = redactEnv(env);
    const byKey = Object.fromEntries(inv.entries.map((e) => [e.key, e]));
    expect(byKey.APP_SECRET.value).toBe("<redacted>");
    expect(byKey.APP_SECRET.redacted).toBe(true);
    expect(byKey.DATABASE_URL.value).toBe("<redacted>");
    expect(byKey.META_APP_SECRET.redacted).toBe(true);
    expect(byKey.ENABLE_PREMIUM_VIDEO.value).toBe("true");
    expect(byKey.SMTP_PORT.value).toBe("587");
    expect(byKey.PUBLIC_APP_URL.value).toBe("https://natforgeai.com");
    expect(byKey.OPENAI_IMAGE_MODEL.value).toBe("gpt-image-1");
    expect(byKey.EMPTY_VAR.value).toBe("");
    expect(inv.entryCount).toBe(inv.entries.length);
  });

  it("never leaks a credential-bearing URL even under safe keys", () => {
    const inv = redactEnv("PUBLIC_APP_URL=https://user:pass@example.com/x");
    expect(inv.entries[0].redacted).toBe(true);
    expect(inv.entries[0].value).toBe("<redacted>");
  });

  it("strips surrounding quotes", () => {
    const inv = redactEnv('APP_SECRET="quoted-secret"\nFLAG="true"');
    const byKey = Object.fromEntries(inv.entries.map((e) => [e.key, e]));
    expect(byKey.APP_SECRET.value).toBe("<redacted>");
    expect(byKey.FLAG.value).toBe("true");
  });

  it("sorts entries deterministically", () => {
    const a = redactEnv("B=1\nA=2");
    expect(a.entries.map((e) => e.key)).toEqual(["A", "B"]);
  });
});
