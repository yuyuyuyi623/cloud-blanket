/**
 * 被子列表状态：侧栏"我的被子"与导入完成后的刷新共用。
 *
 * 删除语义：删 = 进回收站（deletedAt 记时间），30 天后刷新时自动彻底删除；
 * 彻底删除连原料会话一起走。记忆索引的失效交给 load.ts 的 invalidateBlanket，这里不碰检索。
 */

import { create } from 'zustand'
import { deleteBlanket, loadBlankets, saveBlanket } from '../chat/db.js'
import type { BlanketRecord } from './blanket.js'
import { invalidateBlanket } from './load.js'
import type { MemoryPack } from '../../../engine/pack.js'

/** 回收站保留天数：到期自动彻底删除 */
export const TRASH_DAYS = 30

interface BlanketListState {
  /** 全部被子，含回收站里的（deletedAt 有值）；各组件自己按需过滤 */
  list: BlanketRecord[]
  loaded: boolean
}

export const useBlankets = create<BlanketListState>(() => ({ list: [], loaded: false }))

const DAY_MS = 24 * 60 * 60 * 1000

const isExpired = (item: BlanketRecord): boolean =>
  item.deletedAt !== undefined && Date.now() - item.deletedAt >= TRASH_DAYS * DAY_MS

export const refreshBlankets = async (): Promise<void> => {
  const all = await loadBlankets()
  // 到期的回收站被子就地彻底删除（含原料会话），不用等用户再点一次
  const expired = all.filter(isExpired)
  if (expired.length) {
    await Promise.all(expired.map((item) => deleteBlanket(item.id)))
    for (const item of expired) {
      invalidateBlanket(item.id)
    }
  }
  const list = expired.length ? all.filter((item) => !isExpired(item)) : all
  useBlankets.setState({ list, loaded: true })
}

/** 删 = 进回收站：30 天内可恢复，期间不参与对话、不进侧栏。
 * 绑定的对话框一起进左侧普通回收站（对话记录不丢，只是不占列表）。 */
export const removeBlanket = async (id: string): Promise<void> => {
  const current = useBlankets.getState().list.find((item) => item.id === id)
  if (!current || current.deletedAt !== undefined) {
    return
  }
  await saveBlanket({ ...current, deletedAt: Date.now() })
  invalidateBlanket(id)
  await refreshBlankets()
  // 动态 import：chat store 里 import 了 blanketStore，静态引回来就是循环依赖
  const { trashSession, useChatStore } = await import('../chat/store.js')
  if (
    current.chatSessionId &&
    useChatStore.getState().sessions.some((session) => session.id === current.chatSessionId)
  ) {
    await trashSession(current.chatSessionId)
  }
}

/** 从回收站捞回来：清掉删除标记，绑定的对话也跟着回来。 */
export const restoreBlanket = async (id: string): Promise<void> => {
  const current = useBlankets.getState().list.find((item) => item.id === id)
  if (!current || current.deletedAt === undefined) {
    return
  }
  await saveBlanket({ ...current, deletedAt: undefined })
  invalidateBlanket(id)
  await refreshBlankets()
  const { restoreSession, useChatStore } = await import('../chat/store.js')
  if (
    current.chatSessionId &&
    useChatStore.getState().trashedSessions.some((session) => session.id === current.chatSessionId)
  ) {
    await restoreSession(current.chatSessionId)
  }
}

/** 回收站里彻底删除（含原料会话），不可恢复 */
export const purgeBlanket = async (id: string): Promise<void> => {
  const current = useBlankets.getState().list.find((item) => item.id === id)
  await deleteBlanket(id)
  invalidateBlanket(id)
  await refreshBlankets()
  // 彻底删 = 连对话也不留：否则普通回收站里会剩一条以被子命名的孤立对话
  const { removeSession, useChatStore } = await import('../chat/store.js')
  if (
    current?.chatSessionId &&
    useChatStore.getState().trashedSessions.some((session) => session.id === current.chatSessionId)
  ) {
    await removeSession(current.chatSessionId)
  }
}

/** 手改记忆包（角色卡、核心记忆、事实、事件……）：确认页人工修的口子。
 * 先同步改内存再落库——编辑弹窗和下一句对话请求立即可见；
 * 检索缓存同步失效，改完的记忆下一轮就能被搜到。 */
export const updatePack = async (
  id: string,
  mutate: (pack: MemoryPack) => MemoryPack,
): Promise<void> => {
  const current = useBlankets.getState().list.find((item) => item.id === id)
  if (!current) {
    return
  }
  const next: BlanketRecord = {
    ...current,
    pack: mutate(current.pack),
    updatedAt: Date.now(),
  }
  useBlankets.setState((state) => ({
    list: state.list.map((item) => (item.id === id ? next : item)),
  }))
  invalidateBlanket(id)
  await saveBlanket(next)
  await refreshBlankets()
}

/** 这个会话是不是被子模式（绑在某床**在用**的被子上）；回收站里的被子对话退回普通模式 */
export const blanketOfSession = (sessionId: string): BlanketRecord | undefined =>
  useBlankets
    .getState()
    .list.find((blanket) => blanket.chatSessionId === sessionId && blanket.deletedAt === undefined)
