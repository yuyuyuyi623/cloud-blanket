/**
 * 导入被子的流程状态机（界面只读这里，不各自散落状态）。
 *
 * 步骤：pick（选文件）→ scanning（粗扫）→ select（勾会话 + 预估）→ confirm（看账）
 *      → running（蒸馏进度）→ done。任一步出错停在原步并把原因写进 error。
 *
 * 筛选三件套（对齐 local/选择器.html 的定稿）：
 *   · 搜标题（手上就有，纯前端过滤）/ 搜聊天内容（要读全文，首次十几秒，读完全库十几 MB 常驻）；
 *   · 排序：轮数（默认）/ 字数 / 聊天天数 / 最近说话 / 内容搜索时按命中数；
 *   · 轮数门槛：不限 / ≥20 / ≥50 / ≥100——短对话蒸出来的多半是"你好""在吗"，不值得花那一份钱。
 * 筛选只改"看得见什么"，不动勾选：筛掉了但勾着的会话依然算钱，所以底部要把这个差额说出来。
 */

import { create } from 'zustand'
import type { ParsedSession } from '../../../engine/parse.js'
import type { DistillProgress } from '../../../engine/distill.js'
import { searchTexts, type ContentHit } from '../../../engine/content-search.js'
import type { SearchMode, SortBy } from '../../../engine/select-sessions.js'
import {
  buildPlan,
  collectSessionTextsFromFile,
  readSelectedSessions,
  scanArchive,
  type ImportPlan,
} from './importBlanket.js'
import { createBlanket } from './importStore.js'
import { refreshBlankets } from './blanketStore.js'
import { describeDistillError, describeScanError } from './describeImportError.js'
import { recordError } from '../diagnostics/errorLog.js'
import { recordDistillCost } from '../usage/ledger.js'
import { translate } from '../../i18n/index.js'

export type ImportStep = 'pick' | 'scanning' | 'select' | 'confirm' | 'running' | 'done'
export type { SearchMode, SortBy }

export interface CreatedBlanketInfo {
  id: string
  name: string
  memories: number
  facts: number
  core: number
}

export interface BlanketImportState {
  open: boolean
  step: ImportStep
  file: File | null
  fileName: string
  /** 粗扫进度（done/total），读完为 null */
  scanProgress: { done: number; total: number } | null
  sessions: ParsedSession[]
  /** 解析失败的会话数（坏文件不阻止其余会话成被子） */
  broken: number
  selected: string[]
  error: string | null
  progress: DistillProgress | null
  created: CreatedBlanketInfo | null

  /** 搜索关键词（标题 / 内容共用同一个框，靠 searchMode 决定搜哪儿） */
  query: string
  searchMode: SearchMode
  sortBy: SortBy
  /** 轮数门槛，0 = 不限 */
  minTurns: number
  /** 内容搜索命中（sessionId → 命中数 + 片段）；标题模式恒为 null */
  hits: Map<string, ContentHit> | null
  /** 首次内容搜索要读整包正文，这是那段进度；不搜时为 null */
  searchProgress: { done: number; total: number } | null
  /** 内容搜索自己的错误（不能跟蒸馏错误混在一个字段里，否则会把上一步的账盖掉） */
  searchError: string | null
}

const initial = {
  open: false,
  step: 'pick' as ImportStep,
  file: null,
  fileName: '',
  scanProgress: null,
  sessions: [],
  broken: 0,
  selected: [],
  error: null,
  progress: null,
  created: null,
  query: '',
  searchMode: 'title' as SearchMode,
  sortBy: 'turns' as SortBy,
  minTurns: 0,
  hits: null,
  searchProgress: null,
  searchError: null,
}

export const useBlanketImport = create<BlanketImportState>(() => ({ ...initial }))

/**
 * 内容搜索的正文缓存与本包绑定：换包/关窗就丢，否则搜的是上一份文件的话。
 * 不放进 store 是因为 Map 只是缓存、界面不该订阅它（订阅了每次搜索都要整表 diff）。
 */
let textCache: Map<string, string> | null = null
let searchTimer: ReturnType<typeof setTimeout> | null = null
/** 每次搜索换一个令牌：慢搜索回来时若已换了关键词或换了包，就丢掉这次结果 */
let searchToken = 0

const dropSearchCache = () => {
  if (searchTimer) {
    clearTimeout(searchTimer)
    searchTimer = null
  }
  searchToken++
  textCache = null
}

export const openBlanketImport = () => {
  dropSearchCache()
  useBlanketImport.setState({ ...initial, open: true })
}

export const closeBlanketImport = () => {
  dropSearchCache()
  useBlanketImport.setState({ open: false })
}

/** 选文件后立刻粗扫：几百个会话也只读统计，列表秒出 */
export const chooseArchive = async (file: File): Promise<void> => {
  dropSearchCache()
  useBlanketImport.setState({
    step: 'scanning',
    file,
    fileName: file.name,
    scanProgress: { done: 0, total: 0 },
    sessions: [],
    broken: 0,
    selected: [],
    error: null,
    query: '',
    hits: null,
    searchProgress: null,
    searchError: null,
  })
  try {
    // 大包（几百 MB）解压要几十秒，必须让用户看到"还在动"
    const result = await scanArchive(file, (done, total) =>
      useBlanketImport.setState({ scanProgress: { done, total } })
    )
    useBlanketImport.setState({
      step: 'select',
      sessions: result.sessions,
      broken: result.broken.length,
      scanProgress: null,
      // 默认一个都不勾：哪些对话"真的是她"，只有本人能判断。
      // 顺手全选等于替他做了这单子最要紧的那个决定，而代价是钱和一份不像她的记忆。
      selected: [],
    })
  } catch (e) {
    recordError('导入', e)
    useBlanketImport.setState({
      step: 'pick',
      scanProgress: null,
      error: describeScanError(e),
    })
  }
}

