import { describe, expect, it, vi } from 'vitest'
import {
  applySettings,
  BACKUP_SCHEMA_VERSION,
  BackupFormatError,
  backupFileName,
  buildManifest,
  collectSettings,
  fromJsonl,
  parseManifest,
  toJsonl,
} from '../src/services/backup/backup.js'
import { API_KEY_STORAGE_KEY } from '../src/services/settings.js'

describe('备份 manifest', () => {
  it('buildManifest 产出带类型标记与版本号的结构', () => {
    const m = buildManifest(
      { sessions: 3, files: 2, blankets: 1, blanketSessions: 4 },
      '0.1.3',
      '2026-11-25T03:00:00.000Z',
    )
    expect(m.type).toBe('cloud-blanket-backup')
    expect(m.schemaVersion).toBe(BACKUP_SCHEMA_VERSION)
    expect(m.appVersion).toBe('0.1.3')
    expect(m.counts.blanketSessions).toBe(4)
    expect(m.createdAt).toBe('2026-11-25T03:00:00.000Z')
  })

  it('parseManifest 接受本应用产出的 manifest', () => {
    const m = buildManifest({ sessions: 0, files: 0, blankets: 0, blanketSessions: 0 }, '0.1.3')
    expect(parseManifest(JSON.stringify(m))).toEqual(m)
  })

  it('parseManifest 拒绝非本应用的 zip', () => {
    expect(() => parseManifest(JSON.stringify({ type: 'something-else', schemaVersion: 1 }))).toThrow(
      BackupFormatError,
    )
  })

  it('parseManifest 拒绝非 JSON', () => {
    expect(() => parseManifest('这不是 JSON')).toThrow(BackupFormatError)
  })

  it('parseManifest 拒绝更新版本的备份（schemaVersion 超前）', () => {
    const m = buildManifest({ sessions: 0, files: 0, blankets: 0, blanketSessions: 0 }, '9.9.9')
    m.schemaVersion = BACKUP_SCHEMA_VERSION + 1
    expect(() => parseManifest(JSON.stringify(m))).toThrow(BackupFormatError)
  })

  it('parseManifest 接受旧版本（schemaVersion 更小）的备份，向前兼容', () => {
    const m = buildManifest({ sessions: 1, files: 0, blankets: 0, blanketSessions: 0 }, '0.1.3')
    m.schemaVersion = 1
    expect(parseManifest(JSON.stringify(m)).schemaVersion).toBe(1)
  })
})

describe('备份 JSONL 编解码', () => {
  it('toJsonl / fromJsonl 往返一致', () => {
    const items = [
      { id: 'a', messages: [{ role: 'user', content: '你好' }] },
      { id: 'b', nested: { deep: [1, 2, 3] } },
      { id: 'c', text: '带\n换行的内容也不会破行——JSON.stringify 会转义' },
    ]
    const text = toJsonl(items)
    // 每条一行：c 的换行被转义，不产生额外行
    expect(text.split('\n')).toHaveLength(items.length + 1) // 末尾留一个空串
    expect(fromJsonl(text)).toEqual(items)
  })

  it('fromJsonl 跳过空行', () => {
    const text = '{"a":1}\n\n{"b":2}\n\n'
    expect(fromJsonl(text)).toEqual([{ a: 1 }, { b: 2 }])
  })

  it('toJsonl 空数组产出空文件', () => {
    expect(toJsonl([])).toBe('')
    expect(fromJsonl('')).toEqual([])
  })
})

describe('备份文件名', () => {
  it('按日期时间命名，可排序、无空格冒号', () => {
    const name = backupFileName(new Date(2026, 10, 25, 9, 5)) // 2026-11-25 09:05 本地
    expect(name).toBe('cloud-blanket-backup-20261125-0905.zip')
    expect(name).not.toContain(':')
  })
})

describe('备份与 API 密钥', () => {
  /** node 环境没有 localStorage，用 Map 模拟一个（只覆盖用到的四个方法） */
  const store = new Map<string, string>()
  const localStorageShim = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  }

  it('collectSettings 不导出 API 密钥（备份文件可能被别人看，2026-11-25 拍板）', () => {
    vi.stubGlobal('localStorage', localStorageShim)
    localStorageShim.setItem(API_KEY_STORAGE_KEY, 'sk-secret')
    localStorageShim.setItem('chat-demo:locale', 'zh')
    const collected = collectSettings()
    expect(collected[API_KEY_STORAGE_KEY]).toBeUndefined()
    expect(collected['chat-demo:locale']).toBe('zh')
    vi.unstubAllGlobals()
  })

  it('applySettings 跳过 API 密钥：不覆盖、也不因为包里没有而删掉现有密钥', () => {
    vi.stubGlobal('localStorage', localStorageShim)
    localStorageShim.setItem(API_KEY_STORAGE_KEY, 'sk-current')
    localStorageShim.setItem('chat-demo:locale', 'en')
    // 模拟旧版备份包：里面竟然还带密钥，也绝不允许覆盖
    applySettings({ [API_KEY_STORAGE_KEY]: 'sk-from-backup', 'chat-demo:locale': 'zh' })
    expect(localStorageShim.getItem(API_KEY_STORAGE_KEY)).toBe('sk-current')
    expect(localStorageShim.getItem('chat-demo:locale')).toBe('zh')
    // 模拟新版备份包：包里没有的设置键按缺席处理（移除），但密钥不动
    applySettings({})
    expect(localStorageShim.getItem(API_KEY_STORAGE_KEY)).toBe('sk-current')
    expect(localStorageShim.getItem('chat-demo:locale')).toBeNull()
    vi.unstubAllGlobals()
  })
})
