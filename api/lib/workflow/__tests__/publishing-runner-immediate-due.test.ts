import { describe, expect, it } from "vitest";
import {
  buildImmediatePostsCondition,
  LIVE_PUBLICATION_WORKFLOW_STATES,
} from "../publishing-runner";

// Operator-aware evaluator for the immediate-condition shape
// and(eq(status), isNull(scheduledAt), inArray(campaignId, ids)).
// Chunks are walked via constructor name (StringChunk vs Param) — drizzle
// wraps operator text and bound values in objects, not plain strings.
function flattenSqlChunks(node: any): any[] {
  if (!node || typeof node !== "object" || !Array.isArray(node.queryChunks)) {
    return node === undefined ? [] : [node];
  }
  const out: any[] = [];
  for (const chunk of node.queryChunks) out.push(...flattenSqlChunks(chunk));
  return out;
}

function chunkText(chunk: unknown): string {
  if (typeof chunk === "string") return chunk;
  if (chunk && typeof chunk === "object" && (chunk as any).constructor?.name === "StringChunk") {
    return String((chunk as any).value ?? "");
  }
  return "";
}

function isParamChunk(chunk: unknown): boolean {
  return (
    !!chunk &&
    typeof chunk === "object" &&
    (chunk as any).constructor?.name === "Param" &&
    "value" in (chunk as any)
  );
}

function matchesImmediateCondition(
  row: { status: string; scheduledAt: Date | null; campaignId: number },
  liveIds: number[]
): boolean {
  const condition = buildImmediatePostsCondition(liveIds);
  const chunks = flattenSqlChunks(condition);
  const tests: Array<() => boolean> = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!chunk || typeof chunk !== "object" || typeof (chunk as any).name !== "string") continue;
    const column = (chunk as any).name as string;
    let j = i + 1;
    while (j < chunks.length && chunkText(chunks[j]).trim() === "") j++;
    const opToken = chunkText(chunks[j]);
    const param = chunks[j + 1];
    if (/is\s+null/i.test(opToken)) {
      tests.push(() => row[column as keyof typeof row] === null);
    } else if (opToken.trim() === "in") {
      // inArray binds its value list inside a nested SQL fragment; the set
      // under test is exactly the liveIds argument, so evaluate membership
      // against it directly.
      tests.push(() => liveIds.includes(row.campaignId));
    } else if (opToken.includes("=")) {
      const value = isParamChunk(param) ? (param as any).value : undefined;
      tests.push(() => row[column as keyof typeof row] === value);
    } else {
      throw new Error(`unexpected operator token in condition: ${JSON.stringify(opToken)}`);
    }
  }
  return tests.every((t) => t());
}

const DUE = new Date("2027-03-15T09:30:00Z");

describe("buildImmediatePostsCondition (WBS-R3.4 / GAP29 b/c)", () => {
  it("exposes the live publication workflow states used by the cron gate", () => {
    expect([...LIVE_PUBLICATION_WORKFLOW_STATES]).toEqual([
      "publication_pending",
      "campaign_live",
    ]);
  });

  it("matches an approved immediate row of a live campaign", () => {
    expect(
      matchesImmediateCondition(
        { status: "approved", scheduledAt: null, campaignId: 27 },
        [27, 31]
      )
    ).toBe(true);
  });

  it("excludes rows with a concrete schedule (the timestamped branch owns them)", () => {
    expect(
      matchesImmediateCondition(
        { status: "approved", scheduledAt: DUE, campaignId: 27 },
        [27]
      )
    ).toBe(false);
  });

  it("excludes rows of campaigns that do not hold publication authority (pre-launch invisibility)", () => {
    expect(
      matchesImmediateCondition(
        { status: "approved", scheduledAt: null, campaignId: 26 },
        [27]
      )
    ).toBe(false);
  });

  it("excludes non-approved statuses", () => {
    for (const status of ["pending_approval", "retrying", "draft", "published", "failed"]) {
      expect(
        matchesImmediateCondition({ status, scheduledAt: null, campaignId: 27 }, [27])
      ).toBe(false);
    }
  });

  it("produces deterministic SQL for the same live-id set", () => {
    const describe = (c: unknown) =>
      JSON.stringify(
        flattenSqlChunks(c).map((chunk) =>
          chunk && typeof chunk === "object"
            ? {
                ctor: (chunk as any).constructor?.name,
                name: typeof (chunk as any).name === "string" ? (chunk as any).name : undefined,
                value:
                  (chunk as any).value instanceof Date
                    ? (chunk as any).value.toISOString()
                    : (chunk as any).value,
              }
            : String(chunk)
        )
      );
    expect(describe(buildImmediatePostsCondition([27, 31]))).toBe(
      describe(buildImmediatePostsCondition([27, 31]))
    );
    expect(describe(buildImmediatePostsCondition([27, 31]))).toContain('"ctor":"Param"');
  });
});
