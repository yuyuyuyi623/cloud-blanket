/**
 * 被子聊天的入口：从被子详情点"开始聊天"之后发生什么。
 *
 * 为什么单独一个文件：store.ts 管发送管线（它会查这个会话属于哪床被子），
 * blanketStore 管被子列表；入口逻辑两边都要摸一点，放中间这里，引用方向是
 * blanketChat → store + blanketStore，没有环。
 */

import { useBlankets } from '../memory/blanketStore.js'
import { armBlanketChat, newChat, selectSession, useChatStore } from './store.js'

/**
 * 打开一床被子的对话框：
 *   · 之前聊过 → 直接回到那个会话（记忆索引还在缓存里，秒开）；
 *   · 没聊过（或会话被删了）→ 记下这床被子再开新对话框，
 *     第一句话发出后 sendMessage 会把新会话绑回被子（见 store.bindBlanketChat）。
 *
 * 两条路都必须留下可见结果：新对话那条路里 activeId 本来就是 null，
 * 光调 newChat 界面一点变化都没有——欢迎页会显示"正在和「XX」聊天"（读 pendingBlanketId）。
 */
export const openBlanketChat = (blanketId: string): void => {
  const record = useBlankets.getState().list.find((item) => item.id === blanketId)
  if (!record) {
    return
  }
  // 会话可能被删进回收站了：列表里没有就当没聊过，重新开一个（回收站还能单独捞回来）
  const sessionId = record.chatSessionId
  if (sessionId && useChatStore.getState().sessions.some((session) => session.id === sessionId)) {
    selectSession(sessionId)
    // 正在导入历史时 selectSession 会被忽略：那就退到新对话入口，别让用户点了没反应
    if (useChatStore.getState().activeId === sessionId) {
      return
    }
  }
  armBlanketChat(record.id)
  newChat()
}
