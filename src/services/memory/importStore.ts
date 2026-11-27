/**
 * 把蒸馏结果落成一床被子（IndexedDB 写入）。
 *
 * 与 importBlanket.ts 分开的理由：那边是纯逻辑（Node 里能测），
 * 这边依赖浏览器存储（IndexedDB），混在一起测试就得给 idb 打桩。
 */

import { clearBlanketSessions, loadBlankets, saveBlanket, saveBlanketSessions } from '../chat/db.js'
import { dedupeBlanketName, type BlanketRecord } from './blanket.js'
import { invalidateBlanket } from './load.js'
import {
  parsedToSession,
  runBlanketDistill,
  type BlanketDistillOptions,
} from './importBlanket.js'
import type { ParsedSession } from '../../../engine/parse.js'
import type { DistillRunResult } from '../../../engine/distill.js'

/** 被子默认名：模型给的人格名 → 会话里最后一轮的标题 → 兜底 */
export const defaultBlanketName = (
  result: DistillRunResult,
  sessions: ParsedSession[]
): string => {
  const named = result.pack.persona.name.trim()
  if (named) {
    return named
  }
  const titled = sessions.find((session) => session.title.trim())?.title.trim()
  return titled ?? '新被子'
}

export interface CreateBlanketOptions extends BlanketDistillOptions {
  parsedSessions: ParsedSession[]
  /** 确认页改过的名字；不传则用默认名 */
  name?: string
}

export interface CreateBlanketResult {
  record: BlanketRecord
  /** 蒸馏全部成功调用的实际 token 总量——账本按这个实记（2026-11-25 对账修正） */
  usage: { promptTokens: number; completionTokens: number }
}

/** 蒸馏 → 原文入库 → 被子记录。任一步失败都会把刚写的原料清掉，不留半床被子。 */
export const createBlanket = async (options: CreateBlanketOptions): Promise<CreateBlanketResult> => {
  const { parsedSessions, apiKey, name, attachmentDocs, onProgress } = options
  const result = await runBlanketDistill(parsedSessions, { apiKey, attachmentDocs, onProgress })

  const base = name?.trim() || defaultBlanketName(result, parsedSessions)
  // 同名被子自动加序号（第二份起（2）（3）……），不然侧栏两床同名分不清哪床是新的
  const existing = (await loadBlankets())
    .filter((item) => item.deletedAt === undefined)
    .map((item) => item.name)

  const id = crypto.randomUUID()
  const sessions = parsedSessions.map(parsedToSession)
  const now = Date.now()
  const record: BlanketRecord = {
    id,
    name: dedupeBlanketName(base, existing),
    sessionIds: sessions.map((session) => session.id),
    pack: result.pack,
    createdAt: now,
    updatedAt: now,
  }

  // 先写原文再写被子：被子记录存在就意味着原文齐全，检索不会缺料
  await saveBlanketSessions(id, sessions)
  try {
    await saveBlanket(record)
  } catch (e) {
    // 记录没写成功，原料就是孤儿：清掉再抛，避免占着几十 MB 还能被旧索引读到
    await clearBlanketSessions(id).catch(() => undefined)
    throw e
  }
  invalidateBlanket(id)
  return { record, usage: result.usage }
}
