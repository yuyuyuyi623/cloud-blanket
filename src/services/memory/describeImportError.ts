/**
 * 导入/蒸馏链路的报错归一化：把底层英文原文翻译成"用户下一步该干什么"。
 *
 * 普通对话的报错官方已模板化（describe.ts），这里补蒸馏流程的三处漏网：
 * 扫描 ZIP（本地解压错误）、内容搜索（同扫描）、蒸馏（DeepSeek API 的 ApiError）。
 * 识别不了的照原样透出——宁可原文也别编一个看起来官方的错误。
 */

import { translate } from '../../i18n/index.js'
import { ApiError } from '../api/client.js'
import { classifyApiError } from '../api/errors.js'

const rawText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** 本地读包失败：按 jszip 的报错特征归类；不认识的原样透出 */
export const describeScanError = (error: unknown): string => {
  const raw = rawText(error)
  if (/corrupt|central directory|unexpected end/i.test(raw)) {
    return translate('scanErrCorrupt')
  }
  if (/encrypted|password/i.test(raw)) {
    return translate('scanErrEncrypted')
  }
  if (/zip|format|signature/i.test(raw)) {
    return translate('scanErrNotZip')
  }
  return translate('scanErrOther', { message: raw })
}

/** 蒸馏失败：ApiError 按状态归类给出下一步指引；engine 自己抛的中文原样透出 */
export const describeDistillError = (error: unknown): string => {
  if (error instanceof ApiError) {
    switch (classifyApiError(error)) {
      case 'unauthorized':
        return translate('distillErrUnauthorized')
      case 'insufficientBalance':
        return translate('distillErrBalance')
      case 'rateLimited':
        return translate('distillErrRateLimited')
      case 'serverBusy':
        return translate('distillErrBusy')
      case 'network':
        return translate('distillErrNetwork')
      default:
        return translate('distillErrOther', { message: rawText(error) })
    }
  }
  return rawText(error)
}
