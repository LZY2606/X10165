import type {
  ChangeSet,
  ExportBundle,
  NodeValue,
  PersistedState,
  PhaseName,
  PlanRecord,
  Revision,
  Snapshot,
  StoredChangeSet,
} from "./types";
import {
  MemoryPersistence,
  PersistenceAdapter,
  LocalStoragePersistence,
} from "./persistence";
import { seedSnapshot } from "./seed";
import { buildGraph } from "./graph";
import { buildSummary, computeFullValues } from "./compute";
import { applyChangeSet } from "./snapshot";
import {
  PHASES,
  preparePlan,
  invalidateEvents,
  recomputeEvents,
  buildTargetSummary,
} from "./executor";
import { fnv1aHex } from "./hash";

const DEFAULT_BUDGET = 50;

function freshState(now: number): PersistedState {
  const snapshot = seedSnapshot();
  const graph = buildGraph(snapshot, []);
  const full = computeFullValues(snapshot, graph, DEFAULT_BUDGET);
  const revisionId = "rev-000";
  const summary = buildSummary(revisionId, null, null, snapshot, graph, full);
  const revision: Revision = {
    id: revisionId,
    parentId: null,
    changeSetId: null,
    createdAt: now,
    snapshot,
    summary,
  };
  return {
    format: "iisim-state",
    version: 1,
    counters: { rev: 0, cs: 0, plan: 0, event: 1 },
    revisions: { [revisionId]: revision },
    changeSets: {},
    plans: {},
    values: { [revisionId]: full.values },
    headId: revisionId,
    activePlanId: null,
    fixedPointBudget: DEFAULT_BUDGET,
    createdAt: now,
  };
}

export class SimulatorStore {
  private state: PersistedState;
  private adapter: PersistenceAdapter;
  private readonly now: () => number;

  constructor(adapter?: PersistenceAdapter, now?: () => number) {
    this.adapter = adapter ?? new MemoryPersistence();
    this.now = now ?? (() => Date.now());
    const loaded = this.adapter.load();
    if (loaded) {
      this.state = JSON.parse(loaded) as PersistedState;
    } else {
      this.state = freshState(this.now());
      this.persist();
    }
  }

  static withLocalStorage(now?: () => number): SimulatorStore {
    return new SimulatorStore(new LocalStoragePersistence(), now);
  }

  private persist(): void {
    const snapshot = JSON.stringify(this.state);
    const previous = this.adapter.load();
    try {
      this.adapter.save(snapshot);
    } catch (error) {
      if (previous !== null) {
        this.state = JSON.parse(previous) as PersistedState;
      }
      throw error;
    }
  }

  getState(): PersistedState {
    return this.state;
  }

  head(): Revision {
    return this.state.revisions[this.state.headId]!;
  }

  revision(id: string): Revision | undefined {
    return this.state.revisions[id];
  }

  values(revisionId: string): Record<string, NodeValue> {
    return this.state.values[revisionId] ?? {};
  }

  listRevisions(): Revision[] {
    return Object.values(this.state.revisions).sort((a, b) =>
      a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt - b.createdAt,
    );
  }

  listPlans(): PlanRecord[] {
    return Object.values(this.state.plans).sort((a, b) =>
      a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt - b.createdAt,
    );
  }

  activePlan(): PlanRecord | null {
    return this.state.activePlanId ? this.state.plans[this.state.activePlanId]! : null;
  }

  submitChangeSet(description: string, changeSet: Omit<ChangeSet, "id" | "createdAt">): PlanRecord {
    const base = this.head();
    this.state.counters.cs += 1;
    this.state.counters.rev += 1;
    const csId = `cs-${String(this.state.counters.cs).padStart(3, "0")}`;
    const revisionId = `rev-${String(this.state.counters.rev).padStart(3, "0")}`;
    const stored: StoredChangeSet = {
      ...changeSet,
      id: csId,
      description,
      createdAt: this.now(),
      baseRevisionId: base.id,
      targetRevisionId: revisionId,
    };
    this.state.changeSets[csId] = stored;
    return this.createPlan(csId);
  }

