// 失效规划器：
// 1) 逐节点比较结构指纹，找出变化源（seed）及其变化味道；
// 2) 味道感知传播：只有边上声明的依赖味道与变化味道相交才继续扩散；
// 3) 记录每个失效节点从变化源出发的代表依赖路径；
// 4) 在受影响子图上做 SCC 分解：环 -> 固定点组，其余 -> 单节点组，稳定拓扑排序。

import type {
  ChangeKind,
  Edge,
  EdgeFlavor,
  Graph,
  OrderedGroup,
  Plan,
  Seed,
  SerialNode,
} from './types';
import { nodeIds, nodeSignature } from './builder';

interface Reachable {
  reasons: Set<ChangeKind>;
  via: { from: string; flavors: EdgeFlavor[] } | null;
  distance: number;
}

function seedReasonsForAdd(type: SerialNode['type']): ChangeKind[] {
  switch (type) {
    case 'doc':
      return ['content', 'path', 'exists', 'parser-version'];
    case 'tokens':
      return ['content', 'parser-version', 'exists'];
    case 'reference':
      return ['graph', 'exists'];
    case 'resolved':
      return ['graph', 'exists'];
    case 'custom':
      return ['content', 'exists'];
    case 'fingerprint':
      return ['content', 'exists'];
    default:
      return ['content'];
  }
}

/** 比较新旧节点，得出该节点自身发生了哪些“味道”的变化。 */
function diffReasons(oldNode: SerialNode | undefined, newNode: SerialNode): ChangeKind[] {
  if (!oldNode) return seedReasonsForAdd(newNode.type);
  const reasons: ChangeKind[] = [];
  if (newNode.type === 'doc') {
    if (oldNode.label !== newNode.label) reasons.push('path');
    if (oldNode.contentHash !== newNode.contentHash) reasons.push('content');
    if (oldNode.parserVersion !== newNode.parserVersion) reasons.push('parser-version');
  } else if (newNode.type === 'tokens') {
    if (oldNode.parserVersion !== newNode.parserVersion) reasons.push('parser-version');
  } else if (newNode.type === 'reference') {
    if (oldNode.targetPath !== newNode.targetPath || oldNode.sourceDocId !== newNode.sourceDocId) {
      reasons.push('graph');
    }
  } else if (newNode.type === 'custom') {
    if (oldNode.ruleHash !== newNode.ruleHash || oldNode.label !== newNode.label) {
      reasons.push('content');
    }
  }
  if (!oldNode.tombstone && newNode.tombstone) reasons.push('exists');
  if (oldNode.tombstone && !newNode.tombstone) reasons.push('exists');
  return [...new Set(reasons)];
}

function describeSeed(node: SerialNode, reasons: ChangeKind[], isNew: boolean): string {
  const flavorText: Record<ChangeKind, string> = {
    content: '内容',
    path: '路径',
    exists: '存在性',
    'parser-version': '解析器版本',
    graph: '引用图',
  };
  const what = reasons.map((r) => flavorText[r]).join('、');
  if (node.tombstone) return `${node.label} 被删除（墓碑），变化：${what}`;
  if (isNew) return `${node.label} 新建，变化：${what}`;
  return `${node.label} 自身改变，变化：${what}`;
}

const SEED_TYPES = new Set<SerialNode['type']>([
  'doc',
  'tokens',
  'reference',
  'custom',
]);

function outgoingIndex(graph: Graph): Map<string, Edge[]> {
  const index = new Map<string, Edge[]>();
  for (const edgeItem of graph.edges) {
    const list = index.get(edgeItem.from) ?? [];
    list.push(edgeItem);
    index.set(edgeItem.from, list);
  }
  return index;
}

/** Tarjan SCC，仅在给定节点集合与边集合上运行。 */
function tarjanScc(nodes: string[], edges: Edge[]): string[][] {
  const adj = new Map<string, string[]>();
  const nodeSet = new Set(nodes);
  for (const n of nodes) adj.set(n, []);
  for (const e of edges) {
    if (nodeSet.has(e.from) && nodeSet.has(e.to)) adj.get(e.from)!.push(e.to);
  }
  for (const list of adj.values()) list.sort();

  let indexCounter = 0;
  const indices = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const sccs: string[][] = [];

  const strongConnect = (v: string) => {
    indices.set(v, indexCounter);
    low.set(v, indexCounter);
    indexCounter += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of adj.get(v) ?? []) {
      if (!indices.has(w)) {
        strongConnect(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, indices.get(w)!));
      }
    }
    if (low.get(v) === indices.get(v)) {
      const component: string[] = [];
      let w: string;
      do {
        w = stack.pop() as string;
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      sccs.push(component.sort());
    }
  };

  for (const n of [...nodes].sort()) {
    if (!indices.has(n)) strongConnect(n);
  }
  return sccs;
}

