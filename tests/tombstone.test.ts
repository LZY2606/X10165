import { describe, expect, it } from 'vitest';
import { setupThreeDocs } from './helpers.js';

describe('删除墓碑：一致性重算前旧引用不静默消失', () => {
  it('删除文档保留墓碑与悬空引用，重算后显式呈现', async () => {
    const { engine } = await setupThreeDocs();

    const { revision } = engine.submit(
      {
        docChanges: [{ id: 'd1', type: 'delete' }],
        refChanges: []
      },
      '删除 d1'
    );

    expect(revision.postSnapshot.docs.d1.deleted).toBe(true);
    const ref = revision.postSnapshot.refs.r1;
    expect(ref.deleted).toBe(false);
    expect(ref.toDoc).toBe('d1');

    const plan = revision.plan;
    expect(plan.affected.some((a) => a.key === 'backlinks:d1' && a.status === 'delete')).toBe(true);
    expect(plan.affected.some((a) => a.key.startsWith('posting:d1/') && a.status === 'delete')).toBe(true);
    expect(plan.affected.some((a) => a.key === 'rank:d1' && a.status === 'delete')).toBe(true);

    await engine.runRevision(revision.id);
    const done = engine.getRevision(revision.id);
    const summary = done.summary!;
    expect(summary.liveDocCount).toBe(2);
    expect(summary.tombstoneCount).toBe(1);
    expect(summary.danglingRefCount).toBe(1);

    const backlinksD2 = done.committedValues!['backlinks:d2'] as {
      links: { refId: string }[];
    };
    expect(backlinksD2.links.map((l) => l.refId)).toContain('r2');

    expect(Object.keys(done.committedValues ?? {})).not.toContain('backlinks:d1');
  });
});
