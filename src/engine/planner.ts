import type {
  AffectedInfo,
  ChangeSet,
  DependencyGraph,
  DependencyRoute,
  EdgeType,
  GraphEdge,
  NodeValue,
  OriginInfo,
  PlanAnalysis,
  Snapshot,
} from "./types";
import type { SnapshotGraph } from "./graph";
import { edgeSignature } from "./graph";
import { docId, refId } from "./ids";

export interface PlannerInput {
  changeSet: ChangeSet;
  baseSnapshot: Snapshot;
  targetSnapshot: Snapshot;
  baseGraph: SnapshotGraph;
  targetGraph: SnapshotGraph;
  baseValues: Record<string, NodeValue>;
  targetValues: Record<string, NodeValue>;
  fixedPointGroup: string[];
}

const MAX_ROUTES_PER_NODE = 6;

export function detectOrigins(input: PlannerInput): OriginInfo[] {
  const { changeSet, baseSnapshot, targetSnapshot, baseGraph, targetGraph } = input;
  const origins: OriginInfo[] = [];
  const seen = new Set<string>();
  const push = (origin: OriginInfo, key: string) => {
    if (!seen.has(key)) {
      seen.add(key);
      origins.push(origin);
    }
  };

  for (const op of changeSet.ops) {
    if (op.type === "renameDoc" && op.path && op.newPath) {
      push(
        { nodeId: docId(op.newPath), kind: "doc-rename-in", renameFrom: op.path, renameTo: op.newPath },
        `in:${op.newPath}`,
      );
      push(
        { nodeId: docId(op.path), kind: "doc-rename-out", renameFrom: op.path, renameTo: op.newPath },
        `out:${op.path}`,
      );
    }
  }

  const renameInPaths = new Set(origins.filter((o) => o.kind === "doc-rename-in").map((o) => o.renameTo!));
  const renameOutPaths = new Set(origins.filter((o) => o.kind === "doc-rename-out").map((o) => o.renameFrom!));

  const basePaths = new Set(baseGraph.docPaths);
  for (const path of targetGraph.docPaths) {
    if (!basePaths.has(path) && !renameInPaths.has(path)) {
      push({ nodeId: docId(path), kind: "doc-added" }, `add:${path}`);
    }
  }
  for (const path of baseGraph.docPaths) {
    if (!targetSnapshot.docs[path] && !renameOutPaths.has(path)) {
      push({ nodeId: docId(path), kind: "doc-deleted" }, `del:${path}`);
    }
  }

  for (const path of targetGraph.docPaths) {
    if (!baseSnapshot.docs[path]) {
      continue;
    }
    const baseDoc = baseSnapshot.docs[path]!;
    const targetDoc = targetSnapshot.docs[path]!;
    if (baseDoc.content !== targetDoc.content) {
      push({ nodeId: docId(path), kind: "doc-content" }, `content:${path}`);
    }
    if (baseDoc.parserVersion !== targetDoc.parserVersion) {
      push({ nodeId: docId(path), kind: "doc-parser" }, `parser:${path}`);
    }
  }

  const baseRefs = new Set(baseGraph.refIds);
  for (const key of targetGraph.refIds) {
    if (!baseRefs.has(key)) {
      push({ nodeId: refId(key), kind: "ref-added" }, `refadd:${key}`);
      continue;
    }
    const a = baseSnapshot.refs[key]!;
    const b = targetSnapshot.refs[key]!;
    if (a.from !== b.from || a.to !== b.to || (a.label ?? "") !== (b.label ?? "")) {
      push({ nodeId: refId(key), kind: "ref-changed" }, `refchg:${key}`);
    }
  }
  for (const key of baseGraph.refIds) {
    if (!targetSnapshot.refs[key]) {
      push({ nodeId: refId(key), kind: "ref-deleted" }, `refdel:${key}`);
    }
  }

  return origins.sort((a, b) => a.nodeId.localeCompare(b.nodeId) || a.kind.localeCompare(b.kind));
}

function edgesByKey(graph: DependencyGraph): Set<string> {
  return new Set(graph.edges.map(edgeSignature));
}

function originFiresEdge(
  edge: GraphEdge,
  origin: OriginInfo,
  inBase: boolean,
  inTarget: boolean,
): boolean {
  if (edge.from !== origin.nodeId) {
    return false;
  }
  let kindMatch = true;
  switch (origin.kind) {
    case "doc-content":
      kindMatch = edge.type === "content";
      break;
    case "doc-parser":
      kindMatch = edge.type === "parser";
      break;
    case "ref-changed":
      kindMatch = edge.type === "value";
      break;
    case "doc-rename-in":
    case "doc-rename-out":
      kindMatch = edge.type === "path" || edge.type === "exists";
      break;
    default:
      kindMatch = true;
  }
  if (!kindMatch) {
    return false;
  }
  if (inBase !== inTarget) {
    return true;
  }
  return true;
}