export const toggleSession = (id: string) =>
  useBlanketImport.setState((state) => ({
    selected: state.selected.includes(id)
      ? state.selected.filter((item) => item !== id)
      : [...state.selected, id],
  }))

/**
 * 勾上"当前筛出来的这些"（并集，不清掉筛选外已经勾过的）。
 * 为什么不做成"以筛选结果替换全部勾选"：筛选是拿来看的，不是拿来做删除的——
 * 手滑切一下排序就把已选的十几个会话丢掉，那是会让人不敢用筛选的。
 */
export const selectSessions = (ids: string[]) =>
  useBlanketImport.setState((state) => ({
    selected: [...new Set([...state.selected, ...ids])],
  }))

export const selectAllSessions = () =>
  useBlanketImport.setState((state) => ({
    selected: state.sessions.map((session) => session.id),
  }))

export const clearSelection = () => useBlanketImport.setState({ selected: [] })

/** 内容搜索：读整包正文（首次）→ 内存子串扫描（之后几十毫秒） */
const runContentSearch = async (query: string): Promise<void> => {
  const { file, searchMode } = useBlanketImport.getState()
  if (searchMode !== 'content' || !file) {
    return
  }
  const keyword = query.trim()
  if (!keyword) {
    useBlanketImport.setState({ hits: null, searchProgress: null })
    return
  }
  const token = ++searchToken
  try {
    if (!textCache) {
      useBlanketImport.setState({ searchProgress: { done: 0, total: 0 }, searchError: null })
      const texts = await collectSessionTextsFromFile(file, (done, total) => {
        if (token === searchToken) {
          useBlanketImport.setState({ searchProgress: { done, total } })
        }
      })
      if (token !== searchToken) {
        return
      }
      textCache = texts
    }
    if (token !== searchToken) {
      return
    }
    const hits = searchTexts(textCache, keyword)
    useBlanketImport.setState({ hits, searchProgress: null, searchError: null })
  } catch (e) {
    if (token !== searchToken) {
      return
    }
    recordError('导入', e)
    useBlanketImport.setState({
      hits: null,
      searchProgress: null,
      searchError: describeScanError(e),
    })
  }
}

export const setQuery = (query: string) => {
  useBlanketImport.setState({ query })
  if (searchTimer) {
    clearTimeout(searchTimer)
    searchTimer = null
  }
  if (useBlanketImport.getState().searchMode !== 'content') {
    return
  }
  // 一个字一个字敲的时候别每次读包：停手 350ms 才搜
  searchTimer = setTimeout(() => {
    searchTimer = null
    void runContentSearch(useBlanketImport.getState().query)
  }, 350)
}

export const setSearchMode = (searchMode: SearchMode) => {
  useBlanketImport.setState({ searchMode, hits: null, searchProgress: null, searchError: null })
  if (searchMode === 'content') {
    void runContentSearch(useBlanketImport.getState().query)
  }
}

export const setSortBy = (sortBy: SortBy) => useBlanketImport.setState({ sortBy })

export const setMinTurns = (minTurns: number) => useBlanketImport.setState({ minTurns })

export const goConfirm = () => useBlanketImport.setState({ step: 'confirm', error: null })

export const backToSelect = () => useBlanketImport.setState({ step: 'select', error: null })

/** 勾选对应的计划与预估（勾选变化时界面实时算） */
export const planFor = (sessions: ParsedSession[], selected: string[]): ImportPlan => {
  const chosen = new Set(selected)
  return buildPlan(sessions.filter((session) => chosen.has(session.id)))
}

/**
 * 真花钱那一步：细读选中会话 → 蒸馏 → 落库。
 * 失败不静默：错误挂在 state 上，已花的调用不会因为重试被清掉（重试是再花一次，由用户决定）。
 */
export const startDistill = async (apiKey: string): Promise<void> => {
  const { file, selected } = useBlanketImport.getState()
  if (!file) {
    useBlanketImport.setState({ error: translate('blanketImportNoFile') })
    return
  }
  useBlanketImport.setState({ step: 'running', error: null, progress: null })
  try {
    const ids = new Set(selected)
    const loaded = await readSelectedSessions(file, ids)
    if (!loaded.sessions.length) {
      throw new Error('选中的会话没有读出正文，请重新选择文件')
    }
    const record = await createBlanket({
      apiKey,
      parsedSessions: loaded.sessions,
      onProgress: (progress) => useBlanketImport.setState({ progress }),
    })
    // 蒸馏记一笔账：金额用确认页那个预估实付（engine/estimate 口径），完成时刻判峰谷
    void recordDistillCost(planFor(loaded.sessions, selected).estimate.costCny)
    // 侧栏"我的被子"立刻能看到新盖的这床
    void refreshBlankets()
    useBlanketImport.setState({
      step: 'done',
      progress: null,
      created: {
        id: record.id,
        name: record.name,
        memories: record.pack.memories.length,
        facts: record.pack.facts.length,
        core: record.pack.coreMemories.length,
      },
    })
  } catch (e) {
    recordError('蒸馏', e)
    useBlanketImport.setState({
      step: 'confirm',
      progress: null,
      error: describeDistillError(e),
    })
  }
}
