// 依赖图构建：从当前快照的文档/引用/自定义视图规格生成节点与依赖边，
// 并与父 revision 的图合并，保留删除节点作为墓碑。

import type {
  Edge,
  EdgeFlavor,
  GNode,
  Graph,
  NodeType,
  SerialNode,
  SimulatorInput,
} from './types';
import { fnv1a, stableHash } from './util';

export const nodeIds = {
  doc: (id: string) => `doc:${id}`,
  blob: (hash: string) => `blob:${hash}`,
  parser: (version: number) => `parser:v${version}`,
  tokens: (docId: string) => `tokens:${docId}`,
  reference: (id: string) => `ref:${id}`,
  resolved: (id: string) => `resolved:${id}`,
  fingerprint: (docId: string) => `fp:${docId}`,
  catalog: () => 'view:catalog',
  inverted: () => 'view:inverted',
  forward: () => 'view:forward',
  linkgraph: () => 'view:linkgraph',
  custom: (id: string) => `custom:${id}`,
};

export function contentHash(content: string): string {
  return fnv1a(content);
}

function flavorsForCustomParent(parentType: NodeType): EdgeFlavor[] {
  switch (parentType) {
    case 'doc':
      return ['path', 'exists'];
    case 'reference':
    case 'resolved':
      return ['graph', 'exists'];
    case 'parser':
      return ['parser-version'];
    default:
      return ['content'];
  }
}

/** 仅依据当前快照构建图（不含墓碑），节点值全部为 null。 */
export function buildGraph(input: SimulatorInput): Graph {
  const nodes: Record<string, SerialNode> = {};
  const edges: Edge[] = [];

  const put = (node: GNode) => {
    nodes[node.id] = { ...node, value: null };
  };
  const edge = (from: string, to: string, flavors: EdgeFlavor[], label?: string) => {
    edges.push({ from, to, flavors, label });
  };

  // 全局派生视图
  put({ id: nodeIds.catalog(), type: 'catalog', label: '路径目录（路径敏感）' });
  put({ id: nodeIds.inverted(), type: 'inverted', label: '倒排索引（内容派生）' });
  put({ id: nodeIds.forward(), type: 'forward', label: '正向索引（路径+内容）' });
  put({ id: nodeIds.linkgraph(), type: 'linkgraph', label: '引用图（跨文档引用）' });

  const docIds = Object.keys(input.docs).sort();
  const pathToDoc = new Map<string, string>();
  for (const id of docIds) {
    const doc = input.docs[id];
    pathToDoc.set(doc.path, id);
  }

  for (const id of docIds) {
    const doc = input.docs[id];
    const blobId = nodeIds.blob(contentHash(doc.content));
    const parserId = nodeIds.parser(doc.parserVersion);
    const tokensId = nodeIds.tokens(id);
    const fpId = nodeIds.fingerprint(id);
    const docId2 = nodeIds.doc(id);

    put({
      id: docId2,
      type: 'doc',
      label: doc.path,
      docId: id,
      parserVersion: doc.parserVersion,
      contentHash: contentHash(doc.content),
    });
    if (!nodes[blobId]) {
      put({ id: blobId, type: 'blob', label: `内容块 ${blobId.slice(5, 11)}` });
    }
    if (!nodes[parserId]) {
      put({ id: parserId, type: 'parser', label: `解析器 v${doc.parserVersion}`, parserVersion: doc.parserVersion });
    }
    put({
      id: tokensId,
      type: 'tokens',
      label: `token 流（${doc.parserVersion} 号解析规则）`,
      docId: id,
      parserVersion: doc.parserVersion,
    });
    put({ id: fpId, type: 'fingerprint', label: '内容指纹', docId: id });

    edge(docId2, blobId, ['content']);
    edge(docId2, tokensId, ['content', 'parser-version']);
    edge(parserId, tokensId, ['parser-version']);
    edge(tokensId, nodeIds.inverted(), ['content']);
    edge(tokensId, nodeIds.forward(), ['content']);
    edge(blobId, fpId, ['content']);
    edge(docId2, fpId, ['exists']);
    edge(docId2, nodeIds.catalog(), ['path', 'exists']);
    edge(docId2, nodeIds.forward(), ['path', 'exists']);
  }

  // 跨文档引用
  for (const refId of Object.keys(input.refs).sort()) {
    const ref = input.refs[refId];
    const refNodeId = nodeIds.reference(refId);
    const resolvedId = nodeIds.resolved(refId);
    put({
      id: refNodeId,
      type: 'reference',
      label: `引用 ${refId}`,
      refId,
      sourceDocId: ref.sourceDocId,
      targetPath: ref.targetPath,
    });
    put({
      id: resolvedId,
      type: 'resolved',
      label: `引用解析 ${refId}`,
      refId,
      docId: ref.sourceDocId,
    });
    edge(refNodeId, resolvedId, ['graph', 'exists']);
    edge(nodeIds.doc(ref.sourceDocId), resolvedId, ['exists']);
    edge(resolvedId, nodeIds.linkgraph(), ['graph', 'exists']);

    const targetDocId = pathToDoc.get(ref.targetPath);
    if (targetDocId !== undefined) {
      // 解析结果依赖目标路径：目标改名时该解析失效
      edge(nodeIds.doc(targetDocId), resolvedId, ['path', 'exists']);
    }
  }

  // 自定义派生视图（可以引用任意节点，允许成环）。先建节点、再连边，避免前向引用丢失。
  const pendingCustomEdges: { from: string; to: string }[] = [];
  for (const customId of Object.keys(input.customs).sort()) {
    const custom = input.customs[customId];
    const customNodeId = nodeIds.custom(customId);
    const ruleHash = stableHash([
      'custom-rule',
      custom.rule,
      custom.init,
      [...custom.parents].sort().join('>'),
    ]);
    put({ id: customNodeId, type: 'custom', label: custom.label, customId, ruleHash });
    for (const parentId of custom.parents) pendingCustomEdges.push({ from: parentId, to: customNodeId });
  }
  for (const pending of pendingCustomEdges) {
    const parentType = nodes[pending.from]?.type;
    if (parentType) edge(pending.from, pending.to, flavorsForCustomParent(parentType));
  }

  return { nodes, edges: dedupeEdges(edges) };
}

