import { fnv1a, tokenize, uniqSorted } from './hash';
import { computeSignatures } from './engine';
import type { Store } from './storage';
import type { NodeId, Plan, RevisionSummary } from './types';

export class CrashError extends Error {
  constructor(public readonly afterPhase: number) {
    super(`simulated crash after phase ${afterPhase}`);
    this.name = 'CrashError';
  }
}

export interface RunOptions {
  /** Test hook: throw a CrashError after this phase index completes. */
  failAfterPhase?: number;
  /** New fixed-point budget when resuming a budget-exhausted plan. */
  budgetOverride?: number;
  onEvent?: (type: string, detail: string) => void;
}

function arraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Execute or resume a recompute plan against its frozen snapshot. */
export class Executor {
  constructor(readonly store: Store) {}

  private emit(planId: string, type: string, detail: string, onEvent?: RunOptions['onEvent']) {
    const data = this.store.data;
    data.seq += 1;
    data.events.push({ seq: data.seq, planId, type, detail });
    onEvent?.(type, detail);
  }

  private computeValue(
    plan: Plan,
    id: NodeId,
    values: Record<NodeId, string[]>,
  ): string[] {
    const node = plan.snapshot.nodes[id];
    const spec = node.spec;
    const pv = plan.snapshot.parserVersion;
    if (spec.kind === 'document') {
      if (node.tombstone) return [];
      const own = tokenize(spec.content, pv);
      const fromRefs = spec.refs.flatMap((r) => values[r] ?? []);
      return uniqSorted([...own, ...fromRefs]);
    }
    if (spec.kind === 'tokens') {
      const doc = plan.snapshot.nodes[spec.doc];
      if (!doc || doc.tombstone || doc.spec.kind !== 'document') return [];
      return tokenize(doc.spec.content, pv);
    }
    const fromDeps = spec.deps.flatMap((d) => values[d] ?? []);
    return uniqSorted([`@${id}`, ...fromDeps]);
  }

