import { applyChangeset, cloneSnapshot, isRefDangling } from './changeset.js';
import {
  computeBacklinks,
  computeIndex,
  computePosting,
  computeToken,
  initRanks,
  rankInputs,
  rankIteration,
  rankValue,
  ranksConverged,
  shortHash
} from './compute.js';
import { buildGraph, nodeKey, parseKey, tokenSet } from './graph.js';
import { buildPlan } from './planner.js';
import type { KVStore } from './store.js';
import type {
  Changeset,
  ExecutionEvent,
  ExecutionPhase,
  IndexSummary,
  RevisionRecord,
  RuntimeOptions,
  Snapshot
} from './types.js';

const K_HEAD = 'head';
const K_SEQ = 'seq';
const K_EVENT_SEQ = 'eventSeq';
const revKey = (id: string) => `rev:${id}`;

export interface SubmitResult {
  revision: RevisionRecord;
}

const DEFAULT_MAX_ITERATIONS = 30;
const DEFAULT_EPSILON = 1e-6;

export class IncrementalIndexEngine {
  private store: KVStore;

  constructor(store: KVStore) {
    this.store = store;
    if (!this.store.get(K_HEAD)) {
      this.bootstrap();
    }
  }

  private bootstrap(): void {
    const genesis: RevisionRecord = {
      id: 'rev-0',
      seq: 0,
      parentId: null,
      description: '初始空快照',
      changes: { docChanges: [], refChanges: [] },
      createdAt: 0,
      status: 'committed',
      plan: {
        revisionId: 'rev-0',
        baseRevisionId: 'rev-0',
        affected: [],
        entries: [],
        groups: [],
        deletedKeys: [],
        reusableKeys: [],
        cycles: []
      },
      postSnapshot: { docs: {}, refs: {} },
      committedAt: 0,
      summary: undefined
    };
    genesis.summary = this.summarize(genesis);
    this.store.set(revKey('rev-0'), JSON.stringify(genesis));
    this.store.set(K_HEAD, 'rev-0');
    this.store.set(K_SEQ, '0');
    this.store.set(K_EVENT_SEQ, '0');
  }

  listRevisions(): RevisionRecord[] {
    return this.store
      .keys()
      .filter((k) => k.startsWith('rev:'))
      .map((k) => JSON.parse(this.store.get(k)!) as RevisionRecord)
      .sort((a, b) => a.seq - b.seq);
  }

  getRevision(id: string): RevisionRecord {
    const raw = this.store.get(revKey(id));
    if (!raw) {
      throw new Error(`未知 revision: ${id}`);
    }
    return JSON.parse(raw) as RevisionRecord;
  }

  headId(): string {
    return this.store.get(K_HEAD) ?? 'rev-0';
  }

  head(): RevisionRecord {
    return this.getRevision(this.headId());
  }

  snapshot(): Snapshot {
    return cloneSnapshot(this.head().postSnapshot);
  }

  events(): ExecutionEvent[] {
    return this.store
      .keys()
      .filter((k) => k.startsWith('event:'))
      .map((k) => JSON.parse(this.store.get(k)!) as ExecutionEvent)
      .sort((a, b) => a.seq - b.seq);
}

  /**
   * Submit a batch of changes. The batch is published atomically as one
   * revision; the plan is computed against the current head snapshot.
   * Plans never mix snapshots — a revision always carries the post-snapshot
   * projected from its own parent.
   */
  submit(changes: Changeset, description?: string): SubmitResult {
    const revisions = this.listRevisions();
    const parent = revisions[revisions.length - 1];
    if (parent.status === 'budget-exhausted') {
      throw new Error(`head ${parent.id} 固定点预算耗尽，请先恢复或重置后再提交`);
    }
    if (parent.status === 'planned') {
      throw new Error(`已有排队中的 ${parent.id}，请先运行后再提交新 revision`);
    }
    const seq = Number(this.store.get(K_SEQ) ?? '0') + 1;
    this.store.set(K_SEQ, String(seq));
    const id = `rev-${seq}`;

    for (const candidate of this.listRevisions()) {
      if (
        (candidate.status === 'running' || candidate.status === 'planned') &&
        candidate.id !== id
      ) {
        candidate.supersededBy = id;
        this.persist(candidate);
      }
    }

    const post = applyChangeset(parent.postSnapshot, changes);
    const committedKeys = new Set(
      parent.committedValues ? Object.keys(parent.committedValues) : []
    );
    const plan = buildPlan({
      revisionId: id,
      baseRevisionId: parent.id,
      changes,
      base: parent.postSnapshot,
      post,
      committedKeys
    });

    const revision: RevisionRecord = {
      id,
      seq,
      parentId: parent.id,
      description: description ?? `变更集 #${seq}`,
      changes,
      createdAt: Date.now(),
      status: 'planned',
      plan,
      postSnapshot: post,
      arrivalHeadId: parent.id,
      execution: {
        phase: 'prepare',
        completedKeys: [],
        nodeStates: {},
        groupIterations: {},
        groupConverged: {}
      }
    };
    this.store.set(revKey(id), JSON.stringify(revision));
    this.emit(revision, 'revision-created', {
      parent: parent.id,
      affected: plan.affected.length,
      reuse: plan.reusableKeys.length,
      deletes: plan.deletedKeys.length
    });
    return { revision };
  }

