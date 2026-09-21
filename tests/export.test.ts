import { describe, expect, it } from 'vitest';
import { MemoryStore, Store } from '../src/core/storage';
import { commitAndRun, makeFixture } from './helpers';

describe('导出导入一致性', () => {
  it('导出导入后计划顺序与索引摘要一致', () => {
    const f = makeFixture();
    commitAndRun(f, {
      upsertDocs: {
        A: { path: 'a.txt', content: 'one two', refs: ['B'] },
        B: { path: 'b.txt', content: 'three' },
      },
      upsertTokens: { T: { doc: 'A' } },
      upsertViews: { V: { deps: ['T', 'B'] } },
    });
    commitAndRun(f, { upsertDocs: { B: { path: 'b.txt', content: 'three four' } } });
    commitAndRun(f, { deleteDocs: ['B'] });

    const exported = f.store.export();

    const kv2 = new MemoryStore();
    const store2 = new Store(kv2);
    store2.import(exported);

    // 再导出应与原导出逐字节一致（确定性序列化）
    expect(store2.export()).toBe(exported);

    // 计划阶段顺序一致
    const plans1 = f.store.data.plans.map((p) => p.phases.map((ph) => ph.nodes));
    const plans2 = store2.data.plans.map((p) => p.phases.map((ph) => ph.nodes));
    expect(plans2).toEqual(plans1);

    // 每个 revision 的摘要一致
    const summaries = (s: Store) =>
      s.data.revisions.map((r) => r.summary?.summaryHash);
    expect(summaries(store2)).toEqual(summaries(f.store));
    expect(summaries(store2).every((h) => typeof h === 'string')).toBe(true);
  });
});
