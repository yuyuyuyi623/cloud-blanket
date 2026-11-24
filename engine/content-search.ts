/**
 * engine/content-search.ts —— 内容搜索（搜"她说过的话"，不只搜标题）
 *
 * 为什么要单独一层：会话列表屏拿的是"粗扫"结果（只有统计、没有正文），
 * 标题搜索够用；但用户真正想做的是"我记得她说过一句什么，找出来在哪个对话"。
 * 这需要正文。
 *
 * 内存策略（手机）：不建倒排索引（583 万字建索引要吃 200MB+，会顶爆手机堆），
 * 改为"正文文本缓存"——每会话一段纯文本，全库约 12MB；搜索是内存子串扫描，
 * 1206 个会话 × 583 万字，几十毫秒级。缓存只在首次搜索时构一次。
 */

import { ZipDirectory, utf8Decode, type RangeReader } from './zip-reader.js';
import { mainline, messageText, mapLimit } from './parse.js';

export interface ContentHit {
  sessionId: string;
  /** 该会话里命中的总处数（各关键词出现次数之和） */
  matches: number;
  /** 第一处命中前后的一小段，给你在列表里直接看 */
  snippet: string;
}

/** 只保留会话正文文本（带"我/她"前缀，便于读片段） */
function renderSessionText(raw: string): string {
  const obj = JSON.parse(raw) as Record<string, unknown>;
  const line = mainline(obj);
  const parts: string[] = [];
  for (const m of line) {
    const { text } = messageText(m);
    if (!text) continue;
    parts.push(`${m.role === 'USER' ? '我' : '她'}：${text}`);
  }
  return parts.join('\n');
}

export interface CollectTextsOptions {
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
}

/**
 * 读整个包的正文，返回 sessionId → 文本。
 * 手机端首次搜索调用一次（约 10~30s，带进度），之后所有搜索走内存。
 */
export async function collectSessionTexts(
  reader: RangeReader,
  opts: CollectTextsOptions = {}
): Promise<Map<string, string>> {
  const dir = await ZipDirectory.open(reader);
  const names = dir
    .listNames()
    .filter((n) => n.startsWith('chat_sessions/') && n.endsWith('.json') && !n.includes('_files/'));

  const concurrency = opts.concurrency ?? 2; // 手机：正文比统计大得多，并发压低
  let done = 0;
  const results = await mapLimit(names, concurrency, async (name) => {
    try {
      const text = renderSessionText(utf8Decode(await dir.readEntry(name)));
      return { name, text };
    } catch {
      return { name, text: '' }; // 坏会话不影响搜索
    } finally {
      done++;
      opts.onProgress?.(done, names.length);
    }
  });

  const texts = new Map<string, string>();
  for (const r of results) {
    // 文件名即会话 id（导出格式分析 三.1）
    const id = r.name.slice(r.name.lastIndexOf('/') + 1, -'.json'.length);
    if (r.text) texts.set(id, r.text);
  }
  return texts;
}

/** 关键词切分：空格分隔，多词 AND；中文不需要分词（子串即可命中） */
export function splitTerms(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

function makeSnippet(text: string, at: number, len: number): string {
  const from = Math.max(0, at - 30);
  const to = Math.min(text.length, at + len + 50);
  const body = text.slice(from, to).replace(/\s+/g, ' ').trim();
  return `${from > 0 ? '…' : ''}${body}${to < text.length ? '…' : ''}`;
}

/**
 * 在文本缓存里搜（纯内存）。
 * 多关键词 = AND（全都出现才算命中），次数是各词出现次数之和。
 */
export function searchTexts(texts: Map<string, string>, query: string): Map<string, ContentHit> {
  const terms = splitTerms(query);
  if (!terms.length) return new Map();

  const hits = new Map<string, ContentHit>();
  for (const [sessionId, text] of texts) {
    const lower = text.toLowerCase();
    let matches = 0;
    let firstAt = -1;
    let firstLen = 0;
    let allFound = true;

    for (const t of terms) {
      let from = 0;
      let count = 0;
      let firstOfTerm = -1;
      for (;;) {
        const i = lower.indexOf(t, from);
        if (i < 0) break;
        count++;
        if (firstOfTerm < 0) firstOfTerm = i;
        from = i + t.length;
      }
      if (!count) {
        allFound = false;
        break;
      }
      matches += count;
      if (firstAt < 0 || firstOfTerm < firstAt) {
        firstAt = firstOfTerm;
        firstLen = t.length;
      }
    }

    if (!allFound) continue;
    hits.set(sessionId, { sessionId, matches, snippet: makeSnippet(text, firstAt, firstLen) });
  }
  return hits;
}
