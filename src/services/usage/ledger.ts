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

import {
  addUsageLog,
  loadUsageLog,
  loadUsageSince,
  loadUsageTotal,
} from '../chat/db.js'
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
// 保守方向纪律（2026-11-25 羽翼拍板：宁可稍微贵点，也别骗消费者）：
//   - 峰谷取"发送时刻与完成时刻任一落在峰即整笔记峰"；
//   - 中断没拿到 usage 的请求，按已生成文字 1 字 = 1 token 保守记输出（刻意高估 token 数）；
//   - 展示层金额一律向上取整。完全失败、没生成内容的请求仍不记（官方不收费，记了是虚高误导）。

/** 普通模式 / 被子模式的一条回复记一笔。失败静默，不影响聊天。 */
export const recordMessageUsage = async (
  mode: UsageLogEntry['mode'],
  usage: { hit: number; miss: number; completion: number } | undefined,
  requestTs: number,
  /** 完成/中断时刻，峰谷判据之一（默认 = requestTs） */
  doneTs: number = requestTs,
  /** usage 缺失时兜底：已生成的正文文本，按 1 字 1 token 记输出 */
  fallbackText?: string,
  /** 归因字段（2026-11-26 经济方案 §3.4）：联网次数与是否开思考。可选，旧调用不传自动兼容 */
  extra?: { searches?: number; thinking?: boolean }
): Promise<void> => {
  let final = usage
  if (!final || (!final.hit && !final.miss && !final.completion)) {
    if (fallbackText && fallbackText.length > 0) {
      // 中断且服务端没回 usage：DeepSeek 对已生成部分照常收费，这里保守估算，宁可多记
      final = { hit: 0, miss: 0, completion: fallbackText.length }
    } else {
      return // 完全没产出（请求没发出/失败前无内容），官方不收费，不记
    }
  }
  const peak = isPeakHours(new Date(requestTs)) || isPeakHours(new Date(doneTs))
  await addUsageLog({
    ts: requestTs,
    mode,
    hit: final.hit,
    miss: final.miss,
    completion: final.completion,
    peak,
    cost: estimateCost(final, peak),
    ...(extra?.searches ? { searches: extra.searches } : {}),
    ...(extra?.thinking ? { thinking: true } : {}),
  })
}

/**
 * 蒸馏记一笔（2026-11-25 对账修正）：改用蒸馏返回的**实际 usage**（块 + 汇总求和），
 * 不再用 estimate 的谷价预估——峰时按谷价记会低估近一半（实测 ¥0.107 vs 官方 ¥0.15）。
 * 口径与巩固一致（保守三件）：prompt 不分命中/未命中全按未命中价、峰谷取开始/结束任一落峰。
 * 失败/被丢弃的调用拿不到 usage，官方若计费则略低估——已知边界，记在 runDistill 注释里。
 */
export const recordDistillUsage = async (
  promptTokens: number,
  completionTokens: number,
  startTs: number,
  endTs: number = Date.now()
): Promise<void> => {
  const final = {
    hit: 0,
    miss: promptTokens,
    completion: completionTokens,
  }
  if (!(final.miss + final.completion > 0)) {
    return
  }
  const peak = isPeakHours(new Date(startTs)) || isPeakHours(new Date(endTs))
  await addUsageLog({
    ts: endTs,
    mode: 'distill',
    ...final,
    peak,
    cost: estimateCost(final, peak),
  })
}

/**
 * 巩固记一笔（账本方案 §3.3）：走账本同一张表，模式 = 'consolidate'。
 * 保守口径（2026-11-25 拍板）：promptTokens 不分命中/未命中，全部按未命中价计
 * （命中价只有未命中价的 1/50，混算会显著低估）；峰谷取开始/结束任一落峰。
 */
export const recordConsolidationUsage = async (
  promptTokens: number,
  completionTokens: number,
  startTs: number,
  endTs: number = startTs
): Promise<void> => {
  const peak = isPeakHours(new Date(startTs)) || isPeakHours(new Date(endTs))
  await addUsageLog({
    ts: endTs,
    mode: 'consolidate',
    hit: 0,
    miss: promptTokens,
    completion: completionTokens,
    peak,
    cost: estimateCost({ hit: 0, miss: promptTokens, completion: completionTokens }, peak),
  })
}

/** 账本页一次读两样：最近明细 + 全量累计 */
export const getLedger = async (
  limit = 50
): Promise<{ total: number; count: number; entries: UsageLogEntry[] }> => {
  const [{ total, count }, entries] = await Promise.all([loadUsageTotal(), loadUsageLog(limit)])
  return { total, count, entries }
}

/**
 * 「用量与账单」页一次读齐（经济方案 §3.2/§3.4）：
 * 本月汇总、今天汇总、近 7 天日均基线，外加原始记录（明细列表复用）。
 * 读取下界 = min(本月 1 号, 今天往前推 7 天)，正好覆盖三段。
 */
