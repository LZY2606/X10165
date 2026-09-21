// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

describe('UI 冒烟', () => {
  it('渲染标题，完成示例加载、变更提交与重算流程', async () => {
    document.body.innerHTML = '<div id="app"></div>';
    window.localStorage.clear();
    await import('../src/ui/main');

    // 标题
    expect(document.querySelector('h1')!.textContent).toBe('增量索引模拟器');

    // 加载示例：自动提交并运行重算
    click('demo');
    expect(document.body.textContent).toContain('失效报告');
    expect(document.body.textContent).toContain('revision 1');
    expect(document.body.textContent).toContain('completed');

    // 暂存一次改名（内容不变）并提交
    setVal('doc-id', 'A');
    setVal('doc-path', 'docs/renamed.txt');
    setVal('doc-content', 'hello world');
    setVal('doc-refs', 'B');
    click('stage-doc');
    expect(document.body.textContent).toContain('待提交变更集（1）');
    click('commit');

    // 失效报告：路径敏感视图 VP 失效，内容派生 VC 可复用
    const report = document.body.textContent!;
    expect(report).toContain('VP');
    expect(document.querySelector('#anim-log')).toBeTruthy();
    const reuseSection = document.body.textContent!;
    expect(reuseSection).toContain('可复用项');

    // 运行最新计划
    const runBtn = document.querySelector<HTMLButtonElement>('[data-run-plan]:not([disabled])')!;
    runBtn.click();
    expect(document.body.textContent).toContain('completed');

    // revision 比较区域存在两个 revision
    const options = document.querySelectorAll('#cmp-a option');
    expect(options.length).toBe(2);

    // 导出 → 重置 → 导入，状态一致
    click('export');
    const exported = (document.querySelector<HTMLTextAreaElement>('#io-box')!).value;
    expect(exported).toContain('"revisions"');
    click('reset');
    expect(document.body.textContent).toContain('当前 revision: 0');
    (document.querySelector<HTMLTextAreaElement>('#io-box')!).value = exported;
    click('import');
    expect(document.body.textContent).toContain('当前 revision: 2');
  });
});

function click(act: string): void {
  const el = document.querySelector<HTMLButtonElement>(`[data-act="${act}"]`);
  if (!el) throw new Error(`button ${act} not found`);
  el.click();
}

function setVal(id: string, value: string): void {
  const el = document.querySelector<HTMLInputElement>(`#${id}`);
  if (!el) throw new Error(`input ${id} not found`);
  el.value = value;
}
