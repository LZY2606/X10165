// 节点值计算：所有计算都是确定性的纯函数。

import { nodeIds } from './builder';
import { tokenize } from './tokenizer';
import type { Graph, NodeValue, SerialNode, SimulatorInput } from './types';
import { fnv1a } from './util';

export interface ComputeContext {
  snapshot: SimulatorInput;
  graph: Graph;
}

function parentNodes(ctx: ComputeContext, nodeId: string): SerialNode[] {
  const parents: SerialNode[] = [];
  for (const edge of ctx.graph.edges) {
    if (edge.to === nodeId) {
      const parent = ctx.graph.nodes[edge.from];
      if (parent) parents.push(parent);
    }
  }
  return parents.sort((a, b) => (a.id < b.id ? -1 : 1));
}

export function numericValue(value: NodeValue | null | undefined): number {
  if (!value) return 0;
  switch (value.kind) {
    case 'custom':
      return value.number ?? 0;
    case 'doc':
      return value.tombstone ? 0 : value.content.length;
    case 'blob':
      return value.content.length;
    case 'tokens':
      return value.tombstone ? 0 : value.tokens.length;
    case 'fingerprint':
      return value.tombstone ? 0 : Number.parseInt(value.hash.slice(0, 8), 16);
    case 'resolved':
      return value.dangling || value.tombstone ? 0 : 1;
    case 'catalog':
      return value.entries.length;
    case 'inverted':
      return Object.keys(value.entries).length;
    case 'forward':
      return Object.keys(value.entries).length;
    case 'linkgraph':
      return value.entries.length;
    case 'reference':
      return value.tombstone ? 0 : 1;
    case 'parser':
      return value.version;
  }
}

function computeCustom(node: SerialNode, ctx: ComputeContext): NodeValue {
  const spec = ctx.snapshot.customs[node.customId as string];
  const previous = node.value?.kind === 'custom' ? node.value : null;
  if (!spec) {
    return { kind: 'custom', customId: node.customId as string, number: previous?.number ?? null };
  }
  const parents = parentNodes(ctx, node.id);
  const parentNumbers = parents.map((p) => numericValue(p.value));
  let number: number;
  switch (spec.rule) {
    case 'sum':
      number = parentNumbers.reduce((acc, n) => acc + n, 0);
      break;
    case 'converge': {
      // 几何衰减：x_{n+1} = floor(均值 * 0.9)，整数固定点为 0，有限步收敛
      const k = Math.max(1, parentNumbers.length);
      const mean = parentNumbers.reduce((acc, n) => acc + n, 0) / k;
      number = Math.floor(mean * 0.9);
      break;
    }
    case 'toggle': {
      // 二值振荡：x_{n+1} = 1 - x_n，只依赖自身当前值
      const self = previous?.number ?? spec.init;
      number = self === 1 ? 0 : 1;
      break;
    }
  }
  return { kind: 'custom', customId: spec.id, number };
}

