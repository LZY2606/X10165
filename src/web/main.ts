import { IncrementalIndexEngine } from '../engine/engine.js';
import { LocalStorageKVStore } from '../engine/store.js';
import type {
  ExecutionEvent,
  GraphNode,
  Plan,
  RevisionRecord,
  Snapshot
} from '../engine/types.js';
import { buildGraph } from '../engine/graph.js';

import './styles.css';

const store = new LocalStorageKVStore();
const engine = new IncrementalIndexEngine(store);

const state = {
  selectedRevision: engine.listRevisions().at(-1)?.id ?? 'rev-0',
  compareA: 'rev-0',
  compareB: engine.headId(),
  animation: null as null | {
    plan: Plan;
    snapshot: Snapshot;
    index: number;
    keys: string[];
    timer: number;
  }
};

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <header>
    <h1>增量索引模拟器</h1>
    <p class="subtitle">文档 · token · 引用 · 派生视图 — 提交批量变更，观察失效传播、重算顺序与固定点</p>
  </header>
  <main>
    <section class="panel" id="editor-panel">
      <h2>① 编辑文档与引用</h2>
      <div class="grid-2">
        <div>
          <h3>文档</h3>
          <div id="doc-editor"></div>
          <div class="row">
            <input id="new-doc-id" placeholder="id，如 d4" />
            <input id="new-doc-path" placeholder="路径，如 /x/y.md" />
            <input id="new-doc-content" placeholder="内容" />
            <select id="new-doc-parser">
              <option value="1">解析器 v1（保留停用词）</option>
              <option value="2">解析器 v2（过滤停用词）</option>
            </select>
            <button id="add-doc">新建文档</button>
          </div>
        </div>
        <div>
          <h3>跨文档引用</h3>
          <div id="ref-editor"></div>
          <div class="row">
            <input id="new-ref-id" placeholder="引用 id，如 r9" />
            <input id="new-ref-from" placeholder="from 文档 id" />
            <input id="new-ref-to" placeholder="to 文档 id" />
            <button id="add-ref">新建引用</button>
          </div>
        </div>
      </div>
    </section>

    <section class="panel" id="submit-panel">
      <h2>② 提交批量变更集（一个 revision 原子发布）</h2>
      <div id="change-list" class="change-list"></div>
      <div class="row">
        <input id="change-desc" placeholder="变更说明（可选）" />
        <button id="submit-rev" class="primary">提交变更集</button>
        <button id="clear-changes">清空</button>
      </div>
    </section>

    <section class="panel" id="revision-panel">
      <h2>③ Revision 队列与执行</h2>
      <div id="revision-list"></div>
      <div class="row">
        <button id="run-selected">运行选中 revision</button>
        <label class="inline">
          固定点预算
          <input id="max-iter" type="number" value="30" min="1" max="200" style="width:5rem" />
        </label>
        <label class="inline">
          ε
          <input id="epsilon" type="text" value="0.000001" style="width:7rem" />
        </label>
      </div>
      <div id="execution-log" class="log"></div>
    </section>

    <section class="panel" id="animation-panel">
      <h2>④ 失效传播动画</h2>
      <div class="row">
        <button id="play-anim">播放失效→重算传播</button>
        <button id="step-anim">单步</button>
        <button id="reset-anim">复位</button>
        <span id="anim-caption" class="caption"></span>
      </div>
      <div id="graph-canvas"></div>
      <div id="path-detail" class="path-detail">选择一个高亮节点查看从变化源到它的依赖路径。</div>
    </section>

    <section class="panel" id="summary-panel">
      <h2>⑤ 比较两个 revision 的索引摘要</h2>
      <div class="row">
        <select id="compare-a"></select>
        <span>→</span>
        <select id="compare-b"></select>
        <button id="run-compare">比较</button>
      </div>
      <div id="summary-output"></div>
    </section>

    <section class="panel" id="persist-panel">
      <h2>⑥ 持久化 / 导入导出</h2>
      <div class="row">
        <button id="export-btn">导出全部状态（JSON）</button>
        <label class="button-like">
          导入 JSON
          <input id="import-file" type="file" accept="application/json" hidden />
        </label>
        <button id="reset-btn" class="danger">清空 localStorage 重置</button>
      </div>
      <div id="persist-message" class="caption"></div>
    </section>
  </main>
