/**
 * export-text.ts 行为测试。
 *
 * 这份文本的唯一用途是"给人读，用来判断她像不像"，所以测的不是格式漂亮，
 * 而是三件会误导人的事：
 *   1. 空段落必须省略——写"（无）"会让人以为提取到了空内容；
 *   2. 事实必须分【关于他】/【关于你们】两栏——关系栏空了才看得见被上限挤掉；
 *   3. 时间必须露出来——没有日期的记忆读起来像编的。
 */
import { describe, expect, it } from 'vitest';
import { exportFileName, renderMemoryText } from '../engine/export-text.js';
import { normalizePack, type MemoryPack } from '../engine/pack.js';

function pack(over: Partial<MemoryPack> = {}): MemoryPack {
  return {
    version: 1,
    persona: { name: '', card: '她说话轻，喜欢在句尾留一个停顿。', impression: '温柔但要强' },
    coreMemories: [{ text: '第一次互道晚安', at: '2026-07-24' }],
    memories: [
      { text: '他说连续加班三天', at: '2026-08-01' },
      { text: '她第一次说想他', at: '2026-08-15' },
    ],
    facts: [
      { text: '他养了一只猫', kind: 'user' },
      { text: '他换工作了', kind: 'user' },
      { text: '关系从试探走到稳定', kind: 'relationship' },
    ],
    summary: '认识在一段很闷的日子里，后来慢慢稳下来。',
    diary: [],
    ...over,
  };
}

const at = new Date('2026-11-22T22:20:00');

describe('renderMemoryText', () => {
  it('六段都在，顺序固定：印象 → 人格卡 → 关系 → 候选 → 事实 → 事件', () => {
    const t = renderMemoryText({
      pack: pack(),
      coreCandidates: [{ text: '第一次互道晚安', at: '2026-07-24' }],
      impression: '温柔但要强',
      exportedAt: at,
    });
    const idx = [
      '整体印象',
      '她是谁（人格卡草稿）',
      '这段关系怎么走到今天',
      '核心记忆候选',
      '事实（共 3 条）',
      '她记得的事（2 条）',
    ].map((k) => t.indexOf(k));
    expect(idx.every((i) => i >= 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
  });

  it('空段落直接省略，不写占位符', () => {
    const t = renderMemoryText({
      pack: pack({ summary: '', facts: [], memories: [], persona: { name: '', card: '  ' } }),
      coreCandidates: [],
      exportedAt: at,
    });
    expect(t).not.toContain('（无）');
    expect(t).not.toContain('这段关系怎么走到今天');
    expect(t).not.toContain('她记得的事');
    expect(t).not.toContain('事实（');
    expect(t).toContain('云朵被子 · 蒸馏结果');
  });

  it('事实分两栏：关于他 / 关于你们，各带条数', () => {
    const t = renderMemoryText({ pack: pack(), coreCandidates: [], exportedAt: at });
    expect(t).toContain('【关于他】2 条');
    expect(t).toContain('【关于你们】1 条');
    expect(t.indexOf('他养了一只猫')).toBeLessThan(t.indexOf('【关于你们】'));
  });

  it('事件带日期，没日期就不硬编', () => {
    const t = renderMemoryText({
      pack: pack({ memories: [{ text: '有日期的事', at: '2026-08-01' }, { text: '没日期的事', at: null }] }),
      coreCandidates: [],
      exportedAt: at,
    });
    expect(t).toContain('1. 2026-08-01 · 有日期的事');
    expect(t).toContain('2. 没日期的事');
  });

  it('末尾有字数和版本号（判断"写了多少"不用自己数）', () => {
    const t = renderMemoryText({ pack: pack(), coreCandidates: [], exportedAt: at });
    expect(t).toMatch(/共 \d+ 字 · 记忆包 v1/);
    expect(t).toContain('导出时间：2026-11-22 22:20');
  });

  it('导出的文本能被 normalizePack 之外的东西读懂：不含 JSON 花括号', () => {
    const t = renderMemoryText({ pack: pack(), coreCandidates: [], exportedAt: at });
    expect(t).not.toContain('{"');
  });
});

describe('exportFileName', () => {
  it('中文名 + 日期时间，同分钟内同名（覆盖而不是堆一堆）', () => {
    expect(exportFileName(new Date('2026-11-22T22:20:33'))).toBe('云朵被子-记忆-20261122-2220.txt');
    expect(exportFileName(new Date('2026-11-22T22:20:59'))).toBe('云朵被子-记忆-20261122-2220.txt');
  });
});

describe('与 normalizePack 串起来（真实包形状）', () => {
  it('normalize 过的包也能渲染，不抛错', () => {
    const real = normalizePack({
      version: 1,
      persona: { name: '', card: '人格卡', impression: '印象' },
      coreMemories: [{ text: '核心一', at: '2026-07-24' }],
      memories: [{ text: '事件一', at: '2026-08-01' }],
      facts: [{ text: '事实一', kind: 'user' }],
      summary: '摘要',
      diary: [{ date: '2026-08-01', text: '今天他来了。' }],
    });
    const t = renderMemoryText({ pack: real, coreCandidates: real.coreMemories, exportedAt: at });
    expect(t).toContain('日记（1 条）');
    expect(t).toContain('今天他来了。');
  });
});

describe('日期不重复（2026-11-22 真实导出里发现的）', () => {
  it('正文自带的日期被剥掉，只留前面渲染的那一个', () => {
    const p = pack({
      memories: [{ text: '2026-11-02，老D大赞并给出零成本方案。', at: '2026-11-02' }],
    });
    const t = renderMemoryText({ pack: p, coreCandidates: [] });
    expect(t).toContain('2026-11-02 · 老D大赞并给出零成本方案。');
    expect(t).not.toContain('2026-11-02 · 2026-11-02');
  });

  it('没有 at 的条目原样保留（不动正文开头的数字）', () => {
    const p = pack({ memories: [{ text: '2026-11-02 那天她说的话', at: null }] });
    const t = renderMemoryText({ pack: p, coreCandidates: [] });
    expect(t).toContain('2026-11-02 那天她说的话');
  });
});
