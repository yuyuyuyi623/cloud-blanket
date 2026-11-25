/**
 * distill.ts 行为测试（块提示词 / 汇总 / 流水线 / H1 红线）
 */
import { describe, expect, it, vi } from 'vitest';
import {
  buildBlockMessages,
  buildSummarizeMessages,
  distillBlock,
  distillSummarize,
  renderBlockText,
  runDistill,
  type DistillBlockInput,
  type DistillBlockResult,
} from '../engine/distill.js';
import type { LlmClient } from '../engine/deepseek.js';
import { LlmError } from '../engine/deepseek.js';
import {
  DISTILL_BLOCK_RETRIES,
  DISTILL_CONCURRENCY,
  DISTILL_TIMEOUT_MS,
  EPISODES_LIMIT,
} from '../engine/config.js';
import type { ParsedMessage } from '../engine/parse.js';

const block: DistillBlockInput = {
  blockIndex: 0,
  text: '对方：晚安\n你：晚安，做个好梦',
  firstAt: '2026-07-24T10:00:00',
  lastAt: '2026-07-24T23:00:00',
};

describe('buildBlockMessages', () => {
  it('块首带时间范围，正文原样进 user 消息', () => {
    const msgs = buildBlockMessages(block);
    expect(msgs[1]!.content).toContain('2026-07-24');
    expect(msgs[1]!.content).toContain('晚安，做个好梦');
    expect(msgs[0]!.role).toBe('system');
  });

  it('必须要求产出 memories（清单九：蒸馏不产事件层 = 致命缺陷）', () => {
    const system = buildBlockMessages(block)[0]!.content;
    expect(system).toContain('memories');
    expect(system).toContain('"memories"');
  });

  it('H1 红线：块提示词不含示范句式', () => {
    for (const m of buildBlockMessages(block)) {
      expect(m.content).not.toMatch(/比如|例如|例[:：]|你可以/);
    }
  });

  it('安全排除项在提示词里', () => {
    expect(buildBlockMessages(block)[0]!.content).toContain('密码、密钥、账号、支付信息、精确住址');
  });
});

describe('distillBlock（假 client）', () => {
  it('按蒸馏口径传超时：300s、不走日常 90s 默认', async () => {
    let got: { timeoutMs?: number; retries?: number; maxTokens: number } | null = null;
    const client: LlmClient = {
      async chat(_m, options) {
        got = { timeoutMs: options.timeoutMs, retries: options.retries, maxTokens: options.maxTokens };
        return { content: '{"summary":"ok"}', finishReason: 'stop' };
      },
    };
    await distillBlock(client, block);
    expect(got!.timeoutMs).toBe(DISTILL_TIMEOUT_MS);
    expect(got!.maxTokens).toBe(4000);
  });

  it('解析正常输出；缺字段给空默认', async () => {
    const client: LlmClient = {
      async chat() {
        return {
          content: JSON.stringify({
            summary: '聊了晚安',
            persona: ['口吻温柔'],
            factsUser: ['他晚睡'],
            factsRelationship: ['关系稳定'],
            memories: [{ text: '第一次互道晚安', at: '2026-07-24' }],
          }),
          finishReason: 'stop',
        };
      },
    };
    const r = await distillBlock(client, block);
    expect(r.summary).toBe('聊了晚安');
    expect(r.personaFragments).toEqual(['口吻温柔']);
    expect(r.memories[0]).toEqual({ text: '第一次互道晚安', at: '2026-07-24' });
  });

  it('截断与没给 JSON 分开报错（G2 在蒸馏块上同样生效）', async () => {
    const truncated: LlmClient = {
      async chat() {
        return { content: '{"summary":"很长的摘要"', finishReason: 'length' };
      },
    };
    await expect(distillBlock(truncated, block)).rejects.toMatchObject({ kind: 'truncated-json' });

    const noJson: LlmClient = {
      async chat() {
        return { content: '我不知道该怎么提取', finishReason: 'stop' };
      },
    };
    await expect(distillBlock(noJson, block)).rejects.toMatchObject({ kind: 'no-json' });
  });

  it('事件条数与字数被防御性裁切', async () => {
    const client: LlmClient = {
      async chat() {
        return {
          content: JSON.stringify({
            memories: Array.from({ length: 12 }, (_, i) => ({ text: `事${'x'.repeat(150)}${i}`, at: null })),
          }),
          finishReason: 'stop',
        };
      },
    };
    const r = await distillBlock(client, block);
    expect(r.memories).toHaveLength(8);
    expect(r.memories[0]!.text.length).toBeLessThanOrEqual(120);
  });
});

