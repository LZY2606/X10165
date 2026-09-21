export function stronglyConnectedComponents(
  nodes: string[],
  edges: Map<string, string[]>,
): string[][] {
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const result: string[][] = [];
  let counter = 0;

  function visit(v: string): void {
    index.set(v, counter);
    lowlink.set(v, counter);
    counter += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of (edges.get(v) ?? []).slice().sort()) {
      if (!index.has(w)) {
        visit(w);
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, index.get(w)!));
      }
    }
    if (lowlink.get(v) === index.get(v)) {
      const scc: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);
      result.push(scc.sort());
    }
  }

  for (const v of nodes.slice().sort()) {
    if (!index.has(v)) visit(v);
  }
  return result;
}

export function orderAffected(
  nodes: string[],
  depsOf: (id: string) => string[],
): { order: string[]; groups: string[][] } {
  const nodeSet = new Set(nodes);
  const edges = new Map<string, string[]>();
  for (const id of nodes) {
    edges.set(
      id,
      depsOf(id).filter((d) => nodeSet.has(d)),
    );
  }
  const sccs = stronglyConnectedComponents(nodes, edges);
  const sccOf = new Map<string, number>();
  sccs.forEach((scc, i) => scc.forEach((n) => sccOf.set(n, i)));

  const cyclic = new Set<number>();
  sccs.forEach((scc, i) => {
    if (scc.length > 1) cyclic.add(i);
    else if ((edges.get(scc[0]) ?? []).includes(scc[0])) cyclic.add(i);
  });

  const indegree = new Map<number, number>();
  const condEdges = new Map<number, Set<number>>();
  sccs.forEach((_, i) => {
    indegree.set(i, 0);
    condEdges.set(i, new Set());
  });
  sccs.forEach((scc, i) => {
    for (const n of scc) {
      for (const dep of edges.get(n) ?? []) {
        const j = sccOf.get(dep)!;
        if (j !== i && !condEdges.get(j)!.has(i)) {
          condEdges.get(j)!.add(i);
          indegree.set(i, indegree.get(i)! + 1);
        }
      }
    }
  });

  const ready: number[] = [];
  indegree.forEach((deg, i) => {
    if (deg === 0) ready.push(i);
  });
  ready.sort((a, b) => sccs[a][0].localeCompare(sccs[b][0]));

  const order: string[] = [];
  const groups: string[][] = [];
  const emit = (i: number): void => {
    if (cyclic.has(i)) {
      groups.push(sccs[i]);
      order.push(...sccs[i]);
    } else {
      order.push(sccs[i][0]);
    }
  };
  while (ready.length > 0) {
    const i = ready.shift()!;
    emit(i);
    const newly: number[] = [];
    for (const j of condEdges.get(i) ?? []) {
      indegree.set(j, indegree.get(j)! - 1);
      if (indegree.get(j) === 0) newly.push(j);
    }
    newly.sort((a, b) => sccs[a][0].localeCompare(sccs[b][0]));
    ready.push(...newly);
    ready.sort((a, b) => sccs[a][0].localeCompare(sccs[b][0]));
  }
  for (let i = 0; i < sccs.length; i++) {
    if (!order.includes(sccs[i][0])) emit(i);
  }
  return { order, groups };
}
