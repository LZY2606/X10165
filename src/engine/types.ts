export type Facet = 'content' | 'path' | 'parser' | 'reference' | 'existence';

export type NodeKind =
  | 'document'
  | 'reference'
  | 'token'
  | 'posting'
  | 'index'
  | 'backlinks'
  | 'rank';

export interface DocumentNode {
  id: string;
  path: string;
  content: string;
  parserVersion: 1 | 2;
  deleted: boolean;
}

export interface ReferenceNode {
  id: string;
  fromDoc: string;
  toDoc: string;
  deleted: boolean;
}

export interface Snapshot {
  docs: Record<string, DocumentNode>;
  refs: Record<string, ReferenceNode>;
}

export type DocChangeType = 'upsert' | 'rename' | 'delete';

export interface DocChange {
  id: string;
  type: DocChangeType;
  path?: string;
  content?: string;
  parserVersion?: 1 | 2;
}

export type RefChangeType = 'add' | 'remove' | 'retarget';

export interface RefChange {
  id: string;
  type: RefChangeType;
  fromDoc?: string;
  toDoc?: string;
}

export interface Changeset {
  docChanges: DocChange[];
  refChanges: RefChange[];
  description?: string;
}

export type DerivedNodeId =
  | { kind: 'token'; docId: string; token: string }
  | { kind: 'posting'; docId: string; token: string }
  | { kind: 'index' }
  | { kind: 'backlinks'; docId: string }
  | { kind: 'rank'; docId: string };

export interface GraphNode {
  id: DerivedNodeId;
  key: string;
  kind: Exclude<NodeKind, 'document' | 'reference'>;
  pathSensitive: boolean;
  incoming: GraphEdge[];
  outgoing: GraphEdge[];
}

export interface GraphEdge {
  from: string;
  to: string;
  facets: Facet[];
  via: string;
}

export interface AffectedNode {
  key: string;
  kind: GraphNode['kind'];
  pathSensitive: boolean;
  status: 'recompute' | 'reuse' | 'delete';
  reasons: string[];
  paths: DependencyPath[];
}

export interface DependencyPath {
  nodes: string[];
  edges: string[];
}

export type PlanEntryType = 'recompute' | 'delete';

export interface PlanEntry {
  type: PlanEntryType;
  key: string;
  kind: GraphNode['kind'];
  order: number;
  groupId?: number;
  paths: DependencyPath[];
  reasons: string[];
}

export type RevisionStatus =
  | 'planned'
  | 'running'
  | 'committed'
  | 'stale'
  | 'budget-exhausted';

export interface Plan {
  revisionId: string;
  baseRevisionId: string;
  affected: AffectedNode[];
  entries: PlanEntry[];
  groups: SCCGroup[];
  deletedKeys: string[];
  reusableKeys: string[];
  cycles: string[][];
}

export interface SCCGroup {
  id: number;
  members: string[];
  edgesInternal: number;
}

export interface NodeExecutionState {
  key: string;
  kind: GraphNode['kind'];
  iterations?: number;
  converged?: boolean;
  reused?: boolean;
}

export interface PlanExecutionState {
  phase: ExecutionPhase;
  completedKeys: string[];
  nodeStates: Record<string, NodeExecutionState>;
  groupIterations: Record<string, number>;
  groupConverged: Record<string, boolean>;
  rankGateDone?: boolean;
}

export type ExecutionPhase = 'prepare' | 'compute' | 'commit' | 'done';

export interface ExecutionEvent {
  seq: number;
  revisionId: string;
  timestamp: number;
  type:
    | 'revision-created'
    | 'execution-started'
    | 'phase-entered'
    | 'node-reuse'
    | 'node-recompute'
    | 'node-deleted'
    | 'group-iteration'
    | 'group-converged'
    | 'budget-exhausted'
    | 'revision-committed'
    | 'revision-stale'
    | 'execution-resumed';
  payload?: Record<string, unknown>;
}

export interface IndexSummary {
  revisionId: string;
  basedOn: string;
  status: RevisionStatus;
  docCount: number;
  liveDocCount: number;
  tombstoneCount: number;
  referenceCount: number;
  danglingRefCount: number;
  tokenCount: number;
  postingCount: number;
  indexTerms: number;
  backlinkNodes: number;
  rankNodes: number;
  ranks: { docId: string; rank: number }[];
  contentHashes: Record<string, string>;
}

export interface RevisionRecord {
  id: string;
  seq: number;
  parentId: string | null;
  description: string;
  changes: Changeset;
  createdAt: number;
  committedAt?: number;
  status: RevisionStatus;
  plan: Plan;
  postSnapshot: Snapshot;
  execution?: PlanExecutionState;
  summary?: IndexSummary;
  committedValues?: Record<string, unknown>;
  intermediateValues?: Record<string, unknown>;
  budgetDiagnostics?: BudgetDiagnostics;
  supersessionNote?: string;
  arrivalHeadId?: string;
  supersededBy?: string;
}

export interface BudgetDiagnostics {
  revisionId: string;
  groupId: number;
  members: string[];
  iterationsUsed: number;
  maxIterations: number;
  maxResidual: number;
  epsilon: number;
  intermediateRanks: Record<string, number>;
  savedAt: number;
}

export interface RuntimeOptions {
  maxIterations?: number;
  convergenceEpsilon?: number;
  eventHook?: (event: ExecutionEvent) => Promise<void> | void;
  crashAfterNode?: string;
  failBeforePhase?: ExecutionPhase;
}
