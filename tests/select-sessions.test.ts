/**
 * 挑会话的筛选/排序：口径对齐 local/选择器.html 的定稿。
 * 这里只测纯函数——界面上"筛掉了但还勾着"的差额是组件算的，不在这一层。
 */
import { describe, expect, it } from 'vitest'
import type { ParsedSession } from '../engine/parse.js'
import type { ContentHit } from '../engine/content-search.js'
import { MIN_TURNS_OPTIONS, filterSessions } from '../engine/select-sessions.js'

const make = (over: Partial<ParsedSession> & { id: string }): ParsedSession => ({
  title: over.id,
  pinned: false,
  firstAt: '2026-01-01T00:00:00Z',
  lastAt: '2026-01-01T00:00:00Z',
  days: 1,
  words: 100,
  userTurns: 10,
  totalMessages: 20,
  messages: [],
  stats: { thinkCount: 0, thinkWords: 0, fileCount: 0, unfinished: 0, emptyMessages: 0 },
  ...over,
})

const ids = (list: ParsedSession[]): string[] => list.map((s) => s.id)

const sessions = [
  make({ id: 'a', title: '晚安', userTurns: 300, words: 90_000, days: 9, lastAt: '2026-10-01T00:00:00Z' }),
  make({ id: 'b', title: '旅行计划', userTurns: 40, words: 200_000, days: 3, lastAt: '2026-11-20T00:00:00Z' }),
  make({ id: 'c', title: '深夜聊', userTurns: 120, words: 30_000, days: 20, lastAt: '2026-09-01T00:00:00Z' }),
]

describe('filterSessions', () => {
  it('默认按轮数排：聊得最多的在最上面', () => {
    expect(ids(filterSessions(sessions))).toEqual(['a', 'c', 'b'])
  })

  it('轮数相同就按字数（别让顺序看起来是随机的）', () => {
    const same = [make({ id: 'x', userTurns: 5, words: 10 }), make({ id: 'y', userTurns: 5, words: 99 })]
    expect(ids(filterSessions(same))).toEqual(['y', 'x'])
  })

  it('轮数门槛按 >= 卡，四档就是定稿那四档', () => {
    expect(MIN_TURNS_OPTIONS).toEqual([0, 20, 50, 100])
    expect(ids(filterSessions(sessions, { minTurns: 50 }))).toEqual(['a', 'c'])
    expect(ids(filterSessions(sessions, { minTurns: 100 }))).toEqual(['a', 'c'])
    expect(ids(filterSessions(sessions, { minTurns: 301 }))).toEqual([])
  })

  it('搜标题：子串、不分大小写、不搜正文', () => {
    expect(ids(filterSessions(sessions, { query: '晚安' }))).toEqual(['a'])
    const en = [make({ id: 'k', title: 'Good Night' }), make({ id: 'm', title: '午后' })]
    expect(ids(filterSessions(en, { query: 'good' }))).toEqual(['k'])
    expect(filterSessions(en, { query: 'good night' })).toHaveLength(1)
  })

  it('搜内容：只留命中的会话；没命中表时一个都不给（别假装搜到了）', () => {
    const hits = new Map<string, ContentHit>([
      ['a', { sessionId: 'a', matches: 3, snippet: '…晚安…' }],
    ])
    expect(ids(filterSessions(sessions, { query: '晚安', mode: 'content', hits }))).toEqual(['a'])
    expect(filterSessions(sessions, { query: '晚安', mode: 'content' })).toHaveLength(0)
  })

  it('搜内容时关键词是空的就看全部（空查询不该把列表清空）', () => {
    expect(filterSessions(sessions, { mode: 'content', hits: new Map() })).toHaveLength(3)
  })

  it('按字数 / 天数 / 最近说话', () => {
    expect(ids(filterSessions(sessions, { sortBy: 'words' }))).toEqual(['b', 'a', 'c'])
    expect(ids(filterSessions(sessions, { sortBy: 'days' }))).toEqual(['c', 'a', 'b'])
    expect(ids(filterSessions(sessions, { sortBy: 'recent' }))).toEqual(['b', 'a', 'c'])
  })

  it('按命中数排，命中数相同退回轮数；标题模式下没有命中数就按轮数', () => {
    const hits = new Map<string, ContentHit>([
      ['b', { sessionId: 'b', matches: 9, snippet: '' }],
      ['c', { sessionId: 'c', matches: 4, snippet: '' }],
      ['a', { sessionId: 'a', matches: 1, snippet: '' }],
    ])
    expect(ids(filterSessions(sessions, { sortBy: 'match', hits }))).toEqual(['b', 'c', 'a'])
    expect(ids(filterSessions(sessions, { sortBy: 'match' }))).toEqual(['a', 'c', 'b'])
  })

  it('时间串读不出来也不许把顺序搅乱（NaN 比较全是 false）', () => {
    const broken = [
      make({ id: 'p', lastAt: 'not-a-date', userTurns: 5 }),
      make({ id: 'q', lastAt: '2026-05-01T00:00:00Z', userTurns: 9 }),
    ]
    expect(ids(filterSessions(broken, { sortBy: 'recent' }))).toEqual(['q', 'p'])
  })

  it('筛选不改原数组（界面拿它直接渲染，改了就成幽灵排序）', () => {
    const input = sessions.slice()
    filterSessions(input, { sortBy: 'words' })
    expect(ids(input)).toEqual(['a', 'b', 'c'])
  })
})