describe('buildSummarizeMessages + distillSummarize', () => {
  const blockResults: DistillBlockResult[] = [
    {
      blockIndex: 0,
      summary: '第一段：认识',
      personaFragments: ['称呼对方全名'],
      factsUser: ['他养猫'],
      factsRelationship: ['刚认识'],
      memories: [{ text: '第一次聊天', at: '2026-07-24' }],
    },
    {
      blockIndex: 1,
      summary: '第二段：稳定',
      personaFragments: ['会主动问吃饭'],
      factsUser: ['他养猫', '他换工作了'],
      factsRelationship: ['关系稳定'],
      memories: [],
    },
  ];

  it('原料按时间顺序全给，含事实与事件', () => {
    const user = buildSummarizeMessages(blockResults)[1]!.content;
    expect(user).toContain('第一段：认识');
    expect(user).toContain('第二段：稳定');
    expect(user).toContain('他养猫');
    expect(user).toContain('第一次聊天');
  });

  it('H1 红线：汇总提示词不含示范句式', () => {
    for (const m of buildSummarizeMessages(blockResults)) {
      expect(m.content).not.toMatch(/比如|例如|例[:：]|你可以/);
    }
  });

  it('汇总解析：persona/impression/summary/coreCandidates/事实', async () => {
    const client: LlmClient = {
      async chat() {
        return {
          content: JSON.stringify({
            persona: '她的人人格卡'.repeat(3),
            impression: '温柔但要强',
            summary: '关系摘要',
            coreMemories: [
              { text: '第一次互道晚安', at: '2026-07-24' },
              '纯字符串候选',
            ],
            factsUser: ['他养猫'],
            factsRelationship: ['关系稳定'],
          }),
          finishReason: 'stop',
        };
      },
    };
    const r = await distillSummarize(client, blockResults);
    expect(r.impression).toBe('温柔但要强');
    expect(r.coreCandidates).toHaveLength(2);
    expect(r.coreCandidates[0]).toEqual({ text: '第一次互道晚安', at: '2026-07-24' });
    expect(r.coreCandidates[1]).toEqual({ text: '纯字符串候选', at: null });
  });
});

