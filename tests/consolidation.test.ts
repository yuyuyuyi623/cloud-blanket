/**
 * consolidation.ts 行为测试（G5 节流 / D1 facts / E3 准入制 / F1 forget / N3 事件互斥 / C2 摘要）
 */
import { describe, expect, it } from 'vitest';
import {
  applyConsolidation,
  applySummary,
  buildConsolidationMessages,
  buildSummaryMessages,
  consolidate,
  consolidateSummary,
  renderRecentConversation,
  shouldConsolidate,
} from '../engine/consolidation.js';
import { parseJsonObject, type LlmClient } from '../engine/deepseek.js';
import { normalizePack, type MemoryPack } from '../engine/pack.js';

function pack(overrides: Partial<MemoryPack> = {}): MemoryPack {
  return normalizePack({
    version: 1,
    persona: { name: '', card: '卡', impression: '旧印象' },
    coreMemories: [{ text: '老核心一', at: '2026-06-01' }],
    memories: [
      { text: '事件甲', at: '2026-07-01' },
      { text: '事件乙', at: '2026-08-01' },
    ],
    facts: [{ text: '旧事实' }],
    summary: '旧摘要',
    diary: [],
    ...overrides,
  });
}

describe('shouldConsolidate（G5：10 轮 + 30 分钟冷却 + in-flight 互斥）', () => {
  const now = new Date('2026-11-22T12:00:00').getTime();
  const recent = new Date('2026-11-22T11:00:00').toISOString(); // 1 小时前 > 30 分钟

  it('不满 10 轮不触发；满 10 轮且过了冷却触发', () => {
    expect(shouldConsolidate({ userRoundsSince: 9, lastAttemptAt: recent, now, inFlight: false })).toBe(false);
    expect(shouldConsolidate({ userRoundsSince: 10, lastAttemptAt: recent, now, inFlight: false })).toBe(true);
  });

  it('30 分钟冷却内不触发；冷却已过触发', () => {
    const justNow = new Date(now - 10 * 60 * 1000).toISOString();
    expect(shouldConsolidate({ userRoundsSince: 10, lastAttemptAt: justNow, now, inFlight: false })).toBe(false);
  });

  it('in-flight 互斥连 force 都拦住', () => {
    expect(shouldConsolidate({ userRoundsSince: 10, lastAttemptAt: null, now, inFlight: true })).toBe(false);
    expect(shouldConsolidate({ userRoundsSince: 10, lastAttemptAt: null, now, inFlight: true, force: true })).toBe(false);
  });

  it('force 跳过轮数与冷却，但不动 in-flight', () => {
    const justNow = new Date(now - 60 * 1000).toISOString();
    expect(shouldConsolidate({ userRoundsSince: 1, lastAttemptAt: justNow, now, inFlight: false, force: true })).toBe(true);
  });
});

describe('buildConsolidationMessages', () => {
  it('手动记住通道必须作为输入喂回（清单十·2，否则会被吞）', () => {
    const msgs = buildConsolidationMessages(pack(), ['请记住我养了猫'], []);
    const user = msgs[1]!.content;
    expect(user).toContain('请记住我养了猫');
  });

  it('现有核心/事件/facts/摘要都进输入，供模型筛选', () => {
    const msgs = buildConsolidationMessages(pack(), [], [
      { role: 'user', text: '我今天加班', at: '2026-11-22T10:00:00' },
      { role: 'assistant', text: '辛苦了' },
    ]);
    const user = msgs[1]!.content;
    expect(user).toContain('老核心一');
    expect(user).toContain('事件甲');
    expect(user).toContain('旧事实');
    expect(user).toContain('旧印象');
    expect(user).toContain('2026-11-22 10:00');
    expect(user).toContain('对方：我今天加班');
    expect(user).toContain('你：辛苦了');
  });

  it('H1 红线：整合提示词不含示范句式（比如/例如/例：/你可以）', () => {
    const msgs = buildConsolidationMessages(pack(), [], []);
    for (const m of msgs) {
      expect(m.content).not.toMatch(/比如|例如|例[:：]|你可以/);
    }
  });
});