  private createPlan(changeSetId: string): PlanRecord {
    const changeSet = this.state.changeSets[changeSetId]!;
    if (this.state.activePlanId) {
      const active = this.state.plans[this.state.activePlanId]!;
      active.outdated = true;
      this.state.activePlanId = null;
    }
    this.state.counters.plan += 1;
    const prepared = preparePlan(this.state, changeSetId, this.state.fixedPointBudget, this.now());
    const plan = prepared.plan;
    plan.id = `plan-${String(this.state.counters.plan).padStart(3, "0")}`;
    this.state.plans[plan.id] = plan;
    this.state.activePlanId = plan.id;
    const event = plan.events[0]!;
    event.seq = this.state.counters.event;
    this.persist();
    return plan;
  }

  private nextSeq(): number {
    this.state.counters.event += 1;
    return this.state.counters.event;
  }

  plan(planId: string): PlanRecord {
    const plan = this.state.plans[planId];
    if (!plan) {
      throw new Error(`计划不存在：${planId}`);
    }
    return plan;
  }

  advancePlan(planId?: string): PlanRecord {
    const plan = planId ? this.plan(planId) : this.activePlan();
    if (!plan) {
      throw new Error("没有进行中的计划");
    }
    const phase: PhaseName = plan.nextPhase;
    if (phase === "invalidate") {
      this.runInvalidate(plan);
    } else if (phase === "recompute") {
      this.runRecompute(plan, plan.budgetOverride ?? this.state.fixedPointBudget);
    } else if (phase === "publish") {
      this.publish(plan);
    } else {
      throw new Error(`计划状态为 ${plan.status}，无法推进`);
    }
    return plan;
  }

  runToCompletion(planId?: string): PlanRecord {
    let plan = planId ? this.plan(planId) : this.activePlan();
    if (!plan) {
      throw new Error("没有进行中的计划");
    }
    const id = plan.id;
    const guard = new Set<string>();
    while (!["published", "failed", "outdated"].includes(plan.status)) {
      if (guard.has(plan.nextPhase)) {
        throw new Error("执行器无法继续推进");
      }
      guard.add(plan.nextPhase);
      this.advancePlan(id);
      plan = this.state.plans[id]!;
    }
    return plan;
  }

  resumeActivePlan(): PlanRecord | null {
    const plan = this.activePlan();
    if (!plan) {
      return null;
    }
    return this.runToCompletion(plan.id);
  }

  private runInvalidate(plan: PlanRecord): void {
    plan.status = "running";
    const events = invalidateEvents(plan, this.state.counters.event, this.now());
    for (const event of events) {
      this.state.counters.event += 1;
      event.seq = this.state.counters.event;
      plan.events.push(event);
    }
    plan.completedPhases.push("invalidate");
    plan.nextPhase = "recompute";
    this.persist();
  }

  private runRecompute(plan: PlanRecord, budget: number): void {
    plan.status = "running";
    const changeSet = this.state.changeSets[plan.changeSetId]!;
    const baseSnapshot = this.state.revisions[plan.baseRevisionId]!.snapshot;
    const targetSnapshot = applyChangeSet(baseSnapshot, changeSet, changeSet.createdAt);
    const result = recomputeEvents(plan, targetSnapshot, budget, this.state.counters.event, this.now());
    for (const event of result.events) {
      this.state.counters.event += 1;
      event.seq = this.state.counters.event;
      plan.events.push(event);
    }
    plan.completedPhases.push("recompute");
    if (!result.converged) {
      this.failPlan(plan, result.diagnostics!, result.intermediateScores!);
      return;
    }
    plan.nextPhase = "publish";
    this.persist();
  }

  private failPlan(
    plan: PlanRecord,
    diagnostics: NonNullable<PlanRecord["diagnostics"]>,
    intermediateScores: Record<string, number>,
  ): void {
    plan.status = "failed";
    plan.diagnostics = diagnostics;
    plan.intermediateScores = intermediateScores;
    plan.finishedAt = this.now();
    if (this.state.activePlanId === plan.id) {
      this.state.activePlanId = null;
    }
    this.state.counters.event += 1;
    plan.events.push({
      seq: this.state.counters.event,
      at: this.now(),
      type: "plan-failed",
      phase: "recompute",
      diagnostics,
      message: "预算耗尽：保留中间状态与诊断，本次不发布 revision，不宣称成功",
    });
    this.persist();
  }

