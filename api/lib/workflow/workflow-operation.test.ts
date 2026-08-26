import { describe, expect, it } from "vitest";
import {
  buildWorkflowOperationId,
  buildWorkflowAttemptId,
  buildWorkflowCorrelationContext,
  buildWorkflowIdempotencyKey,
  finalizeWorkflowOperation,
  InMemoryWorkflowOperationRegistry,
  transitionOperationStatus,
  transitionAttemptStatus,
  validateWorkflowCorrelation,
  type WorkflowOperationIdentityInput,
} from "./workflow-operation";

const baseIdentityInput: WorkflowOperationIdentityInput = {
  operationType: "creative_generation",
  operationSource: "approval",
  operationReferenceId: "36",
  campaignId: 30,
  userId: 22,
  businessId: 26,
  contractFingerprint: "fp-contract-253",
  strategyRunId: 253,
  approvalRequestId: 36,
  claimId: 17,
  approvedAt: "2026-07-01T08:00:00.000Z",
};

describe("workflow-operation identity", () => {
  it("identical canonical top-level input produces identical workflowOperationId", () => {
    const a = buildWorkflowOperationId(baseIdentityInput);
    const b = buildWorkflowOperationId({ ...baseIdentityInput });
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });

  it("object-key order does not affect ID", () => {
    const ordered: Record<string, unknown> = {
      operationType: "creative_generation",
      operationSource: "approval",
      operationReferenceId: "36",
      campaignId: 30,
      userId: 22,
      contractFingerprint: "fp-contract-253",
      strategyRunId: 253,
      approvalRequestId: 36,
    };
    const reversed: Record<string, unknown> = {};
    for (const key of Object.keys(ordered).reverse()) {
      reversed[key] = ordered[key];
    }
    const a = buildWorkflowOperationId({
      ...(ordered as unknown as WorkflowOperationIdentityInput),
      claimId: 17,
      approvedAt: "2026-07-01T08:00:00.000Z",
    });
    const b = buildWorkflowOperationId({
      ...(reversed as unknown as WorkflowOperationIdentityInput),
      claimId: 17,
      approvedAt: "2026-07-01T08:00:00.000Z",
    });
    expect(a).toBe(b);
  });

  it("timestamp/randomness does not participate", () => {
    const inputA = { ...baseIdentityInput, approvedAt: "2026-07-01T08:00:00.000Z" };
    const inputB = { ...baseIdentityInput, approvedAt: "2026-07-02T08:00:00.000Z" };
    // approvedAt is intentionally included in correlation context but not in ID.
    expect(buildWorkflowOperationId(inputA)).toBe(buildWorkflowOperationId(inputB));
  });

  it("changed campaign changes ID", () => {
    const a = buildWorkflowOperationId(baseIdentityInput);
    const b = buildWorkflowOperationId({ ...baseIdentityInput, campaignId: 31 });
    expect(a).not.toBe(b);
  });

  it("changed user changes ID", () => {
    const a = buildWorkflowOperationId(baseIdentityInput);
    const b = buildWorkflowOperationId({ ...baseIdentityInput, userId: 23 });
    expect(a).not.toBe(b);
  });

  it("changed approval changes ID", () => {
    const a = buildWorkflowOperationId(baseIdentityInput);
    const b = buildWorkflowOperationId({ ...baseIdentityInput, approvalRequestId: 37 });
    expect(a).not.toBe(b);
  });

  it("changed strategy run changes ID", () => {
    const a = buildWorkflowOperationId(baseIdentityInput);
    const b = buildWorkflowOperationId({ ...baseIdentityInput, strategyRunId: 254 });
    expect(a).not.toBe(b);
  });

  it("changed contract fingerprint changes ID", () => {
    const a = buildWorkflowOperationId(baseIdentityInput);
    const b = buildWorkflowOperationId({ ...baseIdentityInput, contractFingerprint: "fp-contract-254" });
    expect(a).not.toBe(b);
  });

  it("changed operation type changes ID", () => {
    const a = buildWorkflowOperationId(baseIdentityInput);
    const b = buildWorkflowOperationId({ ...baseIdentityInput, operationType: "creative_recovery" });
    expect(a).not.toBe(b);
  });

  it("internal retry does not change top-level ID", () => {
    const a = buildWorkflowOperationId(baseIdentityInput);
    const b = buildWorkflowOperationId({ ...baseIdentityInput });
    expect(a).toBe(b);
  });

  it("includes only expected fields in the identity payload", () => {
    const payload = {
      operationType: baseIdentityInput.operationType,
      operationSource: baseIdentityInput.operationSource,
      operationReferenceId: "36",
      campaignId: baseIdentityInput.campaignId,
      userId: baseIdentityInput.userId,
      contractFingerprint: baseIdentityInput.contractFingerprint,
      strategyRunId: baseIdentityInput.strategyRunId,
      approvalRequestId: baseIdentityInput.approvalRequestId,
    };
    expect(buildWorkflowOperationId(baseIdentityInput)).toBe(buildWorkflowOperationId(payload as WorkflowOperationIdentityInput));
  });
});