`;

interface PendingChange {
  kind: 'doc' | 'ref';
  id: string;
  payload: Record<string, unknown>;
}

const pending: PendingChange[] = [];

const $ = <T extends HTMLElement>(sel: string): T =>
  app.querySelector<T>(sel)!;

function snapshot(): Snapshot {
  return engine.snapshot();
}


function esc(text: string): string {
  return text.replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!
  );
}

function renderEditors(): void {
  const snap = snapshot();
  const docHost = $('#doc-editor');
  docHost.innerHTML = Object.values(snap.docs)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((doc) => {
      const status = doc.deleted
        ? '<span class="badge tomb">墓碑</span>'
        : `<span class="badge live">存活</span><span class="badge parser">v${doc.parserVersion}</span>`;
      return `
        <div class="entity ${doc.deleted ? 'deleted' : ''}">
          <div class="entity-head">${status} <strong>${esc(doc.id)}</strong> <code>${esc(doc.path)}</code></div>
          <div class="entity-body">${esc(doc.content)}</div>
          <div class="entity-actions">
            <button data-act="edit-doc" data-id="${esc(doc.id)}">编辑</button>
            <button data-act="rename-doc" data-id="${esc(doc.id)}">改名</button>
            <button data-act="parser-doc" data-id="${esc(doc.id)}">升级解析器</button>
            <button data-act="delete-doc" data-id="${esc(doc.id)}" class="danger">删除（墓碑）</button>
          </div>
        </div>`;
    })
    .join('');

  const refHost = $('#ref-editor');
  refHost.innerHTML = Object.values(snap.refs)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((ref) => {
      const source = snap.docs[ref.fromDoc];
      const target = snap.docs[ref.toDoc];
      const dangling =
        !ref.deleted && (!source || source.deleted || !target || target.deleted);
      const badge = ref.deleted
        ? '<span class="badge tomb">已移除</span>'
        : dangling
          ? '<span class="badge dangling">悬空引用</span>'
          : '<span class="badge live">有效</span>';
      return `
        <div class="entity ${ref.deleted ? 'deleted' : ''} ${dangling ? 'dangling-entity' : ''}">
          <div class="entity-head">${badge} <strong>${esc(ref.id)}</strong></div>
          <div class="entity-body"><code>${esc(ref.fromDoc)}</code> → <code>${esc(ref.toDoc)}</code></div>
          <div class="entity-actions">
            <button data-act="retarget-ref" data-id="${esc(ref.id)}">改指</button>
            <button data-act="remove-ref" data-id="${esc(ref.id)}" class="danger">移除引用</button>
          </div>
        </div>`;
    })
    .join('');
}

function renderChangeList(): void {
  const host = $('#change-list');
  if (pending.length === 0) {
    host.innerHTML = '<p class="caption">还没有待提交的变更。在上方编辑文档或引用即可加入变更集。</p>';
    return;
  }
  host.innerHTML = pending
    .map(
      (change, idx) => `
      <div class="change-item">
        <span class="badge change">${change.kind === 'doc' ? '文档' : '引用'}</span>
        <code>${esc(change.id)}</code>
        <span>${esc(describeChange(change))}</span>
        <button data-act="remove-change" data-idx="${idx}" class="danger">撤出</button>
      </div>`
    )
    .join('');
}

function describeChange(change: PendingChange): string {
  const p = change.payload;
  switch (p.type) {
    case 'upsert':
      return `新建 ${p.path as string}（解析器 v${String(p.parserVersion)}）`;
    case 'rename': {
      const parts: string[] = [];
      if (p.path) parts.push(`路径→${String(p.path)}`);
      if (p.content !== undefined) parts.push('内容更新');
      if (p.parserVersion !== undefined) parts.push(`解析器→v${String(p.parserVersion)}`);
      return parts.join('，') || '无字段变化';
    }
    case 'delete':
      return '删除（墓碑）';
    case 'add':
      return `新增引用 ${String(p.fromDoc)}→${String(p.toDoc)}`;
    case 'retarget':
      return `改指 ${p.fromDoc !== undefined ? String(p.fromDoc) + '→' : ''}${p.toDoc !== undefined ? String(p.toDoc) : ''}`;
    case 'remove':
      return '移除引用';
    default:
      return JSON.stringify(p);
  }
}

function statusBadge(status: RevisionRecord['status']): string {
  const map: Record<RevisionRecord['status'], string> = {
    planned: '排队',
    running: '运行中',
    committed: '已提交',
    stale: '已过时',
    'budget-exhausted': '预算耗尽'
  };
  return `<span class="badge status-${status}">${map[status]}</span>`;
}

function renderRevisions(): void {
  const host = $('#revision-list');
  const revisions = engine.listRevisions();
  host.innerHTML = revisions
    .map((rev) => {
      const affected = rev.plan.affected.length;
      const reuse = rev.plan.reusableKeys.length;
      const deletes = rev.plan.deletedKeys.length;
      const cycles = rev.plan.cycles.length;
      const selected = state.selectedRevision === rev.id ? 'selected' : '';
      return `
        <div class="revision ${selected}" data-rev="${esc(rev.id)}">
          <div>
            ${statusBadge(rev.status)}
            <strong>${esc(rev.id)}</strong>
            <span class="caption">${esc(rev.description)}</span>
            ${rev.supersessionNote ? `<div class="warn">⚠ ${esc(rev.supersessionNote)}</div>` : ''}
            ${rev.budgetDiagnostics ? `<div class="warn">⚠ 固定点预算耗尽：迭代 ${rev.budgetDiagnostics.iterationsUsed}/${rev.budgetDiagnostics.maxIterations}，残差 ${rev.budgetDiagnostics.maxResidual.toExponential(2)}，中间状态已保存</div>` : ''}
          </div>
          <div class="rev-meta">
            受影响 ${affected} · 可复用 ${reuse} · 删除 ${deletes} · 环 ${cycles}
          </div>
        </div>`;
    })
    .join('');

  const options = revisions
    .map((rev) => `<option value="${esc(rev.id)}" ${state.compareB === rev.id ? 'selected' : ''}>${esc(rev.id)} — ${esc(rev.description)}</option>`)
    .join('');
  $('#compare-a').innerHTML = revisions
    .map((rev) => `<option value="${esc(rev.id)}" ${state.compareA === rev.id ? 'selected' : ''}>${esc(rev.id)}</option>`)
    .join('');
  $('#compare-b').innerHTML = options;
}

function appendLog(text: string, cls = ''): void {
  const host = $('#execution-log');
  const line = document.createElement('div');
  line.className = `log-line ${cls}`;
  line.textContent = text;
  host.appendChild(line);
  host.scrollTop = host.scrollHeight;
}

async function runSelectedRevision(): Promise<void> {
  const id = state.selectedRevision;
  const rev = engine.getRevision(id);
  if (rev.status === 'committed' || rev.status === 'stale') {
    appendLog(`${id} 已经是终态 ${rev.status}`, 'done');
    return;
  }
  const maxIterations = Number($<HTMLInputElement>('#max-iter').value) || 30;
  const epsilon = Number($<HTMLInputElement>('#epsilon').value) || 1e-6;
  appendLog(`▶ 开始执行 ${id}（预算 ${maxIterations}，ε ${epsilon}）`);

  const result = await engine.runRevision(id, {
    maxIterations,
    convergenceEpsilon: epsilon,
    eventHook: async (event: ExecutionEvent) => {
      handleExecutionEvent(event);
      await sleep(60);
    }
  });

  appendLog(
    result.status === 'committed'
      ? `✔ ${id} 已提交为 head，受影响 ${result.plan.affected.length}，复用 ${result.plan.reusableKeys.length}`
      : result.status === 'stale'
        ? `◷ ${id} 基于原快照完成，但已过时（不发布为 head）`
        : `⊘ ${id} 预算耗尽，中间状态已持久化，可提高预算后恢复`,
    result.status === 'committed' ? 'done' : result.status === 'stale' ? 'stale' : 'fail'
  );
  renderAll();
}

function handleExecutionEvent(event: ExecutionEvent): void {
  const key = (event.payload?.key as string) ?? '';
  switch (event.type) {
    case 'phase-entered':
      appendLog(`阶段 → ${String(event.payload?.phase)}`);
      break;
    case 'node-reuse':
      appendLog(`♻ 复用 ${key}（值未变化）`, 'reuse');
      break;
    case 'node-recompute':
      appendLog(`重算 #${String(event.payload?.order ?? '')} ${key}`, 'recompute');
      highlightAnimationNode(key, 'recompute');
      break;
    case 'node-deleted':
      appendLog(`删除派生项 ${key}`, 'delete');
      highlightAnimationNode(key, 'delete');
      break;
    case 'group-iteration':
      appendLog(
        `固定点迭代 #${String(event.payload?.iteration)} 残差=${Number(event.payload?.maxResidual).toExponential(2)}${event.payload?.converged ? '（收敛）' : ''}`
      );
      break;
    case 'budget-exhausted':
      appendLog('固定点预算耗尽，已保存中间状态与诊断', 'fail');
      break;
    case 'revision-stale':
      appendLog('检测到更新的 revision，当前计划完成后将标记为过时', 'stale');
      break;
    case 'revision-committed':
      appendLog(`revision 发布为 head: ${String(event.payload?.head)}`, 'done');
      break;
    case 'execution-resumed':
      appendLog('从上次完整阶段恢复执行', 'stale');
      break;
    default:
      break;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface VizNode {
  key: string;
  label: string;
  kind: string;
  x: number;
  y: number;
}

