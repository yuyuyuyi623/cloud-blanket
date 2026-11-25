import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import { translate } from '../../i18n/index.js'
import { showToast } from '../../components/base/toastState.js'
import type { BlanketRecord } from '../memory/blanket.js'
import { toSessionSummary, type Session, type SessionSummary } from './types.js'

/** IndexedDB 存储结构版本；新增或调整存储、索引时递增。 */
const DB_VERSION = 14

/** 文件原件按附件的本地 id 存储，所有引用同一 id 的消息共用一份；用于缩略图、打开查看，以及没有 serverId 时补传。 */
export type StoredFile = {
  id: string
  blob: Blob
}

/** 文件引用留在摘要中，删除会话时通过索引判断原件是否仍被引用。 */
type StoredSessionSummary = SessionSummary & { fileIds: string[] }

/**
 * 被子原料会话：蒸进被子的原始对话。
 * 记忆检索要原文（pack 里只有摘要和事件），所以原文按被子单独存一份，
 * 不写进 sessions——导入几百个会话不该淹没侧栏的普通对话列表。
 */
export type BlanketSessionRecord = {
  /** `${blanketId}\u0000${sessionId}`，一床被子里的会话 */
  id: string
  blanketId: string
  sessionId: string
  session: Session
}

const blanketSessionKey = (blanketId: string, sessionId: string) =>
  `${blanketId}\u0000${sessionId}`

interface ChatDB extends DBSchema {
  /** 当前使用的会话，界面读写都在这里 */
  sessions: { key: string; value: Session }
  sessionSummaries: {
    key: string
    value: StoredSessionSummary
    indexes: { fileIds: string }
  }
  /** 当前使用的文件原件 */
  files: { key: string; value: StoredFile }
  /**
   * 历史导入的暂存：导入过程中会话与原件只写入这两个存储，`sessions` / `files` 保持不变；
   * 全部校验通过后在一个事务中替换正式数据并清空暂存，失败时只清空暂存。
   */
  sessionsStaging: { key: string; value: Session }
  filesStaging: { key: string; value: StoredFile }
  /** 云朵被子：一床被子 = 一组会话 + 记忆包（v12 新增，与官方会话数据互不干扰） */
  blankets: { key: string; value: BlanketRecord }
  /** 被子原料会话（v13 新增）：记忆检索的原文来源，按被子分组 */
  blanketSessions: {
    key: string
    value: BlanketSessionRecord
    indexes: { blanketId: string }
  }
  /** 账本用量（v14 新增）：每条消息/每次蒸馏一笔，只存数字和时间，绝不存消息内容 */
  usageLog: { key: string; value: UsageLogEntry; indexes: { ts: string } }
}

let dbPromise: Promise<IDBPDatabase<ChatDB>> | null = null

/** 账本一笔：峰谷由 ts 判定后落库，cost 是折算后的人民币金额（估算口径） */
export interface UsageLogEntry {
  id: string
  /** 请求发出时刻（蒸馏 = 完成时刻），UTC 毫秒 */
  ts: number
  /** 普通对话 / 被子对话 / 蒸馏 */
  mode: 'normal' | 'blanket' | 'distill'
  hit: number
  miss: number
  completion: number
  peak: boolean
  /** 人民币金额（峰谷折算后的估算值） */
  cost: number
}

const storedSummary = (session: Session): StoredSessionSummary => ({
  ...toSessionSummary(session),
  fileIds: [
    ...new Set(
      session.messages.flatMap((message) =>
        message.role === 'user' ? message.files.map((file) => file.id) : []
      )
    ),
  ],
})

const abortTransaction = (tx: { abort(): void }) => {
  try {
    tx.abort()
  } catch {
    // 事务已因请求失败中止。
  }
}

