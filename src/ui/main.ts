import './styles.css';
import { Engine } from '../core/engine';
import { Executor } from '../core/executor';
import { computeSCCs, depsOf } from '../core/graph';
import { LocalStorageStore, Store, emptyState } from '../core/storage';
import { canonicalStringify } from '../core/hash';
import type { Changeset, NodeId, Plan, Revision } from '../core/types';

const store = new Store(new LocalStorageStore('iisim:'));
const engine = new Engine(store);
const executor = new Executor(store);

// 崩溃恢复：页面加载时从最后一个完整阶段继续所有“运行中”的计划
const bootLog: string[] = [];
const resumedPlans = executor.recover({ onEvent: (t, d) => bootLog.push(`${t}: ${d}`) });
if (resumedPlans.length > 0) {
  bootLog.unshift(`检测到 ${resumedPlans.length} 个未完成计划，已从最后一个完整阶段继续`);
}

let pending: Changeset = {};
let pendingDesc: string[] = [];
let lastRevisionId: number | null = null;
let compareA = 0;
let compareB = 0;
let timers: number[] = [];

function qs<T extends HTMLElement>(sel: string): T {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing element ${sel}`);
  return el;
}
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function clearTimers(): void {
  for (const t of timers) window.clearInterval(t);
  timers = [];
}
function readVal(id: string): string {
  return (qs<HTMLInputElement>(`#${id}`).value ?? '').trim();
}
function parseList(s: string): string[] {
  return s.split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean);
}
function stage(desc: string, mutate: (cs: Changeset) => void): void {
  mutate(pending);
  pendingDesc.push(desc);
  render();
}

interface Pos { x: number; y: number }

function layout(): Map<NodeId, Pos> {
  const live = store.data.live;
  const ids = Object.keys(live).sort();
  const deps = (id: NodeId) => depsOf(live[id].spec).filter((d) => live[d]);
  const sccs = computeSCCs(ids, deps);
  const compOf = new Map<NodeId, number>();
  sccs.forEach((scc, i) => scc.forEach((n) => compOf.set(n, i)));
  const depth: number[] = sccs.map(() => 0);
  sccs.forEach((scc, i) => {
    let d = 0;
    for (const n of scc) {
      for (const dep of deps(n)) {
        const j = compOf.get(dep)!;
        if (j !== i) d = Math.max(d, depth[j] + 1);
      }
    }
    depth[i] = d;
  });
  const perColumn = new Map<number, number>();
  const pos = new Map<NodeId, Pos>();
  for (const scc of sccs) {
    for (const id of scc) {
      const col = depth[compOf.get(id)!];
      const row = perColumn.get(col) ?? 0;
      perColumn.set(col, row + 1);
      pos.set(id, { x: 30 + col * 180, y: 26 + row * 84 });
    }
  }
  return pos;
}

// ---------- 图渲染 ----------

function graphHtml(): string {
  const live = store.data.live;
  const ids = Object.keys(live).sort();
  if (ids.length === 0) return '<p class="path">暂无节点，请先添加文档。</p>';
  const pos = layout();
  const edges: string[] = [];
  for (const id of ids) {
    const p1 = pos.get(id)!;
    for (const dep of depsOf(live[id].spec)) {
      if (!live[dep]) continue;
      const p0 = pos.get(dep)!;
      const dangling = live[dep].tombstone;
      const x1 = p0.x + 120;
      const y1 = p0.y + 24;
      const x2 = p1.x;
      const y2 = p1.y + 24;
      const dash = dangling ? ' stroke-dasharray="5,4"' : '';
      const color = dangling ? '#ff9f43' : '#3a4a6e';
      edges.push(
        `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="1.5"${dash}/>`,
      );
    }
  }
  const nodesHtml = ids
    .map((id) => {
      const n = live[id];
      const p = pos.get(id)!;
      const kindLabel =
        n.spec.kind === 'document' ? '文档' : n.spec.kind === 'tokens' ? 'token' : '视图';
      const tomb = n.tombstone ? ' tombstone' : '';
      const value = n.tombstone ? '墓碑' : n.value.slice(0, 4).join(' ');
      return (
        `<div class="gnode${tomb}" id="gn-${esc(id)}" style="left:${p.x}px;top:${p.y}px">` +
        `<div><b>${esc(id)}</b> <span class="k">${kindLabel}</span></div>` +
        `<div class="k">${esc(value)}</div></div>`
      );
    })
    .join('');
  const maxX = Math.max(...[...pos.values()].map((p) => p.x)) + 160;
  const maxY = Math.max(...[...pos.values()].map((p) => p.y)) + 90;
  return (
    `<div id="graph" style="width:${maxX}px;height:${maxY}px">` +
    `<svg id="edges" width="${maxX}" height="${maxY}">${edges.join('')}</svg>` +
    nodesHtml +
    `</div>`
  );
}