  private async emit(
    revision: RevisionRecord,
    type: ExecutionEvent['type'],
    payload?: Record<string, unknown>
  ): Promise<void> {
    const seq = Number(this.store.get(K_EVENT_SEQ) ?? '0') + 1;
    this.store.set(K_EVENT_SEQ, String(seq));
    const event: ExecutionEvent = {
      seq,
      revisionId: revision.id,
      timestamp: Date.now(),
      type,
      payload
    };
    this.store.set(`event:${seq}`, JSON.stringify(event));
  }

  private async notify(
    revision: RevisionRecord,
    type: ExecutionEvent['type'],
    payload?: Record<string, unknown>,
    options?: RuntimeOptions
  ): Promise<void> {
    await this.emit(revision, type, payload);
    if (options?.eventHook) {
      const seq = Number(this.store.get(K_EVENT_SEQ) ?? '0');
      const event = JSON.parse(this.store.get(`event:${seq}`)!) as ExecutionEvent;
      await options.eventHook(event);
    }
  }

  /**
   * Execute a planned revision across durable phases:
   * prepare → compute → commit → done.
   *
   * Crash recovery resumes from the last fully persisted phase/node.
   * If a newer revision already committed while this run was in progress,
   * the plan still completes against its original snapshot, but the result
   * is published as "stale" and never becomes head.
   */
  async runRevision(id: string, options: RuntimeOptions = {}): Promise<RevisionRecord> {
    let revision = this.getRevision(id);
    const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    const epsilon = options.convergenceEpsilon ?? DEFAULT_EPSILON;

    if (revision.status === 'committed' || revision.status === 'stale') {
      return revision;
    }
    if (revision.status === 'budget-exhausted') {
      revision = this.resumeBudgetRun(revision, options);
    }

    revision.status = 'running';
    this.persist(revision);
    if (revision.execution!.phase === 'prepare') {
      await this.enterPhase(revision, 'compute', options);
      await this.notify(revision, 'execution-started', {
        entries: revision.plan.entries.length,
        groups: revision.plan.groups.filter((g) => g.edgesInternal > 0).length
      }, options);
    } else {
      await this.notify(revision, 'execution-resumed', {
        phase: revision.execution!.phase,
        completed: revision.execution!.completedKeys.length
      }, options);
    }

    revision = await this.runCompute(revision, options, maxIterations, epsilon);
    if (revision.status === 'budget-exhausted') {
      return revision;
    }

    await this.enterPhase(revision, 'commit', options);
    revision = this.getRevision(revision.id);
    const latestAtCommit = this.listRevisions();
    const willBeStale =
      !!revision.supersededBy ||
      latestAtCommit[latestAtCommit.length - 1].id !== revision.id;
    if (willBeStale) {
      revision.status = 'stale';
      revision.supersessionNote = `执行期间新 revision ${revision.supersededBy ?? this.headId()} 已到达；本计划基于 ${revision.parentId} 快照完成，不发布为新 head，旧节点未与新快照混合`;
      await this.notify(revision, 'revision-stale', {
        head: this.headId(),
        parent: revision.parentId
      }, options);
    } else {
      revision.status = 'committed';
      revision.committedAt = Date.now();
      this.store.set(K_HEAD, revision.id);
      await this.notify(revision, 'revision-committed', {
        head: revision.id,
        reused: revision.plan.reusableKeys.length
      }, options);
    }
    revision.summary = this.summarize(revision);
    revision.execution!.phase = 'done';
    this.persist(revision);
    return revision;
  }

