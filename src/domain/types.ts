// 增量索引失效模拟器 —— 核心领域类型

export type NodeType =
  | 'doc'
  | 'blob'
  | 'parser'
  | 'tokens'
  | 'reference'
  | 'resolved'
  | 'fingerprint'
  | 'catalog'
  | 'inverted'
  | 'forward'
  | 'linkgraph'
  | 'custom';

/** 依赖边的“味道”：只有匹配的变化才沿该边传播 */
export type EdgeFlavor =
  | 'content' // 内容变化
  | 'path' // 路径 / 身份变化
  | 'exists' // 存在性（墓碑）变化
  | 'parser-version' // 解析器版本变化
  | 'graph'; // 跨文档引用图变化

export const ALL_FLAVORS: EdgeFlavor[] = ['content', 'path', 'exists', 'parser-version', 'graph'];

export interface NodeRef {
  id: string;
  type: NodeType;
}

export interface Edge {
  /** 被依赖方（上游） */
  from: string;
  /** 依赖方（下游） */
  to: string;
  flavors: EdgeFlavor[];
  label?: string;
}

export interface GNode {
  id: string;
  type: NodeType;
  label: string;
  docId?: string;
  parserVersion?: number;
  refId?: string;
  sourceDocId?: string;
  targetPath?: string;
  contentHash?: string;
  ruleHash?: string;
  customId?: string;
  /** 墓碑：相对上一个快照已删除，但一致性重算完成前仍保留 */
  tombstone?: boolean;
}

// ---- 用户输入的规格（文档 / 引用 / 自定义派生视图）----

export interface DocSpec {
  id: string;
  path: string;
  content: string;
  parserVersion: number;
}

export interface RefSpec {
  id: string;
  sourceDocId: string;
  targetPath: string;
  label?: string;
}

export type CustomRuleKind = 'sum' | 'converge' | 'toggle';

export interface CustomSpec {
  id: string;
  label: string;
  rule: CustomRuleKind;
  /** 父节点 id（可以是任意图节点，包括其他 custom，允许成环） */
  parents: string[];
  init: number;
}

export interface SimulatorInput {
  docs: Record<string, DocSpec>;
  refs: Record<string, RefSpec>;
  customs: Record<string, CustomSpec>;
}

// ---- 变更集 ----

export interface ChangeSet {
  message: string;
  upsertDocs?: DocSpec[];
  deleteDocIds?: string[];
  upsertRefs?: RefSpec[];
  deleteRefIds?: string[];
  upsertCustoms?: CustomSpec[];
  deleteCustomIds?: string[];
}

// ---- 节点值（重算结果）----

export type NodeValue =
  | { kind: 'doc'; docId: string; path: string; content: string; parserVersion: number; tombstone: boolean }
  | { kind: 'blob'; hash: string; content: string }
  | { kind: 'parser'; version: number }
  | { kind: 'tokens'; docId: string; version: number; tokens: string[]; tombstone: boolean }
  | { kind: 'reference'; refId: string; sourceDocId: string; targetPath: string; tombstone: boolean }
  | { kind: 'resolved'; refId: string; sourceDocId: string; targetDocId: string | null; dangling: boolean; tombstone: boolean }
  | { kind: 'fingerprint'; docId: string; hash: string; tombstone: boolean }
  | { kind: 'catalog'; entries: { docId: string; path: string }[] }
  | { kind: 'inverted'; entries: Record<string, string[]> }
  | { kind: 'forward'; entries: Record<string, { path: string; tokens: string[] }> }
  | { kind: 'linkgraph'; entries: { refId: string; sourceDocId: string; targetDocId: string | null; dangling: boolean }[] }
  | { kind: 'custom'; customId: string; number: number | null };

export interface SerialNode extends GNode {
  value: NodeValue | null;
}

export interface Graph {
  nodes: Record<string, SerialNode>;
  edges: Edge[];
}

// ---- 计划 ----

export type ChangeKind = EdgeFlavor;

export interface Seed {
  nodeId: string;
  reasons: ChangeKind[];
  tombstone: boolean;
  detail: string;
}

export interface OrderedGroup {
  index: number;
  kind: 'single' | 'fixedpoint';
  nodeIds: string[];
}

