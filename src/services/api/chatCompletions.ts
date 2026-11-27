/**
 * OpenAI 兼容端点（POST /chat/completions）的流式客户端。
 *
 * 为什么换端点：anthropic 兼容端点实测零缓存命中（M0 验证，F12 + 账单双实锤），
 * "稳定段省 90%+" 的收益只有 /chat/completions 的 prompt_cache_hit_tokens 上才成立
 * （柔光 33 天线上 48.2% 命中率对照）。架构决定见 docs/M0验证报告-2026-11-23.md §二③。
 *
 * 架构：内部模型（CreateMessageRequest / MessageStreamEvent / 内容块）保持不变，
 * 本文件负责 内部模型 ↔ OpenAI 线格式 的双向翻译：
 * - 请求：system 字段 → system 消息；latest_reminder 角色两端同名；文件块 → {type:'file', file_id}
 *   （file_id 由 Files API 上传获得，账号内所有 API 家族共享，chat completions 引用无需 beta 头）；
 * - 响应：delta.reasoning_content → thinking 块；server_tool_event → server_tool_use /
 *   结果块；最后一块的 usage（prompt_cache_hit_tokens / prompt_cache_miss_tokens）→ MessageUsage；
 *   annotations（url_citation）→ TextCitation；[DONE] → message_stop。
 *
 * 回传规则（联网工具指南）：assistant 消息连同 server_tool_calls 原样回传；signature 让
 * 阅读过的网页正文拼回上下文。流式事件 call_completed 不带 signature，所以完整的
 * server_tool_calls 在收尾块补发（raw_server_tool_calls 内部事件），由 applyEvent 存进回复。
 */

import { API_ORIGIN, ApiError, isErrorBody, readErrorResponse, request } from './client.js'
import type {
  CreateMessageRequest,
  MessageParam,
  MessageStreamEvent,
  MessageUsage,
  OpenAiAnnotation,
  OpenAiChunk,
  OpenAiFinishReason,
  OpenAiMessage,
  OpenAiUsage,
  ServerToolCall,
  ServerToolCallAction,
  ServerToolCallStep,
  ServerToolInput,
  StopReason,
  TextCitation,
} from './types.js'
import { readCacheHitTokens } from './types.js'
import { readServerSentEvents } from './sse.js'

// ── 请求翻译：内部 MessageParam → OpenAiMessage ──────────────────────────

type OpenAiUserContent = Extract<OpenAiMessage, { role: 'user' }>['content']

const toWireUserContent = (
  content: Extract<MessageParam, { role: 'user' }>['content']
): OpenAiUserContent => {
  if (typeof content === 'string') {
    return content
  }
  return content.map((block) =>
    block.type === 'text'
      ? { type: 'text', text: block.text }
      : { type: 'file', file_id: block.source.file_id }
  )
}

/**
 * 工具调用的 action 两种口径互转：内部 ServerToolInput 用 action 字段做判别
 * （anthropic 口径），线格式 ServerToolCallAction 用 type 字段。legacy 重建与流式
 * 翻译各用其一。
 */
export const toWireAction = (input: ServerToolInput): ServerToolCallAction => {
  switch (input.action) {
    case 'search':
      return {
        type: 'search',
        queries: input.queries,
        ...(input.query !== undefined ? { query: input.query } : {}),
      }
    case 'open_page':
      return { type: 'open_page', url: input.url }
    case 'find_in_page':
      return { type: 'find_in_page', url: input.url, pattern: input.pattern }
    case 'read_link':
      return { type: 'read_link', url: input.url }
  }
}

export const toInternalInput = (action: ServerToolCallAction): ServerToolInput => {
  switch (action.type) {
    case 'search':
      return {
        action: 'search',
        queries: action.queries,
        ...(action.query !== undefined ? { query: action.query } : {}),
      }
    case 'open_page':
      return { action: 'open_page', url: action.url }
    case 'find_in_page':
      return { action: 'find_in_page', url: action.url, pattern: action.pattern }
    case 'read_link':
      return { action: 'read_link', url: action.url }
  }
}

/**
 * assistant 历史轮：线格式就是拼好的文本 + 原样 server_tool_calls（历史思考不回传——
 * 线格式没有思考块）。
 */
const toWireMessage = (message: MessageParam): OpenAiMessage => {
  switch (message.role) {
    case 'latest_reminder':
      return message
    case 'user':
      return { role: 'user', content: toWireUserContent(message.content) }
    case 'assistant':
      return {
        role: 'assistant',
        content: message.content,
        ...(message.server_tool_calls?.length
          ? { server_tool_calls: message.server_tool_calls }
          : {}),
        ...(message.prefix ? { prefix: true as const } : {}),
      }
  }
}