function animationRevision(): RevisionRecord {
  const revisions = engine.listRevisions();
  const withPlan = revisions.filter((r) => r.plan.affected.length > 0);
  const selected = revisions.find((r) => r.id === state.selectedRevision);
  if (selected && selected.plan.affected.length > 0) {
    return selected;
  }
  return withPlan.at(-1) ?? revisions.at(-1)!;
}

function renderGraph(highlightKeys?: Map<string, 'affected' | 'recompute' | 'reuse' | 'delete' | 'source'>): void {
  const rev = animationRevision();
  const { nodes, edges } = buildGraph(rev.postSnapshot);
  const canvas = $('#graph-canvas');

  const affectedMap = new Map(rev.plan.affected.map((a) => [a.key, a]));
  const sourceKeys = new Set<string>();
  for (const affected of rev.plan.affected) {
    for (const path of affected.paths) {
      const first = path.nodes[1];
      if (first) {
        sourceKeys.add(first);
      }
    }
  }

  const groups: { key: string; nodes: GraphNode[] }[] = [
    { key: 'token', nodes: [] },
    { key: 'posting', nodes: [] },
    { key: 'rank', nodes: [] },
    { key: 'backlinks', nodes: [] },
    { key: 'index', nodes: [] }
  ];
  for (const node of Array.from(nodes.values()).sort((a, b) => a.key.localeCompare(b.key))) {
    groups.find((g) => g.key === node.kind)?.nodes.push(node);
  }

  const viz = new Map<string, VizNode>();
  const colX = [60, 250, 460, 670, 880];
  const rowHeight = 34;
  const width = 1020;
  const height = Math.max(420, ...groups.map((g) => g.nodes.length * rowHeight + 80));

  groups.forEach((group, colIndex) => {
    group.nodes.forEach((node, rowIndex) => {
      viz.set(node.key, {
        key: node.key,
        label: shortNodeLabel(node.key, node.kind),
        kind: node.kind,
        x: colX[colIndex],
        y: 46 + rowIndex * rowHeight
      });
    });
  });

  const activeEdges = new Set<string>();
  for (const affected of rev.plan.affected) {
    for (const path of affected.paths) {
      for (let i = 1; i < path.nodes.length - 1; i++) {
        activeEdges.add(`${path.nodes[i]}→${path.nodes[i + 1]}`);
      }
    }
  }

  const edgeSvg = edges
    .map((edge) => {
      const from = viz.get(edge.from);
      const to = viz.get(edge.to);
      if (!from || !to) {
        return '';
      }
      const active = activeEdges.has(`${edge.from}→${edge.to}`);
      return `<line x1="${from.x + 86}" y1="${from.y}" x2="${to.x - 4}" y2="${to.y}"
        class="edge ${active ? 'edge-active' : ''}" data-from="${esc(edge.from)}" data-to="${esc(edge.to)}" />`;
    })
    .join('');

  const nodeSvg = Array.from(viz.values())
    .map((node) => {
      const affected = affectedMap.get(node.key);
      const stateClass = highlightKeys?.get(node.key)
        ?? (affected?.status === 'delete'
          ? 'delete'
          : affected?.status === 'reuse'
            ? 'reuse'
            : affected
              ? 'affected'
              : sourceKeys.has(node.key)
                ? 'source'
                : 'idle');
      return `
        <g class="viz-node node-${stateClass}" data-key="${esc(node.key)}" transform="translate(${node.x},${node.y})">
          <rect width="160" height="24" rx="5"></rect>
          <text x="8" y="16">${esc(node.label)}</text>
        </g>`;
    })
    .join('');

  const headers = ['token（内容派生）', 'posting（路径敏感）', 'rank（引用固定点）', 'backlinks（路径敏感）', 'index（内容派生）']
    .map((label, i) => `<text x="${colX[i]}" y="22" class="col-head">${label}</text>`)
    .join('');

  canvas.innerHTML = `
    <div class="graph-meta">${esc(rev.id)}：${rev.plan.affected.length} 受影响 / ${rev.plan.reusableKeys.length} 可复用 / ${rev.plan.deletedKeys.length} 删除 / ${rev.plan.cycles.length} 环</div>
    <svg viewBox="0 0 ${width} ${height}" width="100%" height="${Math.min(height, 520)}">
      ${headers}
      ${edgeSvg}
      ${nodeSvg}
    </svg>`;

  canvas.querySelectorAll<SVGGElement>('.viz-node').forEach((el) => {
    el.addEventListener('click', () => showPathDetail(el.dataset.key!, rev));
  });
}

