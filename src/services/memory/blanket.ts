/**
 * 被子记忆层：一床被子 = 导入时勾选的那组会话（+ 事后从普通模式转进来的会话）。
 *
 * 职责边界：
 *   - 本文件只管"记忆怎么检索"（纯逻辑，零浏览器依赖，vitest 可直接测）；
 *   - 持久化在 ./db.ts（IndexedDB blankets 存储），组装进请求在任务 4 的 store 分支。
 *
 * 索引只建一次、之后增量补：docId = sessionId:messageIndex，engine 的 add() 幂等，
 * 所以"每轮同步一次当前会话"是安全的，也不会重复占内存。
 */

import type { Message, Session } from '../chat/types.js'
import { buildDynamicSegment } from '../../../engine/context.js'
import {
  InvertedIndex,
  budgetSearchResults,
  searchMemory,
  type SearchResult,
} from '../../../engine/fts.js'
import type { MemoryPack } from '../../../engine/pack.js'

/** 一床被子：一组会话蒸出来的记忆，加一个随时可聊的对话框 */
export interface BlanketRecord {
  id: string
  /** 被子名（默认取 persona.name，确认页可改） */
  name: string
  /**
   * 蒸进这床被子的会话。导入时勾选的全部在这里；
   * "普通模式转被子"就是把那个会话 id 追加进来重蒸一次（不新开被子）。
   */
  sessionIds: string[]
  /** 被子模式自己的对话框；还没开聊时缺省，开聊后写入 */
  chatSessionId?: string
  /** 进回收站的时间；缺省 = 正常在用。回收站 30 天后自动彻底删除 */
  deletedAt?: number
  pack: MemoryPack
  createdAt: number
  updatedAt: number
}

/** 一条可检索的记忆（会话内的一条消息） */
export interface MemoryDoc {
  messageIndex: number
  text: string
  /** ISO 时间，动态段用它渲染"昨天/更早" */
  at: string
}

/** 单条消息的可检索文本：用户取正文，助手只取文本块（思考/工具过程不是"发生过的事"） */
export const messageText = (message: Message): string => {
  if (message.role === 'user') {
    return message.content.trim()
  }
  return message.blocks
    .flatMap((block) => (block.type === 'text' && !block.isTemplate ? [block.text] : []))
    .join('\n')
    .trim()
}

/** 会话 → 可检索文档；空消息（纯附件、纯思考）不进索引，避免污染召回 */
export const sessionDocs = (session: Session): MemoryDoc[] =>
  session.messages.flatMap((message, index) => {
    const text = messageText(message)
    if (!text) {
      return []
    }
    return [{ messageIndex: index, text, at: new Date(message.createdAt).toISOString() }]
  })

export interface BlanketRetrieval {
  /** 动态段文本（已含"这一轮没有想起相关的旧事"兜底） */
  dynamic: string
  results: SearchResult[]
  /** 命中路径，调试/日志用：关键词式问法走 and，口语走 rare/or */
  mode: 'and' | 'rare' | 'or' | 'empty'
}

/**
 * 一床被子的检索器。每个被子一个实例，索引互不串味
 * （多个角色共用浏览器时，A 的旧事不能漏到 B 的对话里）。
 */
export class BlanketMemory {
  private readonly index = new InvertedIndex()
  /** 已同步过的会话，避免每次重复遍历消息数组（增量仍靠 add() 的幂等） */
  private readonly synced = new Set<string>()

  /** 增量同步一个会话。首次同步整段，之后只有新消息会被真正写入索引 */
  syncSession(session: Session): void {
    const docs = sessionDocs(session)
    for (const doc of docs) {
      this.index.add(session.id, doc.messageIndex, doc.text, doc.at)
    }
    this.synced.add(session.id)
  }

  /** 会话被移出被子（换导出包、用户删库、重蒸前清场） */
  removeSession(sessionId: string): void {
    this.index.removeSession(sessionId)
    this.synced.delete(sessionId)
  }

  /**
   * 本轮检索 → 动态段。
   * 管线（交接文档 §四）：改写层 → searchMemory 三路降级 → budgetSearchResults → 动态段。
   */
  retrieve(userText: string): BlanketRetrieval {
    const text = userText.trim()
    if (!text) {
      return { dynamic: buildDynamicSegment([]), results: [], mode: 'empty' }
    }
    const { results, mode } = searchMemory(this.index, text)
    const budgeted = budgetSearchResults(results)
    return { dynamic: buildDynamicSegment(budgeted.used), results: budgeted.used, mode }
  }

  stats(): { docs: number; terms: number; sessions: number } {
    const { docs, terms } = this.index.stats()
    return { docs, terms, sessions: this.synced.size }
  }
}

/** 同名被子自动加序号：第一份用原名，第二份起加（2）（3）…… */
export const dedupeBlanketName = (base: string, existing: string[]): string => {
  const taken = new Set(existing)
  if (!taken.has(base)) {
    return base
  }
  let n = 2
  while (taken.has(`${base}（${n}）`)) {
    n += 1
  }
  return `${base}（${n}）`
}
