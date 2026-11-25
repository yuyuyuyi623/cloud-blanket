import { describe, expect, it, vi } from 'vitest'
import { estimateCost, isPeakHours } from '../src/services/usage/ledger.js'

/** 北京墙上时间 → Date。输入 (2026, 11月, 25日, 时, 分) 语义直观，内部转 UTC 毫秒 */
const beijing = (year: number, month: number, day: number, hour: number, minute = 0): Date =>
  new Date(Date.UTC(year, month - 1, day, hour - 8, minute))

describe('峰谷判定（北京时间周一至五 9-12、14-18 为峰）', () => {
  it('四个边界：9 点进峰、12 点出峰、14 点进峰、18 点出峰', () => {
    expect(isPeakHours(beijing(2026, 11, 25, 9))).toBe(true) // 周三 9:00
    expect(isPeakHours(beijing(2026, 11, 25, 11, 59))).toBe(true)
    expect(isPeakHours(beijing(2026, 11, 25, 12))).toBe(false)
    expect(isPeakHours(beijing(2026, 11, 25, 13, 59))).toBe(false)
    expect(isPeakHours(beijing(2026, 11, 25, 14))).toBe(true)
    expect(isPeakHours(beijing(2026, 11, 25, 17, 59))).toBe(true)
    expect(isPeakHours(beijing(2026, 11, 25, 18))).toBe(false)
  })

  it('周末全天谷价，深夜与清早也是谷', () => {
    expect(isPeakHours(beijing(2026, 11, 28, 10))).toBe(false) // 周六
    expect(isPeakHours(beijing(2026, 11, 29, 15))).toBe(false) // 周日
    expect(isPeakHours(beijing(2026, 11, 25, 8, 59))).toBe(false)
    expect(isPeakHours(beijing(2026, 11, 25, 23))).toBe(false)
  })

  it('UTC 输入与本地时区无关：UTC 零点 = 北京 8 点（谷）', () => {
    expect(isPeakHours(new Date(Date.UTC(2026, 10, 25, 0, 0)))).toBe(false)
    expect(isPeakHours(new Date(Date.UTC(2026, 10, 25, 3, 0)))).toBe(true) // 北京 11 点
  })
})

describe('峰谷折算（每百万 token 价，峰 ×2）', () => {
  it('谷价：命中 0.02 / 未命中 1 / 输出 4', () => {
    const cost = estimateCost({ hit: 1_000_000, miss: 1_000_000, completion: 1_000_000 }, false)
    expect(cost).toBeCloseTo(0.02 + 1 + 4, 10)
  })

  it('峰价翻倍：0.04 / 2 / 8', () => {
    const cost = estimateCost({ hit: 1_000_000, miss: 1_000_000, completion: 1_000_000 }, true)
    expect(cost).toBeCloseTo((0.02 + 1 + 4) * 2, 10)
  })

  it('零用量为零；小额用量金额量级正确（一条普通消息约 ¥0.001 级）', () => {
    expect(estimateCost({ hit: 0, miss: 0, completion: 0 }, false)).toBe(0)
    // 8 万命中输入 + 1 千输出，谷价：0.08*0.02 + 0.001*4 = 0.0016 + 0.004
    const cost = estimateCost({ hit: 80_000, miss: 0, completion: 1_000 }, false)
    expect(cost).toBeCloseTo(0.0016 + 0.004, 10)
  })
})