  private async enterPhase(
    revision: RevisionRecord,
    phase: ExecutionPhase,
    options: RuntimeOptions
  ): Promise<void> {
    revision.execution!.phase = phase;
    this.persist(revision);
    await this.notify(revision, 'phase-entered', { phase }, options);
  }

  private resumeBudgetRun(revision: RevisionRecord, options: RuntimeOptions): RevisionRecord {
    revision.status = 'running';
    revision.execution!.phase = 'compute';
    this.persist(revision);
    void options;
    return revision;
  }

  private async runCompute(
    revision: RevisionRecord,
    options: RuntimeOptions,
    maxIterations: number,
    epsilon: number
  ): Promise<RevisionRecord> {
    const parent = this.getRevision(revision.parentId!);
    const state = revision.execution!;
    const post = revision.postSnapshot;
    const inputs = rankInputs(post);

    const working: Record<string, unknown> = {};
    if (revision.intermediateValues) {
      Object.assign(working, revision.intermediateValues);
    } else if (parent.committedValues) {
      Object.assign(working, parent.committedValues);
    }
    delete working.__ranks;

    const storedRanks = revision.intermediateValues?.__ranks as
      | Record<string, number>
      | undefined;
    const ranks: Record<string, number> = storedRanks
      ? { ...storedRanks }
      : initRanks(inputs);

    const completed = new Set(state.completedKeys);
    const recomputeEntries = revision.plan.entries
      .filter((e) => e.type === 'recompute')
      .sort((a, b) => a.order - b.order);
    const deleteEntries = revision.plan.entries
      .filter((e) => e.type === 'delete')
      .sort((a, b) => b.order - a.order);

    for (const entry of deleteEntries) {
      if (completed.has(entry.key)) {
        continue;
      }
      delete working[entry.key];
      state.nodeStates[entry.key] = { key: entry.key, kind: entry.kind };
      state.completedKeys.push(entry.key);
      completed.add(entry.key);
      this.persist(revision);
      await this.notify(revision, 'node-deleted', {
        key: entry.key,
        kind: entry.kind,
        paths: entry.paths.length
      }, options);
    }

    const rankEntries = recomputeEntries.filter((e) => e.kind === 'rank');
    const firstRankEntry = rankEntries[0];
    const cyclicGroupIds = new Set(
      revision.plan.groups.filter((g) => g.edgesInternal > 0).map((g) => g.id)
    );

    for (const entry of recomputeEntries) {
      if (completed.has(entry.key)) {
        continue;
      }

      if (entry.kind === 'rank' && entry.key !== firstRankEntry?.key) {
        continue;
      }

      if (entry.kind === 'rank' && !state.rankGateDone) {
        const startIteration = Number(state.groupIterations.rank ?? 0);
        let previous = { ...ranks };
        let next = { ...ranks };
        let iterations = startIteration;
        let converged = false;
        let maxResidual = Infinity;

        if (iterations === 0) {
          this.checkpointRanks(revision, working, ranks);
        }

        while (iterations < maxIterations) {
          next = rankIteration(inputs, previous);
          iterations += 1;
          maxResidual = maxRankResidual(previous, next);
          converged = ranksConverged(previous, next, epsilon);
          state.groupIterations.rank = iterations;
          this.checkpointRanks(revision, working, next);
          await this.notify(revision, 'group-iteration', {
            groupId: null,
            cyclicGroups: Array.from(cyclicGroupIds),
            iteration: iterations,
            maxResidual,
            converged
          }, options);
          previous = next;
          if (converged) {
            break;
          }
        }

        Object.assign(ranks, next);

        if (!converged) {
          revision.budgetDiagnostics = {
            revisionId: revision.id,
            groupId: -1,
            members: rankEntries.map((e) => e.key),
            iterationsUsed: iterations,
            maxIterations,
            maxResidual,
            epsilon,
            intermediateRanks: { ...ranks },
            savedAt: Date.now()
          };
          revision.intermediateValues = { ...working, __ranks: ranks };
          revision.status = 'budget-exhausted';
          this.persist(revision);
          await this.notify(revision, 'budget-exhausted', {
            iterations,
            maxIterations,
            maxResidual,
            members: rankEntries.length
          }, options);
          return revision;
        }

        state.rankGateDone = true;
        for (const rankEntry of rankEntries) {
          const { local } = parseKey(rankEntry.key);
          working[rankEntry.key] = rankValue(local, ranks);
          state.nodeStates[rankEntry.key] = {
            key: rankEntry.key,
            kind: 'rank',
            iterations,
            converged: true
          };
          state.completedKeys.push(rankEntry.key);
          completed.add(rankEntry.key);
          await this.notify(revision, 'node-recompute', {
            key: rankEntry.key,
            kind: 'rank',
            order: rankEntry.order,
            groupId: rankEntry.groupId,
            reasons: rankEntry.reasons,
            pathSample: rankEntry.paths[0],
            iterations
          }, options);
        }
        state.groupConverged.rank = true;
        this.persist(revision);
        continue;
      }

      const isReuseCandidate = revision.plan.reusableKeys.includes(entry.key);
      const value = this.computeNode(entry.key, post, ranks);
      let reused = false;
      if (isReuseCandidate) {
        const oldValue = parent.committedValues?.[entry.key];
        if (oldValue !== undefined && stableEqual(oldValue, value)) {
          reused = true;
        }
      }
      working[entry.key] = value;

      state.nodeStates[entry.key] = {
        key: entry.key,
        kind: entry.kind,
        reused
      };
      state.completedKeys.push(entry.key);
      completed.add(entry.key);
      revision.intermediateValues = { ...working };
      this.persist(revision);
      if (options.crashAfterNode === entry.key) {
        throw new Error(`模拟崩溃：节点 ${entry.key} 检查点写入后进程退出`);
      }
      await this.notify(
        revision,
        reused ? 'node-reuse' : 'node-recompute',
        {
          key: entry.key,
          kind: entry.kind,
          order: entry.order,
          groupId: entry.groupId,
          reasons: entry.reasons,
          pathSample: entry.paths[0]
        },
        options
      );
    }

    revision.intermediateValues = undefined;
    revision.committedValues = working;
    revision.budgetDiagnostics = undefined;
    state.completedKeys = Array.from(new Set(state.completedKeys)).sort();
    this.persist(revision);
    return revision;
  }

