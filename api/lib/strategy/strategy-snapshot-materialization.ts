import {
  createAuditEvent,
  type AuditEvent,
} from "../audit/audit-event";

import {
  persistAuditEvent,
} from "../audit/audit-store";
import {
  materializeGovernedBusinessDna,
} from "../business-dna-governance";

import {
  buildStrategySnapshot,
  hashStrategySnapshotPayload,
  type JsonValue,
} from "./strategy-snapshot";

import {
  StrategySnapshotConflictError,
  persistImmutableStrategySnapshot,
  type PersistedStrategySnapshot,
  type StrategySnapshotPersistence,
} from "./strategy-snapshot-store";

import {
  createStrategySnapshotPersistence,
  getNextStrategySnapshotVersion,
} from "./strategy-snapshot-db-store";

export interface MaterializeGovernedStrategySnapshotInput {
  readonly userId: number;
  readonly campaignId: number;
  readonly businessId: number;
  readonly strategyRunId: number;
  readonly creativeBriefFingerprint: string;
  readonly snapshot: unknown;
}

export interface StrategyBusinessDnaAuthority {
  readonly snapshot: {
    readonly snapshotId: string;
  };
}

export interface StrategySnapshotMaterializationDependencies {
  readonly persistence?:
    StrategySnapshotPersistence;

  readonly materializeBusinessDna?: (
    input: {
      userId: number;
      businessId: number;
    }
  ) => Promise<StrategyBusinessDnaAuthority>;

  readonly resolveNextVersion?: (
    campaignId: number
  ) => Promise<number>;

  readonly persistAudit?: (
    event: AuditEvent
  ) => Promise<void>;

  readonly now?: () => Date;
}

export interface MaterializedGovernedStrategySnapshot {
  readonly status:
    | "inserted"
    | "reused";

  readonly snapshot:
    PersistedStrategySnapshot;
}

function assertPositiveInteger(
  field: string,
  value: number
): void {
  if (
    !Number.isInteger(value) ||
    value <= 0
  ) {
    throw new Error(
      `${field} must be a positive integer`
    );
  }
}

function assertNonBlank(
  field: string,
  value: string
): void {
  if (
    value.trim().length === 0
  ) {
    throw new Error(
      `${field} must not be blank`
    );
  }
}

function normalizeStrategyJson(
  value: unknown
): JsonValue {
  const encoded =
    JSON.stringify(value);

  if (
    typeof encoded !== "string"
  ) {
    throw new Error(
      "Strategy snapshot payload is not JSON serializable"
    );
  }

  return JSON.parse(
    encoded
  ) as JsonValue;
}

function assertExistingRunContext(
  existing: PersistedStrategySnapshot,
  input: MaterializeGovernedStrategySnapshotInput
): void {
  if (
    existing.userId !==
      input.userId ||
    existing.campaignId !==
      input.campaignId ||
    existing.businessId !==
      input.businessId ||
    existing.strategyRunId !==
      input.strategyRunId ||
    existing.creativeBriefFingerprint !==
      input.creativeBriefFingerprint
  ) {
    throw new StrategySnapshotConflictError(
      "Existing Strategy snapshot authority does not match the requested Strategy run context"
    );
  }
}

function buildStrategySnapshotMaterializationAuditEvent(
  snapshot: PersistedStrategySnapshot
): AuditEvent {
  return createAuditEvent({
    eventType:
      "strategy_snapshot_materialized",
    occurredAt:
      snapshot.capturedAt.toISOString(),
    userId:
      snapshot.userId,
    campaignId:
      snapshot.campaignId,
    businessId:
      snapshot.businessId,
    artifactId:
      snapshot.snapshotId,
    source:
      "strategy",
    outcome:
      "succeeded",
    metadata: {
      strategyRunId:
        snapshot.strategyRunId,
      strategyVersion:
        snapshot.version,
      businessDnaSnapshotId:
        snapshot.businessDnaSnapshotId,
      creativeBriefFingerprint:
        snapshot.creativeBriefFingerprint,
      strategyHashSha256:
        snapshot.strategyHashSha256,
    },
  });
}