  retryFailedPlan(planId: string, budgetOverride?: number): PlanRecord {
    const plan = this.state.plans[planId];
    if (!plan || plan.status !== "failed") {
      throw new Error("只能重试失败的计划");
    }
    const budget = budgetOverride ?? Math.max(this.state.fixedPointBudget, (plan.diagnostics?.iterations ?? 0) * 2);
    const replacement: PlanRecord = {
      ...plan,
      status: "prepared",
      nextPhase: "invalidate",
      completedPhases: ["prepare"],
      events: plan.events.filter((event) => event.phase === "prepare" || event.type === "plan-retry"),
      diagnostics: undefined,
      intermediateScores: undefined,
      outdated: false,
      budgetOverride: budget,
      finishedAt: undefined,
    };
    this.state.counters.event += 1;
    replacement.events.push({
      seq: this.state.counters.event,
      at: this.now(),
      type: "plan-retry",
      message: `以预算 ${budget} 重新执行失败计划`,
    });
    this.state.plans[planId] = replacement;
    this.state.activePlanId = planId;
    this.persist();
    return replacement;
  }

  private publish(plan: PlanRecord): void {
    const changeSet = this.state.changeSets[plan.changeSetId]!;
    const parent = this.state.revisions[plan.baseRevisionId]!;
    const snapshot = applyChangeSet(parent.snapshot, changeSet, changeSet.createdAt);
    const graph = buildGraph(snapshot, Object.keys(snapshot.tombstones));
    const budget = plan.budgetOverride ?? this.state.fixedPointBudget;
    const full = computeFullValues(snapshot, graph, budget);
    const summary = buildTargetSummary(
      plan.targetRevisionId,
      parent.id,
      changeSet.id,
      snapshot,
      graph,
      full,
    );
    const revision: Revision = {
      id: plan.targetRevisionId,
      parentId: parent.id,
      changeSetId: changeSet.id,
      createdAt: this.now(),
      snapshot,
      summary,
    };
    this.state.revisions[revision.id] = revision;
    this.state.values[revision.id] = full.values;
    if (revisionNumber(revision.id) >= revisionNumber(this.state.headId)) {
      this.state.headId = revision.id;
    }
    plan.status = "published";
    plan.nextPhase = "publish";
    plan.completedPhases = ["prepare", "invalidate", "recompute", "publish"];
    plan.finishedAt = this.now();
    if (this.state.activePlanId === plan.id) {
      this.state.activePlanId = null;
    }
    this.state.counters.event += 1;
    plan.events.push({
      seq: this.state.counters.event,
      at: this.now(),
      type: "revision-published",
      phase: "publish",
      revisionId: revision.id,
      message: `revision ${revision.id} 原子发布；旧引用在一致性重算前保留为悬挂引用`,
    });
    this.persist();
  }

  setFixedPointBudget(budget: number): void {
    this.state.fixedPointBudget = Math.max(1, Math.floor(budget));
    this.persist();
  }

  crashBeforeNextSave(): void {
    if (this.adapter instanceof MemoryPersistence) {
      this.adapter.crashBeforePhase();
    }
  }

  resetAll(): void {
    this.adapter.clear();
    this.state = freshState(this.now());
    this.persist();
  }

  exportBundle(): ExportBundle {
    const plans = this.listPlans();
    const planOrder = plans
      .map((plan) => `${plan.id}:${plan.analysis.order.join(">")}`)
      .join("||");
    const summaries = this.listRevisions()
      .map((revision) => JSON.stringify(revision.summary))
      .join("||");
    return {
      format: "iisim-export",
      version: 1,
      exportedAt: this.now(),
      state: this.state,
      integrity: {
        planOrderChecksum: fnv1aHex(planOrder),
        summaryChecksum: fnv1aHex(summaries),
      },
    };
  }

  importBundle(bundle: ExportBundle): void {
    if (bundle.format !== "iisim-export" || bundle.version !== 1) {
      throw new Error("导入文件格式不兼容");
    }
    const plans = Object.values(bundle.state.plans).sort((a, b) => a.id.localeCompare(b.id));
    const planOrder = plans.map((plan) => `${plan.id}:${plan.analysis.order.join(">")}`).join("||");
    const summaries = Object.values(bundle.state.revisions)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((revision) => JSON.stringify(revision.summary))
      .join("||");
    if (
      fnv1aHex(planOrder) !== bundle.integrity.planOrderChecksum ||
      fnv1aHex(summaries) !== bundle.integrity.summaryChecksum
    ) {
      throw new Error("完整性校验失败：计划顺序或摘要已损坏");
    }
    this.state = bundle.state;
    this.persist();
  }
}

function revisionNumber(id: string): number {
  return Number(id.replace("rev-", "")) || 0;
}
