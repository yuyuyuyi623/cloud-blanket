/**
 * 备份/恢复（v1.0.1 P0）。
 *
 * 为什么是现在做：换手机/清缓存/换域名都会数据清零（换域名清零 2026-11-24 已真实发生过），
 * 这是当前最大的风险敞口。备份 = 把"她"整个带走。
 *
 * 格式：zip（fflate 流式压缩，附件放原始二进制不 base64，省 33% 体积）：
 *   manifest.json        校验用（类型标记 + 格式版本 + 各 store 条数）
 *   settings.json        localStorage 键值（不含 API 密钥——备份文件可能被别人看，密钥恢复后重填）
 *   sessions.jsonl       逐条 JSON 行（不导 sessionSummaries，恢复时重建）
 *   blankets.json        被子记录（含记忆包）
 *   blanketSessions.jsonl 被子原料会话
 *   files/<附件id>       附件原件
 * 不导：sessionsStaging / filesStaging（导入暂存）、sessionSummaries（可重建）。
 *
 * 内存策略：导出用 fflate 流式 Zip，文本逐条 push，不在内存里攒完整字符串；
 * 有 showSaveFilePicker（Chromium/PWA）时边压边直写文件系统，内存峰值最低；
 * 否则退回内存攒 chunks → Blob → 原生下载。恢复目前需整包读进内存（JSZip），
 * 大包在低端手机上有压力，是已知边界，第一版接受。
 */

import { Zip, ZipDeflate } from 'fflate'
import JSZip from 'jszip'
import { iterateStore, restoreFromBackup } from '../chat/db.js'
import type { BlanketSessionRecord, StoredFile } from '../chat/db.js'
import type { BlanketRecord } from '../memory/blanket.js'
import { API_KEY_STORAGE_KEY, SETTINGS_KEYS } from '../settings.js'
import type { Session } from '../chat/types.js'

/** 备份格式版本：结构不兼容时递增，恢复侧按它拒绝或转换 */
export const BACKUP_SCHEMA_VERSION = 1
/** manifest 里的类型标记：恢复时拒绝任何不是本应用产出的 zip */
export const BACKUP_TYPE = 'cloud-blanket-backup'

export interface BackupManifest {
  type: string
  schemaVersion: number
  createdAt: string
  /** 各 store 条数；恢复时不强校验，给出问题诊断线索 */
  counts: { sessions: number; files: number; blankets: number; blanketSessions: number }
  /** 产出时的应用版本，排查用 */
  appVersion: string
}

export const backupFileName = (now: Date = new Date()): string => {
  const p = (n: number) => String(n).padStart(2, '0')
  return `cloud-blanket-backup-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}.zip`
}

// ── 纯函数（单测覆盖的部分）─────────────────────────────────

export const buildManifest = (
  counts: BackupManifest['counts'],
  appVersion: string,
  createdAt: string = new Date().toISOString(),
): BackupManifest => ({ type: BACKUP_TYPE, schemaVersion: BACKUP_SCHEMA_VERSION, createdAt, counts, appVersion })

export class BackupFormatError extends Error {}

/** 恢复前的第一道闸：类型不对 / 版本超前的包直接拒绝，错误信息说人话 */
export const parseManifest = (text: string): BackupManifest => {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new BackupFormatError('manifest 不是合法 JSON')
  }
  const m = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  if (m.type !== BACKUP_TYPE) {
    throw new BackupFormatError('不是云朵被子的备份文件')
  }
  if (typeof m.schemaVersion !== 'number' || m.schemaVersion > BACKUP_SCHEMA_VERSION) {
    throw new BackupFormatError('备份文件来自更新的版本，请先升级应用再恢复')
  }
  return m as unknown as BackupManifest
}

/** 逐条 JSON 行。行内不含换行（JSON.stringify 保证），一行一条，最后允许有或没有空行 */
export const toJsonl = (items: readonly unknown[]): string =>
  items.map((item) => JSON.stringify(item)).join('\n') + (items.length ? '\n' : '')

