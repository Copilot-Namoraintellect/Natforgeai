import { describe, expect, it } from "vitest";
import {
  R5_BLOCKER_CLASSES,
  R5_BLOCKER_CLASS_POLICY,
  R5_RECOVERY_CLASSES,
  isR5BlockerClass,
  isSystemRetryAllowed,
  mapFailureCodeToBlockerClass,
  recoveryClassFor,
} from "./r5-blocker-taxonomy";

describe("R5 blocker taxonomy — controlled vocabulary", () => {
  it("defines the fifteen charter blocker classes exactly", () => {
    expect([...R5_BLOCKER_CLASSES].sort()).toEqual(
      [
        "BUDGET_EXHAUSTED",
        "MALFORMED_EXTERNAL_PAYLOAD",
        "MODEL_CONFIGURATION_MISSING",
        "MODEL_TIMEOUT",
        "OWNERSHIP_MISMATCH",
        "POLICY_REQUIRES_APPROVAL",
        "PROVIDER_AUTH_EXPIRED",
        "PROVIDER_SCOPE_MISSING",
        "QUEUE_UNAVAILABLE",
        "QUOTA_EXHAUSTED",
        "RATE_LIMITED",
        "REDIS_UNAVAILABLE",
        "SECURITY_REJECTION",
        "STALE_OPERATION",
        "UNSUPPORTED_PROVIDER_CAPABILITY",
      ].sort()
    );
  });

  it("every blocker class has a policy with a valid recovery class", () => {
    for (const blockerClass of R5_BLOCKER_CLASSES) {
      const policy = R5_BLOCKER_CLASS_POLICY[blockerClass];
      expect(policy).toBeDefined();
      expect(R5_RECOVERY_CLASSES).toContain(policy.recoveryClass);
      expect(policy.rationale.length).toBeGreaterThan(0);
    }
  });

  it("recognizes valid blocker classes and rejects free text", () => {
    expect(isR5BlockerClass("RATE_LIMITED")).toBe(true);
    expect(isR5BlockerClass("force_publish")).toBe(false);
    expect(isR5BlockerClass("ADMIN_BYPASS")).toBe(false);
  });
});

describe("R5 blocker taxonomy — recovery classification policy", () => {
  it("transient infrastructure failures are AUTO_RECOVER and system-retryable", () => {
    for (const blockerClass of ["RATE_LIMITED", "QUEUE_UNAVAILABLE", "REDIS_UNAVAILABLE", "MODEL_TIMEOUT"] as const) {
      expect(recoveryClassFor(blockerClass)).toBe("AUTO_RECOVER");
      expect(isSystemRetryAllowed(blockerClass)).toBe(true);
    }
  });

  it("credential/scope/config conditions are OPERATOR_ACTION and never system-retryable", () => {
    for (const blockerClass of [
      "PROVIDER_AUTH_EXPIRED",
      "PROVIDER_SCOPE_MISSING",
      "MODEL_CONFIGURATION_MISSING",
      "UNSUPPORTED_PROVIDER_CAPABILITY",
      "STALE_OPERATION",
    ] as const) {
      expect(recoveryClassFor(blockerClass)).toBe("OPERATOR_ACTION");
      expect(isSystemRetryAllowed(blockerClass)).toBe(false);
    }
  });

  it("human-decision conditions are GOVERNANCE_APPROVAL and never auto-approved", () => {
    for (const blockerClass of ["POLICY_REQUIRES_APPROVAL", "BUDGET_EXHAUSTED", "QUOTA_EXHAUSTED"] as const) {
      expect(recoveryClassFor(blockerClass)).toBe("GOVERNANCE_APPROVAL");
      expect(isSystemRetryAllowed(blockerClass)).toBe(false);
    }
  });

  it("security/ownership/malformed conditions are FAIL_CLOSED", () => {
    for (const blockerClass of ["OWNERSHIP_MISMATCH", "MALFORMED_EXTERNAL_PAYLOAD", "SECURITY_REJECTION"] as const) {
      expect(recoveryClassFor(blockerClass)).toBe("FAIL_CLOSED");
      expect(isSystemRetryAllowed(blockerClass)).toBe(false);
    }
  });
});

describe("R5 blocker taxonomy — failure code mapping", () => {
  it("maps provider auth patterns", () => {
    expect(mapFailureCodeToBlockerClass("provider_token_expired")).toBe("PROVIDER_AUTH_EXPIRED");
    expect(mapFailureCodeToBlockerClass("oauth_unauthorized_401")).toBe("PROVIDER_AUTH_EXPIRED");
    expect(mapFailureCodeToBlockerClass("invalid_grant")).toBe("PROVIDER_AUTH_EXPIRED");
  });

  it("maps throttling and timeouts", () => {
    expect(mapFailureCodeToBlockerClass("http_429_rate_limited")).toBe("RATE_LIMITED");
    expect(mapFailureCodeToBlockerClass("provider_timeout")).toBe("MODEL_TIMEOUT");
    expect(mapFailureCodeToBlockerClass("redis_connection_lost")).toBe("REDIS_UNAVAILABLE");
    expect(mapFailureCodeToBlockerClass("queue_unavailable")).toBe("QUEUE_UNAVAILABLE");
  });

  it("maps security-sensitive patterns before generic auth", () => {
    expect(mapFailureCodeToBlockerClass("cross_business_ownership_mismatch")).toBe("OWNERSHIP_MISMATCH");
    expect(mapFailureCodeToBlockerClass("malformed_webhook_payload")).toBe("MALFORMED_EXTERNAL_PAYLOAD");
    expect(mapFailureCodeToBlockerClass("policy_deny_safety")).toBe("SECURITY_REJECTION");
  });

  it("maps scope and capability gaps", () => {
    expect(mapFailureCodeToBlockerClass("insufficient_scope_pages_read")).toBe("PROVIDER_SCOPE_MISSING");
    expect(mapFailureCodeToBlockerClass("capability_unsupported_platform")).toBe("UNSUPPORTED_PROVIDER_CAPABILITY");
    expect(mapFailureCodeToBlockerClass("model_not_configured")).toBe("MODEL_CONFIGURATION_MISSING");
  });

  it("returns null for unknown codes rather than guessing", () => {
    expect(mapFailureCodeToBlockerClass(null)).toBeNull();
    expect(mapFailureCodeToBlockerClass("")).toBeNull();
    expect(mapFailureCodeToBlockerClass("something_weird")).toBeNull();
  });
});
