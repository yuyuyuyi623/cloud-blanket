/**
 * 附件进蒸馏（2026-11-27）单测：
 *   判类启发式 / 路径解析 / 解码 / 截断 / 人设蒸分块 / 解析保留附件引用 /
 *   B 路拼进消息 / A 路单独计块 / backstory 字段 / 稳定段位置。
 */

import { describe, expect, it } from 'vitest'
import {
  capAttachments,
  classifyAttachment,
  countAttachmentWords,
  decodeAttachmentText,
  isTextAttachmentName,
  parseAttachmentPath,
  personaDocChunks,
  type AttachmentDoc,
} from '../engine/attachment-scan.js'
import { parseSession } from '../engine/parse.js'
import { renderBlockText } from '../engine/distill.js'
import { buildBlocks, buildPlan } from '../src/services/memory/importBlanket.js'
import { normalizePack } from '../engine/pack.js'
import { buildStableSegment } from '../engine/context.js'
import { BACKSTORY_MAX_CHARS } from '../engine/config.js'

const doc = (over: Partial<AttachmentDoc>): AttachmentDoc => ({
  id: 's1::a.txt',
  sessionId: 's1',
  name: 'a.txt',
  path: 'chat_sessions/s1_files/a.txt',
  text: '正文',
  words: 2,
  tag: 'material',
  clipped: false,
  ...over,
})

describe('附件路径与扩展名', () => {
  it('认出 chat_sessions/<id>_files/<file>', () => {
    expect(parseAttachmentPath('chat_sessions/abc_files/设定.txt')).toEqual({
      sessionId: 'abc',
      name: '设定.txt',
    })
  })

  it('别的路径一律不认', () => {
    expect(parseAttachmentPath('chat_sessions/abc.json')).toBeNull()
    expect(parseAttachmentPath('manifest.json')).toBeNull()
  })

  it('只收文本类扩展名，图片/PDF 不收', () => {
    expect(isTextAttachmentName('a.txt')).toBe(true)
    expect(isTextAttachmentName('A.MD')).toBe(true)
    expect(isTextAttachmentName('设定.markdown')).toBe(true)
    expect(isTextAttachmentName('图片.png')).toBe(false)
    expect(isTextAttachmentName('合同.pdf')).toBe(false)
  })
})

describe('判类启发式（第一层，零 token）', () => {
  it('文件名像设定 → 身世', () => {
    expect(classifyAttachment('小鲸鱼设定.txt', 100, 5)).toBe('persona')
    expect(classifyAttachment('世界观.md', 10, 9)).toBe('persona')
    expect(classifyAttachment('persona_v2.txt', 10, 9)).toBe('persona')
  })

  it('会话前几个 + 超过 5000 字 → 身世（开局甩一本书）', () => {
    expect(classifyAttachment('笔记.txt', 6000, 0)).toBe('persona')
    expect(classifyAttachment('笔记.txt', 6000, 2)).toBe('persona')
  })

  it('其余 → 普通资料', () => {
    expect(classifyAttachment('笔记.txt', 6000, 3)).toBe('material')
    expect(classifyAttachment('日记.txt', 4000, 0)).toBe('material')
    expect(classifyAttachment('资料.csv', 100, 0)).toBe('material')
  })
})

describe('解码与截断', () => {
  it('UTF-8 中文原样读出', () => {
    const bytes = new TextEncoder().encode('她的身世是这样的。')
    expect(decodeAttachmentText(bytes)).toBe('她的身世是这样的。')
  })

  it('GBK 字节在支持 gbk 解码器的环境里能读出来', () => {
    let supported = true
    try {
      new TextDecoder('gbk')
    } catch {
      supported = false
    }
    if (!supported) return
    // 「你好」的 GBK 编码
    const gbk = new Uint8Array([0xc4, 0xe3, 0xba, 0xc3])
    const text = decodeAttachmentText(gbk)
    expect(text).not.toContain('\uFFFD')
    expect(text.length).toBeGreaterThan(0)
  })

  it('整包上限：超出的整份跳过并标记 clipped，不切半份', () => {
    const docs = [doc({ id: 'a', words: 60 }), doc({ id: 'b', words: 60 }), doc({ id: 'c', words: 60 })]
    const capped = capAttachments(docs, 150)
    expect(capped.map((d) => d.id)).toEqual(['a', 'b', 'c'])
    expect(capped[2]!.clipped).toBe(true)
    expect(capped[2]!.text).toBe('')
    expect(capped[2]!.words).toBe(0)
  })

  it('字数按 trim 后的字符串长度算', () => {
    expect(countAttachmentWords('  你好  ')).toBe(2)
  })
})

describe('人设蒸分块（A 路）', () => {
  it('超过块上限的大文档分成多块，每块非空', () => {
    const text = '第一句。'.repeat(3000) // 12000 字
    const chunks = personaDocChunks([doc({ text, words: text.length })], 5000)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.text.trim().length).toBeGreaterThan(0)
      expect(chunk.from).toBe('a.txt')
    }
    expect(chunks.map((c) => c.text).join('')).toContain('第一句。')
  })

  it('空文档不产块', () => {
    expect(personaDocChunks([doc({ text: '   ' })], 5000)).toEqual([])
  })
})

