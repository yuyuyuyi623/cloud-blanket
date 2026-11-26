/**
 * 落档裁剪（2026-11-26 经济方案）单测
 *
 * 锁三件事：
 * 1. 死重（snippet/site_icon/image_url/每步思考）裁掉，signature 保留（read_link 拼正文的唯一钥匙）；
 * 2. 幂等：裁过的再裁一遍不变（重复落档安全）；
 * 3. 裁过的快照经 toAssistantParam 序列化仍是合法线格式（server_tool_calls 结构完整）。
 */

import { describe, expect, it } from 'vitest';
import { trimServerToolCalls, toRequestMessages } from '../src/services/chat/reply.js';
import type { ServerToolCallStep } from '../src/services/api/types.js';
import type { AssistantMessage, Message, UserMessage } from '../src/services/chat/types.js';

/** 构造一步搜索调用：带全量展示字段的 2 条来源 */
const searchStep = (): ServerToolCallStep => ({
  index: 0,
  reasoning_content: '用户在问价格，需要查一下',
  calls: [
    {
      index: 0,
      id: 'call_1',
      type: 'deepseek_web_search',
      kind: 'search',
      action: { type: 'search', queries: ['云朵被子 价格'] },
      status: 'completed',
      sources: [
        {
          type: 'url',
          url: 'https://example.com/a',
          title: '结果一',
          snippet: '这是一大段摘要文本……'.repeat(20),
          site_name: '示例站',
          site_icon: 'https://example.com/favicon.ico',
          published_at: '2026-11-25',
          image_url: 'https://example.com/img.jpg',
        },
        {
          type: 'url',
          url: 'https://example.com/b',
          title: '结果二',
          snippet: '另一段摘要',
          site_name: null,
          site_icon: null,
          published_at: null,
        },
      ],
    },
  ],
});

/** 构造一步 read_link 调用：signature 是网页正文的加密载荷，绝不能丢 */
const readStep = (): ServerToolCallStep => ({
  index: 1,
  reasoning_content: '打开这篇网页核对原文',
  calls: [
    {
      index: 1,
      id: 'call_2',
      type: 'deepseek_read_url',
      kind: 'read_link',
      action: { type: 'read_link', url: 'https://example.com/doc' },
      status: 'completed',
      page: { url: 'https://example.com/doc', title: '文档页', published_at: '2026-11-01' },
      signature: 'ENC-SIGNATURE-PAYLOAD',
    },
  ],
});

const userMsg = (text: string): UserMessage => ({
  id: 'u1',
  role: 'user',
  content: text,
  createdAt: 1,
  files: [],
});

const replyMsg = (steps: ServerToolCallStep[]): AssistantMessage => ({
  id: 'a1',
  role: 'assistant',
  status: 'done',
  createdAt: 2,
  model: null,
  prefix: true,
  blocks: [{ type: 'text', text: '回答正文', citations: [] }],
  serverToolCalls: steps,
});

describe('trimServerToolCalls', () => {
  it('丢掉 snippet/site_icon/image_url，保留 url/title/域名/日期', () => {
    const [step] = trimServerToolCalls([searchStep()]);
    const source = step.calls[0].sources![0];
    expect(source.snippet).toBe('');
    expect(source.site_icon).toBeNull();
    expect('image_url' in source ? source.image_url : undefined).toBeUndefined();
    expect(source.url).toBe('https://example.com/a');
    expect(source.title).toBe('结果一');
    expect(source.site_name).toBe('示例站');
    expect(source.published_at).toBe('2026-11-25');
  });

  it('每步 reasoning_content 清空，calls 结构原样', () => {
    const steps = trimServerToolCalls([searchStep(), readStep()]);
    expect(steps.map((s) => s.reasoning_content)).toEqual(['', '']);
    expect(steps[0].calls[0].id).toBe('call_1');
    expect(steps[1].calls[0].id).toBe('call_2');
    // step index 不动
    expect(steps.map((s) => s.index)).toEqual([0, 1]);
  });

  it('signature 与 page 保留（read_link 靠它们拼回网页正文）', () => {
    const [, step] = trimServerToolCalls([searchStep(), readStep()]);
    expect(step.calls[0].signature).toBe('ENC-SIGNATURE-PAYLOAD');
    expect(step.calls[0].page?.title).toBe('文档页');
  });

  it('幂等：裁过的再裁一遍结果不变', () => {
    const once = trimServerToolCalls([searchStep(), readStep()]);
    const twice = trimServerToolCalls(once);
    expect(twice).toEqual(once);
  });

  it('空数组与无 sources 的调用安全通过', () => {
    expect(trimServerToolCalls([])).toEqual([]);
    const failed: ServerToolCallStep = {
      index: 0,
      reasoning_content: 'x',
      calls: [
        {
          index: 0,
          id: 'call_3',
          type: 'deepseek_web_search',
          kind: 'search',
          action: { type: 'search', queries: ['q'] },
          status: 'failed',
          error: { code: 'unavailable' },
        },
      ],
    };
    const [step] = trimServerToolCalls([failed]);
    expect(step.calls[0].sources).toBeUndefined();
    expect(step.calls[0].error).toEqual({ code: 'unavailable' });
    expect(step.reasoning_content).toBe('');
  });

  it('裁过的快照经 toRequestMessages 序列化仍是合法线格式', () => {
    // 落档时先裁（store.ts finally 的行为），历史里存的是瘦身版
    const history: Message[] = [
      userMsg('查一下价格'),
      replyMsg(trimServerToolCalls([searchStep(), readStep()])),
    ];
    const messages = toRequestMessages(history, userMsg('那销量呢'));
    const assistant = messages.find((m) => m.role === 'assistant');
    expect(assistant).toBeDefined();
    const calls = assistant && 'server_tool_calls' in assistant ? assistant.server_tool_calls : undefined;
    expect(calls).toHaveLength(2);
    // 线格式回放的是裁剪版：无摘要、无思考，signature 完整
    expect(calls![0].calls[0].sources![0].snippet).toBe('');
    expect(calls![0].reasoning_content).toBe('');
    expect(calls![1].calls[0].signature).toBe('ENC-SIGNATURE-PAYLOAD');
    // JSON 序列化不丢字段（落库走的就是这条路）
    expect(JSON.parse(JSON.stringify(calls))).toEqual(calls);
  });
});