// ---------- 动画 ----------

function markNode(id: NodeId, cls: string): void {
  const el = document.getElementById(`gn-${id}`);
  if (el) el.classList.add(cls);
}

function animateInvalidation(revision: Revision): void {
  clearTimers();
  for (const s of revision.report.sources) markNode(s, 'source');
  const items = [...revision.report.affected].sort((a, b) => a.path.length - b.path.length);
  let i = 0;
  const step = (): void => {
    if (i >= items.length) {
      for (const r of revision.report.reusable) markNode(r, 'reusable');
      return;
    }
    const item = items[i];
    i += 1;
    markNode(item.id, 'dirty');
    const log = document.getElementById('anim-log');
    if (log) {
      log.innerHTML += `<div class="ev">失效: <b>${esc(item.path.join(' → '))}</b></div>`;
      log.scrollTop = log.scrollHeight;
    }
    timers.push(window.setTimeout(step, 420));
  };
  timers.push(window.setTimeout(step, 300));
}

function animateExecution(plan: Plan): void {
  clearTimers();
  let i = 0;
  const step = (): void => {
    if (i >= plan.phases.length) return;
    const phase = plan.phases[i];
    i += 1;
    for (const id of phase.nodes) markNode(id, 'computed');
    timers.push(window.setTimeout(step, 500));
  };
  step();
}

// ---------- 面板 HTML ----------

function nodeListHtml(): string {
  const live = store.data.live;
  const ids = Object.keys(live).sort();
  if (ids.length === 0) return '<li>（空）</li>';
  return ids
    .map((id) => {
      const n = live[id];
      const spec = n.spec;
      let tag = '';
      let detail = '';
      if (spec.kind === 'document') {
        tag = '<span class="tag doc">文档</span>';
        const refs = spec.refs.length > 0 ? ` 引用: ${esc(spec.refs.join(', '))}` : '';
        detail = `${esc(spec.path)} · ${esc(spec.content.slice(0, 24))}${refs}`;
      } else if (spec.kind === 'tokens') {
        tag = '<span class="tag tokens">token</span>';
        detail = `提取自 ${esc(spec.doc)}`;
      } else {
        tag = '<span class="tag view">视图</span>';
        const flags = [spec.sensitivity === 'path' ? '路径敏感' : '内容派生'];
        if (spec.usesParser) flags.push('依赖解析器');
        detail = `deps: ${esc(spec.deps.join(', ') || '-')} · ${flags.join(' · ')}`;
      }
      const tomb = n.tombstone ? '<span class="tag tombstone">墓碑</span>' : '';
      const val = n.tombstone ? '' : ` <span class="sub">值: ${esc(n.value.join(' ') || '（未计算）')}</span>`;
      const del =
        spec.kind === 'document'
          ? `<button class="danger" data-del-doc="${esc(id)}">删除</button>`
          : `<button class="danger" data-del-node="${esc(id)}">删除</button>`;
      return `<li>${tag}${tomb}<b>${esc(id)}</b> <span class="sub">${detail}</span>${val}<br>${del}</li>`;
    })
    .join('');
}

function editorHtml(): string {
  return `
  <section>
    <h2>节点</h2>
    <ul class="list">${nodeListHtml()}</ul>
  </section>
  <section>
    <h2>添加 / 更新文档</h2>
    <label>ID</label><input id="doc-id" placeholder="A" />
    <label>路径</label><input id="doc-path" placeholder="docs/a.txt" />
    <label>内容</label><textarea id="doc-content" placeholder="hello world"></textarea>
    <label>引用（逗号分隔的文档 ID）</label><input id="doc-refs" placeholder="B, C" />
    <button data-act="stage-doc">暂存文档变更</button>
  </section>
  <section>
    <h2>添加 token 提取器</h2>
    <label>ID</label><input id="tok-id" placeholder="T1" />
    <label>文档 ID</label><input id="tok-doc" placeholder="A" />
    <button data-act="stage-tokens">暂存 token 提取器</button>
  </section>
  <section>
    <h2>添加 / 更新派生视图</h2>
    <label>ID</label><input id="view-id" placeholder="V1" />
    <label>依赖（逗号分隔）</label><input id="view-deps" placeholder="T1, B" />
    <label>敏感度</label>
    <select id="view-sens">
      <option value="content">内容派生（改名可复用）</option>
      <option value="path">路径敏感（改名失效）</option>
    </select>
    <label><input type="checkbox" id="view-parser" style="width:auto" /> 声明依赖解析器版本</label>
    <button data-act="stage-view">暂存视图变更</button>
  </section>
  <section>
    <h2>解析器</h2>
    <p class="path">当前版本: <b>v${store.data.parserVersion}</b>（v2 按字母数字切分 token）</p>
    <button data-act="stage-parser">暂存解析器升级</button>
  </section>`;
}

