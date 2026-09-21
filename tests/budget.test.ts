import { describe, expect, it } from 'vitest';
import { IncrementalIndexEngine } from '../src/engine/engine.js';
import { MemoryKVStore } from '../src/engine/store.js';
import type { Changeset } from '../src/engine/types.js';

describe('预算耗尽：保存中间状态与诊断，不宣称成功', () => {
  it('迭代预算用完时保存中间状态与诊断，不发布 head', async () => {
    const engine = new IncrementalIndexEngine(new MemoryKVStore());
    const seed: Changeset = {
      docChanges: [
        { id: 'a', type: 'upsert', path: '/a.md', content: 'apple', parserVersion: 1 },
        { id: 'b', type: 'upsert', path: '/b.md', content: 'banana', parserVersion: 1 },
        { id: 'c', type: 'upsert', path: '/c.md', content: 'cherry', parserVersion: 1 }
      ],
      refChanges: [
        { id: 'ab', type: 'add', fromDoc: 'a', toDoc: 'b' },
        { id: 'bc', type: 'add', fromDoc: 'b', toDoc: 'c' },
        { id: 'ca', type: 'add', fromDoc: 'c', toDoc: 'a' }
      ]
    };
    const { revision } = engine.submit(seed, 'tight budget');
    const result = await engine.runRevision(revision.id, {
      maxIterations: 1,
      convergenceEpsilon: 0
    });

    expect(result.status).toBe('budget-exhausted');
    expect(result.committedAt).toBeUndefined();
    expect(engine.headId()).toBe('rev-0');

    const diagnostics = result.budgetDiagnostics!;
    expect(diagnostics.iterationsUsed).toBe(1);
    expect(diagnostics.maxIterations).toBe(1);
    expect(diagnostics.maxResidual).toBeGreaterThan(0);
    expect(Object.keys(diagnostics.intermediateRanks).sort()).toEqual(['a', 'b', 'c']);
    expect(result.intermediateValues?.__ranks).toBeDefined();

    const persisted = engine.getRevision(revision.id);
    expect(persisted.budgetDiagnostics?.savedAt).toBeGreaterThan(0);

    const resumed = await engine.runRevision(revision.id, {
      maxIterations: 50,
      convergenceEpsilon: 1e-9
    });
    expect(resumed.status).toBe('committed');
    expect(engine.headId()).toBe(revision.id);
  });
});
