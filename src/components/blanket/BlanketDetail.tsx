import { useState, type ReactNode } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { openBlanketChat } from '../../services/chat/blanketChat.js'
import { removeBlanket, updateBlanket, updatePack } from '../../services/memory/blanketStore.js'
import type { BlanketRecord } from '../../services/memory/blanket.js'
import { exportBlanketMarkdown } from './exportBlanket.js'
import { formatDate } from '../../utils/format.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import styles from './BlanketList.module.css'

/**
 * 她的记忆：角色卡 → 她的日记 → 整体印象 → 核心记忆 → 关于你 → 记得的事。
 *
 * 蒸馏是初稿，这里是定稿：点"改"直接修，改动立即落库生效，下一句话用的就是改后的
 * 记忆（确认页人工修的口子，修口误固化不用重蒸）。事件层只给删，改写一条不如删了重加。
 */
export const BlanketDetail = ({ blanket, onClose }: { blanket: BlanketRecord; onClose: () => void }) => {
  const t = useTranslate()
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const { pack } = blanket
  const created = formatDate(blanket.createdAt, '/')

  /** 改记忆包的任一区块 */
  const save = (mutate: Parameters<typeof updatePack>[1]) => {
    void updatePack(blanket.id, mutate)
  }

  return (
    <Modal
      title={blanket.name}
      onClose={confirming || deleting ? () => undefined : onClose}
      closable={!confirming && !deleting}
      mainClassName={styles.detailMain}
      className={styles.detail}
    >
      <div className={styles.detailBody}>
        <div className={styles.detailMeta}>
          {created ? t('blanketDetailCreatedAt', { date: created }) : null}
          <span>·</span>
          {t('blanketDetailSessions', { count: blanket.sessionIds.length })}
          <span>·</span>
          {t('blanketEditHint')}
        </div>

        <TextSection
          title={t('blanketDetailPersona')}
          value={pack.persona.card}
          empty={t('blanketEditWritePrompt')}
          onSave={(card) => save((p) => ({ ...p, persona: { ...p.persona, card } }))}
        />

        <div className={styles.sectionBlock}>
          <div className={styles.sectionTitle}>{t('blanketDetailDiary')}</div>
          {pack.diary.length ? (
            <ul className={styles.sectionList}>
              {pack.diary.map((entry, index) => (
                <li key={`${entry.date}-${index}`} className={styles.sectionItem}>
                  {entry.date} · {entry.text}
                </li>
              ))}
            </ul>
          ) : (
            <p className={styles.sectionEmpty}>{t('blanketDetailDiaryEmpty')}</p>
          )}
        </div>

        <ImpressionSection blanket={blanket} />

        <ListSection
          title={t('blanketDetailCore')}
          items={pack.coreMemories}
          textOf={(item) => item.text}
          timeOf={(item) => item.at}
          makeItem={(text) => ({ text, at: null })}
          onChange={(coreMemories) => save((p) => ({ ...p, coreMemories }))}
        />

        <ListSection
          title={t('blanketDetailFacts')}
          items={pack.facts}
          textOf={(item) => item.text}
          makeItem={(text) => ({ text })}
          onChange={(facts) => save((p) => ({ ...p, facts }))}
        />

        <ListSection
          title={t('blanketDetailMemories')}
          items={pack.memories}
          textOf={(item) => item.text}
          timeOf={(item) => item.at}
          /** 事件只给删/加：改写一条不如删了重加，brief 是模型蒸的注入短句，手编容易两头不对 */
          freeform={false}
          makeItem={(text) => ({ text, at: null })}
          onChange={(memories) => save((p) => ({ ...p, memories }))}
        />

        {confirming ? (
          <div className={styles.confirmBox}>
            <p className={styles.confirmText}>{t('blanketDetailDeleteHint')}</p>
            <div className={styles.confirmActions}>
              <Button variant="outlined" size="s" onClick={() => setConfirming(false)}>
                {t('cancel')}
              </Button>
              <Button
                variant="danger"
                size="s"
                disabled={deleting}
                onClick={async () => {
                  setDeleting(true)
                  try {
                    await removeBlanket(blanket.id)
                    onClose()
                  } finally {
                    setDeleting(false)
                  }
                }}
              >
                {t('blanketDetailDeleteConfirm')}
              </Button>
            </div>
          </div>
        ) : (
          <div className={styles.detailFooter}>
            <Button size="s" onClick={() => exportBlanketMarkdown(blanket)}>
              {t('blanketDetailExport')}
            </Button>
            <Button
              size="s"
              onClick={() => {
                openBlanketChat(blanket.id)
                onClose()
              }}
            >
              {t('blanketDetailChat')}
            </Button>
            <button type="button" className={styles.deleteLink} onClick={() => setConfirming(true)}>
              {t('blanketDetailDelete')}
            </button>
          </div>
        )}
      </div>
    </Modal>
  )
}

