import type { Snapshot } from './types.js';
import { tokenize } from './graph.js';

export type DerivedValue = unknown;

export function computeToken(snapshot: Snapshot, docId: string, token: string): unknown {
  const doc = snapshot.docs[docId];
  const tokens = doc && !doc.deleted ? tokenize(doc.content, doc.parserVersion) : [];
  const frequency = tokens.filter((t) => t === token).length;
  return {
    type: 'token',
    docId,
    token,
    frequency,
    parser: doc?.parserVersion ?? null,
    contentHash: shortHash(doc?.content ?? '')
  };
}

export function computePosting(snapshot: Snapshot, docId: string, token: string): unknown {
  const doc = snapshot.docs[docId];
  const tokens = doc && !doc.deleted ? tokenize(doc.content, doc.parserVersion) : [];
  const frequency = tokens.filter((t) => t === token).length;
  return {
    type: 'posting',
    docId,
    path: doc?.path ?? null,
    token,
    frequency,
    positions: tokens.reduce<number[]>((acc, t, i) => {
      if (t === token) {
        acc.push(i);
      }
      return acc;
    }, [])
  };
}

export function computeIndex(snapshot: Snapshot): unknown {
  const terms: Record<string, { docId: string }[]> = {};
  for (const doc of Object.values(snapshot.docs)) {
    if (doc.deleted) {
      continue;
    }
    for (const token of new Set(tokenize(doc.content, doc.parserVersion))) {
      (terms[token] ??= []).push({ docId: doc.id });
    }
  }
  for (const list of Object.values(terms)) {
    list.sort((a, b) => a.docId.localeCompare(b.docId));
  }
  return {
    type: 'index',
    termCount: Object.keys(terms).length,
    postingCount: Object.values(terms).reduce((n, list) => n + list.length, 0),
    terms: Object.fromEntries(Object.entries(terms).sort(([a], [b]) => a.localeCompare(b)))
  };
}

export interface RankInputs {
  liveDocIds: string[];
  incoming: Record<string, string[]>;
  outgoingCount: Record<string, number>;
}

export function rankInputs(snapshot: Snapshot): RankInputs {
  const liveDocIds = Object.values(snapshot.docs)
    .filter((d) => !d.deleted)
    .map((d) => d.id)
    .sort();
  const incoming: Record<string, string[]> = {};
  const outgoingCount: Record<string, number> = {};
  for (const id of liveDocIds) {
    incoming[id] = [];
    outgoingCount[id] = 0;
  }
  for (const ref of Object.values(snapshot.refs)) {
    if (ref.deleted) {
      continue;
    }
    const source = snapshot.docs[ref.fromDoc];
    const target = snapshot.docs[ref.toDoc];
    if (!source || source.deleted || !target || target.deleted) {
      continue;
    }
    incoming[ref.toDoc].push(ref.fromDoc);
    outgoingCount[ref.fromDoc] += 1;
  }
  for (const list of Object.values(incoming)) {
    list.sort();
  }
  return { liveDocIds, incoming, outgoingCount };
}

export function initRanks(inputs: RankInputs): Record<string, number> {
  const ranks: Record<string, number> = {};
  const base = inputs.liveDocIds.length > 0 ? 1 / inputs.liveDocIds.length : 0;
  for (const id of inputs.liveDocIds) {
    ranks[id] = base;
  }
  return ranks;
}

const DAMPING = 0.85;

/**
 * One stable-order fixed-point iteration over rank nodes.
 * Values are rounded to 9 decimals so the convergence test is deterministic.
 */
export function rankIteration(inputs: RankInputs, previous: Record<string, number>): Record<string, number> {
  const n = inputs.liveDocIds.length;
  const base = n > 0 ? (1 - DAMPING) / n : 0;
  const next: Record<string, number> = {};
  for (const id of inputs.liveDocIds) {
    let share = 0;
    for (const sourceId of inputs.incoming[id] ?? []) {
      const out = inputs.outgoingCount[sourceId] || 0;
      if (out > 0) {
        share += (previous[sourceId] ?? 0) / out;
      } else {
        share += n > 0 ? (previous[sourceId] ?? 0) / n : 0;
      }
    }
    next[id] = round(base + DAMPING * share);
  }
  return next;
}

export function ranksConverged(a: Record<string, number>, b: Record<string, number>, epsilon: number): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (Math.abs((a[key] ?? 0) - (b[key] ?? 0)) > epsilon) {
      return false;
    }
  }
  return true;
}

export function computeBacklinks(snapshot: Snapshot, docId: string, ranks: Record<string, number>): unknown {
  const links: { refId: string; fromDoc: string; path: string; weight: number }[] = [];
  for (const ref of Object.values(snapshot.refs)) {
    if (ref.deleted || ref.toDoc !== docId) {
      continue;
    }
    const source = snapshot.docs[ref.fromDoc];
    const target = snapshot.docs[docId];
    if (!source || source.deleted || !target || target.deleted) {
      continue;
    }
    links.push({
      refId: ref.id,
      fromDoc: source.id,
      path: source.path,
      weight: ranks[source.id] ?? 0
    });
  }
  links.sort((a, b) =>
    a.refId.localeCompare(b.refId) || a.fromDoc.localeCompare(b.fromDoc)
  );
  return {
    type: 'backlinks',
    docId,
    path: snapshot.docs[docId]?.path ?? null,
    links,
    danglingReferences: Object.values(snapshot.refs)
      .filter((r) => !r.deleted && r.toDoc === docId)
      .filter((r) => {
        const source = snapshot.docs[r.fromDoc];
        return !source || source.deleted;
      })
      .map((r) => r.id)
      .sort()
  };
}

export function rankValue(docId: string, ranks: Record<string, number>): unknown {
  return { type: 'rank', docId, rank: ranks[docId] ?? 0 };
}

function round(value: number): number {
  return Math.round(value * 1e9) / 1e9;
}

export function shortHash(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