/** 内部请求 → OpenAI 线格式请求体（不含 stream 字段，由 streamChatCompletion 统一加） */
export const toWireRequest = (body: CreateMessageRequest) => ({
  model: body.model,
  messages: [
    { role: 'system', content: body.system } satisfies Extract<OpenAiMessage, { role: 'system' }>,
    ...body.messages.map(toWireMessage),
    // 动态段在历史之后、本轮提问之前仍是"最后一条 system"（P0：位置错了缓存前缀就碎）
    ...(body.systemSuffix
      ? [{ role: 'system', content: body.systemSuffix } satisfies Extract<
          OpenAiMessage,
          { role: 'system' }
        >]
      : []),
  ],
  thinking: body.thinking,
  // 思考力度：enabled 时才传（disabled 传了会被忽略，也免得线格式噪音）
  ...(body.thinking.type === 'enabled' && body.reasoning_effort
    ? { reasoning_effort: body.reasoning_effort }
    : {}),
  safety_check: body.safety_check,
  tools: body.tools,
  ...(body.title ? { title: body.title } : {}),
})

// ── 响应翻译：OpenAiChunk → 内部流式事件 ─────────────────────────────────

const toMessageUsage = (usage: OpenAiUsage | null | undefined): MessageUsage | undefined => {
  if (!usage) {
    return undefined
  }
  const tool = usage.server_tool_use
  // 缓存命中字段真机为 prompt_tokens_details.cached_tokens，文档口径 prompt_cache_hit_tokens 兼容
  const cacheHit = readCacheHitTokens(usage)
  return {
    // 内部 input_tokens 语义 = 未命中缓存的输入；总输入 = 缓存命中 + 未命中
    input_tokens: usage.prompt_tokens - cacheHit,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: cacheHit,
    output_tokens: usage.completion_tokens,
    ...(tool
      ? {
          server_tool_use: {
            web_search_requests:
              (tool.tool_search ?? 0) + (tool.tool_fetch ?? 0) + (tool.tool_image_search ?? 0),
            tool_search: tool.tool_search ?? 0,
          },
        }
      : {}),
  }
}

/** finish_reason → 内部 StopReason */
const STOP_REASONS: Record<Exclude<OpenAiFinishReason, null>, StopReason> = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  content_filter: 'refusal',
  // 系统资源不足与主动中断：已有内容按正常收尾保留，不再续写
  insufficient_system_resource: 'end_turn',
  aborted: 'end_turn',
}

/** 搜索结果 → 内部 WebSearchResult（加密摘要字段 OpenAI 端点不下发，置空） */
const toWebSearchResult = (source: NonNullable<ServerToolCall['sources']>[number]) => ({
  type: 'web_search_result' as const,
  title: source.title,
  url: source.url,
  ...(source.image_url ? { image_url: source.image_url } : {}),
  snippet: source.snippet,
  site_icon: source.site_icon,
  site_name: source.site_name,
  encrypted_content: '',
  page_age: source.published_at,
})

/**
 * 单次工具调用 → 内部结果块（展示用）。signature 不进展示块（流式事件本身也不带），
 * 正文回传靠 raw server_tool_calls。
 */
