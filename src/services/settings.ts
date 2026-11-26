import { create } from 'zustand'
import type { TtsVoice } from './api/speech.js'
import { normalizeLocation, type UserLocation } from './location.js'

export type Locale = 'zh-CN' | 'en-US'

/** 主题偏好；默认跟随系统 */
export type ThemePreference = 'light' | 'dark' | 'system'

/** 界面风格：云朵暖色（默认，米黄卡片）/ 官方原样（全中性色） */
export type BlanketStyle = 'warm' | 'plain'

/** 本机设置，存 localStorage：API Key、语言、主题、位置、朗读音色、深度思考与智能搜索开关、侧边栏收起状态 */
type Settings = {
  apiKey: string | null
  locale: Locale
  themePreference: ThemePreference
  blanketStyle: BlanketStyle
  location: UserLocation | null
  ttsVoice: TtsVoice
  thinking: boolean
  search: boolean
  siderCollapsed: boolean
  /** 月度提醒线（元）：只提醒不拦截，超线不弹窗（2026-11-26 经济方案 §3.2） */
  monthlyReminderLine: number
}

const KEYS = {
  apiKey: 'chat-demo:api-key',
  locale: 'chat-demo:locale',
  location: 'chat-demo:location',
  themePreference: 'chat-demo:theme-preference',
  blanketStyle: 'chat-demo:blanket-style',
  ttsVoice: 'chat-demo:tts-voice',
  thinking: 'chat-demo:thinking',
  search: 'chat-demo:search',
  siderCollapsed: 'chat-demo:sider-collapsed',
  monthlyReminderLine: 'chat-demo:monthly-reminder-line',
} as const

/** 备份/恢复要读写全部设置键；从这里出，避免备份侧自己抄一份清单后两处漂移。 */
export const SETTINGS_KEYS: readonly string[] = Object.values(KEYS)

/** API 密钥的存储键：备份不导出、恢复不覆盖（羽翼拍板 2026-11-25——备份文件可能被别人看，密钥是能直接花钱的活口，重填一次不麻烦），备份侧要单独排除它。 */
export const API_KEY_STORAGE_KEY = KEYS.apiKey

const read = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const write = (key: string, value: string | null) => {
  try {
    if (value === null) {
      localStorage.removeItem(key)
    } else {
      localStorage.setItem(key, value)
    }
  } catch {
    // 存储不可用时只在内存中生效
  }
}

/** 位置选择模式跟随浏览器语言，与应用内选择的界面语言无关。 */
export const isChineseBrowser = (): boolean =>
  (typeof navigator === 'undefined' ? 'zh' : navigator.language).toLowerCase().startsWith('zh')

const initialLocale = (): Locale => {
  const saved = read(KEYS.locale)
  if (saved === 'zh-CN' || saved === 'en-US') {
    return saved
  }
  return isChineseBrowser() ? 'zh-CN' : 'en-US'
}

const initialLocation = (): UserLocation | null => {
  try {
    const location = normalizeLocation(JSON.parse(read(KEYS.location) ?? 'null'))
    if (!location) {
      return null
    }
    return isChineseBrowser()
      ? location.region === 'CN' && location.province
        ? location
        : null
      : { region: location.region }
  } catch {
    return null
  }
}

/** 未保存过时跟随系统 */
const initialThemePreference = (): ThemePreference => {
  const saved = read(KEYS.themePreference)
  return saved === 'light' || saved === 'dark' ? saved : 'system'
}

/** 未保存过时使用云朵暖色 */
const initialBlanketStyle = (): BlanketStyle => (read(KEYS.blanketStyle) === 'plain' ? 'plain' : 'warm')

/** 未保存过时使用服务端默认音色 stella（海星） */
const initialTtsVoice = (): TtsVoice => (read(KEYS.ttsVoice) === 'tide' ? 'tide' : 'stella')

