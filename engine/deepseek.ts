/**
 * engine/deepseek.ts —— 唯一网络出口，client 必须可注入
 *
 * 设计决定（清单十·5）：柔光的整合函数直连 fetch，导致只能"读自己源码、正则断言"
 * 来防回退。这里把 client 定义成接口，测试时注入假实现，直接断言收到的参数。
 *
 * 铁律（全部来自踩坑，出处见 config 注释）：
 *   G1  maxTokens 必须显式传，类型层强制——不许有 500 这种默认值；
 *   G2  JSON 解析两分支分开报错：没给 JSON ≠ 截断（判断顺序照源码 parseJsonObject）；
 *   G3  finish_reason === 'length' 必须触发 warn 留痕，截断不许隐形；
 *   十·4  超时 90 秒（AbortController），429/5xx 重试一次（等 1.2s），其余直接抛；
 *   十·4  空 content 单独报错，与截断、与"没给 JSON"三者互斥。
 */

import {
  DEEPSEEK_BASE_URL,
  DEEPSEEK_MODEL,
  REQUEST_TIMEOUT_MS,
  RETRY_DELAY_MS,
  RETRYABLE_STATUS_CODES,
} from './config.js';

// ── 类型 ─────────────────────────────────────────────────────

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface CallOptions {
  /** G1：必须显式给，没有默认值。这是 230 次失败换来的教训 */
  maxTokens: number;
  temperature?: number;
  /** 日志用途标记（'profile' | 'summary' | 'distill-block' | 'distill-summarize' | 'chat'） */
  purpose?: string;
  /**
   * 本次调用覆盖默认超时。蒸馏用它放宽（DISTILL_TIMEOUT_MS）——
   * 一块 2 万字输入 + 4000 token 输出，90 秒是必超的，超时 = 白跑。
   */
  timeoutMs?: number;
  /** 429/5xx 重试次数，默认 1（十·4）。蒸馏块给 2，8 路并发下一块被限流不该拖死全局 */
  retries?: number;
}

export interface CallResult {
  content: string;
  finishReason: string | null;
  promptTokens?: number;
  completionTokens?: number;
}

/** 可注入的模型调用接口。App 里由 deepseek 实现，测试里由假 client 实现 */
export interface LlmClient {
  chat(messages: ChatMessage[], options: CallOptions): Promise<CallResult>;
}

export type LlmErrorKind =
  | 'http' // 非 429/5xx 的 HTTP 错误
  | 'timeout' // 90 秒超时
  | 'network' // fetch 本身失败
  | 'empty' // 200 但 content 为空
  | 'no-json' // 回复里没有 JSON 对象
  | 'truncated-json'; // 有 { 没 } —— 被 max_tokens 截断

