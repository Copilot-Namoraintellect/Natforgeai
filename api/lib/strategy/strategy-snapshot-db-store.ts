import {
  desc,
  eq,
} from "drizzle-orm";

import {
  strategySnapshots,
  type StrategySnapshotRow,
} from "@db/schema";

import {
  getDb,
} from "../../queries/connection";

import type {
  JsonValue,
  StrategySnapshot,
} from "./strategy-snapshot";

import type {
  PersistedStrategySnapshot,
  StrategySnapshotPersistence,
} from "./strategy-snapshot-store";

type StrategySnapshotDb =
  NonNullable<
    Awaited<
      ReturnType<typeof getDb>
    >
  >;

function rowToPersistedStrategySnapshot(
  row: StrategySnapshotRow
): PersistedStrategySnapshot {
  return {
    id: row.id,
    snapshotId: row.snapshotId,
    userId: row.userId,
    campaignId: row.campaignId,
    businessId: row.businessId,
    strategyRunId: row.strategyRunId,
    businessDnaSnapshotId:
      row.businessDnaSnapshotId,
    version: row.version,
    creativeBriefFingerprint:
      row.creativeBriefFingerprint,
    strategyHashSha256:
      row.strategyHashSha256,
    snapshot:
      row.snapshot as JsonValue,
    capturedAt: row.capturedAt,
    createdAt: row.createdAt,
  };
}

async function resolveDb(): Promise<StrategySnapshotDb> {
  const db =
    await getDb();

  if (!db) {
    throw new Error(
      "Strategy snapshot persistence requires an available database"
    );
  }

  return db;
}

export async function createStrategySnapshotPersistence():
Promise<StrategySnapshotPersistence> {
  const db =
    await resolveDb();

  return {
    async findByStrategyRunId(
      strategyRunId: number
    ): Promise<PersistedStrategySnapshot | null> {
      const [row] =
        await db
          .select()
          .from(strategySnapshots)
          .where(
            eq(
              strategySnapshots.strategyRunId,
              strategyRunId
            )
          )
          .limit(1);

      return row
        ? rowToPersistedStrategySnapshot(
            row
          )
        : null;
    },

    async insert(
      snapshot: StrategySnapshot
    ): Promise<PersistedStrategySnapshot> {
      const [insertResult] =
        await db
          .insert(strategySnapshots)
          .values({
            snapshotId:
              snapshot.snapshotId,
            userId:
              snapshot.userId,
            campaignId:
              snapshot.campaignId,
            businessId:
              snapshot.businessId,
            strategyRunId:
              snapshot.strategyRunId,
            businessDnaSnapshotId:
              snapshot.businessDnaSnapshotId,
            version:
              snapshot.version,
            creativeBriefFingerprint:
              snapshot.creativeBriefFingerprint,
            strategyHashSha256:
              snapshot.strategyHashSha256,
            snapshot:
              snapshot.snapshot,
            capturedAt:
              snapshot.capturedAt,
          });

      const insertedId =
        Number(
          insertResult.insertId
        );

      if (
        !Number.isInteger(insertedId) ||
        insertedId <= 0
      ) {
        throw new Error(
          "Strategy snapshot insert returned an invalid insert id"
        );
      }

      const [row] =
        await db
          .select()
          .from(strategySnapshots)
          .where(
            eq(
              strategySnapshots.id,
              insertedId
            )
          )
          .limit(1);

      if (!row) {
        throw new Error(
          "Failed to reload inserted Strategy snapshot"
        );
      }

      return rowToPersistedStrategySnapshot(
        row
      );
    },
  };
}

export async function getStrategySnapshotByStrategyRunId(
  strategyRunId: number
): Promise<PersistedStrategySnapshot | null> {
  if (
    !Number.isInteger(strategyRunId) ||
    strategyRunId <= 0
  ) {
    throw new Error(
      "strategyRunId must be a positive integer"
    );
  }

  const persistence =
    await createStrategySnapshotPersistence();

  return persistence.findByStrategyRunId(
    strategyRunId
  );
}

export async function getNextStrategySnapshotVersion(
  campaignId: number
): Promise<number> {
  if (
    !Number.isInteger(campaignId) ||
    campaignId <= 0
  ) {
    throw new Error(
      "campaignId must be a positive integer"
    );
  }

  const db =
    await resolveDb();

  const [latest] =
    await db
      .select({
        version:
          strategySnapshots.version,
      })
      .from(strategySnapshots)
      .where(
        eq(
          strategySnapshots.campaignId,
          campaignId
        )
      )
      .orderBy(
        desc(
          strategySnapshots.version
        ),
        desc(
          strategySnapshots.id
        )
      )
      .limit(1);

  return (
    latest?.version ?? 0
  ) + 1;
}