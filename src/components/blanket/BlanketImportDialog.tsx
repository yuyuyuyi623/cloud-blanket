import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { useSettings } from '../../services/settings.js'
import {
  backToSelect,
  chooseArchive,
  clearSelection,
  closeBlanketImport,
  goConfirm,
  planFor,
  selectAllSessions,
  selectSessions,
  setMinTurns,
  setQuery,
  setSearchMode,
  setSortBy,
  startDistill,
  toggleSession,
  useBlanketImport,
} from '../../services/memory/importState.js'
import { MIN_TURNS_OPTIONS, filterSessions, type SortBy } from '../../../engine/select-sessions.js'
import { DISTILL_CONCURRENCY } from '../../../engine/config.js'
import type { DistillProgress } from '../../../engine/distill.js'
import { openSettings } from '../settings/settingsDialogState.js'
import { openTutorial } from '../guide/tutorialLink.js'
import { BlanketDetail } from './BlanketDetail.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { formatDate } from '../../utils/format.js'
import { useBlankets } from '../../services/memory/blanketStore.js'
import styles from './BlanketImportDialog.module.css'

/** 字数给人看：上万就换成"万字"，数字太长会把估价行挤断 */
const wordsText = (words: number): string =>
  words >= 10_000 ? `${(words / 10_000).toFixed(1)} 万字` : `${words} 字`

/** 已用时长 mm:ss */
const elapsedText = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

const costText = (cost: number): string => cost.toFixed(2)

/**
 * 剩余时间说人话：不到一分钟不报秒数，免得秒表滴答反而更焦虑（口径沿旧壳 DistillRun）。
 * 估算 = 还剩几批 × 上一块多久；还没有块跑完时不编数字，直接说"估算中"。
 */
const remainMs = (progress: DistillProgress): number | null =>
  progress.phase !== 'summarize' && progress.lastBlockMs
    ? Math.ceil((progress.total - progress.done) / DISTILL_CONCURRENCY) * progress.lastBlockMs
    : null

/**
 * 盖进被子：导入 → 勾选 → 看账 → 蒸馏。
 * 每一步都把"会发生什么、要花多少"写在按钮旁边——花钱那一步绝不让人摸瞎点。
 */