function dedupeEdges(edges: Edge[]): Edge[] {
  const seen = new Map<string, Edge>();
  for (const edgeItem of edges) {
    const key = `${edgeItem.from}->${edgeItem.to}`;
    const existing = seen.get(key);
    if (existing) {
      existing.flavors = uniqueFlavors([...existing.flavors, ...edgeItem.flavors]);
    } else {
      seen.set(key, { ...edgeItem, flavors: [...edgeItem.flavors] });
    }
  }
  return [...seen.values()].sort((a, b) =>
    a.from === b.from ? a.to.localeCompare(b.to) : a.from.localeCompare(b.from),
  );
}

function uniqueFlavors(flavors: EdgeFlavor[]): EdgeFlavor[] {
  const order: EdgeFlavor[] = ['content', 'path', 'exists', 'parser-version', 'graph'];
  return order.filter((f) => flavors.includes(f));
}

const TOMBSTONE_TYPES = new Set<NodeType>([
  'doc',
  'tokens',
  'reference',
  'resolved',
  'fingerprint',
  'forward',
  'custom',
]);

/**
 * 合并父图：新图中不再出现的节点保留为墓碑（内容块/解析器是不可变的内容寻址节点），
 * 旧边在两个端点都存在时保留，保证删除的变化仍能沿旧依赖传播。
 */
