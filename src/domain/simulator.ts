// 模拟器：revision 发布、分阶段执行（plan -> recompute -> verify -> publish）、
// 崩溃恢复（从最后一个完整阶段继续）、陈旧标记、快照隔离、摘要与导入导出。

import { buildGraph, mergeTombstones } from './builder';
import { computeNode, customVector, vectorsEqual } from './compute';
import { buildPlan } from './planner';
import type { KVStore } from './store';
import { MemoryStore } from './store';
import type {
  ChangeSet,
  Execution,
  ExecutionEvent,
  FixedpointDiagnostics,
  Graph,
  IndexSummary,
  Phase,
  Plan,
  Revision,
  SerialNode,
  SimulatorInput,
  StoreDump,
  SummaryDiff,
} from './types';

export const DEFAULT_FIXEDPOINT_BUDGET = 50;

const K_HEAD = 'meta.head';
const K_SEQ = 'meta.seq';
const K_CURRENT = 'meta.currentInput';
const K_REV_PREFIX = 'revision.';
const K_EXEC_PREFIX = 'execution.';
const PHASES: Phase[] = ['plan', 'recompute', 'verify', 'publish'];

export interface SubmitOptions {
  fixedpointBudget?: number;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function emptyInput(): SimulatorInput {
  return { docs: {}, refs: {}, customs: {} };
}

export function applyChanges(input: SimulatorInput, change: ChangeSet): SimulatorInput {
  const next: SimulatorInput = {
    docs: { ...input.docs },
    refs: { ...input.refs },
    customs: { ...input.customs },
  };
  for (const doc of change.upsertDocs ?? []) next.docs[doc.id] = { ...doc };
  for (const id of change.deleteDocIds ?? []) delete next.docs[id];
  for (const ref of change.upsertRefs ?? []) next.refs[ref.id] = { ...ref };
  for (const id of change.deleteRefIds ?? []) delete next.refs[id];
  for (const custom of change.upsertCustoms ?? []) next.customs[custom.id] = { ...custom };
  for (const id of change.deleteCustomIds ?? []) delete next.customs[id];
  return next;
}

export class Simulator {
  private store: KVStore;
  private fixedpointBudget: number;
  /** 测试用：在该步骤序号执行后抛出崩溃（写盘之后） */
  crashAfterStep: number | null = null;

  constructor(store?: KVStore, fixedpointBudget = DEFAULT_FIXEDPOINT_BUDGET) {
    this.store = store ?? new MemoryStore();
    this.fixedpointBudget = fixedpointBudget;
    this.recover();
  }

  // ---- 持久化辅助 ----

