import { describe, expect, it } from 'vitest';
import { commitAndRun, makeFixture } from './helpers';

describe('删除墓碑', () => {
  it('删除产生墓碑，旧引用在一致性重算完成前不消失', () => {
    const f = makeFixture();
    commitAndRun(f, {
      upsertDocs: {
        A: { path: 'a.txt', content: 'alpha', refs: ['B'] },
        B: { path: 'b.txt', content: 'beta' },
      },
    });

    const { revision } = f.engine.commit({ deleteDocs: ['B'] });

    // 墓碑存在，A -> B 的引用仍然可见（悬挂）
    expect(f.store.data.live.B.tombstone).toBe(true);
    const specA = f.store.data.live.A.spec;
    expect(specA.kind === 'document' && specA.refs).toContain('B');
    expect(revision.tombstones).toContain('B');

    // 删除传播：A 的引用签名变化导致 A 失效
    const affected = revision.report.affected.map((a) => a.id);
    expect(affected).toContain('A');
    expect(affected).toContain('B');

    // 一致性重算完成后，墓碑与悬挂引用被回收
    f.executor.run(revision.planId);
    expect(f.store.data.live.B).toBeUndefined();
    const specAfter = f.store.data.live.A.spec;
    expect(specAfter.kind === 'document' && specAfter.refs).toEqual([]);
  });

  it('删除文档使其 tokens 提取器失效并在回收时一并清理', () => {
    const f = makeFixture();
    commitAndRun(f, {
      upsertDocs: { A: { path: 'a.txt', content: 'alpha' } },
      upsertTokens: { T: { doc: 'A' } },
    });
    const { revision } = f.engine.commit({ deleteDocs: ['A'] });
    expect(revision.report.affected.map((a) => a.id)).toContain('T');
    f.executor.run(revision.planId);
    expect(f.store.data.live.A).toBeUndefined();
    expect(f.store.data.live.T).toBeUndefined();
  });
});
