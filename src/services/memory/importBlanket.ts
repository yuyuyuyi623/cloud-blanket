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
  loadAttachmentsFromReader,
  loadSessionsFromReader,
  chunkMessagesWithQuota,
  type LoadResult,
  type ParsedSession,
} from '../../../engine/parse.js'
import { renderBlockText, runDistill, type DistillBlockInput, type DistillRunResult, type DistillProgress } from '../../../engine/distill.js'
import { runPersonaDistill } from '../../../engine/persona-distill.js'
import { clipMaterialAttachment, type AttachmentDoc } from '../../../engine/attachment-scan.js'
import { collectSessionTexts } from '../../../engine/content-search.js'
import { normalizePack, normalizeSeedTurns, type SeedTurn } from '../../../engine/pack.js'
import { SEED_TURNS_ROUNDS } from '../../../engine/config.js'
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
 * 粗扫附件（附件进蒸馏方案 §3.2 第一层）：只读文本类附件，图片/PDF 全跳过。
 * 放在粗扫阶段做的理由：确认页要按附件字数出预估，钱花之前就得看见数字。
 */
export const scanArchiveAttachments = (file: File): Promise<AttachmentDoc[]> =>
  loadAttachmentsFromReader(fileRangeReader(file)).then((result) => result.docs)

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

/**
 * B 路（普通资料）拼进消息：单件裁到 2 万字（按句读），拼到引用它的那条用户消息后面。
 * 找不到对应消息（老包没有 export_path）就拼到该会话第一条用户消息上。
 * 不修改原对象：返回新数组，预估与实际蒸馏共用同一份拼装结果（两处口径必须是同一个）。
 */
const mergeMaterialDocs = (
  sessions: ParsedSession[],
  docs: AttachmentDoc[],
): ParsedSession[] => {
  if (!docs.length) {
    return sessions
  }
  return sessions.map((session) => {
    const material = docs.filter((doc) => doc.sessionId === session.id && doc.tag === 'material' && doc.text.trim())
    if (!material.length) {
      return session
    }
    const messages = session.messages.map((message) => ({ ...message }))
    for (const doc of material) {
      const target =
        messages.find(
          (message) =>
            message.role === 'user' &&
            message.files?.some((file) => file.name === doc.name || file.path.endsWith(doc.name)),
        ) ?? messages.find((message) => message.role === 'user')
      if (!target) {
        continue
      }
      const piece = `〔附件：${doc.name}〕\n${clipMaterialAttachment(doc.text)}`
      target.text = target.text ? `${target.text}\n\n${piece}` : piece
    }
    return { ...session, messages, words: messages.reduce((sum, m) => sum + m.text.length, 0) }
  })
}

/** 勾选的会话 → 计划行与预估（金额/时长口径只在 engine/estimate 里有一份） */
export const buildPlan = (sessions: ParsedSession[], attachmentDocs: AttachmentDoc[] = []): ImportPlan => {
  const effective = mergeMaterialDocs(sessions, attachmentDocs)
  const rows: PlanRow[] = effective.map((session) => ({
    sessionId: session.id,
    title: session.title,
    userTurns: session.userTurns,
    words: session.words,
    blocks: roughBlocks(session.words),
  }))
  // A 路身世文档单独计块：它不走对话块，但钱是实打实要花的
  const personaDocs = attachmentDocs.filter((doc) => doc.tag === 'persona' && doc.text)
  const personaWords = personaDocs.reduce((sum, doc) => sum + doc.words, 0)
  if (personaWords > 0) {
    rows.push({
      sessionId: '__attachments__',
      title: '身世文档',
      userTurns: 0,
      words: personaWords,
      blocks: roughBlocks(personaWords),
    })
  }
  return { rows, estimate: estimateDistill(rows) }
}