  private getJSON<T>(key: string, fallback: T): T {
    const raw = this.store.get(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  }

  private putJSON(key: string, value: unknown): void {
    this.store.set(key, JSON.stringify(value));
  }

  private saveRevision(rev: Revision): void {
    this.putJSON(K_REV_PREFIX + rev.id, rev);
  }

  private saveExecution(exec: Execution): void {
    this.putJSON(K_EXEC_PREFIX + exec.revisionId, exec);
  }

  getRevision(id: string): Revision | null {
    return this.getJSON<Revision | null>(K_REV_PREFIX + id, null);
  }

  getExecution(id: string): Execution | null {
    return this.getJSON<Execution | null>(K_EXEC_PREFIX + id, null);
  }

  listRevisions(): Revision[] {
    return this.store
      .keys()
      .filter((k) => k.startsWith(K_REV_PREFIX))
      .map((k) => this.getJSON<Revision>(k, null as unknown as Revision))
      .filter(Boolean)
      .sort((a, b) => a.sequence - b.sequence);
  }

  getHeadId(): string | null {
    return this.getJSON<string | null>(K_HEAD, null);
  }

  getHead(): Revision | null {
    const id = this.getHeadId();
    return id ? this.getRevision(id) : null;
  }

  getCurrentInput(): SimulatorInput {
    const head = this.getHead();
    return head ? clone(head.snapshot) : emptyInput();
  }

  /** 下一个待执行 revision（状态 queued 或崩溃后 running）。 */
  nextPending(): Revision | null {
    return this.listRevisions().find((r) => r.status === 'queued' || r.status === 'running') ?? null;
  }

  // ---- 崩溃恢复 ----

  private recover(): void {
    const pending = this.listRevisions().filter((r) => r.status === 'running');
    for (const rev of pending) {
      const exec = this.getExecution(rev.id);
      if (!exec) continue;
      const resumedPhase = exec.phase;
      rev.status = 'queued';
      this.saveRevision(rev);
      exec.events.push({
        seq: exec.events.length + 1,
        at: Date.now(),
        phase: resumedPhase,
        type: 'resumed',
        message: `检测到未完成执行，从最后一个完整阶段（${phaseLabel(resumedPhase)}）继续`,
      });
      exec.status = 'queued';
      exec.updatedAt = Date.now();
      this.saveExecution(exec);
    }
  }

  // ---- 事件 ----

  private appendEvent(
    revisionId: string,
    partial: Omit<ExecutionEvent, 'seq' | 'at' | 'phase'> & { phase?: Phase },
  ): { event: ExecutionEvent; exec: Execution } {
    const exec = this.mustExecution(revisionId);
    const event: ExecutionEvent = {
      seq: exec.events.length + 1,
      at: Date.now(),
      phase: partial.phase ?? exec.phase,
      type: partial.type,
      nodeId: partial.nodeId,
      groupIndex: partial.groupIndex,
      iteration: partial.iteration,
      message: partial.message,
      detail: partial.detail,
    };
    exec.events.push(event);
    exec.updatedAt = Date.now();
    this.saveExecution(exec);
    return { event, exec };
  }

  private mustExecution(revisionId: string): Execution {
    const exec = this.getExecution(revisionId);
    if (!exec) throw new Error('执行记录不存在');
    return exec;
  }

  // ---- 提交 revision ----

  submit(change: ChangeSet, options: SubmitOptions = {}): Revision {
    const budget = options.fixedpointBudget ?? this.fixedpointBudget;
    const parent = this.getHead();
    // 注意：即便前一个 revision 还在运行，当前输入也只代表“已提交规格”，
    // 后续排队的 revision 依次以前一个提交快照为父，保证新计划不混入旧执行结果。
    const baseInput: SimulatorInput = parent ? clone(parent.snapshot) : emptyInput();
    const snapshot = applyChanges(baseInput, change);

    const sequence = this.getJSON<number>(K_SEQ, 0) + 1;
    this.putJSON(K_SEQ, sequence);
    const id = `r${sequence}`;

    const parentGraph: Graph | null = parent ? clone(parent.graph) : null;
    const fresh = buildGraph(snapshot);
    const graph = mergeTombstones(fresh, parentGraph);

    const rev: Revision = {
      id,
      sequence,
      parentId: parent?.id ?? null,
      createdAt: Date.now(),
      message: change.message || `revision ${sequence}`,
      change: clone(change),
      snapshot,
      graph,
      status: 'queued',
      plan: null,
      completedAt: null,
      summary: null,
    };

    // plan 阶段在提交时立即完成并持久化（即使随后崩溃，计划也不丢失）
    const exec = this.newExecution(id, budget);
    this.saveExecution(exec);
    const plan = buildPlan({
      revisionId: id,
      parentRevisionId: parent?.id ?? null,
      graph,
      parentGraph,
    });
    rev.plan = plan;
    this.saveRevision(rev);
    this.finalizePlanPhase(rev, exec, plan);
    return this.getRevision(id) as Revision;
  }

  private newExecution(revisionId: string, budget: number): Execution {
    return {
      revisionId,
      status: 'queued',
      phase: 'plan',
      budget,
      reuseDone: false,
      totalSteps: 0,
      completedGroups: 0,
      completedSteps: 0,
      checkpoints: {},
      events: [
        {
          seq: 1,
          at: Date.now(),
          phase: 'plan',
          type: 'revision-submitted',
          message: '变更集已作为新 revision 提交',
        },
      ],
      diagnostics: [],
      brokenRefs: [],
      updatedAt: Date.now(),
    };
  }

  private finalizePlanPhase(rev: Revision, exec: Execution, plan: Plan): void {
    for (const seed of plan.seeds) {
      this.appendEvent(rev.id, {
        type: 'seed-detected',
        phase: 'plan',
        nodeId: seed.nodeId,
        message: seed.detail,
        detail: { reasons: seed.reasons },
      });
    }
    this.appendEvent(rev.id, {
      type: 'phase-done',
      phase: 'plan',
      message: `计划完成：${plan.seeds.length} 个变化源，${plan.affectedIds.length} 个受影响节点，${plan.reusableIds.length} 个可复用节点，${plan.orderGroups.length} 个执行组，${plan.cycles.length} 个环`,
      detail: {
        affected: plan.affectedIds,
        reusable: plan.reusableIds,
        cycleCount: plan.cycles.length,
      },
    });
    exec.phase = 'recompute';
    exec.status = 'queued';
    exec.totalSteps = 2 + plan.orderGroups.length;
    this.saveExecution(exec);
  }

  // ---- 重算阶段 ----

  private stepRecompute(rev: Revision, exec: Execution, plan: Plan): 'done' | 'continue' | 'failed' {
    const ctx = { snapshot: rev.snapshot, graph: rev.graph };
    const completedGroups = exec.completedGroups ?? Math.max(0, exec.completedSteps - 1);

    if (!exec.reuseDone) {
      // 第 0 步：可复用项直接继承父快照的值（这也是一个可崩溃边界）
      for (const id of plan.reusableIds) {
        const node = rev.graph.nodes[id];
        const parentNode = this.parentGraph(rev)?.nodes[id];
        if (node && parentNode?.value) node.value = clone(parentNode.value);
        ({ exec } = this.appendEvent(rev.id, {
          type: 'node-reused',
          phase: 'recompute',
          nodeId: id,
          message: `${node?.label ?? id} 未失效，直接复用父 revision 的结果`,
        }));
      }
      exec.reuseDone = true;
      this.saveRevision(rev);
      this.saveExecution(exec);
      exec.completedSteps = 1;
      this.saveExecution(exec);
      this.maybeCrash(exec);
      return 'continue';
    }

    // 恢复后：把崩溃前已完成的组静默重放（结果确定性一致）
    for (let gi = 0; gi < completedGroups && gi < plan.orderGroups.length; gi++) {
      for (const nodeId of plan.orderGroups[gi].nodeIds) {
        const node = rev.graph.nodes[nodeId];
        if (node && plan.orderGroups[gi].kind === 'single') node.value = computeNode(node, ctx);
        if (node && plan.orderGroups[gi].kind === 'fixedpoint' && exec.checkpoints[gi]) {
          this.applyVector(rev, [nodeId], exec.checkpoints[gi].values);
        }
      }
    }

    const gi = completedGroups;
    if (gi >= plan.orderGroups.length) {
      ({ exec } = this.appendEvent(rev.id, {
        type: 'phase-done',
        phase: 'recompute',
        message: '全部受影响节点重算完成',
      }));
      exec.phase = 'verify';
      this.saveExecution(exec);
      return 'done';
    }

    const group = plan.orderGroups[gi];
    if (group.kind === 'single') {
      for (const nodeId of group.nodeIds) {
        const node = rev.graph.nodes[nodeId];
        if (!node) continue;
        ({ exec } = this.appendEvent(rev.id, {
          type: 'node-recompute-start',
          phase: 'recompute',
          nodeId,
          groupIndex: gi,
          message: `开始重算 ${node.label}`,
        }));
        node.value = computeNode(node, ctx);
        ({ exec } = this.appendEvent(rev.id, {
          type: 'node-recompute-done',
          phase: 'recompute',
          nodeId,
          groupIndex: gi,
          message: `${node.label} 重算完成`,
        }));
      }
    } else {
      const result = this.runFixedpoint(rev, exec, plan, gi);
      if (result === 'failed') return 'failed';
    }

    exec.completedGroups = gi + 1;
    exec.completedSteps = exec.completedGroups + 1;
    delete exec.checkpoints[gi];
    this.saveRevision(rev);
    this.saveExecution(exec);
    this.maybeCrash(exec);

    if (gi + 1 >= plan.orderGroups.length) {
      ({ exec } = this.appendEvent(rev.id, {
        type: 'phase-done',
        phase: 'recompute',
        message: '全部受影响节点重算完成',
      }));
      exec.phase = 'verify';
      this.saveExecution(exec);
      return 'done';
    }
    return 'continue';
  }

  private parentGraph(rev: Revision): Graph | null {
    return rev.parentId ? (this.getRevision(rev.parentId)?.graph ?? null) : null;
  }

  private runFixedpoint(
    rev: Revision,
    exec: Execution,
    plan: Plan,
    groupIndex: number,
  ): 'converged' | 'failed' {
    const group = plan.orderGroups[groupIndex];
    const members = group.nodeIds;
    const ctx = { snapshot: rev.snapshot, graph: rev.graph };
    const budget = exec.budget;
    const checkpoint = exec.checkpoints[groupIndex];

    if (checkpoint) {
      for (const [id, number] of Object.entries(checkpoint.values)) {
        const node = rev.graph.nodes[id];
        if (node?.value?.kind === 'custom') node.value = { ...node.value, number };
      }
      ({ exec } = this.appendEvent(rev.id, {
        type: 'resumed',
        phase: 'recompute',
        groupIndex,
        message: `固定点组从第 ${checkpoint.iteration} 轮迭代的检查点继续`,
      }));
    }

    let current = customVector(rev.graph, members);
    // 首次迭代前，把尚无值的 custom 节点初始化为规格声明的初值
    if (!checkpoint) {
      for (const id of members) {
        if (current[id] === null || current[id] === undefined) {
          const node = rev.graph.nodes[id];
          const spec = node?.customId ? rev.snapshot.customs[node.customId] : undefined;
          current[id] = spec?.init ?? 0;
        }
      }
      this.applyVector(rev, members, current);
    }
    let startIteration = checkpoint?.iteration ?? 0;
    if (checkpoint) {
      current = { ...checkpoint.values };
    }

    const history: Record<string, number | null>[] = [];
    history.push(clone(current));

    for (let iter = startIteration; iter < budget; iter++) {
      // Jacobi：按稳定顺序，每轮都基于上一轮的快照计算
      const snapshotVector = clone(current);
      const next: Record<string, number | null> = {};
      for (const id of members) {
        const node = rev.graph.nodes[id];
        if (!node) {
          next[id] = snapshotVector[id];
          continue;
        }
        // 用上一轮向量临时覆盖同组 custom 父节点
        const restore: Record<string, SerialNode['value']> = {};
        for (const memberId of members) {
          restore[memberId] = rev.graph.nodes[memberId]?.value ?? null;
          const memberNode = rev.graph.nodes[memberId];
          if (memberNode) {
            memberNode.value = { kind: 'custom', customId: memberNode.customId ?? '', number: snapshotVector[memberId] };
          }
        }
        const value = computeNode(node, ctx);
        next[id] = value.kind === 'custom' ? value.number : null;
        for (const memberId of members) {
          const memberNode = rev.graph.nodes[memberId];
          if (memberNode) memberNode.value = restore[memberId];
        }
      }

      const converged = vectorsEqual(next, snapshotVector);
      current = next;
      history.push(clone(current));
      ({ exec } = this.appendEvent(rev.id, {
        type: 'fixedpoint-iter',
        phase: 'recompute',
        groupIndex,
        iteration: iter + 1,
        message: `固定点组 [${members.join(', ')}] 第 ${iter + 1}/${budget} 轮迭代`,
        detail: { values: clone(current) },
      }));

      if (converged) {
        this.applyVector(rev, members, current);
        ({ exec } = this.appendEvent(rev.id, {
          type: 'fixedpoint-converged',
          phase: 'recompute',
          groupIndex,
          iteration: iter + 1,
          message: `固定点组在第 ${iter + 1} 轮收敛`,
        }));
        return 'converged';
      }

      // 每轮迭代后保存检查点
      exec.checkpoints[groupIndex] = { iteration: iter + 1, values: clone(current) };
      this.applyVector(rev, members, current);
      this.saveRevision(rev);
      this.saveExecution(exec);
      this.maybeCrash(exec);
    }

    // 预算耗尽：保存中间状态与诊断，绝不宣称成功
    const diagnostics: FixedpointDiagnostics = {
      groupIndex,
      members,
      iterations: budget,
      converged: false,
      intermediate: clone(current),
      history,
    };
    exec.diagnostics.push(diagnostics);
    ({ exec } = this.appendEvent(rev.id, {
      type: 'fixedpoint-budget-exhausted',
      phase: 'recompute',
      groupIndex,
      iteration: budget,
      message: `固定点组 [${members.join(', ')}] 在 ${budget} 轮预算内未收敛，已保存中间状态与诊断`,
      detail: { intermediate: clone(current) },
    }));
    this.markFailed(rev, exec, '固定点组达到迭代预算仍未收敛');
    return 'failed';
  }

  private applyVector(rev: Revision, members: string[], vector: Record<string, number | null>): void {
    for (const id of members) {
      const node = rev.graph.nodes[id];
      if (node) node.value = { kind: 'custom', customId: node.customId ?? '', number: vector[id] ?? null };
    }
  }

  private markFailed(rev: Revision, exec: Execution, message: string): void {
    rev.status = 'failed';
    const { exec: latest } = this.appendEvent(rev.id, {
      type: 'info',
      phase: 'recompute',
      message: `执行失败：${message}`,
    });
    latest.status = 'failed';
    latest.phase = 'recompute';
    this.saveExecution(latest);
    this.saveRevision(rev);
  }

  private maybeCrash(exec: Execution): void {
    if (this.crashAfterStep !== null && exec.completedSteps >= this.crashAfterStep) {
      // 模拟进程被杀死：内存中的调用栈丢失，已写盘内容保留
      const budget = this.crashAfterStep;
      this.crashAfterStep = null;
      throw new SimulatedCrash(budget);
    }
  }

  // ---- 执行驱动 ----

  /**
   * 推进一步（重算组 / verify / publish）。若当前没有待执行 revision，返回 null。
   * 执行严格按队列顺序：后来的 revision 等待前面完成；先完成的旧 revision 若已被
   * 后来者超越，会被标记 stale，绝不推进 head，保证不混入新旧节点。
   */
  step(): { revision: Revision; state: 'continue' | 'complete' | 'failed' | 'stale' } | null {
    const pending = this.nextPending();
    if (!pending) return null;
    const rev = this.getRevision(pending.id) as Revision;
    let exec = this.getExecution(rev.id) as Execution;

    if (rev.status === 'queued' && exec.status === 'queued') {
      exec.status = 'running';
      rev.status = 'running';
      exec.events.push({
        seq: exec.events.length + 1,
        at: Date.now(),
        phase: exec.phase,
        type: 'phase-start',
        message: `开始执行（阶段：${phaseLabel(exec.phase)}）`,
      });
      this.saveExecution(exec);
      this.saveRevision(rev);
      exec = this.getExecution(rev.id) as Execution;
    }

    if (exec.phase === 'recompute') {
      const result = this.stepRecompute(rev, exec, rev.plan as Plan);
      if (result === 'failed') return { revision: this.getRevision(rev.id) as Revision, state: 'failed' };
      if (result === 'continue') {
        this.saveRevision(rev);
        return { revision: this.getRevision(rev.id) as Revision, state: 'continue' };
      }
    }

    if (exec.phase === 'verify') {
      this.stepVerify(rev, exec);
    }

    if (exec.phase === 'publish') {
      this.stepPublish(rev, exec);
    }

    const fresh = this.getRevision(rev.id) as Revision;
    if (fresh.status === 'failed') return { revision: fresh, state: 'failed' };
    return { revision: fresh, state: fresh.status === 'stale' ? 'stale' : 'complete' };
  }

  private stepVerify(rev: Revision, _exec: Execution): void {
    let exec = this.mustExecution(rev.id);
    const broken: Execution['brokenRefs'] = [];
    for (const node of Object.values(rev.graph.nodes)) {
      if (node.type === 'resolved' && node.value?.kind === 'resolved') {
        if (node.value.dangling) {
          broken.push({
            refId: node.refId as string,
            sourceDocId: node.value.sourceDocId,
            targetPath: rev.snapshot.refs[node.refId as string]?.targetPath ?? '',
          });
          ({ exec } = this.appendEvent(rev.id, {
            type: 'verify-broken-ref',
            phase: 'verify',
            nodeId: node.id,
            message: `旧引用 ${node.refId} 指向不存在的路径，一致性重算完成前保留为悬空墓碑标记`,
          }));
        }
      }
    }
    exec.brokenRefs = broken;
    if (broken.length === 0) {
      ({ exec } = this.appendEvent(rev.id, {
        type: 'verify-ok',
        phase: 'verify',
        message: '一致性校验通过：所有跨文档引用均可解析',
      }));
    } else {
      ({ exec } = this.appendEvent(rev.id, {
        type: 'verify-ok',
        phase: 'verify',
        message: `一致性校验完成：${broken.length} 条悬空引用已标记（未静默删除）`,
      }));
    }
    ({ exec } = this.appendEvent(rev.id, {
      type: 'phase-done',
      phase: 'verify',
      message: '一致性校验阶段完成',
    }));
    exec.phase = 'publish';
    this.saveExecution(exec);
  }

  private stepPublish(rev: Revision, _exec: Execution): void {
    let exec = this.mustExecution(rev.id);
    // 快照隔离：发布时再检查是否已有更新的 revision 抢先完成
    const laterComplete = this.listRevisions().some(
      (r) => r.sequence > rev.sequence && (r.status === 'complete' || r.status === 'stale'),
    );
    if (laterComplete) {
      rev.status = 'stale';
      ({ exec } = this.appendEvent(rev.id, {
        type: 'marked-stale',
        phase: 'publish',
        message: '执行期间有更新 revision 已完成：本计划基于原始快照完成，标记为已过时，不推进 head',
      }));
      ({ exec } = this.appendEvent(rev.id, {
        type: 'phase-done',
        phase: 'publish',
        message: '发布阶段结束（过时）',
      }));
      exec.status = 'stale';
      rev.completedAt = Date.now();
      rev.summary = buildSummary(rev, exec.brokenRefs.length);
      this.saveExecution(exec);
      this.saveRevision(rev);
      return;
    }

    rev.status = 'complete';
    rev.completedAt = Date.now();
    rev.summary = buildSummary(rev, exec.brokenRefs.length);
    this.putJSON(K_HEAD, rev.id);
    this.putJSON(K_CURRENT, rev.snapshot);
    ({ exec } = this.appendEvent(rev.id, {
      type: 'published',
      phase: 'publish',
      message: `revision ${rev.id} 已发布，head 推进，所有节点值冻结`,
    }));
    ({ exec } = this.appendEvent(rev.id, {
      type: 'phase-done',
      phase: 'publish',
      message: '发布阶段完成',
    }));
    exec.status = 'complete';
    this.saveExecution(exec);
    this.saveRevision(rev);
  }

  /** 运行直到某个 revision 结束（失败/完成）。 */
  async run(options?: { delayMs?: number }): Promise<Revision> {
    let current: Revision | null = null;
    for (;;) {
      const result = this.step();
      if (!result) {
        if (current) return current;
        throw new Error('没有待执行的 revision');
      }
      current = result.revision;
      if (result.state !== 'continue') return current;
      if (options?.delayMs && options.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      }
    }
  }

  /** 排空整个队列，依次执行所有 revision（用于演示与测试）。 */
  async runAll(options?: { delayMs?: number }): Promise<Revision[]> {
    const finished: Revision[] = [];
    for (;;) {
      const rev = await this.run(options);
      finished.push(rev);
      if (!this.nextPending()) return finished;
    }
  }

  // ---- 摘要 / 对比 ----

  summaryOf(revisionId: string): IndexSummary | null {
    const rev = this.getRevision(revisionId);
    if (!rev) return null;
    if (rev.summary) return rev.summary;
    return buildSummary(rev, this.getExecution(revisionId)?.brokenRefs.length ?? 0);
  }

  static compareSummaries(before: IndexSummary | null, after: IndexSummary | null): SummaryDiff {
    const docs = (s: IndexSummary | null) => new Set((s?.catalogPaths ?? []).map((p) => p.docId));
    const beforeDocs = docs(before);
    const afterDocs = docs(after);
    const pathsChanged: SummaryDiff['pathsChanged'] = [];
    const beforePathMap = new Map((before?.catalogPaths ?? []).map((p) => [p.docId, p.path]));
    for (const item of after?.catalogPaths ?? []) {
      const oldPath = beforePathMap.get(item.docId);
      if (oldPath !== undefined && oldPath !== item.path) {
        pathsChanged.push({ key: item.docId, before: oldPath, after: item.path });
      }
    }
    const fingerprintsChanged: SummaryDiff['fingerprintsChanged'] = [];
    for (const key of new Set([
      ...Object.keys(before?.fingerprints ?? {}),
      ...Object.keys(after?.fingerprints ?? {}),
    ])) {
      const a = before?.fingerprints[key];
      const b = after?.fingerprints[key];
      if (a !== b) fingerprintsChanged.push({ key, before: a ?? null, after: b ?? null });
    }
    const customChanged: SummaryDiff['customChanged'] = [];
    for (const key of new Set([
      ...Object.keys(before?.customValues ?? {}),
      ...Object.keys(after?.customValues ?? {}),
    ])) {
      const a = before?.customValues[key] ?? null;
      const b = after?.customValues[key] ?? null;
      if (a !== b) customChanged.push({ key, before: a, after: b });
    }
    return {
      docsAdded: [...afterDocs].filter((d) => !beforeDocs.has(d)).sort(),
      docsRemoved: [...beforeDocs].filter((d) => !afterDocs.has(d)).sort(),
      pathsChanged,
      fingerprintsChanged,
      customChanged,
      brokenRefBefore: before?.brokenRefCount ?? 0,
      brokenRefAfter: after?.brokenRefCount ?? 0,
      totalTokensBefore: before?.totalTokens ?? 0,
      totalTokensAfter: after?.totalTokens ?? 0,
    };
  }

  // ---- 导入导出 ----

  exportData(): StoreDump {
    return this.store.export();
  }

  importData(dump: StoreDump): void {
    this.store.load(dump);
    this.recover();
  }

  /** 测试辅助：在一个全新的 MemoryStore 上恢复模拟器。 */
  static fromDump(dump: StoreDump, fixedpointBudget?: number): Simulator {
    const store = new MemoryStore();
    store.load(dump);
    return new Simulator(store, fixedpointBudget);
  }
}

export class SimulatedCrash extends Error {
  constructor(public step: number) {
    super(`模拟崩溃：已完成第 ${step} 步后进程终止`);
    this.name = 'SimulatedCrash';
  }
}

function buildSummary(rev: Revision, brokenRefCount: number): IndexSummary {
  const fingerprints: Record<string, string> = {};
  const customValues: Record<string, number | null> = {};
  let liveDocCount = 0;
  let tombstonedDocCount = 0;
  let totalTokens = 0;
  const catalogPaths: IndexSummary['catalogPaths'] = [];

  for (const node of Object.values(rev.graph.nodes)) {
    if (node.type === 'doc') {
      if (node.tombstone) tombstonedDocCount += 1;
      else {
        liveDocCount += 1;
        if (node.value?.kind === 'doc') catalogPaths.push({ docId: node.docId as string, path: node.value.path });
      }
    }
    if (node.type === 'tokens' && !node.tombstone && node.value?.kind === 'tokens') {
      totalTokens += node.value.tokens.length;
    }
    if (node.type === 'fingerprint' && !node.tombstone && node.value?.kind === 'fingerprint') {
      fingerprints[node.docId as string] = node.value.hash;
    }
    if (node.type === 'custom' && node.value?.kind === 'custom' && rev.snapshot.customs[node.customId ?? '']) {
      customValues[node.customId as string] = node.value.number;
    }
  }
  catalogPaths.sort((a, b) => (a.path === b.path ? a.docId.localeCompare(b.docId) : a.path.localeCompare(b.path)));

  let inverted: Record<string, string[]> = {};
  const invertedNode = rev.graph.nodes['view:inverted'];
  if (invertedNode?.value?.kind === 'inverted') inverted = invertedNode.value.entries;

  return {
    revisionId: rev.id,
    sequence: rev.sequence,
    status: rev.status,
    liveDocCount,
    tombstonedDocCount,
    totalTokens,
    catalogPaths,
    fingerprints,
    inverted,
    brokenRefCount,
    customValues,
  };
}

export function phaseLabel(phase: Phase): string {
  switch (phase) {
    case 'plan':
      return '计划';
    case 'recompute':
      return '重算';
    case 'verify':
      return '一致性校验';
    case 'publish':
      return '发布';
  }
}
