/**
 * 导入聊天记录 → 盖成被子：数据侧编排。
 *
 * 三段式（每一步都可单测，UI 只管调）：
 *   1. 粗扫 scanArchive：只读统计（标题/轮数/字数），不读正文细节——几百个会话也能秒出列表；
 *   2. 估算 buildPlan：勾选的会话 → 块数/金额/时长（公式全在 engine/estimate，这里不重复算）；
 *   3. 细读 + 蒸馏 runBlanketDistill：只读选中的会话正文 → 切块 → 调模型 → 记忆包。
 *
 * 为什么用 RangeReader 而不是整包读进内存：手机 JS 堆约 400MB，300MB 导出包
 * 整包 bytes() 会直接 OutOfMemory（2026-11-22 真机实测）。
 */

import type { Session } from '../chat/types.js'
import type { RangeReader } from '../../../engine/zip-reader.js'
import {
  loadSessionsFromReader,
  chunkMessagesWithQuota,
  type LoadResult,
  type ParsedSession,
} from '../../../engine/parse.js'
import { renderBlockText, runDistill, type DistillBlockInput, type DistillRunResult, type DistillProgress } from '../../../engine/distill.js'
import { collectSessionTexts } from '../../../engine/content-search.js'
import { createDeepseekClient } from '../../../engine/deepseek.js'
import {
  estimateDistill,
  roughBlocks,
  type DistillEstimate,
  type PlanRow,
} from '../../../engine/estimate.js'

/**
 * 浏览器 File → 有界读取器。只读需要的字节，不把整个 ZIP 读进内存。
 * （engine 侧的 RangeReader 是为"任意能按位置读 N 字节的东西"设计的，这是 Web 实现。）
 */
export const fileRangeReader = (file: Blob): RangeReader => ({
  size: file.size,
  readRange: async (start: number, length: number) => {
    const end = Math.min(start + length, file.size)
    const buffer = await file.slice(start, end).arrayBuffer()
    return new Uint8Array(buffer)
  },
})

/** 粗扫：拿会话清单与统计（不保留正文，省内存）；每解析完一个会话回调一次进度 */
export const scanArchive = (
  file: File,
  onProgress?: (done: number, total: number) => void
): Promise<LoadResult> =>
  loadSessionsFromReader(fileRangeReader(file), { withMessages: false, onProgress })

/** 细读：只解析选中的那些会话，带正文（蒸馏用） */
export const readSelectedSessions = (file: File, sessionIds: Set<string>): Promise<LoadResult> =>
  loadSessionsFromReader(fileRangeReader(file), { withMessages: true, onlyIds: sessionIds })

/**
 * 内容搜索用：把整包正文读成 sessionId → 纯文本（每会话约 1 万字，全库十几 MB）。
 * 只在用户真的去搜"她说过的一句话"时调一次，之后搜索走内存子串扫描。
 */
export const collectSessionTextsFromFile = (
  file: File,
  onProgress?: (done: number, total: number) => void
): Promise<Map<string, string>> =>
  collectSessionTexts(fileRangeReader(file), { concurrency: 4, onProgress })

export interface ImportPlan {
  rows: PlanRow[]
  estimate: DistillEstimate
}

/** 勾选的会话 → 计划行与预估（金额/时长口径只在 engine/estimate 里有一份） */
export const buildPlan = (sessions: ParsedSession[]): ImportPlan => {
  const rows: PlanRow[] = sessions.map((session) => ({
    sessionId: session.id,
    title: session.title,
    userTurns: session.userTurns,
    words: session.words,
    blocks: roughBlocks(session.words),
  }))
  return { rows, estimate: estimateDistill(rows) }
}

/** 选中的会话 → 蒸馏块（按消息边界切，一条消息不劈两半；块配额按时间三段递增，A7-B） */
export const buildBlocks = (sessions: ParsedSession[]): DistillBlockInput[] => {
  const blocks: DistillBlockInput[] = []
  for (const session of sessions) {
    for (const chunk of chunkMessagesWithQuota(session.messages)) {
      blocks.push({
        blockIndex: blocks.length,
        text: renderBlockText(chunk.messages),
        firstAt: chunk.firstAt,
        lastAt: chunk.lastAt,
      })
    }
  }
  return blocks
}

/** 导出格式的会话 → 本地会话（原文入库给检索用；助手只保留正文块） */
export const parsedToSession = (parsed: ParsedSession): Session => {
  const fallback = Date.parse(parsed.firstAt) || Date.now()
  const messages = parsed.messages.map((message, index) => {
    const createdAt = Date.parse(message.at) || fallback
    const id = `${parsed.id}-${index}`
    if (message.role === 'user') {
      return { id, role: 'user' as const, content: message.text, files: [], createdAt }
    }
    return {
      id,
      role: 'assistant' as const,
      createdAt,
      model: null,
      prefix: false,
      status: 'done' as const,
      blocks: [{ type: 'text' as const, text: message.text }],
    }
  })
  const created = Date.parse(parsed.firstAt) || fallback
  const updated = Date.parse(parsed.lastAt) || created
  return {
    id: parsed.id,
    // 导出包里常见空标题/纯空白标题，直接留空列表里会是一行空白
    title: parsed.title.trim() || '未命名对话',
    createdAt: created,
    updatedAt: updated,
    messages,
  }
}

export interface BlanketDistillOptions {
  apiKey: string
  onProgress?: (progress: DistillProgress) => void
}

/**
 * 跑蒸馏。失败时抛 engine 的 LlmError（块号写在 message 里，界面直接显示）。
 * 这里不做重试——重试在 engine 内部按块做，外面再套一层会放大限流。
 */
export const runBlanketDistill = async (
  sessions: ParsedSession[],
  options: BlanketDistillOptions
): Promise<DistillRunResult> => {
  const blocks = buildBlocks(sessions)
  if (!blocks.length) {
    throw new Error('选中的会话里没有可蒸馏的正文')
  }
  const client = createDeepseekClient({ apiKey: options.apiKey })
  return runDistill(client, blocks, { onProgress: options.onProgress })
}
