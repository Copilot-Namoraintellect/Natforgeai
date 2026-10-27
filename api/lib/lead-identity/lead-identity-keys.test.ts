// R6-A — controlled enrichment key tests: normalization bounds, deterministic
// domain-separated hashing, and raw-value non-persistence by construction.

import { describe, it, expect } from "vitest";
import {
  toVerifiedIdentityKey,
  hashIdentityKey,
  normalizeEmailIdentity,
  normalizePhoneIdentity,
  normalizeOpaqueReference,
  MAX_RAW_EVIDENCE_LENGTH,
} from "./lead-identity-keys";
import { LeadIdentityInputError } from "./lead-identity-contract";

describe("email normalization", () => {
  it("trims and lowercases", () => {
    expect(normalizeEmailIdentity("  User@Example.COM ")).toBe("user@example.com");
  });
  it("rejects malformed emails", () => {
    expect(() => normalizeEmailIdentity("not-an-email")).toThrow(LeadIdentityInputError);
    expect(() => normalizeEmailIdentity("a@b")).toThrow(LeadIdentityInputError);
    expect(() => normalizeEmailIdentity("a b@c.com")).toThrow(LeadIdentityInputError);
  });
});

describe("phone normalization", () => {
  it("strips separators and keeps leading +", () => {
    expect(normalizePhoneIdentity("+1 (555) 123-4567")).toBe("+15551234567");
    expect(normalizePhoneIdentity("555 123 4567")).toBe("5551234567");
  });
  it("rejects non-numeric and out-of-range values", () => {
    expect(() => normalizePhoneIdentity("call me maybe")).toThrow(LeadIdentityInputError);
    expect(() => normalizePhoneIdentity("123")).toThrow(LeadIdentityInputError);
    expect(() => normalizePhoneIdentity("+1" + "2".repeat(20))).toThrow(LeadIdentityInputError);
  });
});

describe("opaque reference normalization", () => {
  it("trims and bounds", () => {
    expect(normalizeOpaqueReference("  CUST-123  ")).toBe("CUST-123");
    expect(() => normalizeOpaqueReference("   ")).toThrow(LeadIdentityInputError);
    expect(() => normalizeOpaqueReference("x".repeat(129))).toThrow(LeadIdentityInputError);
    expect(() => normalizeOpaqueReference("bad\x00ref")).toThrow(LeadIdentityInputError);
  });
});

describe("verified key derivation", () => {
  it("maps input types to key types + columns", () => {
    expect(toVerifiedIdentityKey("email", "A@B.com")).toMatchObject({
      keyType: "email_hash",
      column: "emailIdentityHash",
    });
    expect(toVerifiedIdentityKey("phone", "+15551234567").column).toBe("phoneIdentityHash");
    expect(toVerifiedIdentityKey("authenticated_customer_reference", "C-1").keyType).toBe(
      "authenticated_customer_reference"
    );
    expect(toVerifiedIdentityKey("crm_external_reference", "C-1").keyType).toBe("crm_external_reference");
  });

  it("is deterministic and case/format normalized", () => {
    const a = toVerifiedIdentityKey("email", "User@Example.com");
    const b = toVerifiedIdentityKey("email", "  user@example.COM");
    expect(a.hash).toBe(b.hash);
    expect(a.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("domain-separates key types (same raw value, different type → different hash)", () => {
    const email = toVerifiedIdentityKey("email", "value@example.com");
    const phone = toVerifiedIdentityKey("phone", "1234567@x.com".replace(/[^\d]/g, ""));
    expect(email.hash).not.toBe(phone.hash);
    const auth = hashIdentityKey("authenticated_customer_reference", "same");
    const crm = hashIdentityKey("crm_external_reference", "same");
    expect(auth).not.toBe(crm);
  });

  it("rejects oversized raw input before hashing", () => {
    expect(() => toVerifiedIdentityKey("email", "e".repeat(MAX_RAW_EVIDENCE_LENGTH + 1))).toThrow(
      LeadIdentityInputError
    );
    expect(() => toVerifiedIdentityKey("email", "")).toThrow(LeadIdentityInputError);
  });
});
