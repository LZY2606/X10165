import { describe, expect, it } from 'vitest';
import { affectedIds, commitAndRun, makeFixture, reusableIds } from './helpers';

describe('解析器版本升级', () => {
  it('只影响声明依赖解析器版本的节点', () => {
    const f = makeFixture();
    commitAndRun(f, {
      upsertDocs: { A: { path: 'a.txt', content: 'foo-bar baz' } },
      upsertTokens: { T: { doc: 'A' } },
      upsertViews: {
        VP: { deps: ['A'], usesParser: true },
        VC: { deps: ['A'], usesParser: false },
      },
    });

    const vcValueBefore = f.store.data.live.VC.value;
    const { revision, plan } = f.engine.commit({ parserVersion: 2 });
    const affected = affectedIds(f, revision.id);

    // tokens 节点与声明 usesParser 的视图失效
    expect(affected).toContain('T');
    expect(affected).toContain('VP');
    // 未声明 parser 依赖的视图复用
    expect(affected).not.toContain('VC');
    expect(reusableIds(f, revision.id)).toContain('VC');

    f.executor.run(plan.id);
    // v2 解析器按字母数字切分：foo-bar -> foo, bar
    expect(f.store.data.live.T.value).toEqual(['bar', 'baz', 'foo']);
    // 复用节点保持旧值
    expect(f.store.data.live.VC.value).toEqual(vcValueBefore);
  });

  it('依赖 tokens 节点的视图随 tokens 失效而失效', () => {
    const f = makeFixture();
    commitAndRun(f, {
      upsertDocs: { A: { path: 'a.txt', content: 'x-y' } },
      upsertTokens: { T: { doc: 'A' } },
      upsertViews: { V: { deps: ['T'], usesParser: false } },
    });
    const { revision } = f.engine.commit({ parserVersion: 2 });
    // V 的签名依赖 T 的签名，T 变了所以 V 也失效（传递依赖）
    expect(affectedIds(f, revision.id)).toContain('V');
  });
});