export const getUsagePage = async (): Promise<{
  month: DayStats
  today: DayStats
  base: { count: number; cost: number } | null
  entries: UsageLogEntry[]
}> => {
  const now = Date.now()
  const d = new Date(now)
  const monthStart = new Date(d.getFullYear(), d.getMonth(), 1).getTime()
  const todayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const entries = await loadUsageSince(Math.min(monthStart, todayStart - 7 * 24 * 60 * 60 * 1000))
  const { month, today, prev7 } = splitUsage(entries, now)
  return { month: summarizeDay(month), today: summarizeDay(today), base: dailyAverage(prev7), entries }
}

// ── 用量页纯函数（2026-11-26 经济方案 §3.2 / §3.4，单测覆盖）────────

/** 一天的汇总：条数、金额、联网次数、带联网条目的金额 */
export interface DayStats {
  count: number
  cost: number
  /** Σ 每条记录的联网调用次数（旧记录无 searches 字段按 0） */
  searches: number
  /** 有联网调用的条目金额合计（归因「搜索占了多少」的分母 = cost） */
  searchCost: number
}

export const summarizeDay = (entries: UsageLogEntry[]): DayStats => ({
  count: entries.length,
  cost: entries.reduce((sum, entry) => sum + entry.cost, 0),
  searches: entries.reduce((sum, entry) => sum + (entry.searches ?? 0), 0),
  searchCost: entries.reduce((sum, entry) => ((entry.searches ?? 0) > 0 ? sum + entry.cost : sum), 0),
})

/** 本月（自然月，按本地时区）、今天、近 7 天（不含今天）三段切分 */
export const splitUsage = (
  entries: UsageLogEntry[],
  now: number
): { month: UsageLogEntry[]; today: UsageLogEntry[]; prev7: UsageLogEntry[] } => {
  const d = new Date(now)
  const todayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const monthStart = new Date(d.getFullYear(), d.getMonth(), 1).getTime()
  const prev7Start = todayStart - 7 * 24 * 60 * 60 * 1000
  return {
    month: entries.filter((entry) => entry.ts >= monthStart),
    today: entries.filter((entry) => entry.ts >= todayStart),
    prev7: entries.filter((entry) => entry.ts >= prev7Start && entry.ts < todayStart),
  }
}

/** 近 7 天日均（不含今天）；没有历史数据时返回 null——展示层据此不显示天数与月预估 */
export const dailyAverage = (prev7: UsageLogEntry[]): { count: number; cost: number } | null => {
  const stats = summarizeDay(prev7)
  if (stats.count === 0 && stats.cost <= 0) {
    return null
  }
  return { count: stats.count / 7, cost: stats.cost / 7 }
}

/**
 * 月进度：整数百分比。line ≤ 0 防御性返回 0；不足 1% 返回 0，展示层显示「<1%」。
 * 超 100% 就如实显示（提醒线不是拦截线，超线只是变红）。
 */
export const monthProgress = (monthCost: number, line: number): number =>
  line > 0 && monthCost > 0 ? Math.floor((monthCost / line) * 100) : 0

/** 余额还能用几天：日均 ≤ 0（无历史）返回 null；向下取整，余额尽当天数为 0 */
export const daysLeft = (balance: number, dailyAvg: number): number | null =>
  dailyAvg > 0 ? Math.max(0, Math.floor(balance / dailyAvg)) : null

/**
 * 异常日判定：当日花费 > 近 7 天日均 ×3，或 > 提醒线 ×20%。
 * 两个条件满足任一即异常——前者抓「比平时贵」，后者抓「绝对值大」（无历史数据的新用户靠这条）。
 */
export const isAnomalyDay = (
  today: DayStats,
  base: { cost: number } | null,
  line: number
): boolean => {
  if (today.cost <= 0) {
    return false
  }
  if (base && base.cost > 0 && today.cost > base.cost * 3) {
    return true
  }
  return line > 0 && today.cost > line * 0.2
}

/** 归因结果：把「聊多了」和「单条贵了」拆开，展示层据此选句子 */
export interface DayAttribution {
  anomaly: boolean
  /** 今日花费 ÷ 日均花费（null = 无基线） */
  costRatio: number | null
  /** 今日条数 ÷ 日均条数（null = 无基线） */
  countRatio: number | null
  /** 今日单条均价（元） */
  perMsg: number
  /** 日均单条（元，null = 无基线或 0 条） */
  perMsgBase: number | null
  /** 今日联网次数合计 */
  searches: number
  /** 联网条目金额占比 0~1（null = 今日 0 元或 0 次） */
  searchShare: number | null
}

/**
 * 异常日归因（§3.4）：只陈述事实，不做建议——「建议关搜索」是另一种居高临下。
 * 条数与单条价分开判断：条数多了 = 聊多了；单条贵了 = 问的都是要核实的；两个都多 = 都说。
 */
export const attributeDay = (
  today: DayStats,
  base: { count: number; cost: number } | null,
  line: number
): DayAttribution => {
  const anomaly = isAnomalyDay(today, base, line)
  const perMsg = today.count > 0 ? today.cost / today.count : 0
  const perMsgBase = base && base.count > 0 ? base.cost / base.count : null
  return {
    anomaly,
    costRatio: base && base.cost > 0 ? today.cost / base.cost : null,
    countRatio: base && base.count > 0 ? today.count / base.count : null,
    perMsg,
    perMsgBase,
    searches: today.searches,
    searchShare: today.cost > 0 && today.searches > 0 ? today.searchCost / today.cost : null,
  }
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