const toResultBlock = (
  call: ServerToolCall,
  index: number
): Extract<MessageStreamEvent, { type: 'content_block_start' }> => {
  const hasResult = Boolean(call.sources?.length || call.page)
  const failed = call.status === 'failed' || !hasResult
  if (!failed && (call.page || call.kind === 'read_link')) {
    return {
      type: 'content_block_start',
      index,
      content_block: {
        type: 'web_fetch_tool_result',
        tool_use_id: call.id,
        kind: call.kind === 'read_link' ? 'read_link' : 'deep_search',
        content: {
          type: 'web_fetch_result',
          url: call.page?.url ?? (call.action.type === 'read_link' ? call.action.url : ''),
          content: {
            type: 'document',
            source: { type: 'text', media_type: 'text/plain', data: '' },
            title: call.page?.title ?? null,
          },
          published_at: call.page?.published_at ?? null,
        },
      },
    }
  }
  if (!failed && call.sources?.length) {
    return {
      type: 'content_block_start',
      index,
      content_block: {
        type: 'web_search_tool_result',
        tool_use_id: call.id,
        kind: call.kind === 'read_link' ? 'deep_search' : call.kind,
        content: call.sources.map(toWebSearchResult),
      },
    }
  }
  // 失败：read_link/deep_search 给抓取错误块，其余搜索给搜索错误块
  if (call.kind === 'read_link' || call.kind === 'deep_search') {
    return {
      type: 'content_block_start',
      index,
      content_block: {
        type: 'web_fetch_tool_result',
        tool_use_id: call.id,
        kind: call.kind === 'read_link' ? 'read_link' : 'deep_search',
        content: {
          type: 'web_fetch_tool_result_error',
          error_code:
            call.error?.code === 'url_not_accessible' || call.error?.code === 'url_not_allowed'
              ? call.error.code
              : 'unavailable',
        },
      },
    }
  }
  return {
    type: 'content_block_start',
    index,
    content_block: {
      type: 'web_search_tool_result',
      tool_use_id: call.id,
      // 走到这里 kind 只剩搜索类（read_link/deep_search 已在前两个分支返回）
      kind: call.kind,
      content: [{ type: 'web_search_tool_result_error', error_code: 'unavailable' }],
    },
  }
}

/** url_citation → 内部 TextCitation；cited_text 按码点索引从已累计正文里切出来 */
const toCitation = (annotation: OpenAiAnnotation, text: string): TextCitation => {
  const { url_citation } = annotation
  const chars = [...text]
  const start = Math.min(Math.max(url_citation.start_index, 0), chars.length)
  const end = Math.min(Math.max(url_citation.end_index, start), chars.length)
  return {
    type: 'web_search_result_location',
    url: url_citation.url,
    title: url_citation.title,
    cited_text: chars.slice(start, end).join('').trim(),
    encrypted_index: '',
  }
}

const isServerToolCall = (value: unknown): value is ServerToolCall => {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const call = value as Partial<ServerToolCall>
  return (
    typeof call.id === 'string' &&
    (call.type === 'deepseek_web_search' || call.type === 'deepseek_read_url') &&
    typeof call.action === 'object' &&
    call.action !== null
  )
}

const readChunk = (value: unknown): OpenAiChunk | null => {
  if (typeof value !== 'object' || value === null || !Array.isArray((value as OpenAiChunk).choices)) {
    return null
  }
  return value as OpenAiChunk
}

/**
 * 有状态的 chunk 翻译器：维护内部内容块序号、打开中的思考/文本块、正文累计。
 * 一个请求一个实例；收尾块（finish_reason 非 null）一次性补发原始 server_tool_calls、
 * 引用与 message_delta。
 */
