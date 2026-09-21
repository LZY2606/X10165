import { tokenize } from "./parser";
import type {
  FixedPointDiagnostics,
  GraphRefEdge,
  NodeValue,
  RevisionSummary,
  Snapshot,
} from "./types";
import type { SnapshotGraph } from "./graph";
import { contentHashKey, docId, rankId, refId, tombstoneId, VIEWS } from "./ids";
import { fnv1aHex, hashValue } from "./hash";

export const DEFAULT_TOLERANCE = 1e-6;
export const DEFAULT_DAMPING = 0.85;

export interface FixedPointResult {
  scores: Record<string, number>;
  iterations: number;
  maxDelta: number;
  converged: boolean;
  diagnostics: FixedPointDiagnostics;
}

export function computeFixedPoint(
  snapshot: Snapshot,
  budget: number,
  tolerance = DEFAULT_TOLERANCE,
  damping = DEFAULT_DAMPING,
  initial?: Record<string, number>,
): FixedPointResult {
  const livePaths = Object.keys(snapshot.docs).sort();
  if (livePaths.length === 0) {
    return {
      scores: {},
      iterations: 0,
      maxDelta: 0,
      converged: true,
      diagnostics: { iterations: 0, budget, tolerance, maxDelta: 0, converged: true },
    };
  }

  const incoming: Record<string, string[]> = {};
  const outCount: Record<string, number> = {};
  for (const path of livePaths) {
    incoming[path] = [];
    outCount[path] = 0;
  }
  for (const ref of Object.values(snapshot.refs)) {
    if (snapshot.docs[ref.from] && snapshot.docs[ref.to]) {
      incoming[ref.to]!.push(ref.from);
      outCount[ref.from]! += 1;
    }
  }

  const n = livePaths.length;
  let scores: Record<string, number> = {};
  if (initial && Object.keys(initial).length === n) {
    for (const path of livePaths) {
      scores[path] = initial[path] ?? 1 / n;
    }
  } else {
    for (const path of livePaths) {
      scores[path] = 1 / n;
    }
  }

  let iterations = 0;
  let maxDelta = Infinity;
  let converged = false;
  while (iterations < budget) {
    iterations += 1;
    const next: Record<string, number> = {};
    for (const path of livePaths) {
      let incomingScore = 0;
      for (const source of incoming[path]!) {
        incomingScore += scores[source]! / Math.max(outCount[source]!, 1);
      }
      next[path] = (1 - damping) / n + damping * incomingScore;
    }
    maxDelta = livePaths.reduce(
      (acc, path) => Math.max(acc, Math.abs(next[path]! - scores[path]!)),
      0,
    );
    scores = next;
    if (maxDelta <= tolerance) {
      converged = true;
      break;
    }
  }

  return {
    scores,
    iterations,
    maxDelta,
    converged,
    diagnostics: { iterations, budget, tolerance, maxDelta, converged },
  };
}

export interface FixedPointTrace extends FixedPointResult {
  perIteration: Array<{ iteration: number; maxDelta: number; scores: Record<string, number> }>;
}

