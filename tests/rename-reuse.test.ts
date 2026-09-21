import { describe, expect, it } from 'vitest';
import { setupThreeDocs } from './helpers.js';

describe('改名复用：内容派生复用、路径敏感失效', () => {
  it('路径改名时 token 复用而 posting/backlinks/rank 失效重算', async () => {
    const { engine } = await setupThreeDocs();
    const headBefore = engine.head();

    const { revision } = engine.submit(
      {
        docChanges: [{ id: 'd1', type: 'rename', path: '/a/introduction.md' }],
        refChanges: []
      },
      'd1 改名'
    );

    const plan = revision.plan;
    const tokenEntry = plan.affected.find((a) => a.key === 'token:d1/alpha');
    const postingEntry = plan.affected.find((a) => a.key === 'posting:d1/alpha');
    const backlinksEntry = plan.affected.find((a) => a.key === 'backlinks:d1');
    const rankEntry = plan.affected.find((a) => a.key === 'rank:d1');

    expect(tokenEntry).toBeUndefined();
    expect(plan.reusableKeys).toContain('token:d1/alpha');
    expect(plan.reusableKeys).toContain('token:d1/beta');
    expect(plan.reusableKeys).toContain('index:all');
    expect(plan.reusableKeys.some((k) => k.startsWith('posting:d1/'))).toBe(false);
    expect(postingEntry?.status).toBe('recompute');
    expect(backlinksEntry?.status).toBe('recompute');
    expect(rankEntry?.status).toBe('recompute');

    await engine.runRevision(revision.id);
    const done = engine.getRevision(revision.id);
    expect(done.status).toBe('committed');

    const tokensBefore = headBefore.committedValues!['token:d1/alpha'];
    const tokensAfter = done.committedValues!['token:d1/alpha'];
    expect(tokensAfter).toEqual(tokensBefore);

    const postingAfter = done.committedValues!['posting:d1/alpha'] as {
      path: string;
    };
    expect(postingAfter.path).toBe('/a/introduction.md');

    const indexBefore = headBefore.committedValues!['index:all'];
    const indexAfter = done.committedValues!['index:all'];
    expect(indexAfter).toEqual(indexBefore);
  });
});
