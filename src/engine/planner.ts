import type {
  AffectedNode,
  Changeset,
  DependencyPath,
  Facet,
  GraphEdge,
  GraphNode,
  Plan,
  SCCGroup,
  Snapshot
} from './types.js';
import { buildGraph, nodeKey, tokenSet } from './graph.js';

interface Seed {
  key: string | null;
  facets: Facet[];
  reason: string;
  startNode?: string;
  force?: boolean;
}

const MAX_PATHS = 8;

/**
 * Compare base/post snapshots and enumerate change seeds with the facets
 * each change actually touches.
 */
export function diffSnapshots(changes: Changeset, base: Snapshot, post: Snapshot): Seed[] {
  const seeds: Seed[] = [];

  for (const change of changes.docChanges) {
    const before = base.docs[change.id];
    const after = post.docs[change.id];

    if (change.type === 'upsert' && after) {
      for (const token of tokenSet(post, change.id)) {
        seeds.push({
          key: nodeKey({ kind: 'token', docId: change.id, token }),
          facets: ['content', 'existence'],
          reason: `文档 ${change.id} 新建 (${after.path})`
        });
      }
      seeds.push(seedPathSensitive(change.id, 'existence', `文档 ${change.id} 新建`));
      continue;
    }

    if (change.type === 'delete') {
      const tokens = before ? tokenSet(base, change.id) : [];
      for (const token of tokens) {
        seeds.push({
          key: nodeKey({ kind: 'token', docId: change.id, token }),
          facets: ['content', 'existence'],
          reason: `文档 ${change.id} 删除（墓碑）`
        });
      }
      seeds.push(seedPathSensitive(change.id, 'existence', `文档 ${change.id} 删除（墓碑）`));
      continue;
    }

    if (change.type === 'rename') {
      const facets: Facet[] = [];
      if (before && after && before.content !== after.content) {
        facets.push('content');
      }
      if (before && after && before.parserVersion !== after.parserVersion) {
        facets.push('parser');
      }
      const pathChanged = before?.path !== after?.path;
      const contentLikeChanged = facets.length > 0;

      if (contentLikeChanged) {
        const beforeTokens = new Set(before ? tokenSet(base, change.id) : []);
        const afterTokens = new Set(tokenSet(post, change.id));
        const parserChanged = before?.parserVersion !== after?.parserVersion;
        for (const token of new Set([...beforeTokens, ...afterTokens])) {
          seeds.push({
            key: nodeKey({ kind: 'token', docId: change.id, token }),
            facets: ['content'],
            reason: parserReason(change.id, before?.parserVersion, after?.parserVersion),
            force: parserChanged
          });
        }
      }
      if (pathChanged || contentLikeChanged) {
        seeds.push(
          seedPathSensitive(
            change.id,
            pathChanged ? 'path' : 'content',
            pathChanged
              ? `文档 ${change.id} 路径改名 ${before?.path} → ${after?.path}`
              : `文档 ${change.id} 内容/解析器变化`
          )
        );
      }
    }
  }

  for (const change of changes.refChanges) {
    const before = base.refs[change.id];
    const after = post.refs[change.id];
    let reason = '';
    if (change.type === 'add' && after) {
      reason = `引用 ${change.id} 新增 ${after.fromDoc}→${after.toDoc}`;
    } else if (change.type === 'remove') {
      reason = `引用 ${change.id} 删除 ${before?.fromDoc}→${before?.toDoc}`;
    } else if (change.type === 'retarget') {
      reason = `引用 ${change.id} 改指 ${before?.fromDoc}→${before?.toDoc} 变为 ${after?.fromDoc}→${after?.toDoc}`;
    }
    pushRefSeeds(seeds, change.type === 'remove' ? before : after, reason);
  }

  return seeds;
}

function parserReason(docId: string, a?: number, b?: number): string {
  if (a !== b) {
    return `文档 ${docId} 解析器版本 v${a} → v${b}`;
  }
  return `文档 ${docId} 内容变化`;
}

function seedPathSensitive(docId: string, facet: Facet, reason: string): Seed {
  return {
    key: null,
    facets: [facet],
    reason,
    startNode: `__doc:${docId}`
  };
}

function pushRefSeeds(seeds: Seed[], ref: { fromDoc: string; toDoc: string } | undefined, reason: string) {
  if (!ref) {
    return;
  }
  seeds.push({
    key: null,
    facets: ['reference'],
    reason,
    startNode: `__backlinks:${ref.toDoc}`
  });
  seeds.push({
    key: null,
    facets: ['reference'],
    reason,
    startNode: `__rank:${ref.fromDoc}`
  });
  seeds.push({
    key: null,
    facets: ['reference'],
    reason,
    startNode: `__rank:${ref.toDoc}`
  });
}

