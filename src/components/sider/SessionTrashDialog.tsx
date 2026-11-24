/**
 * 普通回收站：软删的对话在这里躺 30 天，可恢复、可彻底删。
 * 与右侧"被子回收站"同款口径，只是各管各的东西，互不掺和：
 * 绑在被子上的对话一律不在这里出现——它们的标题就是被子名，
 * 混进来会被当成"被子又出现了一次"。恢复那床被子时对话会自动跟着回来。
 */

import { useMemo } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  removeSession,
  restoreSession,
  SESSION_TRASH_DAYS,
  useChatStore,
} from '../../services/chat/store.js'
import { useBlankets } from '../../services/memory/blanketStore.js'
import { Modal } from '../base/Modal.js'
import styles from './SessionTrashDialog.module.css'

const DAY_MS = 24 * 60 * 60 * 1000

export const SessionTrashDialog = ({ onClose }: { onClose: () => void }) => {
  const t = useTranslate()
  const list = useChatStore((state) => state.trashedSessions)
  const blankets = useBlankets((state) => state.list)

  // 所有被子（含已进回收站的）绑定的对话 id
  const blanketSessionIds = useMemo(() => {
    const set = new Set<string>()
    for (const item of blankets) {
      if (item.chatSessionId) {
        set.add(item.chatSessionId)
      }
    }
    return set
  }, [blankets])

  const plainList = useMemo(
    () => list.filter((session) => !blanketSessionIds.has(session.id)),
    [list, blanketSessionIds]
  )
  const hiddenCount = list.length - plainList.length

  return (
    <Modal title={t('sessionTrashTitle')} onClose={onClose} closable>
      <div className={styles.body}>
        <p className={styles.hint}>{t('sessionTrashHint', { days: SESSION_TRASH_DAYS })}</p>
        {plainList.length ? (
          plainList.map((session) => {
            const leftDays = Math.max(
              1,
              Math.ceil(
                (SESSION_TRASH_DAYS * DAY_MS - (Date.now() - (session.trashedAt ?? 0))) / DAY_MS
              )
            )
            return (
              <div key={session.id} className={styles.row}>
                <div className={styles.main}>
                  <span className={styles.title}>{session.title || t('untitledChat')}</span>
                  <span className={styles.meta}>
                    {t('sessionTrashRemaining', { days: leftDays })}
                  </span>
                </div>
                <div className={styles.actions}>
                  <button
                    type="button"
                    className={styles.linkBtn}
                    onClick={() => void restoreSession(session.id)}
                  >
                    {t('sessionTrashRestore')}
                  </button>
                  <button
                    type="button"
                    className={styles.linkBtnDanger}
                    onClick={() => void removeSession(session.id)}
                  >
                    {t('sessionTrashPurge')}
                  </button>
                </div>
              </div>
            )
          })
        ) : (
          <p className={styles.empty}>{t('sessionTrashEmpty')}</p>
        )}
        {hiddenCount > 0 ? (
          <p className={styles.blanketNote}>{t('sessionTrashBlanketNote', { count: hiddenCount })}</p>
        ) : null}
      </div>
    </Modal>
  )
}
