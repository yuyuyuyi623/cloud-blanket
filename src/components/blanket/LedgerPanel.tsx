/**
 * 「用量与账单」二级页（经济方案 2026-11-26 §3.2，原账本 tab 下沉到设置里）。
 *
 * 展示判据（方案 §3.2 拍板）：「这个数字能不能一步换算回人民币？」——能，就是透明；不能，就是赌场。
 *   - 大字是百分比（映射到用户自定的月度提醒线），金额是小灰字；
 *   - 「条」是用户真实感知的单位（今天 n 条）；
 *   - 明细永远两步可达，绝不上锁；
 *   - 不自造货币（云朵币/积分），不把单条价格贴到回答下面。
 *
 * 三层：
 *   搜索深度  —— 三态派生开关（auto/deep/off），写 thinking/search 两个既有字段；
 *   用量概览  —— 本月 % / 今天条数 / 余额转天数 / 月预估 / 异常日归因（§3.4）；
 *   明细      —— 最近 50 条列表，只读。
 */

import { useEffect, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  getSearchMode,
  setSearchMode,
  setMonthlyReminderLine,
  useSettings,
  type SearchMode,
} from '../../services/settings.js'
import { fetchBalance, getUsagePage, daysLeft, monthProgress } from '../../services/usage/ledger.js'
import type { DayStats } from '../../services/usage/ledger.js'
import { showToast } from '../base/toastState.js'
import type { UsageLogEntry } from '../../services/chat/db.js'
import styles from './BlanketSidePanel.module.css'

const pad = (n: number) => String(n).padStart(2, '0')

/** ts → 「11-25 14:03」本地时间 */
const entryTime = (ts: number): string => {
  const d = new Date(ts)
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 展示向上取整到分：宁可贵点也不能让用户看到的数字低于真账单（2026-11-25 拍板） */
const ceilFen = (cost: number): string => `¥${(Math.ceil(cost * 100) / 100).toFixed(2)}`
/** 单笔向上取整到万分之一元：明细加总只会 ≥ 真实累计 */
const ceilCost = (cost: number): string => `¥${(Math.ceil(cost * 10000) / 10000).toFixed(4)}`

type Balance =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'value'; total: string }
  | { state: 'failed' }

/** 首次超提醒线的轻提示只发一次：标记不进设置备份（属于界面状态，不是用户偏好） */
const OVER_LINE_FLAG = 'chat-demo:usage-over-line-notified'

const MODE_OPTIONS: readonly (readonly [SearchMode, 'usageModeAuto' | 'usageModeDeep' | 'usageModeOff'])[] = [
  ['auto', 'usageModeAuto'],
  ['deep', 'usageModeDeep'],
  ['off', 'usageModeOff'],
]