/** 单节点一次性计算（非固定点）。custom 使用当前图上的上游值。 */
export function computeNode(node: SerialNode, ctx: ComputeContext): NodeValue {
  const { snapshot, graph } = ctx;
  switch (node.type) {
    case 'doc': {
      const doc = node.docId ? snapshot.docs[node.docId] : undefined;
      const old = node.value?.kind === 'doc' ? node.value : null;
      if (doc) {
        return {
          kind: 'doc',
          docId: doc.id,
          path: doc.path,
          content: doc.content,
          parserVersion: doc.parserVersion,
          tombstone: false,
        };
      }
      return old
        ? { ...old, tombstone: true }
        : {
            kind: 'doc',
            docId: node.docId ?? '',
            path: node.label,
            content: '',
            parserVersion: node.parserVersion ?? 1,
            tombstone: true,
          };
    }
    case 'blob': {
      const old = node.value?.kind === 'blob' ? node.value : null;
      if (old) return old;
      for (const docId of Object.keys(snapshot.docs)) {
        const doc = snapshot.docs[docId];
        if (nodeIds.blob(fnv1a(doc.content)) === node.id) {
          return { kind: 'blob', hash: node.id.slice(5), content: doc.content };
        }
      }
      return { kind: 'blob', hash: node.id.slice(5), content: '' };
    }
    case 'parser':
      return { kind: 'parser', version: node.parserVersion ?? Number(node.id.slice(7)) };
    case 'tokens': {
      const docId = node.docId as string;
      const doc = snapshot.docs[docId];
      if (!doc || node.tombstone) {
        return { kind: 'tokens', docId, version: node.parserVersion ?? 1, tokens: [], tombstone: true };
      }
      return {
        kind: 'tokens',
        docId,
        version: doc.parserVersion,
        tokens: tokenize(doc.content, doc.parserVersion),
        tombstone: false,
      };
    }
    case 'reference': {
      const ref = node.refId ? snapshot.refs[node.refId] : undefined;
      const old = node.value?.kind === 'reference' ? node.value : null;
      if (ref) {
        return {
          kind: 'reference',
          refId: ref.id,
          sourceDocId: ref.sourceDocId,
          targetPath: ref.targetPath,
          tombstone: false,
        };
      }
      return old
        ? { ...old, tombstone: true }
        : {
            kind: 'reference',
            refId: node.refId ?? '',
            sourceDocId: node.sourceDocId ?? '',
            targetPath: node.targetPath ?? '',
            tombstone: true,
          };
    }
    case 'resolved': {
      const refId = node.refId as string;
      const ref = snapshot.refs[refId];
      const old = node.value?.kind === 'resolved' ? node.value : null;
      const sourceDoc = ref ? snapshot.docs[ref.sourceDocId] : undefined;
      if (!ref || node.tombstone || !sourceDoc) {
        return {
          kind: 'resolved',
          refId,
          sourceDocId: ref?.sourceDocId ?? old?.sourceDocId ?? node.docId ?? '',
          targetDocId: null,
          dangling: true,
          tombstone: true,
        };
      }
      const targetDocId =
        Object.values(snapshot.docs).find((d) => d.path === ref.targetPath)?.id ?? null;
      return {
        kind: 'resolved',
        refId,
        sourceDocId: ref.sourceDocId,
        targetDocId,
        dangling: targetDocId === null,
        tombstone: false,
      };
    }
    case 'fingerprint': {
      const docId = node.docId as string;
      const blobParent = parentNodes(ctx, node.id).find((p) => p.type === 'blob');
      const docNode = graph.nodes[nodeIds.doc(docId)];
      const docDead = !!docNode?.tombstone;
      return {
        kind: 'fingerprint',
        docId,
        hash: blobParent?.value?.kind === 'blob' ? blobParent.value.hash : fnv1a(''),
        tombstone: docDead,
      };
    }
    case 'catalog': {
      const entries = Object.values(graph.nodes)
        .filter((n) => n.type === 'doc' && !n.tombstone)
        .map((n) => ({
          docId: n.docId as string,
          path: n.value?.kind === 'doc' ? n.value.path : n.label,
        }))
        .sort((a, b) => (a.path === b.path ? a.docId.localeCompare(b.docId) : a.path.localeCompare(b.path)));
      return { kind: 'catalog', entries };
    }
    case 'inverted': {
      const entries: Record<string, string[]> = {};
      for (const item of Object.values(graph.nodes)) {
        if (item.type !== 'tokens' || item.tombstone) continue;
        if (item.value?.kind !== 'tokens' || item.value.tombstone) continue;
        for (const token of item.value.tokens) {
          (entries[token] ??= []).push(item.docId as string);
        }
      }
      for (const token of Object.keys(entries)) {
        entries[token] = [...new Set(entries[token])].sort();
      }
      return { kind: 'inverted', entries };
    }
    case 'forward': {
      const entries: Record<string, { path: string; tokens: string[] }> = {};
      for (const item of Object.values(graph.nodes)) {
        if (item.type !== 'doc' || item.tombstone) continue;
        if (item.value?.kind !== 'doc' || item.value.tombstone) continue;
        const tokensNode = graph.nodes[nodeIds.tokens(item.docId as string)];
        const tokens =
          tokensNode?.value?.kind === 'tokens' && !tokensNode.value.tombstone
            ? tokensNode.value.tokens
            : [];
        entries[item.docId as string] = { path: item.value.path, tokens };
      }
      return { kind: 'forward', entries };
    }
    case 'linkgraph': {
      const entries = Object.values(graph.nodes)
        .filter((n) => n.type === 'resolved' && !n.tombstone)
        .map((n) => {
          const v = n.value?.kind === 'resolved'
            ? n.value
            : { sourceDocId: n.docId ?? '', targetDocId: null as string | null, dangling: true };
          return {
            refId: n.refId as string,
            sourceDocId: v.sourceDocId,
            targetDocId: v.targetDocId,
            dangling: v.dangling,
          };
        })
        .sort((a, b) => a.refId.localeCompare(b.refId));
      return { kind: 'linkgraph', entries };
    }
    case 'custom':
      return computeCustom(node, ctx);
  }
}

/** 固定点组成员的数值向量（Jacobi 迭代）。 */
export function customVector(graph: Graph, members: string[]): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const id of members) {
    const node = graph.nodes[id];
    out[id] = node?.value?.kind === 'custom' ? node.value.number : null;
  }
  return out;
}

export function vectorsEqual(
  a: Record<string, number | null>,
  b: Record<string, number | null>,
): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}