async function persistStrategySnapshotMaterializationAudit(
  snapshot: PersistedStrategySnapshot,
  dependencies: StrategySnapshotMaterializationDependencies
): Promise<void> {
  const event =
    buildStrategySnapshotMaterializationAuditEvent(
      snapshot
    );

  const writer =
    dependencies.persistAudit ??
    (async (
      auditEvent: AuditEvent
    ) => {
      await persistAuditEvent(
        auditEvent
      );
    });

  await writer(
    event
  );
}

/**
 * Establishes the immutable Strategy authority after grounded Strategy
 * validation succeeds and before mutable agent/campaign projections are
 * marked successful.
 *
 * Replay of an already-materialised Strategy run reuses the original
 * authority without rematerialising Business DNA or allocating a new version.
 */
export async function materializeGovernedStrategySnapshot(
  input: MaterializeGovernedStrategySnapshotInput,
  dependencies:
    StrategySnapshotMaterializationDependencies = {}
): Promise<MaterializedGovernedStrategySnapshot> {
  assertPositiveInteger(
    "userId",
    input.userId
  );

  assertPositiveInteger(
    "campaignId",
    input.campaignId
  );

  assertPositiveInteger(
    "businessId",
    input.businessId
  );

  assertPositiveInteger(
    "strategyRunId",
    input.strategyRunId
  );

  assertNonBlank(
    "creativeBriefFingerprint",
    input.creativeBriefFingerprint
  );

  const persistence =
    dependencies.persistence ??
    await createStrategySnapshotPersistence();

  const normalizedSnapshot =
    normalizeStrategyJson(
      input.snapshot
    );

  const incomingStrategyHashSha256 =
    hashStrategySnapshotPayload(
      normalizedSnapshot
    );

  const existing =
    await persistence.findByStrategyRunId(
      input.strategyRunId
    );

  if (existing) {
    assertExistingRunContext(
      existing,
      input
    );

    if (
      existing.strategyHashSha256 !==
        incomingStrategyHashSha256
    ) {
      throw new StrategySnapshotConflictError(
        "Existing Strategy snapshot authority does not match the requested Strategy payload"
      );
    }

    await persistStrategySnapshotMaterializationAudit(
      existing,
      dependencies
    );

    return {
      status: "reused",
      snapshot: existing,
    };
  }

  const materializeBusinessDna =
    dependencies.materializeBusinessDna ??
    (async ({
      userId,
      businessId,
    }) =>
      materializeGovernedBusinessDna({
        userId,
        businessId,
      }));

  const businessDnaAuthority =
    await materializeBusinessDna({
      userId: input.userId,
      businessId: input.businessId,
    });

  const businessDnaSnapshotId =
    businessDnaAuthority
      .snapshot
      .snapshotId;

  assertNonBlank(
    "businessDnaSnapshotId",
    businessDnaSnapshotId
  );

  const resolveNextVersion =
    dependencies.resolveNextVersion ??
    getNextStrategySnapshotVersion;

  const version =
    await resolveNextVersion(
      input.campaignId
    );

  assertPositiveInteger(
    "strategyVersion",
    version
  );

  const now =
    dependencies.now ??
    (() => new Date());

  const capturedAt =
    now();

  const candidate =
    buildStrategySnapshot({
      userId:
        input.userId,
      campaignId:
        input.campaignId,
      businessId:
        input.businessId,
      strategyRunId:
        input.strategyRunId,
      businessDnaSnapshotId,
      version,
      creativeBriefFingerprint:
        input.creativeBriefFingerprint,
      snapshot: normalizedSnapshot,
      capturedAt,
    });

  const persisted =
    await persistImmutableStrategySnapshot(
      persistence,
      candidate
    );

  await persistStrategySnapshotMaterializationAudit(
    persisted.snapshot,
    dependencies
  );

  return {
    status:
      persisted.reused
        ? "reused"
        : "inserted",
    snapshot:
      persisted.snapshot,
  };
}