interface QueueItem {
  nodeId: string;
  route: DependencyRoute;
}

export function rankFixedPointGroup(graph: SnapshotGraph): string[] {
  return graph.rankNodeIds.includes("") ? [] : [...graph.rankNodeIds].sort();
}

function isSourceOrTomb(nodeId: string): boolean {
  return nodeId.startsWith("doc:") || nodeId.startsWith("tomb:");
}

export function planAnalysis(input: PlannerInput): PlanAnalysis {
  const { baseGraph, targetGraph, baseValues, targetValues, fixedPointGroup } = input;
  const origins = detectOrigins(input);
  const baseEdgeKeys = edgesByKey(baseGraph);
  const targetEdgeKeys = edgesByKey(targetGraph);

  const addedDerived = Object.keys(targetGraph.nodes).filter(
    (id) => !baseGraph.nodes[id] && !id.startsWith("doc:"),
  );
  const retired = Object.keys(baseGraph.nodes).filter(
    (id) =>
      !targetGraph.nodes[id] ||
      (baseGraph.nodes[id]!.alive && !targetGraph.nodes[id]!.alive),
  );
  const originNodeIds = new Set(origins.map((o) => o.nodeId));
  const sccSet = new Set(fixedPointGroup);

  const affectedMap = new Map<string, AffectedInfo>();
  const addRoute = (nodeId: string, route: DependencyRoute, inFixedPoint: boolean) => {
    let info = affectedMap.get(nodeId);
    if (!info) {
      info = {
        nodeId,
        routes: [],
        routeCount: 0,
        inFixedPoint,
        valueChanged: false,
      };
      affectedMap.set(nodeId, info);
    }
    info.routeCount += 1;
    if (info.routes.length < MAX_ROUTES_PER_NODE) {
      info.routes.push(route);
    }
    if (inFixedPoint) {
      info.inFixedPoint = true;
    }
  };

  const extend = (route: DependencyRoute, edge: GraphEdge): DependencyRoute => ({
    originId: route.originId,
    hops: [...route.hops, { from: edge.from, to: edge.to, type: edge.type }],
  });

  const valueChanged = (nodeId: string): boolean => {
    const a = baseValues[nodeId];
    const b = targetValues[nodeId];
    if (!a || !b) {
      return a?.valueHash !== b?.valueHash;
    }
    return a.valueHash !== b.valueHash;
  };

  const queue: QueueItem[] = [];
  for (const origin of origins) {
    const outgoing = new Map<string, GraphEdge>();
    for (const edge of [...(baseGraph.out[origin.nodeId] ?? []), ...(targetGraph.out[origin.nodeId] ?? [])]) {
      outgoing.set(edgeSignature(edge), edge);
    }
    for (const edge of outgoing.values()) {
      const key = edgeSignature(edge);
      if (!originFiresEdge(edge, origin, baseEdgeKeys.has(key), targetEdgeKeys.has(key))) {
        continue;
      }
      const route: DependencyRoute = {
        originId: origin.nodeId,
        hops: [{ from: edge.from, to: edge.to, type: edge.type }],
      };
      addRoute(edge.to, route, sccSet.has(edge.to));
      queue.push({ nodeId: edge.to, route });
    }
  }

  const processed = new Set<string>();
  while (queue.length > 0) {
    const item = queue.shift()!;
    const { nodeId, route } = item;
    const inBase = Boolean(baseGraph.nodes[nodeId]);
    const inTarget = Boolean(targetGraph.nodes[nodeId]);

    if (!inBase && inTarget) {
      for (const edge of targetGraph.out[nodeId] ?? []) {
        if (!targetGraph.nodes[edge.to]) {
          continue;
        }
        const nextRoute = extend(route, edge);
        addRoute(edge.to, nextRoute, sccSet.has(edge.to));
        queue.push({ nodeId: edge.to, route: nextRoute });
      }
      continue;
    }

    if (inBase && !inTarget) {
      for (const edge of baseGraph.out[nodeId] ?? []) {
        if (baseGraph.nodes[edge.to]?.alive === false) {
          continue;
        }
        const nextRoute = extend(route, edge);
        addRoute(edge.to, nextRoute, sccSet.has(edge.to));
        if (targetGraph.nodes[edge.to] || baseGraph.nodes[edge.to]) {
          queue.push({ nodeId: edge.to, route: nextRoute });
        }
      }
      continue;
    }

    if (processed.has(nodeId)) {
      continue;
    }
    if (nodeId.startsWith("doc:")) {
      continue;
    }
    processed.add(nodeId);
    const lastHopType = route.hops.at(-1)?.type;
    const pathDriven = lastHopType === "path" || lastHopType === "exists";
    const changed = valueChanged(nodeId);
    if (!changed && !pathDriven) {
      continue;
    }
    const allowed: EdgeType[] = pathDriven ? ["path", "exists", "value"] : ["value"];
    for (const edge of targetGraph.out[nodeId] ?? []) {
      if (!allowed.includes(edge.type) || !targetGraph.nodes[edge.to]) {
        continue;
      }
      const nextRoute = extend(route, edge);
      addRoute(edge.to, nextRoute, sccSet.has(edge.to));
      queue.push({ nodeId: edge.to, route: nextRoute });
    }
  }

  for (const member of fixedPointGroup) {
    const info = affectedMap.get(member);
    if (!info) {
      continue;
    }
    const memberToView = (targetGraph.out[member] ?? []).find(
      (edge) => edge.to === VIEWS_RANK && edge.type === "value",
    );
    if (!memberToView) {
      continue;
    }
    for (const other of fixedPointGroup) {
      if (other === member || affectedMap.has(other)) {
        continue;
      }
      const viewToOther = (targetGraph.out[VIEWS_RANK] ?? []).find(
        (edge) => edge.to === other && edge.type === "value",
      );
      if (!viewToOther) {
        continue;
      }
      const sample = info.routes[0];
      const baseRoute: DependencyRoute = sample ?? { originId: member, hops: [] };
      addRoute(
        other,
        { originId: baseRoute.originId, hops: [...baseRoute.hops, memberToView, viewToOther] },
        true,
      );
    }
  }

  for (const info of affectedMap.values()) {
    info.valueChanged = valueChanged(info.nodeId);
  }

  const affected = [...affectedMap.values()]
    .filter((info) => !originNodeIds.has(info.nodeId) && !info.nodeId.startsWith("doc:"))
    .sort((a, b) => a.nodeId.localeCompare(b.nodeId));

  const affectedIds = new Set(affected.map((info) => info.nodeId));
  const recomputed = new Set<string>();
  for (const id of affectedIds) {
    if (targetGraph.nodes[id]) {
      recomputed.add(id);
    }
  }
  for (const id of addedDerived) {
    if (affectedIds.has(id)) {
      recomputed.add(id);
    }
  }

  const reused = Object.keys(targetGraph.nodes)
    .filter((id) => !isSourceOrTomb(id) && !originNodeIds.has(id))
    .filter((id) => baseGraph.nodes[id] && !affectedIds.has(id) && !recomputed.has(id))
    .sort();

  const recomputedUnchanged = [...recomputed]
    .filter((id) => !valueChanged(id))
    .sort();

  const order = topoOrder(targetGraph, recomputed, sccSet);

  return {
    origins,
    affected,
    added: addedDerived.sort(),
    retired: retired.sort(),
    reused,
    recomputedUnchanged,
    order,
    fixedPointGroup: [...fixedPointGroup].sort(),
  };
}