/** 选中的会话 + 附件 → 蒸馏块（B 路先拼进消息，再按消息边界切；一条消息不劈两半） */
export const buildBlocks = (
  sessions: ParsedSession[],
  attachmentDocs: AttachmentDoc[] = [],
): DistillBlockInput[] => {
  const blocks: DistillBlockInput[] = []
  for (const session of mergeMaterialDocs(sessions, attachmentDocs)) {
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

/**
 * 从解析后的原料里切续接历史（A6，2026-11-25 拍板）。
 *
 * 为什么在 App 侧切、不在 engine 切：engine 拿到的是拼好的纯文本块，
 * 切不出干净的消息边界（对齐文档冲突 2）。
 *
 * 三条纪律：
 *   - 多会话**跨会话按时间合并**，排序用每条消息自己的 `at`（不是会话级 updatedAt——
 *     同一天几个会话交错时，会话级时间戳只能说明"最近一条在哪"，排不出正确顺序）；
 *   - 取末尾 SEED_TURNS_ROUNDS 轮的原封文本，不改写、不摘要；
 *   - 一律过脱敏（在 normalizeSeedTurns 里做，幂等）。
 */
export const pickSeedTurns = (sessions: ParsedSession[]): SeedTurn[] => {
  const all: SeedTurn[] = sessions.flatMap((session) =>
    session.messages.map((m) => ({ role: m.role, text: m.text, at: m.at }))
  )
  // 稳定排序：时间相同的保持原顺序（sort 在 V8 上已稳定，这里仍显式比较避免解析失败乱序）
  all.sort((a, b) => (Date.parse(a.at ?? '') || 0) - (Date.parse(b.at ?? '') || 0))
  return normalizeSeedTurns(all.slice(-SEED_TURNS_ROUNDS * 2))
}

export interface BlanketDistillOptions {
  apiKey: string
  /** 附件（两路都从这进：A 路走人设蒸，B 路随对话块蒸） */
  attachmentDocs?: AttachmentDoc[]
  onProgress?: (progress: DistillProgress) => void
}

/**
 * 跑蒸馏。失败时抛 engine 的 LlmError（块号写在 message 里，界面直接显示）。
 * 这里不做重试——重试在 engine 内部按块做，外面再套一层会放大限流。
 *
 * 顺序：身世通道（A 路）先跑 → 对话块 + 汇总（B 路已拼在消息里）。
 * 先跑身世的原因：它决定"她是谁"，且进度条上先走的这一段自然对应"先读设定再读聊天"。
 */
export const runBlanketDistill = async (
  sessions: ParsedSession[],
  options: BlanketDistillOptions
): Promise<DistillRunResult> => {
  const docs = options.attachmentDocs ?? []
  const blocks = buildBlocks(sessions, docs)
  if (!blocks.length) {
    throw new Error('选中的会话里没有可蒸馏的正文')
  }
  const client = createDeepseekClient({ apiKey: options.apiKey })
  const personaDocs = docs.filter((doc) => doc.tag === 'persona' && doc.text)
  // 进度时间锚点固定：UI 的"已用 6:12"靠 startedAt 算，不能每次回调都刷新
  const personaStartedAt = Date.now()
  const personaResult = personaDocs.length
    ? await runPersonaDistill(client, personaDocs, {
        onProgress: (p) =>
          options.onProgress?.({
            phase: 'blocks',
            done: p.done,
            total: p.total,
            startedAt: personaStartedAt,
            running: [],
            runningSince: null,
            lastBlockMs: null,
          }),
      })
    : null
  const result = await runDistill(client, blocks, { onProgress: options.onProgress })
  // seed 不走模型、不新增调用：直接从原料末尾原封截（方案 §6.1）
  const seedTurns = pickSeedTurns(sessions)
  const pack = normalizePack({
    ...result.pack,
    ...(personaResult?.personaCard
      ? { persona: { ...result.pack.persona, card: personaResult.personaCard } }
      : {}),
    ...(personaResult?.backstory ? { backstory: personaResult.backstory } : {}),
    seedTurns,
  })
  const usage = personaResult
    ? {
        promptTokens: result.usage.promptTokens + personaResult.usage.promptTokens,
        completionTokens: result.usage.completionTokens + personaResult.usage.completionTokens,
      }
    : result.usage
  return { ...result, pack, usage }
}
