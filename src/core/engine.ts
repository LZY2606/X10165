import { hashParts } from './hash';
import { computeSCCs, depsOf, isCyclic } from './graph';
import type { Store } from './storage';
import {
  PARSER_SOURCE,
  type AffectedItem,
  type Changeset,
  type GraphState,
  type InvalidationReport,
  type NodeId,
  type NodeState,
  type PhaseSpec,
  type Plan,
  type Revision,
} from './types';

export interface EngineOptions {
  /** Fixed-point iteration budget for cyclic groups. */
  fixedPointBudget?: number;
}

interface Channels {
  content: string;
  path: string;
  refs: string;
  sig: string;
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Compute invalidation signatures for every node. Signatures are channel
 * based so that, e.g., a pure rename keeps the content channel stable while
 * changing the path channel. Inside a cycle, intra-cycle dependencies
 * contribute a stable placeholder so signature computation terminates.
 */
export function computeSignatures(state: GraphState): Record<NodeId, string> {
  const nodes = state.nodes;
  const ids = Object.keys(nodes).sort();
  const deps = (id: NodeId): NodeId[] =>
    depsOf(nodes[id].spec).filter((d) => nodes[d] !== undefined);
  const sccs = computeSCCs(ids, deps);
  const compOf = new Map<NodeId, number>();
  sccs.forEach((scc, i) => scc.forEach((n) => compOf.set(n, i)));
  const channels: Record<NodeId, Channels> = {};

  for (const scc of sccs) {
    for (const id of scc) {
      const node = nodes[id];
      const spec = node.spec;
      const depChannel = (dep: NodeId): Channels | null => {
        if (!nodes[dep]) return null;
        if (compOf.get(dep) === compOf.get(id)) {
          const ph = hashParts('cycle', dep);
          return { content: ph, path: '', refs: '', sig: ph };
        }
        return channels[dep] ?? null;
      };
      if (spec.kind === 'document') {
        const content = node.tombstone
          ? hashParts('tombstone', id)
          : hashParts('content', spec.content);
        const path = hashParts('path', spec.path);
        const refParts = [...spec.refs].sort().map((r) => {
          if (!nodes[r]) return hashParts('missing-ref', r);
          if (nodes[r].tombstone) return hashParts('dangling-ref', r);
          const c = depChannel(r);
          return hashParts('ref', r, c ? c.content : 'cycle');
        });
        const refs = hashParts('refs', ...refParts);
        channels[id] = {
          content,
          path,
          refs,
          sig: hashParts('doc', content, path, refs),
        };
      } else if (spec.kind === 'tokens') {
        const doc = nodes[spec.doc];
        const docContent = doc
          ? doc.tombstone
            ? hashParts('tombstone', spec.doc)
            : hashParts('content', doc.spec.kind === 'document' ? doc.spec.content : '')
          : hashParts('missing', spec.doc);
        const sig = hashParts('tokens', docContent, state.parserVersion);
        channels[id] = { content: sig, path: '', refs: '', sig };
      } else {
        const contributions = [...spec.deps].sort().map((d) => {
          if (!nodes[d]) return hashParts('missing', d);
          const c = depChannel(d);
          if (!c) return hashParts('cycle', d);
          const depSpec = nodes[d].spec;
          if (depSpec.kind === 'document') {
            return hashParts(
              'dep-doc',
              c.content,
              c.refs,
              spec.sensitivity === 'path' ? c.path : '',
            );
          }
          return hashParts('dep', c.sig);
        });
        const sig = hashParts(
          'view',
          spec.sensitivity,
          spec.usesParser ? state.parserVersion : '',
          ...contributions,
        );
        channels[id] = { content: sig, path: '', refs: '', sig };
      }
    }
  }
  const out: Record<NodeId, string> = {};
  for (const id of ids) out[id] = channels[id].sig;
  return out;
}

export class Engine {
  readonly fixedPointBudget: number;

  constructor(
    readonly store: Store,
    options: EngineOptions = {},
  ) {
    this.fixedPointBudget = options.fixedPointBudget ?? 64;
  }

  get data() {
    return this.store.data;
  }