function shortNodeLabel(key: string, kind: string): string {
  const { local } = parseLocal(key);
  switch (kind) {
    case 'index':
      return 'index:all';
    case 'token':
    case 'posting': {
      const slash = local.lastIndexOf('/');
      const doc = local.slice(0, slash);
      const token = local.slice(slash + 1);
      return `${kind === 'token' ? 'tok' : 'post'}:${doc}/${token.length > 8 ? token.slice(0, 8) + '…' : token}`;
    }
    default:
      return `${kind}:${local}`;
  }
}

function parseLocal(key: string): { local: string } {
  return { local: key.slice(key.indexOf(':') + 1) };
}

function showPathDetail(key: string, rev: RevisionRecord): void {
  const affected = rev.plan.affected.find((a) => a.key === key);
  const host = $('#path-detail');
  if (!affected) {
    host.innerHTML = `<code>${esc(key)}</code> 不在本 revision 的受影响集合中（可复用或无关）。`;
    return;
  }
  host.innerHTML = `
    <div><code>${esc(key)}</code> — 状态：<strong>${affected.status}</strong></div>
    <div class="reasons">${affected.reasons.map((r) => `<span class="badge change">${esc(r)}</span>`).join('')}</div>
    <ol class="paths">
      ${affected.paths
        .map((path) => {
          const pieces: string[] = [`<em>${esc(path.nodes[0] ?? '')}</em>`];
          for (let i = 1; i < path.nodes.length; i++) {
            pieces.push(`<span class="arrow">—[${esc(path.edges[i - 1] ?? '')}]→</span>`);
            pieces.push(`<code>${esc(path.nodes[i] ?? '')}</code>`);
          }
          return `<li>${pieces.join(' ')}</li>`;
        })
        .join('')}
    </ol>`;
}


