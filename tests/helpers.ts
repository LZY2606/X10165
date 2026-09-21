import { Engine } from '../src/core/engine';
import { Executor } from '../src/core/executor';
import { MemoryStore, Store } from '../src/core/storage';
import type { Changeset } from '../src/core/types';

export interface Fixture {
  kv: MemoryStore;
  store: Store;
  engine: Engine;
  executor: Executor;
}

export function makeFixture(opts: { fixedPointBudget?: number } = {}): Fixture {
  const kv = new MemoryStore();
  const store = new Store(kv);
  const engine = new Engine(store, opts);
  const executor = new Executor(store);
  return { kv, store, engine, executor };
}

/** Commit a changeset and run the resulting plan to completion. */
export function commitAndRun(f: Fixture, cs: Changeset) {
  const { revision, plan } = f.engine.commit(cs);
  const done = f.executor.run(plan.id);
  return { revision, plan: done };
}

export function affectedIds(f: Fixture, revision: number): string[] {
  const rev = f.store.data.revisions.find((r) => r.id === revision)!;
  return rev.report.affected.map((a) => a.id).sort();
}

export function reusableIds(f: Fixture, revision: number): string[] {
  const rev = f.store.data.revisions.find((r) => r.id === revision)!;
  return [...rev.report.reusable].sort();
}