export interface PlanInput {
  revisionId: string;
  parentRevisionId: string | null;
  graph: Graph;
  parentGraph: Graph | null;
}

export function buildPlan(input: PlanInput): Plan {
  const { graph, parentGraph } = input;
  const seeds: Seed[] = [];

  // 1) 变化源检测（遍历新旧图并集，被删除的墓碑节点也是变化源）
  const allIds = new Set([
    ...Object.keys(graph.nodes),
    ...Object.keys(parentGraph?.nodes ?? {}),
  ]);
  for (const id of [...allIds].sort()) {
    const node = graph.nodes[id];
    if (!node) continue;
    if (!SEED_TYPES.has(node.type)) continue;
    const oldNode = parentGraph?.nodes[id];
    const isNew = !oldNode;
    // 全新的内容块/解析器不是变化源（它们是不可变基础数据），由 bootstrap 处理
    if (isNew) {
      if (node.type === 'tokens' && !node.tombstone) {
        // tokens 节点不会独立新建；其新建一定跟随文档，文档自身已覆盖，跳过避免噪声
        continue;
      }
    }
    const reasons = diffReasons(oldNode, node);
    if (reasons.length === 0) continue;
    seeds.push({
      nodeId: id,
      reasons,
      tombstone: !!node.tombstone,
      detail: describeSeed(node, reasons, isNew),
    });
  }

  // 2) 味道感知传播
  const outgoing = outgoingIndex(graph);
  const reached = new Map<string, Reachable>();
  const queue: { id: string; reasons: Set<ChangeKind> }[] = [];
  for (const seed of seeds) {
    reached.set(seed.nodeId, {
      reasons: new Set(seed.reasons),
      via: null,
      distance: 0,
    });
    queue.push({ id: seed.nodeId, reasons: new Set(seed.reasons) });
  }

  while (queue.length > 0) {
    queue.sort((a, b) => (a.id === b.id ? 0 : a.id < b.id ? -1 : 1));
    const current = queue.shift()!;
    for (const edgeItem of outgoing.get(current.id) ?? []) {
      const matched = edgeItem.flavors.filter((f) => current.reasons.has(f));
      if (matched.length === 0) continue;
      // 穿过边后，下游节点在“该边声明的全部依赖味道”上变脏
      const carried = new Set<ChangeKind>(edgeItem.flavors);
      const existing = reached.get(edgeItem.to);
      const nextDistance = (reached.get(current.id)?.distance ?? 0) + 1;
      if (!existing || nextDistance < existing.distance) {
        reached.set(edgeItem.to, {
          reasons: new Set([...(existing?.reasons ?? []), ...carried]),
          via: { from: current.id, flavors: matched },
          distance: nextDistance,
        });
        queue.push({ id: edgeItem.to, reasons: carried });
      } else {
        let added = false;
        for (const r of carried) {
          if (!existing.reasons.has(r)) {
            existing.reasons.add(r);
            added = true;
          }
        }
        if (added) queue.push({ id: edgeItem.to, reasons: existing.reasons });
      }
    }
  }

  const affectedIds = [...reached.keys()].sort();
  const affectedSet = new Set(affectedIds);

  // 3) 可复用项：父快照中已有值、且本次没有失效的节点
  const reusableIds: string[] = [];
  for (const id of Object.keys(graph.nodes).sort()) {
    const node = graph.nodes[id];
    if (affectedSet.has(id)) continue;
    if (node.tombstone) continue;
    const parentNode = parentGraph?.nodes[id];
    if (parentNode?.value) reusableIds.push(id);
  }

  // 4) bootstrap：新出现但无上游变化源的不可变基础节点（blob / parser）
  const bootstrapIds = Object.keys(graph.nodes)
    .filter((id) => {
      const node = graph.nodes[id];
      if (node.type !== 'blob' && node.type !== 'parser') return false;
      if (affectedSet.has(id)) return false;
      return !parentGraph?.nodes[id]?.value;
    })
    .sort();

  // 5) 依赖路径回溯（BFS 记录的 via 链）
  const paths: Record<string, string[]> = {};
  const pathFlavors: Record<string, EdgeFlavor[]> = {};
  for (const id of affectedIds) {
    if (reached.get(id)?.via === null) {
      paths[id] = [id];
      pathFlavors[id] = [];
      continue;
    }
    const chain: string[] = [id];
    const flavors: EdgeFlavor[] = [];
    let cursor = id;
    let guard = 0;
    while (guard++ < 10000) {
      const info = reached.get(cursor);
      if (!info?.via) break;
      flavors.unshift(...info.via.flavors);
      cursor = info.via.from;
      chain.unshift(cursor);
    }
    paths[id] = chain;
    pathFlavors[id] = flavors;
  }

  // 6) 受影响子图上的 SCC + 稳定拓扑排序
  const computeIds = [...bootstrapIds, ...affectedIds.filter((id) => {
    const node = graph.nodes[id];
    return node.type !== 'doc' && node.type !== 'reference';
  })].sort();
  // 变化源中的 doc/reference 也要物化新值（供 UI/摘要），同样纳入顺序
  for (const id of affectedIds) {
    const node = graph.nodes[id];
    if ((node.type === 'doc' || node.type === 'reference') && !computeIds.includes(id)) {
      computeIds.push(id);
    }
  }
  computeIds.sort();

  const computeSet = new Set(computeIds);
  const subEdges = graph.edges.filter((e) => computeSet.has(e.from) && computeSet.has(e.to));
  const sccs = tarjanScc(computeIds, subEdges);

  const memberToScc = new Map<string, number>();
  sccs.forEach((scc, idx) => {
    for (const member of scc) memberToScc.set(member, idx);
  });
  const selfLoops = new Set<string>();
  for (const e of subEdges) {
    if (e.from === e.to) selfLoops.add(e.from);
  }

  // 缩聚图上 Kahn
  const sccIncoming = new Map<number, Set<number>>();
  const sccOutgoing = new Map<number, Set<number>>();
  sccs.forEach((_, idx) => {
    sccIncoming.set(idx, new Set());
    sccOutgoing.set(idx, new Set());
  });
  for (const e of subEdges) {
    const a = memberToScc.get(e.from)!;
    const b = memberToScc.get(e.to)!;
    if (a !== b) {
      sccOutgoing.get(a)!.add(b);
      sccIncoming.get(b)!.add(a);
    }
  }

  const sccOrder: number[] = [];
  const ready = sccs
    .map((_, idx) => idx)
    .filter((idx) => sccIncoming.get(idx)!.size === 0)
    .sort((a, b) => sccs[a][0].localeCompare(sccs[b][0]));
  const indegree = new Map<number, number>(sccs.map((_, idx) => [idx, sccIncoming.get(idx)!.size]));
  while (ready.length > 0) {
    const idx = ready.shift()!;
    sccOrder.push(idx);
    for (const next of [...sccOutgoing.get(idx)!].sort((a, b) => sccs[a][0].localeCompare(sccs[b][0]))) {
      indegree.set(next, (indegree.get(next) ?? 0) - 1);
      if (indegree.get(next) === 0) ready.push(next);
    }
  }

  const orderGroups: OrderedGroup[] = [];
  const cycles: string[][] = [];
  sccOrder.forEach((sccIndex, position) => {
    const members = sccs[sccIndex];
    const isCycle = members.length > 1 || selfLoops.has(members[0]);
    if (isCycle) cycles.push(members);
    orderGroups.push({
      index: position,
      kind: isCycle ? 'fixedpoint' : 'single',
      nodeIds: members,
    });
  });

  const tombstoneIds = seeds.filter((s) => s.tombstone).map((s) => s.nodeId).sort();

  return {
    revisionId: input.revisionId,
    parentRevisionId: input.parentRevisionId,
    seeds,
    affectedIds,
    reusableIds: reusableIds.sort(),
    tombstoneIds,
    paths,
    pathFlavors,
    orderGroups,
    cycles,
  };
}

export const _testing = { nodeIds };
