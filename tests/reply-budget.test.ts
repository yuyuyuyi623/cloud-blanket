/**
 * 预算执行器（A4，2026-11-25 拍板）
 *
 * 锁三件事：
 *   1. 不传 budget 时是官方原样（全量历史）——普通模式不做裁剪，这是产品口径；
 *   2. 传 budget 时按整轮成对裁剪：从最近一轮往回装，装不下就停，绝不剩半轮；
 *   3. 稳定段/动态段先占，历史只能用剩下的；轮数另受 MAX_HISTORY_ROUNDS 约束。
 */

import { describe, expect, it } from 'vitest'
import {
  estimateTokens,
  toRequestMessages,
  type HistoryBudget,
} from '../src/services/chat/reply.js'
import { CONTEXT_BUDGET_TOKENS, MAX_HISTORY_ROUNDS } from '../engine/config.js'
import type { AssistantMessage, Message, UserMessage } from '../src/services/chat/types.js'

const text = (n: number, seed: string) => {
  let s = ''
  let i = 0
  while (s.length < n) {
    s += `${seed}第${i}句，这一轮说的事他还记着。`
    i += 1
  }
  return s.slice(0, n)
}

const user = (content: string): UserMessage => ({
  id: `u-${content.slice(0, 8)}`,
  role: 'user',
  content,
  files: [],
  createdAt: 1,
})

const assistant = (content: string, latestReminder?: string): AssistantMessage => ({
  id: `a-${content.slice(0, 8)}`,
  role: 'assistant',
  createdAt: 2,
  model: null,
  prefix: true,
  status: 'done',
  blocks: [{ type: 'text', text: content }],
  ...(latestReminder ? { latestReminder } : {}),
})

/** 造 n 轮历史：每轮 user + assistant，各 charsPerMsg 字 */
const rounds = (n: number, charsPerMsg = 70, reminderEvery = 0): Message[] => {
  const out: Message[] = []
  for (let i = 0; i < n; i++) {
    const reminder = reminderEvery && i % reminderEvery === 0 ? `现在 ${i} 点` : undefined
    out.push(user(text(charsPerMsg, `问${i}`)))
    out.push(assistant(text(charsPerMsg, `答${i}`), reminder))
  }
  return out
}

const question = user(text(50, '这一轮的问题'))
const budget = (reservedTokens: number, budgetTokens?: number): HistoryBudget => ({
  reservedTokens,
  ...(budgetTokens === undefined ? {} : { budgetTokens }),
})

/** 取消息里的正文（用于识别保留的是哪几轮） */
const contentOf = (m: { content: string | unknown[] }) =>
  typeof m.content === 'string'
    ? m.content
    : ''

describe('toRequestMessages 预算执行器', () => {
  it('不传 budget：官方原样，全量历史 + 本轮提问', () => {
    const out = toRequestMessages(rounds(8), question)
    expect(out.filter((m) => m.role === 'user')).toHaveLength(9) // 8 轮 + 本轮
    expect(out.filter((m) => m.role === 'assistant')).toHaveLength(8)
    expect(out[out.length - 1]?.role).toBe('user')
  })

  it('预算充足：只受 MAX_HISTORY_ROUNDS 约束（20 轮只留最近 10 轮）', () => {
    const out = toRequestMessages(rounds(20), question, undefined, undefined, budget(0))
    expect(out.filter((m) => m.role === 'assistant')).toHaveLength(MAX_HISTORY_ROUNDS)
  })

  it('稳定段吃满预算：历史被裁到最近几轮，且仍是整轮', () => {
    // 稳定段打满实测 5571 token（文档 §10.2），7000×0.9 的执行口径下只剩 ~700 给历史
    const out = toRequestMessages(rounds(20), question, undefined, undefined, budget(5571))
    const users = out.filter((m) => m.role === 'user')
    const assistants = out.filter((m) => m.role === 'assistant')
    expect(assistants.length).toBe(users.length - 1) // 每轮成对；本轮的提问还没有回答
    expect(assistants.length).toBeGreaterThan(0)
    expect(assistants.length).toBeLessThan(MAX_HISTORY_ROUNDS)
    // 留下的是最近的那几轮（末尾连接不断）
    expect(contentOf(assistants[assistants.length - 1] ?? { content: '' })).toContain('答19')
  })

  it('历史中间不出现 system（assertTwoSegmentShape 的口径）', () => {
    const out = toRequestMessages(rounds(20), question, undefined, '现在 9 点', budget(2000))
    expect(out.some((m) => (m.role as string) === 'system')).toBe(false)
  })

  it('一轮都装不下：历史全丢，本轮提问仍发出（不裁掉用户刚说的话）', () => {
    const out = toRequestMessages(
      rounds(5, 400),
      question,
      undefined,
      undefined,
      budget(Math.floor(CONTEXT_BUDGET_TOKENS * 0.9))
    )
    expect(out.filter((m) => m.role === 'assistant')).toHaveLength(0)
    expect(out).toHaveLength(1)
    expect(out[0]?.role).toBe('user')
  })

  it('提醒快照跟着所属轮次进出，且不连续重复', () => {
    // 每 2 轮一条快照（第 1/3/5 轮）；裁到只剩最近 2 轮时，只该带出第 5 轮那条
    const out = toRequestMessages(rounds(6, 70, 2), question, undefined, '现在 9 点', budget(6055))
    const reminders = out.filter((m) => m.role === 'latest_reminder')
    const values = reminders.map((m) => contentOf(m as { content: string }))
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).not.toBe(values[i - 1])
    }
    // 本轮快照永远在
    expect(values[values.length - 1]).toBe('现在 9 点')
  })

  it('token 估算按 TOKENS_PER_CHAR 折算（0.7/字，向上取整）', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('一二三四五六七八九十')).toBe(7)
    expect(estimateTokens('一')).toBe(1)
  })
})