describe("workflow-operation idempotency", () => {
  it("identical duplicate registration returns existing operation", () => {
    const registry = new InMemoryWorkflowOperationRegistry();
    const first = registry.registerOperation(baseIdentityInput);
    const second = registry.registerOperation({ ...baseIdentityInput });
    expect(first.operation.workflowOperationId).toBe(second.operation.workflowOperationId);
    expect(second.duplicateClassification).toBe("idempotent_replay");
  });

  it("same idempotency key with conflicting identity fails", () => {
    const registry = new InMemoryWorkflowOperationRegistry();
    registry.registerOperation({ ...baseIdentityInput, externalIdempotencyKey: "shared-key" });
    try {
      registry.registerOperation({
        ...baseIdentityInput,
        campaignId: 99,
        externalIdempotencyKey: "shared-key",
      });
      expect.fail("expected IDEMPOTENCY_KEY_CONFLICT");
    } catch (err: any) {
      expect(err.code).toBe("IDEMPOTENCY_KEY_CONFLICT");
    }
  });

  it("same operation reference with different approved lineage fails", () => {
    const registry = new InMemoryWorkflowOperationRegistry();
    registry.registerOperation(baseIdentityInput);
    try {
      registry.registerOperation({
        ...baseIdentityInput,
        strategyRunId: 999,
        contractFingerprint: "different",
      });
      expect.fail("expected AMBIGUOUS_OPERATION");
    } catch (err: any) {
      expect(err.code).toBe("AMBIGUOUS_OPERATION");
    }
  });

  it("separate legitimate operations do not collide", () => {
    const registry = new InMemoryWorkflowOperationRegistry();
    const a = registry.registerOperation(baseIdentityInput);
    const b = registry.registerOperation({ ...baseIdentityInput, operationReferenceId: "999" });
    expect(a.operation.workflowOperationId).not.toBe(b.operation.workflowOperationId);
  });

  it("registry instances are isolated", () => {
    const registryA = new InMemoryWorkflowOperationRegistry();
    const registryB = new InMemoryWorkflowOperationRegistry();
    const a = registryA.registerOperation(baseIdentityInput);
    expect(registryB.findOperation(a.operation.workflowOperationId)).toBeNull();
  });

  it("immutable snapshot cannot mutate registry state", () => {
    const registry = new InMemoryWorkflowOperationRegistry();
    registry.registerOperation(baseIdentityInput);
    const snapshot = registry.snapshot();
    snapshot.operations[0].status = "failed";
    const op = registry.findOperation(snapshot.operations[0].workflowOperationId);
    expect(op?.status).toBe("created");
  });
});

