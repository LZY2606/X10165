import { describe, it, expect } from 'vitest';
import { Simulator, SimulatedCrash } from '../domain/simulator';

function boot(): Simulator {
  const sim = new Simulator();
  sim.submit({
    message: '初始',
    upsertDocs: [
      { id: 'a', path: '/a.md', content: 'hello world hello', parserVersion: 1 },
      { id: 'b', path: '/b.md', content: 'world news', parserVersion: 1 },
    ],
    upsertRefs: [{ id: 'r1', sourceDocId: 'a', targetPath: '/b.md' }],
  });
  return sim;
}

describe('smoke3', () => {
  it('delete a -> tombstone', async () => {
    const sim = boot();
    await sim.runAll();
    sim.submit({ message: '删除 a', deleteDocIds: ['a'] });
    await sim.runAll();
    const rev = sim.getRevision('r2')!;
    const plan = rev.plan!;
    console.log('seeds', plan.seeds.map((s) => [s.nodeId, s.reasons]));
    console.log('affected', plan.affectedIds);
    console.log('doc:a tombstone', rev.graph.nodes['doc:a'].tombstone);
    console.log('tokens:a tombstone', rev.graph.nodes['tokens:a'].tombstone);
    console.log('resolved:r1', rev.graph.nodes['resolved:r1'].value);
    console.log('linkgraph', rev.graph.nodes['view:linkgraph'].value);
    const exec = sim.getExecution('r2')!;
    console.log('brokenRefs', exec.brokenRefs);
    expect(rev.graph.nodes['doc:a'].tombstone).toBe(true);
    expect(plan.affectedIds).toContain('resolved:r1');
    expect(plan.affectedIds).toContain('view:linkgraph');
  });

  it('fixedpoint converge cycle', async () => {
    const sim = boot();
    await sim.runAll();
    sim.submit({
      message: '加收敛环',
      upsertCustoms: [
        { id: 'x', label: 'X', rule: 'converge', parents: ['custom:y'], init: 100 },
        { id: 'y', label: 'Y', rule: 'converge', parents: ['custom:x'], init: 0 },
      ],
    });
    await sim.runAll();
    const rev = sim.getRevision('r2')!;
    const plan = rev.plan!;
    console.log('cycles', plan.cycles);
    console.log('groups', plan.orderGroups);
    const exec = sim.getExecution('r2')!;
    console.log('iters', exec.events.filter((e) => e.type.startsWith('fixedpoint')).map((e) => [e.type, e.iteration]));
    console.log('x', rev.graph.nodes['custom:x'].value);
    expect(rev.status).toBe('complete');
    expect(plan.cycles.length).toBe(1);
  });
});

describe('debug2', () => {
  it('fp events', async () => {
    const sim = boot();
    await sim.runAll();
    sim.submit({
      message: '环',
      upsertCustoms: [
        { id: 'x', label: 'X', rule: 'converge', parents: ['custom:y'], init: 100 },
        { id: 'y', label: 'Y', rule: 'converge', parents: ['custom:x'], init: 0 },
      ],
    });
    await sim.runAll();
    const exec = sim.getExecution('r2')!;
    console.log(exec.events.map((e) => [e.type, e.message, e.iteration, e.detail?.values as never]));
    console.log('status', exec.status, 'phase', exec.phase, 'completed', exec.completedSteps, exec.totalSteps);
  });
});

describe('debug3', () => {
  it('step events', async () => {
    const sim = boot();
    await sim.runAll();
    console.log('after runAll r1 exec events:', sim.getExecution('r1')!.events.length);
    const r2 = sim.submit({
      message: '环',
      upsertCustoms: [
        { id: 'x', label: 'X', rule: 'converge', parents: ['custom:y'], init: 100 },
        { id: 'y', label: 'Y', rule: 'converge', parents: ['custom:x'], init: 0 },
      ],
    });
    console.log('after submit r2 events:', sim.getExecution('r2')!.events.map((e) => e.type), 'phase', sim.getExecution('r2')!.phase);
    const s1 = sim.step();
    console.log('step1', s1?.state, sim.getExecution('r2')!.events.map((e) => e.type));
  });
});