// 每个操作拿到连接后立即创建事务；IndexedDB 按创建顺序执行范围重叠的事务，读取总能看到之前发起的写入。
const getDB = () =>
  (dbPromise ??= openDB<ChatDB>('chat-demo', DB_VERSION, {

    upgrade(db, _oldVersion, _newVersion, tx) {
      // 初始化当前格式需要的存储与索引，不迁移旧消息。
      for (const name of [
        'sessions',
        'files',
        'sessionsStaging',
        'filesStaging',
        'blankets',
      ] as const) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath: 'id' })
        }
      }
      const summaries = db.objectStoreNames.contains('sessionSummaries')
        ? tx.objectStore('sessionSummaries')
        : db.createObjectStore('sessionSummaries', { keyPath: 'id' })
      if (!summaries.indexNames.contains('fileIds')) {
        summaries.createIndex('fileIds', 'fileIds', { multiEntry: true })
      }
      if (!db.objectStoreNames.contains('blanketSessions')) {
        db.createObjectStore('blanketSessions', { keyPath: 'id' }).createIndex(
          'blanketId',
          'blanketId'
        )
      }
      if (!db.objectStoreNames.contains('usageLog')) {
        db.createObjectStore('usageLog', { keyPath: 'id' }).createIndex('ts', 'ts')
      }
    },
  }).catch((error: unknown) => {
    // 打开失败后允许界面重试，避免一直复用已拒绝的 Promise。
    dbPromise = null
    throw error
  }))

// ── 配额写满兜底（存储加固 2026-11-24）──────────────────────
// IndexedDB 写入全部从本文件出去，所以只在这里包一层：捕获 QuotaExceededError
// 弹会话内提示（不 alert），然后原样上抛让调用方的既定错误路径（如失败重试、状态提示）照常走。

const isQuotaError = (error: unknown): boolean => {
  const e = error as { name?: string; message?: string } | null
  return Boolean(
    e && (e.name === 'QuotaExceededError' || /quota/i.test(String(e.message ?? '')))
  )
}

const rethrowQuota = (error: unknown): never => {
  if (isQuotaError(error)) {
    showToast(translate('storageQuotaFull'))
  }
  throw error
}

/** 大对象写入统一过这道闸（读取不拦；小写如改名/软删不会碰配额，不过闸） */
const guarded = <Args extends unknown[], R>(fn: (...args: Args) => Promise<R>) =>
  (...args: Args): Promise<R> => fn(...args).catch(rethrowQuota)

export const loadSessionSummaries = async (): Promise<SessionSummary[]> =>
  (await (await getDB()).getAll('sessionSummaries')).map(toSessionSummary)

export const loadSession = async (id: string): Promise<Session | undefined> =>
  (await getDB()).get('sessions', id)

export const saveSession = guarded(async (session: Session, files: StoredFile[] = []): Promise<void> => {
  const summary = storedSummary(session)
  const tx = (await getDB()).transaction(['sessions', 'sessionSummaries', 'files'], 'readwrite')
  await Promise.all([
    (async () => {
      try {
        for (const file of files) {
          await tx.objectStore('files').put(file)
        }
        await tx.objectStore('sessions').put(session)
        await tx.objectStore('sessionSummaries').put(summary)
      } catch (error) {
        abortTransaction(tx)
        throw error
      }
    })(),
    tx.done,
  ])
})

/** 未打开的会话也可重命名，只读取该会话，原子更新详情和列表。 */
export const renameSession = async (id: string, title: string): Promise<void> => {
  const tx = (await getDB()).transaction(['sessions', 'sessionSummaries'], 'readwrite')
  await Promise.all([
    (async () => {
      try {
        const sessions = tx.objectStore('sessions')
        const session = await sessions.get(id)
        if (session) {
          session.title = title
          await sessions.put(session)
          await tx.objectStore('sessionSummaries').put(storedSummary(session))
        }
      } catch (error) {
        abortTransaction(tx)
        throw error
      }
    })(),
    tx.done,
  ])
}

/** 删除会话，仅清理已无会话引用的本地原件；远端文件不删。 */
/**
 * 软删/恢复：写或清 trashedAt，两条记录同步改；消息原件不动——
 * 普通回收站 30 天内可恢复，到期由 store 启动清理时走 deleteSession 彻底删。
 */