describe('applyConsolidation（照 index.mjs:5560-5600 顺序）', () => {
  it('facts：模型合并去重后整体替换；没给数组则保留旧的', () => {
    const r1 = applyConsolidation(pack(), { facts: ['事实A', '事实A', '事实B'] });
    expect(r1.pack.facts.map((f) => f.text)).toEqual(['事实A', '事实B']);
    const r2 = applyConsolidation(pack(), { memories: [] }); // 没给 facts
    expect(r2.pack.facts.map((f) => f.text)).toEqual(['旧事实']);
  });

  it('新事件最多 5 条，时间记 now；老事件保留原时间', () => {
    const now = new Date('2026-11-22T12:00:00');
    const newMemories = Array.from({ length: 7 }, (_, i) => `新事件${i}`);
    const r = applyConsolidation(pack(), { memories: newMemories }, now);
    expect(r.pack.memories).toHaveLength(7); // 2 老 + 5 新
    expect(r.newEpisodeCount).toBe(5);
    const added = r.pack.memories.find((m) => m.text === '新事件0');
    expect(added?.at).toBe(now.toISOString());
    const old = r.pack.memories.find((m) => m.text === '事件甲');
    expect(old?.at).toBe('2026-07-01');
  });

  it('forget：全等匹配只删 episodes，最多 6 条；facts 与 core 不受影响', () => {
    const r = applyConsolidation(pack(), {
      forget: ['事件甲', '事件甲的变体（不在列表里）', '老核心一', '旧事实'],
    });
    expect(r.pack.memories.map((m) => m.text)).toEqual(['事件乙']);
    expect(r.forgotten).toEqual(['事件甲']);
    expect(r.pack.facts.map((f) => f.text)).toEqual(['旧事实']);
    expect(r.pack.coreMemories.map((c) => c.text)).toEqual(['老核心一']);
  });

  it('E3 准入制：新条目与被换掉的老核心 Jaccard > 0.45 → 拒绝替换、老核心保留', () => {
    // "老核心一" 3 个字符；构造高重叠的新条目
    const r = applyConsolidation(pack(), {
      coreMemories: ['老核心一题', '完全不同的新事'],
    });
    expect(r.pack.coreMemories.some((c) => c.text === '老核心一')).toBe(true);
    expect(r.rejectedOverwrites).toContain('老核心一');
  });

  it('E3：低相似的新条目正常替换', () => {
    const r = applyConsolidation(pack(), {
      coreMemories: ['完全不同的新事'],
    });
    expect(r.pack.coreMemories.map((c) => c.text)).toEqual(['完全不同的新事']);
    expect(r.rejectedOverwrites).toHaveLength(0);
  });

  it('老核心沿用原时间，新核心记 now；上限 5 由 normalize 锁死', () => {
    const now = new Date('2026-11-22T12:00:00');
    const r = applyConsolidation(
      pack({
        coreMemories: [
          { text: '核心1', at: '2026-01-01' },
          { text: '核心2', at: '2026-02-01' },
          { text: '核心3', at: '2026-03-01' },
          { text: '核心4', at: '2026-04-01' },
          { text: '核心5', at: '2026-05-01' },
        ],
      }),
      { coreMemories: ['核心1', '新核心A', '新核心B'] },
      now,
    );
    expect(r.pack.coreMemories.find((c) => c.text === '核心1')?.at).toBe('2026-01-01');
    expect(r.pack.coreMemories.find((c) => c.text === '新核心A')?.at).toBe(now.toISOString());
  });

  it('N3 互斥：进了核心的条目从事件层剔除', () => {
    const r = applyConsolidation(pack(), {
      coreMemories: ['事件甲', '老核心一'],
    });
    expect(r.pack.coreMemories.map((c) => c.text)).toContain('事件甲');
    expect(r.pack.memories.map((m) => m.text)).not.toContain('事件甲');
  });

  it('impression：≤80 字截断，没给就保留旧的', () => {
    const long = '很'.repeat(100);
    const r1 = applyConsolidation(pack(), { impression: long });
    expect(r1.pack.persona.impression).toHaveLength(80);
    const r2 = applyConsolidation(pack(), {});
    expect(r2.pack.persona.impression).toBe('旧印象');
  });
});

describe('consolidate（一次调用封装，假 client）', () => {
  it('显式 maxTokens=4000 / temperature=0.1 / purpose=profile；输出 JSON 落进 pack', async () => {
    let captured: { maxTokens?: number; temperature?: number; purpose?: string } = {};
    const client: LlmClient = {
      async chat(_messages, options) {
        captured = options;
        return {
          content: JSON.stringify({
            coreMemories: ['老核心一', '新核心'],
            memories: ['那天他加班到凌晨'],
            facts: ['他养猫'],
            impression: '他挺累但嘴硬',
            forget: ['事件乙'],
          }),
          finishReason: 'stop',
        };
      },
    };
    const r = await consolidate(client, pack(), [], [
      { role: 'user', text: '加班', at: null },
    ]);
    expect(captured).toMatchObject({ maxTokens: 4000, temperature: 0.1, purpose: 'profile' });
    expect(r.pack.facts.map((f) => f.text)).toEqual(['他养猫']);
    expect(r.pack.memories.map((m) => m.text)).toContain('那天他加班到凌晨');
    expect(r.pack.memories.map((m) => m.text)).not.toContain('事件乙');
  });
});

describe('滚动摘要（C2/C3）', () => {
  it('摘要提示词带安全排除项与字数上限', () => {
    const msgs = buildSummaryMessages('旧摘要内容', '新增对话内容');
    expect(msgs[0]!.content).toContain('密码、密钥、账号、金融账户、精确住址');
    expect(msgs[0]!.content).toContain('2000');
    expect(msgs[1]!.content).toContain('旧摘要内容');
    expect(msgs[1]!.content).toContain('新增对话内容');
  });

  it('落库截 2000 字', () => {
    const next = applySummary(pack(), '很'.repeat(3000));
    expect(next.summary).toHaveLength(2000);
  });

  it('consolidateSummary 走假 client：temperature 0.2 / maxTokens 4000 / purpose summary', async () => {
    let captured: { maxTokens?: number; temperature?: number; purpose?: string } = {};
    const client: LlmClient = {
      async chat(_messages, options) {
        captured = options;
        return { content: '新摘要', finishReason: 'stop', promptTokens: 1, completionTokens: 1 };
      },
    };
    const next = await consolidateSummary(client, pack(), '新对话');
    expect(captured).toMatchObject({ maxTokens: 4000, temperature: 0.2, purpose: 'summary' });
    expect(next.summary).toBe('新摘要');
  });
});

// 防止未使用 import 报错
void parseJsonObject;
void renderRecentConversation;