const createTranslator = () => {
  let nextIndex = 0
  let thinkingIndex: number | null = null
  let textIndex: number | null = null
  let textAccum = ''
  /** 按出现顺序收集的调用（call_started / call_completed 都记），收尾时按步归组 */
  const seenCalls: { step: number; call: ServerToolCall }[] = []

  const closeThinking = (events: MessageStreamEvent[]) => {
    if (thinkingIndex !== null) {
      events.push({ type: 'content_block_stop', index: thinkingIndex })
      thinkingIndex = null
    }
  }
  const closeText = (events: MessageStreamEvent[]) => {
    if (textIndex !== null) {
      events.push({ type: 'content_block_stop', index: textIndex })
      textIndex = null
    }
  }

  /** 收尾块：完整 server_tool_calls（按步归组，保留 signature） */
  const buildRawCalls = (): ServerToolCallStep[] => {
    const steps: ServerToolCallStep[] = []
    for (const { step, call } of seenCalls) {
      let target = steps.find((item) => item.index === step)
      if (!target) {
        target = { index: step, reasoning_content: '', calls: [] }
        steps.push(target)
      }
      target.calls.push(call)
    }
    return steps
  }

  return {
    readChunk(chunk: OpenAiChunk): MessageStreamEvent[] {
      const events: MessageStreamEvent[] = []
      const choice = chunk.choices[0]
      if (!choice) {
        // 文档约定 usage 附在最后一个内容块上；单独的 usage 块按防御处理
        if (chunk.usage) {
          events.push({
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: toMessageUsage(chunk.usage),
          })
        }
        return events
      }
      const delta = choice.delta ?? {}

      // 思考增量：reasoning_content → thinking 块
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
        if (thinkingIndex === null) {
          closeText(events)
          thinkingIndex = nextIndex++
          events.push({
            type: 'content_block_start',
            index: thinkingIndex,
            content_block: { type: 'thinking', thinking: '' },
          })
        }
        events.push({
          type: 'content_block_delta',
          index: thinkingIndex,
          delta: { type: 'thinking_delta', thinking: delta.reasoning_content },
        })
      }

      // 正文增量：content → text 块
      if (typeof delta.content === 'string' && delta.content) {
        if (textIndex === null) {
          closeThinking(events)
          textIndex = nextIndex++
          textAccum = ''
          events.push({
            type: 'content_block_start',
            index: textIndex,
            content_block: { type: 'text', text: '' },
          })
        }
        textAccum += delta.content
        events.push({
          type: 'content_block_delta',
          index: textIndex,
          delta: { type: 'text_delta', text: delta.content },
        })
      }

      // 工具过程事件
      const toolEvent = choice.server_tool_event ?? delta.server_tool_event
      if (toolEvent) {
        closeThinking(events)
        closeText(events)
        if (toolEvent.type === 'call_started' || toolEvent.type === 'call_completed') {
          const { call } = toolEvent
          if (isServerToolCall(call)) {
            const seen = seenCalls.find((item) => item.call.id === call.id)
            if (seen) {
              seen.call = call
            } else {
              seenCalls.push({ step: toolEvent.step, call })
            }
            if (toolEvent.type === 'call_started') {
              events.push({
                type: 'content_block_start',
                index: nextIndex++,
                content_block: {
                  type: 'server_tool_use',
                  id: call.id,
                  name: call.type,
                  input: toInternalInput(call.action),
                  caller: { type: 'direct' },
                  kind: call.kind,
                },
              })
            } else {
              events.push(toResultBlock(call, nextIndex++))
            }
          }
        }
        // step_reasoning_done：步思考已随 reasoning_content 流过，无需事件
      }

      // 收尾块：finish_reason 非 null
      const finishReason = choice.finish_reason
      if (finishReason) {
        closeThinking(events)
        closeText(events)
        // 完整 server_tool_calls：优先收尾 delta 的原样结构（含 signature），缺失时按已收调用归组
        const raw = delta.server_tool_calls?.length ? delta.server_tool_calls : buildRawCalls()
        if (raw.length) {
          events.push({ type: 'raw_server_tool_calls', calls: raw })
        }
        // 引用：全部注记挂在最后一个文本块上
        if (textIndex !== null) {
          for (const annotation of delta.annotations ?? []) {
            if (annotation?.type === 'url_citation' && annotation.url_citation) {
              events.push({
                type: 'content_block_delta',
                index: textIndex,
                delta: { type: 'citations_delta', citation: toCitation(annotation, textAccum) },
              })
            }
          }
        }
        const title = (delta.title ?? '').trim()
        events.push({
          type: 'message_delta',
          delta: {
            stop_reason: STOP_REASONS[finishReason] ?? 'end_turn',
            stop_sequence: null,
            ...(finishReason === 'content_filter'
              ? { stop_details: { type: 'refusal', category: null, explanation: null } as const }
              : {}),
            ...(title ? { title } : {}),
          },
          usage: toMessageUsage(chunk.usage),
        })
      }
      return events
    },
  }
}

/**
 * POST /chat/completions（stream: true），逐个产出内部流式事件，[DONE] 时结束。
 * 与旧 anthropic 实现同形：ping/保活注释与无法解析的内容不产出；中止时抛出 signal 的 AbortError。
 */
export async function* streamChatCompletion(
  apiKey: string,
  body: CreateMessageRequest,
  signal: AbortSignal
): AsyncGenerator<MessageStreamEvent> {
  const response = await request(`${API_ORIGIN}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({ ...toWireRequest(body), stream: true }),
    signal,
  })
  const contentType = response.headers.get('Content-Type') ?? ''
  if (!response.body || !contentType.includes('text/event-stream')) {
    throw await readErrorResponse(response, 'protocol', '')
  }
  const translator = createTranslator()
  for await (const { data } of readServerSentEvents(response.body, signal)) {
    if (data === '[DONE]') {
      yield { type: 'message_stop' }
      return
    }
    let payload: unknown
    try {
      payload = JSON.parse(data)
    } catch {
      continue
    }
    if (isErrorBody(payload)) {
      throw new ApiError('stream', payload.error.message)
    }
    const chunk = readChunk(payload)
    if (!chunk) {
      continue
    }
    for (const event of translator.readChunk(chunk)) {
      yield event
    }
  }
  // 服务端没有提供错误内容时保持为空，不推测断流原因。
  throw new ApiError('interrupted', '')
}
