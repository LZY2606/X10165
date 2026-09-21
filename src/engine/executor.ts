import type {
  NodeValue,
  PersistedState,
  PhaseName,
  PlanEvent,
  PlanRecord,
  Snapshot,
} from "./types";
import { buildGraph } from "./graph";
import type { SnapshotGraph } from "./graph";
import { computeFixedPointTrace, computeFullValues, buildSummary } from "./compute";
import { rankFixedPointGroup, planAnalysis, PlannerInput } from "./planner";
import { applyChangeSet } from "./snapshot";

export const PHASES: PhaseName[] = ["prepare", "invalidate", "recompute", "publish"];

export interface PreparedPlan {
  plan: PlanRecord;
  targetSnapshot: Snapshot;
  targetGraph: SnapshotGraph;
  targetFull: { values: Record<string, NodeValue>; fixedPoint: ReturnType<typeof computeFullValues>["fixedPoint"] };
}

export function preparePlan(
  state: PersistedState,
  changeSetId: string,
  budget: number,
  now: number,
): PreparedPlan {
  const changeSet = state.changeSets[changeSetId];
  if (!changeSet) {
    throw new Error(`变更集不存在：${changeSetId}`);
  }
  const baseRevision = state.revisions[changeSet.baseRevisionId];
  if (!baseRevision) {
    throw new Error("基线 revision 不存在");
  }
  const baseSnapshot = baseRevision.snapshot;
  const baseGraph = buildGraph(baseSnapshot, Object.keys(baseSnapshot.tombstones));
  const baseValues = state.values[baseRevision.id] ?? {};

  const targetSnapshot = applyChangeSet(baseSnapshot, changeSet, changeSet.createdAt);
  const targetGraph = buildGraph(targetSnapshot, Object.keys(targetSnapshot.tombstones));
  const targetFull = computeFullValues(targetSnapshot, targetGraph, budget);
  const fixedPointGroup = rankFixedPointGroup(targetGraph);

  const plannerInput: PlannerInput = {
    changeSet,
    baseSnapshot,
    targetSnapshot,
    baseGraph,
    targetGraph,
    baseValues,
    targetValues: targetFull.values,
    fixedPointGroup,
  };
  const analysis = planAnalysis(plannerInput);

  const plan: PlanRecord = {
    id: changeSet.targetRevisionId.replace("rev", "plan"),
    changeSetId,
    baseRevisionId: baseRevision.id,
    targetRevisionId: changeSet.targetRevisionId,
    status: "prepared",
    nextPhase: "invalidate",
    completedPhases: ["prepare"],
    analysis,
    events: [
      {
        seq: state.counters.event,
        at: now,
        type: "phase-complete",
        phase: "prepare",
        message: "计划基于基线快照完成：受影响集合、重算顺序、可复用项已确定",
      },
    ],
    outdated: false,
    createdAt: now,
  };

  return { plan, targetSnapshot, targetGraph, targetFull };
}

export function invalidateEvents(plan: PlanRecord, seqStart: number, now: number): PlanEvent[] {
  const events: PlanEvent[] = [];
  let seq = seqStart;
  for (const info of plan.analysis.affected) {
    seq += 1;
    events.push({
      seq,
      at: now,
      type: "node-invalidated",
      phase: "invalidate",
      nodeId: info.nodeId,
      routes: info.routes,
      message: `${info.nodeId} 被 ${info.routeCount} 条依赖路径命中`,
    });
  }
  for (const nodeId of plan.analysis.retired) {
    seq += 1;
    events.push({
      seq,
      at: now,
      type: "node-retired",
      phase: "invalidate",
      nodeId,
      message: `${nodeId} 随旧快照退役`,
    });
  }
  seq += 1;
  events.push({
    seq,
    at: now,
    type: "phase-complete",
    phase: "invalidate",
    message: "失效传播完成",
  });
  return events;
}

export interface RecomputeResult {
  events: PlanEvent[];
  converged: boolean;
  diagnostics?: PreparedPlan["targetFull"]["fixedPoint"]["diagnostics"];
  intermediateScores?: Record<string, number>;
  seqEnd: number;
}

export function recomputeEvents(
  plan: PlanRecord,
  snapshot: Snapshot,
  budget: number,
  seqStart: number,
  now: number,
): RecomputeResult {
  let seq = seqStart;
  const events: PlanEvent[] = [];
  for (const nodeId of plan.analysis.order) {
    seq += 1;
    events.push({
      seq,
      at: now,
      type: "node-recomputed",
      phase: "recompute",
      nodeId,
      message: `按顺序重算 ${nodeId}`,
    });
  }

  const trace = computeFixedPointTrace(snapshot, budget);
  for (const step of trace.perIteration) {
    seq += 1;
    events.push({
      seq,
      at: now,
      type: "fixedpoint-iteration",
      phase: "recompute",
      iteration: step.iteration,
      maxDelta: step.maxDelta,
      message: `固定点第 ${step.iteration} 轮，maxDelta=${step.maxDelta.toExponential(3)}`,
    });
  }

  seq += 1;
  events.push({
    seq,
    at: now,
    type: trace.converged ? "fixedpoint-converged" : "fixedpoint-budget-exhausted",
    phase: "recompute",
    diagnostics: trace.diagnostics,
    message: trace.converged
      ? `固定点在 ${trace.iterations} 轮内收敛`
      : `预算 ${budget} 轮耗尽仍未收敛（maxDelta=${trace.maxDelta.toExponential(3)}），保存中间状态与诊断`,
  });
  seq += 1;
  events.push({
    seq,
    at: now,
    type: "phase-complete",
    phase: "recompute",
    message: trace.converged ? "重算阶段完成" : "重算阶段以失败结束",
  });

  return {
    events,
    converged: trace.converged,
    diagnostics: trace.diagnostics,
    intermediateScores: trace.scores,
    seqEnd: seq,
  };
}

export function buildTargetSummary(
  revisionId: string,
  parentId: string,
  changeSetId: string,
  snapshot: Snapshot,
  graph: SnapshotGraph,
  full: PreparedPlan["targetFull"],
) {
  return buildSummary(revisionId, parentId, changeSetId, snapshot, graph, full);
}
