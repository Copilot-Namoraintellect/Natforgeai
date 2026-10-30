// ─── R8-D Strategic Reasoning — bounded reasoning graph ───
//
// Deterministic DAG linking evidence → hypothesis → conclusion with typed
// edges (SUPPORTS / CONTRADICTS / CONTEXTUALISES / LIMITS). Edges only ever
// point from evidence toward conclusions, so cycles cannot form; cross-
// evidence CONTRADICTS edges mirror upstream contradiction lineage and are
// recorded once per pair in canonical ref order. Hard bounds keep traversal
// finite (contract §4): ≤64 evidence nodes, ≤256 edges, depth ≤3.

import {
  fail,
  MAX_EVIDENCE_PER_BUNDLE,
  MAX_GRAPH_EDGES,
  type ReasoningGraphEdgeType,
  type StrategicEvidenceClass,
  type StrategicEvidenceRole,
} from "./strategic-reasoning-contract";

export const HYPOTHESIS_NODE_ID = "hypothesis" as const;
export const CONCLUSION_NODE_ID = "conclusion" as const;

export interface ReasoningGraphNode {
  readonly id: string;
  readonly kind: "EVIDENCE" | "HYPOTHESIS" | "CONCLUSION";
  readonly evidenceClass: StrategicEvidenceClass | null;
  readonly role: StrategicEvidenceRole | null;
}

export interface ReasoningGraphEdge {
  readonly from: string;
  readonly to: string;
  readonly type: ReasoningGraphEdgeType;
  readonly depth: number;
}

export interface ReasoningGraph {
  readonly nodes: readonly ReasoningGraphNode[];
  readonly edges: readonly ReasoningGraphEdge[];
}

export interface EvidenceGraphInput {
  readonly ref: string;
  readonly evidenceClass: StrategicEvidenceClass;
  readonly role: StrategicEvidenceRole;
  readonly edgeTypes: readonly ReasoningGraphEdgeType[];
}

/** Contradiction pairs (canonical ordering, recorded once per pair). */
function canonicalPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

export function buildReasoningGraph(input: {
  evidence: readonly EvidenceGraphInput[];
  contradictionPairs: readonly (readonly [string, string])[];
}): ReasoningGraph {
  if (input.evidence.length > MAX_EVIDENCE_PER_BUNDLE) {
    fail("MALFORMED_EVIDENCE", `evidence bundle exceeds ${MAX_EVIDENCE_PER_BUNDLE} items`);
  }
  const nodes: ReasoningGraphNode[] = [];
  const edges: ReasoningGraphEdge[] = [];
  const seen = new Set<string>();

  const pushEdge = (from: string, to: string, type: ReasoningGraphEdgeType, depth: number) => {
    if (edges.length >= MAX_GRAPH_EDGES) {
      fail("MALFORMED_EVIDENCE", `reasoning graph exceeds ${MAX_GRAPH_EDGES} edges`);
    }
    edges.push({ from, to, type, depth });
  };

  for (const item of input.evidence) {
    if (seen.has(item.ref)) continue;
    seen.add(item.ref);
    nodes.push({
      id: item.ref,
      kind: "EVIDENCE",
      evidenceClass: item.evidenceClass,
      role: item.role,
    });
    // depth 1: evidence → hypothesis; depth 2: hypothesis → conclusion.
    for (const type of item.edgeTypes) {
      pushEdge(item.ref, HYPOTHESIS_NODE_ID, type, 1);
    }
  }

  const pairSeen = new Set<string>();
  for (const pair of input.contradictionPairs) {
    const [a, b] = canonicalPair(pair[0], pair[1]);
    const key = `${a}|${b}`;
    if (pairSeen.has(key)) continue;
    pairSeen.add(key);
    if (!seen.has(a) || !seen.has(b)) continue;
    pushEdge(a, b, "CONTRADICTS", 1);
  }

  nodes.push({ id: HYPOTHESIS_NODE_ID, kind: "HYPOTHESIS", evidenceClass: null, role: null });
  nodes.push({ id: CONCLUSION_NODE_ID, kind: "CONCLUSION", evidenceClass: null, role: null });
  pushEdge(HYPOTHESIS_NODE_ID, CONCLUSION_NODE_ID, "SUPPORTS", 2);

  return { nodes, edges };
}

/** Depth guard for consumers traversing the graph (defence in depth). */
export function assertGraphBounds(graph: ReasoningGraph): void {
  const evidenceCount = graph.nodes.filter((n) => n.kind === "EVIDENCE").length;
  if (evidenceCount > MAX_EVIDENCE_PER_BUNDLE) {
    fail("MALFORMED_EVIDENCE", "graph exceeds evidence bound");
  }
  if (graph.edges.length > MAX_GRAPH_EDGES) {
    fail("MALFORMED_EVIDENCE", "graph exceeds edge bound");
  }
  for (const edge of graph.edges) {
    if (edge.depth < 1 || edge.depth > 3) {
      fail("MALFORMED_EVIDENCE", "graph edge exceeds depth bound");
    }
  }
}
