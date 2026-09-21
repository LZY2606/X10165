import { describe, expect, it } from 'vitest';
import { makeFixture } from './helpers';

const cyclicChangeset = {
  upsertDocs: { D: { path: 'd.txt', content: 'seed' } },
  upsertViews: {
    X: { deps: ['D', 'Z'] },
    Y: { deps: ['X'] },
    Z: { deps: ['Y'] },
  },
};

describe('环形固定点', () => {
  it('环被识别为固定点组并按稳定顺序迭代收敛', () => {
    const f = makeFixture();
    const { revision, plan } = f.engine.commit(cyclicChangeset);
    const cyclicPhase = plan.phases.find((p) => p.cyclic);
    expect(cyclicPhase).toBeDefined();
    expect(cyclicPhase!.nodes).toEqual(['X', 'Y', 'Z']);

    const done = f.executor.run(plan.id);
    expect(done.status).toBe('completed');
    // 三个成员收敛到相同的最小不动点：种子 token + 三个标记
    const expected = ['@X', '@Y', '@Z', 'seed'];
    for (const id of ['X', 'Y', 'Z']) {
      expect(done.results[id].value).toEqual(expected);
    }
    // 事件日志记录了固定点迭代
    const iters = f.store.data.events.filter((e) => e.type === 'fixed-point-iteration');
    expect(iters.length).toBeGreaterThan(1);
    expect(revision.report.affected.map((a) => a.id)).toEqual(
      expect.arrayContaining(['X', 'Y', 'Z']),
    );
  });

  it('预算耗尽：保存中间状态与诊断，不宣称成功；提高预算可恢复', () => {
    const f = makeFixture({ fixedPointBudget: 1 });
    const { plan } = f.engine.commit(cyclicChangeset);
    const exhausted = f.executor.run(plan.id);

    expect(exhausted.status).toBe('budget-exhausted');
    expect(exhausted.status).not.toBe('completed');
    expect(exhausted.diagnostics.length).toBeGreaterThan(0);
    expect(exhausted.diagnostics[0]).toContain('未收敛');
    // 中间状态已保存
    expect(Object.keys(exhausted.results).sort()).toEqual(['D', 'X', 'Y', 'Z']);

    // 用更高预算恢复，从保存的状态继续直至收敛
    const resumed = f.executor.run(plan.id, { budgetOverride: 64 });
    expect(resumed.status).toBe('completed');
    expect(resumed.results.X.value).toEqual(['@X', '@Y', '@Z', 'seed']);
  });

  it('文档引用环同样通过固定点收敛', () => {
    const f = makeFixture();
    const { plan } = f.engine.commit({
      upsertDocs: {
        P: { path: 'p.txt', content: 'p1', refs: ['Q'] },
        Q: { path: 'q.txt', content: 'q1', refs: ['P'] },
      },
    });
    const done = f.executor.run(plan.id);
    expect(done.status).toBe('completed');
    expect(done.results.P.value).toEqual(['p1', 'q1']);
    expect(done.results.Q.value).toEqual(['p1', 'q1']);
  });
});
