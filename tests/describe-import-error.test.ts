/**
 * 导入/蒸馏报错归一化：识别得到的给"下一步该干什么"的人话，
 * 识别不了的透原文——宁可英文也别编一个看起来官方的错误。
 */
import { describe, expect, it } from 'vitest'
import { ApiError } from '../src/services/api/client.js'
import { describeDistillError, describeScanError } from '../src/services/memory/describeImportError.js'

// 测试跑在默认 locale 下；断言关键字而非整句，避免文案微调弄脆测试
describe('describeScanError（本地读包）', () => {
  it('损坏的 ZIP 给"重新下载"指引，不带英文原文', () => {
    const text = describeScanError(new Error("Can't find end of central directory"))
    expect(text).toContain('ZIP')
    expect(text).not.toContain('central directory')
  })

  it('加密 ZIP 指出官方导出不加密', () => {
    const text = describeScanError(new Error('Encrypted zip: password required'))
    expect(text).toContain('密码')
  })

  it('不认识的错误透原文', () => {
    const text = describeScanError(new Error('some weird fs error'))
    expect(text).toContain('some weird fs error')
  })
})

describe('describeDistillError（DeepSeek API）', () => {
  it('402 余额不足给充值指引', () => {
    const text = describeDistillError(new ApiError('http', 'Insufficient Balance', 402))
    expect(text).toContain('余额')
    expect(text).toContain('platform.deepseek.com')
  })

  it('401 鉴权失败给填 Key 指引', () => {
    const text = describeDistillError(new ApiError('http', 'Authentication Fails', 401))
    expect(text).toContain('API Key')
  })

  it('网络错误给排查指引', () => {
    const text = describeDistillError(new ApiError('network', 'Failed to fetch'))
    expect(text).not.toContain('Failed to fetch')
  })

  it('非 ApiError（engine 自己抛的中文）原样透出', () => {
    const text = describeDistillError(new Error('选中的会话没有读出正文，请重新选择文件'))
    expect(text).toBe('选中的会话没有读出正文，请重新选择文件')
  })
})
