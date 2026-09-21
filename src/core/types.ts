export type NodeId = string;

/** Virtual change-source id used when the global parser version changes. */
export const PARSER_SOURCE = '$parser';

export interface DocSpec {
  kind: 'document';
  path: string;
  content: string;
  refs: NodeId[];
}

export interface TokensSpec {
  kind: 'tokens';
  doc: NodeId;
}

export interface ViewSpec {
  kind: 'view';
  deps: NodeId[];
  sensitivity: 'content' | 'path';
  usesParser: boolean;
}

export type NodeSpec = DocSpec | TokensSpec | ViewSpec;

export interface NodeState {
  id: NodeId;
  spec: NodeSpec;
  /** Deleted documents become tombstones until a consistency recompute completes. */
  tombstone: boolean;
  value: string[];
  valueHash: string;
}

export interface GraphState {
  parserVersion: number;
  nodes: Record<NodeId, NodeState>;
}

export interface Changeset {
  upsertDocs?: Record<NodeId, { path: string; content: string; refs?: NodeId[] }>;
  deleteDocs?: NodeId[];
  upsertTokens?: Record<NodeId, { doc: NodeId }>;
  upsertViews?: Record<
    NodeId,
    { deps: NodeId[]; sensitivity?: 'content' | 'path'; usesParser?: boolean }
  >;
  deleteNodes?: NodeId[];
  parserVersion?: number;
}

export interface AffectedItem {
  id: NodeId;
  reason: string;
  /** Dependency path from a change source to this node (source first). */
  path: NodeId[];
}

export interface PhaseSpec {
  /** Member node ids, sorted for stable iteration. */
  nodes: NodeId[];
  /** True when the phase is a cyclic fixed-point group. */
  cyclic: boolean;
  /** Fixed-point iteration budget (only meaningful for cyclic phases). */
  budget: number;
}

export interface InvalidationReport {
  revision: number;
  sources: NodeId[];
  affected: AffectedItem[];
  /** Nodes downstream of a change whose signature is unchanged: safe to reuse. */
  reusable: NodeId[];
  phases: PhaseSpec[];
}

export type PlanStatus = 'pending' | 'running' | 'completed' | 'budget-exhausted';

export interface Plan {
  id: string;
  revision: number;
  baseRevision: number;
  /** Frozen graph snapshot at `revision`; execution never reads live state. */
  snapshot: GraphState;
  /** Invalidation signatures of the snapshot graph (for safe result salvage). */
  signatures: Record<NodeId, string>;
  phases: PhaseSpec[];
  status: PlanStatus;
  /** True when a newer revision arrived before this plan finished. */
  stale: boolean;
  /** Number of fully completed phases (crash recovery resumes here). */
  completedPhases: number;
  results: Record<NodeId, { value: string[]; valueHash: string }>;
  diagnostics: string[];
}

export interface RevisionSummary {
  revision: number;
  nodeCount: number;
  tokenCount: number;
  /** node id -> valueHash */
  nodes: Record<NodeId, string>;
  summaryHash: string;
}

export interface Revision {
  id: number;
  parent: number | null;
  changeset: Changeset;
  report: InvalidationReport;
  planId: string;
  tombstones: NodeId[];
  summary?: RevisionSummary;
}

export interface ExecEvent {
  seq: number;
  planId: string;
  type: string;
  detail: string;
}

export interface PersistedState {
  currentRevision: number;
  parserVersion: number;
  live: Record<NodeId, NodeState>;
  signatures: Record<NodeId, string>;
  revisions: Revision[];
  plans: Plan[];
  events: ExecEvent[];
  seq: number;
}