  run(planId: string, opts: RunOptions = {}): Plan {
    const data = this.store.data;
    const plan = data.plans.find((p) => p.id === planId);
    if (!plan) throw new Error(`unknown plan ${planId}`);
    if (plan.status === 'completed') return plan;

    const resuming = plan.completedPhases > 0 || plan.status === 'budget-exhausted';
    plan.status = 'running';
    plan.diagnostics = [];
    this.emit(plan.id, resuming ? 'plan-resumed' : 'plan-started',
      resuming ? `从阶段 ${plan.completedPhases} 继续` : `基于 revision ${plan.revision} 的快照`);

    // Seed values from the frozen snapshot only — never from live state —
    // so a newer revision cannot leak into this run (snapshot isolation).
    const values: Record<NodeId, string[]> = {};
    for (const [id, n] of Object.entries(plan.snapshot.nodes)) {
      values[id] = n.tombstone ? [] : [...n.value];
    }
    for (const [id, r] of Object.entries(plan.results)) values[id] = [...r.value];

    for (let i = plan.completedPhases; i < plan.phases.length; i++) {
      const phase = plan.phases[i];
      this.emit(plan.id, 'phase-start', `阶段 ${i}: ${phase.nodes.join(', ')}`, opts.onEvent);
      if (phase.cyclic) {
        const budget = opts.budgetOverride ?? phase.budget;
        for (const id of phase.nodes) values[id] = [];
        let iterations = 0;
        let changed = true;
        while (changed && iterations < budget) {
          changed = false;
          iterations += 1;
          // Stable iteration order: sorted member ids.
          for (const id of phase.nodes) {
            const next = this.computeValue(plan, id, values);
            if (!arraysEqual(next, values[id])) {
              values[id] = next;
              changed = true;
            }
          }
          this.emit(plan.id, 'fixed-point-iteration', `阶段 ${i} 第 ${iterations} 轮`, opts.onEvent);
        }
        // Save intermediate state either way.
        for (const id of phase.nodes) {
          plan.results[id] = { value: [...values[id]], valueHash: fnv1a(values[id].join('\n')) };
        }
        if (changed) {
          plan.status = 'budget-exhausted';
          plan.diagnostics.push(
            `阶段 ${i} (${phase.nodes.join(', ')}) 在预算 ${budget} 轮内未收敛；` +
              `已保存中间状态，可用更高预算恢复`,
          );
          this.emit(plan.id, 'budget-exhausted', plan.diagnostics[plan.diagnostics.length - 1], opts.onEvent);
          this.store.save();
          return plan;
        }
        this.emit(plan.id, 'fixed-point-converged', `阶段 ${i} 经 ${iterations} 轮收敛`, opts.onEvent);
      } else {
        const id = phase.nodes[0];
        values[id] = this.computeValue(plan, id, values);
        plan.results[id] = { value: [...values[id]], valueHash: fnv1a(values[id].join('\n')) };
      }
      plan.completedPhases = i + 1;
      this.emit(plan.id, 'phase-end', `阶段 ${i} 完成`, opts.onEvent);
      this.store.save(); // checkpoint after each complete phase
      if (opts.failAfterPhase === i) {
        this.store.save();
        throw new CrashError(i);
      }
    }

    plan.status = 'completed';
    plan.stale = data.currentRevision > plan.revision;

    const revision = data.revisions.find((r) => r.id === plan.revision);
    if (revision) {
      revision.summary = buildSummary(plan);
    }

    // Salvage: apply results for nodes whose live signature still matches the
    // plan snapshot signature. For a fresh plan this is every node; for a
    // stale plan only nodes untouched by newer revisions are applied, so old
    // and new nodes never mix.
    for (const [id, r] of Object.entries(plan.results)) {
      const live = data.live[id];
      if (live && !live.tombstone && data.signatures[id] === plan.signatures[id]) {
        live.value = [...r.value];
        live.valueHash = r.valueHash;
      }
    }
    if (!plan.stale) {
      // Consistency recompute for the latest revision: garbage-collect
      // tombstones and dangling references.
      const removed = new Set<NodeId>();
      for (const [id, n] of Object.entries(data.live)) {
        if (n.tombstone) removed.add(id);
      }
      for (const id of Object.keys(data.live)) {
        const n = data.live[id];
        if (n.spec.kind === 'tokens' && removed.has(n.spec.doc)) removed.add(id);
      }
      for (const id of removed) {
        delete data.live[id];
        delete data.signatures[id];
      }
      for (const n of Object.values(data.live)) {
        if (n.spec.kind === 'document') {
          n.spec.refs = n.spec.refs.filter((r) => !removed.has(r));
        }
      }
      data.signatures = computeSignatures({
        parserVersion: data.parserVersion,
        nodes: data.live,
      });
      this.emit(plan.id, 'tombstones-collected',
        removed.size > 0 ? `清理墓碑: ${[...removed].sort().join(', ')}` : '无墓碑', opts.onEvent);
    } else {
      this.emit(plan.id, 'plan-stale',
        `revision ${plan.revision} 已被 ${data.currentRevision} 超越，结果不应用到当前状态`, opts.onEvent);
    }
    this.emit(plan.id, 'plan-completed', plan.stale ? '完成（已过时）' : '完成', opts.onEvent);
    this.store.save();
    return plan;
  }

  /** Resume every plan left in a non-terminal state (crash recovery). */
  recover(opts: RunOptions = {}): Plan[] {
    const resumed: Plan[] = [];
    for (const plan of this.store.data.plans) {
      if (plan.status === 'running') {
        resumed.push(this.run(plan.id, opts));
      }
    }
    return resumed;
  }
}

function buildSummary(plan: Plan): RevisionSummary {
  const nodes: Record<NodeId, string> = {};
  let tokenCount = 0;
  for (const [id, n] of Object.entries(plan.snapshot.nodes).sort()) {
    if (n.tombstone) continue;
    const hash = plan.results[id]?.valueHash ?? n.valueHash ?? fnv1a('');
    nodes[id] = hash;
    if (n.spec.kind === 'tokens') {
      tokenCount += plan.results[id]?.value.length ?? n.value.length;
    }
  }
  const summaryHash = fnv1a(
    Object.entries(nodes)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, h]) => `${id}:${h}`)
      .join('|'),
  );
  return {
    revision: plan.revision,
    nodeCount: Object.keys(nodes).length,
    tokenCount,
    nodes,
    summaryHash,
  };
}