export function computeFixedPointTrace(
  snapshot: Snapshot,
  budget: number,
  tolerance = DEFAULT_TOLERANCE,
  damping = DEFAULT_DAMPING,
  initial?: Record<string, number>,
): FixedPointTrace {
  const livePaths = Object.keys(snapshot.docs).sort();
  if (livePaths.length === 0) {
    return {
      scores: {},
      iterations: 0,
      maxDelta: 0,
      converged: true,
      diagnostics: { iterations: 0, budget, tolerance, maxDelta: 0, converged: true },
      perIteration: [],
    };
  }

  const incoming: Record<string, string[]> = {};
  const outCount: Record<string, number> = {};
  for (const path of livePaths) {
    incoming[path] = [];
    outCount[path] = 0;
  }
  for (const ref of Object.values(snapshot.refs)) {
    if (snapshot.docs[ref.from] && snapshot.docs[ref.to]) {
      incoming[ref.to]!.push(ref.from);
      outCount[ref.from]! += 1;
    }
  }

  const n = livePaths.length;
  let scores: Record<string, number> = {};
  if (initial && Object.keys(initial).length === n) {
    for (const path of livePaths) {
      scores[path] = initial[path] ?? 1 / n;
    }
  } else {
    for (const path of livePaths) {
      scores[path] = 1 / n;
    }
  }

  const perIteration: FixedPointTrace["perIteration"] = [];
  let iterations = 0;
  let maxDelta = Infinity;
  let converged = false;
  while (iterations < budget) {
    iterations += 1;
    const next: Record<string, number> = {};
    for (const path of livePaths) {
      let incomingScore = 0;
      for (const source of incoming[path]!) {
        incomingScore += scores[source]! / Math.max(outCount[source]!, 1);
      }
      next[path] = (1 - damping) / n + damping * incomingScore;
    }
    maxDelta = livePaths.reduce(
      (acc, path) => Math.max(acc, Math.abs(next[path]! - scores[path]!)),
      0,
    );
    scores = next;
    perIteration.push({
      iteration: iterations,
      maxDelta,
      scores: { ...scores },
    });
    if (maxDelta <= tolerance) {
      converged = true;
      break;
    }
  }

  return {
    scores,
    iterations,
    maxDelta,
    converged,
    diagnostics: { iterations, budget, tolerance, maxDelta, converged },
    perIteration,
  };
}

export interface FullValues {
  values: Record<string, NodeValue>;
  fixedPoint: FixedPointResult;
}

export function computeFullValues(
  snapshot: Snapshot,
  graph: SnapshotGraph,
  budget: number,
  tolerance = DEFAULT_TOLERANCE,
): FullValues {
  const values: Record<string, NodeValue> = {};

  for (const path of graph.deadPaths) {
    values[docId(path)] = {
      kind: "doc",
      valueHash: "",
      path,
      alive: false,
    };
    values[tombstoneId(path)] = {
      kind: "tombstone",
      valueHash: `tomb:${path}`,
      path,
      alive: true,
      reason: "deleteDoc",
      at: snapshot.tombstones[path]?.at,
    };
  }

  const tokenOwners: Record<string, string[]> = {};
  for (const path of graph.docPaths) {
    const doc = snapshot.docs[path]!;
    const contentHash = contentHashKey(doc.content, doc.parserVersion);
    values[docId(path)] = {
      kind: "doc",
      valueHash: fnv1aHex(`doc:${contentHash}`),
      path,
      alive: true,
      parserVersion: doc.parserVersion,
      contentHash,
    };

    const nodeId = Object.keys(graph.nodes)
      .filter((id) => id.startsWith("token:"))
      .find((id) => graph.tokenContentHash[id] === contentHash)!;
    (tokenOwners[nodeId] ??= []).push(path);
  }

  for (const tokenNode of graph.tokenNodeIds) {
    const owners = (tokenOwners[tokenNode] ?? []).sort();
    const ownerPath = owners[0]!;
    const doc = snapshot.docs[ownerPath]!;
    const tokens = tokenize(doc.content, doc.parserVersion);
    const contentHash = graph.tokenContentHash[tokenNode]!;
    values[tokenNode] = {
      kind: "token",
      valueHash: fnv1aHex(`token:${doc.parserVersion}:${tokens.join(",")}`),
      tokens,
      owners,
      parserVersion: doc.parserVersion,
      contentHash,
    };
  }

  for (const key of graph.refIds) {
    const ref = snapshot.refs[key]!;
    values[refId(key)] = {
      kind: "ref",
      valueHash: fnv1aHex(`ref:${ref.from}|${ref.to}|${ref.label ?? ""}`),
      refId: key,
      from: ref.from,
      to: ref.to,
      label: ref.label,
      alive: true,
    };
  }

  const inverted: Record<string, string[]> = {};
  const fingerprints: Record<string, string> = {};
  for (const tokenNode of graph.tokenNodeIds) {
    const tokenValue = values[tokenNode]!;
    const owners = tokenValue.owners!;
    fingerprints[tokenNode] = tokenValue.valueHash;
    for (const token of tokenValue.tokens!) {
      const list = inverted[token] ?? [];
      for (const owner of owners) {
        if (!list.includes(owner)) {
          list.push(owner);
        }
      }
      inverted[token] = list.sort();
    }
  }
  values[VIEWS.tokenFingerprint] = {
    kind: "view-token-fingerprint",
    valueHash: hashValue(Object.fromEntries(Object.entries(fingerprints).sort())),
    fingerprints,
  };

  const rankOwnedPaths = graph.docPaths.filter((path) => graph.nodes[rankId(path)]);
  const pathRankIndex = Object.fromEntries(rankOwnedPaths.map((path, i) => [path, i]));
  const sortedInverted: Record<string, string[]> = {};
  for (const term of Object.keys(inverted).sort()) {
    const paths = inverted[term]!
      .filter((path) => pathRankIndex[path] !== undefined)
      .sort((a, b) => pathRankIndex[a]! - pathRankIndex[b]! || a.localeCompare(b));
    if (paths.length > 0) {
      sortedInverted[term] = paths;
    }
  }
  values[VIEWS.tokenIndex] = {
    kind: "view-token-index",
    valueHash: hashValue(sortedInverted),
    inverted: sortedInverted,
  };

  const graphEdges: GraphRefEdge[] = [];
  let danglingCount = 0;
  for (const key of graph.refIds) {
    const ref = snapshot.refs[key]!;
    const dangling = !snapshot.docs[ref.from] || !snapshot.docs[ref.to];
    if (dangling) {
      danglingCount += 1;
    }
    graphEdges.push({ refId: key, from: ref.from, to: ref.to, label: ref.label, dangling });
  }
  graphEdges.sort((a, b) => a.refId.localeCompare(b.refId));
  const tombstoneList = graph.deadPaths.map((path) => ({
    path,
    at: snapshot.tombstones[path]?.at ?? 0,
  }));
  values[VIEWS.refGraph] = {
    kind: "view-ref-graph",
    valueHash: hashValue({ edges: graphEdges, tombstones: tombstoneList }),
    graphEdges,
    danglingCount,
  };

  const fixedPoint = computeFixedPoint(snapshot, budget, tolerance);
  for (const path of rankOwnedPaths) {
    values[rankId(path)] = {
      kind: "rank",
      valueHash: fnv1aHex(`rank:${path}:${fixedPoint.scores[path]?.toFixed(12) ?? "0"}`),
      path,
      score: fixedPoint.scores[path] ?? 0,
    };
  }
  values[VIEWS.rank] = {
    kind: "view-rank",
    valueHash: hashValue({
      scores: fixedPoint.scores,
      converged: fixedPoint.converged,
      iterations: fixedPoint.iterations,
    }),
    scores: fixedPoint.scores,
    iterations: fixedPoint.iterations,
    converged: fixedPoint.converged,
  };

  return { values, fixedPoint };
}