function buildAnimationSequence(rev: RevisionRecord): string[] {
  return rev.plan.entries
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((entry) => entry.key);
}

function ensureAnimation(): boolean {
  if (state.animation) {
    return true;
  }
  const rev = animationRevision();
  const keys = buildAnimationSequence(rev);
  if (keys.length === 0) {
    $('#anim-caption').textContent = '该 revision 没有需要动画展示的计划项。';
    return false;
  }
  state.animation = { plan: rev.plan, snapshot: rev.postSnapshot, index: 0, keys, timer: 0 };
  renderGraph();
  return true;
}

function stepAnimation(): void {
  if (!ensureAnimation()) {
    return;
  }
  const anim = state.animation!;
  if (anim.index >= anim.keys.length) {
    $('#anim-caption').textContent = '传播播放完成。';
    return;
  }
  const key = anim.keys[anim.index];
  const affected = anim.plan.affected.find((a) => a.key === key);
  const status = affected?.status ?? 'recompute';
  const highlight = new Map<string, 'affected' | 'recompute' | 'reuse' | 'delete' | 'source'>();

  if (affected) {
    const firstPath = affected.paths[0];
    if (firstPath) {
      for (const node of firstPath.nodes.slice(1)) {
        highlight.set(node, 'source');
      }
    }
  }
  highlight.set(key, status === 'reuse' ? 'reuse' : status === 'delete' ? 'delete' : 'recompute');
  renderGraph(highlight);
  $('#anim-caption').innerHTML =
    `步骤 ${anim.index + 1}/${anim.keys.length}：<code>${esc(key)}</code>（${status}）` +
    (affected?.reasons[0] ? ` — ${esc(affected.reasons[0])}` : '');
  anim.index += 1;
}