/**
 * 整体印象（半生长区，记忆巩固方案 四·附）：默认她自己重写；
 * 用户手改即接管（impressionAuto = false，显示「已暂停」），点「恢复自动」交还。
 * 角色卡正文与日记是冻结区，机器永不碰——这条红线只豁免这一格。
 */
const ImpressionSection = ({ blanket }: { blanket: BlanketRecord }) => {
  const t = useTranslate()
  const paused = blanket.impressionAuto === false

  return (
    <TextSection
      title={t('blanketDetailImpression')}
      value={blanket.pack.persona.impression ?? ''}
      empty={t('blanketEditWritePrompt')}
      afterTitle={
        paused ? (
          <>
            {' '}
            <span className={styles.impressionBadge}>{t('impressionPaused')}</span>
            <button
              type="button"
              className={styles.editLink}
              onClick={() => {
                void updateBlanket(blanket.id, (record) => ({ ...record, impressionAuto: true }))
              }}
            >
              {t('impressionResume')}
            </button>
          </>
        ) : undefined
      }
      onSave={(impression) => {
        // 手改即接管（拍板选 A）：不弹二次确认，静默停止自动更新
        void updateBlanket(blanket.id, (record) => ({
          ...record,
          pack: { ...record.pack, persona: { ...record.pack.persona, impression } },
          impressionAuto: false,
        }))
      }}
      footer={
        <details className={styles.impressionHint}>
          <summary>{t('impressionHintTitle')}</summary>
          <p>{t('impressionHintBody')}</p>
        </details>
      }
    />
  )
}

/** 整段文字（角色卡、整体印象）：显示态一键改，编辑态 textarea + 存/取消 */
const TextSection = ({
  title,
  value,
  empty,
  onSave,
  afterTitle,
  footer,
}: {
  title: string
  value: string
  /** 为空时也显示区块（带"写"入口），不让用户找不到地方下手 */
  empty: string
  onSave: (value: string) => void
  /** 标题行后缀（如「已暂停」徽标 + 「恢复自动」按钮） */
  afterTitle?: ReactNode
  /** 区块尾部附注（可展开说明等） */
  footer?: ReactNode
}) => {
  const t = useTranslate()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  const start = () => {
    setDraft(value)
    setEditing(true)
  }

  return (
    <div className={styles.sectionBlock}>
      <div className={styles.sectionTitle}>
        {title}
        {afterTitle}
      </div>
      {editing ? (
        <>
          <textarea
            className={styles.editArea}
            value={draft}
            rows={Math.min(16, Math.max(3, Math.ceil(draft.length / 44) + 1))}
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className={styles.editActions}>
            <Button size="s" variant="outlined" onClick={() => setEditing(false)}>
              {t('cancel')}
            </Button>
            <Button
              size="s"
              disabled={!draft.trim() || draft === value}
              onClick={() => {
                onSave(draft.trim())
                setEditing(false)
              }}
            >
              {t('blanketEditSave')}
            </Button>
          </div>
        </>
      ) : value.trim() ? (
        <>
          <p className={styles.personaCard}>{value}</p>
          <button type="button" className={styles.editLink} onClick={start}>
            {t('blanketEditLabel')}
          </button>
        </>
      ) : (
        <>
          <p className={styles.sectionEmpty}>{empty}</p>
          <button type="button" className={styles.editLink} onClick={start}>
            {t('blanketEditWrite')}
          </button>
        </>
      )}
      {footer}
    </div>
  )
}

