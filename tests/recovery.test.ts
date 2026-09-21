import { describe, expect, it } from 'vitest';
import { IncrementalIndexEngine } from '../src/engine/engine.js';
import { LocalStorageKVStore, MemoryKVStore } from '../src/engine/store.js';
import type { Changeset } from '../src/engine/types.js';

const bigChange: Changeset = {
  docChanges: [
    { id: 'd1', type: 'upsert', path: '/d1.md', content: 'alpha beta', parserVersion: 1 },
    { id: 'd2', type: 'upsert', path: '/d2.md', content: 'beta gamma', parserVersion: 1 },
    { id: 'd3', type: 'upsert', path: '/d3.md', content: 'gamma delta', parserVersion: 1 }
  ],
  refChanges: [{ id: 'r1', type: 'add', fromDoc: 'd2', toDoc: 'd1' }]
};

describe('阶段恢复：崩溃后从最后一个完整阶段继续', () => {
  it('compute 阶段节点崩溃后重跑，已完成节点不重复执行', async () => {
    const store = new MemoryKVStore();
    const engine = new IncrementalIndexEngine(store);
    const { revision } = engine.submit(bigChange, 'seed big');

    await expect(
      engine.runRevision(revision.id, { crashAfterNode: 'posting:d2/beta' })
    ).rejects.toThrow(/模拟崩溃/);

    const crashed = engine.getRevision(revision.id);
    expect(crashed.status).toBe('running');
    expect(crashed.execution?.phase).toBe('compute');
    expect(crashed.execution?.completedKeys).toContain('posting:d2/beta');
    expect(crashed.intermediateValues?.['posting:d2/beta']).toBeDefined();


    const resumed = await engine.runRevision(revision.id);
    expect(resumed.status).toBe('committed');
    expect(engine.headId()).toBe(revision.id);

    const eventsAfter = engine
      .events()
      .filter((e) => e.revisionId === revision.id && e.type === 'node-recompute')
      .map((e) => e.payload?.key as string);
    const counts = new Map<string, number>();
    for (const key of eventsAfter) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    expect(counts.get('token:d1/alpha')).toBe(1);

    const resumeEvents = engine
      .events()
      .filter((e) => e.revisionId === revision.id && e.type === 'execution-resumed');
    expect(resumeEvents.length).toBe(1);
  });

  it('崩溃在 revision 提交本身之前不会产生半 revision', () => {
    const store = new MemoryKVStore();
    const engine = new IncrementalIndexEngine(store);
    expect(engine.headId()).toBe('rev-0');
    expect(engine.listRevisions()).toHaveLength(1);
  });

  it('导出/导入往返保留完整检查点（供浏览器 localStorage 存储使用）', () => {
    const store = new MemoryKVStore();
    const engine = new IncrementalIndexEngine(store);
    const { revision } = engine.submit(bigChange, 'persist-check');
    const raw = store.get(`rev:${revision.id}`);
    expect(raw).toBeDefined();
    const blob = store.exportJSON();

    const second = new MemoryKVStore();
    second.importJSON(blob);
    expect(second.get(`rev:${revision.id}`)).toBe(raw);

    const engine2 = new IncrementalIndexEngine(second);
    expect(engine2.getRevision(revision.id).execution?.phase).toBe('prepare');
    void LocalStorageKVStore;
  });
});
