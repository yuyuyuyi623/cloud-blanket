/**
 * 她的角落 · 记忆巩固区块（记忆巩固方案 §四）。
 *
 * 位置：正在被子对话里时，角色卡/日记入口下方。
 * 数据全读本地（水位字段 + chat store 消息条数），不发请求；
 * 巩固进行中读 useConsolidation 的全局运行态。
 */

import { useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { useChatStore } from '../../services/chat/store.js'
import { updateBlanket } from '../../services/memory/blanketStore.js'
import {
  CONSOLIDATION_FAILURE_ALERT,
  consolidationDelta,
  estimateConsolidationCost,
  runConsolidation,
  shouldAutoConsolidate,
  useConsolidation,
} from '../../services/memory/consolidationRunner.js'
import type { BlanketRecord } from '../../services/memory/blanket.js'
import styles from './BlanketSidePanel.module.css'

export const ConsolidationPanel = ({ blanket }: { blanket: BlanketRecord }) => {
  const t = useTranslate()
  const [confirming, setConfirming] = useState(false)

  const session = useChatStore((state) =>
    blanket.chatSessionId ? state.sessionCache[blanket.chatSessionId] : undefined
  )
  const running = useConsolidation((state) => Boolean(state.running[blanket.id]))
  const failures = useConsolidation((state) => state.failures[blanket.id] ?? 0)

  const delta = session ? consolidationDelta(session, blanket.lastConsolidatedMsgCount ?? 0) : { lines: [], count: 0, chars: 0 }
  const autoOn = blanket.autoConsolidate !== false

  const toggleAuto = () => {
    void updateBlanket(blanket.id, (record) => ({
      ...record,
      autoConsolidate: record.autoConsolidate === false,
    }))
  }

  const lastTime = blanket.lastConsolidatedAt
    ? new Date(blanket.lastConsolidatedAt).toLocaleString(undefined, {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : null

  return (
    <div className={styles.backupBlock}>
      <div className={styles.trashTitle}>{t('consolidTitle')}</div>

      {/* 自动巩固开关：只在这里，不进设置页（方案 §七） */}
      <div className={styles.consolidRow}>
        <span className={styles.consolidLabel}>{t('consolidAutoLabel')}</span>
        <button
          type="button"
          className={autoOn ? styles.styleOptionActive : styles.styleOption}
          aria-pressed={autoOn}
          onClick={toggleAuto}
        >
          {autoOn ? t('consolidSwitchOn') : t('consolidSwitchOff')}
        </button>
      </div>

      {/* 水位进度：从不出现"水位"这个内部词 */}
      {shouldAutoConsolidate(delta) ? (
        <p className={styles.consolidStatus}>{t('consolidReady')}</p>
      ) : delta.count > 0 ? (
        <p className={styles.consolidStatus}>{t('consolidRemaining', { count: 80 - delta.count })}</p>
      ) : null}

      {/* 上次巩固 */}
      <p className={styles.consolidStatus}>
        {blanket.lastConsolidatedAt
          ? t('consolidLast', { time: lastTime ?? '', count: blanket.lastConsolidatedNewCount ?? 0 })
          : t('consolidNever')}
      </p>

      {/* 连续失败的被动提示（不弹窗，方案 §3.5） */}
      {failures >= CONSOLIDATION_FAILURE_ALERT ? (
        <p className={styles.consolidFailed}>{t('consolidFailed')}</p>
      ) : null}

      {/* 立即巩固：先显示预估金额再确认；增量 0 置灰；巩固中置灰（方案 §3.4） */}
      {confirming ? (
        <div className={styles.backupConfirm}>
          <p className={styles.backupWarning}>
            {t('consolidConfirm', { cost: `¥${estimateConsolidationCost(delta.chars).toFixed(2)}` })}
          </p>
          <div className={styles.backupConfirmRow}>
            <button type="button" className={styles.trashBtn} onClick={() => setConfirming(false)}>
              {t('cancel')}
            </button>
            <button
              type="button"
              className={styles.trashBtnDanger}
              onClick={() => {
                setConfirming(false)
                void runConsolidation(blanket.id)
              }}
            >
              {t('consolidConfirmYes')}
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className={styles.entry}
          disabled={running || delta.count === 0}
          onClick={() => setConfirming(true)}
        >
          <span>{running ? t('consolidRunning') : delta.count === 0 ? t('consolidEmpty') : t('consolidRun')}</span>
        </button>
      )}

      <p className={styles.backupNote}>{t('consolidNote')}</p>
    </div>
  )
}
