/**
 * 账本 tab（账本方案 §3）：余额（官方真数据）+ 消耗估算（本地，峰谷折算）+ 最近 50 条明细。
 * 定位纪律：这是"用得爽"的功能，UI 从简——两行数字加一个列表，不做大盘子。
 * 明细只读；账本数据纯本地（usageLog store），只存金额与时间，绝不存消息内容。
 */

import { useEffect, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { useSettings } from '../../services/settings.js'
import { fetchBalance, getLedger } from '../../services/usage/ledger.js'
import type { UsageLogEntry } from '../../services/chat/db.js'
import styles from './BlanketSidePanel.module.css'

const pad = (n: number) => String(n).padStart(2, '0')

/** ts → 「11-25 14:03」本地时间 */
const entryTime = (ts: number): string => {
  const d = new Date(ts)
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

type Balance =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'value'; total: string }
  | { state: 'failed' }

export const LedgerPanel = () => {
  const t = useTranslate()
  const apiKey = useSettings((state) => state.apiKey)
  const [balance, setBalance] = useState<Balance>({ state: 'idle' })
  const [ledger, setLedger] = useState<{ total: number; entries: UsageLogEntry[] } | null>(null)

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

  const loadLedger = async () => {
    try {
      const { total, entries } = await getLedger(50)
      setLedger({ total, entries })
    } catch {
      setLedger({ total: 0, entries: [] })
    }
  }

  useEffect(() => {
    void loadLedger()
    void loadBalance()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在打开账本时取一次，刷新走按钮
  }, [])

  const modeLabel = (mode: UsageLogEntry['mode']): string =>
    t(
      mode === 'normal'
        ? 'ledgerModeNormal'
        : mode === 'blanket'
          ? 'ledgerModeBlanket'
          : mode === 'distill'
            ? 'ledgerModeDistill'
            : 'ledgerModeConsolidate'
    )

  /** 展示向上取整到分：宁可贵点也不能让用户看到的数字低于真账单（2026-11-25 拍板） */
  const ceilFen = (cost: number): string => `¥${(Math.ceil(cost * 100) / 100).toFixed(2)}`
  /** 单笔向上取整到万分之一元：明细加总只会 ≥ 真实累计 */
  const ceilCost = (cost: number): string => `¥${(Math.ceil(cost * 10000) / 10000).toFixed(4)}`

  return (
    <div className={styles.ledgerBlock}>
      {/* 余额：真数据 */}
      <div className={styles.ledgerBalance}>
        <span className={styles.ledgerTotalLabel}>{t('ledgerBalance')}</span>
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
        {balance.state === 'failed' ? t('ledgerBalanceFailed') : t('ledgerBalanceSource')}
      </p>

      {/* 消耗估算：本地口径 */}
      <div className={styles.ledgerBalance}>
        <span className={styles.ledgerTotalLabel}>{t('ledgerTotal')}</span>
        <span className={styles.ledgerTotalMoney}>
          {ledger ? ceilFen(ledger.total) : '…'}
        </span>
      </div>
      <p className={styles.ledgerNote}>{t('ledgerNote')}</p>

      {/* 明细：倒序，最近 50 条，只读 */}
      {ledger && ledger.entries.length ? (
        <div className={styles.ledgerList}>
          {ledger.entries.map((entry) => (
            <div key={entry.id} className={styles.ledgerRow}>
              <span className={styles.ledgerMeta}>
                {entryTime(entry.ts)} · {modeLabel(entry.mode)} ·{' '}
                {entry.peak ? t('ledgerPeak') : t('ledgerOffPeak')}
              </span>
              <span className={styles.ledgerAmount}>{ceilCost(entry.cost)}</span>
            </div>
          ))}
        </div>
      ) : ledger ? (
        <p className={styles.ledgerEmpty}>{t('ledgerEmpty')}</p>
      ) : null}
    </div>
  )
}
