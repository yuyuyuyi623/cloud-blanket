/**
 * 「账本」tab（档位重做方案 2026-11-27 §三）：
 *
 * 收起态只有两样：本月百分比进度条 + 「当前为经济模式」一行——钱藏一层；
 * 点进度条展开具体花费（本月/今天/日均/余额/归因/明细，v2 经济方案 §3.2/§3.4 代码搬家）；
 * ⚙ 点开档位选择器：普通会话三档（普通/经济/专家，带预估 + 场景百分比，联网恒开模型判断），
 *   被子会话四档（角色扮演/深思/经济/专家，带解释不带预估——人设对话不看价签）；
 *   下方各带一个「显示思考过程」开关（纯 UI 零成本，普通默认开、被子默认关）。
 *
 * 判据沿用 v2 §3.2 拍板：「这个数字能不能一步换算回人民币？」——百分比是钱的音量调小，
 * 明细永远两步可达，绝不上锁；不自造货币，不把价签贴到回答下面。
 */

import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { useTranslate } from '../../i18n/index.js'
import {
  setMonthlyReminderLine,
  setShowThinkingBlanket,
  setShowThinkingNormal,
  setThinkingEffort,
  useSettings,
  type BlanketGear,
  type ThinkingEffort,
} from '../../services/settings.js'
import { useChatStore } from '../../services/chat/store.js'
import { useBlankets, setBlanketGear } from '../../services/memory/blanketStore.js'
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

/**
 * 场景日的估算花费（谷时，元）——场景百分比 = 花费 ÷ 月度提醒线，改提醒线跟着重算，
 * 不写死百分数（档位重做方案 §二）。
 */
const SCENARIO_COSTS = {
  /** 普通档闲聊一整天（约 50 条，纯聊天不查资料） */
  normalChatDay: 0.15,
  /** 经济档日常一天（闲聊为主，模型偶尔自己搜几次） */
  ecoChatDay: 0.4,
  /** 经济档查资料多的日子（多轮调研式对话） */
  ecoResearchDay: 1.5,
  /** 专家档重度调研一天 */
  expertResearchDay: 3.5,
} as const

const scenarioPercent = (cost: number, line: number): number =>
  Math.max(1, Math.round((cost / line) * 100))

