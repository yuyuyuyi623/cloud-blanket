/**
 * 被子记忆的装配层：IndexedDB 里的被子 + 会话 → 可直接检索的 BlanketMemory。
 *
 * 为什么单独一层：
 *   - 被子记忆要跟着"这床被子蒸了哪些会话"走，装配逻辑落在这，界面与请求层都不用关心；
 *   - 数据源做成可注入（BlanketSource），Node 测试可以不碰 IndexedDB；
 *   - 结果按被子 id 缓存：索引重建是 O(全部消息)，不该每轮都做；
 *     新消息用 syncChatSession 增量补，不重建。
 */

import { loadBlanket, loadBlanketSession, loadSession } from '../chat/db.js'
import type { Session } from '../chat/types.js'
import { BlanketMemory, type BlanketRecord } from './blanket.js'

/** 装配所需的数据来源（生产走 IndexedDB，测试注入假实现） */
export interface BlanketSource {
  loadBlanket(id: string): Promise<BlanketRecord | undefined>
  loadSession(id: string): Promise<Session | undefined>
  /** 蒸进来的原料会话（存在 blanketSessions，不在 sessions 里） */
  loadBlanketSession(blanketId: string, sessionId: string): Promise<Session | undefined>
}

const defaultSource: BlanketSource = { loadBlanket, loadSession, loadBlanketSession }

export interface LoadedBlanket {
  record: BlanketRecord
  memory: BlanketMemory
}

/**
 * 装配一床被子的检索器。
 * 索引范围 = 蒸进来的那些会话 + 被子模式自己的对话框（自己的对话也是"旧事"来源）。
 * 缺少的会话（用户删了、导出包换了）直接跳过——少一段记忆不该让整场对话打不开。
 */
export const buildBlanketMemory = async (
  id: string,
  source: BlanketSource = defaultSource
): Promise<LoadedBlanket | undefined> => {
  const record = await source.loadBlanket(id)
  if (!record) {
    return undefined
  }
  const memory = new BlanketMemory()
  const sessionIds = [
    ...new Set([...record.sessionIds, ...(record.chatSessionId ? [record.chatSessionId] : [])]),
  ]
  for (const sessionId of sessionIds) {
    // 先找普通会话（普通模式转进被子的、被子自己的对话框），再找被子原料会话
    const session =
      (await source.loadSession(sessionId)) ??
      (await source.loadBlanketSession(record.id, sessionId))
    if (session) {
      memory.syncSession(session)
    }
  }
  return { record, memory }
}

/** 已装配的被子按 id 缓存（一个浏览器里的被子数量是个位数，不设上限） */
const cache = new Map<string, LoadedBlanket>()

/** 取被子运行态；第一次取时装配，之后直接命中缓存 */
export const getBlanketMemory = async (
  id: string,
  source: BlanketSource = defaultSource
): Promise<LoadedBlanket | undefined> => {
  const cached = cache.get(id)
  if (cached) {
    return cached
  }
  const loaded = await buildBlanketMemory(id, source)
  if (loaded) {
    cache.set(id, loaded)
  }
  return loaded
}

/**
 * 每轮发送前同步当前对话框（增量：只有新消息真正进索引）。
 * 被子模式里聊出来的新内容，几分钟后就要能被"你还记得刚才…"检索到。
 */
export const syncChatSession = async (blanketId: string, session: Session): Promise<void> => {
  const loaded = await getBlanketMemory(blanketId)
  loaded?.memory.syncSession(session)
}

/** 被子被删、被重蒸、会话被移出时需要丢弃旧索引 */
export const invalidateBlanket = (id: string): void => {
  cache.delete(id)
}
