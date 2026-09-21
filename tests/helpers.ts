import { IncrementalIndexEngine } from '../src/engine/engine.js';
import { MemoryKVStore } from '../src/engine/store.js';
import type { Changeset } from '../src/engine/types.js';

export async function setupThreeDocs(): Promise<{
  engine: IncrementalIndexEngine;
  revId: string;
}> {
  const engine = new IncrementalIndexEngine(new MemoryKVStore());
  const changes: Changeset = {
    description: 'seed 三个文档与引用',
    docChanges: [
      { id: 'd1', type: 'upsert', path: '/a/intro.md', content: 'alpha beta gamma', parserVersion: 1 },
      { id: 'd2', type: 'upsert', path: '/a/usage.md', content: 'beta gamma delta', parserVersion: 1 },
      { id: 'd3', type: 'upsert', path: '/b/notes.md', content: 'gamma delta epsilon', parserVersion: 1 }
    ],
    refChanges: [
      { id: 'r1', type: 'add', fromDoc: 'd2', toDoc: 'd1' },
      { id: 'r2', type: 'add', fromDoc: 'd3', toDoc: 'd2' }
    ]
  };
  const { revision } = engine.submit(changes, 'seed');
  await engine.runRevision(revision.id);
  return { engine, revId: revision.id };
}

export function valueKeys(engine: IncrementalIndexEngine, revId: string): string[] {
  const rev = engine.getRevision(revId);
  return Object.keys(rev.committedValues ?? {}).sort();
}