  private checkpointRanks(
    revision: RevisionRecord,
    working: Record<string, unknown>,
    ranks: Record<string, number>
  ): void {
    revision.intermediateValues = { ...working, __ranks: ranks };
    this.persist(revision);
  }

  private computeNode(
    key: string,
    snapshot: Snapshot,
    ranks: Record<string, number>
  ): unknown {
    const { kind, local } = parseKey(key);
    switch (kind) {
      case 'token': {
        const slash = local.lastIndexOf('/');
        return computeToken(snapshot, local.slice(0, slash), local.slice(slash + 1));
      }
      case 'posting': {
        const slash = local.lastIndexOf('/');
        return computePosting(snapshot, local.slice(0, slash), local.slice(slash + 1));
      }
      case 'index':
        return computeIndex(snapshot);
      case 'rank':
        return rankValue(local, ranks);
      case 'backlinks':
        return computeBacklinks(snapshot, local, ranks);
      default:
        throw new Error(`未知节点类型: ${kind}`);
    }
  }

  private persist(revision: RevisionRecord): void {
    const storedRaw = this.store.get(revKey(revision.id));
    if (storedRaw) {
      const stored = JSON.parse(storedRaw) as RevisionRecord;
      if (stored.supersededBy && !revision.supersededBy) {
        revision.supersededBy = stored.supersededBy;
      }
    }
    this.store.set(revKey(revision.id), JSON.stringify(revision));
  }

