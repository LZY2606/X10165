import { describe, expect, it } from 'vitest';
import { affectedIds, commitAndRun, makeFixture, reusableIds } from './helpers';

function baseChangeset() {
  return {
    upsertDocs: { A: { path: 'docs/a.txt', content: 'hello world' } },
    upsertTokens: { T: { doc: 'A' } },
    upsertViews: {
      VC: { deps: ['T'], sensitivity: 'content' as const },
      VP: { deps: ['A'], sensitivity: 'path' as const },
    },
  };
}

describe('改名复用与路径敏感节点', () => {
  it('内容相同的改名：内容派生复用，路径敏感派生失效', () => {
    const f = makeFixture();
    commitAndRun(f, baseChangeset());

    const { revision } = f.engine.commit({
      upsertDocs: { A: { path: 'docs/renamed.txt', content: 'hello world' } },
    });

    const affected = affectedIds(f, revision.id);
    const reusable = reusableIds(f, revision.id);

    // 文档本身与路径敏感视图失效
    expect(affected).toContain('A');
    expect(affected).toContain('VP');
    // 内容派生（tokens、内容视图）复用
    expect(affected).not.toContain('T');
    expect(affected).not.toContain('VC');
    expect(reusable).toContain('T');
    expect(reusable).toContain('VC');
  });

  it('每个受影响项都带有从变化源出发的依赖路径', () => {
    const f = makeFixture();
    commitAndRun(f, baseChangeset());
    const { revision } = f.engine.commit({
      upsertDocs: { A: { path: 'x.txt', content: 'hello world' } },
    });
    const vp = revision.report.affected.find((a) => a.id === 'VP')!;
    expect(vp.path[0]).toBe('A');
    expect(vp.path[vp.path.length - 1]).toBe('VP');
  });

  it('改名后路径敏感视图重算、内容视图保持原值', () => {
    const f = makeFixture();
    commitAndRun(f, baseChangeset());
    const vcBefore = f.store.data.live.VC.value;
    const { plan } = f.engine.commit({
      upsertDocs: { A: { path: 'y.txt', content: 'hello world' } },
    });
    f.executor.run(plan.id);
    expect(f.store.data.live.VC.value).toEqual(vcBefore);
    expect(f.store.data.live.A.value).toEqual(['hello', 'world']);
  });

  it('内容变化会同时失效内容派生与路径派生', () => {
    const f = makeFixture();
    commitAndRun(f, baseChangeset());
    const { revision } = f.engine.commit({
      upsertDocs: { A: { path: 'docs/a.txt', content: 'hello brave world' } },
    });
    const affected = affectedIds(f, revision.id);
    for (const id of ['A', 'T', 'VC', 'VP']) expect(affected).toContain(id);
  });
});
