/**
 * 账本（右侧抽屉仪表板，账本方案 2026-11-24 §3）。
 *
 * 三层数据：
 *   余额      —— DeepSeek 官方接口 GET /user/balance，用用户自己的 Key，零后端；
 *   消耗估算  —— 每条消息完成后从 usage 记一笔，按峰谷价折算，纯本地估算；
 *   明细      —— usageLog store 倒序列表，只读。
 *
 * 口径纪律（方案 §3.2）：
 *   - 峰谷按"请求发出时刻"判，北京时间周一至五 9:00–12:00、14:00–18:00 为高峰 ×2，其余谷价；
 *   - 价目表硬编码（flash 档），官方改价/改时段时这里要跟（对账入口）；
 *   - 边缘误差（11:59 发的请求按 12:00 计等）不做处理，属可接受估算误差；
 *   - 顶部永远标注「本地估算，以 DeepSeek 平台账单为准」。
 */

import { addUsageLog, loadUsageLog, loadUsageTotal } from '../chat/db.js'
import type { UsageLogEntry } from '../chat/db.js'

// ── 纯函数（单测覆盖）────────────────────────────────────────

/** 价目表（deepseek-flash，每百万 token，人民币）。官方改价时改这里并同步方案文档。 */
export const PRICE_PER_MILLION = {
  /** 缓存命中输入：谷 / 峰 */
  hit: { off: 0.02, peak: 0.04 },
  /** 未命中输入：谷 / 峰 */
  miss: { off: 1, peak: 2 },
  /** 输出：谷 / 峰 */
  completion: { off: 4, peak: 8 },
} as const

/**
 * 峰谷判定：UTC+8 的周一至五 9:00–12:00、14:00–18:00 为高峰，其余（晚间/周末）谷价。
 * 中国无夏令时，固定 +8 偏移即可；边界 12:00/14:00/18:00 属于谷（半开区间 [start, end)）。
 */
export const isPeakHours = (date: Date): boolean => {
  // 把 UTC 毫秒平移到北京时钟，再用 getUTC* 读出"北京墙上时间"
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000)
  const day = shifted.getUTCDay() // 0=周日
  const hour = shifted.getUTCHours()
  if (day === 0 || day === 6) {
    return false
  }
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18)
}

/** 一笔 token 用量折算人民币。峰谷倍率 ×2，所以按档位乘 2 表达，不另存倍率常量。 */
export const estimateCost = (
  usage: { hit: number; miss: number; completion: number },
  peak: boolean
): number => {
  const scale = (perMillion: { off: number; peak: number }, tokens: number) =>
    (tokens / 1_000_000) * (peak ? perMillion.peak : perMillion.off)
  return (
    scale(PRICE_PER_MILLION.hit, usage.hit) +
    scale(PRICE_PER_MILLION.miss, usage.miss) +
    scale(PRICE_PER_MILLION.completion, usage.completion)
  )
}

// ── 记账（三链路共用）────────────────────────────────────────

/** 普通模式 / 被子模式的一条回复记一笔。失败静默，不影响聊天。 */
export const recordMessageUsage = async (
  mode: UsageLogEntry['mode'],
  usage: { hit: number; miss: number; completion: number } | undefined,
  requestTs: number
): Promise<void> => {
  if (!usage || (!usage.hit && !usage.miss && !usage.completion)) {
    return // 该请求没拿到 usage（如上传失败重试前的中断），如实不计，不编数据
  }
  const peak = isPeakHours(new Date(requestTs))
  await addUsageLog({
    ts: requestTs,
    mode,
    hit: usage.hit,
    miss: usage.miss,
    completion: usage.completion,
    peak,
    cost: estimateCost(usage, peak),
  })
}

/** 蒸馏记一笔：金额用导入确认页算出的预估实付（engine/estimate 的口径），完成时刻判峰谷 */
export const recordDistillCost = async (costCny: number, ts: number = Date.now()): Promise<void> => {
  if (!(costCny > 0)) {
    return
  }
  const peak = isPeakHours(new Date(ts))
  await addUsageLog({ ts, mode: 'distill', hit: 0, miss: 0, completion: 0, peak, cost: costCny })
}

/** 账本页一次读两样：最近明细 + 全量累计 */
export const getLedger = async (
  limit = 50
): Promise<{ total: number; count: number; entries: UsageLogEntry[] }> => {
  const [{ total, count }, entries] = await Promise.all([loadUsageTotal(), loadUsageLog(limit)])
  return { total, count, entries }
}

// ── 余额（官方真数据）────────────────────────────────────────

export interface BalanceResult {
  /** 人民币余额（字符串，官方返回就是字符串金额） */
  total: string
  isAvailable: boolean
}

/**
 * GET https://api.deepseek.com/user/balance（官方文档 2026-11-25 核对）。
 * 返回 balance_infos 数组按币种取 CNY；Key 无效/网络失败抛错，由调用方给友好文案。
 */
export const fetchBalance = async (apiKey: string): Promise<BalanceResult> => {
  const response = await fetch('https://api.deepseek.com/user/balance', {
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  if (!response.ok) {
    throw new Error(`balance ${response.status}`)
  }
  const data = (await response.json()) as {
    is_available?: boolean
    balance_infos?: { currency?: string; total_balance?: string }[]
  }
  const cny = data.balance_infos?.find((info) => info.currency === 'CNY')
  if (!cny?.total_balance) {
    throw new Error('balance missing CNY entry')
  }
  return { total: cny.total_balance, isAvailable: data.is_available !== false }
}
