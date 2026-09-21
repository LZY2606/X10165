import { describe, it } from 'vitest';
import { Simulator } from '../domain/simulator';

describe('dbg', () => {
  it('fp', async () => {
    const sim = new Simulator();
    sim.submit({ message: 'init', upsertDocs: [{ id: 'a', path: '/a', content: 'abc def', parserVersion: 1 }] });
    await sim.run();
    sim.submit({
      message: '环',
      upsertCustoms: [
        { id: 'x', label: 'X', rule: 'converge', parents: ['custom:y'], init: 100 },
        { id: 'y', label: 'Y', rule: 'converge', parents: ['custom:x'], init: 0 },
      ],
    });
    for (let i = 0; i < 10; i++) {
      const s = sim.step();
      console.log('step', i, s?.revision.id, s?.state);
      if (!s || s.state !== 'continue') break;
    }
    const exec = sim.getExecution('r2')!;
    console.log(exec.events.map((e) => [e.type, e.iteration, e.detail?.values as never]));
  });
});
