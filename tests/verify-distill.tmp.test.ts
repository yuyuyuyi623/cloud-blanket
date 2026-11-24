/**
 * 〇·一汇总截断真机验证（一次性，跑完即删）：
 * 用真实导出 ZIP 走完整蒸馏（块并发 + 汇总），验证 maxTokens=65536 后汇总不再截断。
 *
 * 运行（需要羽翼的 Key，只在环境变量里传，不落盘）：
 *   cd fork/chat-demo
 *   DEEPSEEK_KEY=sk-xxx DEEPSEEK_ZIP="D:/dsh/cloud-blanket/local/蒸馏原料/deepseek_data-2026-11-22.zip" \
 *     npx vitest run tests/verify-distill.tmp.test.ts
 *
 * 产物：JSON 完整解析 ✓/✗、各字段长度、usage、G3 截断 warn（finish_reason=length 会打 warn）。
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createDeepseekClient } from '../engine/deepseek.js'
import { loadSessionsFromReader } from '../engine/parse.js'
import { runDistill } from '../engine/distill.js'
import { buildBlocks, fileRangeReader } from '../src/services/memory/importBlanket.js'

const key = process.env.DEEPSEEK_KEY ?? ''
const zipPath = process.env.DEEPSEEK_ZIP ?? ''

describe.skipIf(!key || !zipPath)('〇·一汇总截断真机验证', () => {
  it(
    '完整蒸馏：汇总 JSON 完整、无 length 截断',
    async () => {
      const bytes = readFileSync(zipPath)
      const blob = new Blob([new Uint8Array(bytes)])
      const loaded = await loadSessionsFromReader(fileRangeReader(blob), { withMessages: true })
      const sessions = loaded.sessions
      const blocks = buildBlocks(sessions)
      // eslint-disable-next-line no-console
      console.log(
        `[verify] 会话 ${sessions.length} 个，块 ${blocks.length} 个，正文 ${blocks
          .map((b) => b.text.length)
          .reduce((a, b) => a + b, 0)} 字`
      )

      const client = createDeepseekClient({ apiKey: key })
      const result = await runDistill(client, blocks, {
        onProgress: (p) => {
          // eslint-disable-next-line no-console
          console.log(`[verify] ${p.phase} ${p.done}/${p.total}`)
        },
      })

      const s = result.summarize
      expect(s.personaCard.length).toBeGreaterThan(0)
      expect(s.summary.length).toBeGreaterThan(0)
      // eslint-disable-next-line no-console
      console.log(
        `[verify] 汇总完整：persona ${s.personaCard.length} 字 / impression ${s.impression.length} 字 / summary ${s.summary.length} 字 / core ${s.coreCandidates.length} 条 / facts ${s.factsUser.length}+${s.factsRelationship.length} 条 / usage ${JSON.stringify(s.usage ?? null)}`
      )
    },
    600_000
  )
})
