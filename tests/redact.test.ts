/**
 * 原文脱敏单测（P1，2026-11-25 拍板：只替换不丢弃）
 *
 * 锁四件事：手机号/邮箱/URL/卡号/长数字都抹；含密钥的整行抹但保留说话人前缀；
 * 正常聊天不被误伤；替换幂等（跑两遍结果一样）。
 */

import { describe, expect, it } from 'vitest'
import { REDACTED, redactSensitive } from '../engine/redact.js'

describe('redactSensitive', () => {
  it('手机号 / 邮箱 / URL 行内替换，句子结构保留', () => {
    const out = redactSensitive('你（2025-03-01）：我电话 13812345678，邮箱 a.b@example.com，主页 https://x.test/u/1')
    expect(out).toContain('我电话')
    expect(out).toContain(REDACTED)
    expect(out).not.toContain('13812345678')
    expect(out).not.toContain('a.b@example.com')
    expect(out).not.toContain('https://x.test')
  })

  it('卡号（4-4-4-4 带分隔）与 12 位以上长数字都抹', () => {
    const out = redactSensitive('她（2025-04-02）：卡号 6222 0202 0000 1234，订单 202503150000123456')
    expect(out).not.toContain('6222')
    expect(out).not.toContain('202503150000123456')
    expect(out).toContain(REDACTED)
  })

  it('含密钥/密码的整行替换，但保留「说话人（时间）：」前缀', () => {
    const out = redactSensitive('你（2025-05-06）：我的 api key 是 sk-abcdef123456，别告诉别人')
    expect(out).toBe(`你（2025-05-06）：${REDACTED}`)
  })

  it('没有前缀的敏感行整行替换', () => {
    expect(redactSensitive('密码：hunter2')).toBe(REDACTED)
  })

  it('普通聊天不被误伤（含数字但不够长、含"安全感"这种词）', () => {
    const line = '她（2025-06-07）：你给的安全感比 3 个月工资都多，第 2 次这么说'
    expect(redactSensitive(line)).toBe(line)
  })

  it('多行各自处理，空行原样', () => {
    const out = redactSensitive('你：13800001111\n\n她：好')
    expect(out.split('\n')).toEqual([`你：${REDACTED}`, '', '她：好'])
  })

  it('幂等：跑两遍结果一致', () => {
    const once = redactSensitive('你：邮箱 a@b.co，密码是 xyz')
    expect(redactSensitive(once)).toBe(once)
  })

  it('空串直接返回', () => {
    expect(redactSensitive('')).toBe('')
  })
})
