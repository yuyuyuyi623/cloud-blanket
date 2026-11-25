/**
 * consolidation.ts 行为测试
 *
 * v1.0.2 死路径清理后，本文件只测留存的导出：巩固提示词 + 摘要四件套，
 * 外加三条反向断言（拍板回复 §五·5）：删掉的东西不许再回来。
 */
import { describe, expect, it } from 'vitest';
import * as consolidationModule from '../engine/consolidation.js';
import {
  applySummary,
  buildConsolidationMessages,
  buildSummaryMessages,
  consolidateSummary,
  renderRecentConversation,
} from '../engine/consolidation.js';
import type { LlmClient } from '../engine/deepseek.js';
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

  it('反向断言：提示词里没有 forget（字段已不存在，句子也不许留）', () => {
    const msgs = buildConsolidationMessages(pack(), [], []);
    for (const m of msgs) {
      expect(m.content).not.toContain('forget');
    }
    // 三·① 的悬空引用："forget 从这里挑"
    expect(msgs[1]!.content).not.toContain('从这里挑');
  });
});

describe('死路径清理的反向断言（拍板回复 三·②/§五·5）', () => {
  it('engine/consolidation.ts 不再导出 shouldConsolidate / consolidate / applyConsolidation', () => {
    expect('shouldConsolidate' in consolidationModule).toBe(false);
    expect('consolidate' in consolidationModule).toBe(false);
    expect('applyConsolidation' in consolidationModule).toBe(false);
  });

  it('唯一在用的导出还在：buildConsolidationMessages', () => {
    expect(typeof consolidationModule.buildConsolidationMessages).toBe('function');
  });
});

describe('renderRecentConversation', () => {
  it('角色换成"对方/你"，时间戳放行首', () => {
    const text = renderRecentConversation([
      { role: 'user', text: '在吗', at: '2026-11-22T09:05:00' },
      { role: 'assistant', text: '在', at: null },
    ]);
    expect(text).toContain('[2026-11-22 09:05] 对方：在吗');
    expect(text).toContain('你：在');
  });
});

describe('滚动摘要（C2/C3）——零引用，v1.0.3 处置，本轮只锁现状', () => {
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
