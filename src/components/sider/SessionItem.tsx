import clsx from 'clsx'
import { memo, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  IconCloudOutline16,
  IconEditOutline16,
  IconEllipsisOutline16,
  IconTrashOutline16,
} from '../base/icons.js'
import { renameSession, selectSession } from '../../services/chat/store.js'
import { removeBlanket } from '../../services/memory/blanketStore.js'
import type { SessionSummary } from '../../services/chat/types.js'
import { IconButton } from '../base/IconButton.js'
import { Menu, type MenuOption } from '../base/Menu.js'
import { showToast } from '../base/toastState.js'
import { closeMobileSider } from './mobileSiderState.js'
import styles from './SessionItem.module.css'

/**
 * 会话列表的一行。
 *
 * 被子的对话（绑在某床在用的被子上）特殊处理，标题前带一朵云：
 *   · 删除项不是"删掉这条对话"，而是"删除被子"——对话和被子是一体的，
 *     只删对话会留下"被子还在却没了对话"的半截状态（羽翼实测：看着像坏了）；
 *   · 效果和"她的角落 → 角色卡 → 删除"完全一致（被子 + 对话一起进回收站，30 天可恢复）。
 */
export const SessionItem = memo(function SessionItem({
  session,
  active,
  onDelete,
  blanketId,
  blanketName,
}: {
  session: SessionSummary
  active: boolean
  onDelete: () => void
  /** 绑在这条对话上的被子；有值说明这是被子的对话 */
  blanketId?: string
  blanketName?: string
}) {
  const t = useTranslate()
  const [editing, setEditing] = useState(false)
  const displayTitle = session.title || t('untitledChat')
  const name = blanketName ?? ''

  if (editing) {
    const finish = (title: string) => {
      setEditing(false)
      if (title.trim() && title.trim() !== displayTitle) {
        renameSession(session.id, title.trim())
      }
    }
    return (
      <input
        className={styles.renameInput}
        defaultValue={displayTitle}
        autoFocus
        onFocus={(event) => event.target.select()}
        onBlur={(event) => finish(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            finish(event.currentTarget.value)
          } else if (event.key === 'Escape') {
            setEditing(false)
          }
        }}
      />
    )
  }

  const options: MenuOption[] = [
    {
      key: 'rename',
      label: t('sessionItemMenuRenameOption'),
      icon: <IconEditOutline16 />,
      onSelect: () => setEditing(true),
    },
    blanketId
      ? {
          key: 'delete',
          label: t('sessionItemDeleteBlanket', { name }),
          icon: <IconTrashOutline16 />,
          danger: true,
          onSelect: () => {
            void removeBlanket(blanketId).then(() => {
              showToast({ key: 'blanketRemovedToast', params: { name } })
            })
          },
        }
      : {
          key: 'delete',
          label: t('delete'),
          icon: <IconTrashOutline16 />,
          danger: true,
          onSelect: onDelete,
        },
  ]

  return (
    <div
      className={clsx(styles.item, active && styles.active)}
      onClick={() => {
        selectSession(session.id)
        closeMobileSider()
      }}
    >
      <div className={styles.title}>
        {blanketId ? (
          <span className={styles.blanketMark} title={t('sessionItemBlanketMark', { name })}>
            <IconCloudOutline16 />
          </span>
        ) : null}
        <span className={styles.titleText}>{displayTitle}</span>
      </div>
      <div className={styles.action} onClick={(event) => event.stopPropagation()}>
        <Menu options={options}>
          {({ toggle }) => (
            <IconButton icon={<IconEllipsisOutline16 />} aria-label={t('more')} onClick={toggle} />
          )}
        </Menu>
      </div>
    </div>
  )
})
