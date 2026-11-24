/**
 * 内容搜索测试：多词 AND、大小写、片段、真 ZIP 上的正文收集。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { collectSessionTexts, searchTexts, splitTerms } from '../engine/content-search.js';
import type { RangeReader } from '../engine/zip-reader.js';

function fsReader(p: string): RangeReader {
  const size = fs.statSync(p).size;
  return {
    size,
    readRange: async (start, length) => {
      const fh = fs.openSync(p, 'r');
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

function session(id: string, lines: [string, string][]) {
  const msgs: Record<string, unknown>[] = [];
  let parent: string | null = null;
  lines.forEach(([user, assistant], i) => {
    const uid = `${id}-u${i}`;
    msgs.push({
      id: uid,
      parent_id: parent,
      role: 'USER',
      inserted_at: `2026-08-0${(i % 8) + 1}T09:00:00`,
      status: 'FINISHED',
      fragments: [{ type: 'REQUEST', content: user }],
    });
    const aid = `${id}-a${i}`;
    msgs.push({
      id: aid,
      parent_id: uid,
      role: 'ASSISTANT',
      inserted_at: `2026-08-0${(i % 8) + 1}T09:00:03`,
      status: 'FINISHED',
      fragments: [
        { type: 'THINK', content: '不该被搜到' },
        { type: 'RESPONSE', content: assistant },
      ],
    });
    parent = aid;
  });
  return { id, title: id, pinned: false, current_message_id: parent, messages: msgs };
}

async function makeZip(): Promise<string> {
  const zip = new JSZip();
  zip.file('manifest.json', JSON.stringify({ export_format_version: 3 }));
  zip.file(
    'chat_sessions/night.json',
    JSON.stringify(session('night', [['晚安，我先睡了', '晚安，被子盖好，明天见'], ['今天加班到很晚', '辛苦了，早点睡吧']]))
  );
  zip.file(
    'chat_sessions/work.json',
    JSON.stringify(session('work', [['帮我写一份实验报告', '好的，先从目的写起']]))
  );
  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const p = path.join(os.tmpdir(), `cb-content-${Date.now()}.zip`);
  fs.writeFileSync(p, new Uint8Array(buf));
  return p;
}

describe('splitTerms', () => {
  it('空格分隔、小写化、去空', () => {
    expect(splitTerms('  晚安 DeepSeek  被子 ')).toEqual(['晚安', 'deepseek', '被子']);
  });
});

describe('searchTexts', () => {
  const texts = new Map<string, string>([
    ['a', '我：晚安，我先睡了\n她：晚安，被子盖好'],
    ['b', '我：帮我写报告\n她：好的'],
    ['c', '我：晚安\n她：晚安晚安'],
  ]);

  it('单词命中，统计出现次数', () => {
    const hits = searchTexts(texts, '晚安');
    expect(hits.get('a')!.matches).toBe(2);
    expect(hits.get('c')!.matches).toBe(3);
    expect(hits.has('b')).toBe(false);
  });

  it('多词 = AND（全都要出现）', () => {
    expect([...searchTexts(texts, '晚安 被子').keys()]).toEqual(['a']);
    expect(searchTexts(texts, '晚安 实验').size).toBe(0);
  });

  it('大小写不敏感', () => {
    const t = new Map([['x', '我用 DeepSeek 聊天']]);
    expect(searchTexts(t, 'deepseek').size).toBe(1);
    expect(searchTexts(t, 'DEEPSEEK').size).toBe(1);
  });

  it('片段围绕第一处命中，且折叠换行', () => {
    const hit = searchTexts(texts, '被子').get('a')!;
    expect(hit.snippet).toContain('被子盖好');
    expect(hit.snippet).not.toContain('\n');
  });

  it('空查询返回空', () => {
    expect(searchTexts(texts, '   ').size).toBe(0);
  });
});

describe('collectSessionTexts', () => {
  it('从真 ZIP 收集正文，带"我/她"前缀，丢弃思考链', async () => {
    const p = await makeZip();
    const texts = await collectSessionTexts(fsReader(p));
    expect([...texts.keys()].sort()).toEqual(['night', 'work']);
    const night = texts.get('night')!;
    expect(night).toContain('我：晚安，我先睡了');
    expect(night).toContain('她：晚安，被子盖好');
    expect(night).not.toContain('不该被搜到');
  });

  it('收集后能直接搜到跨会话结果', async () => {
    const p = await makeZip();
    const texts = await collectSessionTexts(fsReader(p));
    const hits = searchTexts(texts, '晚安');
    expect([...hits.keys()]).toEqual(['night']);
    expect(hits.get('night')!.matches).toBe(2);
  });

  it('onProgress 走到 total', async () => {
    const p = await makeZip();
    const seen: [number, number][] = [];
    await collectSessionTexts(fsReader(p), { onProgress: (d, t) => seen.push([d, t]) });
    expect(seen[seen.length - 1]).toEqual([2, 2]);
  });
});