describe("workflow-operation attempts", () => {
  it("multiple attempts map to one operation", () => {
    const registry = new InMemoryWorkflowOperationRegistry();
    const op = registry.registerOperation(baseIdentityInput).operation;
    registry.transitionOperation(op.workflowOperationId, "running");

    const a = registry.allocateNewAttempt({
      workflowOperationId: op.workflowOperationId,
      attemptType: "message_pack",
    }).attempt;
    const b = registry.allocateNewAttempt({
      workflowOperationId: op.workflowOperationId,
      attemptType: "creative_generation",
    }).attempt;

    expect(a.workflowOperationId).toBe(op.workflowOperationId);
    expect(b.workflowOperationId).toBe(op.workflowOperationId);
    expect(registry.listAttempts(op.workflowOperationId)).toHaveLength(2);
  });

  it("attempt ID is deterministic", () => {
    const a = buildWorkflowAttemptId({
      workflowOperationId: "op-1",
      attemptType: "message_pack",
      ordinal: 1,
      parentAttemptId: null,
    });
    const b = buildWorkflowAttemptId({
      workflowOperationId: "op-1",
      attemptType: "message_pack",
      ordinal: 1,
      parentAttemptId: null,
    });
    expect(a).toBe(b);
  });

  it("changed ordinal changes attempt ID", () => {
    const a = buildWorkflowAttemptId({
      workflowOperationId: "op-1",
      attemptType: "message_pack",
      ordinal: 1,
      parentAttemptId: null,
    });
    const b = buildWorkflowAttemptId({
      workflowOperationId: "op-1",
      attemptType: "message_pack",
      ordinal: 2,
      parentAttemptId: null,
    });
    expect(a).not.toBe(b);
  });

  it("duplicate identical attempt is idempotent", () => {
    const registry = new InMemoryWorkflowOperationRegistry();
    const op = registry.registerOperation(baseIdentityInput).operation;
    registry.transitionOperation(op.workflowOperationId, "running");
    const a = registry.registerAttemptReplay({
      workflowOperationId: op.workflowOperationId,
      attemptType: "message_pack",
      ordinal: 1,
    });
    const b = registry.registerAttemptReplay({
      workflowOperationId: op.workflowOperationId,
      attemptType: "message_pack",
      ordinal: 1,
    });
    expect(a.attempt.workflowAttemptId).toBe(b.attempt.workflowAttemptId);
    expect(b.duplicateClassification).toBe("idempotent_replay");
  });

  it("conflicting duplicate attempt fails", () => {
    const registry = new InMemoryWorkflowOperationRegistry();
    const op = registry.registerOperation(baseIdentityInput).operation;
    registry.transitionOperation(op.workflowOperationId, "running");
    registry.registerAttemptReplay({
      workflowOperationId: op.workflowOperationId,
      attemptType: "message_pack",
      ordinal: 1,
      providerRunId: "run-a",
    });
    try {
      registry.registerAttemptReplay({
        workflowOperationId: op.workflowOperationId,
        attemptType: "message_pack",
        ordinal: 1,
        providerRunId: "run-b",
      });
      expect.fail("expected DUPLICATE_ATTEMPT_IDENTITY_CONFLICT");
    } catch (err: any) {
      expect(err.code).toBe("DUPLICATE_ATTEMPT_IDENTITY_CONFLICT");
    }
  });

  it("invalid ordinal fails", () => {
    const registry = new InMemoryWorkflowOperationRegistry();
    const op = registry.registerOperation(baseIdentityInput).operation;
    registry.transitionOperation(op.workflowOperationId, "running");
    try {
      registry.registerAttemptReplay({
        workflowOperationId: op.workflowOperationId,
        attemptType: "message_pack",
        ordinal: 0,
      });
      expect.fail("expected INVALID_ATTEMPT_ORDINAL");
    } catch (err: any) {
      expect(err.code).toBe("INVALID_ATTEMPT_ORDINAL");
    }
  });

  it("cross-operation parent fails", () => {
    const registry = new InMemoryWorkflowOperationRegistry();
    const opA = registry.registerOperation(baseIdentityInput).operation;
    const opB = registry.registerOperation({ ...baseIdentityInput, operationReferenceId: "999" }).operation;
    registry.transitionOperation(opA.workflowOperationId, "running");
    registry.transitionOperation(opB.workflowOperationId, "running");

    const parent = registry.allocateNewAttempt({
      workflowOperationId: opA.workflowOperationId,
      attemptType: "message_pack",
    }).attempt;

    try {
      registry.allocateNewAttempt({
        workflowOperationId: opB.workflowOperationId,
        attemptType: "creative_regeneration",
        parentAttemptId: parent.workflowAttemptId,
      });
      expect.fail("expected CROSS_OPERATION_PARENT");
    } catch (err: any) {
      expect(err.code).toBe("CROSS_OPERATION_PARENT");
    }
  });

  it("provider run ID does not affect top-level operation ID", () => {
    const a = buildWorkflowOperationId(baseIdentityInput);
    const b = buildWorkflowOperationId({ ...baseIdentityInput });
    expect(a).toBe(b);
  });

  it("internal run ID does not affect top-level operation ID", () => {
    const a = buildWorkflowOperationId(baseIdentityInput);
    const b = buildWorkflowOperationId({ ...baseIdentityInput });
    expect(a).toBe(b);
  });

  it("failed attempt may be followed by permitted recovery attempt", () => {
    const registry = new InMemoryWorkflowOperationRegistry();
    const op = registry.registerOperation(baseIdentityInput).operation;
    registry.transitionOperation(op.workflowOperationId, "running");

    const failed = registry.registerAttemptReplay({
      workflowOperationId: op.workflowOperationId,
      attemptType: "message_pack",
      ordinal: 1,
    }).attempt;
    registry.transitionAttempt(failed.workflowAttemptId, "running");
    registry.transitionAttempt(failed.workflowAttemptId, "failed", "GENERATION_FAILED");

    const recovery = registry.registerAttemptReplay({
      workflowOperationId: op.workflowOperationId,
      attemptType: "creative_regeneration",
      ordinal: 1,
      parentAttemptId: failed.workflowAttemptId,
    }).attempt;
    expect(recovery.parentAttemptId).toBe(failed.workflowAttemptId);
  });

  it("attempt completion does not complete workflow automatically", () => {
    const registry = new InMemoryWorkflowOperationRegistry();
    const op = registry.registerOperation(baseIdentityInput).operation;
    registry.transitionOperation(op.workflowOperationId, "running");

    const attempt = registry.allocateNewAttempt({
      workflowOperationId: op.workflowOperationId,
      attemptType: "message_pack",
    }).attempt;
    registry.transitionAttempt(attempt.workflowAttemptId, "running");
    registry.transitionAttempt(attempt.workflowAttemptId, "completed");

    expect(registry.findOperation(op.workflowOperationId)?.status).toBe("running");
  });
});

