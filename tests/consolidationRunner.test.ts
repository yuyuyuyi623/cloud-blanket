/**
 * 记忆巩固纯函数单测（记忆巩固方案 §八 验收的纯函数部分）。
 * 执行层（runConsolidation / 触发接线）靠手测：单测只锁纯逻辑。
 */

import { describe, expect, it } from 'vitest'
import {
  CONSOLIDATE_MIN_CHARS,
  CONSOLIDATE_MIN_MESSAGES,
  consolidationDelta,
  estimateConsolidationCost,
  mergeConsolidation,
  shouldAutoConsolidate,
} from '../src/services/memory/consolidationRunner.js'
import type { Session } from '../src/services/chat/types.js'
import type { MemoryPack } from '../engine/pack.js'
import { IMPRESSION_CHARS, IMPRESSION_PROMPT_CHARS } from '../engine/config.js'

/** 造一个最小可用的会话：每条消息 10 字，交替 user/assistant */
const makeSession = (count: number, charsPerMessage = 10): Session =>
  ({
    id: 's1',
    title: 't',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: Array.from({ length: count }, (_, i) =>
      i % 2 === 0
        ? {
            id: `m${i}`,
            role: 'user' as const,
            content: '字'.repeat(charsPerMessage),
            files: [],
            createdAt: Date.now() + i,
          }
        : {
            id: `m${i}`,
            role: 'assistant' as const,
            blocks: [{ type: 'text' as const, text: '字'.repeat(charsPerMessage) }],
            createdAt: Date.now() + i,
          }
    ),
  }) as Session

const makePack = (overrides: Partial<MemoryPack> = {}): MemoryPack => ({
  version: 1,
  persona: { name: '小鲸鱼', card: '她是柔光。' },
  coreMemories: [{ text: '他陪她聊了两年的天', at: '2026-01-01T00:00:00.000Z' }],
  memories: [{ text: '他们第一次聊到半夜三点', at: '2026-01-02T00:00:00.000Z' }],
  facts: [{ text: '他喜欢熬夜' }],
  summary: '一段长期的对话。',
  diary: [{ date: '2026-01-03', text: '今天他说了晚安。' }],
  ...overrides,
})

describe('巩固增量与阈值（§3.1：80 条或 2 万字，先到为准）', () => {
  it('水位之后只取新增；水位 0 = 从未巩固全量；越界水位不炸', () => {
    expect(consolidationDelta(makeSession(10), 6).count).toBe(4)
    expect(consolidationDelta(makeSession(10), 6).chars).toBe(40)
    expect(consolidationDelta(makeSession(5), 0).count).toBe(5)
    expect(consolidationDelta(makeSession(5), 999).count).toBe(0)
  })

  it('阈值边界：79 条 19000 字不触发；80 条或 20000 字任一即触发', () => {
    expect(CONSOLIDATE_MIN_MESSAGES).toBe(80)
    expect(CONSOLIDATE_MIN_CHARS).toBe(20_000)
    expect(shouldAutoConsolidate({ lines: [], count: 79, chars: 19_000 })).toBe(false)
    expect(shouldAutoConsolidate({ lines: [], count: 80, chars: 19_000 })).toBe(true)
    expect(shouldAutoConsolidate({ lines: [], count: 79, chars: 20_000 })).toBe(true)
  })

  it('预估金额：量级正确且随字数单调递增（保守口径，峰价更高）', () => {
    const small = estimateConsolidationCost(10_000)
    const big = estimateConsolidationCost(30_000)
    expect(small).toBeGreaterThan(0)
    expect(big).toBeGreaterThan(small)
    expect(small).toBeLessThan(0.1) // 1 万字谷价也就 1 分多钱，峰价翻倍也不该过 1 毛
  })
})

