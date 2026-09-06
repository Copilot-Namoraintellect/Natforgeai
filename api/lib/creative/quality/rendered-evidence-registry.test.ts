import { describe, expect, it } from "vitest";

import { createTrustedRenderedCreativeEvidence } from "./rendered-creative-test-fixtures";
import { InMemoryRenderedEvidenceRegistry } from "./rendered-evidence-registry";

const identity = {
  workflowOperationId: "operation-1",
  contractFingerprint: "contract-1",
  candidateId: "candidate-1",
};

describe("InMemoryRenderedEvidenceRegistry", () => {
  it("stores only the exact trusted object and permits its idempotent replay", async () => {
    const registry = new InMemoryRenderedEvidenceRegistry();
    const evidence = await createTrustedRenderedCreativeEvidence();
    const bound = { ...identity, renderedAssetFingerprint: evidence.renderedAssetFingerprint };

    expect(registry.register(bound, evidence).status).toBe("stored");
    expect(registry.register(bound, evidence).status).toBe("idempotent_replay");
    expect(registry.find(bound)).toBe(evidence);
    expect(registry.register(bound, { ...evidence }).status).toBe("rejected_untrusted");
  });

  it("rejects fingerprint mismatches and conflicting trusted duplicates", async () => {
    const registry = new InMemoryRenderedEvidenceRegistry();
    const first = await createTrustedRenderedCreativeEvidence();
    const second = await createTrustedRenderedCreativeEvidence();
    const bound = { ...identity, renderedAssetFingerprint: first.renderedAssetFingerprint };

    expect(registry.register({ ...bound, renderedAssetFingerprint: "wrong" }, first).status).toBe("rejected_identity_mismatch");
    expect(registry.register(bound, first).status).toBe("stored");
    expect(registry.register(bound, second).status).toBe("rejected_conflicting_duplicate");
  });

  it("isolates evidence between registry instances and identity keys", async () => {
    const firstRegistry = new InMemoryRenderedEvidenceRegistry();
    const secondRegistry = new InMemoryRenderedEvidenceRegistry();
    const evidence = await createTrustedRenderedCreativeEvidence();
    const bound = { ...identity, renderedAssetFingerprint: evidence.renderedAssetFingerprint };

    firstRegistry.register(bound, evidence);
    expect(secondRegistry.find(bound)).toBeNull();
    expect(firstRegistry.find({ ...bound, workflowOperationId: "operation-2" })).toBeNull();
  });
});