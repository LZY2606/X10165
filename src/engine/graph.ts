import type {
  DependencyGraph,
  GraphEdge,
  GraphNode,
  NodeKind,
  Snapshot,
} from "./types";
import { contentHashKey, docId, rankId, refId, tombstoneId, tokenId, VIEWS } from "./ids";
import { fnv1aHex } from "./hash";

function makeGraph(): DependencyGraph {
  return { nodes: {}, edges: [], out: {}, inn: {} };
}

function addNode(graph: DependencyGraph, node: GraphNode): void {
  graph.nodes[node.id] = node;
  graph.out[node.id] ??= [];
  graph.inn[node.id] ??= [];
}

function addEdge(graph: DependencyGraph, edge: GraphEdge): void {
  graph.edges.push(edge);
  (graph.out[edge.from] ??= []).push(edge);
  (graph.inn[edge.to] ??= []).push(edge);
}

export interface SnapshotGraph extends DependencyGraph {
  docPaths: string[];
  deadPaths: string[];
  refIds: string[];
  tokenNodeIds: string[];
  rankNodeIds: string[];
  tokenOwners: Record<string, string[]>;
  tokenContentHash: Record<string, string>;
}

export function buildGraph(
  snapshot: Snapshot,
  deadPaths: string[] = [],
): SnapshotGraph {
  const graph = makeGraph() as SnapshotGraph;
  graph.docPaths = Object.keys(snapshot.docs).sort();
  graph.deadPaths = [...deadPaths].sort();
  graph.refIds = Object.keys(snapshot.refs).sort();
  graph.tokenNodeIds = [];
  graph.rankNodeIds = [];
  graph.tokenOwners = {};
  graph.tokenContentHash = {};

  for (const path of graph.deadPaths) {
    addNode(graph, {
      id: docId(path),
      kind: "doc",
      label: path,
      alive: false,
      pathSensitive: true,
    });
    addNode(graph, {
      id: tombstoneId(path),
      kind: "tombstone",
      label: `墓碑 ${path}`,
      alive: true,
      pathSensitive: true,
    });
    addEdge(graph, { from: docId(path), to: tombstoneId(path), type: "exists" });
    addEdge(graph, { from: tombstoneId(path), to: VIEWS.refGraph, type: "exists" });
  }

  for (const path of graph.docPaths) {
    const doc = snapshot.docs[path]!;
    addNode(graph, {
      id: docId(path),
      kind: "doc",
      label: path,
      alive: true,
      pathSensitive: true,
    });
    const hash = contentHashKey(doc.content, doc.parserVersion);
    const tokenNode = tokenId(hash, doc.parserVersion);
    graph.tokenContentHash[tokenNode] = hash;
    if (!graph.nodes[tokenNode]) {
      addNode(graph, {
        id: tokenNode,
        kind: "token",
        label: `tokens ${hash.slice(0, 6)}`,
        alive: true,
        pathSensitive: false,
      });
      graph.tokenNodeIds.push(tokenNode);
    }
    (graph.tokenOwners[tokenNode] ??= []).push(path);
    addEdge(graph, { from: docId(path), to: tokenNode, type: "content" });
    addEdge(graph, { from: docId(path), to: tokenNode, type: "parser" });

    const rankNode = rankId(path);
    addNode(graph, {
      id: rankNode,
      kind: "rank",
      label: `rank ${path}`,
      alive: true,
      pathSensitive: true,
    });
    graph.rankNodeIds.push(rankNode);
    addEdge(graph, { from: docId(path), to: rankNode, type: "path" });
    addEdge(graph, { from: rankNode, to: VIEWS.rank, type: "value" });
    addEdge(graph, { from: VIEWS.rank, to: rankNode, type: "value" });
  }

  for (const tokenNode of graph.tokenNodeIds.sort()) {
    addEdge(graph, { from: tokenNode, to: VIEWS.tokenIndex, type: "value" });
    addEdge(graph, { from: tokenNode, to: VIEWS.tokenFingerprint, type: "value" });
  }

  for (const key of graph.refIds) {
    const ref = snapshot.refs[key]!;
    const node = refId(key);
    addNode(graph, {
      id: node,
      kind: "ref",
      label: ref.label ? `${ref.label} (${key})` : key,
      alive: true,
      pathSensitive: true,
    });
    if (snapshot.docs[ref.from]) {
      addEdge(graph, { from: docId(ref.from), to: node, type: "path" });
    }
    if (snapshot.docs[ref.to]) {
      addEdge(graph, { from: docId(ref.to), to: node, type: "path" });
    }
    addEdge(graph, { from: node, to: VIEWS.refGraph, type: "value" });
    if (snapshot.docs[ref.from]) {
      addEdge(graph, { from: node, to: rankId(ref.from), type: "value" });
    }
    if (snapshot.docs[ref.to]) {
      addEdge(graph, { from: node, to: rankId(ref.to), type: "value" });
    }
  }

  const viewDefinitions: Array<[string, NodeKind, string, boolean]> = [
    [VIEWS.tokenIndex, "view-token-index", "倒排索引视图", false],
    [VIEWS.tokenFingerprint, "view-token-fingerprint", "内容指纹视图", false],
    [VIEWS.refGraph, "view-ref-graph", "引用图视图（含悬挂检查）", false],
    [VIEWS.rank, "view-rank", "环引用权威度视图", false],
  ];
  for (const [id, kind, label, pathSensitive] of viewDefinitions) {
    addNode(graph, { id, kind, label, alive: true, pathSensitive });
  }

  return graph;
}

export function graphEdgeKey(edge: GraphEdge): string {
  return `${edge.type}:${edge.from}->${edge.to}`;
}

export function edgeSignature(edge: GraphEdge): string {
  return graphEdgeKey(edge);
}

export function nodeContentSignature(
  snapshot: Snapshot,
  path: string,
): { content: string; parser: string } {
  const doc = snapshot.docs[path]!;
  return { content: fnv1aHex(doc.content), parser: doc.parserVersion };
}