type RecordFn = (
  key: string,
  facets: Facet[],
  path: DependencyPath,
  reason: string,
  force?: boolean
) => void;

interface Reached {
  key: string;
  paths: DependencyPath[];
  reasons: Set<string>;
  facets: Set<Facet>;
  force: boolean;
}

interface UnionGraph {
  nodes: Map<string, GraphNode>;
  edges: GraphEdge[];
}

function unionGraph(a: UnionGraph, b: UnionGraph): UnionGraph {
  const nodes = new Map<string, GraphNode>();
  for (const [key, node] of a.nodes) {
    nodes.set(key, { ...node, incoming: [], outgoing: [] });
  }
  for (const [key, node] of b.nodes) {
    if (!nodes.has(key)) {
      nodes.set(key, { ...node, incoming: [], outgoing: [] });
    }
  }
  const edgeKey = (e: GraphEdge) => `${e.from}|${e.to}|${e.via}`;
  const seen = new Set<string>();
  const edges: GraphEdge[] = [];
  for (const edge of [...a.edges, ...b.edges]) {
    const k = edgeKey(edge);
    if (!seen.has(k)) {
      seen.add(k);
      edges.push(edge);
    }
  }
  for (const edge of edges) {
    nodes.get(edge.from)?.outgoing.push(edge);
    nodes.get(edge.to)?.incoming.push(edge);
  }
  return { nodes, edges };
}

function virtualEdges(seed: Seed, graph: UnionGraph): { to: string; facets: Facet[] }[] {
  if (seed.startNode?.startsWith('__doc:')) {
    const docId = seed.startNode.slice('__doc:'.length);
    const out: { to: string; facets: Facet[] }[] = [];
    for (const node of graph.nodes.values()) {
      if (
        (node.kind === 'backlinks' || node.kind === 'rank') &&
        node.id.kind !== 'index' &&
        'docId' in node.id &&
        node.id.docId === docId
      ) {
        out.push({
          to: node.key,
          facets: seed.facets.includes('existence')
            ? ['existence', 'path']
            : ['path']
        });
      }
      if (
        node.kind === 'posting' &&
        'docId' in node.id &&
        node.id.docId === docId
      ) {
        out.push({ to: node.key, facets: ['path'] });
      }
    }
    return out;
  }
  return [];
}

function virtualTarget(seed: Seed): string | null {
  if (seed.startNode?.startsWith('__backlinks:')) {
    return nodeKey({ kind: 'backlinks', docId: seed.startNode.slice('__backlinks:'.length) });
  }
  if (seed.startNode?.startsWith('__rank:')) {
    return nodeKey({ kind: 'rank', docId: seed.startNode.slice('__rank:'.length) });
  }
  return null;
}

function sourceLabel(seed: Seed): string {
  if (seed.key) {
    const { local } = parseNodeKey(seed.key);
    const slash = local.indexOf('/');
    return `doc:${slash >= 0 ? local.slice(0, slash) : local}`;
  }
  return seed.startNode ?? 'change';
}

function parseNodeKey(key: string): { kind: string; local: string } {
  const idx = key.indexOf(':');
  return { kind: key.slice(0, idx), local: key.slice(idx + 1) };
}

import { presentingFacets } from './graph.js';

export interface PlanInput {
  revisionId: string;
  baseRevisionId: string;
  changes: Changeset;
  base: Snapshot;
  post: Snapshot;
  committedKeys: Set<string>;
}

/**
 * Build an invalidation plan: affected set, dependency paths, recompute
 * ordering (SCC-aware) and reusable items.
 */