export const fromJsonl = <T>(text: string): T[] => {
  const out: T[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) {
      continue
    }
    out.push(JSON.parse(trimmed) as T)
  }
  return out
}

/** 收集设置键值。API 密钥永不导出（2026-11-25 拍板）：备份文件可能给别人看，重填一次不麻烦 */
export const collectSettings = (): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const key of SETTINGS_KEYS) {
    if (key === API_KEY_STORAGE_KEY) {
      continue
    }
    const value = localStorage.getItem(key)
    if (value !== null) {
      out[key] = value
    }
  }
  return out
}

/**
 * 恢复设置：原样写回。不认识的键忽略（向前兼容），认识的键不丢。
 * API 密钥跳过：旧版备份包里可能还带密钥（禁止覆盖现有设备的），新版包里本来就没有。
 */
export const applySettings = (record: Record<string, string>): void => {
  for (const key of SETTINGS_KEYS) {
    if (key === API_KEY_STORAGE_KEY) {
      continue
    }
    const value = record[key]
    if (typeof value === 'string') {
      localStorage.setItem(key, value)
    } else {
      localStorage.removeItem(key)
    }
  }
}

// ── 导出 ─────────────────────────────────────────────────────

const enc = new TextEncoder()

interface ZipSink {
  pushText(name: string, text: string): void
  pushOpenText(name: string): { write(text: string): void; finish(): void }
  pushBinary(name: string, bytes: Uint8Array): void
  finish(): void
}

/**
 * 流式 Zip 写入器。直写模式（showSaveFilePicker 可用）每个压缩块直接落盘，
 * 内存峰值最低；否则块攒进内存，最后拼 Blob 下载。
 */
const createZipSink = async (fileName: string): Promise<ZipSink> => {
  const chunks: Uint8Array[] = []
  let writable: { write(data: Uint8Array): Promise<void>; close(): Promise<void> } | null = null
  let doneResolve: (() => void) | null = null
  const finished = new Promise<void>((resolve) => {
    doneResolve = resolve
  })
  let failure: Error | null = null

  const zip = new Zip((err, data, final) => {
    if (err) {
      failure = err instanceof Error ? err : new Error(String(err))
      doneResolve?.()
      return
    }
    if (writable) {
      void writable.write(data)
        .catch((e: unknown) => {
          failure = e instanceof Error ? e : new Error(String(e))
          doneResolve?.()
        })
    } else if (data.length) {
      chunks.push(data)
    }
    if (final) {
      if (writable) {
        void writable.close().catch((e: unknown) => {
          failure = e instanceof Error ? e : new Error(String(e))
        }).finally(() => doneResolve?.())
      } else {
        doneResolve?.()
      }
    }
  })

  // showSaveFilePicker 需要 user gesture；exportBackup 由按钮点击触发，链路上没有 await 丢失手势
  const picker = (window as unknown as { showSaveFilePicker?: (opts: unknown) => Promise<{
    createWritable: () => Promise<{ write(data: Uint8Array): Promise<void>; close(): Promise<void> }>
  }> }).showSaveFilePicker
  if (picker) {
    try {
      const handle = await picker({
        suggestedName: fileName,
        types: [{ description: 'Cloud Blanket Backup', accept: { 'application/zip': ['.zip'] } }],
      })
      writable = await handle.createWritable()
    } catch {
      // 用户取消保存对话框 → 整个导出取消
      throw new DOMException('canceled', 'AbortError')
    }
  }

  const addDeflate = (name: string): ZipDeflate => {
    const deflate = new ZipDeflate(name, { level: 6 })
    zip.add(deflate)
    return deflate
  }

  return {
    pushText(name, text) {
      const deflate = addDeflate(name)
      deflate.push(enc.encode(text), true)
    },
    pushOpenText(name) {
      const deflate = addDeflate(name)
      return {
        write(text) {
          deflate.push(enc.encode(text))
        },
        finish() {
          deflate.push(new Uint8Array(0), true)
        },
      }
    },
    pushBinary(name, bytes) {
      const deflate = addDeflate(name)
      deflate.push(bytes, true)
    },
    finish() {
      zip.end()
      return finished.then(() => {
        if (failure) {
          throw failure
        }
        if (!writable) {
          const blob = new Blob(chunks as BlobPart[], { type: 'application/zip' })
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url
          a.download = fileName
          a.click()
          // 大文件 revoke 太早会打断下载；60 秒足够
          setTimeout(() => URL.revokeObjectURL(url), 60_000)
        }
      })
    },
  }
}