  /** Apply a changeset, publish a new revision and an invalidation plan. */
  commit(changeset: Changeset): { revision: Revision; plan: Plan } {
    const data = this.data;
    const oldNodes = data.live;
    const oldSigs = data.signatures;
    const nodes: Record<NodeId, NodeState> = clone(oldNodes);
    const sources: NodeId[] = [];

    for (const [id, d] of Object.entries(changeset.upsertDocs ?? {}).sort()) {
      const prev = nodes[id];
      nodes[id] = {
        id,
        spec: {
          kind: 'document',
          path: d.path,
          content: d.content,
          refs: [...new Set(d.refs ?? [])].sort(),
        },
        tombstone: false,
        value: prev && !prev.tombstone ? prev.value : [],
        valueHash: prev && !prev.tombstone ? prev.valueHash : '',
      };
      sources.push(id);
    }
    for (const id of [...(changeset.deleteDocs ?? [])].sort()) {
      const prev = nodes[id];
      if (!prev || prev.spec.kind !== 'document') continue;
      // Deletion produces a tombstone; inbound references stay visible
      // (dangling) until a consistency recompute completes.
      nodes[id] = {
        ...prev,
        tombstone: true,
        spec: { ...prev.spec, refs: [] },
      };
      sources.push(id);
    }
    for (const [id, t] of Object.entries(changeset.upsertTokens ?? {}).sort()) {
      const prev = nodes[id];
      nodes[id] = {
        id,
        spec: { kind: 'tokens', doc: t.doc },
        tombstone: false,
        value: prev ? prev.value : [],
        valueHash: prev ? prev.valueHash : '',
      };
      sources.push(id);
    }
    for (const [id, v] of Object.entries(changeset.upsertViews ?? {}).sort()) {
      const prev = nodes[id];
      nodes[id] = {
        id,
        spec: {
          kind: 'view',
          deps: [...new Set(v.deps)].sort(),
          sensitivity: v.sensitivity ?? 'content',
          usesParser: v.usesParser ?? false,
        },
        tombstone: false,
        value: prev ? prev.value : [],
        valueHash: prev ? prev.valueHash : '',
      };
      sources.push(id);
    }
    for (const id of [...(changeset.deleteNodes ?? [])].sort()) {
      if (nodes[id] && nodes[id].spec.kind !== 'document') {
        delete nodes[id];
        sources.push(id);
      }
    }
    const parserChanged =
      changeset.parserVersion !== undefined &&
      changeset.parserVersion !== data.parserVersion;
    const parserVersion = changeset.parserVersion ?? data.parserVersion;
    if (parserChanged) sources.push(PARSER_SOURCE);

    const graph: GraphState = { parserVersion, nodes };
    const newSigs = computeSignatures(graph);

    // Dirty = propagation signature changed, or (parser changed and the node
    // inherently depends on the parser). Tombstones are dirty but not computed.
    const dirty = new Set<NodeId>();
    for (const id of Object.keys(nodes)) {
      if (oldSigs[id] !== newSigs[id]) dirty.add(id);
    }
    if (parserChanged) {
      for (const [id, n] of Object.entries(nodes)) {
        if (n.spec.kind === 'document' || n.spec.kind === 'tokens') dirty.add(id);
      }
    }

    // Reverse dependency edges over the union of old and new graphs so that
    // propagation through removed edges is still observed.
    const reverse = new Map<NodeId, Set<NodeId>>();
    const addEdge = (from: NodeId, to: NodeId) => {
      if (!reverse.has(from)) reverse.set(from, new Set());
      reverse.get(from)!.add(to);
    };
    for (const graphNodes of [oldNodes, nodes]) {
      for (const [id, n] of Object.entries(graphNodes)) {
        for (const dep of depsOf(n.spec)) addEdge(dep, id);
      }
    }
    if (parserChanged) {
      for (const id of Object.keys(nodes)) addEdge(PARSER_SOURCE, id);
    }

    // BFS from sources: dependency path to every reached node.
    const pathOf = new Map<NodeId, NodeId[]>();
    const queue: NodeId[] = [];
    for (const s of sources) {
      if (!pathOf.has(s)) {
        pathOf.set(s, [s]);
        queue.push(s);
      }
    }
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const next of [...(reverse.get(cur) ?? [])].sort()) {
        if (!pathOf.has(next)) {
          pathOf.set(next, [...pathOf.get(cur)!, next]);
          queue.push(next);
        }
      }
    }

    const affected: AffectedItem[] = [];
    const reusable: NodeId[] = [];
    for (const [id, path] of [...pathOf.entries()].sort()) {
      if (id === PARSER_SOURCE) continue;
      if (!nodes[id]) continue; // fully removed node
      if (sources.includes(id) && !dirty.has(id)) continue; // unchanged source
      if (dirty.has(id)) {
        affected.push({
          id,
          path,
          reason: nodes[id].tombstone ? 'deleted (tombstone)' : 'signature changed',
        });
      } else if (!sources.includes(id)) {
        reusable.push(id);
      }
    }

    // Recompute order: SCCs of the dirty subgraph in topological order.
    const computeIds = Object.keys(nodes)
      .filter((id) => dirty.has(id) && !nodes[id].tombstone)
      .sort();
    const dirtyDeps = (id: NodeId): NodeId[] =>
      depsOf(nodes[id].spec).filter((d) => computeIds.includes(d));
    const phases: PhaseSpec[] = computeSCCs(computeIds, dirtyDeps).map((scc) => ({
      nodes: scc,
      cyclic: isCyclic(scc, dirtyDeps),
      budget: this.fixedPointBudget,
    }));

    const revisionId = data.currentRevision + 1;
    const planId = `plan-${revisionId}`;
    const report: InvalidationReport = {
      revision: revisionId,
      sources,
      affected,
      reusable,
      phases,
    };
    const plan: Plan = {
      id: planId,
      revision: revisionId,
      baseRevision: data.currentRevision,
      snapshot: clone(graph),
      signatures: { ...newSigs },
      phases: clone(phases),
      status: 'pending',
      stale: false,
      completedPhases: 0,
      results: {},
      diagnostics: [],
    };
    const revision: Revision = {
      id: revisionId,
      parent: data.currentRevision === 0 ? null : data.currentRevision,
      changeset: clone(changeset),
      report,
      planId,
      tombstones: Object.keys(nodes)
        .filter((id) => nodes[id].tombstone)
        .sort(),
    };

    data.live = nodes;
    data.signatures = newSigs;
    data.parserVersion = parserVersion;
    data.currentRevision = revisionId;
    data.revisions.push(revision);
    data.plans.push(plan);
    this.store.save();
    return { revision, plan };
  }

  getPlan(planId: string): Plan | undefined {
    return this.data.plans.find((p) => p.id === planId);
  }

  getRevision(id: number): Revision | undefined {
    return this.data.revisions.find((r) => r.id === id);
  }
}