describe('保守方向纪律（2026-11-25 拍板：宁可稍微贵点，也别让用户以为我们抽成）', () => {
  /** 读回账本里最近一笔（recordMessageUsage 内部落库，用内存 stub 验证写入值） */
  const captureLastWrite = async (): Promise<{
    rec: typeof import('../src/services/usage/ledger.js').recordMessageUsage
    writes: Record<string, unknown>[]
  }> => {
    const writes: Record<string, unknown>[] = []
    vi.doMock('../src/services/chat/db.js', () => ({
      addUsageLog: async (entry: Record<string, unknown>) => {
        writes.push(entry)
      },
      loadUsageLog: async () => [],
      loadUsageTotal: async () => ({ total: 0, count: 0 }),
    }))
    vi.resetModules()
    const { recordMessageUsage: rec } = await import('../src/services/usage/ledger.js')
    return { rec, writes }
  }

  it('中断无 usage：按已生成文字 1 字 = 1 token 保守记输出，金额 = 字数 × 输出价', async () => {
    const { rec, writes } = await captureLastWrite()
    // 周六谷价，100 字正文，无 usage
    await rec('normal', undefined, beijing(2026, 11, 28, 10).getTime(), undefined, 'a'.repeat(100))
    expect(writes).toHaveLength(1)
    const entry = writes[0] as { hit: number; miss: number; completion: number; cost: number }
    expect(entry.completion).toBe(100)
    expect(entry.hit).toBe(0)
    expect(entry.miss).toBe(0)
    expect(entry.cost).toBeCloseTo((100 / 1_000_000) * 4, 12)
  })

  it('中断无 usage 且无正文：不记（官方对完全失败请求不收费，记了是虚高误导）', async () => {
    const { rec, writes } = await captureLastWrite()
    await rec('normal', undefined, Date.now(), undefined, '')
    expect(writes).toHaveLength(0)
  })

  it('峰谷任一落峰即记峰：13:55 发（谷）→ 14:05 完成（峰），整笔记峰', async () => {
    const { rec, writes } = await captureLastWrite()
    // 13:55 发（谷）→ 14:05 完成（峰）：跨进峰，整笔记峰
    await rec(
      'normal',
      { hit: 0, miss: 1_000_000, completion: 0 },
      beijing(2026, 11, 25, 13, 55).getTime(),
      beijing(2026, 11, 25, 14, 5).getTime()
    )
    expect(writes).toHaveLength(1)
    expect((writes[0] as { peak: boolean }).peak).toBe(true)
    expect((writes[0] as { cost: number }).cost).toBeCloseTo(2, 10) // 未命中价 ×2
  })

  it('两刻都在谷：仍记谷（保守化不改变正常情形）', async () => {
    const { rec, writes } = await captureLastWrite()
    await rec(
      'blanket',
      { hit: 0, miss: 1_000_000, completion: 0 },
      beijing(2026, 11, 25, 12, 30).getTime(),
      beijing(2026, 11, 25, 12, 59).getTime()
    )
    expect(writes).toHaveLength(1)
    expect((writes[0] as { peak: boolean }).peak).toBe(false)
    expect((writes[0] as { cost: number }).cost).toBeCloseTo(1, 10)
  })
})

describe('蒸馏记账（2026-11-25 对账修正：实际 usage + 峰谷实价，不再是谷价预估）', () => {
  const captureDistillWrite = async (): Promise<{
    rec: typeof import('../src/services/usage/ledger.js').recordDistillUsage
    writes: Record<string, unknown>[]
  }> => {
    const writes: Record<string, unknown>[] = []
    vi.doMock('../src/services/chat/db.js', () => ({
      addUsageLog: async (entry: Record<string, unknown>) => {
        writes.push(entry)
      },
      loadUsageLog: async () => [],
      loadUsageTotal: async () => ({ total: 0, count: 0 }),
    }))
    vi.resetModules()
    const { recordDistillUsage: rec } = await import('../src/services/usage/ledger.js')
    return { rec, writes }
  }

  it('峰时蒸馏：prompt 全按未命中峰价、输出按输出峰价（当天实测低估的根因）', async () => {
    const { rec, writes } = await captureDistillWrite()
    // 16:02 蒸馏（峰），prompt 1 万 / 输出 5 千——对账实测 ¥0.107（谷价预估）vs 官方 ¥0.15
    await rec(10_000, 5_000, beijing(2026, 11, 25, 16, 2).getTime())
    expect(writes).toHaveLength(1)
    const entry = writes[0] as { miss: number; hit: number; completion: number; peak: boolean; cost: number }
    expect(entry.miss).toBe(10_000)
    expect(entry.hit).toBe(0)
    expect(entry.completion).toBe(5_000)
    expect(entry.peak).toBe(true)
    expect(entry.cost).toBeCloseTo((10_000 / 1_000_000) * 2 + (5_000 / 1_000_000) * 8, 12)
  })

  it('开始谷、结束峰：整笔记峰（与巩固/聊天同口径）', async () => {
    const { rec, writes } = await captureDistillWrite()
    await rec(
      1_000_000,
      0,
      beijing(2026, 11, 25, 13, 55).getTime(),
      beijing(2026, 11, 25, 14, 5).getTime()
    )
    expect((writes[0] as { peak: boolean }).peak).toBe(true)
    expect((writes[0] as { cost: number }).cost).toBeCloseTo(2, 10)
  })

  it('tokens 全零：不记（没有任何成功调用就没花钱）', async () => {
    const { rec, writes } = await captureDistillWrite()
    await rec(0, 0, Date.now())
    expect(writes).toHaveLength(0)
  })
})