export const LedgerPanel = () => {
  const t = useTranslate()
  const apiKey = useSettings((state) => state.apiKey)
  const thinking = useSettings((state) => state.thinking)
  const search = useSettings((state) => state.search)
  const reminderLine = useSettings((state) => state.monthlyReminderLine)
  const mode = getSearchMode(thinking, search)

  const [balance, setBalance] = useState<Balance>({ state: 'idle' })
  const [usage, setUsage] = useState<{
    month: DayStats
    today: DayStats
    base: { count: number; cost: number } | null
    entries: UsageLogEntry[]
  } | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)

  const loadBalance = async () => {
    if (!apiKey) {
      setBalance({ state: 'failed' })
      return
    }
    setBalance({ state: 'loading' })
    try {
      const result = await fetchBalance(apiKey)
      setBalance({ state: 'value', total: result.total })
    } catch {
      setBalance({ state: 'failed' })
    }
  }

  useEffect(() => {
    void getUsagePage()
      .then(setUsage)
      .catch(() =>
        setUsage({
          month: { count: 0, cost: 0, searches: 0, searchCost: 0 },
          today: { count: 0, cost: 0, searches: 0, searchCost: 0 },
          base: null,
          entries: [],
        })
      )
    void loadBalance()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在打开页面时取一次，余额刷新走按钮
  }, [])

  const monthCost = usage?.month.cost ?? 0
  const percent = monthProgress(monthCost, reminderLine)
  const overLine = reminderLine > 0 && monthCost > reminderLine

  // 首次超过提醒线：一次轻提示，之后不再提（超线不拦截、不弹窗是纪律，但第一次该说一声）
  useEffect(() => {
    if (overLine && usage) {
      try {
        if (!localStorage.getItem(OVER_LINE_FLAG)) {
          localStorage.setItem(OVER_LINE_FLAG, '1')
          showToast({ key: 'usageOverLineToast', type: 'error' })
        }
      } catch {
        // 存储不可用就不提示，页面里的红字还在
      }
    }
  }, [overLine, usage])

  // 余额转时间（§3.2）：金额是账，时间是体感
  const balanceNumber = balance.state === 'value' ? Number.parseFloat(balance.total) : NaN
  const remainingDays =
    balance.state === 'value' && Number.isFinite(balanceNumber)
      ? daysLeft(balanceNumber, usage?.base?.cost ?? 0)
      : null
  // 月预估：近 7 天日均 × 30，向前看的估算（§3.4）
  const monthEstimate = usage?.base ? usage.base.cost * 30 : null

  // 异常日归因句（§3.4）：只在异常日出现，只陈述事实、不给建议
  const attributionLines: string[] = []
  if (usage) {
    const { today } = usage
    const base = usage.base
    if (today.cost > 0 && base && base.cost > 0 && today.cost > base.cost * 3) {
      attributionLines.push(
        t('usageAttrCostHigh', {
          cost: ceilFen(today.cost),
          avg: ceilFen(base.cost),
          ratio: Math.max(2, Math.round(today.cost / base.cost)),
        })
      )
    }
    if (base && base.count > 0 && today.count > base.count * 1.5) {
      attributionLines.push(
        t('usageAttrCountHigh', { count: today.count, base: Math.max(1, Math.round(base.count)) })
      )
    }
    const perMsgBase = base && base.count > 0 ? base.cost / base.count : null
    if (today.count > 0 && perMsgBase !== null && today.cost / today.count > perMsgBase * 2) {
      attributionLines.push(
        t('usageAttrPerMsgHigh', { cost: ceilFen(today.cost / today.count), avg: ceilFen(perMsgBase) })
      )
    }
    if (today.searches > 0) {
      attributionLines.push(
        t('usageAttrSearch', {
          count: today.searches,
          share: Math.round((today.searchCost / Math.max(today.cost, 1e-9)) * 100),
        })
      )
    }
    if (attributionLines.length === 0 && today.cost > 0 && (overLine || today.cost > reminderLine * 0.2)) {
      attributionLines.push(t('usageAttrGeneric', { cost: ceilFen(today.cost) }))
    }
  }

  const modeLabel = (m: UsageLogEntry['mode']): string =>
    t(
      m === 'normal'
        ? 'ledgerModeNormal'
        : m === 'blanket'
          ? 'ledgerModeBlanket'
          : m === 'distill'
            ? 'ledgerModeDistill'
            : 'ledgerModeConsolidate'
    )

  return (
    <div className={styles.ledgerBlock}>
      {/* 搜索深度三态（§3.1）：派生开关，写 thinking/search 两个既有字段 */}
      <div className={styles.ledgerModeRow}>
        <span className={styles.ledgerModeLabel}>{t('usageModeLabel')}</span>
        <div role="radiogroup" aria-label={t('usageModeLabel')} className={styles.styleSwitch}>
          {MODE_OPTIONS.map(([value, labelKey]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={mode === value}
              className={mode === value ? styles.styleOptionActive : styles.styleOption}
              onClick={() => setSearchMode(value)}
            >
              {t(labelKey)}
            </button>
          ))}
        </div>
      </div>
      <p className={styles.ledgerNote}>
        {mode === 'auto'
          ? t('usageModeAutoHint')
          : mode === 'deep'
            ? t('usageModeDeepHint')
            : t('usageModeOffHint')}
        <br />
        {t('usageModeCostNote')}
      </p>

      {/* 本月：百分比为主，金额为辅（§3.2 配套纪律 1） */}
      <div className={styles.ledgerSectionTitle}>{t('usageMonth')}</div>
      <div
        className={`${styles.ledgerProgressRow} ${overLine ? styles.ledgerProgressOver : ''}`}
      >
        <div
          className={styles.ledgerProgress}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.min(percent, 100)}
        >
          <div
            className={styles.ledgerProgressFill}
            style={{ width: `${Math.min(100, Math.max(2, percent))}%` }}
          />
        </div>
        <span className={styles.ledgerPercent}>{percent > 0 ? `${percent}%` : t('usageUnder1')}</span>
        <span className={styles.ledgerMoneySmall}>
          {t('usageOfLine', { cost: ceilFen(monthCost), line: `¥${reminderLine}` })}
        </span>
      </div>
      {overLine ? <p className={styles.ledgerOverLine}>{t('usageOverLine')}</p> : null}
      {/* 日均参照常驻：提醒线上调到 20 后异常日的灵敏度补偿（§3.2 拍板） */}
      <p className={styles.ledgerMoneySmall}>
        {usage?.base
          ? t('usageDailyAvg', { cost: ceilFen(usage.base.cost) })
          : t('usageDailyAvgEmpty')}
      </p>

      {/* 今天：用户真实感知的单位是「条」 */}
      <div className={styles.ledgerSectionTitle}>{t('usageToday')}</div>
      <div className={styles.ledgerBalance}>
        <span className={styles.ledgerTotalMoney}>
          {usage ? t('usageTodayDetail', { count: usage.today.count, cost: ceilFen(usage.today.cost) }) : '…'}
        </span>
      </div>

      {/* 异常日归因：把「花多了」和「聊多了」拆开（§3.4） */}
      {attributionLines.length ? (
        <p className={styles.ledgerAttribution}>
          {attributionLines.map((line, index) => (
            <span key={index}>
              {line}
              {index < attributionLines.length - 1 ? <br /> : null}
            </span>
          ))}
        </p>
      ) : null}

      {/* 余额：真数据 + 转成时间（§3.2 配套纪律） */}
      <div className={styles.ledgerSectionTitle}>{t('ledgerBalance')}</div>
      <div className={styles.ledgerBalance}>
        <span className={styles.ledgerTotalMoney}>
          {balance.state === 'value' ? `¥${balance.total}` : balance.state === 'loading' ? '…' : '—'}
        </span>
        <button
          type="button"
          className={styles.ledgerRefresh}
          disabled={balance.state === 'loading'}
          onClick={() => void loadBalance()}
        >
          {t('ledgerBalanceRefresh')}
        </button>
      </div>
      <p className={styles.ledgerNote}>
        {balance.state === 'failed'
          ? t('ledgerBalanceFailed')
          : remainingDays !== null
            ? t('usageBalanceDays', { days: remainingDays })
            : t('usageBalanceDaysUnknown')}
      </p>
      {/* 向前看的月预估，与逐条的事后估算并存（§3.4） */}
      {monthEstimate !== null ? (
        <p className={styles.ledgerNote}>{t('usageMonthEstimate', { cost: ceilFen(monthEstimate) })}</p>
      ) : null}

      {/* 月度提醒线：只提醒不拦截；命名不用「预算」（§3.2 拍板） */}
      <div className={styles.ledgerBalance}>
        <span className={styles.ledgerTotalLabel}>{t('usageReminderLine')}</span>
        <input
          type="number"
          min={1}
          max={100}
          className={styles.ledgerLineInput}
          value={reminderLine}
          aria-label={t('usageReminderLine')}
          onChange={(event) => {
            const value = Number(event.target.value)
            if (Number.isFinite(value) && value >= 1 && value <= 100) {
              setMonthlyReminderLine(value)
            }
          }}
        />
      </div>
      <p className={styles.ledgerNote}>{t('usageReminderLineNote')}</p>

      {/* 本地口径说明沿用原账本文案 */}
      <p className={styles.ledgerNote}>{t('ledgerNote')}</p>

      {/* 明细：默认收起，两步可达、绝不上锁（§3.2） */}
      <button
        type="button"
        className={styles.ledgerRefresh}
        onClick={() => setDetailOpen((value) => !value)}
      >
        {detailOpen ? t('usageHideDetail') : t('usageShowDetail')}
      </button>
      {detailOpen ? (
        usage && usage.entries.length ? (
          <div className={styles.ledgerList}>
            {usage.entries.map((entry) => (
              <div key={entry.id} className={styles.ledgerRow}>
                <span className={styles.ledgerMeta}>
                  {entryTime(entry.ts)} · {modeLabel(entry.mode)} ·{' '}
                  {entry.peak ? t('ledgerPeak') : t('ledgerOffPeak')}
                </span>
                <span className={styles.ledgerAmount}>{ceilCost(entry.cost)}</span>
              </div>
            ))}
          </div>
        ) : usage ? (
          <p className={styles.ledgerEmpty}>{t('ledgerEmpty')}</p>
        ) : null
      ) : null}
    </div>
  )
}