export const LedgerPanel = () => {
  const t = useTranslate()
  const apiKey = useSettings((state) => state.apiKey)
  const thinkingEffort = useSettings((state) => state.thinkingEffort)
  const showThinkingNormal = useSettings((state) => state.showThinkingNormal)
  const showThinkingBlanket = useSettings((state) => state.showThinkingBlanket)
  const reminderLine = useSettings((state) => state.monthlyReminderLine)
  const activeId = useChatStore((state) => state.activeId)
  const blanketList = useBlankets((state) => state.list)
  /** 当前会话是不是被子模式：是 → 显示被子档位（四档，不带预估），否 → 全局三档 */
  const blanket = blanketList.find(
    (item) => item.chatSessionId === activeId && item.deletedAt === undefined
  )
  const blanketGear = blanket ? (blanket.chatGear ?? 'roleplay') : null

  const [expanded, setExpanded] = useState(false)
  const [gearOpen, setGearOpen] = useState(false)
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

  /** 当前生效档位的名字（当前模式行） */
  const currentGearLabel = blanketGear
    ? t(
        blanketGear === 'roleplay'
          ? 'blanketGearRoleplay'
          : blanketGear === 'deep'
            ? 'blanketGearDeep'
            : blanketGear === 'eco'
              ? 'blanketGearEco'
              : 'blanketGearExpert'
      )
    : t(
        thinkingEffort === 'off'
          ? 'gearNormalLabel'
          : thinkingEffort === 'low'
            ? 'gearEcoLabel'
            : 'gearExpertLabel'
      )

  /** 档位选项与解释文案：普通三档带预估+场景百分比；被子四档只带解释（人设对话不看价签） */
  type GearOption = {
    value: ThinkingEffort | BlanketGear
    labelKey:
      | 'gearNormalLabel'
      | 'gearEcoLabel'
      | 'gearExpertLabel'
      | 'blanketGearRoleplay'
      | 'blanketGearDeep'
      | 'blanketGearEco'
      | 'blanketGearExpert'
    hintKey:
      | 'gearNormalHint'
      | 'gearEcoHint'
      | 'gearExpertHint'
      | 'blanketGearRoleplayHint'
      | 'blanketGearDeepHint'
      | 'blanketGearEcoHint'
      | 'blanketGearExpertHint'
    scenario?: {
      key: 'gearNormalScenario' | 'gearEcoScenario' | 'gearExpertScenario'
      values: Record<string, string | number>
    }
  }
  const gearOptions: GearOption[] = blanketGear
    ? [
        { value: 'roleplay', labelKey: 'blanketGearRoleplay', hintKey: 'blanketGearRoleplayHint' },
        { value: 'deep', labelKey: 'blanketGearDeep', hintKey: 'blanketGearDeepHint' },
        { value: 'eco', labelKey: 'blanketGearEco', hintKey: 'blanketGearEcoHint' },
        { value: 'expert', labelKey: 'blanketGearExpert', hintKey: 'blanketGearExpertHint' },
      ]
    : [
        {
          value: 'off',
          labelKey: 'gearNormalLabel',
          hintKey: 'gearNormalHint',
          scenario: {
            key: 'gearNormalScenario',
            values: { percent: scenarioPercent(SCENARIO_COSTS.normalChatDay, reminderLine) },
          },
        },
        {
          value: 'low',
          labelKey: 'gearEcoLabel',
          hintKey: 'gearEcoHint',
          scenario: {
            key: 'gearEcoScenario',
            values: {
              percent: scenarioPercent(SCENARIO_COSTS.ecoChatDay, reminderLine),
              percent2: scenarioPercent(SCENARIO_COSTS.ecoResearchDay, reminderLine),
            },
          },
        },
        {
          value: 'max',
          labelKey: 'gearExpertLabel',
          hintKey: 'gearExpertHint',
          scenario: {
            key: 'gearExpertScenario',
            values: { percent: scenarioPercent(SCENARIO_COSTS.expertResearchDay, reminderLine) },
          },
        },
      ]
  const currentGear: ThinkingEffort | BlanketGear = blanketGear ?? thinkingEffort
  const showThinking = blanket ? showThinkingBlanket : showThinkingNormal
  const setShowThinking = blanket ? setShowThinkingBlanket : setShowThinkingNormal

  return (
    <div className={styles.ledgerBlock}>
      {/* 本月：百分比进度条；收起态只有它 + 当前模式行，钱点开才看到（§三） */}
      <div className={styles.ledgerSectionTitle}>{t('usageMonth')}</div>
      <div
        className={clsx(
          styles.ledgerProgressRow,
          styles.ledgerProgressClickable,
          overLine && styles.ledgerProgressOver
        )}
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            setExpanded((value) => !value)
          }
        }}
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
      </div>

      {expanded ? (
        <>
          <p className={styles.ledgerMoneySmall}>
            {t('usageOfLine', { cost: ceilFen(monthCost), line: `¥${reminderLine}` })}
          </p>
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
              {usage
                ? t('usageTodayDetail', { count: usage.today.count, cost: ceilFen(usage.today.cost) })
                : '…'}
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
        </>
      ) : null}

      {/* 当前模式行：收起态的第二样东西 */}
      <div className={styles.ledgerModeRow}>
        <span className={styles.ledgerModeLabel}>
          {t('usageCurrentMode', { mode: currentGearLabel })}
        </span>
        <button
          type="button"
          className={styles.ledgerRefresh}
          aria-expanded={gearOpen}
          onClick={() => setGearOpen((value) => !value)}
        >
          {t('usageGearSettings')}
        </button>
      </div>

      {/* 档位选择器：普通三档带预估+场景百分比；被子四档只带解释（§二/§四） */}
      {gearOpen ? (
        <>
          <div role="radiogroup" aria-label={t('usageGearSettings')} className={styles.styleSwitch}>
            {gearOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={currentGear === option.value}
                className={
                  currentGear === option.value ? styles.styleOptionActive : styles.styleOption
                }
                onClick={() => {
                  if (blanket && blanketGear) {
                    void setBlanketGear(blanket.id, option.value as BlanketGear)
                  } else {
                    setThinkingEffort(option.value as ThinkingEffort)
                  }
                }}
              >
                {t(option.labelKey)}
              </button>
            ))}
          </div>
          {gearOptions.map((option) =>
            currentGear === option.value ? (
              <div key={option.value}>
                <p className={styles.ledgerNote}>{t(option.hintKey)}</p>
                {option.scenario ? (
                  <p className={styles.ledgerMoneySmall}>
                    {t(option.scenario.key, option.scenario.values)}
                  </p>
                ) : null}
              </div>
            ) : null
          )}
          <p className={styles.ledgerNote}>{t('usageModeCostNote')}</p>

          {/* 显示思考过程开关：纯 UI 零成本；普通默认开、被子默认关（保护人设） */}
          <div className={styles.ledgerModeRow}>
            <span className={styles.ledgerModeLabel}>{t('showThinkingLabel')}</span>
            <div className={styles.styleSwitch}>
              <button
                type="button"
                aria-pressed={showThinking}
                className={showThinking ? styles.styleOptionActive : styles.styleOption}
                onClick={() => setShowThinking(true)}
              >
                {t('showThinkingOn')}
              </button>
              <button
                type="button"
                aria-pressed={!showThinking}
                className={!showThinking ? styles.styleOptionActive : styles.styleOption}
                onClick={() => setShowThinking(false)}
              >
                {t('showThinkingOff')}
              </button>
            </div>
          </div>
          <p className={styles.ledgerNote}>{t('showThinkingNote')}</p>
        </>
      ) : null}
    </div>
  )
}
