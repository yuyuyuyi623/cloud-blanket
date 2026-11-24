/**
 * deepseek.ts 行为测试（清单十·5：不采纳"读源码正则断言"，全部假 fetch 行为断言）
 */
import { describe, expect, it, vi } from 'vitest';
import { LlmError, createDeepseekClient, parseJsonObject } from '../engine/deepseek.js';

function okResponse(overrides: Partial<Record<string, unknown>> = {}, content = '你好') {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 10 },
      ...overrides,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function fakeFetch(handler: (url: string, init: RequestInit) => Promise<Response>) {
  return vi.fn(handler) as unknown as typeof fetch;
}

describe('parseJsonObject（G2：两分支分开报错，顺序钉死）', () => {
  it('正常 JSON、带 ```json 围栏、带前后废话都能抠出来', () => {
    expect(parseJsonObject('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonObject('好的，这是结果：{"a":{"b":2}} 请查收')).toEqual({ a: { b: 2 } });
  });

  it('没有 { → "没给 JSON"；有 { 没 } → "截断"；报错种类分开', () => {
    expect(() => parseJsonObject('抱歉我无法输出')).toThrowError(/JSON 对象/);
    try {
      parseJsonObject('抱歉我无法输出');
      throw new Error('should not reach');
    } catch (e) {
      expect((e as LlmError).kind).toBe('no-json');
    }
    try {
      parseJsonObject('{"core":["第一条",');
      throw new Error('should not reach');
    } catch (e) {
      expect((e as LlmError).kind).toBe('truncated-json');
    }
  });
});

describe('createDeepseekClient（假 fetch 行为断言）', () => {
  it('G1：maxTokens 必须原样透传，不许被改写或丢掉', async () => {
    const fetchImpl = fakeFetch(async (_url, init) => {
      const body = JSON.parse(String(init.body));
      expect(body.max_tokens).toBe(4000);
      expect(body.messages).toHaveLength(2);
      return okResponse();
    });
    const client = createDeepseekClient({ apiKey: 'k', fetchImpl });
    await client.chat(
      [
        { role: 'system', content: 's' },
        { role: 'user', content: 'u' },
      ],
      { maxTokens: 4000 },
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('429 重试一次后成功；两次都 429 才抛', async () => {
    let calls = 0;
    const fetchImpl = fakeFetch(async () => {
      calls++;
      return calls === 1 ? new Response('rate limited', { status: 429 }) : okResponse();
    });
    const client = createDeepseekClient({ apiKey: 'k', fetchImpl, timeoutMs: 100 });
    const result = await client.chat([{ role: 'user', content: 'u' }], { maxTokens: 100 });
    expect(result.content).toBe('你好');
    expect(calls).toBe(2);
  });

  it('400 这类不可重试错误直接抛，不重试', async () => {
    const fetchImpl = fakeFetch(async () => new Response('bad key', { status: 401 }));
    const client = createDeepseekClient({ apiKey: 'bad', fetchImpl, timeoutMs: 100 });
    await expect(
      client.chat([{ role: 'user', content: 'u' }], { maxTokens: 100 }),
    ).rejects.toMatchObject({ kind: 'http', status: 401 });
  });

  it('空 content 单独报错（与截断、没给 JSON 三者互斥）', async () => {
    const fetchImpl = fakeFetch(async () => okResponse({}, '  '));
    const client = createDeepseekClient({ apiKey: 'k', fetchImpl, timeoutMs: 100 });
    await expect(
      client.chat([{ role: 'user', content: 'u' }], { maxTokens: 100 }),
    ).rejects.toMatchObject({ kind: 'empty' });
  });

  it('G3：finish_reason=length 触发 warn 留痕，带 purpose', async () => {
    const onWarn = vi.fn();
    const fetchImpl = fakeFetch(async () =>
      okResponse({ choices: [{ message: { content: '写了一半' }, finish_reason: 'length' }] }),
    );
    const client = createDeepseekClient({ apiKey: 'k', fetchImpl, timeoutMs: 100, onWarn });
    await client.chat([{ role: 'user', content: 'u' }], { maxTokens: 10, purpose: 'profile' });
    expect(onWarn).toHaveBeenCalledTimes(1);
    const [message, data] = onWarn.mock.calls[0]!;
    expect(String(message)).toContain('截断');
    expect(data).toMatchObject({ purpose: 'profile' });
  });

  it('调用级 timeoutMs 覆盖 client 默认超时（蒸馏靠它从 90s 放宽到 300s）', async () => {
    const fetchImpl = fakeFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    );
    const client = createDeepseekClient({ apiKey: 'k', fetchImpl, timeoutMs: 10_000 });
    const t0 = Date.now();
    await expect(
      client.chat([{ role: 'user', content: 'u' }], { maxTokens: 10, timeoutMs: 30 }),
    ).rejects.toMatchObject({ kind: 'timeout' });
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('finish_reason=stop 不触发 warn', async () => {
    const onWarn = vi.fn();
    const fetchImpl = fakeFetch(async () => okResponse());
    const client = createDeepseekClient({ apiKey: 'k', fetchImpl, timeoutMs: 100, onWarn });
    await client.chat([{ role: 'user', content: 'u' }], { maxTokens: 100 });
    expect(onWarn).not.toHaveBeenCalled();
  });
});