describe('runDistill 流水线', () => {
  function scriptedClient(script: (i: number) => string): LlmClient {
    let i = 0;
    return {
      async chat(_m, options) {
        const content = options.purpose === 'distill-block' ? script(i++) : JSON.stringify({
          persona: '汇总人格卡',
          impression: '印象',
          summary: '汇总摘要',
          coreMemories: [{ text: '核心候选一', at: null }],
          factsUser: ['他养猫'],
          factsRelationship: ['关系稳定'],
        });
        return { content, finishReason: 'stop' };
      },
    };
  }

  it('并发跑完全部块 + 汇总 + 组包；进度回调完整', async () => {
    const client = scriptedClient(
      (i) =>
        JSON.stringify({
          summary: `块${i}摘要`,
          persona: [`块${i}侧写`],
          factsUser: [`事实${i}`],
          memories: [{ text: `事件${i}`, at: '2026-08-01' }],
        }),
    );
    const onProgress = vi.fn();
    const blocks: DistillBlockInput[] = Array.from({ length: 5 }, (_, i) => ({
      blockIndex: i,
      text: `块${i}`.repeat(10),
    }));
    const r = await runDistill(client, blocks, { onProgress });

    expect(r.blockResults).toHaveLength(5);
    expect(r.blockResults[3]!.summary).toBe('块3摘要');
    // pack 与运行时同构：memories 必须有（5 个块各 1 条）
    expect(r.pack.memories).toHaveLength(5);
    expect(r.pack.persona.card).toBe('汇总人格卡');
    expect(r.pack.facts.map((f) => f.text)).toContain('他养猫');
    // 核心候选与 pack 分离：候选 1 条，pack.coreMemories 取前 5
    expect(r.coreCandidates).toHaveLength(1);
    expect(r.pack.coreMemories.map((c) => c.text)).toEqual(['核心候选一']);
    // 进度：每个块跑完 done 都 +1，最终 5；汇总阶段单独发
    const blockDone = onProgress.mock.calls
      .map((c) => c[0] as { phase: string; done: number })
      .filter((p) => p.phase === 'blocks')
      .map((p) => p.done);
    for (let k = 1; k < blockDone.length; k++) {
      expect(blockDone[k]!).toBeGreaterThanOrEqual(blockDone[k - 1]!);
    }
    expect(Math.max(...blockDone)).toBe(5);
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ phase: 'summarize' }));
  });

  it('进度带心跳字段：startedAt / running / lastBlockMs', async () => {
    const client = scriptedClient((i) => JSON.stringify({ summary: `块${i}`, memories: [] }));
    const seen: { running: number[]; lastBlockMs: number | null; startedAt: number }[] = [];
    const blocks = Array.from({ length: 3 }, (_, i) => ({ blockIndex: i, text: `块${i}` }));
    await runDistill(client, blocks, {
      onProgress: (p) => seen.push({ running: p.running, lastBlockMs: p.lastBlockMs, startedAt: p.startedAt }),
    });
    expect(seen.length).toBeGreaterThan(3);
    expect(seen[0]!.running).toEqual([]);
    expect(seen[0]!.lastBlockMs).toBeNull();
    expect(seen.every((s) => s.startedAt > 0)).toBe(true);
    expect(seen.some((s) => s.running.length > 0)).toBe(true);
    expect(seen.at(-1)!.lastBlockMs).toBeGreaterThanOrEqual(0);
  });

  it('并发不超过 DISTILL_CONCURRENCY，且确实并发', async () => {
    let inflight = 0;
    let peak = 0;
    const client: LlmClient = {
      async chat(_m, options) {
        if (options.purpose === 'distill-block') {
          inflight++;
          peak = Math.max(peak, inflight);
          await new Promise((r) => setTimeout(r, 5));
          inflight--;
          return { content: '{"summary":"ok","memories":[]}', finishReason: 'stop' };
        }
        return { content: '{}', finishReason: 'stop' };
      },
    };
    const blocks = Array.from({ length: DISTILL_CONCURRENCY * 2 }, (_, i) => ({ blockIndex: i, text: `块${i}` }));
    await runDistill(client, blocks);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(DISTILL_CONCURRENCY);
  });

  it('一块永久失败：重试到底后整条抛，不静默跳过', async () => {
    let calls = 0;
    const client: LlmClient = {
      async chat(_m, options) {
        if (options.purpose === 'distill-block') {
          calls++;
          throw new LlmError('no-json', '模型没有返回 JSON 对象');
        }
        return { content: '{}', finishReason: 'stop' };
      },
    };
    const blocks: DistillBlockInput[] = Array.from({ length: 4 }, (_, k) => ({ blockIndex: k, text: `块${k}` }));
    await expect(runDistill(client, blocks)).rejects.toMatchObject({ kind: 'no-json' });
    // 每块：首次 + DISTILL_BLOCK_RETRIES 次重试
    expect(calls).toBe(4 * (DISTILL_BLOCK_RETRIES + 1));
  });

  it('截断类错误不重试（模型输出被截断，重试也是同样长度）', async () => {
    let calls = 0;
    const client: LlmClient = {
      async chat(_m, options) {
        if (options.purpose === 'distill-block') {
          calls++;
          throw new LlmError('truncated-json', '模型返回了被截断的 JSON');
        }
        return { content: '{}', finishReason: 'stop' };
      },
    };
    const blocks: DistillBlockInput[] = [{ blockIndex: 0, text: '块' }];
    await expect(runDistill(client, blocks)).rejects.toMatchObject({ kind: 'truncated-json' });
    expect(calls).toBe(1);
  });

  it('偶发超时单独重试这块，其余块不受影响', async () => {
    let failedOnce = false;
    const client: LlmClient = {
      async chat(_m, options) {
        if (options.purpose === 'distill-block') {
          if (!failedOnce) {
            failedOnce = true;
            throw new LlmError('timeout', '请求超过 300000ms 未响应');
          }
          return { content: '{"summary":"ok","memories":[]}', finishReason: 'stop' };
        }
        return { content: '{"persona":"卡","summary":"摘要"}', finishReason: 'stop' };
      },
    };
    const blocks = Array.from({ length: 3 }, (_, i) => ({ blockIndex: i, text: `块${i}` }));
    const r = await runDistill(client, blocks);
    expect(r.blockResults).toHaveLength(3);
    expect(r.blockResults.every((b) => b.summary === 'ok')).toBe(true);
  });

  it('事件候选超过上限时按三段分层保留（A3：60 条）', async () => {
    let call = 0;
    const client = scriptedClient(
      () => {
        const n = call++;
        return JSON.stringify({
          memories: Array.from({ length: 10 }, (_, k) => ({ text: `块${n}事件${k}`, at: null })),
        });
      },
    );
    const blocks: DistillBlockInput[] = Array.from({ length: 8 }, (_, i) => ({ blockIndex: i, text: `块${i}` }));
    const r = await runDistill(client, blocks);
    expect(r.pack.memories).toHaveLength(EPISODES_LIMIT);
  });
});

describe('renderBlockText（喂给模型的原文口径，只有这一份）', () => {
  const msg = (over: Partial<ParsedMessage> & { text: string }): ParsedMessage => ({
    role: 'user',
    at: '2025-03-01T12:33:00',
    unfinished: '',
    ...over,
  });

  it('你/她 + 日期 + 内容，空行分隔', () => {
    const out = renderBlockText([
      msg({ text: '晚安', at: '2025-03-01T23:10:00' }),
      msg({ role: 'assistant', text: '晚安，被子盖好', at: '2025-03-01T23:11:00' }),
    ]);
    expect(out).toBe('你（2025-03-01）：晚安\n\n她（2025-03-01）：晚安，被子盖好');
  });

  it('非 FINISHED 带状态标记，时间照留', () => {
    const out = renderBlockText([msg({ role: 'assistant', text: '那我先', unfinished: 'GENERATING' })]);
    expect(out).toBe('她（2025-03-01）〔未说完：GENERATING〕：那我先');
  });

  it('没有时间就不带括号', () => {
    const out = renderBlockText([msg({ text: '嗯', at: '' })]);
    expect(out).toBe('你：嗯');
  });

  it('空消息列表给空串（调用方负责不传空块）', () => {
    expect(renderBlockText([])).toBe('');
  });
});