export function buildPlan(input: PlanInput): Plan {
  const beforeGraph = buildGraph(input.base);
  const afterGraph = buildGraph(input.post);
  const graph = unionGraph(
    { nodes: beforeGraph.nodes, edges: beforeGraph.edges },
    { nodes: afterGraph.nodes, edges: afterGraph.edges }
  );

  const seeds = diffSnapshots(input.changes, input.base, input.post);
  const reached = propagateFiltered(seeds, graph);

  const affected: AffectedNode[] = [];
  const deletedKeys: string[] = [];
  const reusableKeys: string[] = [];

  for (const [key, entry] of reached) {
    const postNode = afterGraph.nodes.get(key);
    const beforeNode = beforeGraph.nodes.get(key);
    const reasons = Array.from(entry.reasons).sort();
    const paths = entry.paths;

    if (!postNode) {
      if (beforeNode) {
        deletedKeys.push(key);
        affected.push({
          key,
          kind: (beforeNode ?? graph.nodes.get(key))!.kind,
          pathSensitive: (beforeNode ?? graph.nodes.get(key))!.pathSensitive,
          status: 'delete',
          reasons,
          paths
        });
      }
      continue;
    }

    const structuralTouched =
      entry.facets.has('path') ||
      entry.facets.has('existence') ||
      entry.facets.has('reference');
    const candidate =
      postNode &&
      !structuralTouched &&
      !entry.force &&
      (input.committedKeys.has(key) || !!beforeNode);
    if (candidate) {
      reusableKeys.push(key);
    }
    affected.push({
      key,
      kind: postNode.kind,
      pathSensitive: postNode.pathSensitive,
      status: candidate ? 'reuse' : 'recompute',
      reasons,
      paths
    });
  }

  for (const [key, node] of afterGraph.nodes) {
    const existedBefore = beforeGraph.nodes.has(key);
    if (reached.has(key)) {
      continue;
    }
    if (!existedBefore) {
      affected.push({
        key,
        kind: node.kind,
        pathSensitive: node.pathSensitive,
        status: 'recompute',
        reasons: ['新增结构节点'],
        paths: [{ nodes: ['changeset', key], edges: ['结构新增'] }]
      });
    }
  }

  for (const key of afterGraph.nodes.keys()) {
    const untouched = !reached.has(key);
    const survived = beforeGraph.nodes.has(key);
    const known = input.committedKeys.has(key) || survived;
    if (untouched && survived && known) {
      reusableKeys.push(key);
    }
  }
  for (const key of affected.filter((a) => a.status === 'reuse').map((a) => a.key)) {
    if (!reusableKeys.includes(key)) {
      reusableKeys.push(key);
    }
  }

  const recomputeKeys = affected
    .filter((a) => a.status === 'recompute')
    .map((a) => a.key)
    .sort();

  const contextRankKeys = Array.from(afterGraph.nodes.values())
    .filter((n) => n.kind === 'rank')
    .map((n) => n.key);

  const ordering = orderNodes(recomputeKeys, contextRankKeys, afterGraph);
  const groups = ordering.groups;
  const cycles = groups
    .filter((g) => g.edgesInternal > 0)
    .map((g) => g.members.filter((m) => recomputeKeys.includes(m)));

  const entries: Plan['entries'] = [];
  let order = 0;
  for (const key of ordering.order) {
    const info = affected.find((a) => a.key === key)!;
    const group = ordering.nodeGroup.get(key);
    entries.push({
      type: 'recompute',
      key,
      kind: info.kind,
      order: order++,
      groupId: group,
      paths: info.paths,
      reasons: info.reasons
    });
  }
  for (const key of deletedKeys.sort().reverse()) {
    const info = affected.find((a) => a.key === key)!;
    entries.push({ type: 'delete', key, kind: info.kind, order: order++, paths: info.paths, reasons: info.reasons });
  }

  return {
    revisionId: input.revisionId,
    baseRevisionId: input.baseRevisionId,
    affected,
    entries,
    groups,
    deletedKeys: deletedKeys.sort().reverse(),
    reusableKeys: reusableKeys.sort(),
    cycles
  };
}

