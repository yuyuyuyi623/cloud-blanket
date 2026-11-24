import clsx from 'clsx'
import { useEffect, useMemo, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  IconPanelLeftOutline16,
  IconSettingsOutline16,
  IconTrashOutline16,
  IconUploadOutline14,
  NewChatIcon,
} from '../base/icons.js'
import { setSiderCollapsed } from '../../services/settings.js'
import { groupSessions } from '../../services/chat/sessionGroups.js'
import {
  disarmBlanketChat,
  newChat,
  trashSession,
  useChatStore,
} from '../../services/chat/store.js'
import { openBlanketImport } from '../../services/memory/importState.js'
import { useBlankets } from '../../services/memory/blanketStore.js'
import { BlanketList } from '../blanket/BlanketList.js'
import { IconButton } from '../base/IconButton.js'
import { showToast } from '../base/toastState.js'
import { openSettings } from '../settings/settingsDialogState.js'
import { closeMobileSider, useMobileSider } from './mobileSiderState.js'
import { SessionItem } from './SessionItem.js'
import { SessionTrashDialog } from './SessionTrashDialog.js'
import styles from './Sider.module.css'

/** 展开的侧边栏：名称与收起按钮、开启新对话、按时间分组的会话列表、底部设置；移动端放在抽屉里，收起按钮关闭抽屉 */
export const Sider = ({ mobile = false }: { mobile?: boolean }) => {
  const t = useTranslate()
  const sessions = useChatStore((state) => state.sessions)
  const trashedCount = useChatStore((state) => state.trashedSessions.length)
  const activeId = useChatStore((state) => state.activeId)
  const [now, setNow] = useState(Date.now)
  // 会话 id → 绑在它上面的被子：这些对话不进普通列表（入口就是"我的被子"那一行）
  const blankets = useBlankets((state) => state.list)
  const blanketBySession = useMemo(() => {
    const map = new Map<string, { id: string; name: string }>()
    for (const item of blankets) {
      if (item.deletedAt === undefined && item.chatSessionId) {
        map.set(item.chatSessionId, { id: item.id, name: item.name })
      }
    }
    return map
  }, [blankets])
  const plainSessions = useMemo(
    () => sessions.filter((session) => !blanketBySession.has(session.id)),
    [sessions, blanketBySession],
  )
  const groups = useMemo(() => groupSessions(plainSessions, now, t), [plainSessions, now, t])
  const [trashOpen, setTrashOpen] = useState(false)

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const refresh = () => {
      clearTimeout(timer)
      const time = Date.now()
      setNow(time)
      const midnight = new Date(time).setHours(24, 0, 0, 0)
      timer = setTimeout(refresh, midnight - time)
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refresh()
      }
    }
    refresh()
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('focus', refresh)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('focus', refresh)
    }
  }, [])

  return (
    <div className={clsx(styles.sider, mobile && styles.mobile)}>
      <div className={styles.top}>
        <div className={styles.branding}>
          <div className={styles.appName}>{t('appName')}</div>
          <a
            className={styles.appAttribution}
            href="https://github.com/deepseek-ai/chat-demo"
            target="_blank"
            rel="noreferrer"
          >
            {t('appAttribution')}
          </a>
        </div>
        <IconButton
          size="m"
          icon={<IconPanelLeftOutline16 />}
          tooltip={t('collapseSiderbarButton')}
          tooltipPlacement="bottom"
          onClick={() => (mobile ? closeMobileSider() : setSiderCollapsed(true))}
        />
      </div>
      <button
        type="button"
        className={styles.newChat}
        onClick={() => {
          disarmBlanketChat()
          newChat()
          closeMobileSider()
        }}
      >
        <span className={styles.newChatIcon}>
          <NewChatIcon />
        </span>
        {t('newChat')}
      </button>
      <button
        type="button"
        className={styles.importEntry}
        onClick={() => {
          openBlanketImport()
          closeMobileSider()
        }}
      >
        <IconUploadOutline14 />
        {t('entryBlanketTitle')}
      </button>
      <div className={styles.listWrap}>
        <div className={styles.list}>
          <BlanketList />
          {groups.map((group) => (
            <div key={group.key} className={styles.section}>
              <div className={styles.sectionHeader}>{group.label}</div>
              {group.sessions.map((session) => {
                const blanket = blanketBySession.get(session.id)
                return (
                  <SessionItem
                    key={session.id}
                    session={session}
                    active={session.id === activeId}
                    blanketId={blanket?.id}
                    blanketName={blanket?.name}
                    onDelete={() => {
                      // 软删进回收站：不用确认框拦截，30 天内随时可找回
                      void trashSession(session.id).then((ok) => {
                        if (ok) {
                          showToast(t('sessionTrashedToast'))
                        } else {
                          showToast({ key: 'sessionDeleteFailed', type: 'error' })
                        }
                      })
                    }}
                  />
                )
              })}
            </div>
          ))}
        </div>
      </div>
      <div className={styles.bottom}>
        <button type="button" className={styles.settings} onClick={() => setTrashOpen(true)}>
          <span className={styles.settingsIcon}>
            <IconTrashOutline16 />
          </span>
          <span className={styles.settingsLabel}>
            {t('sessionTrashTitle')}
            {trashedCount ? ` (${trashedCount})` : ''}
          </span>
        </button>
        <button type="button" className={styles.settings} onClick={() => openSettings('general')}>
          <span className={styles.settingsIcon}>
            <IconSettingsOutline16 />
          </span>
          <span className={styles.settingsLabel}>{t('settings')}</span>
        </button>
      </div>
      {trashOpen ? <SessionTrashDialog onClose={() => setTrashOpen(false)} /> : null}
    </div>
  )
}

/** 移动端抽屉：浮在页面上方，点空白区域关闭。 */
export const MobileSider = () => {
  const open = useMobileSider((state) => state.open)
  if (!open) {
    return null
  }
  return (
    <>
      <div className={styles.drawerMask} onClick={closeMobileSider} />
      <div className={styles.drawer}>
        <Sider mobile />
      </div>
    </>
  )
}
