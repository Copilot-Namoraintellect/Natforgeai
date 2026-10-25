// R6-A — pure derivation tests: identity status/confidence, primary type
// precedence, and the deterministic resolution classifier (MATCH / NO_MATCH /
// CONFLICT / INSUFFICIENT_EVIDENCE). No I/O, no clock.

import { describe, it, expect } from "vitest";
import {
  deriveIdentityStatus,
  deriveIdentityConfidence,
  adoptPrimaryIdentityType,
  classifyIdentityResolution,
  isMergeEligibleStatus,
  sameBusinessScope,
} from "./lead-identity-derivation";

const base = {
  hasActor: true,
  linkingKeyTypes: [] as const,
  hasAuthenticatedCustomerReference: false,
  hasCrmExternalReference: false,
  conflictDetected: false,
};

describe("deriveIdentityStatus", () => {
  it("maps evidence to status deterministically", () => {
    expect(deriveIdentityStatus("active", base)).toBe("active");
    expect(deriveIdentityStatus("anonymous", { ...base, hasActor: false })).toBe("anonymous");
    expect(
      deriveIdentityStatus("active", { ...base, linkingKeyTypes: ["email_hash"] })
    ).toBe("partially_identified");
    expect(
      deriveIdentityStatus("anonymous", { ...base, hasActor: false, linkingKeyTypes: ["phone_hash"] })
    ).toBe("partially_identified");
    expect(
      deriveIdentityStatus("active", {
        ...base,
        linkingKeyTypes: ["email_hash", "phone_hash"],
      })
    ).toBe("resolved");
    expect(
      deriveIdentityStatus("active", {
        ...base,
        hasAuthenticatedCustomerReference: true,
        linkingKeyTypes: ["authenticated_customer_reference"],
      })
    ).toBe("resolved");
    expect(
      deriveIdentityStatus("active", {
        ...base,
        hasCrmExternalReference: true,
        linkingKeyTypes: ["crm_external_reference"],
      })
    ).toBe("resolved");
  });

  it("conflict detection sets conflicting and is sticky", () => {
    expect(deriveIdentityStatus("active", { ...base, conflictDetected: true })).toBe("conflicting");
    expect(deriveIdentityStatus("conflicting", base)).toBe("conflicting");
  });

  it("terminal statuses are never re-derived", () => {
    expect(deriveIdentityStatus("suppressed", { ...base, linkingKeyTypes: ["email_hash"] })).toBe("suppressed");
    expect(deriveIdentityStatus("merged", base)).toBe("merged");
    expect(deriveIdentityStatus("archived", base)).toBe("archived");
  });
});

describe("deriveIdentityConfidence", () => {
  it("follows the bounded ordinal rules", () => {
    expect(
      deriveIdentityConfidence({ hasActor: false, handoffObservationCount: 0, linkingKeyTypeCount: 0, hasAuthenticatedCustomerReference: false })
    ).toBe("unknown");
    expect(
      deriveIdentityConfidence({ hasActor: true, handoffObservationCount: 1, linkingKeyTypeCount: 0, hasAuthenticatedCustomerReference: false })
    ).toBe("low");
    expect(
      deriveIdentityConfidence({ hasActor: true, handoffObservationCount: 2, linkingKeyTypeCount: 0, hasAuthenticatedCustomerReference: false })
    ).toBe("medium");
    expect(
      deriveIdentityConfidence({ hasActor: true, handoffObservationCount: 1, linkingKeyTypeCount: 1, hasAuthenticatedCustomerReference: false })
    ).toBe("medium");
    expect(
      deriveIdentityConfidence({ hasActor: true, handoffObservationCount: 1, linkingKeyTypeCount: 2, hasAuthenticatedCustomerReference: false })
    ).toBe("high");
    expect(
      deriveIdentityConfidence({ hasActor: true, handoffObservationCount: 2, linkingKeyTypeCount: 1, hasAuthenticatedCustomerReference: false })
    ).toBe("high");
    expect(
      deriveIdentityConfidence({ hasActor: true, handoffObservationCount: 1, linkingKeyTypeCount: 1, hasAuthenticatedCustomerReference: true })
    ).toBe("high");
  });
});

