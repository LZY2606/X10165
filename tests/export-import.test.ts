import { describe, expect, it } from 'vitest';
import { IncrementalIndexEngine } from '../src/engine/engine.js';
import { MemoryKVStore } from '../src/engine/store.js';
import { setupThreeDocs } from './helpers.js';

describe('导出导入：计划顺序与摘要一致', () => {
  it('导出到新存储后 plans、entries 顺序、summary 与事件完全一致', async () => {
    const { engine } = await setupThreeDocs();
    engine.submit(
      {
        docChanges: [{ id: 'd1', type: 'rename', path: '/a/intro-renamed.md' }],
        refChanges: [{ id: 'r3', type: 'add', fromDoc: 'd1', toDoc: 'd3' }]
      },
      '改名加引用'
    );
    await engine.runRevision('rev-2');

    const exported = engine.exportJSON();

    const restoredStore = new MemoryKVStore();
    restoredStore.importJSON(exported);
    const restored = new IncrementalIndexEngine(restoredStore);

    expect(restored.headId()).toBe(engine.headId());
    for (const original of engine.listRevisions()) {
      const copy = restored.getRevision(original.id);
      expect(copy.plan.entries.map((e) => e.order + ':' + e.key)).toEqual(
        original.plan.entries.map((e) => e.order + ':' + e.key)
      );
      expect(copy.plan.reusableKeys).toEqual(original.plan.reusableKeys);
      expect(copy.plan.deletedKeys).toEqual(original.plan.deletedKeys);
      expect(copy.summary).toEqual(original.summary);
    }
    expect(restored.events()).toEqual(engine.events());

    const diff = restored.compareSummaries('rev-1', 'rev-2');
    expect(diff.counters.find((c) => c.field === 'referenceCount')?.delta).toBe(1);
    expect(diff.changedRanks.length).toBeGreaterThan(0);

    const reExported = restored.exportJSON();
    expect(reExported).toBe(exported);
  });
});
