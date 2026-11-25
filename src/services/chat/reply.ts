import {
  CONTEXT_BUDGET_SAFETY_RATIO,
  CONTEXT_BUDGET_TOKENS,
  MAX_HISTORY_ROUNDS,
  TOKENS_PER_CHAR,
} from '../../../engine/config.js'
import { toWireAction } from '../api/chatCompletions.js'
import type {
  FileBlockParam,
  MessageParam,
  MessageStreamEvent,
  OutputBlockStart,
  ServerToolCall,
  ServerToolCallStep,
} from '../api/types.js'
import type {
  AssistantMessage,
  FileAttachment,
  Message,
  ReplyBlock,
  ReplyStatus,
  UserMessage,
} from './types.js'

/**
 * 文件按 Files API 的 file_id（附件的 serverId）引用：图片用 image 块，其余用 document 块。
 * 发送前 streamReply 会先补齐 serverId；仍为 null 的是本地没有原件的附件，不进入请求。
 */
const toFileBlocks = (files: FileAttachment[]): FileBlockParam[] =>
  files.flatMap(({ serverId, isImage }) =>
    serverId
      ? [
          {
            type: isImage ? 'image' : 'document',
            source: { type: 'file', file_id: serverId },
          },
        ]
      : []
  )

const toReplyBlock = (block: OutputBlockStart, now: number): ReplyBlock | null => {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text, citations: block.citations ?? [] }
    case 'thinking':
      return {
        type: 'thinking',
        thinking: block.thinking,
        signature: block.signature,
        startedAt: now,
      }
    case 'server_tool_use':
    case 'web_search_tool_result':
    case 'web_fetch_tool_result':
      return block
    default:
      return null
  }
}

const updateBlock = (
  reply: AssistantMessage,
  index: number,
  update: (block: ReplyBlock) => ReplyBlock
): AssistantMessage => {
  const block = reply.blocks[index]
  if (!block) {
    return reply
  }
  const blocks = [...reply.blocks]
  blocks[index] = update(block)
  return { ...reply, blocks }
}

/**
 * 把一个流式事件合并进回复：只追加可识别的内容块，用本次请求的临时索引映射处理增量。
 * 跳过的块不占位；续写直接追加到已有内容之后，message_delta 更新结束原因与累计用量。
 */
export const applyEvent = (
  reply: AssistantMessage,
  event: MessageStreamEvent,
  now: number,
  blockIndexes: Map<number, number>
): AssistantMessage => {
  const next: AssistantMessage =
    reply.status === 'streaming' ? reply : { ...reply, status: 'streaming' }
  switch (event.type) {
    case 'message_start':
      return { ...next, usage: event.message.usage ?? next.usage }
    case 'content_block_start': {
      blockIndexes.delete(event.index)
      const block = toReplyBlock(event.content_block, now)
      if (!block) {
        // 客户端工具内容不保存；未完成的工具往返也不能作为续写前缀。
        return event.content_block.type === 'tool_use' ? { ...next, prefix: false } : next
      }
      blockIndexes.set(event.index, next.blocks.length)
      return { ...next, blocks: [...next.blocks, block] }
    }
    case 'content_block_delta': {
      const index = blockIndexes.get(event.index)
      if (index === undefined) {
        return next
      }
      const { delta } = event
      return updateBlock(next, index, (block) => {
        if (block.type === 'text' && delta.type === 'text_delta') {
          return { ...block, text: block.text + delta.text }
        }
        if (block.type === 'thinking' && delta.type === 'thinking_delta') {
          return { ...block, thinking: block.thinking + delta.thinking }
        }
        if (block.type === 'thinking' && delta.type === 'signature_delta') {
          return { ...block, signature: (block.signature ?? '') + delta.signature }
        }
        if (block.type === 'text' && delta.type === 'citations_delta') {
          return { ...block, citations: [...(block.citations ?? []), delta.citation] }
        }
        return block
      })
    }
    case 'content_block_stop': {
      const index = blockIndexes.get(event.index)
      if (index === undefined) {
        return next
      }
      blockIndexes.delete(event.index)
      return updateBlock(next, index, (block) =>
        block.type === 'thinking' && block.startedAt !== undefined && block.endedAt === undefined
          ? { ...block, endedAt: now }
          : block
      )
    }
    case 'message_delta':
      return {
        ...next,
        stopReason: event.delta.stop_reason,
        stopDetails: event.delta.stop_details,
        usage: event.usage ?? next.usage,
      }
    case 'raw_server_tool_calls':
      // 本轮完整的服务端工具调用（含流式事件不带走的 signature），回传时原样重发
      return { ...next, serverToolCalls: event.calls }
    default:
      return next
  }
}

