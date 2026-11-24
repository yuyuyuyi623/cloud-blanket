/**
 * 报错日志：环形缓冲封顶 50 条；求助文本带版本/环境头部与逐条原文。
 * 用户靠这个文本找开发者求助，格式丢了就等于功能没了。
 */
import { describe, expect, it } from 'vitest'
import { ApiError } from '../src/services/api/client.js'
import { buildErrorLogText, recordError } from '../src/services/diagnostics/errorLog.js'

describe('报错日志', () => {
  it('recordError 记录 ApiError 的分类与原文', () => {
    recordError('蒸馏', new ApiError('http', 'Insufficient Balance', 402))
    const text = buildErrorLogText()
    expect(text).toContain('蒸馏 / insufficientBalance: Insufficient Balance')
    expect(text).toContain('cloud-blanket v')
  })

  it('非 ApiError 记为 local', () => {
    recordError('导入', new Error('some weird fs error'))
    const text = buildErrorLogText()
    expect(text).toContain('导入 / local: some weird fs error')
  })

  it('环形缓冲：超过 50 条只留最近的', () => {
    for (let i = 0; i < 60; i += 1) {
      recordError('对话', new Error(`boom-${i}`))
    }
    const text = buildErrorLogText()
    expect(text).toContain('boom-59')
    expect(text).not.toContain('boom-0\n')
  })
})
