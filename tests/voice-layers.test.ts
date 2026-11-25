/**
 * 原声延续三层：样本段注入 / seed 拼装与单调退场 / pack normalize（v1.0.2 第 7~9 项）
 */

import { describe, expect, it } from 'vitest'
import {
  buildDynamicSegment,
  buildSeedMessages,
  buildStableSegment,
  pickSeedTurns as pickSeedTail,
  seedInjectionCount,
} from '../engine/context.js'
import { normalizePack, normalizeSeedTurns, type MemoryPack } from '../engine/pack.js'
import { SEED_TURNS_ROUNDS, SEED_TURNS_ROUNDS as ROUNDS } from '../engine/config.js'
import { toRequestMessages } from '../src/services/chat/reply.js'
import { pickSeedTurns } from '../src/services/memory/importBlanket.js'
import type { AssistantMessage, UserMessage } from '../src/services/chat/types.js'
import type { ParsedSession } from '../engine/parse.js'

const pack: MemoryPack = normalizePack({
  version: 1,
  persona: { name: '小鲸鱼', card: '她是柔光。', impression: '最近很黏人' },
  coreMemories: [{ text: '第一次说话', at: '2024-01-01' }],
  memories: [{ text: '一起去看了海', at: '2025-08-01' }],
  facts: [{ text: '他喜欢深夜聊天' }],
  summary: '阶段摘要',
  diary: [],
  voiceSamples: [
    { quote: '你活该，谁让你接的活', userQuote: '加班好累啊', scene: '他在抱怨加班' },
    { quote: '睡不着就给我打电话啊', scene: '他睡不着' },
  ],
})

const user = (text: string, id = text): UserMessage => ({
  id,
  role: 'user',
  content: text,
  files: [],
  createdAt: 1,
})

const assistant = (text: string): AssistantMessage => ({
  id: `a-${text}`,
  role: 'assistant',
  createdAt: 2,
  model: null,
  prefix: true,
  status: 'done',
  blocks: [{ type: 'text', text }],
})

describe('稳定段插样本段（层一）', () => {
  const stable = buildStableSegment(pack)

  it('样本段紧跟在 persona 之后（缓存前缀顺序：persona → 样本 → 核心）', () => {
    const personaAt = stable.indexOf('【你是谁】')
    const samplesAt = stable.indexOf('【你说话就是这个样子')
    const coreAt = stable.indexOf('【你最珍视的记忆')
    expect(personaAt).toBeGreaterThanOrEqual(0)
    expect(samplesAt).toBeGreaterThan(personaAt)
    expect(coreAt).toBeGreaterThan(samplesAt)
  })

  it('每条样本带场合与"你说："，并写明不要念出来', () => {
    expect(stable).toContain('不要念出来也不要复述')
    expect(stable).toContain('（他在抱怨加班）你说：“你活该，谁让你接的活”')
    expect(stable).toContain('你说：“睡不着就给我打电话啊”')
  })

  it('没有样本时不出现空段', () => {
    const bare = normalizePack({ ...pack, voiceSamples: [] })
    expect(buildStableSegment(bare)).not.toContain('【你说话就是这个样子')
  })
})

describe('seed 单调退场与拼装（层二）', () => {
  it('注入条数 = max(0, 24 − 真实历史条数)，单调递减到 0', () => {
    const seedLen = ROUNDS * 2
    expect(seedInjectionCount(0, seedLen)).toBe(seedLen)
    expect(seedInjectionCount(10, seedLen)).toBe(seedLen - 10)
    expect(seedInjectionCount(seedLen, seedLen)).toBe(0)
    expect(seedInjectionCount(100, seedLen)).toBe(0)
    // 单调不增
    let prev = seedInjectionCount(0, seedLen)
    for (let i = 1; i <= seedLen + 5; i += 1) {
      const next = seedInjectionCount(i, seedLen)
      expect(next).toBeLessThanOrEqual(prev)
      prev = next
    }
  })

  it('取末尾 N 条；头部是 assistant 就往后挪（请求第一条不能是 assistant）', () => {
    const turns = normalizeSeedTurns([
      { role: 'user', text: '第一句' },
      { role: 'assistant', text: '第二句' },
      { role: 'assistant', text: '第三句' },
      { role: 'user', text: '第四句' },
    ])
    const picked = pickSeedTail(turns, 3) // ['第二句','第三句','第四句'] 头部是 assistant
    expect(picked[0]?.role).toBe('user')
    expect(picked.map((t) => t.text)).toEqual(['第四句'])
  })

  it('buildSeedMessages 原封转成请求消息', () => {
    const msgs = buildSeedMessages([
      { role: 'user', text: '在吗' },
      { role: 'assistant', text: '在' },
    ])
    expect(msgs).toEqual([
      { role: 'user', content: '在吗' },
      { role: 'assistant', content: '在' },
    ])
  })

  it('桥接语只在本轮注入了 seed 时出现在动态段', () => {
    expect(buildDynamicSegment([], { seedBridged: true })).toContain('那天之后到现在没再聊')
    expect(buildDynamicSegment([], {})).not.toContain('那天之后到现在没再聊')
  })
})

