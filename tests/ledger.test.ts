import { describe, expect, it } from 'vitest'
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
