// ─── R9-C Dependency & Scheduling Intelligence — dependency graph ───
//
// PURE deterministic bounded DAG validation (C3). No I/O, no clock, no
// model: the graph module is rule-only and cannot be overridden by any agent
// or model output. Every traversal is bounded by construction (task/edge
// limits) and additionally by a hard step budget. Cycle detection is
// iterative three-colour DFS over deterministically sorted adjacency — the
// same edge set always yields the same verdict and the same witness path.

import {
  MAX_DEPENDENCIES_PER_PLAN,
  MAX_GRAPH_TRAVERSAL_STEPS,
  MAX_TASKS_PER_PLAN,
  MissionSchedulingValidationError,
  isOrderingDependency,
  type MissionDependencyHardness,
  type MissionDependencyType,
} from "./mission-scheduling-contract";

export interface GraphEdgeInput {
  predecessorTaskId: string;
  successorTaskId: string;
  dependencyType: MissionDependencyType;
  hardOrSoft: MissionDependencyHardness;
}

export interface ValidatedMissionGraph {
  /** All task ids of the plan, sorted lexicographically (deterministic). */
  readonly taskIds: readonly string[];
  /** Normalised edges sorted by canonical edge key. */
  readonly edges: readonly GraphEdgeInput[];
  /** Hard ordering adjacency (pred → sorted succs). SOFT + MUTUAL_EXCLUSION excluded. */
  readonly adjacency: ReadonlyMap<string, readonly string[]>;
  /** Symmetric exclusion adjacency (MUTUAL_EXCLUSION edges + serialized pairs). */
  readonly exclusionAdjacency: ReadonlyMap<string, readonly string[]>;
  /** Deterministic Kahn levels from hard ordering edges. */
  readonly levels: readonly (readonly string[])[];
}

