export type ParserVersion = "v1" | "v2" | (string & {});

export interface DocSource {
  path: string;
  content: string;
  parserVersion: ParserVersion;
}

export interface RefSource {
  id: string;
  from: string;
  to: string;
  label?: string;
}

export interface Tombstone {
  path: string;
  at: number;
  reason: string;
}

export interface Snapshot {
  docs: Record<string, DocSource>;
  refs: Record<string, RefSource>;
  tombstones: Record<string, Tombstone>;
}

export type ChangeOpType =
  | "upsertDoc"
  | "deleteDoc"
  | "renameDoc"
  | "upsertRef"
  | "deleteRef";

export interface ChangeOp {
  type: ChangeOpType;
  path?: string;
  newPath?: string;
  content?: string;
  parserVersion?: ParserVersion;
  refId?: string;
  from?: string;
  to?: string;
  label?: string;
}

export interface ChangeSet {
  id: string;
  description: string;
  ops: ChangeOp[];
  createdAt: number;
}

export type NodeKind =
  | "doc"
  | "tombstone"
  | "token"
  | "ref"
  | "rank"
  | "view-token-index"
  | "view-token-fingerprint"
  | "view-ref-graph"
  | "view-rank";

export type EdgeType = "content" | "parser" | "path" | "exists" | "value";

export interface GraphNode {
  id: string;
  kind: NodeKind;
  label: string;
  alive: boolean;
  pathSensitive: boolean;
}

export interface GraphEdge {
  from: string;
  to: string;
  type: EdgeType;
}

export interface DependencyGraph {
  nodes: Record<string, GraphNode>;
  edges: GraphEdge[];
  out: Record<string, GraphEdge[]>;
  inn: Record<string, GraphEdge[]>;
}

export interface NodeValue {
  kind: NodeKind;
  valueHash: string;
  path?: string;
  alive?: boolean;
  parserVersion?: ParserVersion;
  contentHash?: string;
  tokens?: string[];
  owners?: string[];
  refId?: string;
  from?: string;
  to?: string;
  label?: string;
  at?: number;
  reason?: string;
  inverted?: Record<string, string[]>;
  fingerprints?: Record<string, string>;
  graphEdges?: GraphRefEdge[];
  danglingCount?: number;
  score?: number;
  scores?: Record<string, number>;
  iterations?: number;
  converged?: boolean;
}

export interface GraphRefEdge {
  refId: string;
  from: string;
  to: string;
  label?: string;
  dangling: boolean;
}

export interface FixedPointDiagnostics {
  iterations: number;
  budget: number;
  tolerance: number;
  maxDelta: number;
  converged: boolean;
}

export type OriginKind =
  | "doc-added"
  | "doc-deleted"
  | "doc-content"
  | "doc-parser"
  | "doc-rename-out"
  | "doc-rename-in"
  | "ref-added"
  | "ref-deleted"
  | "ref-changed";

export interface OriginInfo {
  nodeId: string;
  kind: OriginKind;
  renameFrom?: string;
  renameTo?: string;
}

export interface RouteHop {
  from: string;
  to: string;
  type: EdgeType;
}

export interface DependencyRoute {
  originId: string;
  hops: RouteHop[];
}

export interface AffectedInfo {
  nodeId: string;
  routes: DependencyRoute[];
  routeCount: number;
  inFixedPoint: boolean;
  valueChanged: boolean;
}

export interface PlanAnalysis {
  origins: OriginInfo[];
  affected: AffectedInfo[];
  added: string[];
  retired: string[];
  reused: string[];
  recomputedUnchanged: string[];
  order: string[];
  fixedPointGroup: string[];
}

export type PlanStatus =
  | "prepared"
  | "running"
  | "failed"
  | "published"
  | "outdated";

export type PhaseName = "prepare" | "invalidate" | "recompute" | "publish";

export interface PlanEvent {
  seq: number;
  at: number;
  type: string;
  phase?: PhaseName;
  nodeId?: string;
  routes?: DependencyRoute[];
  iteration?: number;
  maxDelta?: number;
  diagnostics?: FixedPointDiagnostics;
  revisionId?: string;
  message?: string;
}

export interface PlanRecord {
  id: string;
  changeSetId: string;
  baseRevisionId: string;
  targetRevisionId: string;
  status: PlanStatus;
  nextPhase: PhaseName;
  completedPhases: PhaseName[];
  analysis: PlanAnalysis;
  events: PlanEvent[];
  diagnostics?: FixedPointDiagnostics;
  intermediateScores?: Record<string, number>;
  budgetOverride?: number;
  outdated: boolean;
  createdAt: number;
  finishedAt?: number;
}

export interface StoredChangeSet extends ChangeSet {
  baseRevisionId: string;
  targetRevisionId: string;
}

export interface RevisionSummary {
  revisionId: string;
  parentId: string | null;
  changeSetId: string | null;
  docsAlive: number;
  docsDead: number;
  tokenNodes: number;
  refs: number;
  danglingRefs: number;
  indexTerms: number;
  fingerprints: Record<string, string>;
  rankConverged: boolean;
  rankIterations: number;
  rankTop: Array<[string, number]>;
  valueChecksum: string;
}

export interface Revision {
  id: string;
  parentId: string | null;
  changeSetId: string | null;
  createdAt: number;
  snapshot: Snapshot;
  summary: RevisionSummary | null;
}

export interface PersistedState {
  format: "iisim-state";
  version: 1;
  counters: { rev: number; cs: number; plan: number; event: number };
  revisions: Record<string, Revision>;
  changeSets: Record<string, StoredChangeSet>;
  plans: Record<string, PlanRecord>;
  values: Record<string, Record<string, NodeValue>>;
  headId: string;
  activePlanId: string | null;
  fixedPointBudget: number;
  createdAt: number;
}

export interface ExportBundle {
  format: "iisim-export";
  version: 1;
  exportedAt: number;
  state: PersistedState;
  integrity: {
    planOrderChecksum: string;
    summaryChecksum: string;
  };
}

export interface SimulatorOptions {
  fixedPointBudget?: number;
  tolerance?: number;
  damping?: number;
  now?: () => number;
}

