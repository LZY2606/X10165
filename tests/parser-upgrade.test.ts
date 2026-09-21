import { describe, expect, it } from 'vitest';
import { setupThreeDocs } from './helpers.js';

describe('解析器版本升级只影响声明依赖的节点', () => {
  it('v1→v2 只失效 token→posting→index 链，不影响 backlinks/rank', async () => {
    const { engine } = await setupThreeDocs();

    const { revision } = engine.submit(
      {
        docChanges: [
          { id: 'd1', type: 'rename', content: 'alpha and the beta', parserVersion: 2 }
        ],
        refChanges: []
      },
      'd1 升级解析器'
    );

    const affectedKinds = new Map(
      revision.plan.affected.map((a) => [a.key, a] as const)
    );

    expect(affectedKinds.get('token:d1/the')).toBeUndefined();
    expect(affectedKinds.get('token:d1/and')).toBeUndefined();
    expect(affectedKinds.get('token:d1/alpha')?.status).toBe('recompute');
    expect(affectedKinds.get('token:d1/beta')?.status).toBe('recompute');

    expect(affectedKinds.get('posting:d1/alpha')?.kind).toBe('posting');
    expect(affectedKinds.get('index:all')?.kind).toBe('index');

    for (const key of [
      'backlinks:d1',
      'backlinks:d2',
      'backlinks:d3',
      'rank:d1',
      'rank:d2',
      'rank:d3'
    ]) {
      expect(affectedKinds.has(key), `${key} 不应被解析器升级影响`).toBe(false);
    }

    await engine.runRevision(revision.id);
    const done = engine.getRevision(revision.id);
    expect(Object.keys(done.committedValues ?? {})).not.toContain('token:d1/the');
    expect(Object.keys(done.committedValues ?? {})).toContain('token:d1/alpha');
    const index = done.committedValues!['index:all'] as {
      terms: Record<string, { docId: string }[]>;
    };
    expect(index.terms.the).toBeUndefined();
    expect(index.terms.alpha?.map((x) => x.docId)).toEqual(['d1']);
  });
});