export interface Plan {
  revisionId: string;
  parentRevisionId: string | null;
  seeds: Seed[];
  affectedIds: string[];
  reusableIds: string[];
  tombstoneIds: string[];
  /** 受影响节点 -> 从变化源出发的代表依赖路径（节点 id 序列） */
  paths: Record<string, string[]>;
  /** 受影响节点 -> 路径上每一跳经过的边味道 */
  pathFlavors: Record<string, EdgeFlavor[]>;
  orderGroups: OrderedGroup[];
  cycles: string[][];
}

// ---- 执行事件 / 执行记录 / Revision ----

export type Phase = 'plan' | 'recompute' | 'verify' | 'publish';

export type EventType =
  | 'revision-submitted'
  | 'phase-start'
  | 'phase-done'
  | 'seed-detected'
  | 'node-reused'
  | 'node-recompute-start'
  | 'node-recompute-done'
  | 'fixedpoint-iter'
  | 'fixedpoint-converged'
  | 'fixedpoint-budget-exhausted'
  | 'verify-broken-ref'
  | 'verify-ok'
  | 'published'
  | 'marked-stale'
  | 'resumed'
  | 'info';

export interface ExecutionEvent {
  seq: number;
  at: number;
  type: EventType;
  phase: Phase;
  nodeId?: string;
  groupIndex?: number;
  iteration?: number;
  message: string;
  detail?: Record<string, unknown>;
}

export interface FixedpointDiagnostics {
  groupIndex: number;
  members: string[];
  iterations: number;
  converged: boolean;
  /** 预算耗尽时保存的中间状态 */
  intermediate: Record<string, number | null>;
  history: Record<string, number | null>[];
}

export type ExecutionStatus = 'queued' | 'running' | 'complete' | 'failed' | 'stale';

export interface Execution {
  revisionId: string;
  status: ExecutionStatus;
  phase: Phase;
  /** 固定点迭代预算（每个固定点组共享） */
  budget: number;
  /** 重算阶段是否已宣告过复用项（恢复时不重复发事件） */
  reuseDone: boolean;
  /** 顺序执行步骤：复用步(0) + 每个执行组一步(1..N) + verify + publish */
  totalSteps: number;
  /** 已完成的重算组数量（等价于 completedSteps-1，但独立存储避免语义漂移） */
  completedGroups: number;
  completedSteps: number;
  /** 固定点组的检查点（崩溃后从最后完整迭代继续） */
  checkpoints: Record<number, { iteration: number; values: Record<string, number | null> }>;
  events: ExecutionEvent[];
  diagnostics: FixedpointDiagnostics[];
  brokenRefs: { refId: string; sourceDocId: string; targetPath: string }[];
  resumedFromPhase?: Phase;
  updatedAt: number;
}

export type RevisionStatus = 'queued' | 'running' | 'complete' | 'failed' | 'stale';

export interface Revision {
  id: string;
  sequence: number;
  parentId: string | null;
  createdAt: number;
  message: string;
  change: ChangeSet;
  /** 提交时的完整输入快照，保证计划永远基于原始快照 */
  snapshot: SimulatorInput;
  graph: Graph;
  status: RevisionStatus;
  plan: Plan | null;
  completedAt: number | null;
  summary: IndexSummary | null;
}

// ---- 索引摘要与对比 ----

export interface IndexSummary {
  revisionId: string;
  sequence: number;
  status: RevisionStatus;
  liveDocCount: number;
  tombstonedDocCount: number;
  totalTokens: number;
  catalogPaths: { docId: string; path: string }[];
  fingerprints: Record<string, string>;
  inverted: Record<string, string[]>;
  brokenRefCount: number;
  customValues: Record<string, number | null>;
}

export interface SummaryDiffEntry {
  key: string;
  before: unknown;
  after: unknown;
}

export interface SummaryDiff {
  docsAdded: string[];
  docsRemoved: string[];
  pathsChanged: SummaryDiffEntry[];
  fingerprintsChanged: SummaryDiffEntry[];
  customChanged: SummaryDiffEntry[];
  brokenRefBefore: number;
  brokenRefAfter: number;
  totalTokensBefore: number;
  totalTokensAfter: number;
}

// ---- 持久化转储 ----

export interface StoreDump {
  format: 'incremental-index-simulator/v1';
  exportedAt: number;
  entries: Record<string, string>;
}
