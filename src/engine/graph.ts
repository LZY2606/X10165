import type {
  DerivedNodeId,
  Facet,
  GraphEdge,
  GraphNode,
  Snapshot
} from './types.js';

export function nodeKey(id: DerivedNodeId): string {
  switch (id.kind) {
    case 'token':
      return `token:${id.docId}/${id.token}`;
    case 'posting':
      return `posting:${id.docId}/${id.token}`;
    case 'index':
      return 'index:all';
    case 'backlinks':
      return `backlinks:${id.docId}`;
    case 'rank':
      return `rank:${id.docId}`;
  }
}

export function parseKey(key: string): { kind: string; local: string } {
  const idx = key.indexOf(':');
  return { kind: key.slice(0, idx), local: key.slice(idx + 1) };
}

const KIND_FACETS: Record<GraphNode['kind'], Facet[]> = {
  token: ['content', 'parser', 'existence'],
  posting: ['content', 'path', 'existence'],
  index: ['content', 'existence'],
  backlinks: ['path', 'reference', 'existence'],
  rank: ['path', 'reference', 'existence']
};

export function presentingFacets(kind: GraphNode['kind']): Facet[] {
  return KIND_FACETS[kind];
}

export function emptySnapshot(): Snapshot {
  return { docs: {}, refs: {} };
}

/**
 * Build the derived dependency graph from a snapshot.
 *
 * Edges carry facet labels: a downstream node is only invalidated when an
 * upstream change touches one of the edge's carrier facets.
 */
export function buildGraph(snapshot: Snapshot): {
  nodes: Map<string, GraphNode>;
  edges: GraphEdge[];
} {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];

  const ensure = (
    id: DerivedNodeId,
    kind: GraphNode['kind'],
    pathSensitive: boolean
  ): GraphNode => {
    const key = nodeKey(id);
    let node = nodes.get(key);
    if (!node) {
      node = { id, key, kind, pathSensitive, incoming: [], outgoing: [] };
      nodes.set(key, node);
    }
    return node;
  };

  const addEdge = (from: GraphNode, to: GraphNode, facets: Facet[], via: string) => {
    const edge: GraphEdge = { from: from.key, to: to.key, facets, via };
    from.outgoing.push(edge);
    to.incoming.push(edge);
    edges.push(edge);
  };

  const liveDocs = Object.values(snapshot.docs).filter((d) => !d.deleted);
  const liveRefs = Object.values(snapshot.refs).filter((r) => !r.deleted);

  for (const doc of liveDocs) {
    const tokens = tokenize(doc.content, doc.parserVersion);
    for (const token of tokens) {
      const tokenNode = ensure(
        { kind: 'token', docId: doc.id, token },
        'token',
        false
      );
      const postingNode = ensure(
        { kind: 'posting', docId: doc.id, token },
        'posting',
        true
      );
      addEdge(tokenNode, postingNode, ['content', 'path', 'existence'], 'token→posting');
    }
  }

  const indexNode = ensure({ kind: 'index' }, 'index', false);
  for (const node of nodes.values()) {
    if (node.kind === 'posting') {
      addEdge(node, indexNode, ['content', 'existence'], 'posting→index');
    }
  }

  for (const doc of liveDocs) {
    const backNode = ensure(
      { kind: 'backlinks', docId: doc.id },
      'backlinks',
      true
    );
    const rankNode = ensure({ kind: 'rank', docId: doc.id }, 'rank', true);
    addEdge(rankNode, backNode, ['reference', 'existence'], 'rank→backlinks');
  }

  for (const ref of liveRefs) {
    const source = snapshot.docs[ref.fromDoc];
    const target = snapshot.docs[ref.toDoc];
    if (!source || source.deleted || !target || target.deleted) {
      continue;
    }
    const targetBack = ensure(
      { kind: 'backlinks', docId: ref.toDoc },
      'backlinks',
      true
    );
    const sourceRank = ensure(
      { kind: 'rank', docId: ref.fromDoc },
      'rank',
      true
    );
    addEdge(sourceRank, targetBack, ['reference', 'path', 'existence'], 'ref→backlinks');

    const targetRank = ensure(
      { kind: 'rank', docId: ref.toDoc },
      'rank',
      true
    );
    addEdge(sourceRank, targetRank, ['reference', 'path', 'existence'], 'ref→rank');
  }

  return { nodes, edges };
}

export function tokenize(content: string, parserVersion: 1 | 2): string[] {
  const words = Array.from(
    content
      .toLowerCase()
      .matchAll(/[\p{L}\p{N}]+/gu),
    (m) => m[0]
  );
  if (parserVersion === 1) {
    return words;
  }
  const stopWords = new Set([
    'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'is', 'it',
    'for', 'on', 'with', 'as', 'at', 'by', 'this', 'that'
  ]);
  return words.filter((w) => !stopWords.has(w));
}

export function tokenSet(snapshot: Snapshot, docId: string): string[] {
  const doc = snapshot.docs[docId];
  if (!doc || doc.deleted) {
    return [];
  }
  return tokenize(doc.content, doc.parserVersion);
}
