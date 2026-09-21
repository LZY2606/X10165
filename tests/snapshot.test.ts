import { describe, expect, it } from 'vitest';
import { makeFixture } from './helpers';

describe('快照隔离', () => {
  it('计算期间到达新 revision：旧计划基于原快照完成并标记过时', () => {
    const f = makeFixture();
    const r1 = f.engine.commit({
      upsertDocs: { A: { path: 'a.txt', content: 'one' } },
      upsertTokens: { T1: { doc: 'A' } },
    });
    // 计划在执行前，新 revision 到达
    const r2 = f.engine.commit({
      upsertDocs: { B: { path: 'b.txt', content: 'two' } },
      upsertTokens: { T2: { doc: 'B' } },
    });

    const p1 = f.executor.run(r1.plan.id);
    expect(p1.status).toBe('completed');
    expect(p1.stale).toBe(true);
    // 旧计划的结果只包含旧快照的节点，不混入新节点
    expect(Object.keys(p1.results).sort()).toEqual(['A', 'T1']);
    expect(p1.results.T1.value).toEqual(['one']);
    // 旧计划的结果只应用到签名未变的节点（A、T1），新 revision 引入的 B 仍未计算
    expect(f.store.data.live.B.value).toEqual([]);
    expect(f.store.data.live.A.value).toEqual(['one']);
    expect(f.store.data.live.T1.value).toEqual(['one']);

    const p2 = f.executor.run(r2.plan.id);
    expect(p2.stale).toBe(false);
    expect(f.store.data.live.T1.value).toEqual(['one']);
    expect(f.store.data.live.T2.value).toEqual(['two']);
  });

  it('过时的删除计划不会回收墓碑，由最新一致性重算负责', () => {
    const f = makeFixture();
    f.engine.commit({ upsertDocs: { A: { path: 'a.txt', content: 'x' } } });
    const r2 = f.engine.commit({ deleteDocs: ['A'] });
    const r3 = f.engine.commit({ upsertDocs: { C: { path: 'c.txt', content: 'y' } } });

    f.executor.run(r2.plan.id); // 过时：不应回收墓碑
    expect(f.store.data.live.A?.tombstone).toBe(true);

    f.executor.run(r3.plan.id); // 最新一致性重算：回收
    expect(f.store.data.live.A).toBeUndefined();
  });
});
