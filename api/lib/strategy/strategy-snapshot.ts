import { createHash } from "node:crypto";

export type JsonPrimitive =
  | string
  | number
  | boolean
  | null;

export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface StrategySnapshot {
  snapshotId: string;
  userId: number;
  campaignId: number;
  businessId: number;
  strategyRunId: number;
  businessDnaSnapshotId: string;
  version: number;
  creativeBriefFingerprint: string;
  strategyHashSha256: string;
  snapshot: JsonValue;
  capturedAt: Date;
}

export interface BuildStrategySnapshotInput {
  userId: number;
  campaignId: number;
  businessId: number;
  strategyRunId: number;
  businessDnaSnapshotId: string;
  version: number;
  creativeBriefFingerprint: string;
  snapshot: JsonValue;
  capturedAt: Date;
}

function assertPositiveInteger(
  name: string,
  value: number
): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      `${name} must be a positive integer`
    );
  }
}

function assertNonBlank(
  name: string,
  value: string
): void {
  if (value.trim().length === 0) {
    throw new Error(
      `${name} must not be blank`
    );
  }
}

export function canonicalStrategyJson(
  value: JsonValue
): string {
  if (value === null) {
    return "null";
  }

  if (typeof value === "string") {
    return JSON.stringify(value);
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(
        "Strategy snapshot JSON contains a non-finite number"
      );
    }

    return JSON.stringify(value);
  }

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  if (Array.isArray(value)) {
    return (
      "[" +
      value
        .map((entry) =>
          canonicalStrategyJson(entry)
        )
        .join(",") +
      "]"
    );
  }

  const keys =
    Object.keys(value).sort();

  const properties =
    keys.map((key) => {
      return (
        JSON.stringify(key) +
        ":" +
        canonicalStrategyJson(value[key])
      );
    });

  return (
    "{" +
    properties.join(",") +
    "}"
  );
}

function cloneCanonicalJson(
  value: JsonValue
): JsonValue {
  return JSON.parse(
    canonicalStrategyJson(value)
  ) as JsonValue;
}

function deepFreezeJson(
  value: JsonValue
): JsonValue {
  if (
    value !== null &&
    typeof value === "object"
  ) {
    if (Array.isArray(value)) {
      for (const entry of value) {
        deepFreezeJson(entry);
      }
    }
    else {
      for (
        const entry of
        Object.values(value)
      ) {
        deepFreezeJson(entry);
      }
    }

    Object.freeze(value);
  }

  return value;
}

export function hashStrategySnapshotPayload(
  snapshot: JsonValue
): string {
  return createHash("sha256")
    .update(
      canonicalStrategyJson(snapshot),
      "utf8"
    )
    .digest("hex");
}

export function buildStrategySnapshot(
  input: BuildStrategySnapshotInput
): StrategySnapshot {
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

  assertPositiveInteger(
    "version",
    input.version
  );

  assertNonBlank(
    "businessDnaSnapshotId",
    input.businessDnaSnapshotId
  );

  assertNonBlank(
    "creativeBriefFingerprint",
    input.creativeBriefFingerprint
  );

  if (
    !(input.capturedAt instanceof Date) ||
    Number.isNaN(
      input.capturedAt.getTime()
    )
  ) {
    throw new Error(
      "capturedAt must be a valid Date"
    );
  }

  const canonicalSnapshot =
    deepFreezeJson(
      cloneCanonicalJson(
        input.snapshot
      )
    );

  const strategyHashSha256 =
    hashStrategySnapshotPayload(
      canonicalSnapshot
    );

  const authoritySeed = [
    input.campaignId,
    input.version,
    input.strategyRunId,
    input.businessDnaSnapshotId,
    input.creativeBriefFingerprint,
    strategyHashSha256,
  ].join("|");

  const snapshotId =
    "strategy_" +
    createHash("sha256")
      .update(
        authoritySeed,
        "utf8"
      )
      .digest("hex")
      .slice(0, 48);

  return Object.freeze({
    snapshotId,
    userId: input.userId,
    campaignId: input.campaignId,
    businessId: input.businessId,
    strategyRunId: input.strategyRunId,
    businessDnaSnapshotId:
      input.businessDnaSnapshotId,
    version: input.version,
    creativeBriefFingerprint:
      input.creativeBriefFingerprint,
    strategyHashSha256,
    snapshot: canonicalSnapshot,
    capturedAt:
      new Date(
        input.capturedAt.getTime()
      ),
  });
}

export function hasSameStrategyAuthority(
  left: StrategySnapshot,
  right: StrategySnapshot
): boolean {
  return (
    left.snapshotId ===
      right.snapshotId &&
    left.userId ===
      right.userId &&
    left.campaignId ===
      right.campaignId &&
    left.businessId ===
      right.businessId &&
    left.strategyRunId ===
      right.strategyRunId &&
    left.businessDnaSnapshotId ===
      right.businessDnaSnapshotId &&
    left.version ===
      right.version &&
    left.creativeBriefFingerprint ===
      right.creativeBriefFingerprint &&
    left.strategyHashSha256 ===
      right.strategyHashSha256
  );
}