/**
 * engine/select-sessions.ts —— 挑会话时的筛选与排序（纯函数，可单测）
 *
 * 口径来自 local/选择器.html 的定稿：
 *   · 轮数是"我用得多"的硬证据，默认按轮数排（不是按时间——按时间排会把一次深夜长谈埋掉）；
 *   · 字数看的是"这段关系有多厚"，天数看的是"她陪我跨过多少个日子"，最近说话看的是"还热乎吗"；
 *   · 搜内容命中后按命中数排最贴合"我记得她说过一句什么，找出来在哪"。
 *
 * 筛选只决定"看得见什么"，不改勾选：被筛掉的会话只要还勾着，照样进蒸馏、照样算钱，
 * 所以界面必须把"筛选外还勾着几个"单独说出来（这是最容易让人多花钱的地方）。
 */

import type { ParsedSession } from './parse.js'
import type { ContentHit } from './content-search.js'

export type SortBy = 'turns' | 'words' | 'days' | 'recent' | 'match'

export type SearchMode = 'title' | 'content'

export interface SessionFilter {
  /** 关键词：标题模式搜标题，内容模式在 hits 里找 */
  query?: string
  mode?: SearchMode
  sortBy?: SortBy
  /** 轮数门槛，0 = 不限 */
  minTurns?: number
  /** 内容搜索命中（内容模式必须给，否则筛不出东西） */
  hits?: Map<string, ContentHit> | null
}

/** 导出的时间串有带时区和不带时区的，解析不出来就当最旧，别让排序 NaN 掉 */
const timeOf = (iso: string): number => {
  const at = Date.parse(iso)
  return Number.isFinite(at) ? at : 0
}

/** 轮数门槛的几档（定稿四档，别自己加：档位多了反而挑不出来） */
export const MIN_TURNS_OPTIONS = [0, 20, 50, 100] as const

export const filterSessions = (
  sessions: ParsedSession[],
  filter: SessionFilter = {}
): ParsedSession[] => {
  const { query = '', mode = 'title', sortBy = 'turns', minTurns = 0, hits = null } = filter
  const keyword = query.trim().toLowerCase()

  const list = sessions.filter((session) => {
    if (session.userTurns < minTurns) {
      return false
    }
    if (!keyword) {
      return true
    }
    if (mode === 'content') {
      return hits ? hits.has(session.id) : false
    }
    return session.title.toLowerCase().includes(keyword)
  })

  const matchesOf = (session: ParsedSession): number => hits?.get(session.id)?.matches ?? 0

  list.sort((a, b) => {
    switch (sortBy) {
      case 'words':
        return b.words - a.words || b.userTurns - a.userTurns
      case 'days':
        return b.days - a.days || b.words - a.words
      case 'recent':
        return timeOf(b.lastAt) - timeOf(a.lastAt) || b.userTurns - a.userTurns
      case 'match':
        // 标题模式下没有命中数，退回轮数（别让人选了"按命中"却看到随机顺序）
        return matchesOf(b) - matchesOf(a) || b.userTurns - a.userTurns
      default:
        return b.userTurns - a.userTurns || b.words - a.words
    }
  })

  return list
}