/** 月度提醒线默认 ¥20（2026-11-26 拍板上调：不拦截的线设高点没有代价，且避免重度日误撞线）；可改 1~100 */
export const MONTHLY_REMINDER_LINE_DEFAULT = 20
const clampReminderLine = (value: number): number =>
  Number.isFinite(value) ? Math.min(100, Math.max(1, Math.round(value))) : MONTHLY_REMINDER_LINE_DEFAULT
const initialMonthlyReminderLine = (): number => {
  const saved = Number(read(KEYS.monthlyReminderLine))
  return Number.isFinite(saved) && saved >= 1 && saved <= 100
    ? Math.round(saved)
    : MONTHLY_REMINDER_LINE_DEFAULT
}

export const useSettings = create<Settings>(() => ({
  apiKey: read(KEYS.apiKey),
  locale: initialLocale(),
  location: initialLocation(),
  themePreference: initialThemePreference(),
  blanketStyle: initialBlanketStyle(),
  ttsVoice: initialTtsVoice(),
  thinking: read(KEYS.thinking) === 'true',
  search: read(KEYS.search) === 'true',
  siderCollapsed: read(KEYS.siderCollapsed) === 'true',
  monthlyReminderLine: initialMonthlyReminderLine(),
}))

export const setLocale = (locale: Locale) => {
  write(KEYS.locale, locale)
  useSettings.setState({ locale })
}

export const setLocation = (value: UserLocation | null) => {
  const location = normalizeLocation(value)
  write(KEYS.location, location ? JSON.stringify(location) : null)
  useSettings.setState({ location })
}

export const setThemePreference = (themePreference: ThemePreference) => {
  write(KEYS.themePreference, themePreference)
  useSettings.setState({ themePreference })
}

export const setBlanketStyle = (blanketStyle: BlanketStyle) => {
  write(KEYS.blanketStyle, blanketStyle)
  useSettings.setState({ blanketStyle })
}

export const setTtsVoice = (ttsVoice: TtsVoice) => {
  write(KEYS.ttsVoice, ttsVoice)
  useSettings.setState({ ttsVoice })
}

export const setApiKey = (apiKey: string | null) => {
  write(KEYS.apiKey, apiKey)
  useSettings.setState({ apiKey })
}

export const setThinking = (thinking: boolean) => {
  write(KEYS.thinking, String(thinking))
  useSettings.setState({ thinking })
}

export const setSearch = (search: boolean) => {
  write(KEYS.search, String(search))
  useSettings.setState({ search })
}

export const setSiderCollapsed = (siderCollapsed: boolean) => {
  write(KEYS.siderCollapsed, String(siderCollapsed))
  useSettings.setState({ siderCollapsed })
}

export const setMonthlyReminderLine = (line: number) => {
  const value = clampReminderLine(line)
  write(KEYS.monthlyReminderLine, String(value))
  useSettings.setState({ monthlyReminderLine: value })
}

// ── 搜索深度三态（2026-11-26 经济方案 §3.3）────────────────────
// searchMode 是 thinking/search 两个既有字段的**派生视图**，不是第三套真值：
//   自动 = thinking 关 + 搜索声明保留（官方：关思考时由模型自己判断搜不搜，一轮最多一次搜索）
//   深度 = thinking 开 + 搜索声明保留（深度搜索，边想边搜、最多约 20 步工具调用）
//   关   = 不声明搜索（答案只靠已知，thinking 随用户）
// 输入区手动改 thinking/search → 派生档位自动跟随，不存在“档位与开关不一致”的状态，
// 也就不需要“本次已手动调整”的提示逻辑（方案原文的提示条因派生设计而不需要）。

export type SearchMode = 'auto' | 'deep' | 'off'

export const getSearchMode = (thinking: boolean, search: boolean): SearchMode =>
  !search ? 'off' : thinking ? 'deep' : 'auto'

export const setSearchMode = (mode: SearchMode) => {
  if (mode === 'auto') {
    setThinking(false)
    setSearch(true)
  } else if (mode === 'deep') {
    setThinking(true)
    setSearch(true)
  } else {
    setSearch(false)
  }
}