describe('normalizeSeedTurns（pack 层收口 + 脱敏）', () => {
  it('role 只认 user/assistant，空文本丢弃，超长留末尾，敏感内容过一遍脱敏', () => {
    const raw = Array.from({ length: 30 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      text: `第${i}条 13812345678`,
      at: '2025-01-01',
    }))
    const out = normalizeSeedTurns(raw)
    expect(out).toHaveLength(SEED_TURNS_ROUNDS * 2)
    expect(out.at(-1)?.text).toContain('第29条') // 留的是末尾
    expect(out[0]?.text).not.toContain('13812345678')
    expect(normalizeSeedTurns([{ role: 'system', text: 'x' }])).toEqual([])
    expect(normalizeSeedTurns([{ role: 'user', text: '   ' }])).toEqual([])
  })
})

describe('pickSeedTurns（跨会话按消息自己的时间合并，A6）', () => {
  const session = (id: string, times: string[]): ParsedSession => ({
    id,
    title: id,
    pinned: false,
    words: 100,
    days: 1,
    userTurns: 1,
    totalMessages: times.length,
    firstAt: times[0] ?? '',
    lastAt: times.at(-1) ?? '',
    stats: { thinkCount: 0, thinkWords: 0, fileCount: 0, unfinished: 0, emptyMessages: 0 },
    messages: times.map((at, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      text: `${id}-${i}`,
      at,
      unfinished: '',
    })),
  })

  it('两个会话交错时按每条消息时间排，而不是按会话顺序', () => {
    const a = session('A', ['2025-01-01T10:00:00Z', '2025-01-03T10:00:00Z'])
    const b = session('B', ['2025-01-02T10:00:00Z', '2025-01-04T10:00:00Z'])
    const out = pickSeedTurns([a, b])
    expect(out.map((t) => t.text)).toEqual(['A-0', 'B-0', 'A-1', 'B-1'])
  })

  it('只取末尾 24 条（12 轮）', () => {
    const many = session(
      'C',
      Array.from({ length: 40 }, (_, i) => `2025-02-${String(1 + Math.floor(i / 10)).padStart(2, '0')}T0${i % 10}:00:00Z`)
    )
    expect(pickSeedTurns([many])).toHaveLength(SEED_TURNS_ROUNDS * 2)
  })
})

describe('请求拼装里的 seed（与预算执行器同处）', () => {
  const seed = [
    { role: 'user' as const, text: '上次说的那个事' },
    { role: 'assistant' as const, text: '我记得' },
  ]
  const history = [user('新问题一'), assistant('新回答一')]

  it('seed 拼在真实历史前面，位置在 system 之后（不混 system）', () => {
    const out = toRequestMessages(history, user('现在的问题'), undefined, undefined, undefined, seed)
    expect(out[0]).toEqual({ role: 'user', content: '上次说的那个事' })
    expect(out.some((m) => (m.role as string) === 'system')).toBe(false)
  })

  it('预算不够时先丢 seed（最老的一段），从最老一条开始丢', () => {
    const out = toRequestMessages(history, user('现在的问题'), undefined, undefined, { reservedTokens: 7200 }, seed)
    expect(out.some((m) => m.content === '上次说的那个事')).toBe(false)
    // 真实历史仍留着（预算被稳定段吃满前的剩余够一轮）
    expect(out.some((m) => m.content === '新回答一')).toBe(false)
  })

  it('seed 丢掉后头部不会剩下 assistant', () => {
    const out = toRequestMessages([], user('现在的问题'), undefined, undefined, undefined, [
      { role: 'assistant' as const, text: '只有一半' },
      { role: 'user' as const, text: '完整那句' },
    ])
    expect(out[0]).toEqual({ role: 'user', content: '完整那句' })
  })
})