function playAnimation(): void {
  if (!ensureAnimation()) {
    return;
  }
  window.clearInterval(state.animation!.timer);
  state.animation!.timer = window.setInterval(() => {
    if (state.animation && state.animation.index >= state.animation.keys.length) {
      window.clearInterval(state.animation.timer);
      return;
    }
    stepAnimation();
  }, 500);
}

function resetAnimation(): void {
  if (state.animation) {
    window.clearInterval(state.animation.timer);
  }
  state.animation = null;
  $('#anim-caption').textContent = '';
  renderGraph();
}

function highlightAnimationNode(key: string, kind: 'recompute' | 'delete'): void {
  const highlight = new Map<string, 'affected' | 'recompute' | 'reuse' | 'delete' | 'source'>();
  highlight.set(key, kind);
  renderGraph(highlight);
}

function renderSummaryCompare(): void {
  const aId = $<HTMLSelectElement>('#compare-a').value;
  const bId = $<HTMLSelectElement>('#compare-b').value;
  if (aId === bId) {
    $('#summary-output').innerHTML = '<p class="caption">请选择两个不同的 revision。</p>';
    return;
  }
  const diff = engine.compareSummaries(aId, bId);
  const rows = diff.counters
    .map(
      (c) => `<tr class="${c.delta === 0 ? 'zero' : ''}">
        <td>${counterLabel(c.field)}</td>
        <td>${c.from}</td>
        <td>${c.to}</td>
        <td class="${c.delta > 0 ? 'up' : c.delta < 0 ? 'down' : ''}">${c.delta > 0 ? '+' : ''}${c.delta}</td>
      </tr>`
    )
    .join('');
  const rankRows = [
    ...diff.addedRanks.map((id) => `<tr><td><code>${esc(id)}</code></td><td>新增</td></tr>`),
    ...diff.removedRanks.map((id) => `<tr><td><code>${esc(id)}</code></td><td>移除</td></tr>`),
    ...diff.changedRanks.map(
      (r) => `<tr><td><code>${esc(r.docId)}</code></td><td>${r.from.toFixed(5)} → ${r.to.toFixed(5)}</td></tr>`
    )
  ].join('');
  $('#summary-output').innerHTML = `
    <table class="summary-table">
      <thead><tr><th>指标</th><th>${esc(diff.from)}</th><th>${esc(diff.to)}</th><th>Δ</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="grid-2">
      <div>
        <h3>文档变化</h3>
        <p>新增：${diff.addedDocs.map((d) => `<code>${esc(d)}</code>`).join(' ') || '无'}</p>
        <p>删除：${diff.removedDocs.map((d) => `<code>${esc(d)}</code>`).join(' ') || '无'}</p>
        <p>内容变化：${diff.changedContent.map((d) => `<code>${esc(d)}</code>`).join(' ') || '无'}</p>
      </div>
      <div>
        <h3>rank 变化</h3>
        <table class="summary-table"><tbody>${rankRows || '<tr><td>无</td></tr>'}</tbody></table>
      </div>
    </div>`;
}