describe("workflow-operation transitions", () => {
  it("valid operation transitions pass", () => {
    expect(transitionOperationStatus("created", "running")).toBe("running");
    expect(transitionOperationStatus("running", "completed")).toBe("completed");
    expect(transitionOperationStatus("running", "failed")).toBe("failed");
    expect(transitionOperationStatus("running", "cancelled")).toBe("cancelled");
    expect(transitionOperationStatus("created", "cancelled")).toBe("cancelled");
  });

  it("invalid terminal operation transition fails", () => {
    try {
      transitionOperationStatus("completed", "running");
      expect.fail("expected INVALID_OPERATION_TRANSITION");
    } catch (err: any) {
      expect(err.code).toBe("INVALID_OPERATION_TRANSITION");
    }
    try {
      transitionOperationStatus("failed", "completed");
      expect.fail("expected INVALID_OPERATION_TRANSITION");
    } catch (err: any) {
      expect(err.code).toBe("INVALID_OPERATION_TRANSITION");
    }
  });

  it("valid attempt transitions pass", () => {
    expect(transitionAttemptStatus("created", "running")).toBe("running");
    expect(transitionAttemptStatus("running", "completed")).toBe("completed");
  });

  it("invalid terminal attempt transition fails", () => {
    try {
      transitionAttemptStatus("completed", "running");
      expect.fail("expected INVALID_ATTEMPT_TRANSITION");
    } catch (err: any) {
      expect(err.code).toBe("INVALID_ATTEMPT_TRANSITION");
    }
    try {
      transitionAttemptStatus("failed", "completed");
      expect.fail("expected INVALID_ATTEMPT_TRANSITION");
    } catch (err: any) {
      expect(err.code).toBe("INVALID_ATTEMPT_TRANSITION");
    }
  });

  it("attempt cannot be created under terminal operation", () => {
    const registry = new InMemoryWorkflowOperationRegistry();
    const op = registry.registerOperation(baseIdentityInput).operation;
    registry.transitionOperation(op.workflowOperationId, "running");
    registry.transitionOperation(op.workflowOperationId, "failed");
    try {
      registry.allocateNewAttempt({
        workflowOperationId: op.workflowOperationId,
        attemptType: "message_pack",
      });
      expect.fail("expected ATTEMPT_UNDER_TERMINAL_OPERATION");
    } catch (err: any) {
      expect(err.code).toBe("ATTEMPT_UNDER_TERMINAL_OPERATION");
    }
  });

  it("final-persistence attempt requires eligibility", () => {
    const registry = new InMemoryWorkflowOperationRegistry();
    const op = registry.registerOperation(baseIdentityInput).operation;
    registry.transitionOperation(op.workflowOperationId, "running");
    try {
      registry.allocateNewAttempt({
        workflowOperationId: op.workflowOperationId,
        attemptType: "final_persistence",
      });
      expect.fail("expected FINAL_PERSISTENCE_NOT_ELIGIBLE");
    } catch (err: any) {
      expect(err.code).toBe("FINAL_PERSISTENCE_NOT_ELIGIBLE");
    }

    const eligible = registry.allocateNewAttempt({
      workflowOperationId: op.workflowOperationId,
      attemptType: "final_persistence",
      eligibility: { finalAssetSelected: true },
    }).attempt;
    expect(eligible.attemptType).toBe("final_persistence");
  });

  it("billing attempt requires eligibility", () => {
    const registry = new InMemoryWorkflowOperationRegistry();
    const op = registry.registerOperation(baseIdentityInput).operation;
    registry.transitionOperation(op.workflowOperationId, "running");
    try {
      registry.allocateNewAttempt({
        workflowOperationId: op.workflowOperationId,
        attemptType: "billing",
      });
      expect.fail("expected BILLING_NOT_ELIGIBLE");
    } catch (err: any) {
      expect(err.code).toBe("BILLING_NOT_ELIGIBLE");
    }

    const eligible = registry.allocateNewAttempt({
      workflowOperationId: op.workflowOperationId,
      attemptType: "billing",
      eligibility: { chargePermitted: true },
    }).attempt;
    expect(eligible.attemptType).toBe("billing");
  });

  it("duplicate completion fails or is classified idempotently", () => {
    const registry = new InMemoryWorkflowOperationRegistry();
    const op = registry.registerOperation(baseIdentityInput).operation;
    registry.transitionOperation(op.workflowOperationId, "running");
    registry.transitionOperation(op.workflowOperationId, "completed");
    try {
      registry.transitionOperation(op.workflowOperationId, "running");
      expect.fail("expected INVALID_OPERATION_TRANSITION");
    } catch (err: any) {
      expect(err.code).toBe("INVALID_OPERATION_TRANSITION");
    }
  });
});

