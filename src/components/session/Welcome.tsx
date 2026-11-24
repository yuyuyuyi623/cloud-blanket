import { useIsMobile } from '../../app/viewport.js'
import { useTranslate } from '../../i18n/index.js'
import { openTutorial } from '../guide/tutorialLink.js'
import { ChatInput } from '../chatInput/ChatInput.js'
import { EntryCards, PlayChips, openJustChat } from './EntryCards.js'
import { MobileHeader } from './MobileHeader.js'
import styles from './Welcome.module.css'

/** 新对话：问候语 + 入口卡片 + 输入框。桌面端居中；移动端输入框吸底 */
export const Welcome = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  return (
    <div className={styles.container}>
      {isMobile ? <MobileHeader /> : null}
      <div className={styles.welcome}>
        <div className={styles.greeting}>{t('welcomeMessageChat250808')}</div>
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