function counterLabel(field: string): string {
  const map: Record<string, string> = {
    docCount: '文档总数（含墓碑）',
    liveDocCount: '存活文档',
    tombstoneCount: '墓碑',
    referenceCount: '有效引用',
    danglingRefCount: '悬空引用',
    tokenCount: 'token 节点',
    postingCount: 'posting 节点',
    indexTerms: '索引词项',
    backlinkNodes: '反向链接节点',
    rankNodes: 'rank 节点'
  };
  return map[field] ?? field;
}

function renderAll(): void {
  renderEditors();
  renderChangeList();
  renderRevisions();
  renderGraph();
}

app.addEventListener('click', async (event) => {
  const target = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-act]');
  if (!target) {
    return;
  }
  const act = target.dataset.act!;
  const id = target.dataset.id ?? '';
  const snap = snapshot();

  if (act === 'add-doc') {
    const docId = $<HTMLInputElement>('#new-doc-id').value.trim();
    const path = $<HTMLInputElement>('#new-doc-path').value.trim();
    const content = $<HTMLInputElement>('#new-doc-content').value;
    const parserVersion = Number($<HTMLSelectElement>('#new-doc-parser').value) as 1 | 2;
    if (!docId || !path) {
      alert('文档 id 和路径必填');
      return;
    }
    pending.push({ kind: 'doc', id: docId, payload: { type: 'upsert', path, content, parserVersion } });
    ['#new-doc-id', '#new-doc-path', '#new-doc-content'].forEach((sel) => ($(sel) as HTMLInputElement).value = '');
    renderChangeList();
  }

  if (act === 'edit-doc') {
    const doc = snap.docs[id];
    const content = prompt(`编辑 ${id} 的内容`, doc.content);
    if (content === null) {
      return;
    }
    const parserRaw = prompt(`解析器版本（1 或 2）`, String(doc.parserVersion));
    const parserVersion = parserRaw === '2' ? 2 : 1;
    pending.push({
      kind: 'doc',
      id,
      payload: {
        type: 'rename',
        content,
        parserVersion: parserVersion === doc.parserVersion ? undefined : parserVersion
      }
    });
    renderChangeList();
  }

  if (act === 'rename-doc') {
    const doc = snap.docs[id];
    const path = prompt(`新路径（当前 ${doc.path}）`, doc.path);
    if (path === null || path === doc.path) {
      return;
    }
    pending.push({ kind: 'doc', id, payload: { type: 'rename', path } });
    renderChangeList();
  }

  if (act === 'parser-doc') {
    const doc = snap.docs[id];
    const nextVersion = doc.parserVersion === 1 ? 2 : 1;
    if (!confirm(`将 ${id} 的解析器从 v${doc.parserVersion} 切换到 v${nextVersion}？\n只有声明依赖 parser 的 token/posting/index 链会失效。`)) {
      return;
    }
    pending.push({ kind: 'doc', id, payload: { type: 'rename', parserVersion: nextVersion } });
    renderChangeList();
  }

  if (act === 'delete-doc') {
    if (!confirm(`删除 ${id}？将生成墓碑，指向它的引用在一致性重算前保留为悬空引用。`)) {
      return;
    }
    pending.push({ kind: 'doc', id, payload: { type: 'delete' } });
    renderChangeList();
  }

  if (act === 'add-ref') {
    const refId = $<HTMLInputElement>('#new-ref-id').value.trim();
    const fromDoc = $<HTMLInputElement>('#new-ref-from').value.trim();
    const toDoc = $<HTMLInputElement>('#new-ref-to').value.trim();
    if (!refId || !fromDoc || !toDoc) {
      alert('引用 id、from、to 必填');
      return;
    }
    pending.push({ kind: 'ref', id: refId, payload: { type: 'add', fromDoc, toDoc } });
    ['#new-ref-id', '#new-ref-from', '#new-ref-to'].forEach((sel) => ($(sel) as HTMLInputElement).value = '');
    renderChangeList();
  }

  if (act === 'retarget-ref') {
    const ref = snap.refs[id];
    const fromDoc = prompt('from 文档 id（留空保持不变）', ref.fromDoc) ?? '';
    const toDoc = prompt('to 文档 id（留空保持不变）', ref.toDoc) ?? '';
    const payload: Record<string, unknown> = { type: 'retarget' };
    if (fromDoc && fromDoc !== ref.fromDoc) {
      payload.fromDoc = fromDoc;
    }
    if (toDoc && toDoc !== ref.toDoc) {
      payload.toDoc = toDoc;
    }
    pending.push({ kind: 'ref', id, payload });
    renderChangeList();
  }

  if (act === 'remove-ref') {
    pending.push({ kind: 'ref', id, payload: { type: 'remove' } });
    renderChangeList();
  }

  if (act === 'remove-change') {
    const idx = Number(target.dataset.idx);
    pending.splice(idx, 1);
    renderChangeList();
  }

  if (act === undefined) {
    return;
  }
});

