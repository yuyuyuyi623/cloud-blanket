import { useEffect } from 'react'
import { create } from 'zustand'
import { useTranslate } from '../../i18n/index.js'
import type { TranslationKey } from '../../i18n/index.js'
import type { ReactNode } from 'react'
import {
  IconEditOutline16,
  IconNewChatOutline20,
  IconUploadOutline14,
} from '../base/icons.js'
import { showToast } from '../base/toastState.js'
import { openBlanketImport } from '../../services/memory/importState.js'
import { useSettings } from '../../services/settings.js'
import { getDraft, setDraftText } from '../../services/chat/drafts.js'
import { openTutorial } from '../guide/tutorialLink.js'
import { openWelcome } from '../guide/welcomeDialogState.js'
import styles from './EntryCards.module.css'

/** 题库（硬编码，零 API 成本）：中性日常题，严禁人格/关系预设——这是普通模式，没有"她" */
const PLAY_QUESTIONS: TranslationKey[] = [
  'entryPlayQ1',
  'entryPlayQ2',
  'entryPlayQ3',
  'entryPlayQ4',
  'entryPlayQ5',
  'entryPlayQ6',
  'entryPlayQ7',
  'entryPlayQ8',
]

/** 从题库里随机抽 3 条（每次点击重新抽，反复点题目有变化） */
const sampleQuestions = (t: (key: TranslationKey) => string): string[] => {
  const pool = [...PLAY_QUESTIONS]
  const picked: string[] = []
  while (pool.length > 0 && picked.length < 3) {
    const i = Math.floor(Math.random() * pool.length)
    const [key] = pool.splice(i, 1)
    if (key) {
      picked.push(t(key))
    }
  }
  return picked
}

/** 「随便聊聊」试玩浮层的开合状态；渲染在 Welcome 的 ChatInput 上方（输入框在卡片上面） */
export const usePlayChips = create(() => ({ open: false, questions: [] as string[] }))

const closePlayChips = () => usePlayChips.setState({ open: false })

const openPlayChips = (questions: string[]) => usePlayChips.setState({ open: true, questions })

/** 「随便聊聊」点击行为：无 Key → 弹首启引导；有 Key → 浮出候选问题 */
export const openJustChat = (t: (key: TranslationKey) => string) => {
  if (useSettings.getState().apiKey === null) {
    openWelcome()
    return
  }
  openPlayChips(sampleQuestions(t))
}

/**
 * 主区空状态的三张入口卡片（用户旅程场景 A 第 2 步）：
 * 「随便聊聊」＝无 Key 弹首启引导、有 Key 浮出候选问题（试玩，见 usePlayChips）；
 * 「盖进被子」＝导入蒸馏流程（开始导入/问题指引双入口）；
 * 「从零开始」＝人设向导（场景 B，后续接入）。
 * 视觉：官方骨架 + 暖色品牌（米黄卡片，暗色主题夜间被窝配色）；
 * 不放劝退话术；两个未接入的入口点击时如实提示，不装假流程。
 */
export const EntryCards = () => {
  const t = useTranslate()
  const entries: { title: string; desc: string; icon: ReactNode; action: () => void }[] = [
    {
      title: t('entryChatTitle'),
      desc: t('entryChatDesc'),
      icon: <IconNewChatOutline20 />,
      action: () => openJustChat(t),
    },
    {
      title: t('entryBlanketTitle'),
      desc: t('entryBlanketDesc'),
      icon: <IconUploadOutline14 />,
      action: openBlanketImport,
    },
    {
      title: t('entryFromScratchTitle'),
      desc: t('entryFromScratchDesc'),
      icon: <IconEditOutline16 />,
      action: () => showToast(t('entryComingSoon')),
    },
  ]
  return (
    <>
      <div className={styles.entryCards}>
        {entries.map((entry) => (
          <button key={entry.title} type="button" className={styles.entryCard} onClick={entry.action}>
            <span className={styles.entryIcon}>{entry.icon}</span>
            <span className={styles.entryText}>
              <span className={styles.entryTitle}>{entry.title}</span>
              <span className={styles.entryDesc}>{entry.desc}</span>
            </span>
          </button>
        ))}
      </div>
      <div className={styles.linkRow}>
        <div className={styles.linkSlot}>
          <button type="button" className={styles.guideLink} onClick={openTutorial}>
            {t('guideLinkTitle')}
          </button>
        </div>
        <div className={styles.linkSlot} />
        <div className={styles.linkSlot}>
          <a
            className={styles.guideLink}
            href="https://platform.deepseek.com"
            target="_blank"
            rel="noreferrer"
          >
            {t('platformLinkTitle')}
          </a>
        </div>
      </div>
    </>
  )
}

/** 候选问题浮层：渲染在 ChatInput 上方（Welcome.tsx）。点 chip 只填入输入框，不自动发送 */
export const PlayChips = () => {
  const t = useTranslate()
  const open = usePlayChips((state) => state.open)
  const questions = usePlayChips((state) => state.questions)

  // Esc 收起（点别处由透明背板负责）
  useEffect(() => {
    if (!open) {
      return
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closePlayChips()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  if (!open) {
    return null
  }

  const pick = (question: string) => {
    // 不覆盖用户已打的草稿：非空时追加
    const current = getDraft(null).text
    setDraftText(null, current ? `${current} ${question}` : question)
    closePlayChips()
    // 光标落到末尾
    requestAnimationFrame(() => {
      const textarea = document.querySelector<HTMLTextAreaElement>('textarea')
      textarea?.focus({ preventScroll: true })
      const value = getDraft(null).text
      textarea?.setSelectionRange(value.length, value.length)
    })
  }

  return (
    <>
      <div className={styles.playBackdrop} onClick={closePlayChips} />
      <div className={styles.playChips} role="listbox" aria-label={t('entryChatTitle')}>
        {questions.map((question) => (
          <button key={question} type="button" className={styles.playChip} onClick={() => pick(question)}>
            {question}
          </button>
        ))}
        <div className={styles.playHint}>{t('entryPlayHint')}</div>
      </div>
    </>
  )
}