export const BlanketImportDialog = () => {
  const t = useTranslate()
  const open = useBlanketImport((state) => state.open)
  const step = useBlanketImport((state) => state.step)
  const fileName = useBlanketImport((state) => state.fileName)
  const scanProgress = useBlanketImport((state) => state.scanProgress)
  const sessions = useBlanketImport((state) => state.sessions)
  const broken = useBlanketImport((state) => state.broken)
  const selected = useBlanketImport((state) => state.selected)
  const progress = useBlanketImport((state) => state.progress)
  const error = useBlanketImport((state) => state.error)
  const created = useBlanketImport((state) => state.created)
  const query = useBlanketImport((state) => state.query)
  const searchMode = useBlanketImport((state) => state.searchMode)
  const sortBy = useBlanketImport((state) => state.sortBy)
  const minTurns = useBlanketImport((state) => state.minTurns)
  const hits = useBlanketImport((state) => state.hits)
  const searchProgress = useBlanketImport((state) => state.searchProgress)
  const searchError = useBlanketImport((state) => state.searchError)
  const apiKey = useSettings((state) => state.apiKey)
  // 蒸完自动弹一次角色卡：她刚醒来，第一眼该看见的是“她记了什么”，不是一句干巴巴的统计
  const createdRecord = useBlankets((state) =>
    state.loaded && created ? state.list.find((item) => item.id === created.id) : undefined
  )

  const [dragging, setDragging] = useState(false)
  /** 粘贴导出链接：只负责把浏览器原生下载发起来，不读内容（对方域名没开 CORS） */
  const [link, setLink] = useState('')
  const [linkError, setLinkError] = useState<string | null>(null)
  const [linkSent, setLinkSent] = useState(false)
  /** 每秒刷一次"已用时间"，只在蒸馏中需要 */
  const [now, setNow] = useState(Date.now)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (step !== 'running') {
      return
    }
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [step])

  const plan = useMemo(() => planFor(sessions, selected), [sessions, selected])
  const estimate = plan.estimate
  const selectedWords = plan.rows.reduce((sum, row) => sum + row.words, 0)

  /** 筛选只改"看得见什么"：勾选照旧，所以要把"筛掉了但还勾着"的数量单独算出来 */
  const visible = useMemo(
    () => filterSessions(sessions, { query, mode: searchMode, sortBy, minTurns, hits }),
    [sessions, query, searchMode, sortBy, minTurns, hits]
  )
  const hiddenSelected = useMemo(() => {
    const shown = new Set(visible.map((session) => session.id))
    return selected.filter((id) => !shown.has(id)).length
  }, [selected, visible])

  /** 剩余毫秒数：估算阶段（还没块跑完）为 null，汇总阶段不给估计 */
  const remain =
    progress && progress.phase === 'blocks' ? remainMs(progress) : null

  if (!open) {
    return null
  }

  const pickFile = (file: File | undefined) => {
    if (file) {
      void chooseArchive(file)
    }
  }

  /**
   * 粘贴链接 → 发起原生下载。
   * 为什么不是 fetch 下来再解析：DeepSeek 的导出域名（对象存储预签名地址）没开 CORS，
   * 浏览器里 JS 读不到它（2026-11-24 实测：Range 支持、无 Access-Control-Allow-Origin）。
   * 所以这里只做一次导航式点击，把下载交给浏览器下载器，下完由用户点上面的选文件。
   */
  const startDownload = () => {
    const url = link.trim()
    if (!/^https:\/\/\S+$/i.test(url)) {
      setLinkError(t('blanketImportLinkInvalid'))
      return
    }
    setLinkError(null)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.rel = 'noopener'
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    setLinkSent(true)
  }

  /** 蒸馏中不许关：engine 没有中断能力，关了就是钱花了、记忆没了 */
  const onClose = () => {
    if (step === 'running') {
      return
    }
    closeBlanketImport()
  }

  const title =
    step === 'done' ? t('blanketImportDoneTitle') : step === 'running' ? t('blanketImportRunningTitle') : t('blanketImportTitle')

  return (
    <Modal
      title={title}
      onClose={onClose}
      closable={step !== 'running'}
      className={styles.dialog}
      mainClassName={styles.dialogMain}
    >
      <div
        className={styles.body}
        // 拖到弹窗其他位置也别让浏览器把 ZIP 当页面打开
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => event.preventDefault()}
      >
        {step === 'pick' ? (
          <>
            <p className={styles.intro}>{t('blanketImportIntro')}</p>
            <button
              type="button"
              className={dragging ? `${styles.drop} ${styles.dropActive}` : styles.drop}
              onClick={() => inputRef.current?.click()}
              onDragOver={(event) => {
                event.preventDefault()
                setDragging(true)
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => {
                event.preventDefault()
                setDragging(false)
                pickFile(event.dataTransfer.files[0])
              }}
            >
              <span className={styles.dropTitle}>{t('blanketImportDropHint')}</span>
              <span className={styles.dropHint}>{t('blanketImportDropFormats')}</span>
            </button>
            <input
              ref={inputRef}
              type="file"
              // accept 放宽：手机文件管理器常把 zip 报成 octet-stream，收窄了会被灰掉选不中。
              // 真正的校验在解析那一步（describeScanError），前端这层只管别挡人。
              accept=".zip,application/zip,application/x-zip-compressed,application/octet-stream"
              hidden
              onChange={(event) => {
                pickFile(event.target.files?.[0])
                event.target.value = ''
              }}
            />
            {/* 手机党：DeepSeek 导出只给一个链接，浏览器里读不了（无 CORS），
                这里帮他发起下载，省掉"复制到地址栏粘贴"那几步 */}
            <div className={styles.linkBox}>
              <div className={styles.linkTitle}>{t('blanketImportLinkTitle')}</div>
              <div className={styles.linkRow}>
                <input
                  type="url"
                  inputMode="url"
                  className={styles.linkInput}
                  value={link}
                  placeholder={t('blanketImportLinkPlaceholder')}
                  onChange={(event) => {
                    setLink(event.target.value)
                    setLinkError(null)
                    setLinkSent(false)
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      startDownload()
                    }
                  }}
                />
                <Button variant="outlined" size="s" disabled={!link.trim()} onClick={startDownload}>
                  {t('blanketImportLinkAction')}
                </Button>
              </div>
              {linkError ? <p className={styles.error}>{linkError}</p> : null}
              <p className={linkSent ? styles.linkStarted : styles.linkHint}>
                {linkSent ? t('blanketImportLinkStarted') : t('blanketImportLinkHint')}
              </p>
            </div>
            {error ? <p className={styles.error}>{error}</p> : null}
            <button type="button" className={styles.guideHint} onClick={openTutorial}>
              {t('guideStuckHint')}
            </button>
          </>
        ) : null}

        {step === 'scanning' ? (
          <div className={styles.center}>
            <div className={styles.spinner} aria-hidden="true" />
            <p className={styles.status}>{t('blanketImportScanning')}</p>
            {scanProgress && scanProgress.total > 0 ? (
              <p className={styles.subtle}>
                {t('blanketImportScanCount', {
                  done: scanProgress.done,
                  total: scanProgress.total,
                })}
              </p>
            ) : null}
          </div>
        ) : null}

        {step === 'select' ? (
          <>
            <div className={styles.summaryRow}>
              <div>
                <div className={styles.fileName}>{fileName}</div>
                <div className={styles.subtle}>
                  {t('blanketImportSessionsFound', { count: sessions.length })}
                  {broken > 0 ? ` · ${t('blanketImportBroken', { count: broken })}` : ''}
                </div>
              </div>
              <div className={styles.bulkActions}>
                <Button
                  variant="outlined"
                  size="s"
                  disabled={!visible.length}
                  onClick={() => selectSessions(visible.map((session) => session.id))}
                >
                  {t('blanketImportSelectVisible', { count: visible.length })}
                </Button>
                {visible.length !== sessions.length ? (
                  <Button variant="outlined" size="s" onClick={selectAllSessions}>
                    {t('blanketImportSelectAll')}
                  </Button>
                ) : null}
                <Button variant="outlined" size="s" onClick={clearSelection}>
                  {t('blanketImportClearSelection')}
                </Button>
              </div>
            </div>

            <div className={styles.tools}>
              <input
                type="search"
                className={styles.search}
                value={query}
                placeholder={t(
                  searchMode === 'content'
                    ? 'blanketImportSearchContentPlaceholder'
                    : 'blanketImportSearchTitlePlaceholder'
                )}
                onChange={(event) => setQuery(event.target.value)}
              />
              <div className={styles.toolRow}>
                <div className={styles.chips}>
                  <button
                    type="button"
                    className={
                      searchMode === 'title' ? `${styles.chip} ${styles.chipOn}` : styles.chip
                    }
                    onClick={() => setSearchMode('title')}
                  >
                    {t('blanketImportSearchTitle')}
                  </button>
                  <button
                    type="button"
                    className={
                      searchMode === 'content' ? `${styles.chip} ${styles.chipOn}` : styles.chip
                    }
                    onClick={() => setSearchMode('content')}
                  >
                    {t('blanketImportSearchContent')}
                  </button>
                </div>
                <div className={styles.selects}>
                  <select
                    className={styles.select}
                    value={sortBy}
                    onChange={(event) => setSortBy(event.target.value as SortBy)}
                  >
                    <option value="turns">{t('blanketImportSortTurns')}</option>
                    <option value="words">{t('blanketImportSortWords')}</option>
                    <option value="days">{t('blanketImportSortDays')}</option>
                    <option value="recent">{t('blanketImportSortRecent')}</option>
                    {searchMode === 'content' ? (
                      <option value="match">{t('blanketImportSortMatch')}</option>
                    ) : null}
                  </select>
                  <select
                    className={styles.select}
                    value={minTurns}
                    onChange={(event) => setMinTurns(Number(event.target.value))}
                  >
                    {MIN_TURNS_OPTIONS.map((option) => (
                      <option key={option} value={option}>
                        {option ? t('blanketImportMinTurns', { turns: option }) : t('blanketImportMinTurnsNone')}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className={styles.toolHint}>
                {searchProgress
                  ? t('blanketImportIndexing', {
                      done: searchProgress.done,
                      total: searchProgress.total,
                    })
                  : t('blanketImportFilterCount', {
                      total: sessions.length,
                      shown: visible.length,
                    })}
              </div>
              {searchError ? (
                <p className={styles.error}>{searchError}</p>
              ) : null}
            </div>

            <div className={styles.list}>
              {visible.map((session) => {
                const checked = selected.includes(session.id)
                const from = formatDate(session.firstAt, '/')
                const to = formatDate(session.lastAt, '/')
                const hit = searchMode === 'content' && query.trim() ? hits?.get(session.id) : undefined
                return (
                  <label
                    key={session.id}
                    className={checked ? `${styles.row} ${styles.rowChecked}` : styles.row}
                  >
                    <input
                      type="checkbox"
                      className={styles.checkbox}
                      checked={checked}
                      onChange={() => toggleSession(session.id)}
                    />
                    <span className={styles.rowMain}>
                      <span className={styles.rowTitle}>{session.title.trim() || t('untitledChat')}</span>
                      <span className={styles.rowMeta}>
                        {t('blanketImportRowMeta', {
                          turns: session.userTurns,
                          words: wordsText(session.words),
                        })}
                        {from ? ` · ${from}${to && to !== from ? `–${to}` : ''}` : ''}
                      </span>
                      {hit ? (
                        <span className={styles.rowHit}>
                          {t('blanketImportHitCount', { count: hit.matches })} · {hit.snippet}
                        </span>
                      ) : null}
                    </span>
                  </label>
                )
              })}
              {!visible.length ? <p className={styles.emptyList}>{t('blanketImportNoMatch')}</p> : null}
            </div>

            <div className={styles.footer}>
              <div className={styles.estimate}>
                {selected.length
                  ? t('blanketImportSelected', {
                      count: selected.length,
                      words: wordsText(selectedWords),
                    })
                  : t('blanketImportNoSelection')}
                {hiddenSelected > 0 ? (
                  <span className={styles.estimateWarn}>
                    {t('blanketImportSelectedHidden', { count: hiddenSelected })}
                  </span>
                ) : null}
                <span className={styles.estimateMoney}>
                  {t('blanketImportEstimate', {
                    blocks: estimate.totalBlocks,
                    cost: costText(estimate.costCny),
                    minutes: estimate.minutes,
                  })}
                </span>
              </div>
              <Button disabled={!selected.length} onClick={goConfirm}>
                {t('blanketImportNext')}
              </Button>
            </div>
          </>
        ) : null}

        {step === 'confirm' ? (
          <>
            <p className={styles.intro}>{t('blanketImportConfirmIntro')}</p>
            <div className={styles.bill}>
              <div className={styles.billRow}>
                <span>{t('blanketImportBillSessions')}</span>
                <span>{t('blanketImportBillSessionsValue', { count: selected.length })}</span>
              </div>
              <div className={styles.billRow}>
                <span>{t('blanketImportBillWords')}</span>
                <span>{wordsText(selectedWords)}</span>
              </div>
              <div className={styles.billRow}>
                <span>{t('blanketImportBillBlocks')}</span>
                <span>
                  {t('blanketImportBillBlocksValue', {
                    blocks: estimate.totalBlocks,
                    calls: estimate.totalCalls,
                  })}
                </span>
              </div>
              <div className={`${styles.billRow} ${styles.billTotal}`}>
                <span>{t('blanketImportBillCost')}</span>
                <span>
                  {t('blanketImportBillCostValue', {
                    cost: costText(estimate.costCny),
                    minutes: estimate.minutes,
                  })}
                </span>
              </div>
            </div>
            <p className={styles.note}>{t('blanketImportConfirmNote')}</p>
            {error ? <p className={styles.error}>{error}</p> : null}
            <div className={styles.footer}>
              <Button variant="outlined" onClick={backToSelect}>
                {t('blanketImportBack')}
              </Button>
              {apiKey ? (
                <Button onClick={() => void startDistill(apiKey)}>
                  {t('blanketImportStart', { cost: costText(estimate.costCny) })}
                </Button>
              ) : (
                <Button onClick={() => openSettings('data')}>{t('blanketImportNeedKey')}</Button>
              )}
            </div>
          </>
        ) : null}

        {step === 'running' ? (
          <div className={styles.center}>
            <div className={styles.progressTrack}>
              <div
                className={styles.progressFill}
                style={{
                  width: `${progress ? Math.round((progress.done / Math.max(1, progress.total)) * 100) : 0}%`,
                }}
              />
            </div>
            <p className={styles.status}>
              {progress
                ? t('blanketImportRunningBlocks', {
                    done: progress.done,
                    total: progress.total,
                  })
                : t('blanketImportRunningPrepare')}
            </p>
            {progress ? (
              <>
                <p className={styles.subtle}>
                  {progress.phase === 'summarize'
                    ? t('blanketImportRunningSummarize')
                    : t('blanketImportRunningElapsed', {
                        time: elapsedText(now - progress.startedAt),
                      })}
                </p>
                {progress.phase !== 'summarize' ? (
                  <p className={styles.subtle}>
                    {remain === null
                      ? t('blanketImportRunningEtaPending')
                      : t('blanketImportRunningEta', {
                          time:
                            remain < 45_000
                              ? t('blanketImportRemainUnder')
                              : t('blanketImportRemainMinutes', {
                                  minutes: Math.max(1, Math.round(remain / 60_000)),
                                }),
                        })}
                  </p>
                ) : null}
              </>
            ) : null}
            <p className={styles.warn}>{t('blanketImportRunningWarn')}</p>
          </div>
        ) : null}

        {step === 'done' && created ? (
          createdRecord ? (
            <BlanketDetail blanket={createdRecord} onClose={closeBlanketImport} />
          ) : (
            <div className={styles.center}>
              <p className={styles.doneTitle}>{t('blanketImportDoneHeading', { name: created.name })}</p>
              <p className={styles.status}>
                {t('blanketImportDoneBody', {
                  memories: created.memories,
                  facts: created.facts,
                  core: created.core,
                })}
              </p>
              <p className={styles.subtle}>{t('blanketImportDoneNext')}</p>
              <Button onClick={closeBlanketImport}>{t('blanketImportDoneClose')}</Button>
            </div>
          )
        ) : null}
      </div>
    </Modal>
  )
}
