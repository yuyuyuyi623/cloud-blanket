import { create } from 'zustand'
import type { TtsVoice } from './api/speech.js'
import { normalizeLocation, type UserLocation } from './location.js'

export type Locale = 'zh-CN' | 'en-US'

/** 主题偏好；默认跟随系统 */
export type ThemePreference = 'light' | 'dark' | 'system'

/** 界面风格：云朵暖色（默认，米黄卡片）/ 官方原样（全中性色） */
export type BlanketStyle = 'warm' | 'plain'

/** 思考强度（普通模式档位）：off=普通（秒出）/ low=经济（默认，短思考链）/ max=专家（档位重做方案 2026-11-27） */
export type ThinkingEffort = 'off' | 'low' | 'max'
/** 请求用的思考力度；被子深思档用 high（不在普通档位里出现） */
export type EffortLevel = 'low' | 'high' | 'max'

/** 被子档位（每床被子单独存，缺省 roleplay；档位重做方案 §四） */
export type BlanketGear = 'roleplay' | 'deep' | 'eco' | 'expert'

/**
 * 一轮回复的请求参数快照：thinking=是否开思考链；effort=思考力度（开时才有）；
 * search=是否声明联网搜索。存到每条回复上（chat/types.ts AssistantMessage），
 * 续写/重试沿用原快照，重生成才取当前档位。
 */
export type ReplyParams = { thinking: boolean; effort?: EffortLevel; search: boolean }

/** 普通模式：联网恒开（搜不搜模型自己判断），档位只决定思考强度 */
export const normalReplyParams = (effort: ThinkingEffort): ReplyParams => ({
  thinking: effort !== 'off',
  ...(effort !== 'off' ? { effort } : {}),
  search: true,
})

/** 被子档位 → 请求参数：全矩阵穷尽（角色扮演 off/off、深思 high/关、经济 off/开、专家 max/开） */
export const gearReplyParams = (gear: BlanketGear): ReplyParams => {
  switch (gear) {
    case 'deep':
      return { thinking: true, effort: 'high', search: false }
    case 'eco':
      return { thinking: false, search: true }
    case 'expert':
      return { thinking: true, effort: 'max', search: true }
    default:
      return { thinking: false, search: false }
  }
}

/** 本机设置，存 localStorage：API Key、语言、主题、位置、朗读音色、思考强度档位与思考链显示开关、侧边栏收起状态 */
type Settings = {
  apiKey: string | null
  locale: Locale
  themePreference: ThemePreference
  blanketStyle: BlanketStyle
  location: UserLocation | null
  ttsVoice: TtsVoice
  /** 普通模式思考强度档位；联网恒开，不再单独存 search 开关 */
  thinkingEffort: ThinkingEffort
  /** 思考链显示开关（纯 UI，不影响请求与账单）：普通模式默认开 */
  showThinkingNormal: boolean
  /** 思考链显示开关：被子模式默认关（人设不当众露思考独白） */
  showThinkingBlanket: boolean
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
  thinkingEffort: 'chat-demo:thinking-effort',
  showThinkingNormal: 'chat-demo:show-thinking-normal',
  showThinkingBlanket: 'chat-demo:show-thinking-blanket',
  siderCollapsed: 'chat-demo:sider-collapsed',
  monthlyReminderLine: 'chat-demo:monthly-reminder-line',
} as const

/** 旧版布尔思考开关的存储键（只读不写，迁移用；2026-11-26 经济方案只上线一天） */
const LEGACY_THINKING_KEY = 'chat-demo:thinking'

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

/**
 * 思考强度初值 + 旧布尔迁移：存过新键直接用；没存过但存过旧 thinking 布尔时
 * false→low（原自动档≈新默认经济）、true→max（原深度档）；全新用户 = 经济。
 */
const initialThinkingEffort = (): ThinkingEffort => {
  const saved = read(KEYS.thinkingEffort)
  if (saved === 'off' || saved === 'low' || saved === 'max') {
    return saved
  }
  return read(LEGACY_THINKING_KEY) === 'true' ? 'max' : 'low'
}

/** 思考链显示开关初值：普通默认开、被子默认关（2026-11-27 拍板） */
const initialFlag = (key: string, fallback: boolean): boolean => {
  const saved = read(key)
  return saved === null ? fallback : saved === 'true'
}

export const useSettings = create<Settings>(() => ({
  apiKey: read(KEYS.apiKey),
  locale: initialLocale(),
  location: initialLocation(),
  themePreference: initialThemePreference(),
  blanketStyle: initialBlanketStyle(),
  ttsVoice: initialTtsVoice(),
  thinkingEffort: initialThinkingEffort(),
  showThinkingNormal: initialFlag(KEYS.showThinkingNormal, true),
  showThinkingBlanket: initialFlag(KEYS.showThinkingBlanket, false),
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

export const setThinkingEffort = (thinkingEffort: ThinkingEffort) => {
  write(KEYS.thinkingEffort, thinkingEffort)
  useSettings.setState({ thinkingEffort })
}

export const setShowThinkingNormal = (showThinkingNormal: boolean) => {
  write(KEYS.showThinkingNormal, String(showThinkingNormal))
  useSettings.setState({ showThinkingNormal })
}

export const setShowThinkingBlanket = (showThinkingBlanket: boolean) => {
  write(KEYS.showThinkingBlanket, String(showThinkingBlanket))
  useSettings.setState({ showThinkingBlanket })
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

// ── 思考强度档位（2026-11-27 档位重做方案）────────────────────
// thinkingEffort 是普通模式唯一的思考旋钮：off=普通（秒出）/ low=经济（默认）/
// max=专家。联网不再单独开关——普通模式恒声明搜索工具，搜不搜模型自己判断
//（官方机制：关思考时同样由模型判断，闲聊自然不搜）。
// 被子模式不用这个字段：每床被子存自己的 chatGear（blanket.ts），覆盖全局。
