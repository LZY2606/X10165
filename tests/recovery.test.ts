import { describe, expect, it } from 'vitest';
import { CrashError, Executor } from '../src/core/executor';
import { Engine } from '../src/core/engine';
import { Store } from '../src/core/storage';
import { commitAndRun, makeFixture } from './helpers';

const chainChangeset = {
  upsertDocs: { A: { path: 'a.txt', content: 'alpha beta' } },
  upsertTokens: { T: { doc: 'A' } },
  upsertViews: {
    V1: { deps: ['T'] },
    V2: { deps: ['V1'] },
  },
};

describe('阶段恢复', () => {
  it('崩溃后从最后一个完整阶段继续，结果与不中断运行一致', () => {
    const f = makeFixture();
    const { revision, plan } = f.engine.commit(chainChangeset);
    expect(plan.phases.length).toBe(4); // A, T, V1, V2 各自一个阶段

    // 模拟崩溃：第 2 个阶段（索引 1）完成后进程死亡
    expect(() => f.executor.run(plan.id, { failAfterPhase: 1 })).toThrow(CrashError);

    const crashed = f.store.data.plans.find((p) => p.id === plan.id)!;
    expect(crashed.status).toBe('running');
    expect(crashed.completedPhases).toBe(2);

    // 用同一存储重建执行器（模拟重启），恢复未完成的计划
    const executor2 = new Executor(f.store);
    const resumed = executor2.recover();
    expect(resumed.map((p) => p.id)).toEqual([plan.id]);

    const finished = f.store.data.plans.find((p) => p.id === plan.id)!;
    expect(finished.status).toBe('completed');
    expect(finished.completedPhases).toBe(4);

    // 与无中断的对照运行结果一致
    const control = makeFixture();
    const c = control.engine.commit(chainChangeset);
    const controlDone = control.executor.run(c.plan.id);
    expect(finished.results).toEqual(controlDone.results);
    expect(
      f.store.data.revisions.find((r) => r.id === revision.id)!.summary,
    ).toEqual(control.store.data.revisions[0].summary);
  });

  it('所有 revision、计划与执行事件均已持久化', () => {
    const f = makeFixture();
    commitAndRun(f, chainChangeset);
    commitAndRun(f, { upsertDocs: { A: { path: 'a.txt', content: 'alpha beta gamma' } } });

    // 重新加载（模拟重启后从持久化状态恢复）
    const store2 = new Store(f.kv);
    expect(store2.data.revisions.length).toBe(2);
    expect(store2.data.plans.length).toBe(2);
    expect(store2.data.events.length).toBeGreaterThan(0);
    expect(store2.data.live.T.value).toEqual(['alpha', 'beta', 'gamma']);
    const engine2 = new Engine(store2);
    expect(engine2.data.currentRevision).toBe(2);
  });
});