function pendingHtml(): string {
  const items = pendingDesc.map((d) => `<li>${esc(d)}</li>`).join('');
  return `
  <section>
    <h2>待提交变更集（${pendingDesc.length}）</h2>
    <ul class="list">${items || '<li>（空）</li>'}</ul>
    <button class="primary" data-act="commit" ${pendingDesc.length === 0 ? 'disabled' : ''}>提交变更集</button>
    <button data-act="clear-pending" ${pendingDesc.length === 0 ? 'disabled' : ''}>清空</button>
    <button data-act="demo">加载示例</button>
    <button class="danger" data-act="reset">重置全部</button>
  </section>`;
}

function reportHtml(): string {
  if (lastRevisionId === null) return '<section><h2>失效报告</h2><p class="path">提交变更集后在此显示失效传播。</p><div id="anim-log" class="log"></div></section>';
  const rev = store.data.revisions.find((r) => r.id === lastRevisionId);
  if (!rev) return '';
  const rep = rev.report;
  const affected = rep.affected
    .map(
      (a) =>
        `<li><b>${esc(a.id)}</b> <span class="sub">${esc(a.reason)}</span><br>` +
        `<span class="path">路径: <b>${esc(a.path.join(' → '))}</b></span></li>`,
    )
    .join('');
  const reusable = rep.reusable.map((r) => `<span class="pill completed">${esc(r)}</span> `).join('');
  const phases = rep.phases
    .map(
      (p, i) =>
        `<li>阶段 ${i}: ${esc(p.nodes.join(', '))}${p.cyclic ? ` <span class="pill stale">固定点组 · 预算 ${p.budget}</span>` : ''}</li>`,
    )
    .join('');
  return `
  <section>
    <h2>失效报告 · revision ${rev.id}</h2>
    <p class="path">变化源: ${esc(rep.sources.join(', ') || '（无）')}</p>
    <h2>受影响集合（${rep.affected.length}）</h2>
    <ul class="list">${affected || '<li>（无）</li>'}</ul>
    <h2>可复用项</h2>
    <p>${reusable || '<span class="path">（无）</span>'}</p>
    <h2>重算顺序</h2>
    <ul class="list">${phases || '<li>（无）</li>'}</ul>
    <h2>传播动画日志</h2>
    <div id="anim-log" class="log"></div>
  </section>`;
}

function plansHtml(): string {
  const plans = [...store.data.plans].sort((a, b) => a.revision - b.revision);
  const items = plans
    .map((p) => {
      const canRun = p.status !== 'completed';
      const diag = p.diagnostics.map((d) => `<div class="diff-removed">${esc(d)}</div>`).join('');
      return (
        `<li><span class="pill ${p.status}">${p.status}</span> <b>${esc(p.id)}</b> ` +
        `<span class="sub">rev ${p.revision} · 阶段 ${p.completedPhases}/${p.phases.length}` +
        `${p.stale ? ' · 已过时' : ''}</span><br>` +
        `<button data-run-plan="${esc(p.id)}" ${canRun ? '' : 'disabled'}>运行重算</button>` +
        `${diag}</li>`
      );
    })
    .join('');
  return `
  <section>
    <h2>重算计划</h2>
    <ul class="list">${items || '<li>（无）</li>'}</ul>
  </section>`;
}

function revisionsHtml(): string {
  const revs = [...store.data.revisions].sort((a, b) => a.id - b.id);
  const opts = (sel: number) =>
    revs
      .map((r) => `<option value="${r.id}" ${r.id === sel ? 'selected' : ''}>revision ${r.id}</option>`)
      .join('');
  const rows = revs
    .map((r) => {
      const sum = r.summary;
      return (
        `<tr><td>${r.id}</td><td>${esc(r.report.sources.join(', '))}</td>` +
        `<td>${r.report.affected.length}</td>` +
        `<td class="mono">${sum ? esc(sum.summaryHash) : '（未重算）'}</td></tr>`
      );
    })
    .join('');
  return `
  <section>
    <h2>Revision 历史</h2>
    <table><tr><th>rev</th><th>变化源</th><th>失效数</th><th>摘要哈希</th></tr>${rows}</table>
    <h2>比较索引摘要</h2>
    <div class="row">
      <select id="cmp-a">${opts(compareA)}</select>
      <select id="cmp-b">${opts(compareB)}</select>
    </div>
    <div id="cmp-result">${compareHtml()}</div>
  </section>`;
}

