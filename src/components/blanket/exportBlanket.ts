/**
 * 被子记忆导出：一份人能读的 Markdown 存档。
 *
 * 用途是翻看和备份，不是给程序吃的——真要搬家，做"导入记忆包"时再定义机器格式。
 * 私人产物只落在用户自己选的下载目录，不进仓库。
 */

import type { BlanketRecord } from '../../services/memory/blanket.js'

const list = (title: string, lines: string[]): string => {
  if (!lines.length) {
    return ''
  }
  return `## ${title}\n\n${lines.map((line) => `- ${line}`).join('\n')}\n\n`
}

export const exportBlanketMarkdown = (blanket: BlanketRecord): void => {
  const { pack } = blanket
  const parts: string[] = []

  parts.push(`# ${blanket.name} · 她的记忆\n\n`)
  parts.push(
    `> 蒸于 ${new Date(blanket.createdAt).toLocaleString('zh-CN')} · ${blanket.sessionIds.length} 个会话 · ${pack.memories.length} 件具体的事\n\n`,
  )

  if (pack.persona.card.trim()) {
    parts.push(`## 角色卡\n\n${pack.persona.card.trim()}\n\n`)
  }
  if (pack.persona.impression?.trim()) {
    parts.push(`## 整体印象\n\n${pack.persona.impression.trim()}\n\n`)
  }
  if (pack.summary.trim()) {
    parts.push(`## 关系摘要\n\n${pack.summary.trim()}\n\n`)
  }
  parts.push(
    list(
      '她的日记',
      pack.diary.map((entry) => `${entry.date} · ${entry.text}`),
    ),
  )
  parts.push(
    list(
      '核心记忆',
      pack.coreMemories.map((item) => (item.at ? `${item.at} · ${item.text}` : item.text)),
    ),
  )
  parts.push(list('关于你', pack.facts.map((item) => item.text)))
  parts.push(
    list(
      '记得的事',
      pack.memories.map((item) => (item.at ? `${item.at} · ${item.text}` : item.text)),
    ),
  )

  const blob = new Blob([parts.join('')], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${blanket.name}-记忆.md`
  anchor.click()
  // 下载启动后再撤销，立刻撤销在部分浏览器会截断文件
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