$('#clear-changes').addEventListener('click', () => {
  pending.length = 0;
  renderChangeList();
});

$('#submit-rev').addEventListener('click', () => {
  if (pending.length === 0) {
    alert('变更集为空');
    return;
  }
  const changes = {
    description: $<HTMLInputElement>('#change-desc').value || undefined,
    docChanges: pending.filter((c) => c.kind === 'doc').map((c) => c.payload as never),
    refChanges: pending.filter((c) => c.kind === 'ref').map((c) => c.payload as never)
  };
  try {
    const { revision } = engine.submit(changes as never, changes.description);
    appendLog(`已创建 ${revision.id}：受影响 ${revision.plan.affected.length}，复用 ${revision.plan.reusableKeys.length}，删除 ${revision.plan.deletedKeys.length}`);
    pending.length = 0;
    state.selectedRevision = revision.id;
    $<HTMLInputElement>('#change-desc').value = '';
    renderAll();
  } catch (error) {
    alert((error as Error).message);
  }
});

$('#revision-list').addEventListener('click', (event) => {
  const item = (event.target as HTMLElement).closest<HTMLDivElement>('[data-rev]');
  if (item) {
    state.selectedRevision = item.dataset.rev!;
    state.animation = null;
    renderRevisions();
    renderGraph();
  }
});

$('#run-selected').addEventListener('click', () => {
  void runSelectedRevision();
});
$('#play-anim').addEventListener('click', playAnimation);
$('#step-anim').addEventListener('click', stepAnimation);
$('#reset-anim').addEventListener('click', resetAnimation);
$('#run-compare').addEventListener('click', renderSummaryCompare);

$('#export-btn').addEventListener('click', () => {
  const blob = new Blob([engine.exportJSON()], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `incremental-index-${new Date().toISOString().slice(0, 19)}.json`;
  link.click();
  URL.revokeObjectURL(url);
  $('#persist-message').textContent = '已导出全部 revision、计划与执行事件。';
});

$('#import-file').addEventListener('change', (event) => {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) {
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    try {
      engine.importJSON(String(reader.result));
      state.selectedRevision = engine.headId();
      state.animation = null;
      renderAll();
      $('#persist-message').textContent = '导入成功，计划顺序与摘要已恢复。';
      appendLog('已从 JSON 导入完整状态');
    } catch (error) {
      alert(`导入失败：${(error as Error).message}`);
    }
  };
  reader.readAsText(file);
  input.value = '';
});

$('#reset-btn').addEventListener('click', () => {
  if (!confirm('确定清空 localStorage 中的全部模拟数据？')) {
    return;
  }
  engine.reset();
  pending.length = 0;
  state.selectedRevision = 'rev-0';
  state.animation = null;
  renderAll();
  $('#execution-log').innerHTML = '';
  $('#summary-output').innerHTML = '';
  $('#persist-message').textContent = '已重置到初始空快照。';
});

renderAll();
