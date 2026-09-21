import { describe, expect, it } from 'vitest';
import { IncrementalIndexEngine } from '../src/engine/engine.js';
import { MemoryKVStore } from '../src/engine/store.js';
import type { Changeset } from '../src/engine/types.js';

describe('环形固定点：稳定顺序迭代', () => {
  it('引用成环时 rank SCC 按稳定顺序迭代直到收敛', async () => {
    const engine = new IncrementalIndexEngine(new MemoryKVStore());
    const seed: Changeset = {
      docChanges: [
        { id: 'a', type: 'upsert', path: '/a.md', content: 'apple', parserVersion: 1 },
        { id: 'b', type: 'upsert', path: '/b.md', content: 'banana', parserVersion: 1 },
        { id: 'c', type: 'upsert', path: '/c.md', content: 'cherry', parserVersion: 1 }
      ],
      refChanges: [
        { id: 'ab', type: 'add', fromDoc: 'a', toDoc: 'b' },
        { id: 'ac', type: 'add', fromDoc: 'a', toDoc: 'c' }
      ]
    };
    const first = engine.submit(seed, 'seed dag');
    await engine.runRevision(first.revision.id);

    const second = engine.submit(
      {
        docChanges: [],
        refChanges: [
          { id: 'ba', type: 'add', fromDoc: 'b', toDoc: 'a' },
          { id: 'cb', type: 'add', fromDoc: 'c', toDoc: 'b' }
        ]
      },
      'close cycle'
    ).revision;
    const done = await engine.runRevision(second.id);

    expect(done.plan.cycles.length).toBeGreaterThan(0);
    const cycle = done.plan.cycles[0].map((k) => k.replace('rank:', '')).sort();
    expect(cycle).toEqual(['a', 'b', 'c']);

    const ranks = Object.fromEntries(done.summary!.ranks.map((r) => [r.docId, r.rank]));
    const total = ranks.a + ranks.b + ranks.c;
    expect(total).toBeCloseTo(1, 6);
    expect(ranks.a).not.toBeCloseTo(ranks.b, 5);

    const iterations = engine
      .events()
      .filter((e) => e.revisionId === second.id && e.type === 'group-iteration');
    expect(iterations.length).toBeGreaterThan(1);
    const last = iterations[iterations.length - 1].payload as {
      converged: boolean;
      maxResidual: number;
      cyclicGroups: number[];
    };
    expect(last.converged).toBe(true);
    expect(last.cyclicGroups).toEqual([...last.cyclicGroups].sort());
  });
});
