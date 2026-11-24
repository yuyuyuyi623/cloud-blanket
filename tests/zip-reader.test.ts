/**
 * zip-reader 测试：流式读取必须与整包读取（JSZip）结果逐字一致。
 * 这是手机 OOM 方案的正确性命脉——两套入口，一套口径。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import {
  ZipDirectory,
  base64ToBytes,
  utf8Decode,
  type RangeReader,
} from '../engine/zip-reader.js';
import { loadSessions, loadSessionsFromReader } from '../engine/parse.js';

/** 电脑端 RangeReader：fs 按位置读（模拟手机上的 expo-file-system 分段读） */
function fsReader(filePath: string): RangeReader {
  const size = fs.statSync(filePath).size;
  return {
    size,
    readRange: async (start, length) => {
      const fh = fs.openSync(filePath, 'r');
      try {
        const buf = new Uint8Array(length);
        const n = fs.readSync(fh, buf, 0, length, start);
        return new Uint8Array(buf.subarray(0, n));
      } finally {
        fs.closeSync(fh);
      }
    },
  };
}

function makeSession(id: string, opts: { turns?: number; title?: string } = {}) {
  const msgs: Record<string, unknown>[] = [];
  let parent: string | null = null;
  const turns = opts.turns ?? 2;
  for (let i = 0; i < turns; i++) {
    const uid = `${id}-u${i}`;
    msgs.push({
      id: uid,
      parent_id: parent,
      role: 'USER',
      inserted_at: `2026-07-0${(i % 8) + 1}T10:00:00`,
      status: 'FINISHED',
      fragments: [{ type: 'REQUEST', content: `你好，这是${id}的第${i}轮` }],
    });
    const aid = `${id}-a${i}`;
    msgs.push({
      id: aid,
      parent_id: uid,
      role: 'ASSISTANT',
      inserted_at: `2026-07-0${(i % 8) + 1}T10:00:05`,
      status: 'FINISHED',
      fragments: [
        { type: 'THINK', content: '思考链要被丢掉' },
        { type: 'RESPONSE', content: `我在呢，${id}的第${i}轮回复` },
      ],
    });
    parent = aid;
  }
  return {
    id,
    title: opts.title ?? id,
    pinned: false,
    current_message_id: parent,
    messages: msgs,
  };
}

async function makeZipFile(): Promise<string> {
  const zip = new JSZip();
  zip.file('manifest.json', JSON.stringify({ export_format_version: 3 }));
  zip.file('chat_sessions/session-a.json', JSON.stringify(makeSession('session-a')));
  zip.file('chat_sessions/session-b.json', JSON.stringify(makeSession('session-b', { turns: 3 })));
  zip.file('chat_sessions/broken.json', '{ 这是坏 JSON');
  zip.file('chat_sessions/x_files/attachment.bin', 'binary');
  zip.file('chat_sessions/中文标题.json', JSON.stringify(makeSession('中文标题', { title: '中文' })));
  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const p = path.join(os.tmpdir(), `cb-zip-reader-test-${Date.now()}.zip`);
  fs.writeFileSync(p, new Uint8Array(buf));
  return p;
}

describe('ZipDirectory', () => {
  it('能打开 JSZip 生成的 deflate 包并列出条目', async () => {
    const p = await makeZipFile();
    const dir = await ZipDirectory.open(fsReader(p));
    const names = dir.listNames();
    expect(names).toContain('manifest.json');
    expect(names).toContain('chat_sessions/session-a.json');
    expect(names).toContain('chat_sessions/中文标题.json');
    // 中文文件名也能正确读出内容（UTF-8 条目内容走 utf8Decode）
    const raw = utf8Decode(await dir.readEntry('chat_sessions/中文标题.json'));
    expect(JSON.parse(raw).id).toBe('中文标题');
  });

  it('条目内容与原文一致（deflate 往返无损）', async () => {
    const p = await makeZipFile();
    const dir = await ZipDirectory.open(fsReader(p));
    const raw = utf8Decode(await dir.readEntry('chat_sessions/session-b.json'));
    expect(JSON.parse(raw).messages).toHaveLength(6);
  });

  it('非 ZIP 文件报清晰错误', async () => {
    const p = path.join(os.tmpdir(), `cb-not-zip-${Date.now()}.txt`);
    fs.writeFileSync(p, '这根本不是 zip 文件'.repeat(100));
    await expect(ZipDirectory.open(fsReader(p))).rejects.toThrowError(/ZIP/);
  });
});

describe('loadSessionsFromReader', () => {
  it('流式入口与整包入口结果一致（含 manifest、broken、中文条目）', async () => {
    const p = await makeZipFile();
    const bytes = new Uint8Array(fs.readFileSync(p));

    const whole = await loadSessions(bytes, { withMessages: false });
    const stream = await loadSessionsFromReader(fsReader(p), { withMessages: false });

    expect(stream.formatVersion).toBe(whole.formatVersion);
    expect(stream.sessionCount).toBe(whole.sessionCount);
    expect(stream.broken).toHaveLength(whole.broken.length);
    const ids = (r: typeof stream) => r.sessions.map((s) => s.id).sort();
    expect(ids(stream)).toEqual(ids(whole));
    const a = stream.sessions.find((s) => s.id === 'session-a');
    expect(a!.userTurns).toBe(2);
    expect(a!.stats.thinkCount).toBe(2);
  });

  it('带消息细读时内容可用', async () => {
    const p = await makeZipFile();
    const r = await loadSessionsFromReader(fsReader(p), {
      withMessages: true,
      onlyIds: new Set(['session-b']),
    });
    expect(r.sessionCount).toBe(4); // sessionCount 统计全部会话，不只命中的
    expect(r.sessions).toHaveLength(1);
    expect(r.sessions[0]!.messages?.[0]?.text).toContain('第0轮');
  });

  it('onProgress 逐条回调到 total', async () => {
    const p = await makeZipFile();
    const seen: [number, number][] = [];
    await loadSessionsFromReader(fsReader(p), {
      withMessages: false,
      onProgress: (done, total) => seen.push([done, total]),
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toEqual([4, 4]); // 4 个条目全计入（broken 报错也算"处理完"）
  });
});

describe('工具函数', () => {
  it('base64ToBytes 对含中文的 UTF-8 字节无损', () => {
    const src = new TextEncoder().encode('你好，云朵被子 abc123 🌙');
    // 用 Buffer 转 base64（Node 端真值），再走我们的解码器
    const b64 = Buffer.from(src).toString('base64');
    const out = base64ToBytes(b64);
    expect(Array.from(out)).toEqual(Array.from(src));
    expect(utf8Decode(out)).toBe('你好，云朵被子 abc123 🌙');
  });

  it('base64ToBytes 能解 expo 分段读返回的完整 base64', () => {
    const src = crypto.getRandomValues(new Uint8Array(1000));
    const b64 = Buffer.from(src).toString('base64');
    expect(Array.from(base64ToBytes(b64))).toEqual(Array.from(src));
  });
});