export const setSessionTrashed = async (
  sessionId: string,
  trashedAt: number | undefined,
): Promise<void> => {
  const tx = (await getDB()).transaction(['sessions', 'sessionSummaries'], 'readwrite')
  await Promise.all([
    (async () => {
      try {
        for (const name of ['sessions', 'sessionSummaries'] as const) {
          const store = tx.objectStore(name)
          const record = await store.get(sessionId)
          if (record) {
            if (trashedAt === undefined) {
              delete record.trashedAt
            } else {
              record.trashedAt = trashedAt
            }
            await store.put(record)
          }
        }
      } catch (error) {
        abortTransaction(tx)
        throw error
      }
    })(),
    tx.done,
  ])
}

export const deleteSession = async (sessionId: string): Promise<void> => {
  const tx = (await getDB()).transaction(['sessions', 'sessionSummaries', 'files'], 'readwrite')
  await Promise.all([
    (async () => {
      try {
        const summaries = tx.objectStore('sessionSummaries')
        const summary = await summaries.get(sessionId)
        await tx.objectStore('sessions').delete(sessionId)
        await summaries.delete(sessionId)
        for (const id of summary?.fileIds ?? []) {
          if ((await summaries.index('fileIds').count(id)) === 0) {
            await tx.objectStore('files').delete(id)
          }
        }
      } catch (error) {
        abortTransaction(tx)
        throw error
      }
    })(),
    tx.done,
  ])
}

const putFiles = async (store: 'files' | 'filesStaging', files: StoredFile[]) => {
  const tx = (await getDB()).transaction(store, 'readwrite')
  await Promise.all([...files.map((file) => tx.store.put(file)), tx.done])
}

export const saveFiles = guarded((files: StoredFile[]): Promise<void> => putFiles('files', files))

export const loadFile = async (id: string): Promise<Blob | undefined> =>
  (await (await getDB()).get('files', id))?.blob

/** 清空导入暂存：开始导入前清除上次中断（如关闭页面）遗留的数据，导入失败后清除本次写入。 */
export const clearStaging = async (): Promise<void> => {
  const tx = (await getDB()).transaction(['sessionsStaging', 'filesStaging'], 'readwrite')
  await Promise.all([
    tx.objectStore('sessionsStaging').clear(),
    tx.objectStore('filesStaging').clear(),
    tx.done,
  ])
}

export const addStagingSession = guarded(async (session: Session): Promise<void> => {
  await (await getDB()).add('sessionsStaging', session)
})

export const saveStagingFiles = guarded((files: StoredFile[]): Promise<void> =>
  putFiles('filesStaging', files)
)

/** 图片位于会话 JSON 之后；全部读完后回填具体 MIME，保留归档给出的 isImage 标识。 */
export const updateStagingFileTypes = async (types: ReadonlyMap<string, string>): Promise<void> => {
  const tx = (await getDB()).transaction('sessionsStaging', 'readwrite')
  await Promise.all([
    (async () => {
      for (let cursor = await tx.store.openCursor(); cursor; cursor = await cursor.continue()) {
        const session = cursor.value
        let changed = false
        for (const message of session.messages) {
          if (message.role !== 'user') {
            continue
          }
          for (const file of message.files) {
            const type = types.get(file.id) ?? ''
            if (file.mimeType !== type) {
              file.mimeType = type
              changed = true
            }
          }
        }
        if (changed) {
          await cursor.update(session)
        }
      }
    })(),
    tx.done,
  ])
}

/**
 * 导入完成后用暂存替换正式数据：同一事务中替换会话、摘要和原件，并清空暂存。
 * 逐条游标复制，同一时间只读取一条记录；事务失败时整体回滚，正式数据不变。
 */