export class LlmError extends Error {
  constructor(
    public readonly kind: LlmErrorKind,
    message: string,
    public readonly status?: number,
    public readonly purpose?: string,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

// ── JSON 提取（G2，判断顺序照源码 parseJsonObject：index.mjs:5447）──

/**
 * 从模型回复里抠出第一个 JSON 对象。
 * 判断顺序钉死：先判"根本没给 {"，再判"有 { 没 } = 截断"——两个分支分开报错。
 */
export function parseJsonObject(text: string): Record<string, unknown> {
  const raw = String(text)
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0) {
    throw new LlmError('no-json', '模型没有返回 JSON 对象');
  }
  // 有开头没闭合 = 被 max_tokens 截断，跟"模型没给 JSON"是两回事，别再混着报
  if (end <= start) {
    throw new LlmError('truncated-json', '模型返回了被截断的 JSON（没有闭合花括号）');
  }
  try {
    return JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  } catch (e) {
    throw new LlmError('no-json', `JSON 解析失败：${(e as Error).message}`);
  }
}

// ── 真 client ────────────────────────────────────────────────

export interface DeepseekClientOptions {
  apiKey: string;
  /** K6 生存设计：默认 config 的单点常量，改模型/换地址不改这里 */
  baseUrl?: string;
  model?: string;
  /** 测试注入用；生产走全局 fetch */
  fetchImpl?: typeof fetch;
  /** 测试注入用；生产走 REQUEST_TIMEOUT_MS */
  timeoutMs?: number;
  /** G3 留痕钩子：截断 warn、重试 warn 都走这里 */
  onWarn?: (message: string, data?: Record<string, unknown>) => void;
}

export function createDeepseekClient(options: DeepseekClientOptions): LlmClient {
  const baseUrl = (options.baseUrl ?? DEEPSEEK_BASE_URL).replace(/\/+$/, '');
  const model = options.model ?? DEEPSEEK_MODEL;
  const fetchImpl = options.fetchImpl ?? fetch;
  const defaultTimeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  /** 每次调用生效的超时：调用级覆盖 > client 级 > config 默认 */
  const timeoutFor = (opts: CallOptions) => opts.timeoutMs ?? defaultTimeoutMs;
  const onWarn = options.onWarn;

  async function callOnce(
    messages: ChatMessage[],
    opts: CallOptions,
  ): Promise<CallResult> {
    const timeoutMs = timeoutFor(opts);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: opts.maxTokens,
          // JSON 任务（蒸馏/整合/摘要）必须显式关思考：思考 token 不计入 max_tokens
          // 却照样计费，且会让结构化输出更容易漂。引擎这条通道只跑 JSON 任务。
          thinking: { type: 'disabled' },
          ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        }),
      });

      if (!response.ok) {
        const status = response.status;
        if (RETRYABLE_STATUS_CODES.includes(status)) {
          throw new LlmError('http', `可重试的 HTTP ${status}`, status, opts.purpose);
        }
        const body = await response.text().catch(() => '');
        throw new LlmError('http', `HTTP ${status}：${body.slice(0, 300)}`, status, opts.purpose);
      }

      const data = (await response.json()) as {
        choices?: { message?: { content?: string }; finish_reason?: string }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const choice = data.choices?.[0];
      const content = choice?.message?.content ?? '';
      const finishReason = choice?.finish_reason ?? null;

      if (!content.trim()) {
        throw new LlmError('empty', '模型返回了空回复', undefined, opts.purpose);
      }
      // G3：截断必须留痕，不许隐形
      if (finishReason === 'length') {
        onWarn?.('回复被 max_tokens 截断（finish_reason=length）', {
          purpose: opts.purpose,
          completionTokens: data.usage?.completion_tokens,
        });
      }

      return {
        content,
        finishReason,
        promptTokens: data.usage?.prompt_tokens,
        completionTokens: data.usage?.completion_tokens,
      };
    } catch (e) {
      if (e instanceof LlmError) throw e;
      if ((e as Error).name === 'AbortError') {
        throw new LlmError('timeout', `请求超过 ${timeoutMs}ms 未响应`, undefined, opts.purpose);
      }
      throw new LlmError('network', `网络请求失败：${(e as Error).message}`, undefined, opts.purpose);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async chat(messages, opts) {
      // 十·4：429/5xx 重试，默认一次、间隔 1.2s；蒸馏块给 2 次，间隔指数加长
      const maxRetries = opts.retries ?? 1;
      for (let attempt = 0; ; attempt++) {
        try {
          return await callOnce(messages, opts);
        } catch (e) {
          const status = e instanceof LlmError ? e.status : undefined;
          const retryable =
            e instanceof LlmError &&
            e.kind === 'http' &&
            status !== undefined &&
            RETRYABLE_STATUS_CODES.includes(status);
          if (!retryable || attempt >= maxRetries) throw e;
          const wait = RETRY_DELAY_MS * 2 ** attempt;
          onWarn?.(`HTTP ${status}，${wait}ms 后重试（${attempt + 1}/${maxRetries}）`, {
            purpose: opts.purpose,
          });
          await new Promise((resolve) => setTimeout(resolve, wait));
        }
      }
    },
  };
}
