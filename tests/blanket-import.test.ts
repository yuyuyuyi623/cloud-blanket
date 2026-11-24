import { describe, expect, it } from 'vitest';
import type { ParsedSession } from '../engine/parse.js';
import {
  buildBlocks,
  buildPlan,
  parsedToSession,
} from '../src/services/memory/importBlanket.js';

/** 造一个导出格式的会话；words 按正文长度算，与 engine 口径一致 */
const parsed = (
  id: string,
  title: string,
  messages: { role: 'user' | 'assistant'; text: string; at?: string }[],
  firstAt = '2025-03-01T10:00:00Z'
): ParsedSession => ({
  id,
  title,
  pinned: false,
  firstAt,
  lastAt: '2025-03-02T10:00:00Z',
  days: 2,
  words: messages.reduce((sum, m) => sum + m.text.length, 0),
  userTurns: messages.filter((m) => m.role === 'user').length,
  totalMessages: messages.length,
  messages: messages.map((m) => ({
    role: m.role,
    text: m.text,
    at: m.at ?? firstAt,
    unfinished: '',
  })),
  stats: { thinkCount: 0, thinkWords: 0, fileCount: 0, unfinished: 0, emptyMessages: 0 },
});

describe('buildPlan', () => {
  it('一个会话一行，字数与块数对得上', () => {
    const sessions = [
      parsed('s1', '吃火锅', [{ role: 'user', text: '昨晚吃了火锅' }]),
      parsed('s2', '看海', [{ role: 'user', text: '我们说好去看海' }]),
    ];
    const { rows, estimate } = buildPlan(sessions);
    expect(rows.map((row) => row.sessionId)).toEqual(['s1', 's2']);
    expect(rows.map((row) => row.title)).toEqual(['吃火锅', '看海']);
    // 短会话各自 1 块
    expect(rows.every((row) => row.blocks === 1)).toBe(true);
    expect(estimate.totalSessions).toBe(2);
    expect(estimate.totalBlocks).toBe(2);
    expect(estimate.costCny).toBeGreaterThan(0);
    expect(estimate.minutes).toBeGreaterThan(0);
  });

  it('没勾任何会话时估算是零，不报错', () => {
    const { rows, estimate } = buildPlan([]);
    expect(rows).toEqual([]);
    expect(estimate.totalBlocks).toBe(0);
    expect(estimate.costCny).toBe(0);
  });

  it('字越多越贵：2 万字会话的估价高于 2 千字会话', () => {
    const long = buildPlan([parsed('long', '长', [{ role: 'user', text: '啊'.repeat(20_000) }])]);
    const short = buildPlan([parsed('short', '短', [{ role: 'user', text: '啊'.repeat(2_000) }])]);
    // 2 万字刚好是一块的上限，块数可能相同；钱按字数算，必须拉开
    expect(long.estimate.totalBlocks).toBeGreaterThanOrEqual(short.estimate.totalBlocks);
    expect(long.estimate.costCny).toBeGreaterThan(short.estimate.costCny);
  });
});

describe('buildBlocks', () => {
  it('按会话顺序拼块，块号连续，正文带说话人与日期', () => {
    const sessions = [
      parsed('s1', '一', [
        { role: 'user', text: '昨晚吃了火锅', at: '2025-03-01T10:00:00Z' },
        { role: 'assistant', text: '那家店的锅底很辣', at: '2025-03-01T10:01:00Z' },
      ]),
      parsed('s2', '二', [{ role: 'user', text: '我们说好去看海' }]),
    ];
    const blocks = buildBlocks(sessions);
    expect(blocks.map((block) => block.blockIndex)).toEqual([0, 1]);
    expect(blocks[0]!.text).toContain('你（2025-03-01）：昨晚吃了火锅');
    expect(blocks[0]!.text).toContain('她（2025-03-01）：那家店的锅底很辣');
    expect(blocks[1]!.text).toContain('我们说好去看海');
    expect(blocks[0]!.firstAt).toBe('2025-03-01T10:00:00Z');
  });

  it('超长会话会被切块，块数大于 1 且内容不丢', () => {
    // 每条约 1.2 万字，两条超过 2 万字/块的上限
    const long = '啊'.repeat(12_000);
    const blocks = buildBlocks([
      parsed('s1', '长', [
        { role: 'user', text: long },
        { role: 'assistant', text: long },
      ]),
    ]);
    expect(blocks.length).toBeGreaterThan(1);
    const joined = blocks.map((block) => block.text).join('');
    expect(joined.match(/啊/g)?.length).toBe(24_000);
  });

  it('没有会话时返回空数组（由调用方决定怎么报错）', () => {
    expect(buildBlocks([])).toEqual([]);
  });
});

describe('parsedToSession', () => {
  it('用户消息取正文，助手消息落成文本块，时间解析成毫秒', () => {
    const session = parsedToSession(
      parsed('s1', '吃火锅', [
        { role: 'user', text: '昨晚吃了火锅', at: '2025-03-01T10:00:00Z' },
        { role: 'assistant', text: '锅底很辣', at: '2025-03-01T10:01:00Z' },
      ])
    );
    expect(session.id).toBe('s1');
    expect(session.title).toBe('吃火锅');
    expect(session.createdAt).toBe(Date.parse('2025-03-01T10:00:00Z'));
    expect(session.messages).toHaveLength(2);
    const [user, assistant] = session.messages;
    expect(user!.role).toBe('user');
    expect(user!.role === 'user' && user!.content).toBe('昨晚吃了火锅');
    expect(assistant!.role).toBe('assistant');
    expect(assistant!.role === 'assistant' && assistant!.blocks).toEqual([
      { type: 'text', text: '锅底很辣' },
    ]);
    // 助手消息的完成状态：导入的历史不该显示成"正在生成"
    expect(assistant!.role === 'assistant' && assistant!.status).toBe('done');
  });

  it('没有标题的会话给兜底名，不出现空标题', () => {
    const session = parsedToSession(parsed('s1', '  ', [{ role: 'user', text: '在吗' }]));
    expect(session.title).toBe('未命名对话');
  });

  it('消息 id 稳定且不重复（同一会话重建结果一致）', () => {
    const source = parsed('s1', '一', [
      { role: 'user', text: '一句' },
      { role: 'user', text: '两句' },
    ]);
    const a = parsedToSession(source);
    const b = parsedToSession(source);
    expect(a.messages.map((m) => m.id)).toEqual(b.messages.map((m) => m.id));
    expect(new Set(a.messages.map((m) => m.id)).size).toBe(2);
  });
});