function compareHtml(): string {
  const a = store.data.revisions.find((r) => r.id === compareA)?.summary;
  const b = store.data.revisions.find((r) => r.id === compareB)?.summary;
  if (!a || !b) return '<p class="path">选择两个已重算的 revision 进行比较。</p>';
  const ids = [...new Set([...Object.keys(a.nodes), ...Object.keys(b.nodes)])].sort();
  const rows = ids
    .map((id) => {
      const ha = a.nodes[id];
      const hb = b.nodes[id];
      let cls = 'diff-same';
      let label = '相同';
      if (ha === undefined) { cls = 'diff-added'; label = '新增'; }
      else if (hb === undefined) { cls = 'diff-removed'; label = '移除'; }
      else if (ha !== hb) { cls = 'diff-changed'; label = '变化'; }
      return `<tr><td>${esc(id)}</td><td class="mono">${esc(ha ?? '-')}</td>` +
        `<td class="mono">${esc(hb ?? '-')}</td><td class="${cls}">${label}</td></tr>`;
    })
    .join('');
  return (
    `<p class="path">rev ${a.revision}: ${a.nodeCount} 节点 / ${a.tokenCount} token · ` +
    `rev ${b.revision}: ${b.nodeCount} 节点 / ${b.tokenCount} token</p>` +
    `<table><tr><th>节点</th><th>rev ${a.revision}</th><th>rev ${b.revision}</th><th>状态</th></tr>${rows}</table>`
  );
}

function eventsHtml(): string {
  const evs = store.data.events.slice(-30);
  const lines = evs
    .map((e) => `<div class="ev">#${e.seq} <b>${esc(e.type)}</b> ${esc(e.planId)} ${esc(e.detail)}</div>`)
    .join('');
  const boot = bootLog.map((l) => `<div class="ev"><b>[启动恢复]</b> ${esc(l)}</div>`).join('');
  return `
  <section>
    <h2>执行事件（持久化）</h2>
    <div class="log">${boot}${lines || '<div class="ev">（无事件）</div>'}</div>
  </section>`;
}

function ioHtml(): string {
  return `
  <section>
    <h2>导出 / 导入</h2>
    <button data-act="export">导出状态</button>
    <button data-act="import">从文本框导入</button>
    <textarea id="io-box" rows="6" placeholder="导出的 JSON 或粘贴导入内容"></textarea>
  </section>`;
}

// ---------- 渲染与事件 ----------