function propagateFiltered(seeds: Seed[], graph: UnionGraph): Map<string, Reached> {
  const reached = new Map<string, Reached>();

  const record: RecordFn = (key, facets, path, reason, force = false) => {
    let entry = reached.get(key);
    if (!entry) {
      entry = { key, paths: [], reasons: new Set(), facets: new Set(), force: false };
      reached.set(key, entry);
    }
    if (entry.paths.length < MAX_PATHS) {
      entry.paths.push(path);
    }
    entry.reasons.add(reason);
    for (const facet of facets) {
      entry.facets.add(facet);
    }
    if (force) {
      entry.force = true;
    }
  };

  for (const seed of seeds) {
    const label = sourceLabel(seed);
    if (seed.key) {
      if (graph.nodes.has(seed.key)) {
        record(seed.key, seed.facets, { nodes: [label, seed.key], edges: [seed.reason] }, seed.reason, seed.force);
      }
      descend(graph, seed.key, seed.facets, [label, seed.key], [seed.reason], seed.reason, record, seed.force);
      continue;
    }
    const direct = virtualTarget(seed);
    if (direct && graph.nodes.has(direct)) {
      record(direct, seed.facets, { nodes: [label, direct], edges: [seed.reason] }, seed.reason, seed.force);
      descend(graph, direct, seed.facets, [label, direct], [seed.reason], seed.reason, record, seed.force);
      continue;
    }
    for (const ve of virtualEdges(seed, graph)) {
      if (!graph.nodes.has(ve.to)) {
        continue;
      }
      const facets = seed.facets.includes('existence') ? ve.facets : seed.facets;
      const accepted = facets.filter((f) => presentingFacets(graph.nodes.get(ve.to)!.kind).includes(f));
      if (accepted.length === 0) {
        continue;
      }
      record(ve.to, accepted, { nodes: [label, ve.to], edges: [seed.reason] }, seed.reason, seed.force);
      descend(graph, ve.to, accepted, [label, ve.to], [seed.reason], seed.reason, record, seed.force);
    }
  }

  return reached;
}

function descend(
  graph: UnionGraph,
  fromKey: string,
  facets: Facet[],
  nodes: string[],
  edges: string[],
  reason: string,
  record: RecordFn,
  force = false
): void {
  const node = graph.nodes.get(fromKey);
  if (!node || nodes.length > 14) {
    return;
  }
  for (const edge of node.outgoing) {
    const target = graph.nodes.get(edge.to);
    if (!target) {
      continue;
    }
    const carry = edge.facets.filter((f) => facets.includes(f));
    const accepted = carry.filter((f) => presentingFacets(target.kind).includes(f));
    if (accepted.length === 0 || nodes.includes(edge.to)) {
      continue;
    }
    const nextNodes = [...nodes, edge.to];
    const nextEdges = [...edges, edge.via];
    record(edge.to, accepted, { nodes: nextNodes, edges: nextEdges }, reason, force);
    descend(graph, edge.to, accepted, nextNodes, nextEdges, reason, record, force);
  }
}

interface Ordering {
  order: string[];
  groups: SCCGroup[];
  nodeGroup: Map<string, number>;
}

/**
 * Tarjan SCC (iterative) over recompute nodes of the post-change graph,
 * then a stable topological order of SCCs. Non-trivial SCCs become
 * fixed-point groups.
 */
