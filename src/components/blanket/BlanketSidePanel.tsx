/**
 * 全局右上角：右侧抽屉，顶栏两个 tab（账本方案 §二）。
 *   · 「她的角落」：被子对话里 → 角色卡、她的日记；不在被子会话里 → 说明 + 被子列表 + 回收站 + 备份/恢复；
 *   · 「账本」：余额（官方接口）+ 本地估算消耗 + 明细（LedgerPanel）；
 * 弹窗从抽屉里点开后抽屉自动收起，不留两层叠在一起的界面。
 */

import { useEffect, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { useChatStore } from '../../services/chat/store.js'
import { setBlanketStyle, useSettings, type BlanketStyle } from '../../services/settings.js'
import {
  purgeBlanket,
  refreshBlankets,
  restoreBlanket,
  TRASH_DAYS,
  useBlankets,
} from '../../services/memory/blanketStore.js'
import { IconBookOutline16, IconCloudOutline16, IconCopyOutline16, IconUserOutline16 } from '../base/icons.js'
import { showToast } from '../base/toastState.js'
import { copyText } from '../../utils/clipboard.js'
import { buildErrorLogText } from '../../services/diagnostics/errorLog.js'
import { exportBackup, restoreBackup } from '../../services/backup/backup.js'
import { reportStorageError } from '../../services/chat/db.js'
import { BlanketDetail } from './BlanketDetail.js'
import { ConsolidationPanel } from './ConsolidationPanel.js'
import { DiaryDialog } from './DiaryDialog.js'
import { LedgerPanel } from './LedgerPanel.js'
import styles from './BlanketSidePanel.module.css'

export const BlanketSidePanel = () => {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  /** 抽屉顶栏 tab（账本方案 §二）：默认她的角落 */
  const [tab, setTab] = useState<'corner' | 'ledger'>('corner')
  /** 备份导出中 / 恢复两步确认的待恢复文件 */
  const [backupBusy, setBackupBusy] = useState(false)
  const [pendingRestore, setPendingRestore] = useState<File | null>(null)
  const restoreInputRef = useRef<HTMLInputElement>(null)
  const recordBackupError = reportStorageError('backup')
  /** 弹窗里显示的被子 id（卡片和日记各一个） */
  const [cardId, setCardId] = useState<string | null>(null)
  const [diaryId, setDiaryId] = useState<string | null>(null)
  const activeId = useChatStore((state) => state.activeId)
  const loaded = useBlankets((state) => state.loaded)
  const list = useBlankets((state) => state.list)
  // 在用的被子 vs 回收站里的
  const alive = list.filter((item) => item.deletedAt === undefined)
  const trash = list.filter((item) => item.deletedAt !== undefined)
  // 当前会话绑在哪床被子上；不在任何被子里就是 null
  const current = loaded
    ? (list.find((item) => item.chatSessionId === activeId) ?? null)
    : null
  const blanketStyle = useSettings((state) => state.blanketStyle)
  const cardBlanket = cardId ? (list.find((item) => item.id === cardId) ?? null) : null
  const diaryBlanket = diaryId ? (list.find((item) => item.id === diaryId) ?? null) : null

  useEffect(() => {
    if (!useBlankets.getState().loaded) {
      void refreshBlankets()
    }
  }, [])

  const doExport = async () => {
    setBackupBusy(true)
    try {
      await exportBackup(__APP_VERSION__ ?? '')
      showToast({ key: 'backupDone' })
    } catch (error) {
      if ((error as { name?: string }).name === 'AbortError') {
        return
      }
      recordBackupError(error)
      showToast({ key: 'backupFailed', type: 'error' })
    } finally {
      setBackupBusy(false)
    }
  }

  const doRestore = async (file: File) => {
    setBackupBusy(true)
    try {
      await restoreBackup(file)
      // 恢复后内存态全部作废（会话列表、被子缓存、设置），重载页面重建，最干净
      window.location.reload()
    } catch (error) {
      recordBackupError(error)
      showToast({ key: 'backupRestoreFailed', type: 'error' })
      setBackupBusy(false)
    }
  }

  return (
    <>
      <button
        type="button"
        className={styles.trigger}
        title={t('blanketPanelOpen')}
        aria-label={t('blanketPanelOpen')}
        onClick={() => setOpen((value) => !value)}
      >
        <IconCloudOutline16 />
      </button>

      {open ? (
        <>
          <div className={styles.backdrop} onClick={() => setOpen(false)} />
          <aside className={styles.panel}>
            <div className={styles.tabs}>
              <button
                type="button"
                className={tab === 'corner' ? styles.tabActive : styles.tab}
                aria-pressed={tab === 'corner'}
                onClick={() => setTab('corner')}
              >
                {t('cornerTab')}
              </button>
              <button
                type="button"
                className={tab === 'ledger' ? styles.tabActive : styles.tab}
                aria-pressed={tab === 'ledger'}
                onClick={() => setTab('ledger')}
              >
                {t('ledgerTab')}
              </button>
            </div>
            {tab === 'ledger' ? (
              <LedgerPanel />
            ) : (
            <>
            {current ? (
              <>
                <div className={styles.panelBlanket}>{current.name}</div>
                <button
                  type="button"
                  className={styles.entry}
                  onClick={() => {
                    setOpen(false)
                    setCardId(current.id)
                  }}
                >
                  <IconUserOutline16 />
                  <span>{t('blanketPanelEntryCard')}</span>
                </button>
                <button
                  type="button"
                  className={styles.entry}
                  onClick={() => {
                    setOpen(false)
                    setDiaryId(current.id)
                  }}
                >
                  <IconBookOutline16 />
                  <span>{t('blanketPanelEntryDiary')}</span>
                </button>
                {/* 记忆巩固区块（方案 §四）：角色卡/日记入口下方 */}
                <ConsolidationPanel blanket={current} />
              </>
            ) : (
              <>
                <p className={styles.panelEmpty}>{t('blanketPanelEmpty')}</p>
                {alive.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={styles.entry}
                    onClick={() => {
                      setOpen(false)
                      setCardId(item.id)
                    }}
                  >
                    <IconUserOutline16 />
                    <span className={styles.entryName}>{item.name}</span>
                  </button>
                ))}
              </>
            )}
            {trash.length ? (
              <>
                <div className={styles.trashTitle}>{t('blanketTrashTitle')}</div>
                {trash.map((item) => {
                  const leftDays = Math.max(
                    1,
                    Math.ceil((TRASH_DAYS * 24 * 60 * 60 * 1000 - (Date.now() - (item.deletedAt ?? 0))) / (24 * 60 * 60 * 1000)),
                  )
                  return (
                    <div key={item.id} className={styles.trashRow}>
                      <div className={styles.trashMain}>
                        <span className={styles.trashName}>{item.name}</span>
                        <span className={styles.trashMeta}>{t('blanketTrashRemaining', { days: leftDays })}</span>
                      </div>
                      <span className={styles.trashActions}>
                        <button
                          type="button"
                          className={styles.trashBtn}
                          onClick={() => void restoreBlanket(item.id)}
                        >
                          {t('blanketTrashRestore')}
                        </button>
                        <button
                          type="button"
                          className={styles.trashBtnDanger}
                          onClick={() => void purgeBlanket(item.id)}
                        >
                          {t('blanketTrashPurge')}
                        </button>
                      </span>
                    </div>
                  )
                })}
              </>
            ) : null}

            {/* 报错日志：出问题时一键复制求助，贴给开发者或任意 AI */}
            <button
              type="button"
              className={styles.entry}
              onClick={() => {
                void copyText(buildErrorLogText()).then((ok) => {
                  showToast(ok ? { key: 'errorLogCopied' } : { key: 'copyFailed', type: 'error' })
                })
              }}
            >
              <IconCopyOutline16 />
              <span>{t('errorLogCopy')}</span>
            </button>

            {/* 备份/恢复（v1.0.1 P0）：换手机/清缓存/换域名都会数据清零，这里是一键带走全部的口子 */}
            <div className={styles.backupBlock}>
              <div className={styles.trashTitle}>{t('backupTitle')}</div>
              <button
                type="button"
                className={styles.entry}
                disabled={backupBusy}
                onClick={() => void doExport()}
              >
                <span>{backupBusy ? t('backupExporting') : t('backupExport')}</span>
              </button>
              <button
                type="button"
                className={styles.entry}
                disabled={backupBusy}
                onClick={() => restoreInputRef.current?.click()}
              >
                <span>{t('backupRestore')}</span>
              </button>
              {pendingRestore ? (
                <div className={styles.backupConfirm}>
                  <p className={styles.backupWarning}>{t('backupRestoreWarning')}</p>
                  <div className={styles.backupConfirmRow}>
                    <button
                      type="button"
                      className={styles.trashBtn}
                      onClick={() => setPendingRestore(null)}
                    >
                      {t('backupRestoreCancel')}
                    </button>
                    <button
                      type="button"
                      className={styles.trashBtnDanger}
                      onClick={() => {
                        const file = pendingRestore
                        setPendingRestore(null)
                        if (file) {
                          void doRestore(file)
                        }
                      }}
                    >
                      {t('backupRestoreConfirm')}
                    </button>
                  </div>
                </div>
              ) : null}
              <p className={styles.backupNote}>{t('backupNote')}</p>
              <input
                ref={restoreInputRef}
                type="file"
                accept=".zip,application/zip"
                hidden
                onChange={(event) => {
                  const file = event.target.files?.[0] ?? null
                  event.target.value = ''
                  setPendingRestore(file)
                }}
              />
            </div>

            {/* 界面风格一键切换：不用进设置翻，点一下立刻变色 */}
            <div className={styles.styleRow}>
              <span className={styles.styleLabel}>{t('blanketPanelStyleLabel')}</span>
              <div className={styles.styleSwitch}>
                {(
                  [
                    ['warm', 'blanketPanelStyleWarm'],
                    ['plain', 'blanketPanelStylePlain'],
                  ] as const satisfies readonly (readonly [BlanketStyle, string])[]
                ).map(([value, labelKey]) => (
                  <button
                    key={value}
                    type="button"
                    className={
                      blanketStyle === value ? styles.styleOptionActive : styles.styleOption
                    }
                    aria-pressed={blanketStyle === value}
                    onClick={() => setBlanketStyle(value)}
                  >
                    {t(labelKey)}
                  </button>
                ))}
              </div>
            </div>
            </>
            )}
          </aside>
        </>
      ) : null}

      {cardBlanket ? <BlanketDetail blanket={cardBlanket} onClose={() => setCardId(null)} /> : null}
      {diaryBlanket ? (
        <DiaryDialog blanket={diaryBlanket} onClose={() => setDiaryId(null)} />
      ) : null}
    </>
  )
}
