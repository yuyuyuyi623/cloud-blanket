/**
 * 记忆巩固执行层（记忆巩固方案-2026-11-24，v1.0.1）。
 *
 * 口径（全部来自方案拍板，别在这改）：
 *   - 后台全自动、零用户操作；水位幂等（同批消息巩固两次，第二次零新增）；
 *   - append-only 红线：事件/事实/核心记忆只增不删不改——模型输出里的 forget 与
 *     "替换核心"类动作在这里一律忽略（engine 里那套带 forget 的旧合并路径已在
 *     v1.0.2 死路径清理中删掉，合并逻辑就这一份）；
 *   - 冻结区（persona.card / diary）零接触；唯一例外是「整体印象」impression，
 *     impressionAuto 为 true 时整格重写；
 *   - 失败静默：不弹窗、水位不推进、下次触发自动重试；事务性 = pack 与水位合成
 *     同一条记录一次 saveBlanket，失败两者都不动；
 *   - 账本记一笔（模式 'consolidate'），prompt 全按未命中价保守计。
 *
 * 触发点（接线见调用方）：被子回复完成后 + 应用打开时；requestIdleCallback 空闲跑。
 */

import {
  CONSOLIDATION_MAX_TOKENS,
  CONSOLIDATION_TEMPERATURE,
  EPISODES_CHARS,
  IMPRESSION_CHARS,
  TOKENS_PER_CHAR,
} from '../../../engine/config.js'
import {
  buildConsolidationMessages,
  type ConsolidationOutput,
  type RecentLine,
} from '../../../engine/consolidation.js'
import { createDeepseekClient, parseJsonObject } from '../../../engine/deepseek.js'
import {
  normalizeCoreMemories,
  normalizeEpisodes,
  normalizeFacts,
  normalizePack,
  type MemoryPack,
} from '../../../engine/pack.js'
import { estimateCost, isPeakHours, recordConsolidationUsage } from '../usage/ledger.js'
import { useSettings } from '../settings.js'
import { saveBlanket } from '../chat/db.js'
import { messageText, type BlanketRecord } from './blanket.js'
import type { Session } from '../chat/types.js'
import { invalidateBlanket } from './load.js'
import { refreshBlankets, useBlankets } from './blanketStore.js'
import { create } from 'zustand'

// ── 阈值（方案 §3.1：80 条或 2 万字，先到为准；常量可调）──────

export const CONSOLIDATE_MIN_MESSAGES = 80
export const CONSOLIDATE_MIN_CHARS = 20_000
/** 连续失败多少次后，她的角落给一行被动提示（方案 §3.5） */
export const CONSOLIDATION_FAILURE_ALERT = 3

// ── 巩固状态（她的角落"巩固中…"与失败提示读这里）────────────

interface ConsolidationState {
  /** 正在巩固的被子 id（in-flight 互斥，防连点/防重入） */
  running: Record<string, true>
  /** 连续失败计数；成功一次即清零 */
  failures: Record<string, number>
}

export const useConsolidation = create<ConsolidationState>(() => ({ running: {}, failures: {} }))

// ── 纯函数（单测覆盖）────────────────────────────────────────

export interface ConsolidationDelta {
  /** 水位之后的新增消息（渲染成 engine 的 RecentLine；空文本不进，与检索口径一致） */
  lines: RecentLine[]
  /** 新增条数（只算有文本的消息） */
  count: number
  /** 新增总字数 */
  chars: number
}

/** 水位之后的巩固增量。水位 = 巩固时的 session.messages.length 快照。 */
export const consolidationDelta = (session: Session, watermark: number): ConsolidationDelta => {
  const lines: RecentLine[] = []
  let chars = 0
  for (let i = Math.max(0, watermark); i < session.messages.length; i++) {
    const message = session.messages[i]
    const text = messageText(message)
    if (!text) {
      continue
    }
    lines.push({
      role: message.role === 'user' ? 'user' : 'assistant',
      text,
      at: new Date(message.createdAt).toISOString(),
    })
    chars += text.length
  }
  return { lines, count: lines.length, chars }
}

/** 阈值判定：条数或字数任一达标即触发（§3.1） */
export const shouldAutoConsolidate = (delta: ConsolidationDelta): boolean =>
  delta.count >= CONSOLIDATE_MIN_MESSAGES || delta.chars >= CONSOLIDATE_MIN_CHARS