/**
 * 回复结束：未结束的思考块以当前时间收尾。
 * 安全拒绝（stop_reason: refusal）时已下发的思考与正文不能撤回，按协议要求由客户端丢弃，只保留工具块。
 */
export const settleReply = (
  reply: AssistantMessage,
  status: Extract<ReplyStatus, 'done' | 'stopped' | 'error'>,
  now: number,
  error?: AssistantMessage['error']
): AssistantMessage => ({
  ...reply,
  status,
  error,
  blocks: reply.blocks.flatMap((block): ReplyBlock[] => {
    if (reply.stopReason === 'refusal' && (block.type === 'thinking' || block.type === 'text')) {
      return []
    }
    return block.type === 'thinking' && block.startedAt !== undefined && block.endedAt === undefined
      ? [{ ...block, endedAt: now }]
      : [block]
  }),
})

/** 回复里所有文本块拼起来，用于复制与判断是否有回答 */
export const getReplyText = (reply: AssistantMessage) =>
  reply.blocks.map((block) => (block.type === 'text' ? block.text : '')).join('')

/**
 * 只有正常达到输出上限或被停止的回复可续写，报错回复不能续写。
 * 末条限制由调用方判断，拒绝和客户端工具调用不能续写。
 * 本轮含服务端工具调用或结果（含 READ_LINK 和孤立结果块）的回复不能续写。
 * 服务端模板提示不能作为续写前缀。
 */
export const canContinueReply = (reply: AssistantMessage): boolean => {
  if (
    !reply.prefix ||
    reply.stopReason === 'refusal' ||
    reply.stopReason === 'tool_use' ||
    reply.blocks.some(
      (block) =>
        block.type === 'server_tool_use' ||
        block.type === 'web_search_tool_result' ||
        block.type === 'web_fetch_tool_result' ||
        (block.type === 'text' && block.isTemplate)
    )
  ) {
    return false
  }
  return (
    reply.status === 'stopped' ||
    (reply.status === 'done' && reply.stopReason === 'max_tokens')
  )
}

/**
 * 已结束或停止且有回答文本的回复才放进上下文；被安全拒绝的轮次不回传。
 * 服务端模板提示不进入上下文。
 */
const isUsableReply = (message: Message): message is AssistantMessage =>
  message.role === 'assistant' &&
  (message.status === 'done' || message.status === 'stopped') &&
  message.stopReason !== 'refusal' &&
  !message.blocks.some((block) => block.type === 'text' && block.isTemplate) &&
  getReplyText(message) !== ''

/** 有文件时用内容块数组：先文件后文本，文件按 Files API 的 file_id 引用 */
const toUserParam = ({ content, files }: UserMessage): MessageParam => {
  const blocks = toFileBlocks(files)
  return blocks.length === 0
    ? { role: 'user', content }
    : {
        role: 'user',
        content: [...blocks, ...(content ? [{ type: 'text' as const, text: content }] : [])],
      }
}

/**
 * 旧数据（anthropic 端点时期）的回复没有 serverToolCalls 快照；从内容块重建，
 * 让历史轮里阅读过的网页（靠 signature）不丢上下文。每步一个调用，步思考无法还原留空。
 */
const serverToolCallsFromBlocks = (blocks: ReplyBlock[]): ServerToolCallStep[] => {
  const results = new Map(
    blocks.flatMap((block) =>
      block.type === 'web_search_tool_result' || block.type === 'web_fetch_tool_result'
        ? [[block.tool_use_id, block]]
        : []
    )
  )
  const steps: ServerToolCallStep[] = []
  for (const block of blocks) {
    if (block.type !== 'server_tool_use') {
      continue
    }
    const result = results.get(block.id)
    let call: ServerToolCall
    if (result?.type === 'web_search_tool_result') {
      const error = result.content.find((item) => item.type === 'web_search_tool_result_error')
      call = {
        index: 0,
        id: block.id,
        type: block.name,
        kind: block.kind,
        action: toWireAction(block.input),
        status: error ? 'failed' : 'completed',
        ...(error
          ? { error: { code: 'unavailable' } }
          : {
              sources: result.content.flatMap((item) =>
                item.type === 'web_search_result'
                  ? [
                      {
                        type: 'url' as const,
                        url: item.url,
                        title: item.title,
                        snippet: item.snippet,
                        site_name: item.site_name,
                        site_icon: item.site_icon,
                        published_at: item.page_age,
                        ...(item.image_url ? { image_url: item.image_url } : {}),
                      },
                    ]
                  : []
              ),
            }),
      }
    } else if (result?.type === 'web_fetch_tool_result') {
      call = {
        index: 0,
        id: block.id,
        type: block.name,
        kind: block.kind,
        action: toWireAction(block.input),
        status: result.content.type === 'web_fetch_tool_result_error' ? 'failed' : 'completed',
        ...(result.content.type === 'web_fetch_tool_result_error'
          ? { error: { code: result.content.error_code } }
          : {
              page: {
                url: result.content.url,
                title: result.content.content.title,
                published_at: result.content.published_at,
              },
              ...(result.signature?.trim() ? { signature: result.signature } : {}),
            }),
      }
    } else {
      // 只有调用没有结果：按未完成处理
      call = {
        index: 0,
        id: block.id,
        type: block.name,
        kind: block.kind,
        action: toWireAction(block.input),
        status: 'failed',
        error: { code: 'unavailable' },
      }
    }
    steps.push({ index: steps.length, reasoning_content: '', calls: [call] })
  }
  return steps
}

