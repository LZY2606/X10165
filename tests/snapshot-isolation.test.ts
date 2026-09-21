import { describe, expect, it } from 'vitest';
import type { ExecutionEvent } from '../src/engine/types.js';
import { setupThreeDocs } from './helpers.js';

function gate(): {
  release: () => void;
  wait: () => Promise<void>;
} {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  let opened = false;
  return {
    wait: async () => {
      if (!opened) {
        await promise;
      }
    },
    release: () => {
      opened = true;
      resolve();
    }
  };
}

describe('快照隔离：执行中到达的新 revision 不能混入新旧节点', () => {
  it('旧计划基于原快照完成并标记 stale，节点全部来自 post 快照', async () => {
    const { engine } = await setupThreeDocs();
    const first = engine.submit(
      { docChanges: [{ id: 'd1', type: 'rename', content: 'alpha beta omega' }], refChanges: [] },
      'revA: 修改 d1'
    ).revision;

    const gateControl = gate();
    let submittedSecond = false;
    const run = engine.runRevision(first.id, {
      eventHook: async (event: ExecutionEvent) => {
        if (
          !submittedSecond &&
          event.type === 'node-recompute' &&
          event.revisionId === first.id
        ) {
          submittedSecond = true;
          engine.submit(
            { docChanges: [{ id: 'd4', type: 'upsert', path: '/c/new.md', content: 'new fresh omega' }], refChanges: [] },
            'revB: 执行中新增 d4'
          );
          gateControl.release();
        }
      }
    });

    await gateControl.wait();
    const done = await run;

    expect(done.status).toBe('stale');
    expect(done.supersessionNote).toContain('新 revision');
    expect(done.postSnapshot.docs.d4).toBeUndefined();
    for (const key of Object.keys(done.committedValues ?? {})) {
      expect(key).not.toContain('d4');
    }

    const second = engine.listRevisions().find((r) => r.description === 'revB: 执行中新增 d4')!;
    const done2 = await engine.runRevision(second.id);
    expect(done2.status).toBe('committed');
    expect(engine.headId()).toBe(second.id);
    expect(engine.head().postSnapshot.docs.d4).toBeDefined();
    expect(engine.head().postSnapshot.docs.d1.content).toBe('alpha beta omega');
  });
});
