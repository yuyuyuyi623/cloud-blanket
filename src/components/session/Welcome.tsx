import { useIsMobile } from '../../app/viewport.js'
import { useTranslate } from '../../i18n/index.js'
import { disarmBlanketChat, useChatStore } from '../../services/chat/store.js'
import { useBlankets } from '../../services/memory/blanketStore.js'
import { openTutorial } from '../guide/tutorialLink.js'
import { ChatInput } from '../chatInput/ChatInput.js'
import { EntryCards, PlayChips, openJustChat } from './EntryCards.js'
import { MobileHeader } from './MobileHeader.js'
import styles from './Welcome.module.css'

/** 新对话：问候语 + 入口卡片 + 输入框。桌面端居中；移动端输入框吸底 */
export const Welcome = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  // 从"我的被子"点进来、还没说第一句话：欢迎页必须写明在跟谁聊，
  // 否则这一页跟普通新对话一模一样，用户会以为点了没反应。
  const pendingId = useChatStore((state) => state.pendingBlanketId)
  const pendingName = useBlankets((state) =>
    state.list.find((item) => item.id === pendingId)?.name,
  )
  return (
    <div className={styles.container}>
      {isMobile ? <MobileHeader /> : null}
      <div className={styles.welcome}>
        <div className={styles.greeting}>{t('welcomeMessageChat250808')}</div>
        {pendingId ? (
          <div className={styles.blanketHint}>
            <span className={styles.blanketHintText}>
              {pendingName
                ? t('blanketChatPending', { name: pendingName })
                : t('blanketChatPendingUnknown')}
            </span>
            <span className={styles.blanketHintSub}>{t('blanketChatPendingHint')}</span>
            <button
              type="button"
              className={styles.blanketHintExit}
              onClick={() => disarmBlanketChat()}
            >
              {t('blanketChatPendingExit')}
            </button>
          </div>
        ) : null}
        {isMobile ? (
          /* 手机端不加卡片（拍板：主界面保持干净），两条轻量文字链接补入口：
             随便聊聊修复 PlayChips 死路径，指引给新访客讲清三步 */
          <div className={styles.mobileLinks}>
            <button type="button" className={styles.mobileLink} onClick={() => openJustChat(t)}>
              {t('entryChatTitle')} →
            </button>
            <button type="button" className={styles.mobileLink} onClick={() => openTutorial()}>
              {t('guideLinkTitle')}
            </button>
          </div>
        ) : null}
        <PlayChips />
        <ChatInput sessionId={null} />
        {!isMobile ? <EntryCards /> : null}
        {isMobile ? <div className={styles.caveat}>{t('contentCaveat')}</div> : null}
      </div>
    </div>
  )
}