const asStringList = (raw: unknown): string[] => {
  if (!Array.isArray(raw)) {
    return []
  }
  return raw
    .map((item) => (typeof item === 'string' ? item : String((item as { text?: unknown })?.text ?? '')))
    .map((s) => s.trim())
    .filter(Boolean)
}

export interface ConsolidationMergeResult {
  pack: MemoryPack
  /** 本次新增的事件条数（她的角落"上次巩固 · 新增 N 条"） */
  newEpisodeCount: number
  /** impression 是否被本次重写 */
  impressionUpdated: boolean
}

/**
 * append-only 合并（§七 红线的落实点）：
 *   - memories：新事件追加，forget 忽略；
 *   - facts：模型已做合并去重，缺数组就原样保留；
 *   - coreMemories：只追加没有的，绝不替换已有（超出上限的新条目丢弃，老核心永不动）；
 *   - impression：impressionAuto 开且模型给了才整格重写；
 *   - persona.card / diary：零接触。
 * 同批消息巩固两次：第二次模型输出重复文本 → normalizeEpisodes 去重 → 零新增（幂等）。
 */
export const mergeConsolidation = (
  pack: MemoryPack,
  output: ConsolidationOutput,
  now: Date,
  options: { impressionAuto: boolean }
): ConsolidationMergeResult => {
  const nowIso = now.toISOString()

  const newEpisodes = asStringList(output.memories)
    .slice(0, 5) // 与 engine NEW_EPISODES_PER_RUN 同口径，单次最多 5 条
    .map((text) => ({ text: text.slice(0, EPISODES_CHARS), at: nowIso }))

  const facts = Array.isArray(output.facts) ? normalizeFacts(output.facts) : pack.facts

  const existingCoreTexts = new Set(pack.coreMemories.map((c) => c.text))
  const newCoreTexts = asStringList(output.coreMemories).filter((t) => !existingCoreTexts.has(t))
  const coreMemories = normalizeCoreMemories([
    ...pack.coreMemories,
    ...newCoreTexts.map((text) => ({ text, at: nowIso })),
  ])

  // 核心条目永远保留在事件层（A3）：先算核心，再按"已进核心"给事件层打 pin
  const memories = normalizeEpisodes([...pack.memories, ...newEpisodes], {
    coreTexts: coreMemories.map((c) => c.text),
  })

  const rawImpression = typeof output.impression === 'string' ? output.impression.trim() : ''
  const impressionUpdated = options.impressionAuto && rawImpression.length > 0
  const impression = impressionUpdated ? rawImpression.slice(0, IMPRESSION_CHARS) : pack.persona.impression

  const nextPack = normalizePack({
    ...pack,
    memories,
    facts,
    coreMemories,
    persona: { ...pack.persona, impression: impression || undefined },
    // ③ 原声红线（2026-11-25 拍板，同轮落地）：voiceSamples 是**冻结区**，
    // 巩固只许原样带过——不读、不写、不合并、不"顺手补一条"。
    // 模型就算在输出里塞了 voiceSamples 也一律无视（唯一合法来源是原始导出包）。
    voiceSamples: pack.voiceSamples,
  })

  return {
    pack: nextPack,
    newEpisodeCount: newEpisodes.length,
    impressionUpdated,
  }
}

/** 手动「立即巩固」的预估金额（确认框展示）。保守口径：按当前峰谷价、输出按 1500 token 估。 */
export const estimateConsolidationCost = (chars: number, now: Date = new Date()): number => {
  const inputTokens = Math.round(chars * TOKENS_PER_CHAR)
  const outputTokens = 1500
  return estimateCost({ hit: 0, miss: inputTokens, completion: outputTokens }, isPeakHours(now))
}

// ── 执行层（副作用）──────────────────────────────────────────

const withoutKey = (record: Record<string, unknown>, key: string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(record).filter(([id]) => id !== key))

const setRunning = (blanketId: string, running: boolean): void => {
  useConsolidation.setState((state) => ({
    ...state,
    running: running
      ? { ...state.running, [blanketId]: true }
      : (withoutKey(state.running, blanketId) as ConsolidationState['running']),
  }))
}

const bumpFailure = (blanketId: string): void => {
  useConsolidation.setState((state) => ({
    ...state,
    failures: { ...state.failures, [blanketId]: (state.failures[blanketId] ?? 0) + 1 },
  }))
}

