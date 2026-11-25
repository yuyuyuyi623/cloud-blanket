/**
 * A5 原声样本：块 prompt 产样本 + 原文硬校验 + 汇总侧只挑不改写
 *
 * 三条铁律（拍板回复 三·③）：
 *   1. 校验先做空白归一，落库仍是原文那份；
 *   2. 命不中丢弃，不许把模型"润色版"当原声；
 *   3. 候选 N / 命中 M 要留痕（M=0 走 warn，不能和"原料本来就没样本"混为一谈）。
 */

import { describe, expect, it, vi } from 'vitest'
import {
  buildBlockMessages,
  distillBlock,
  distillSummarize,
  findVerbatim,
  type DistillBlockInput,
  type DistillBlockResult,
} from '../engine/distill.js'
import type { LlmClient } from '../engine/deepseek.js'
import { SAMPLES_LIMIT, SAMPLES_MAX_CHARS, SAMPLES_QUOTE_CHARS } from '../engine/config.js'
import { normalizeVoiceSamples } from '../engine/pack.js'

const blockText = [
  '你（2025-03-01）：加班好累啊',
  '',
  '她（2025-03-01）：你活该，谁让你接的活',
  '',
  '你（2025-03-02）：睡不着',
  '',
  '她（2025-03-02）：睡不着就给我打电话啊，我又不会咬你',
].join('\n')

const block: DistillBlockInput = {
  blockIndex: 0,
  text: blockText,
  firstAt: '2025-03-01',
  lastAt: '2025-03-02',
}

const blockClient = (payload: unknown): LlmClient => ({
  async chat() {
    return { content: JSON.stringify(payload), finishReason: 'stop' }
  },
})

describe('findVerbatim（空白归一后再比，落库回原文）', () => {
  it('多打空格/换行仍能命中，返回原文那一段（不带归一化）', () => {
    expect(findVerbatim(blockText, '你活该， 谁让你接的活')).toBe('你活该，谁让你接的活')
  })

  it('模型改过字就命不中', () => {
    expect(findVerbatim(blockText, '你活该，谁叫你接的活')).toBeNull()
  })
})

describe('distillBlock 的样本产出（A5）', () => {
  it('命中：落库的是原文（截短到 SAMPLES_QUOTE_CHARS），带配对语境与时间', async () => {
    const result = await distillBlock(
      blockClient({
        voiceSamples: [
          { scene: '他在抱怨加班', userQuote: '加班好累啊', quote: '你活该，谁让你接的活' },
        ],
      }),
      block
    )
    expect(result.voiceSamples).toHaveLength(1)
    const sample = result.voiceSamples?.[0]
    expect(sample?.quote).toBe('你活该，谁让你接的活')
    expect(sample?.userQuote).toBe('加班好累啊')
    expect(sample?.scene).toBe('他在抱怨加班')
    expect(sample?.at).toBe('2025-03-01')
    expect(sample?.quote.length).toBeLessThanOrEqual(SAMPLES_QUOTE_CHARS)
  })

  it('模型润色过的 quote 一律丢弃，台账记候选 N / 命中 0', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = await distillBlock(
      blockClient({
        voiceSamples: [{ quote: '你活该啦，谁让你接那么多活儿' }],
      }),
      block
    )
    expect(result.voiceSamples).toEqual([])
    expect(result.voiceStats).toEqual({ candidates: 1, hits: 0 })
    warn.mockRestore()
  })

  it('找不到上文（没有 userQuote 或上文对不上）就不选——孤立句没有场合锚', async () => {
    const noPair = await distillBlock(
      blockClient({ voiceSamples: [{ quote: '睡不着就给我打电话啊，我又不会咬你' }] }),
      block
    )
    expect(noPair.voiceSamples).toEqual([])

    const badPair = await distillBlock(
      blockClient({
        voiceSamples: [{ userQuote: '你今天吃什么', quote: '睡不着就给我打电话啊，我又不会咬你' }],
      }),
      block
    )
    expect(badPair.voiceSamples).toEqual([])
  })

  it('块 prompt 里写了"一字不改"和配对要求', () => {
    const [system] = buildBlockMessages(block)
    expect(system?.content).toContain('一字不改')
    expect(system?.content).toContain('userQuote')
    expect(system?.content).toContain('voiceSamples')
  })
})

describe('distillSummarize 的样本合并（只挑不改写）', () => {
  const candidates: DistillBlockResult['voiceSamples'] = [
    { quote: '你活该，谁让你接的活', userQuote: '加班好累啊', scene: '他在抱怨加班', at: '2025-03-01' },
    { quote: '睡不着就给我打电话啊，我又不会咬你', userQuote: '睡不着', scene: '他睡不着', at: '2025-03-02' },
  ]
  const blocks: DistillBlockResult[] = [
    {
      blockIndex: 0,
      firstAt: '2025-03-01',
      lastAt: '2025-03-02',
      summary: 's',
      personaFragments: [],
      factsUser: [],
      factsRelationship: [],
      memories: [],
      voiceSamples: candidates,
    },
  ]

  it('模型照抄 → 保留原文；模型改写 → 丢弃', async () => {
    const client = blockClient({
      voiceSamples: [
        { quote: '你活该，谁让你接的活', scene: '他在抱怨加班' },
        { quote: '你活该啦，谁让你接的活儿' },
      ],
    })
    const result = await distillSummarize(client, blocks)
    expect(result.voiceSamples?.map((s) => s.quote)).toEqual(['你活该，谁让你接的活'])
    expect(result.voiceStats).toEqual({ candidates: 2, hits: 1 })
  })

  it('去重 + 条数/字数收口（SAMPLES_LIMIT / SAMPLES_MAX_CHARS）', async () => {
    const many = Array.from({ length: SAMPLES_LIMIT + 5 }, (_, i) => ({ quote: `第${i}句${'好'.repeat(20)}` }))
    const manyCandidates = many.map((s) => ({ quote: s.quote, userQuote: '嗯' }))
    const client = blockClient({ voiceSamples: [...many, many[0]] }) // 故意重复一条
    const result = await distillSummarize(client, [
      { ...blocks[0]!, voiceSamples: manyCandidates },
    ])
    expect(result.voiceSamples?.length).toBeLessThanOrEqual(SAMPLES_LIMIT)
    const chars = (result.voiceSamples ?? []).reduce(
      (a, s) => a + s.quote.length + (s.userQuote?.length ?? 0) + (s.scene?.length ?? 0),
      0
    )
    expect(chars).toBeLessThanOrEqual(SAMPLES_MAX_CHARS)
  })
})

describe('normalizeVoiceSamples（pack 层收口）', () => {
  it('quote 必需、去重、截断、总字数受控；非对象条目丢弃', () => {
    const out = normalizeVoiceSamples([
      { quote: '一句原话', userQuote: '上文' },
      { quote: '一句原话' },
      { userQuote: '只有上文' },
      'not-an-object',
      { quote: '长'.repeat(SAMPLES_QUOTE_CHARS + 20) },
    ])
    expect(out).toHaveLength(2)
    expect(out[0]?.quote).toBe('一句原话')
    expect(out[0]?.userQuote).toBe('上文')
    expect(out[1]?.quote).toHaveLength(SAMPLES_QUOTE_CHARS)
  })
})
