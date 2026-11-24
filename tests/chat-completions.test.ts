/**
 * 翻译层请求转换：重点测两段式——稳定段在头、动态段在尾。
 * 位置错了缓存前缀就碎（P0），所以这条值得一个单测锁住。
 */
import { describe, expect, it } from 'vitest'
import { toWireRequest } from '../src/services/api/chatCompletions.js'
import type { CreateMessageRequest } from '../src/services/api/types.js'

const base: CreateMessageRequest = {
  model: 'deepseek-flash',
  system: '稳定段',
  messages: [
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '嗯' },
    { role: 'user', content: '还记得吗' },
  ],
  thinking: { type: 'disabled' },
  tools: [{ type: 'deepseek_read_url', name: 'deepseek_read_url' }],
  safety_check: { level: 'high' },
}

describe('toWireRequest 两段式', () => {
  it('普通对话：只有开头一条 system，不凭空多出别的 system', () => {
    const body = toWireRequest(base)
    expect(body.messages[0]).toEqual({ role: 'system', content: '稳定段' })
    expect(body.messages.filter((m) => m.role === 'system')).toHaveLength(1)
    expect(body.messages.at(-1)).toMatchObject({ role: 'user', content: '还记得吗' })
  })

  it('被子模式：动态段是最后一条 system，夹在本轮提问之前', () => {
    const body = toWireRequest({ ...base, systemSuffix: '想起的旧事…' })
    const systems = body.messages.filter((m) => m.role === 'system')
    expect(systems).toHaveLength(2)
    expect(systems[0]).toEqual({ role: 'system', content: '稳定段' })
    expect(systems[1]).toEqual({ role: 'system', content: '想起的旧事…' })
    expect(body.messages.at(-1)).toEqual({ role: 'system', content: '想起的旧事…' })
    expect(body.messages.at(-2)).toMatchObject({ role: 'user', content: '还记得吗' })
  })
})