const clearFailure = (blanketId: string): void => {
  useConsolidation.setState((state) => ({
    ...state,
    failures: withoutKey(state.failures, blanketId) as ConsolidationState['failures'],
  }))
}

/**
 * 跑一次巩固（自动与手动共用同一条管线，方案 §3.4）。
 * 所有失败路径静默：水位不推进、下次触发自动重试。
 */
export const runConsolidation = async (blanketId: string): Promise<void> => {
  if (useConsolidation.getState().running[blanketId]) {
    return // in-flight 互斥：连点只算一次
  }
  const blanket = useBlankets.getState().list.find(
    (item) => item.id === blanketId && item.deletedAt === undefined
  )
  if (!blanket?.chatSessionId) {
    return
  }
  const apiKey = useSettings.getState().apiKey ?? ''
  if (!apiKey) {
    return // 没 Key 静默跳过（首次使用还没配 Key，不该报错）
  }
  const { useChatStore } = await import('../chat/store.js') // 动态引：避免与 store 循环依赖
  const session = useChatStore.getState().sessionCache[blanket.chatSessionId]
  if (!session) {
    return
  }
  const watermark = blanket.lastConsolidatedMsgCount ?? 0
  const delta = consolidationDelta(session, watermark)
  if (!delta.lines.length) {
    return // 待蒸增量为 0：无事可做（幂等基线）
  }

  setRunning(blanketId, true)
  const startTs = Date.now()
  try {
    const client = createDeepseekClient({ apiKey })
    const result = await client.chat(buildConsolidationMessages(blanket.pack, [], delta.lines), {
      maxTokens: CONSOLIDATION_MAX_TOKENS,
      temperature: CONSOLIDATION_TEMPERATURE,
      purpose: 'consolidation',
    })
    const output = parseJsonObject(result.content) as ConsolidationOutput
    const merged = mergeConsolidation(blanket.pack, output, new Date(), {
      impressionAuto: blanket.impressionAuto !== false,
    })
    // 事务性：pack 与水位合成同一条记录，一次 saveBlanket（IndexedDB put 原子）
    const next: BlanketRecord = {
      ...blanket,
      pack: merged.pack,
      lastConsolidatedMsgCount: session.messages.length,
      lastConsolidatedAt: Date.now(),
      lastConsolidatedNewCount: merged.newEpisodeCount,
      updatedAt: Date.now(),
    }
    await saveBlanket(next)
    invalidateBlanket(blanket.id)
    await refreshBlankets()
    clearFailure(blanketId)
    // 账本记一笔（prompt 全按未命中价，保守口径）；拿不到 usage 就按输入字数保守估
    void recordConsolidationUsage(
      result.promptTokens ?? Math.round(delta.chars * TOKENS_PER_CHAR),
      result.completionTokens ?? 0,
      startTs,
      Date.now()
    )
  } catch {
    // 静默失败（网络断/Key 失效/余额不足）：不弹窗，连续 3 次后区块出被动提示
    bumpFailure(blanketId)
  } finally {
    setRunning(blanketId, false)
  }
}

/** 自动触发的统一入口：开关、回收站、in-flight、阈值全查完才排队执行（页面空闲时跑）。 */
export const maybeAutoConsolidate = (blanketId: string): void => {
  const blanket = useBlankets.getState().list.find((item) => item.id === blanketId)
  if (
    !blanket ||
    blanket.deletedAt !== undefined ||
    blanket.autoConsolidate === false ||
    !blanket.chatSessionId ||
    useConsolidation.getState().running[blanketId]
  ) {
    return
  }
  void (async () => {
    const { useChatStore } = await import('../chat/store.js')
    const session = useChatStore.getState().sessionCache[blanket.chatSessionId as string]
    if (!session || !shouldAutoConsolidate(consolidationDelta(session, blanket.lastConsolidatedMsgCount ?? 0))) {
      return
    }
    // 页面空闲时后台跑，不阻塞输入与 SSE（方案 §3.1）
    const kick = () => void runConsolidation(blanketId)
    if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(kick, { timeout: 10_000 })
    } else {
      window.setTimeout(kick, 3_000)
    }
  })()
}

/** 应用打开时的全量检查：逐床在用被子查水位（load 完成后由 App.tsx 调一次）。 */
export const checkAllBlanketsForConsolidation = (): void => {
  for (const item of useBlankets.getState().list) {
    if (item.deletedAt === undefined && item.chatSessionId) {
      maybeAutoConsolidate(item.id)
    }
  }
}