function edgeKey(edge: GraphEdgeInput): string {
  return `${edge.predecessorTaskId}→${edge.successorTaskId}:${edge.dependencyType}:${edge.hardOrSoft}`;
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

/**
 * Validate the plan's task set + dependency edges into a bounded DAG.
 * Fail-closed rejections: unknown endpoint, self-cycle, direct/indirect
 * cycle, malformed edge, plan size limits. The caller has already verified
 * tenant/mission/plan scope — this module enforces graph semantics only.
 */
export function buildDependencyGraph(input: {
  taskIds: readonly string[];
  edges: readonly GraphEdgeInput[];
}): ValidatedMissionGraph {
  const taskIds = sortedUnique(input.taskIds);
  if (taskIds.length === 0 || taskIds.length > MAX_TASKS_PER_PLAN) {
    throw new MissionSchedulingValidationError(
      "SCHEDULING_GRAPH_TOO_LARGE",
      `plan declares ${taskIds.length} tasks; bounded scheduler supports 1..${MAX_TASKS_PER_PLAN}.`
    );
  }
  if (input.edges.length > MAX_DEPENDENCIES_PER_PLAN) {
    throw new MissionSchedulingValidationError(
      "SCHEDULING_GRAPH_TOO_LARGE",
      `plan declares ${input.edges.length} dependency edges; bounded scheduler supports ≤${MAX_DEPENDENCIES_PER_PLAN}.`
    );
  }
  const taskSet = new Set(taskIds);

  const edges: GraphEdgeInput[] = [];
  const adjacency = new Map<string, string[]>();
  const exclusion = new Map<string, string[]>();
  const addAdj = (map: Map<string, string[]>, from: string, to: string) => {
    const list = map.get(from) ?? [];
    list.push(to);
    map.set(from, list);
  };

  for (const edge of input.edges) {
    if (!taskSet.has(edge.predecessorTaskId)) {
      throw new MissionSchedulingValidationError(
        "UNKNOWN_PREDECESSOR_TASK",
        `dependency predecessor ${edge.predecessorTaskId} is not a task of this plan.`
      );
    }
    if (!taskSet.has(edge.successorTaskId)) {
      throw new MissionSchedulingValidationError(
        "UNKNOWN_SUCCESSOR_TASK",
        `dependency successor ${edge.successorTaskId} is not a task of this plan.`
      );
    }
    if (edge.predecessorTaskId === edge.successorTaskId && edge.dependencyType !== "MUTUAL_EXCLUSION") {
      throw new MissionSchedulingValidationError(
        "SELF_DEPENDENCY",
        `task ${edge.predecessorTaskId} cannot depend on itself.`
      );
    }
    if (edge.dependencyType === "MUTUAL_EXCLUSION" && edge.predecessorTaskId === edge.successorTaskId) {
      throw new MissionSchedulingValidationError(
        "SELF_DEPENDENCY",
        `task ${edge.predecessorTaskId} cannot be mutually exclusive with itself.`
      );
    }
    edges.push(edge);
    if (edge.dependencyType === "MUTUAL_EXCLUSION") {
      addAdj(exclusion, edge.predecessorTaskId, edge.successorTaskId);
      addAdj(exclusion, edge.successorTaskId, edge.predecessorTaskId);
    } else if (edge.hardOrSoft === "HARD" && isOrderingDependency(edge.dependencyType)) {
      addAdj(adjacency, edge.predecessorTaskId, edge.successorTaskId);
    }
  }

  edges.sort((a, b) => (edgeKey(a) < edgeKey(b) ? -1 : edgeKey(a) > edgeKey(b) ? 1 : 0));
  const frozenAdjacency = new Map<string, readonly string[]>(
    [...adjacency.entries()].map(([k, v]) => [k, sortedUnique(v)])
  );
  const frozenExclusion = new Map<string, readonly string[]>(
    [...exclusion.entries()].map(([k, v]) => [k, sortedUnique(v)])
  );

  assertAcyclic(taskIds, frozenAdjacency);

  return {
    taskIds,
    edges,
    adjacency: frozenAdjacency,
    exclusionAdjacency: frozenExclusion,
    levels: computeKahnLevels(taskIds, frozenAdjacency),
  };
}

/**
 * Three-colour iterative DFS with a hard step budget. On cycle, throws with a
 * deterministic witness path (lexicographically smallest exploration order).
 */
export function assertAcyclic(
  taskIds: readonly string[],
  adjacency: ReadonlyMap<string, readonly string[]>
): void {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>(taskIds.map((id) => [id, WHITE]));
  let steps = 0;

  for (const root of taskIds) {
    if (color.get(root) !== WHITE) continue;
    const stack: Array<{ node: string; nextIndex: number }> = [{ node: root, nextIndex: 0 }];
    color.set(root, GRAY);
    while (stack.length > 0) {
      if (++steps > MAX_GRAPH_TRAVERSAL_STEPS) {
        throw new MissionSchedulingValidationError(
          "SCHEDULING_GRAPH_TOO_LARGE",
          `graph traversal exceeded the hard step budget (${MAX_GRAPH_TRAVERSAL_STEPS}); refusing unbounded scheduling.`
        );
      }
      const top = stack[stack.length - 1];
      const succs = adjacency.get(top.node) ?? [];
      if (top.nextIndex < succs.length) {
        const next = succs[top.nextIndex];
        top.nextIndex += 1;
        const state = color.get(next) ?? WHITE;
        if (state === GRAY) {
          const path = stack.map((frame) => frame.node);
          path.push(next);
          throw new MissionSchedulingValidationError(
            "SCHEDULING_CYCLE",
            `dependency cycle detected: ${path.join(" → ")}. Cycles fail closed; no schedule may be produced.`
          );
        }
        if (state === WHITE) {
          color.set(next, GRAY);
          stack.push({ node: next, nextIndex: 0 });
        }
      } else {
        color.set(top.node, BLACK);
        stack.pop();
      }
    }
  }
}

/**
 * Deterministic Kahn topological levels: each level is the lexicographically
 * sorted set of ready tasks at that wave. Same graph ⇒ same levels.
 */
export function computeKahnLevels(
  taskIds: readonly string[],
  adjacency: ReadonlyMap<string, readonly string[]>
): string[][] {
  const inDegree = new Map<string, number>(taskIds.map((id) => [id, 0]));
  for (const succs of adjacency.values()) {
    for (const succ of succs) inDegree.set(succ, (inDegree.get(succ) ?? 0) + 1);
  }
  let ready = taskIds.filter((id) => (inDegree.get(id) ?? 0) === 0).sort();
  const levels: string[][] = [];
  const placed = new Set<string>();
  let steps = 0;
  while (ready.length > 0) {
    if (++steps > MAX_TASKS_PER_PLAN + 1) {
      throw new MissionSchedulingValidationError(
        "SCHEDULING_CYCLE",
        "Kahn levelisation did not converge; the graph contains a cycle."
      );
    }
    const level = [...ready].sort();
    levels.push(level);
    const next: string[] = [];
    for (const task of level) {
      placed.add(task);
      for (const succ of adjacency.get(task) ?? []) {
        const remaining = (inDegree.get(succ) ?? 0) - 1;
        inDegree.set(succ, remaining);
        if (remaining === 0) next.push(succ);
      }
    }
    ready = next.sort();
  }
  if (placed.size !== taskIds.length) {
    const stranded = taskIds.filter((id) => !placed.has(id)).sort();
    throw new MissionSchedulingValidationError(
      "SCHEDULING_CYCLE",
      `dependency cycle detected among: ${stranded.join(", ")}. Cycles fail closed; no schedule may be produced.`
    );
  }
  return levels;
}

/**
 * Reachability closure over hard ordering adjacency (bounded BFS per node).
 * `reachableFrom.get(a)` contains every task reachable from `a` (exclusive).
 */
export function computeReachability(
  taskIds: readonly string[],
  adjacency: ReadonlyMap<string, readonly string[]>
): Map<string, ReadonlySet<string>> {
  const closure = new Map<string, ReadonlySet<string>>();
  for (const start of taskIds) {
    const seen = new Set<string>();
    const queue: string[] = [...(adjacency.get(start) ?? [])];
    let steps = 0;
    while (queue.length > 0) {
      if (++steps > MAX_GRAPH_TRAVERSAL_STEPS) {
        throw new MissionSchedulingValidationError(
          "SCHEDULING_GRAPH_TOO_LARGE",
          `reachability traversal exceeded the hard step budget (${MAX_GRAPH_TRAVERSAL_STEPS}).`
        );
      }
      const node = queue.shift()!;
      if (seen.has(node)) continue;
      seen.add(node);
      for (const next of adjacency.get(node) ?? []) queue.push(next);
    }
    closure.set(start, seen);
  }
  return closure;
}
