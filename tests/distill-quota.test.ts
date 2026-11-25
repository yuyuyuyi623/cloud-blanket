/**
 * A7 时间加权（2026-11-25 拍板：A 汇总 prompt 加权 + B 块配额递增）
 *
 * B 的硬纪律：块总数不变（成本口径不变）、首尾必留（第一块从最早一条开始、
 * 最后一块收在最新一条）、近期分到的块数多于早期。
 */

import { describe, expect, it } from 'vitest'
import { chunkMessages, chunkMessagesWithQuota } from '../engine/parse.js'
import type { ParsedMessage } from '../engine/parse.js'
import { buildSummarizeMessages, type DistillBlockResult } from '../engine/distill.js'
import {
  DISTILL_BLOCK_QUOTA_EARLY,
  DISTILL_BLOCK_QUOTA_MID,
  DISTILL_BLOCK_QUOTA_RECENT,
} from '../engine/config.js'

/** n 条消息、每条 chars 字、按天推进 */
const timeline = (n: number, chars = 2000): ParsedMessage[] =>
  Array.from({ length: n }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    text: `${i}`.padStart(3, '0') + '字'.repeat(chars - 3),
    at: `2026-${String(1 + Math.floor(i / 28)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}T10:00:00.000Z`,
    unfinished: '',
  }))

describe('chunkMessagesWithQuota（A7-B）', () => {
  it('块总数与普通切块一致（成本口径不变）', () => {
    const messages = timeline(400, 2000) // 80 万字 → 40 块
    const plain = chunkMessages(messages)
    const bucketed = chunkMessagesWithQuota(messages)
    expect(plain.length).toBeGreaterThan(3)
    expect(bucketed).toHaveLength(plain.length)
  })

  it('首尾必留：第一块从最早一条开始，最后一块收在最新一条', () => {
    const messages = timeline(400, 2000)
    const chunks = chunkMessagesWithQuota(messages)
    expect(chunks[0]?.messages[0]).toEqual(messages[0])
    expect(chunks[chunks.length - 1]?.messages.at(-1)).toEqual(messages.at(-1))
  })

  it('一条消息都不丢、顺序不乱（切块只在消息边界上）', () => {
    const messages = timeline(400, 2000)
    const chunks = chunkMessagesWithQuota(messages)
    const flat = chunks.flatMap((c) => c.messages)
    expect(flat).toHaveLength(messages.length)
    expect(flat.map((m) => m.text)).toEqual(messages.map((m) => m.text))
  })

  it('近期块多于早期块（配额 10:13:18 落地）', () => {
    const messages = timeline(1140, 2000) // 228 万字 → 114 块
    const chunks = chunkMessagesWithQuota(messages)
    const third = Math.floor(chunks.length / 3)
    const early = chunks.slice(0, third).length
    const recent = chunks.slice(-third).length
    expect(DISTILL_BLOCK_QUOTA_RECENT).toBeGreaterThan(DISTILL_BLOCK_QUOTA_EARLY)
    expect(DISTILL_BLOCK_QUOTA_MID).toBeGreaterThan(DISTILL_BLOCK_QUOTA_EARLY)
    // 近期那一段的字数密度更高：块更小
    const earlyAvg = chunks.slice(0, third).reduce((a, c) => a + c.words, 0) / early
    const recentAvg = chunks.slice(-third).reduce((a, c) => a + c.words, 0) / recent
    expect(recentAvg).toBeLessThan(earlyAvg)
  })

  it('消息太少/块太少时退回普通切块（配额分不出东西）', () => {
    const few = timeline(2, 100)
    expect(chunkMessagesWithQuota(few)).toEqual(chunkMessages(few))
  })
})

/** 造一个块结果，只需要时间与一段摘要 */
const blockResult = (index: number, firstAt: string): DistillBlockResult => ({
  blockIndex: index,
  firstAt,
  lastAt: firstAt,
  summary: `第 ${index} 段`,
  personaFragments: [],
  factsUser: [],
  factsRelationship: [],
  memories: [],
})

describe('buildSummarizeMessages 的时间标注与权重纪律（A7-A）', () => {
  const blocks = [
    blockResult(0, '2024-01-01T00:00:00.000Z'),
    blockResult(1, '2024-06-01T00:00:00.000Z'),
    blockResult(2, '2025-06-01T00:00:00.000Z'),
  ]
  const messages = buildSummarizeMessages(blocks)
  const system = messages[0]?.content ?? ''
  const user = messages[1]?.content ?? ''

  it('每段标注时间归属（早期/中期/近期）', () => {
    expect(user).toContain('第 1 段（早期）')
    expect(user).toContain('第 3 段（近期）')
  })

  it('系统提示写明"近期权重是早期两倍"与冲突时以近期为准', () => {
    expect(system).toContain('近期的权重是早期的两倍')
    expect(system).toContain('一律以近期为准')
  })

  it('H1 红线不破：仍然不含示范句式', () => {
    for (const m of messages) {
      expect(m.content).not.toMatch(/比如|例如|例[:：]|你可以/)
    }
  })
})
