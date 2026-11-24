/**
 * context.ts 行为测试（两段式位置 P0、滑窗裁剪、动态段配额）
 */
import { describe, expect, it } from 'vitest';
import {
  assembleMessages,
  assertTwoSegmentShape,
  buildDynamicSegment,
  buildStableSegment,
  historyToMessages,
  limitConversationHistory,
  relativeDay,
  type HistoryLine,
} from '../engine/context.js';
import { SEARCH_MAX_RESULTS } from '../engine/config.js';
import { normalizePack, type MemoryPack } from '../engine/pack.js';
import type { SearchResult } from '../engine/fts.js';

function pack(overrides: Partial<MemoryPack> = {}): MemoryPack {
  return normalizePack({
    version: 1,
    persona: { name: '测试', card: '人格卡内容', impression: '整体印象一句' },
    coreMemories: [{ text: '核心记忆一', at: '2026-01-12' }],
    memories: [{ text: '事件一', at: '2026-11-20' }],
    facts: [{ text: '事实一' }],
    summary: '阶段摘要内容',
    diary: [],
    ...overrides,
  });
}

function history(n: number, startRole: 'user' | 'assistant' = 'user'): HistoryLine[] {
  const lines: HistoryLine[] = [];
  let role = startRole;
  for (let i = 0; i < n; i++) {
    lines.push({ role, text: `消息${i}` });
    role = role === 'user' ? 'assistant' : 'user';
  }
  return lines;
}

describe('buildStableSegment（清单十·1 拼接顺序）', () => {
  it('顺序：persona → core → 事件 → 手动 → facts → impression → 摘要', () => {
    const s = buildStableSegment(pack(), ['手动记住的一条']);
    const pos = (marker: string) => s.indexOf(marker);
    const order = ['【你是谁】', '【你最珍视的记忆', '【你记得你们之间发生过的事', '【对方明确请你记住的事', '【你慢慢形成的长期印象', '整体感觉：', '【你们共同经历的阶段摘要'];
    const positions = order.map(pos);
    expect(positions).toEqual([...positions]!.sort((a, b) => a - b));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect(s).toContain('手动记住的一条');
  });

  it('事件与事实注入用 brief（一句话），全文留在库里给导出和检索', () => {
    const longText = '羽翼在深夜说算了不卖女儿了，把商品化整个搁置，转头去聊时间感和记忆降分辨率这些核心问题。';
    const s = buildStableSegment(
      pack({
        memories: [{ text: longText, at: '2026-10-27', brief: '他说不卖女儿了。' }],
        facts: [{ text: longText, brief: '他不想把柔光当商品。' }],
      }),
    );
    expect(s).toContain('他说不卖女儿了。');
    expect(s).toContain('他不想把柔光当商品。');
    expect(s).not.toContain(longText);
  });

  it('缺的层整段不出现（不留空标题）', () => {    const s = buildStableSegment(
      pack({
        coreMemories: [],
        memories: [],
        facts: [],
        summary: '',
        persona: { name: '', card: '只有卡' },
      }),
    );
    expect(s).not.toContain('【你最珍视的记忆');
    expect(s).not.toContain('【你慢慢形成的长期印象');
    expect(s).toContain('【你是谁】');
  });
});

describe('buildDynamicSegment（R2 配额）', () => {
  const results: SearchResult[] = Array.from({ length: 20 }, (_, i) => ({
    sessionId: 's1',
    messageIndex: i,
    text: `旧消息${'x'.repeat(80)}`,
    at: '2026-11-01T00:00:00Z',
    score: 20 - i,
  }));

  it('最多 8 条（SEARCH_MAX_RESULTS）', () => {
    const s = buildDynamicSegment(results);
    expect(s.split('\n- ').length - 1).toBeLessThanOrEqual(SEARCH_MAX_RESULTS);
  });

  it('总字数硬上限 1200', () => {
    const s = buildDynamicSegment(results);
    const body = s.split('\n').filter((l) => l.startsWith('- ')).join('');
    expect(body.length).toBeLessThanOrEqual(1200);
  });

  it('无结果给占位（动态段永远存在，位置不变）', () => {
    expect(buildDynamicSegment([])).toContain('没有想起');
  });
});

