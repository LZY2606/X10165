export type NodeKind = 'document' | 'token' | 'reference' | 'view';

export interface IndexNode {
  id: string;
  kind: NodeKind;
  deps: string[];
  pathSensitive: boolean;
  usesParser: boolean;
  path: string | null;
  contentHash: string | null;
  structHash: string;
  facts: string[];
  tombstone: boolean;
  dangling: boolean;
}

export interface DocumentState {
  id: string;
  path: string;
  content: string;
  deleted: boolean;
}

export interface ReferenceState {
  id: string;
  fromDoc: string;
  toPath: string;
}

export interface ViewState {
  id: string;
  deps: string[];
  pathSensitive: boolean;
  usesParser: boolean;
}

export interface Workspace {
  documents: Record<string, DocumentState>;
  references: Record<string, ReferenceState>;
  views: Record<string, ViewState>;
  parserVersion: string;
}

export type ChangeOp =
  | { type: 'createDocument'; docId: string; path: string; content: string }
  | { type: 'updateDocument'; docId: string; content: string }
  | { type: 'renameDocument'; docId: string; newPath: string }
  | { type: 'deleteDocument'; docId: string }
  | { type: 'addReference'; refId: string; fromDoc: string; toPath: string }
  | { type: 'removeReference'; refId: string }
  | { type: 'defineView'; view: ViewState }
  | { type: 'removeView'; viewId: string }
  | { type: 'setParserVersion'; version: string };

export type SourceKind = 'create' | 'content' | 'path' | 'delete' | 'parser';

export interface ChangeSource {
  nodeId: string;
  kind: SourceKind;
  reason: string;
}

export interface AffectedItem {
  nodeId: string;
  path: string[];
  reason: string;
}

export type PlanStatus =
  | 'planned'
  | 'invalidated'
  | 'recomputed'
  | 'completed'
  | 'budget-exhausted';

export interface Plan {
  id: string;
  revision: number;
  changes: ChangeOp[];
  sources: ChangeSource[];
  affected: AffectedItem[];
  reusable: string[];
  order: string[];
  groups: string[][];
  waves: string[][];
  status: PlanStatus;
  stale: boolean;
  diagnostics: string[];
  checkpointStage: number;
  snapshot: Record<string, IndexNode>;
  desired: Record<string, IndexNode>;
  working: Record<string, IndexNode> | null;
  result: Record<string, IndexNode> | null;
}

export interface Revision {
  id: number;
  planId: string;
  ops: ChangeOp[];
  summary: string | null;
  entries: Record<string, string>;
}

export interface ExecutionEvent {
  seq: number;
  planId: string;
  stage: string;
  message: string;
}

export interface PersistedState {
  workspace: Workspace;
  index: Record<string, IndexNode>;
  revisions: Revision[];
  plans: Plan[];
  events: ExecutionEvent[];
  seq: number;
}