/**
 * 条目列表（核心记忆、关于你、记得的事）：逐条改/删，底部可加新条。
 * 泛型操作原对象：删和改只动目标条，时间戳（at）和注入短句（brief）不丢。
 */
const ListSection = <T,>({
  title,
  items,
  onChange,
  textOf,
  timeOf,
  makeItem,
  /** 条目是否允许改写正文（事件层只给删——改写不如删了重加） */
  freeform = true,
}: {
  title: string
  items: T[]
  onChange: (items: T[]) => void
  textOf: (item: T) => string
  timeOf?: (item: T) => string | null | undefined
  makeItem: (text: string) => T
  freeform?: boolean
}) => {
  const t = useTranslate()
  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  const [draft, setDraft] = useState('')
  const [adding, setAdding] = useState(false)
  const [addDraft, setAddDraft] = useState('')

  const commit = (next: T[]) => {
    onChange(next)
    setEditingIndex(null)
    setAdding(false)
    setAddDraft('')
  }

  return (
    <div className={styles.sectionBlock}>
      <div className={styles.sectionTitle}>{title}</div>
      {items.length ? (
        <ul className={styles.sectionList}>
          {items.map((item, index) => {
            const text = textOf(item)
            const when = timeOf?.(item)
            const shown = when ? `${when} · ${text}` : text
            return editingIndex === index ? (
              <li key={index} className={styles.listRow}>
                <textarea
                  className={styles.editArea}
                  value={draft}
                  rows={Math.min(8, Math.max(2, Math.ceil(draft.length / 44) + 1))}
                  onChange={(event) => setDraft(event.target.value)}
                />
                <div className={styles.editActions}>
                  <Button size="s" variant="outlined" onClick={() => setEditingIndex(null)}>
                    {t('cancel')}
                  </Button>
                  <Button
                    size="s"
                    disabled={!draft.trim() || draft === text}
                    onClick={() => {
                      const next = [...items]
                      next[index] = { ...item, text: draft.trim() }
                      commit(next)
                    }}
                  >
                    {t('blanketEditSave')}
                  </Button>
                </div>
              </li>
            ) : (
              <li key={index} className={styles.listRow}>
                <span className={styles.sectionItem}>{shown}</span>
                <span className={styles.rowActions}>
                  {freeform ? (
                    <button
                      type="button"
                      className={styles.rowButton}
                      onClick={() => {
                        setDraft(text)
                        setEditingIndex(index)
                      }}
                    >
                      {t('blanketEditLabel')}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className={styles.rowButtonDanger}
                    onClick={() => commit(items.filter((_, i) => i !== index))}
                  >
                    {t('blanketEditRemove')}
                  </button>
                </span>
              </li>
            )
          })}
        </ul>
      ) : null}
      {adding ? (
        <div className={styles.listRow}>
          <textarea
            className={styles.editArea}
            value={addDraft}
            rows={2}
            placeholder={t('blanketEditItemPlaceholder')}
            onChange={(event) => setAddDraft(event.target.value)}
          />
          <div className={styles.editActions}>
            <Button size="s" variant="outlined" onClick={() => setAdding(false)}>
              {t('cancel')}
            </Button>
            <Button
              size="s"
              disabled={!addDraft.trim()}
              onClick={() => commit([...items, makeItem(addDraft.trim())])}
            >
              {t('blanketEditSave')}
            </Button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className={styles.editLink}
          onClick={() => {
            setAddDraft('')
            setAdding(true)
          }}
        >
          {t('blanketEditAdd')}
        </button>
      )}
    </div>
  )
}