/** 导出全部数据。调用方负责按钮 busy 态；失败抛出，由调用方提示。 */
export const exportBackup = async (appVersion: string): Promise<void> => {
  const counts = { sessions: 0, files: 0, blankets: 0, blanketSessions: 0 }
  const sink = await createZipSink(backupFileName())

  const settings = collectSettings()
  sink.pushText('settings.json', JSON.stringify(settings))

  const sessions = sink.pushOpenText('sessions.jsonl')
  await iterateStore('sessions', (session) => {
    counts.sessions += 1
    sessions.write(JSON.stringify(session) + '\n')
  })
  sessions.finish()

  const blanketSessions = sink.pushOpenText('blanketSessions.jsonl')
  await iterateStore('blanketSessions', (record) => {
    counts.blanketSessions += 1
    blanketSessions.write(JSON.stringify(record) + '\n')
  })
  blanketSessions.finish()

  const blankets: BlanketRecord[] = []
  await iterateStore('blankets', (record) => {
    counts.blankets += 1
    blankets.push(record)
  })
  sink.pushText('blankets.json', JSON.stringify(blankets))

  // files：游标事务里只收集 Blob 引用（blob 是磁盘 backed，引用不占堆内存）；
  // await blob.arrayBuffer() 不是 IndexedDB 请求，放在游标事务里会让事务空闲提交、游标失效，
  // 所以字节读取必须在事务关闭之后逐个做。
  const fileRecords: StoredFile[] = []
  await iterateStore('files', (file) => {
    counts.files += 1
    fileRecords.push(file)
  })
  for (const file of fileRecords) {
    const bytes = new Uint8Array(await file.blob.arrayBuffer())
    sink.pushBinary(`files/${file.id}`, bytes)
  }

  // manifest 放最后写：此时 counts 是真数字（恢复方不依赖 zip 内文件顺序）
  sink.pushText('manifest.json', JSON.stringify(buildManifest(counts, appVersion)))
  await sink.finish()
}

// ── 恢复 ─────────────────────────────────────────────────────

/**
 * 恢复备份：读 zip → 校验 manifest → 设置写回 localStorage（API 密钥除外，不覆盖不删除）→ 单事务覆盖 IndexedDB。
 * 设置写回后由调用方 reload 生效；API 密钥不在备份里，恢复后用户需重新输入。
 * 附件找不到只影响缩略图/查看，不阻断恢复。
 */
export const restoreBackup = async (file: File): Promise<void> => {
  const zip = await JSZip.loadAsync(file)
  const manifestText = await zip.file('manifest.json')?.async('string')
  if (!manifestText) {
    throw new BackupFormatError('备份文件缺少 manifest.json，可能已损坏')
  }
  parseManifest(manifestText)

  const readText = async (name: string): Promise<string> =>
    (await zip.file(name)?.async('string')) ?? ''

  const sessions = fromJsonl<Session>(await readText('sessions.jsonl'))
  const blanketSessions = fromJsonl<BlanketSessionRecord>(await readText('blanketSessions.jsonl'))
  const blankets: BlanketRecord[] = JSON.parse((await readText('blankets.json')) || '[]')
  const settings: Record<string, string> = JSON.parse((await readText('settings.json')) || '{}')

  const files: StoredFile[] = []
  for (const path of Object.keys(zip.files)) {
    const entry = zip.files[path]
    if (!path.startsWith('files/') || !entry || entry.dir) {
      continue
    }
    const blob = await entry.async('blob')
    files.push({ id: path.slice('files/'.length), blob })
  }

  applySettings(settings)
  await restoreFromBackup({ sessions, files, blankets, blanketSessions })
}