export function buildSummary(
  revisionId: string,
  parentId: string | null,
  changeSetId: string | null,
  snapshot: Snapshot,
  graph: SnapshotGraph,
  full: FullValues,
): RevisionSummary {
  const indexValue = full.values[VIEWS.tokenIndex]!;
  const refValue = full.values[VIEWS.refGraph]!;
  const rankValue = full.values[VIEWS.rank]!;
  const rankTop = Object.entries(rankValue.scores ?? {})
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([path, score]) => [path, Number(score.toFixed(9))] as [string, number]);
  return {
    revisionId,
    parentId,
    changeSetId,
    docsAlive: graph.docPaths.length,
    docsDead: graph.deadPaths.length,
    tokenNodes: graph.tokenNodeIds.length,
    refs: graph.refIds.length,
    danglingRefs: refValue.danglingCount ?? 0,
    indexTerms: Object.keys(indexValue.inverted ?? {}).length,
    fingerprints: { ...(full.values[VIEWS.tokenFingerprint]!.fingerprints ?? {}) },
    rankConverged: rankValue.converged !== false,
    rankIterations: rankValue.iterations ?? 0,
    rankTop,
    valueChecksum: valueChecksum(full.values),
  };
}

export function valueChecksum(values: Record<string, NodeValue>): string {
  const entries = Object.keys(values)
    .sort()
    .map((id) => `${id}:${values[id]!.valueHash}`)
    .join("|");
  return fnv1aHex(entries);
}