  summarize(revision: RevisionRecord): IndexSummary {
    const snapshot = revision.postSnapshot;
    const docs = Object.values(snapshot.docs);
    const liveDocs = docs.filter((d) => !d.deleted);
    const refs = Object.values(snapshot.refs);
    const liveRefs = refs.filter((r) => !r.deleted);
    const dangling = liveRefs.filter((r) => isRefDangling(snapshot, r)).length;

    const values = revision.committedValues ?? {};
    const valueKeys = Object.keys(values);
    const tokenKeys = valueKeys.filter((k) => k.startsWith('token:'));
    const postingKeys = valueKeys.filter((k) => k.startsWith('posting:'));
    const indexEntry = values['index:all'] as
      | { termCount?: number }
      | undefined;
    const backlinkKeys = valueKeys.filter((k) => k.startsWith('backlinks:'));
    const rankKeys = valueKeys.filter((k) => k.startsWith('rank:'));

    const ranks = rankKeys
      .map((k) => ({
        docId: parseKey(k).local,
        rank: (values[k] as { rank: number }).rank
      }))
      .sort((a, b) => a.docId.localeCompare(b.docId));

    const contentHashes: Record<string, string> = {};
    for (const doc of liveDocs) {
      contentHashes[doc.id] = shortHash(doc.content);
    }

    return {
      revisionId: revision.id,
      basedOn: revision.parentId ?? revision.id,
      status: revision.status,
      docCount: docs.length,
      liveDocCount: liveDocs.length,
      tombstoneCount: docs.length - liveDocs.length,
      referenceCount: liveRefs.length,
      danglingRefCount: dangling,
      tokenCount: tokenKeys.length,
      postingCount: postingKeys.length,
      indexTerms: indexEntry?.termCount ?? 0,
      backlinkNodes: backlinkKeys.length,
      rankNodes: rankKeys.length,
      ranks,
      contentHashes
    };
  }

  compareSummaries(aId: string, bId: string): SummaryDiff {
    return diffSummaries(this.summarize(this.getRevision(aId)), this.summarize(this.getRevision(bId)));
  }

  exportJSON(): string {
    return this.store.exportJSON();
  }

  importJSON(data: string): void {
    this.store.importJSON(data);
  }

  reset(): void {
    this.store.clear();
    this.bootstrap();
  }
}

export interface SummaryDiff {
  from: string;
  to: string;
  counters: { field: keyof IndexSummary; from: number; to: number; delta: number }[];
  addedRanks: string[];
  removedRanks: string[];
  changedRanks: { docId: string; from: number; to: number }[];
  addedDocs: string[];
  removedDocs: string[];
  changedContent: string[];
}

function diffSummaries(a: IndexSummary, b: IndexSummary): SummaryDiff {
  const numericFields: (keyof IndexSummary)[] = [
    'docCount',
    'liveDocCount',
    'tombstoneCount',
    'referenceCount',
    'danglingRefCount',
    'tokenCount',
    'postingCount',
    'indexTerms',
    'backlinkNodes',
    'rankNodes'
  ];
  const counters = numericFields.map((field) => {
    const from = a[field] as number;
    const to = b[field] as number;
    return { field, from, to, delta: to - from };
  });

  const aRanks = new Map(a.ranks.map((r) => [r.docId, r.rank]));
  const bRanks = new Map(b.ranks.map((r) => [r.docId, r.rank]));
  const addedRanks = [...bRanks.keys()].filter((k) => !aRanks.has(k)).sort();
  const removedRanks = [...aRanks.keys()].filter((k) => !bRanks.has(k)).sort();
  const changedRanks = [...aRanks.keys()]
    .filter((k) => bRanks.has(k) && Math.abs(aRanks.get(k)! - bRanks.get(k)!) > 1e-9)
    .sort()
    .map((k) => ({ docId: k, from: aRanks.get(k)!, to: bRanks.get(k)! }));

  const addedDocs = Object.keys(b.contentHashes)
    .filter((id) => !(id in a.contentHashes))
    .sort();
  const removedDocs = Object.keys(a.contentHashes)
    .filter((id) => !(id in b.contentHashes))
    .sort();
  const changedContent = Object.keys(a.contentHashes)
    .filter((id) => id in b.contentHashes && a.contentHashes[id] !== b.contentHashes[id])
    .sort();

  return {
    from: a.revisionId,
    to: b.revisionId,
    counters,
    addedRanks,
    removedRanks,
    changedRanks,
    addedDocs,
    removedDocs,
    changedContent
  };
}

function stableEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function maxRankResidual(a: Record<string, number>, b: Record<string, number>): number {
  let max = 0;
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    max = Math.max(max, Math.abs((a[key] ?? 0) - (b[key] ?? 0)));
  }
  return max;
}

export { buildGraph, nodeKey, tokenSet };
