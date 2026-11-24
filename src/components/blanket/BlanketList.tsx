import { useEffect } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { openBlanketChat } from '../../services/chat/blanketChat.js'
import { refreshBlankets, useBlankets } from '../../services/memory/blanketStore.js'
import { closeMobileSider } from '../sider/mobileSiderState.js'
import styles from './BlanketList.module.css'

/**
 * 侧栏的"我的被子"分组：每床一行，**点行 = 直接进聊天**（聊天是默认动作）。
 * 看她的记忆走右上角"她的角落"抽屉，行尾不放按钮——入口只有一个才不会点错。
 * 没有被子时整组不渲染——新用户不该看到一行空标题。
 */
export const BlanketList = () => {
  const t = useTranslate()
  const list = useBlankets((state) => state.list)

  useEffect(() => {
    void refreshBlankets()
  }, [])

  if (!list.length) {
    return null
  }

  // 回收站里的不进侧栏（在看的人不该被"已删的"打扰，回收站在"她的角落"抽屉里）
  const alive = list.filter((item) => item.deletedAt === undefined)
  if (!alive.length) {
    return null
  }

  return (
    <div className={styles.section}>
      <div className={styles.header}>{t('blanketListTitle')}</div>
      {alive.map((blanket) => (
        <button
          key={blanket.id}
          type="button"
          className={styles.item}
          onClick={() => {
            openBlanketChat(blanket.id)
            // 手机端抽屉要主动收起：没聊过的被子走的是新对话，activeId 本来就是 null，
            // App 里"activeId 变化就收抽屉"的 effect 不会触发，抽屉会一直挡着，看着像没点动。
            closeMobileSider()
          }}
          title={t('blanketDetailChat')}
        >
          <span className={styles.itemName}>{blanket.name}</span>
          <span className={styles.itemMeta}>
            {t('blanketListItemMeta', { count: blanket.pack.memories.length })}
          </span>
        </button>
      ))}
    </div>
  )
}