export const commitStaging = guarded(async (): Promise<SessionSummary[]> => {
  const summaries: SessionSummary[] = []
  const tx = (await getDB()).transaction(
    ['sessions', 'sessionSummaries', 'files', 'sessionsStaging', 'filesStaging'],
    'readwrite'
  )
  const move = async (from: 'sessionsStaging' | 'filesStaging', to: 'sessions' | 'files') => {
    try {
      const target = tx.objectStore(to)
      await target.clear()
      if (to === 'sessions') {
        await tx.objectStore('sessionSummaries').clear()
      }
      for (
        let cursor = await tx.objectStore(from).openCursor();
        cursor;
        cursor = await cursor.continue()
      ) {
        await target.put(cursor.value)
        if (to === 'sessions') {
          const summary = storedSummary(cursor.value as Session)
          await tx.objectStore('sessionSummaries').put(summary)
          summaries.push(toSessionSummary(summary))
        }
      }
      await tx.objectStore(from).clear()
    } catch (error) {
      // 同步抛出的错误不会让事务自动回滚，需显式中止，避免只提交清空和部分移入。
      abortTransaction(tx)
      throw error
    }
  }
  await Promise.all([move('sessionsStaging', 'sessions'), move('filesStaging', 'files'), tx.done])
  // 直接返回本次提交的列表，调用方无需在替换成功后再发起可能失败的读取。
  return summaries
})

// ── 云朵被子 ──────────────────────────────────────────────────

/** 全部被子，最近更新的在前（侧栏"我的被子"分组用） */
export const loadBlankets = async (): Promise<BlanketRecord[]> =>
  (await (await getDB()).getAll('blankets')).sort((a, b) => b.updatedAt - a.updatedAt)

export const loadBlanket = async (id: string): Promise<BlanketRecord | undefined> =>
  (await getDB()).get('blankets', id)

export const saveBlanket = guarded(async (blanket: BlanketRecord): Promise<void> => {
  await (await getDB()).put('blankets', blanket)
})

/** 只删被子本身；被蒸的那些会话属于官方数据，由用户在会话列表里自己删 */
export const deleteBlanket = async (id: string): Promise<void> => {
  const db = await getDB()
  const tx = db.transaction(['blankets', 'blanketSessions'], 'readwrite')
  await Promise.all([
    tx.objectStore('blankets').delete(id),
    // 原料会话跟着被子一起走，不留孤儿
    tx.objectStore('blanketSessions').delete(IDBKeyRange.bound(`${id}\u0000`, `${id}\u0000\uffff`)),
    tx.done,
  ])
}

/** 写入/覆盖一床被子的原料会话（重蒸时整组替换由调用方先清空） */
export const saveBlanketSessions = guarded(
  async (blanketId: string, sessions: Session[]): Promise<void> => {
    const db = await getDB()
    const tx = db.transaction('blanketSessions', 'readwrite')
    await Promise.all([
      ...sessions.map((session) =>
        tx.objectStore('blanketSessions').put({
          id: blanketSessionKey(blanketId, session.id),
          blanketId,
          sessionId: session.id,
          session,
        })
      ),
      tx.done,
    ])
  }
)

export const loadBlanketSession = async (
  blanketId: string,
  sessionId: string
): Promise<Session | undefined> =>
  (await (await getDB()).get('blanketSessions', blanketSessionKey(blanketId, sessionId)))?.session

/** 一床被子的全部原料会话（装索引时一次读齐，比逐个 get 快） */
export const loadBlanketSessions = async (blanketId: string): Promise<Session[]> =>
  (await (await getDB()).getAllFromIndex('blanketSessions', 'blanketId', blanketId)).map(
    (record) => record.session
  )

/** 清空一床被子的原料会话（重蒸或换导出包时用） */
export const clearBlanketSessions = async (blanketId: string): Promise<void> => {
  const db = await getDB()
  const tx = db.transaction('blanketSessions', 'readwrite')
  await Promise.all([
    tx.objectStore('blanketSessions').delete(IDBKeyRange.bound(`${blanketId}\u0000`, `${blanketId}\u0000\uffff`)),
    tx.done,
  ])
}

/** 本地存储失败不打断对话，只在控制台留痕 */
export const reportStorageError = (action: string) => (error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(`[storage] ${action} failed`, error)
}

// ── 备份/恢复（v1.0.1 P0：清缓存/换手机/换域名都会数据清零）──

