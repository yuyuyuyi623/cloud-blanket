/**
 * 她的日记：按天倒序的日记本。
 *
 * 生成机制（docs/云朵被子完整方案-v1.md §七/§八）是"静默生成"——她在被子里住下来
 * 会自己写，不用用户按按钮。引擎侧还没实现生成，所以现在这个页面大概率是空的；
 * 空着也要有个说法，不是一句冷冰冰的"暂无数据"。
 */

import { useTranslate } from '../../i18n/index.js'
import type { BlanketRecord } from '../../services/memory/blanket.js'
import { Modal } from '../base/Modal.js'
import listStyles from './BlanketList.module.css'
import styles from './BlanketSidePanel.module.css'

export const DiaryDialog = ({ blanket, onClose }: { blanket: BlanketRecord; onClose: () => void }) => {
  const t = useTranslate()
  // 按天倒序：最新的日记在最上面
  const entries = [...blanket.pack.diary].sort((a, b) => b.date.localeCompare(a.date))

  return (
    <Modal
      title={t('blanketDiaryTitle', { name: blanket.name })}
      onClose={onClose}
      closable
      mainClassName={listStyles.detailMain}
      className={listStyles.detail}
    >
      <div className={listStyles.detailBody}>
        {entries.length ? (
          entries.map((entry, index) => (
            <div key={`${entry.date}-${index}`} className={styles.diaryEntry}>
              <div className={styles.diaryDate}>{entry.date}</div>
              <p className={styles.diaryText}>{entry.text}</p>
            </div>
          ))
        ) : (
          <p className={listStyles.sectionEmpty}>{t('blanketDiaryEmpty')}</p>
        )}
      </div>
    </Modal>
  )
}
