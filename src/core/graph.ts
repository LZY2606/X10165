import type { NodeId, NodeSpec } from './types';

/** Ids this node directly depends on (value flows dep -> node). */
export function depsOf(spec: NodeSpec): NodeId[] {
  switch (spec.kind) {
    case 'document':
      return [...spec.refs];
    case 'tokens':
      return [spec.doc];
    case 'view':
      return [...spec.deps];
  }
}

/**
 * Tarjan SCC + deterministic topological ordering of the condensation DAG.
 * Returns SCCs (each internally sorted) ordered so that dependencies come
 * before the components that depend on them.
 */
export function computeSCCs(
  nodes: NodeId[],
  deps: (id: NodeId) => NodeId[],
): NodeId[][] {
  const index = new Map<NodeId, number>();
  const low = new Map<NodeId, number>();
  const onStack = new Set<NodeId>();
  const stack: NodeId[] = [];
  const sccs: NodeId[][] = [];
  let counter = 0;

  function strongconnect(v: NodeId): void {
    index.set(v, counter);
    low.set(v, counter);
    counter += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of deps(v)) {
      if (!index.has(w)) {
        strongconnect(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, index.get(w)!));
      }
    }
    if (low.get(v) === index.get(v)) {
      const scc: NodeId[] = [];
      let w: NodeId;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);
      sccs.push(scc.sort());
    }
  }

  for (const n of [...nodes].sort()) {
    if (!index.has(n)) strongconnect(n);
  }

  // Kahn topo sort on the condensation DAG (dependencies first), with
  // deterministic tie-break by smallest member id.
  const compOf = new Map<NodeId, number>();
  sccs.forEach((scc, i) => scc.forEach((n) => compOf.set(n, i)));
  const compDeps: Set<number>[] = sccs.map(() => new Set());
  const dependents: Set<number>[] = sccs.map(() => new Set());
  sccs.forEach((scc, i) => {
    for (const n of scc) {
      for (const d of deps(n)) {
        const j = compOf.get(d);
        if (j !== undefined && j !== i) {
          compDeps[i].add(j);
          dependents[j].add(i);
        }
      }
    }
  });
  const inDegree = compDeps.map((s) => s.size);
  const ready = sccs
    .map((_, i) => i)
    .filter((i) => inDegree[i] === 0)
    .sort((a, b) => sccs[a][0].localeCompare(sccs[b][0]));
  const ordered: NodeId[][] = [];
  while (ready.length > 0) {
    const i = ready.shift()!;
    ordered.push(sccs[i]);
    for (const k of dependents[i]) {
      inDegree[k] -= 1;
      if (inDegree[k] === 0) {
        let pos = ready.findIndex((x) => sccs[x][0].localeCompare(sccs[k][0]) > 0);
        if (pos === -1) pos = ready.length;
        ready.splice(pos, 0, k);
      }
    }
  }
  return ordered;
}

/** True when the SCC forms a cycle (size > 1 or a self-loop). */
export function isCyclic(scc: NodeId[], deps: (id: NodeId) => NodeId[]): boolean {
  if (scc.length > 1) return true;
  return deps(scc[0]).includes(scc[0]);
}