/**
 * assistant 历史轮转换（OpenAI 线格式）：文本块相邻直接拼接、被思考或工具隔开的用空行连接；
 * 历史思考不回传（线格式没有思考块）；工具调用回传原样 server_tool_calls。
 */
const toAssistantParam = (
  { blocks, serverToolCalls }: AssistantMessage,
  prefix = false
): Extract<MessageParam, { role: 'assistant' }> => {
  let content = ''
  let previousWasText = false
  for (const block of blocks) {
    if (block.type === 'text') {
      content += previousWasText ? block.text : `${content ? '\n\n' : ''}${block.text}`
      previousWasText = true
      continue
    }
    previousWasText = false
  }
  const calls = serverToolCalls ?? serverToolCallsFromBlocks(blocks)
  return {
    role: 'assistant',
    content,
    ...(calls.length ? { server_tool_calls: calls } : {}),
    ...(prefix ? { prefix: true as const } : {}),
  }
}

/** 历史中会进入请求上下文的轮次：提问后紧跟可用回答的才保留 */
export const getContextRounds = (history: Message[]): [UserMessage, AssistantMessage][] => {
  const rounds: [UserMessage, AssistantMessage][] = []
  for (let i = 0; i + 1 < history.length; i++) {
    const [user, reply] = [history[i], history[i + 1]]
    if (user.role === 'user' && isUsableReply(reply)) {
      rounds.push([user, reply])
      i++
    }
  }
  return rounds
}

/**
 * 历史预算（A4 预算执行器，2026-11-25 拍板）：
 * 稳定段冻结、动态段本轮现算，两者都不许被历史挤掉——只剩多少，历史就用多少。
 */
export interface HistoryBudget {
  /** 稳定段 + 动态段已占的 token（调用方拿真实文本估算后传进来） */
  reservedTokens: number
  /** 整轮请求预算；缺省 = CONTEXT_BUDGET_TOKENS × 安全余量（≈6300） */
  budgetTokens?: number
}

/**
 * 文本 → 粗估 token。仓库没有 tokenizer，TOKENS_PER_CHAR=0.7 在边界上偏 5~10%，
 * 所以执行时按 6300 装（config 的 CONTEXT_BUDGET_SAFETY_RATIO）。
 */
export const estimateTokens = (text: string): number => Math.ceil(text.length * TOKENS_PER_CHAR)

/** 单条请求消息的估算：文件块只算 file_id 引用，图片真值交给服务端 */
export const estimateMessageTokens = (message: MessageParam): number =>
  estimateTokens(
    typeof message.content === 'string'
      ? message.content
      : message.content.map((block) => (block.type === 'text' ? block.text : '')).join('')
  )

/**
 * 从最近一轮往回装（文档 §10.4 第 2 条：装不下就停，不是装完再裁——裁完会剩半轮对话）。
 * 一轮装不下就整轮不进；轮数同时受 MAX_HISTORY_ROUNDS 约束。
 * seed（续接历史）是最老的一段：预算不够先丢它，从最老一条开始丢（方案 §4.3）。
 */