function orderNodes(
  keys: string[],
  contextKeys: string[],
  graph: { nodes: Map<string, GraphNode>; edges: GraphEdge[] }
): Ordering {
  const keySet = new Set(keys);
  const sccKeys = Array.from(new Set([...keys, ...contextKeys])).sort();
  const sccSet = new Set(sccKeys);
  const indexOf = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];
  let counter = 0;

  interface Frame {
    key: string;
    next: number;
  }

  for (const root of sccKeys) {
    if (indexOf.has(root)) {
      continue;
    }
    const frames: Frame[] = [{ key: root, next: 0 }];
    indexOf.set(root, counter);
    low.set(root, counter);
    counter++;
    stack.push(root);
    onStack.add(root);

    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      const node = graph.nodes.get(frame.key);
      const neighbors = node
        ? node.outgoing
            .filter((e) => e.to.startsWith('rank:') && sccSet.has(e.to))
            .map((e) => e.to)
            .sort()
        : [];

      if (frame.next < neighbors.length) {
        const w = neighbors[frame.next++];
        if (!indexOf.has(w)) {
          indexOf.set(w, counter);
          low.set(w, counter);
          counter++;
          stack.push(w);
          onStack.add(w);
          frames.push({ key: w, next: 0 });
        } else if (onStack.has(w)) {
          low.set(frame.key, Math.min(low.get(frame.key)!, indexOf.get(w)!));
        } else if (indexOf.has(w) && !onStack.has(w)) {
          low.set(frame.key, Math.min(low.get(frame.key)!, low.get(w)!));
        }
      } else {
        if (low.get(frame.key) === indexOf.get(frame.key)) {
          const component: string[] = [];
          for (;;) {
            const w = stack.pop()!;
            onStack.delete(w);
            component.push(w);
            if (w === frame.key) {
              break;
            }
          }
          sccs.push(component.sort());
        }
        frames.pop();
        if (frames.length > 0) {
          const parentFrame = frames[frames.length - 1];
          low.set(parentFrame.key, Math.min(low.get(parentFrame.key)!, low.get(frame.key)!));
        }
      }
    }
  }

  const groupOf = new Map<string, number>();
  const groups: SCCGroup[] = [];
  sccs.forEach((members, idx) => {
    for (const member of members) {
      groupOf.set(member, idx);
    }
    const memberSet = new Set(members);
    let edgesInternal = 0;
    const counted = new Set<string>();
    for (const member of members) {
      const node = graph.nodes.get(member);
      if (!node) {
        continue;
      }
      for (const edge of node.outgoing) {
        if (edge.to.startsWith('rank:') && memberSet.has(edge.to)) {
          const k = `${edge.from}>${edge.to}>${edge.via}`;
          if (!counted.has(k)) {
            counted.add(k);
            edgesInternal++;
          }
        }
      }
    }
    groups.push({ id: idx, members, edgesInternal });
  });

  const activeGroupIds = groups
    .filter((g) => g.members.some((m) => keySet.has(m)))
    .map((g) => g.id);

  // Order every recompute node with Kahn on the post graph,
  // treating each non-trivial rank SCC as one unit.
  const inGroupOf = new Map<string, number>();
  for (const gid of activeGroupIds) {
    for (const member of groups[gid].members) {
      if (keySet.has(member)) {
        inGroupOf.set(member, gid);
      }
    }
  }

  type Unit = { id: string; keys: string[]; groupId?: number };
  const units = new Map<string, Unit>();
  for (const key of keys) {
    const gid = inGroupOf.get(key);
    if (gid !== undefined) {
      const uid = `group:${gid}`;
      let unit = units.get(uid);
      if (!unit) {
        unit = { id: uid, keys: [], groupId: gid };
        units.set(uid, unit);
      }
      unit.keys.push(key);
    } else {
      units.set(`node:${key}`, { id: `node:${key}`, keys: [key] });
    }
  }
  for (const unit of units.values()) {
    unit.keys.sort();
  }

  const unitKeyOf = (key: string): string => {
    const gid = inGroupOf.get(key);
    return gid !== undefined ? `group:${gid}` : `node:${key}`;
  };

  const indegree = new Map<string, number>();
  const outgoing = new Map<string, Set<string>>();
  for (const uid of units.keys()) {
    indegree.set(uid, 0);
    outgoing.set(uid, new Set());
  }
  const rankUnits = Array.from(units.keys()).filter((uid) =>
    units.get(uid)!.keys.every((k) => k.startsWith('rank:'))
  );
  const addOrderingEdge = (fromUnit: string, toUnit: string) => {
    if (fromUnit === toUnit || !units.has(fromUnit) || !units.has(toUnit)) {
      return;
    }
    if (!outgoing.get(fromUnit)!.has(toUnit)) {
      outgoing.get(fromUnit)!.add(toUnit);
      indegree.set(toUnit, (indegree.get(toUnit) ?? 0) + 1);
    }
  };
  for (const key of keys) {
    if (!key.startsWith('backlinks:')) {
      continue;
    }
    const backlinkUnit = unitKeyOf(key);
    for (const rankUnit of rankUnits) {
      addOrderingEdge(rankUnit, backlinkUnit);
    }
  }
  for (const key of keys) {
    const node = graph.nodes.get(key);
    if (!node) {
      continue;
    }
    const targetUnit = unitKeyOf(key);
    for (const edge of node.incoming) {
      if (!keySet.has(edge.from)) {
        continue;
      }
      const sourceUnit = unitKeyOf(edge.from);
      if (sourceUnit !== targetUnit && !outgoing.get(sourceUnit)!.has(targetUnit)) {
        outgoing.get(sourceUnit)!.add(targetUnit);
        indegree.set(targetUnit, (indegree.get(targetUnit) ?? 0) + 1);
      }
    }
  }

  const ready = Array.from(units.keys())
    .filter((uid) => (indegree.get(uid) ?? 0) === 0)
    .sort();
  const order: string[] = [];
  const nodeGroup = new Map<string, number>();
  while (ready.length > 0) {
    const uid = ready.shift()!;
    const unit = units.get(uid)!;
    for (const key of unit.keys) {
      order.push(key);
      if (unit.groupId !== undefined) {
        nodeGroup.set(key, unit.groupId);
      }
    }
    for (const target of Array.from(outgoing.get(uid) ?? []).sort()) {
      const deg = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, deg);
      if (deg === 0) {
        ready.push(target);
        ready.sort();
      }
    }
  }

  return {
    order,
    groups: groups.filter((g) => activeGroupIds.includes(g.id)),
    nodeGroup
  };
}