const VIEWS_RANK = "view:rank";

function topoOrder(
  graph: SnapshotGraph,
  candidates: Set<string>,
  sccSet: Set<string>,
): string[] {
  const depth = new Map<string, number>();
  const visit = (nodeId: string, stack: Set<string>): number => {
    const cached = depth.get(nodeId);
    if (cached !== undefined) {
      return cached;
    }
    if (stack.has(nodeId)) {
      return 0;
    }
    stack.add(nodeId);
    let maxParent = -1;
    for (const edge of graph.inn[nodeId] ?? []) {
      if (!graph.nodes[edge.from] || isSourceOrTomb(edge.from)) {
        continue;
      }
      if (sccSet.has(nodeId) && sccSet.has(edge.from)) {
        continue;
      }
      maxParent = Math.max(maxParent, visit(edge.from, stack));
    }
    stack.delete(nodeId);
    const result = maxParent + 1;
    depth.set(nodeId, result);
    return result;
  };
  for (const id of candidates) {
    visit(id, new Set());
  }
  return [...candidates].sort((a, b) => {
    const da = depth.get(a) ?? 0;
    const db = depth.get(b) ?? 0;
    if (da !== db) {
      return da - db;
    }
    const sccA = sccSet.has(a) ? 1 : 0;
    const sccB = sccSet.has(b) ? 1 : 0;
    if (sccA !== sccB) {
      return sccA - sccB;
    }
    return a.localeCompare(b);
  });
}