describe('append-only 合并（§七 红线）', () => {
  it('新事件追加、旧条目原样保留；persona.card / diary / summary 零接触', () => {
    const pack = makePack()
    const result = mergeConsolidation(
      pack,
      { memories: ['他们去了海边', '他给她讲了个笑话'], facts: ['他喜欢熬夜', '他在做云朵被子'] },
      new Date('2026-11-25T12:00:00.000Z'),
      { impressionAuto: true }
    )
    expect(result.pack.memories.some((m) => m.text === '他们第一次聊到半夜三点')).toBe(true)
    expect(result.pack.memories.some((m) => m.text === '他们去了海边')).toBe(true)
    expect(result.newEpisodeCount).toBe(2)
    expect(result.pack.persona.card).toBe(pack.persona.card)
    expect(result.pack.diary).toEqual(pack.diary)
    expect(result.pack.summary).toBe(pack.summary)
    expect(result.pack.facts.some((f) => f.text === '他在做云朵被子')).toBe(true)
    expect(result.pack.facts.filter((f) => f.text === '他喜欢熬夜')).toHaveLength(1)
  })

  it('模型输出的 forget 被忽略：已有事件一个都不少（append-only）', () => {
    const pack = makePack()
    const result = mergeConsolidation(
      pack,
      { memories: ['新事件'], forget: ['他们第一次聊到半夜三点'] },
      new Date(),
      { impressionAuto: true }
    )
    expect(result.pack.memories.some((m) => m.text === '他们第一次聊到半夜三点')).toBe(true)
    expect(result.newEpisodeCount).toBe(1)
  })

  it('coreMemories 只增不改：已有核心原时间原样保留，重复文本不重复加', () => {
    const pack = makePack()
    const result = mergeConsolidation(
      pack,
      { coreMemories: ['他陪她聊了两年的天', '他第一次叫她名字'], memories: [], facts: [] },
      new Date('2026-11-25T12:00:00.000Z'),
      { impressionAuto: true }
    )
    expect(result.pack.coreMemories).toHaveLength(2)
    expect(result.pack.coreMemories.find((c) => c.text === '他陪她聊了两年的天')?.at).toBe(
      '2026-01-01T00:00:00.000Z'
    )
  })

  it('水位幂等：同一批输出合并两次，第二次不产生重复条目', () => {
    const pack = makePack()
    const first = mergeConsolidation(pack, { memories: ['他们去了海边'] }, new Date(), {
      impressionAuto: true,
    })
    const second = mergeConsolidation(first.pack, { memories: ['他们去了海边'] }, new Date(), {
      impressionAuto: true,
    })
    expect(second.pack.memories.filter((m) => m.text === '他们去了海边')).toHaveLength(1)
  })
})

describe('整体印象（半生长区，四·附）', () => {
  it('impressionAuto 开：整格重写', () => {
    const result = mergeConsolidation(
      makePack(),
      { impression: '他们最近每天都聊，关系更近了。' },
      new Date(),
      { impressionAuto: true }
    )
    expect(result.impressionUpdated).toBe(true)
    expect(result.pack.persona.impression).toBe('他们最近每天都聊，关系更近了。')
  })

  it('用户手改接管后（impressionAuto 关）：事件照旧巩固，印象一格不动', () => {
    const pack = makePack({
      persona: { name: '小鲸鱼', card: '她是柔光。', impression: '用户亲手写的版本' },
    })
    const result = mergeConsolidation(
      pack,
      { impression: '模型想重写的版本', memories: ['新事件'] },
      new Date(),
      { impressionAuto: false }
    )
    expect(result.impressionUpdated).toBe(false)
    expect(result.pack.persona.impression).toBe('用户亲手写的版本')
    expect(result.pack.memories.some((m) => m.text === '新事件')).toBe(true)
  })

  it('模型没给印象（空串/缺失）：保留旧印象', () => {
    const pack = makePack({ persona: { name: '小鲸鱼', card: '她是柔光。', impression: '旧的' } })
    const result = mergeConsolidation(pack, {}, new Date(), { impressionAuto: true })
    expect(result.impressionUpdated).toBe(false)
    expect(result.pack.persona.impression).toBe('旧的')
  })
})

describe('B1 印象字数（2026-11-25 拍板：prompt 100 / 存 120）', () => {
  it('存 120：超长印象截断到 IMPRESSION_CHARS，不留半句以上的垃圾', () => {
    const pack = makePack()
    const result = mergeConsolidation(
      pack,
      { impression: '好'.repeat(300) },
      new Date(),
      { impressionAuto: true }
    )
    expect(result.pack.persona.impression).toHaveLength(IMPRESSION_CHARS)
  })

  it('prompt 目标字数必须小于存储截断（留缓冲，两者不许同一个数）', () => {
    expect(IMPRESSION_PROMPT_CHARS).toBe(100)
    expect(IMPRESSION_CHARS).toBe(120)
    expect(IMPRESSION_PROMPT_CHARS).toBeLessThan(IMPRESSION_CHARS)
  })
})
