/**
 * 普通回收站：软删的对话在这里躺 30 天，可恢复、可彻底删。
 * 与右侧"被子回收站"同款口径，只是各管各的东西，互不掺和。
 */

import { useTranslate } from '../../i18n/index.js'
import {
  removeSession,
  restoreSession,
  SESSION_TRASH_DAYS,
  useChatStore,
} from '../../services/chat/store.js'
import { Modal } from '../base/Modal.js'
import styles from './SessionTrashDialog.module.css'

const DAY_MS = 24 * 60 * 60 * 1000

export const SessionTrashDialog = ({ onClose }: { onClose: () => void }) => {
  const t = useTranslate()
  const list = useChatStore((state) => state.trashedSessions)

  return (
    <Modal title={t('sessionTrashTitle')} onClose={onClose} closable>
      <div className={styles.body}>
        <p className={styles.hint}>{t('sessionTrashHint', { days: SESSION_TRASH_DAYS })}</p>
        {list.length ? (
          list.map((session) => {
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
      </div>
    </Modal>
  )
}
