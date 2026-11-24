/**
 * 全局右上角："她的角落"。
 *
 * 点右上角的图标按钮，从右边滑出一小条侧栏：
 *   · 正在被子的对话里 → 两个入口：角色卡、她的日记；
 *   · 不在被子的对话里 → 一行说明 + 盖好的被子列表（点一床直接看她的记忆）。
 * 弹窗从抽屉里点开后抽屉自动收起，不留两层叠在一起的界面。
 */

import { useEffect, useState } from 'react'
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
import { BlanketDetail } from './BlanketDetail.js'
import { DiaryDialog } from './DiaryDialog.js'
import styles from './BlanketSidePanel.module.css'

export const BlanketSidePanel = () => {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
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
            <div className={styles.panelTitle}>{t('blanketPanelTitle')}</div>
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