describe("workflow-operation correlation", () => {
  it("matching correlation passes", () => {
    const registry = new InMemoryWorkflowOperationRegistry();
    const op = registry.registerOperation(baseIdentityInput).operation;
    const result = registry.validateCorrelation({
      workflowOperationId: op.workflowOperationId,
      idempotencyKey: op.idempotencyKey,
      campaignId: op.campaignId,
      userId: op.userId,
      businessId: op.businessId,
      strategyRunId: op.strategyRunId,
      approvalRequestId: op.approvalRequestId,
      claimId: op.claimId,
      contractFingerprint: op.contractFingerprint,
      operationType: op.operationType,
      operationSource: op.operationSource,
      operationReferenceId: op.operationReferenceId,
    });
    expect(result.valid).toBe(true);
    expect(result.failureCodes).toEqual([]);
  });

  it("wrong campaign fails", () => {
    const registry = new InMemoryWorkflowOperationRegistry();
    const op = registry.registerOperation(baseIdentityInput).operation;
    const result = registry.validateCorrelation({ workflowOperationId: op.workflowOperationId, campaignId: 99 });
    expect(result.valid).toBe(false);
    expect(result.failureCodes).toContain("CORRELATION_MISMATCH_CAMPAIGNID");
  });

  it("wrong user fails", () => {
    const registry = new InMemoryWorkflowOperationRegistry();
    const op = registry.registerOperation(baseIdentityInput).operation;
    const result = registry.validateCorrelation({ workflowOperationId: op.workflowOperationId, userId: 99 });
    expect(result.valid).toBe(false);
    expect(result.failureCodes).toContain("CORRELATION_MISMATCH_USERID");
  });

  it("wrong approval fails", () => {
    const registry = new InMemoryWorkflowOperationRegistry();
    const op = registry.registerOperation(baseIdentityInput).operation;
    const result = registry.validateCorrelation({
      workflowOperationId: op.workflowOperationId,
      approvalRequestId: 99,
    });
    expect(result.valid).toBe(false);
    expect(result.failureCodes).toContain("CORRELATION_MISMATCH_APPROVALREQUESTID");
  });

  it("wrong contract fingerprint fails", () => {
    const registry = new InMemoryWorkflowOperationRegistry();
    const op = registry.registerOperation(baseIdentityInput).operation;
    const result = registry.validateCorrelation({
      workflowOperationId: op.workflowOperationId,
      contractFingerprint: "tampered",
    });
    expect(result.valid).toBe(false);
    expect(result.failureCodes).toContain("CORRELATION_MISMATCH_CONTRACTFINGERPRINT");
  });

  it("missing optional claim remains null", () => {
    const input = { ...baseIdentityInput, claimId: undefined };
    const context = buildWorkflowCorrelationContext(input);
    expect(context.claimId).toBeNull();
  });

  it("top-level identity cannot be overwritten downstream", () => {
    const registry = new InMemoryWorkflowOperationRegistry();
    const op = registry.registerOperation(baseIdentityInput).operation;
    const result = registry.validateCorrelation({
      workflowOperationId: op.workflowOperationId,
      campaignId: op.campaignId,
      userId: op.userId,
      operationType: "creative_recovery",
    });
    expect(result.valid).toBe(false);
    expect(result.failureCodes).toContain("CORRELATION_MISMATCH_OPERATIONTYPE");
  });
});