describe('relativeDay（N2 时间感）', () => {
  const now = new Date('2026-11-22T12:00:00');
  it('今天/昨天/前天/前几天/更早', () => {
    expect(relativeDay('2026-11-22T08:00:00', now)).toBe('今天');
    expect(relativeDay('2026-11-21T08:00:00', now)).toBe('昨天');
    expect(relativeDay('2026-11-20T08:00:00', now)).toBe('前天');
    expect(relativeDay('2026-11-18T08:00:00', now)).toBe('前几天');
    expect(relativeDay('2026-11-01T08:00:00', now)).toBe('更早');
    expect(relativeDay(null, now)).toBe('更早');
    expect(relativeDay('不是时间', now)).toBe('更早');
  });
});

describe('limitConversationHistory（B1/B2 + 十·4）', () => {
  it('保留开头稳定段与末尾动态段，中间按 10 轮截', () => {
    // 24 条历史 = 12 轮 user 发言（user 开头）
    const msgs = [
      { role: 'system' as const, content: '稳定段' },
      ...historyToMessages(history(24)),
      { role: 'system' as const, content: '动态段' },
    ];
    const out = limitConversationHistory(msgs);
    expect(out[0]!.content).toBe('稳定段');
    expect(out[out.length - 1]!.content).toBe('动态段');
    // 10 轮 = 10 条 user + 10 条 assistant = 20 条 + 首尾
    expect(out.length).toBe(22);
    // 从"消息4"开始（第 3 轮 user 是 消息4？user 轮在偶数位）
    expect(out[1]!.content).toBe('消息4');
  });

  it('历史不足 10 轮时全保留', () => {
    const msgs = [
      { role: 'system' as const, content: '稳定段' },
      ...historyToMessages(history(6)),
      { role: 'system' as const, content: '动态段' },
    ];
    expect(limitConversationHistory(msgs).length).toBe(8);
  });

  it('兜底：正文数不出任何 user 发言时取 rounds*2 条', () => {
    const body = history(30, 'assistant').map((l) => ({ ...l, role: 'assistant' as const }));
    const msgs = [
      { role: 'system' as const, content: '稳定段' },
      ...historyToMessages(body),
      { role: 'system' as const, content: '动态段' },
    ];
    const out = limitConversationHistory(msgs);
    expect(out.length).toBe(22); // 20 + 首尾
    expect(out[1]!.content).toBe('消息10');
  });
});

describe('assembleMessages + P0 断言（H2）', () => {
  it('无历史时合成单条 system（十·4）', () => {
    const msgs = assembleMessages({ stable: '稳定', dynamic: '动态', history: [] });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.role).toBe('system');
    expect(msgs[0]!.content).toBe('稳定\n\n动态');
  });

  it('有历史时 [稳定, …历史, 动态]，动态段是最后一条', () => {
    const msgs = assembleMessages({
      stable: '稳定',
      dynamic: '动态',
      history: historyToMessages(history(4)),
    });
    expect(msgs[0]!.content).toBe('稳定');
    expect(msgs[msgs.length - 1]!.content).toBe('动态');
    expect(msgs[msgs.length - 1]!.role).toBe('system');
    expect(msgs).toHaveLength(6);
  });

  it('P0 断言：历史中间夹 system 直接抛', () => {
    expect(() =>
      assertTwoSegmentShape([
        { role: 'system', content: '稳定' },
        { role: 'system', content: '中间混进来的' },
        { role: 'user', content: 'u' },
        { role: 'system', content: '动态' },
      ]),
    ).toThrowError(/P0/);
    expect(() =>
      assertTwoSegmentShape([
        { role: 'system', content: '稳定' },
        { role: 'user', content: 'u' },
        { role: 'assistant', content: 'a' },
      ]),
    ).toThrowError(/P0/);
    expect(() =>
      assertTwoSegmentShape([
        { role: 'system', content: '稳定' },
        { role: 'user', content: 'u' },
        { role: 'system', content: '动态' },
      ]),
    ).not.toThrow();
  });
});
