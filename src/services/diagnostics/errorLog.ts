/**
 * 报错日志：运行期环形缓冲（最近 50 条），右边栏一键复制求助。
 *
 * 为什么是"复制文本"而不是导出文件、也不是应用内"问 AI"：
 * 出错时 API 本身往往就不通（Key / 余额 / 网络），复制出来贴给开发者
 * 或贴给任意 AI，是最可靠、对用户动作最少的一条路。
 */

import { translate } from '../../i18n/index.js'
import { ApiError } from '../api/client.js'
import { classifyApiError } from '../api/errors.js'
import { useSettings } from '../settings.js'

const MAX_ENTRIES = 50

export type ErrorLogEntry = {
  /** ISO 时间，用户不用看得懂，开发者排得出序 */
  time: string
  /** 出错场景：对话 / 蒸馏 / 导入 */
  scene: string
  /** 错误归类（ApiError 分类或 local），已经归一化展示给用户的文案另存于 message */
  kind: string
  /** 原始错误信息，保留英文原文供开发者定位 */
  message: string
}

const entries: ErrorLogEntry[] = []

export const getErrorLog = (): readonly ErrorLogEntry[] => entries

export const recordError = (scene: string, error: unknown): void => {
  entries.push({
    time: new Date().toISOString(),
    scene,
    kind: error instanceof ApiError ? classifyApiError(error) : 'local',
    message: error instanceof Error ? error.message : String(error),
  })
  if (entries.length > MAX_ENTRIES) {
    entries.splice(0, entries.length - MAX_ENTRIES)
  }
}

/** 生成求助文本：头部带版本和环境，正文按时间排；空日志也能复制（提示没有记录） */
export const buildErrorLogText = (): string => {
  const version = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev'
  const lines = [
    translate('errorLogHeader'),
    `app: cloud-blanket v${version}`,
    `time: ${new Date().toISOString()}`,
    `locale: ${useSettings.getState().locale}`,
    `ua: ${navigator.userAgent}`,
    '',
  ]
  if (entries.length === 0) {
    lines.push(translate('errorLogEmpty'))
  } else {
    for (const entry of entries) {
      lines.push(`[${entry.time}] ${entry.scene} / ${entry.kind}: ${entry.message}`)
    }
  }
  return lines.join('\n')
}