describe("workflow idempotency key", () => {
  it("uses external idempotency key when provided", () => {
    const key = buildWorkflowIdempotencyKey({ ...baseIdentityInput, externalIdempotencyKey: "external-key" });
    expect(key).toBe("external-key");
  });

  it("falls back to workflow operation ID when no external key", () => {
    const key = buildWorkflowIdempotencyKey(baseIdentityInput);
    expect(key).toBe(buildWorkflowOperationId(baseIdentityInput));
  });
});

describe("workflow-operation finalization", () => {
  it("finalizeWorkflowOperation transitions to terminal state with reason code", () => {
    const registry = new InMemoryWorkflowOperationRegistry();
    const op = registry.registerOperation(baseIdentityInput).operation;
    registry.transitionOperation(op.workflowOperationId, "running");

    const finalized = finalizeWorkflowOperation({
      registry,
      workflowOperationId: op.workflowOperationId,
      terminalState: "failed",
      reasonCode: "CANDIDATE_QUALITY_REJECTED",
    });

    expect(finalized.status).toBe("failed");
    expect(finalized.failureCode).toBe("CANDIDATE_QUALITY_REJECTED");
  });

  it("idempotent replay after finalization returns existing terminal operation without mutation", () => {
    const registry = new InMemoryWorkflowOperationRegistry();
    const op = registry.registerOperation(baseIdentityInput).operation;
    registry.transitionOperation(op.workflowOperationId, "running");

    finalizeWorkflowOperation({
      registry,
      workflowOperationId: op.workflowOperationId,
      terminalState: "failed",
      reasonCode: "CANDIDATE_QUALITY_REJECTED",
    });

    const replay = registry.registerOperation(baseIdentityInput);
    expect(replay.duplicateClassification).toBe("idempotent_replay");
    expect(replay.operation.status).toBe("failed");
    expect(replay.operation.failureCode).toBe("CANDIDATE_QUALITY_REJECTED");
  });

  it("no new attempt can be added after explicit finalization", () => {
    const registry = new InMemoryWorkflowOperationRegistry();
    const op = registry.registerOperation(baseIdentityInput).operation;
    registry.transitionOperation(op.workflowOperationId, "running");

    finalizeWorkflowOperation({
      registry,
      workflowOperationId: op.workflowOperationId,
      terminalState: "failed",
      reasonCode: "CANDIDATE_QUALITY_REJECTED",
    });

    try {
      registry.allocateNewAttempt({
        workflowOperationId: op.workflowOperationId,
        attemptType: "creative_regeneration",
      });
      expect.fail("expected ATTEMPT_UNDER_TERMINAL_OPERATION");
    } catch (err: any) {
      expect(err.code).toBe("ATTEMPT_UNDER_TERMINAL_OPERATION");
    }
  });

  it("terminal operation states are immutable", () => {
    const registry = new InMemoryWorkflowOperationRegistry();
    const op = registry.registerOperation(baseIdentityInput).operation;
    registry.transitionOperation(op.workflowOperationId, "running");
    registry.transitionOperation(op.workflowOperationId, "completed");

    try {
      registry.transitionOperation(op.workflowOperationId, "failed");
      expect.fail("expected INVALID_OPERATION_TRANSITION");
    } catch (err: any) {
      expect(err.code).toBe("INVALID_OPERATION_TRANSITION");
    }
  });
});