const limitRoundsByBudget = (
  groups: MessageParam[][],
  question: MessageParam,
  prefix: MessageParam | undefined,
  budget: HistoryBudget,
  seed: MessageParam[]
): { kept: MessageParam[][]; seed: MessageParam[] } => {
  const total = budget.budgetTokens ?? Math.floor(CONTEXT_BUDGET_TOKENS * CONTEXT_BUDGET_SAFETY_RATIO)
  const costOf = (list: MessageParam[]) =>
    list.reduce((sum, message) => sum + estimateMessageTokens(message), 0)
  const fixed =
    budget.reservedTokens +
    estimateMessageTokens(question) +
    (prefix ? estimateMessageTokens(prefix) : 0)
  let available = total - fixed

  const seedKept = [...seed]
  while (seedKept.length > 0 && costOf(seedKept) > available) {
    seedKept.shift()
  }
  // 头部落在 assistant 上服务端会 400：连着丢到 user 为止
  while (seedKept[0]?.role === 'assistant') {
    seedKept.shift()
  }
  available -= costOf(seedKept)

  const kept: MessageParam[][] = []
  let used = 0
  for (let i = groups.length - 1; i >= 0; i--) {
    if (kept.length >= MAX_HISTORY_ROUNDS) {
      break
    }
    const group = groups[i]
    const cost = costOf(group)
    if (used + cost > available) {
      break
    }
    kept.unshift(group)
    used += cost
  }
  return { kept, seed: seedKept }
}

/**
 * 把会话转成请求的 messages：只保留「提问 + 有回答的回复」成对的轮次，最后接上本轮提问。
 * 失败或没有回答的轮次不进上下文。续写时末尾再带上本轮 assistant（带 prefix 标记）。
 *
 * 传入 budget 时先按预算裁历史（A4，2026-11-25 拍板）：
 *   - 稳定段（冻结）+ 动态段（本轮）+ 本轮提问先占，剩下的才给历史；
 *   - 从最近一轮往回装，装不下就停——**整轮进出，不拆半轮**（拆了她会接不上话）；
 *   - 轮数另受 MAX_HISTORY_ROUNDS 约束（B1 滑窗定稿，不放宽）。
 * 不传 budget = 官方原样（普通模式：明码标价，不替用户做裁剪决定）。
 */
export const toRequestMessages = (
  history: Message[],
  question: UserMessage,
  prefix?: AssistantMessage,
  latestReminder?: string,
  budget?: HistoryBudget,
  seedTurns?: readonly { role: 'user' | 'assistant'; text: string }[]
): MessageParam[] => {
  // 一轮一组：提醒快照跟着它所属的那一轮走，裁轮次时一起进一起出
  const groups: MessageParam[][] = []
  for (const [user, reply] of getContextRounds(history)) {
    // 历史提问没有文字、附件也都没有 serverId 时，提问为空，连同回答一起省略。
    if (!user.content && toFileBlocks(user.files).length === 0) {
      continue
    }
    const group: MessageParam[] = []
    if (reply.latestReminder) {
      group.push({ role: 'latest_reminder', content: reply.latestReminder })
    }
    group.push(toUserParam(user), toAssistantParam(reply))
    groups.push(group)
  }

  const questionParam = toUserParam(question)
  const prefixParam = prefix?.prefix ? toAssistantParam(prefix, true) : undefined
  // 没有非空白正文时直接重发原问题，避免服务端拒绝空前缀。
  const usablePrefix = prefixParam?.content.trim() ? prefixParam : undefined

  // 续接历史（v1.0.2 层二）：原封拼在真实历史前面，是最老的一段——预算不够时先丢它。
  // 头部落在 assistant 上服务端会 400，无论裁不裁都先对齐到 user。
  const seedParams: MessageParam[] = (seedTurns ?? []).map((t) => ({ role: t.role, content: t.text }))
  while (seedParams[0]?.role === 'assistant') {
    seedParams.shift()
  }

  let kept = groups
  let seedKept = seedParams
  if (budget) {
    const limited = limitRoundsByBudget(groups, questionParam, usablePrefix, budget, seedParams)
    kept = limited.kept
    seedKept = limited.seed
  }

  const messages: MessageParam[] = [...seedKept]
  let previousReminder: string | undefined
  const appendReminder = (reminder: string | undefined) => {
    // 仅在当前分支首次出现或内容变化时插入快照；缺少快照的消息保持原有内容。
    if (reminder && reminder !== previousReminder) {
      messages.push({ role: 'latest_reminder', content: reminder })
      previousReminder = reminder
    }
  }
  for (const group of kept) {
    for (const param of group) {
      if (param.role === 'latest_reminder') {
        appendReminder(param.content)
      } else {
        messages.push(param)
      }
    }
  }
  appendReminder(latestReminder)
  messages.push(questionParam)
  if (usablePrefix) {
    messages.push(usablePrefix)
  }
  return messages
}


/** 思考用时（秒），至少 1 秒 */
export const getThinkingSeconds = (startedAt: number, endedAt: number) =>
  Math.max(1, Math.round((endedAt - startedAt) / 1000))