function render(): void {
  const revs = store.data.revisions;
  if (compareA === 0 && revs.length > 0) compareA = revs[revs.length - 1].id;
  if (compareB === 0 && revs.length > 0) compareB = revs[revs.length - 1].id;
  document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <header>
    <h1>增量索引模拟器</h1>
    <span class="meta">当前 revision: <b>${store.data.currentRevision}</b></span>
    <span class="meta">解析器: <b>v${store.data.parserVersion}</b></span>
    <span class="meta">节点: <b>${Object.keys(store.data.live).length}</b></span>
  </header>
  <main>
    <div>${editorHtml()}${pendingHtml()}</div>
    <div>
      <section><h2>依赖图（失效传播动画）</h2><div id="graph-wrap">${graphHtml()}</div></section>
      ${reportHtml()}
    </div>
    <div>${plansHtml()}${revisionsHtml()}${eventsHtml()}${ioHtml()}</div>
  </main>`;
  bind();
}

function bind(): void {
  document.querySelectorAll<HTMLElement>('[data-act]').forEach((el) => {
    el.addEventListener('click', () => onAction(el.dataset.act!));
  });
  document.querySelectorAll<HTMLElement>('[data-del-doc]').forEach((el) => {
    el.addEventListener('click', () => {
      const id = el.dataset.delDoc!;
      stage(`删除文档 ${id}（墓碑）`, (cs) => {
        cs.deleteDocs = [...(cs.deleteDocs ?? []), id];
      });
    });
  });
  document.querySelectorAll<HTMLElement>('[data-del-node]').forEach((el) => {
    el.addEventListener('click', () => {
      const id = el.dataset.delNode!;
      stage(`删除节点 ${id}`, (cs) => {
        cs.deleteNodes = [...(cs.deleteNodes ?? []), id];
      });
    });
  });
  document.querySelectorAll<HTMLElement>('[data-run-plan]').forEach((el) => {
    el.addEventListener('click', () => runPlan(el.dataset.runPlan!));
  });
  const cmpA = document.querySelector<HTMLSelectElement>('#cmp-a');
  const cmpB = document.querySelector<HTMLSelectElement>('#cmp-b');
  cmpA?.addEventListener('change', () => { compareA = Number(cmpA.value); render(); });
  cmpB?.addEventListener('change', () => { compareB = Number(cmpB.value); render(); });
}

function onAction(act: string): void {
  if (act === 'stage-doc') {
    const id = readVal('doc-id');
    if (!id) return;
    const path = readVal('doc-path') || `${id}.txt`;
    const content = qs<HTMLTextAreaElement>('#doc-content').value;
    const refs = parseList(readVal('doc-refs'));
    stage(`文档 ${id} @ ${path}${refs.length ? ` 引用 ${refs.join(',')}` : ''}`, (cs) => {
      cs.upsertDocs = { ...cs.upsertDocs, [id]: { path, content, refs } };
    });
  } else if (act === 'stage-tokens') {
    const id = readVal('tok-id');
    const doc = readVal('tok-doc');
    if (!id || !doc) return;
    stage(`token 提取器 ${id} ← ${doc}`, (cs) => {
      cs.upsertTokens = { ...cs.upsertTokens, [id]: { doc } };
    });
  } else if (act === 'stage-view') {
    const id = readVal('view-id');
    if (!id) return;
    const deps = parseList(readVal('view-deps'));
    const sensitivity = qs<HTMLSelectElement>('#view-sens').value as 'content' | 'path';
    const usesParser = qs<HTMLInputElement>('#view-parser').checked;
    stage(`视图 ${id} ← [${deps.join(',')}]（${sensitivity === 'path' ? '路径敏感' : '内容派生'}${usesParser ? '，依赖解析器' : ''}）`, (cs) => {
      cs.upsertViews = { ...cs.upsertViews, [id]: { deps, sensitivity, usesParser } };
    });
  } else if (act === 'stage-parser') {
    const next = store.data.parserVersion + 1;
    stage(`解析器升级到 v${next}`, (cs) => {
      cs.parserVersion = next;
    });
  } else if (act === 'commit') {
    doCommit();
  } else if (act === 'clear-pending') {
    pending = {};
    pendingDesc = [];
    render();
  } else if (act === 'demo') {
    loadDemo();
  } else if (act === 'reset') {
    clearTimers();
    store.import(canonicalStringify(emptyState()));
    pending = {};
    pendingDesc = [];
    lastRevisionId = null;
    compareA = 0;
    compareB = 0;
    render();
  } else if (act === 'export') {
    qs<HTMLTextAreaElement>('#io-box').value = JSON.stringify(JSON.parse(store.export()), null, 2);
  } else if (act === 'import') {
    const text = qs<HTMLTextAreaElement>('#io-box').value;
    try {
      store.import(text);
      lastRevisionId = store.data.currentRevision || null;
      render();
    } catch {
      window.alert('导入失败：内容不是有效的导出 JSON');
    }
  }
}

function doCommit(): void {
  if (pendingDesc.length === 0) return;
  const { revision } = engine.commit(pending);
  pending = {};
  pendingDesc = [];
  lastRevisionId = revision.id;
  compareB = revision.id;
  if (revision.id > 1) compareA = revision.id - 1;
  render();
  animateInvalidation(revision);
}

function runPlan(planId: string): void {
  executor.run(planId, {});
  const plan = store.data.plans.find((p) => p.id === planId)!;
  render();
  animateExecution(plan);
}

function loadDemo(): void {
  engine.commit({
    upsertDocs: {
      A: { path: 'docs/a.txt', content: 'hello world', refs: ['B'] },
      B: { path: 'docs/b.txt', content: 'foo-bar baz' },
    },
    upsertTokens: { T1: { doc: 'A' }, T2: { doc: 'B' } },
    upsertViews: {
      VC: { deps: ['T1', 'T2'], sensitivity: 'content' },
      VP: { deps: ['A'], sensitivity: 'path' },
      VPAR: { deps: ['B'], usesParser: true },
    },
  });
  const rev = store.data.revisions[store.data.revisions.length - 1];
  executor.run(rev.planId, {});
  lastRevisionId = rev.id;
  compareA = rev.id;
  compareB = rev.id;
  render();
  animateExecution(store.data.plans.find((p) => p.id === rev.planId)!);
}

render();