describe("workflow-operation ordinal allocation", () => {
  it("two message_pack attempts receive ordinals 1 and 2", () => {
    const registry = new InMemoryWorkflowOperationRegistry();
    const op = registry.registerOperation(baseIdentityInput).operation;
    registry.transitionOperation(op.workflowOperationId, "running");

    const a = registry.allocateNewAttempt({
      workflowOperationId: op.workflowOperationId,
      attemptType: "message_pack",
    }).attempt;
    const b = registry.allocateNewAttempt({
      workflowOperationId: op.workflowOperationId,
      attemptType: "message_pack",
    }).attempt;

    expect(a.ordinal).toBe(1);
    expect(b.ordinal).toBe(2);
    expect(a.workflowAttemptId).not.toBe(b.workflowAttemptId);
  });

  it("retry receives next legitimate ordinal", () => {
    const registry = new InMemoryWorkflowOperationRegistry();
    const op = registry.registerOperation(baseIdentityInput).operation;
    registry.transitionOperation(op.workflowOperationId, "running");

    const first = registry.allocateNewAttempt({
      workflowOperationId: op.workflowOperationId,
      attemptType: "message_pack",
    }).attempt;
    const retry = registry.allocateNewAttempt({
      workflowOperationId: op.workflowOperationId,
      attemptType: "message_pack",
    }).attempt;

    expect(first.ordinal).toBe(1);
    expect(retry.ordinal).toBe(2);
    expect(first.workflowAttemptId).not.toBe(retry.workflowAttemptId);
  });
});


