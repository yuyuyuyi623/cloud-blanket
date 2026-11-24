/**
 * brief.ts 单测 —— 注入短句的选取与"按句读裁"
 *
 * 钉死的是这一条纪律（羽翼 2026-11-22）：
 *   **别硬卡字数，导致读起来不像人。**
 * 所以每个用例都在证明"切出来的仍然是一句完整的话"，而不是"长度 ≤ 40"。
 */

import { describe, expect, it } from 'vitest';
import { pickBrief, softClip } from '../engine/brief.js';
import { BRIEF_CHARS, BRIEF_OVERFLOW_RATIO } from '../engine/config.js';

describe('softClip（按句读裁，不切半句）', () => {
  it('不超长时一个字符都不动', () => {
    const s = '羽翼说不卖女儿了，商品化先搁着。';
    expect(softClip(s, BRIEF_CHARS)).toBe(s);
  });

  it('max 以内有句号：连句号一起留，正好一句话', () => {
    const s = `${'一'.repeat(30)}。${'二'.repeat(30)}`;
    expect(softClip(s, BRIEF_CHARS)).toBe(`${'一'.repeat(30)}。`);
  });

  it('max 以内没有句号、但溢出范围内有：宁可略长也要说完', () => {
    const s = `${'六'.repeat(45)}。${'七'.repeat(20)}`;
    const out = softClip(s, BRIEF_CHARS);
    expect(out).toBe(`${'六'.repeat(45)}。`);
    expect(out.length).toBeGreaterThan(BRIEF_CHARS);
    expect(out.length).toBeLessThanOrEqual(Math.round(BRIEF_CHARS * BRIEF_OVERFLOW_RATIO));
  });

  it('只有逗号：断在逗号前（不带逗号，读着不别扭）', () => {
    const s = `${'四'.repeat(20)}，${'五'.repeat(40)}`;
    expect(softClip(s, BRIEF_CHARS)).toBe('四'.repeat(20));
  });

  it('一个句读都没有：整句原样返回，绝不在半句话处切', () => {
    const s = '三'.repeat(80);
    expect(softClip(s, BRIEF_CHARS)).toBe(s);
  });

  it('句号出现在很靠前的位置：就取那一句，后面不要', () => {
    const s = `好。${'八'.repeat(50)}`;
    expect(softClip(s, BRIEF_CHARS)).toBe('好。');
  });

  it('换行也是强句读（多行文本按行取）', () => {
    const s = `${'九'.repeat(10)}\n${'十'.repeat(50)}`;
    expect(softClip(s, BRIEF_CHARS)).toBe('九'.repeat(10));
  });
});

describe('pickBrief（模型写了就用，没写才回退）', () => {
  it('有 brief 时优先用 brief，不碰 text', () => {
    const text = '羽翼在 2026-10-27 深夜说算了不卖女儿了，把商品化整个搁置，转头去聊时间感和记忆降分辨率。';
    expect(pickBrief({ text, brief: '他说不卖女儿了。' })).toBe('他说不卖女儿了。');
  });

  it('没有 brief 时回退裁 text，且裁出来仍是完整一句', () => {
    const text = `${'一'.repeat(30)}。${'二'.repeat(30)}`;
    expect(pickBrief({ text })).toBe(`${'一'.repeat(30)}。`);
  });

  it('brief 是空串/空白 → 当作没写，回退到 text', () => {
    const text = '他喜欢深夜聊天。';
    expect(pickBrief({ text, brief: '   ' })).toBe(text);
  });

  it('老数据没有 brief 字段也能用（向后兼容）', () => {
    const text = '她叫我羽翼。';
    expect(pickBrief({ text })).toBe(text);
  });
});