export function mergeTombstones(fresh: Graph, parent: Graph | null): Graph {
  if (!parent) return fresh;
  const nodes: Record<string, SerialNode> = { ...fresh.nodes };
  for (const [id, oldNode] of Object.entries(parent.nodes)) {
    if (nodes[id]) {
      // 保留父节点上的已计算值，供“可复用”判断与重算前展示
      nodes[id] = { ...nodes[id], value: oldNode.value ?? nodes[id].value };
      continue;
    }
    const immortal = oldNode.type === 'blob' || oldNode.type === 'parser';
    nodes[id] = {
      ...oldNode,
      value: oldNode.value,
      tombstone: immortal ? oldNode.tombstone : true,
    };
  }

  const edgeKeys = new Set(fresh.edges.map((e) => `${e.from}->${e.to}`));
  const edges = [...fresh.edges];
  for (const oldEdge of parent.edges) {
    if (nodes[oldEdge.from] && nodes[oldEdge.to] && !edgeKeys.has(`${oldEdge.from}->${oldEdge.to}`)) {
      edges.push({ ...oldEdge, flavors: [...oldEdge.flavors] });
      edgeKeys.add(`${oldEdge.from}->${oldEdge.to}`);
    }
  }

  // 墓碑补边：被删除的 doc/tokens/reference/custom 与其旧下游之间补一条 exists 边，
  // 保证“删除”这一存在性变化能够传播到每一个旧派生项（旧引用不会被静默忽略）。
  for (const [id, node] of Object.entries(nodes)) {
    if (!node.tombstone) continue;
    if (node.type !== 'doc' && node.type !== 'tokens' && node.type !== 'reference' && node.type !== 'custom') {
      continue;
    }
    for (const oldEdge of parent.edges.filter((e) => e.from === id)) {
      const target = nodes[oldEdge.to];
      if (!target || target.id === id) continue;
      if (edgeKeys.has(`${id}->${target.id}`)) continue;
      edges.push({ from: id, to: target.id, flavors: ['exists'] });
      edgeKeys.add(`${id}->${target.id}`);
    }
    // 被删文档的解析：补 doc -> resolved:exists，使旧引用显式变墓碑
    if (node.type === 'doc') {
      for (const resolvedNode of Object.values(nodes)) {
        if (resolvedNode.type !== 'resolved' || resolvedNode.tombstone) continue;
        const pointsToThis =
          resolvedNode.docId === node.docId ||
          parent.edges.some((e) => e.from === id && e.to === resolvedNode.id);
        if (pointsToThis && !edgeKeys.has(`${id}->${resolvedNode.id}`)) {
          edges.push({ from: id, to: resolvedNode.id, flavors: ['exists'] });
          edgeKeys.add(`${id}->${resolvedNode.id}`);
        }
      }
    }
  }
  return { nodes, edges: dedupeEdges(edges) };
}

/** 节点的结构指纹：用于检测哪些节点自身发生了变化（变化源）。 */
export function nodeSignature(node: SerialNode): string {
  switch (node.type) {
    case 'doc':
      return stableHash([
        'doc',
        node.docId,
        node.label,
        node.parserVersion,
        node.contentHash,
        node.tombstone ? 1 : 0,
      ]);
    case 'tokens':
      return stableHash(['tokens', node.docId, node.parserVersion, node.tombstone ? 1 : 0]);
    case 'reference':
      return stableHash([
        'reference',
        node.refId,
        node.sourceDocId,
        node.targetPath,
        node.tombstone ? 1 : 0,
      ]);
    case 'custom':
      return stableHash(['custom', node.customId, node.label, node.ruleHash, node.tombstone ? 1 : 0]);
    case 'resolved':
      return stableHash(['resolved', node.refId, node.tombstone ? 1 : 0]);
    default:
      return stableHash([node.type, node.id, node.tombstone ? 1 : 0]);
  }
}

/** 自定义规则不看签名细节（规则/父节点/初值变化由 custom 节点签名覆盖）。 */
export function customRuleSignatureKey(): string {
  return 'custom-rule';
}