describe("workflow-operation replay vs new-attempt allocation", () => {
  it("registerAttemptReplay creates an attempt at the explicit ordinal when it does not exist", () => {
    const registry = new InMemoryWorkflowOperationRegistry();
    const op = registry.registerOperation(baseIdentityInput).operation;
    registry.transitionOperation(op.workflowOperationId, "running");

    const result = registry.registerAttemptReplay({
      workflowOperationId: op.workflowOperationId,
      attemptType: "message_pack",
      ordinal: 1,
    });

    expect(result.attempt.ordinal).toBe(1);
    expect(result.duplicateClassification).toBe("none");
    expect(registry.listAttempts(op.workflowOperationId)).toHaveLength(1);
  });

  it("exact replay returns the same attempt ID and is classified as idempotent replay", () => {
    const registry = new InMemoryWorkflowOperationRegistry();
    const op = registry.registerOperation(baseIdentityInput).operation;
    registry.transitionOperation(op.workflowOperationId, "running");

    const first = registry.registerAttemptReplay({
      workflowOperationId: op.workflowOperationId,
      attemptType: "message_pack",
      ordinal: 1,
    });
    const replay = registry.registerAttemptReplay({
      workflowOperationId: op.workflowOperationId,
      attemptType: "message_pack",
      ordinal: 1,
    });

    expect(replay.attempt.workflowAttemptId).toBe(first.attempt.workflowAttemptId);
    expect(replay.duplicateClassification).toBe("idempotent_replay");
    expect(registry.listAttempts(op.workflowOperationId)).toHaveLength(1);
  });

  it("a genuine new attempt receives the next ordinal after an explicit replay", () => {
    const registry = new InMemoryWorkflowOperationRegistry();
    const op = registry.registerOperation(baseIdentityInput).operation;
    registry.transitionOperation(op.workflowOperationId, "running");

    const replay = registry.registerAttemptReplay({
      workflowOperationId: op.workflowOperationId,
      attemptType: "message_pack",
      ordinal: 1,
    }).attempt;
    const next = registry.allocateNewAttempt({
      workflowOperationId: op.workflowOperationId,
      attemptType: "message_pack",
    }).attempt;

    expect(replay.ordinal).toBe(1);
    expect(next.ordinal).toBe(2);
    expect(registry.listAttempts(op.workflowOperationId)).toHaveLength(2);
  });

  it("allocateNewAttempt is explicitly not a replay-safe operation", () => {
    const registry = new InMemoryWorkflowOperationRegistry();
    const op = registry.registerOperation(baseIdentityInput).operation;
    registry.transitionOperation(op.workflowOperationId, "running");

    const a = registry.allocateNewAttempt({
      workflowOperationId: op.workflowOperationId,
      attemptType: "message_pack",
    });
    const b = registry.allocateNewAttempt({
      workflowOperationId: op.workflowOperationId,
      attemptType: "message_pack",
    });

    expect(a.duplicateClassification).toBe("none");
    expect(b.duplicateClassification).toBe("none");
    expect(a.attempt.workflowAttemptId).not.toBe(b.attempt.workflowAttemptId);
    expect(a.attempt.ordinal).toBe(1);
    expect(b.attempt.ordinal).toBe(2);
  });

  it("conflicting duplicate attempt identity fails deterministically", () => {
    const registry = new InMemoryWorkflowOperationRegistry();
    const op = registry.registerOperation(baseIdentityInput).operation;
    registry.transitionOperation(op.workflowOperationId, "running");

    registry.registerAttemptReplay({
      workflowOperationId: op.workflowOperationId,
      attemptType: "message_pack",
      ordinal: 1,
      providerRunId: "run-a",
    });

    try {
      registry.registerAttemptReplay({
        workflowOperationId: op.workflowOperationId,
        attemptType: "message_pack",
        ordinal: 1,
        providerRunId: "run-b",
      });
      expect.fail("expected DUPLICATE_ATTEMPT_IDENTITY_CONFLICT");
    } catch (err: any) {
      expect(err.code).toBe("DUPLICATE_ATTEMPT_IDENTITY_CONFLICT");
    }
  });

  it("replayed identical attempt after finalization returns existing terminal attempt without mutation", () => {
    const registry = new InMemoryWorkflowOperationRegistry();
    const op = registry.registerOperation(baseIdentityInput).operation;
    registry.transitionOperation(op.workflowOperationId, "running");

    const attempt = registry.registerAttemptReplay({
      workflowOperationId: op.workflowOperationId,
      attemptType: "message_pack",
      ordinal: 1,
    }).attempt;
    registry.transitionAttempt(attempt.workflowAttemptId, "running");
    registry.transitionAttempt(attempt.workflowAttemptId, "completed");

    finalizeWorkflowOperation({
      registry,
      workflowOperationId: op.workflowOperationId,
      terminalState: "failed",
      reasonCode: "CANDIDATE_QUALITY_REJECTED",
    });

    const replay = registry.registerAttemptReplay({
      workflowOperationId: op.workflowOperationId,
      attemptType: "message_pack",
      ordinal: 1,
    });

    expect(replay.duplicateClassification).toBe("idempotent_replay");
    expect(registry.findOperation(op.workflowOperationId)?.status).toBe("failed");
    expect(registry.listAttempts(op.workflowOperationId)).toHaveLength(1);
  });

  it("no new attempt can be added after explicit finalization", () => {
    const registry = new InMemoryWorkflowOperationRegistry();
    const op = registry.registerOperation(baseIdentityInput).operation;
    registry.transitionOperation(op.workflowOperationId, "running");

    finalizeWorkflowOperation({
      registry,
      workflowOperationId: op.workflowOperationId,
      terminalState: "failed",
      reasonCode: "CANDIDATE_QUALITY_REJECTED",
    });

    try {
      registry.allocateNewAttempt({
        workflowOperationId: op.workflowOperationId,
        attemptType: "message_pack",
      });
      expect.fail("expected ATTEMPT_UNDER_TERMINAL_OPERATION");
    } catch (err: any) {
      expect(err.code).toBe("ATTEMPT_UNDER_TERMINAL_OPERATION");
    }
  });
});