describe("adoptPrimaryIdentityType", () => {
  it("adopts stronger tiers only; equal tier keeps first-evidenced", () => {
    expect(adoptPrimaryIdentityType("provider_actor", "email_hash")).toBe("email_hash");
    expect(adoptPrimaryIdentityType("email_hash", "phone_hash")).toBe("email_hash");
    expect(adoptPrimaryIdentityType("email_hash", "authenticated_customer_reference")).toBe(
      "authenticated_customer_reference"
    );
    expect(adoptPrimaryIdentityType("anonymous_thread", "provider_actor")).toBe("provider_actor");
    expect(adoptPrimaryIdentityType("authenticated_customer_reference", "email_hash")).toBe(
      "authenticated_customer_reference"
    );
  });
});

describe("classifyIdentityResolution", () => {
  const candidate = {
    leadId: "lid1:a",
    businessScope: 1,
    identityStatus: "active" as const,
    emailIdentityHash: null,
    phoneIdentityHash: null,
    customerReferenceHash: null,
  };

  it("MATCH when actor coordinates match an existing identity", () => {
    const decision = classifyIdentityResolution(
      { actorKey: "actor-x", provider: "meta", crossChannel: false },
      candidate,
      null
    );
    expect(decision.verdict).toBe("MATCH");
    expect(decision.requiresMerge).toBe(false);
  });

  it("NO_MATCH when nothing matches", () => {
    const decision = classifyIdentityResolution(
      { actorKey: "actor-y", provider: "meta", crossChannel: false },
      null,
      null
    );
    expect(decision.verdict).toBe("NO_MATCH");
  });

  it("MATCH + requiresMerge on shared authoritative key within one business scope", () => {
    const decision = classifyIdentityResolution(
      { actorKey: "actor-y", provider: "linkedin", crossChannel: true, emailHash: "h".repeat(64) },
      { ...candidate, leadId: "lid1:b" },
      { ...candidate, leadId: "lid1:a", keyType: "email_hash" }
    );
    expect(decision.verdict).toBe("MATCH");
    expect(decision.requiresMerge).toBe(true);
  });

  it("CONFLICT when the key owner is in a different business scope", () => {
    const decision = classifyIdentityResolution(
      { actorKey: "actor-y", provider: "linkedin", emailHash: "h".repeat(64) },
      candidate,
      { ...candidate, leadId: "lid1:z", businessScope: 2, keyType: "email_hash" }
    );
    expect(decision.verdict).toBe("CONFLICT");
    expect(decision.requiresMerge).toBe(false);
  });

  it("CONFLICT when the key owner is terminal", () => {
    const decision = classifyIdentityResolution(
      { actorKey: "actor-y", provider: "linkedin", emailHash: "h".repeat(64) },
      candidate,
      { ...candidate, leadId: "lid1:z", identityStatus: "suppressed", keyType: "email_hash" }
    );
    expect(decision.verdict).toBe("CONFLICT");
  });

  it("INSUFFICIENT_EVIDENCE for cross-channel questions with only actor evidence", () => {
    const decision = classifyIdentityResolution(
      { actorKey: "actor-y", provider: "linkedin", crossChannel: true },
      null,
      null
    );
    expect(decision.verdict).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("same-identity key binding is MATCH without merge", () => {
    const decision = classifyIdentityResolution(
      { actorKey: "actor-x", provider: "meta", emailHash: "h".repeat(64) },
      candidate,
      { ...candidate, keyType: "email_hash" }
    );
    expect(decision.verdict).toBe("MATCH");
    expect(decision.requiresMerge).toBe(false);
  });
});

describe("eligibility helpers", () => {
  it("merge eligibility is limited to non-terminal statuses", () => {
    expect(isMergeEligibleStatus("active")).toBe(true);
    expect(isMergeEligibleStatus("anonymous")).toBe(true);
    expect(isMergeEligibleStatus("partially_identified")).toBe(true);
    expect(isMergeEligibleStatus("resolved")).toBe(true);
    expect(isMergeEligibleStatus("suppressed")).toBe(false);
    expect(isMergeEligibleStatus("merged")).toBe(false);
    expect(isMergeEligibleStatus("archived")).toBe(false);
    expect(isMergeEligibleStatus("conflicting")).toBe(false);
  });

  it("business scope comparison normalizes null as tenant-unattributed", () => {
    expect(sameBusinessScope(null, null)).toBe(true);
    expect(sameBusinessScope(1, 1)).toBe(true);
    expect(sameBusinessScope(1, null)).toBe(false);
    expect(sameBusinessScope(1, 2)).toBe(false);
  });
});
