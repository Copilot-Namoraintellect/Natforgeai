import {
  hasSameStrategyAuthority,
  type StrategySnapshot,
} from "./strategy-snapshot";

export interface PersistedStrategySnapshot
  extends StrategySnapshot {
  id?: number;
  createdAt?: Date;
}

export interface StrategySnapshotPersistence {
  findByStrategyRunId(
    strategyRunId: number
  ): Promise<PersistedStrategySnapshot | null>;

  insert(
    snapshot: StrategySnapshot
  ): Promise<PersistedStrategySnapshot>;
}

export interface PersistStrategySnapshotResult {
  snapshot: PersistedStrategySnapshot;
  reused: boolean;
}

export class StrategySnapshotConflictError
  extends Error {
  constructor(
    message: string
  ) {
    super(message);
    this.name =
      "StrategySnapshotConflictError";
  }
}

function isDuplicateKeyError(
  error: unknown
): boolean {
  if (
    error === null ||
    typeof error !== "object"
  ) {
    return false;
  }

  const candidate =
    error as {
      code?: unknown;
      errno?: unknown;
    };

  return (
    candidate.code === "ER_DUP_ENTRY" ||
    candidate.errno === 1062
  );
}

function assertReplayCompatible(
  existing: PersistedStrategySnapshot,
  candidate: StrategySnapshot
): void {
  if (
    !hasSameStrategyAuthority(
      existing,
      candidate
    )
  ) {
    throw new StrategySnapshotConflictError(
      "Strategy run is already bound to a different immutable Strategy snapshot"
    );
  }
}

export async function persistImmutableStrategySnapshot(
  persistence: StrategySnapshotPersistence,
  candidate: StrategySnapshot
): Promise<PersistStrategySnapshotResult> {
  const existing =
    await persistence.findByStrategyRunId(
      candidate.strategyRunId
    );

  if (existing) {
    assertReplayCompatible(
      existing,
      candidate
    );

    return {
      snapshot: existing,
      reused: true,
    };
  }

  try {
    const inserted =
      await persistence.insert(
        candidate
      );

    return {
      snapshot: inserted,
      reused: false,
    };
  }
  catch (error) {
    if (!isDuplicateKeyError(error)) {
      throw error;
    }

    const racedExisting =
      await persistence.findByStrategyRunId(
        candidate.strategyRunId
      );

    if (!racedExisting) {
      throw error;
    }

    assertReplayCompatible(
      racedExisting,
      candidate
    );

    return {
      snapshot: racedExisting,
      reused: true,
    };
  }
}