describe('解析保留附件引用', () => {
  const raw = JSON.stringify({
    id: 's1',
    title: '设定',
    current_message_id: 1,
    messages: [
      {
        id: 1,
        role: 'USER',
        status: 'FINISHED',
        inserted_at: '2025-01-01T00:00:00Z',
        fragments: [
          { type: 'REQUEST', content: '看看这个' },
          {
            type: 'FILE',
            file_name: '她的设定.txt',
            export_path: 'chat_sessions/s1_files/她的设定.txt',
          },
        ],
      },
    ],
  })

  it('FILE 片段变成 message.files，不丢', () => {
    const session = parseSession(raw)
    expect(session.messages[0]!.files).toEqual([
      { name: '她的设定.txt', path: 'chat_sessions/s1_files/她的设定.txt' },
    ])
    // 有正文的消息照旧计字数
    expect(session.words).toBe(4)
  })

  it('纯附件消息（没有正文）也保留，不被当空消息丢掉', () => {
    const only = JSON.stringify({
      id: 's2',
      title: '',
      current_message_id: 1,
      messages: [
        {
          id: 1,
          role: 'USER',
          status: 'FINISHED',
          inserted_at: '2025-01-01T00:00:00Z',
          fragments: [{ type: 'FILE', file_name: '图.png' }],
        },
      ],
    })
    const session = parseSession(only)
    expect(session.messages.length).toBe(1)
    expect(session.messages[0]!.text).toBe('')
    expect(session.stats.emptyMessages).toBe(0)
  })

  it('块正文给纯附件消息一个中性描述（措辞在代码里，不走模型）', () => {
    const text = renderBlockText([
      { role: 'user', text: '', at: '2025-01-01', unfinished: '', files: [{ name: '图.png', path: '' }] },
    ])
    expect(text).toContain('发来附件：图.png')
  })
})

describe('两路通道接进蒸馏', () => {
  const session = {
    id: 's1',
    title: '聊天',
    pinned: false,
    firstAt: '2025-01-01T00:00:00Z',
    lastAt: '2025-01-02T00:00:00Z',
    days: 2,
    words: 10,
    userTurns: 1,
    totalMessages: 2,
    messages: [
      { role: 'user' as const, text: '你好', at: '2025-01-01T00:00:00Z', unfinished: '' },
      { role: 'assistant' as const, text: '在呢', at: '2025-01-01T00:00:01Z', unfinished: '' },
    ],
    stats: { thinkCount: 0, thinkWords: 0, fileCount: 0, unfinished: 0, emptyMessages: 0 },
  }

  it('B 路普通资料拼进消息，随对话块蒸', () => {
    const blocks = buildBlocks(
      [session],
      [doc({ text: '这是一份参考资料。', words: 9, tag: 'material' })],
    )
    expect(blocks.length).toBe(1)
    expect(blocks[0]!.text).toContain('这是一份参考资料。')
    expect(blocks[0]!.text).toContain('〔附件：a.txt〕')
  })

  it('A 路身世文档不拼进对话块', () => {
    const blocks = buildBlocks(
      [session],
      [doc({ text: '她的身世很长很长。', words: 9, tag: 'persona' })],
    )
    expect(blocks[0]!.text).not.toContain('她的身世很长很长。')
  })

  it('预估里身世文档单独计块', () => {
    const plan = buildPlan(
      [session],
      [doc({ text: 'x'.repeat(30000), words: 30000, tag: 'persona' })],
    )
    const attachRow = plan.rows.find((row) => row.sessionId === '__attachments__')
    expect(attachRow).toBeDefined()
    expect(attachRow!.blocks).toBe(2)
    expect(plan.estimate.totalBlocks).toBe(3)
  })
})

describe('backstory 字段与稳定段位置', () => {
  it('normalizePack 保留并裁剪 backstory', () => {
    const long = '很久以前。'.repeat(2000)
    const pack = normalizePack({ backstory: long })
    expect(pack.backstory).toBeDefined()
    expect(pack.backstory!.length).toBeLessThanOrEqual(Math.round(BACKSTORY_MAX_CHARS * 1.15) + 1)
  })

  it('空 backstory / 旧包缺字段 → undefined（不迁移、不报错）', () => {
    expect(normalizePack({ backstory: '   ' }).backstory).toBeUndefined()
    expect(normalizePack({}).backstory).toBeUndefined()
  })

  it('稳定段里身世排在 persona 之后、核心记忆之前', () => {
    const pack = normalizePack({
      persona: { name: '小鲸', card: '她是小鲸鱼。' },
      backstory: '她来自很深的海。',
      coreMemories: [{ text: '第一次见面', at: null }],
    })
    const stable = buildStableSegment(pack)
    const personaAt = stable.indexOf('她是小鲸鱼')
    const backstoryAt = stable.indexOf('她来自很深的海')
    const coreAt = stable.indexOf('第一次见面')
    expect(personaAt).toBeGreaterThanOrEqual(0)
    expect(backstoryAt).toBeGreaterThan(personaAt)
    expect(coreAt).toBeGreaterThan(backstoryAt)
  })
})
