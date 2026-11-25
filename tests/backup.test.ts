import { describe, expect, it } from 'vitest'
import {
  BACKUP_SCHEMA_VERSION,
  BackupFormatError,
  backupFileName,
  buildManifest,
  fromJsonl,
  parseManifest,
  toJsonl,
} from '../src/services/backup/backup.js'

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