/** 参与备份的四个正式 store；sessionSummaries 不备份（可从 sessions 重建），暂存不备份 */
type BackupStoreName = 'sessions' | 'files' | 'blankets' | 'blanketSessions'
type BackupStoreValue = {
  sessions: Session
  files: StoredFile
  blankets: BlanketRecord
  blanketSessions: BlanketSessionRecord
}

/**
 * 游标遍历一个 store 的全部记录。
 * 备份用：几百个会话逐条过，别 getAll 一次性进内存（手机 JS 堆约 400MB）。
 * visit 里只做同步工作或同一事务内的读取——跨事务的 await 会让游标事务提前失效。
 */
export const iterateStore = async <N extends BackupStoreName>(
  name: N,
  visit: (value: BackupStoreValue[N]) => Promise<void> | void,
): Promise<number> => {
  const tx = (await getDB()).transaction(name, 'readonly')
  let count = 0
  for (
    let cursor = await tx.objectStore(name).openCursor();
    cursor;
    cursor = await cursor.continue()
  ) {
    await visit(cursor.value as BackupStoreValue[N])
    count += 1
  }
  await tx.done
  return count
}

export interface RestorePayload {
  sessions: Session[]
  files: StoredFile[]
  blankets: BlanketRecord[]
  blanketSessions: BlanketSessionRecord[]
}

/**
 * 恢复备份 = 整体覆盖（合并语义太容易错，第一版不做）。
 * 单事务里清空四个正式 store 后写回，sessionSummaries 从 sessions 重建；
 * 失败整体回滚，现有数据保持原样。
 */
export const restoreFromBackup = guarded(async (payload: RestorePayload): Promise<void> => {
  const storeNames = [
    'sessions',
    'files',
    'blankets',
    'blanketSessions',
    'sessionSummaries',
  ] as const
  const tx = (await getDB()).transaction(storeNames, 'readwrite')
  try {
    for (const name of storeNames) {
      await tx.objectStore(name).clear()
    }
    for (const session of payload.sessions) {
      await tx.objectStore('sessions').put(session)
      await tx.objectStore('sessionSummaries').put(storedSummary(session))
    }
    for (const file of payload.files) {
      await tx.objectStore('files').put(file)
    }
    for (const blanket of payload.blankets) {
      await tx.objectStore('blankets').put(blanket)
    }
    for (const record of payload.blanketSessions) {
      await tx.objectStore('blanketSessions').put(record)
    }
  } catch (error) {
    abortTransaction(tx)
    throw error
  }
  await tx.done
})

// ── 账本用量（账本方案 §3.3，2026-11-25）────────────────────
// 只存数字和时间，绝不存消息内容；纯本地，无任何上传。
// 小写入不走过 guarded 闸（账本丢了不该弹"存储已满"打断聊天，失败静默）。

let usageSeq = 0

/** 记一笔用量。失败静默：账本是锦上添花，不能让它打断聊天或蒸馏。 */
export const addUsageLog = async (entry: Omit<UsageLogEntry, 'id'>): Promise<void> => {
  try {
    const db = await getDB()
    usageSeq = (usageSeq + 1) % Number.MAX_SAFE_INTEGER
    await db.put('usageLog', { ...entry, id: `${entry.ts.toString(36)}-${usageSeq.toString(36)}` })
  } catch (error) {
    reportStorageError('usage log')(error)
  }
}

/** 倒序取最近 limit 条（账本明细只读，不做删除/编辑） */
export const loadUsageLog = async (limit: number): Promise<UsageLogEntry[]> => {
  const db = await getDB()
  const out: UsageLogEntry[] = []
  for await (const cursor of db.transaction('usageLog').store.index('ts').iterate(undefined, 'prev')) {
    out.push(cursor.value)
    if (out.length >= limit) {
      break
    }
  }
  return out
}

/** 全量累计（明细上千条也是小记录，一次读齐算总计最简单，不单独维护汇总行） */
export const loadUsageTotal = async (): Promise<{ total: number; count: number }> => {
  const db = await getDB()
  let total = 0
  let count = 0
  for await (const cursor of db.transaction('usageLog').store) {
    total += cursor.value.cost
    count += 1
  }
  return { total, count }
}
