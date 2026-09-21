// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '<div id="app"></div>';
});

describe('网页 UI 冒烟', () => {
  it('挂载后显示标题、编辑器、动画与比较面板', async () => {
    await import('../src/web/main.ts');
    const body = document.body.textContent ?? '';
    expect(body).toContain('增量索引模拟器');
    expect(body).toContain('编辑文档与引用');
    expect(body).toContain('提交批量变更集');
    expect(body).toContain('失效传播动画');
    expect(body).toContain('比较两个 revision 的索引摘要');
    expect(document.querySelector('#submit-rev')).not.toBeNull();
    expect(document.querySelector('#graph-canvas')).not.toBeNull();
    expect(document.querySelector('#play-anim')).not.toBeNull();
  });
});
