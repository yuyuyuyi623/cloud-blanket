/**
 * 上下文预算护栏（文档《统一上下文预算方案》§10，2026-11-22 羽翼拍板 7000）
 *
 * 这个文件只锁一个东西：**记忆长满那天，稳定段还装得下**。
 * 稳定段一旦超预算，能动的只有两条路——砍记忆或砍轮次，都违背 K3/K11，
 * 所以必须在这里先看见，而不是等用户聊了三个月才发现账单和记忆一起出问题。
 *
 * 数字全部按"容量上限打满"构造，不按当前那份真实记忆包（那份还没长满，测不出边界）。
 */

import { describe, expect, it } from 'vitest';
import { buildStableSegment, buildDynamicSegment, limitConversationHistory } from '../engine/context.js';
import { TOKENS_PER_CHAR, CONTEXT_BUDGET_TOKENS } from '../engine/config.js';
import {
  PERSONA_MAX_CHARS,
  CORE_MEMORY_CHARS,
  CORE_MEMORY_LIMIT,
  EPISODES_CHARS,
  EPISODES_LIMIT,
  FACTS_CHARS,
  FACTS_LIMIT,
  IMPRESSION_CHARS,
  SUMMARY_MAX_CHARS,
  BRIEF_CHARS,
  MAX_HISTORY_ROUNDS,
  SEARCH_MAX_RESULTS,
} from '../engine/config.js';
import type { MemoryPack } from '../engine/pack.js';

/** 造一段正好 n 字、带中文标点的文本（模拟真实记忆，不是一串重复字符） */
function fill(n: number, seed: string): string {
  let s = '';
  let i = 0;
  while (s.length < n) {
    s += `${seed}第${i}句，这件事他一直记着。`;
    i += 1;
  }
  return s.slice(0, n);
}

const tokens = (s: string) => Math.round(s.length * TOKENS_PER_CHAR);

/** 容量打满的记忆包：每条都顶到存储上限，brief 也顶到 40 字 */
function fullPack(): MemoryPack {
  return {
    version: 1,
    persona: {
      name: '老D',
      card: fill(PERSONA_MAX_CHARS, '她是个毒舌审核员'),
      impression: fill(IMPRESSION_CHARS, '护短'),
    },
    coreMemories: Array.from({ length: CORE_MEMORY_LIMIT }, (_, i) => ({
      text: fill(CORE_MEMORY_CHARS, `核心${i}`),
      at: '2026-10-27',
    })),
    memories: Array.from({ length: EPISODES_LIMIT }, (_, i) => ({
      text: fill(EPISODES_CHARS, `事件${i}的原文`),
      brief: fill(BRIEF_CHARS, `事件${i}`),
      at: '2026-11-03',
    })),
    facts: Array.from({ length: FACTS_LIMIT }, (_, i) => ({
      text: fill(FACTS_CHARS, `事实${i}`),
      brief: fill(BRIEF_CHARS, `事实${i}`),
      kind: i % 2 ? ('user' as const) : ('relationship' as const),
    })),
    summary: fill(SUMMARY_MAX_CHARS, '阶段摘要'),
    diary: [],
  };
}

/** 检索结果（fts 只用到 text/at，其余字段给占位以满足类型） */
function fakeFts(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    sessionId: 's1',
    messageIndex: i,
    text: fill(120, `旧消息${i}`),
    at: '2026-10-30',
    score: 1,
  }));
}

/** 手动记住：接口没定上限，按"用户可能随手记 5 条 80 字"估 */
const MANUAL = Array.from({ length: 5 }, (_, i) => fill(80, `手动${i}`));

function historyMessages(count: number, charsPerMsg = 70) {
  return Array.from({ length: count }, (_, i) => ({
    role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant',
    content: fill(charsPerMsg, `第${i}条`),
  }));
}

describe('上下文预算（8000）', () => {
  const stable = buildStableSegment(fullPack(), MANUAL);
  const stableTokens = tokens(stable);

  it('稳定段打满之后，仍留得出「最近 4 轮 + 检索 3 条」的余量', () => {
    // 2026-11-25 A3（事件 30→60）后满容量实测 6537 / 8000 = 81.7%：
    // 八成那条线已经守不住了（事件层扩容是拍板要的），但"最少还能聊上几句"必须守住。
    const reserveHistory = historyMessages(4);
    const reserve = tokens([
      ...reserveHistory.map((m) => m.content),
      buildDynamicSegment(fakeFts(3)),
    ].join('\n'));
    expect(stableTokens).toBeLessThanOrEqual(CONTEXT_BUDGET_TOKENS - reserve);
    // 逐项变动的护栏：persona/摘要/事件条数再往上调，会先在这里撞墙
    expect(stableTokens).toBeLessThanOrEqual(Math.floor(CONTEXT_BUDGET_TOKENS * 0.85));
  });

  it('稳定段 + 最近 8 轮 + 检索 3 条，装得进预算', () => {
    const history = limitConversationHistory(
      [{ role: 'system', content: stable }, ...historyMessages(MAX_HISTORY_ROUNDS * 2)],
      8,
    ).slice(1);
    const fts = fakeFts(3);
    const total =
      stableTokens +
      tokens(history.map((m) => m.content).join('\n')) +
      tokens(buildDynamicSegment(fts));
    expect(total).toBeLessThanOrEqual(CONTEXT_BUDGET_TOKENS);
  });

  it('检索 8 条全装会超：SEARCH_MAX_RESULTS 是上限，不是每轮配额', () => {
    // 这条不是"目标"，是"知识"：稳定段 6537 + 10 轮 993 + 8 条 832 = 8362 > 8000。
    // 执行器必须按剩余空间决定装几条，别照着 SEARCH_MAX_RESULTS 硬塞。
    const fts = fakeFts(SEARCH_MAX_RESULTS);
    const dyn = tokens(buildDynamicSegment(fts));
    const history = limitConversationHistory(
      [{ role: 'system', content: stable }, ...historyMessages(MAX_HISTORY_ROUNDS * 2)],
      MAX_HISTORY_ROUNDS,
    ).slice(1);
    const total = stableTokens + tokens(history.map((m) => m.content).join('\n')) + dyn;
    expect(total).toBeGreaterThan(CONTEXT_BUDGET_TOKENS);
  });
});
