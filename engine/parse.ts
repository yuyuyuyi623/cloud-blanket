/**
 * engine/parse.ts —— DeepSeek 导出包解析（口径与 cli/lib/parse.mjs 同源）
 *
 * 与 CLI 的关系：CLI 目前保留自己的副本（用户已在用）；app 端与 distill 走本文件。
 * M3 结束时 CLI 统一切到 engine，副本退役。
 *
 * 口径出处：
 *   - 主干回溯：docs/导出格式分析-2026-11-22.md 四.1（样本实证 52 条不在主干上）
 *   - 只收 REQUEST/RESPONSE 字符串：同文档三、四.3；THINK、TOOL 类、CONTENT_RISK 一律丢
 *   - FILE 片段：v1 不读内容，只计数量
 *   - 排序按 inserted_at 不按 id：同文档四.2
 *   - 非 FINISHED 照收但标记：同文档四.4
 */

import JSZip from 'jszip';
import { DISTILL_BLOCK_WORDS } from './config.js';
import { ZipDirectory, utf8Decode, type RangeReader } from './zip-reader.js';

// ── 类型 ─────────────────────────────────────────────────────

export interface ParsedMessage {
  role: 'user' | 'assistant';
  text: string;
  /** ISO 时间字符串，原样保留 */
  at: string;
  /** 非 FINISHED 时的状态标记（如 "GENERATING"），正常为空 */
  unfinished: string;
}

export interface ParsedSession {
  id: string;
  title: string;
  pinned: boolean;
  firstAt: string;
  lastAt: string;
  /** 用户发言跨越的日期数——"跨天回来"是关系最硬的信号 */
  days: number;
  /** 计入蒸馏的正文字符数（THINK 不在内） */
  words: number;
  /** 有正文的用户消息数（轮数口径，D1） */
  userTurns: number;
  totalMessages: number;
  messages: ParsedMessage[];
  stats: {
    thinkCount: number;
    thinkWords: number;
    fileCount: number;
    unfinished: number;
    emptyMessages: number;
  };
}

export interface LoadResult {
  formatVersion: number | null;
  sessions: ParsedSession[];
  broken: { name: string; error: string }[];
  sessionCount: number;
}

// ── 主干回溯（四.1） ─────────────────────────────────────────

/**
 * 沿 current_message_id → parent_id 回溯到根，反转成时间顺序。
 * 回溯失败（字段缺失 / 断链 / 有环 / 只有一条）退回数组顺序——宁可退，不能崩。
 */
export function mainline(obj: Record<string, unknown>): Record<string, unknown>[] {
  const msgs = Array.isArray(obj.messages) ? (obj.messages as Record<string, unknown>[]) : [];
  if (!msgs.length) return msgs;

  const byId = new Map<unknown, Record<string, unknown>>();
  for (const m of msgs) {
    if (m && m.id != null) byId.set(m.id, m);
  }

  const chain: Record<string, unknown>[] = [];
  const seen = new Set<unknown>();
  let cur =
    obj.current_message_id != null ? byId.get(obj.current_message_id) : undefined;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.push(cur);
    cur = cur.parent_id != null ? byId.get(cur.parent_id) : undefined;
  }
  if (chain.length < 2) return msgs;
  return chain.reverse();
}

// ── 片段抽取（三、四.3） ─────────────────────────────────────

interface FragmentExtraction {
  text: string;
  thinkCount: number;
  thinkWords: number;
  fileCount: number;
}

/** 只取 REQUEST(USER) / RESPONSE(ASSISTANT) 的字符串正文 */
export function messageText(m: Record<string, unknown>): FragmentExtraction {
  const isUser = m.role === 'USER';
  const frags = Array.isArray(m.fragments) ? (m.fragments as Record<string, unknown>[]) : [];
  const parts: string[] = [];
  let thinkCount = 0;
  let thinkWords = 0;
  let fileCount = 0;

  for (const f of frags) {
    if (!f || typeof f !== 'object') continue;
    if (f.type === 'THINK') {
      thinkCount++;
      if (typeof f.content === 'string') thinkWords += f.content.length;
      continue;
    }
    if (f.type === 'FILE') {
      fileCount++;
      continue;
    }
    const isBody = (isUser && f.type === 'REQUEST') || (!isUser && f.type === 'RESPONSE');
    if (!isBody) continue;
    if (typeof f.content !== 'string' || !f.content.length) continue;
    parts.push(f.content);
  }

  return { text: parts.join('\n').trim(), thinkCount, thinkWords, fileCount };
}

// ── 单会话解析 ───────────────────────────────────────────────

export function parseSession(raw: string): ParsedSession {
  const obj = JSON.parse(raw) as Record<string, unknown>;
  const line = mainline(obj);
  const messages: ParsedMessage[] = [];
  const userDays = new Set<string>();

  let words = 0;
  let thinkCount = 0;
  let thinkWords = 0;
  let fileCount = 0;
  let unfinished = 0;
  let emptyMessages = 0;

  for (const m of line) {
    const { text, thinkCount: tc, thinkWords: tw, fileCount: fc } = messageText(m);
    thinkCount += tc;
    thinkWords += tw;
    fileCount += fc;

    const status = typeof m.status === 'string' ? m.status : '';
    const isUnfinished = status !== '' && status !== 'FINISHED';
    if (isUnfinished) unfinished++;

    if (!text) {
      emptyMessages++;
      continue;
    }

    const isUser = m.role === 'USER';
    const at = typeof m.inserted_at === 'string' ? m.inserted_at : '';
    messages.push({
      role: isUser ? 'user' : 'assistant',
      text,
      at,
      unfinished: isUnfinished ? status : '',
    });
    words += text.length;
    if (isUser && at) userDays.add(at.slice(0, 10));
  }

  const userTurns = messages.filter((m) => m.role === 'user').length;

  return {
    id: typeof obj.id === 'string' ? obj.id : '',
    title: typeof obj.title === 'string' ? obj.title : '',
    pinned: obj.pinned === true,
    firstAt: messages[0]?.at ?? (typeof obj.inserted_at === 'string' ? obj.inserted_at : ''),
    lastAt:
      typeof obj.updated_at === 'string'
        ? obj.updated_at
        : messages[messages.length - 1]?.at ?? '',
    days: userDays.size,
    words,
    userTurns,
    totalMessages: line.length,
    messages,
    stats: { thinkCount, thinkWords, fileCount, unfinished, emptyMessages },
  };
}

// ── 切块（主方案第五节：2 万字/块，按消息边界切） ────────────

export interface DistillChunk {
  messages: ParsedMessage[];
  words: number;
  firstAt: string;
  lastAt: string;
}

/**
 * 按消息边界切块：一条消息绝不劈成两半。
 * 语义：加上这条消息会超出 blockWords 就先开新块——块尽量 ≤ 上限；
 * 唯一例外是单条消息本身就超限（超长单条独立成块，无法劈开）。
 */
export function chunkMessages(
  messages: ParsedMessage[],
  blockWords: number = DISTILL_BLOCK_WORDS
): DistillChunk[] {
  const chunks: DistillChunk[] = [];
  let cur: DistillChunk | null = null;

  for (const m of messages) {
    const len = m.text.length;
    if (!cur || (cur.words > 0 && cur.words + len > blockWords)) {
      cur = { messages: [], words: 0, firstAt: m.at, lastAt: m.at };
      chunks.push(cur);
    }
    cur.messages.push(m);
    cur.words += len;
    if (m.at) cur.lastAt = m.at;
  }
  return chunks;
}

// ── 读整个包 ─────────────────────────────────────────────────

export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (true) {
        const i = cursor++;
        if (i >= items.length) return;
        // cursor 受 workers 数约束，i 必在范围内；noUncheckedIndexedAccess 需要 断言
        results[i] = await fn(items[i]!, i);
      }
    })
  );
  return results;
}

export interface LoadOptions {
  concurrency?: number;
  /** false 时丢掉 messages 数组（只要统计，省内存），统计口径不变 */
  withMessages?: boolean;
  /** 只解析这些会话 id（App 端两段式导入：粗扫拿统计 → 选中后再细读），配合 withMessages 用 */
  onlyIds?: Set<string>;
  /** 每解析完一个会话回调一次（App 端进度条用） */
  onProgress?: (done: number, total: number) => void;
}

/**
 * 共用入口：拿到"一批能逐个读出 JSON 文本的条目"后，解析、汇总、兜底。
 * loadSessions（整包字节）与 loadSessionsFromReader（流式分段）都走这里，口径只有一份。
 */
async function collectSessions(
  entries: { name: string; read: () => Promise<string> }[],
  formatVersion: number | null,
  opts: LoadOptions
): Promise<LoadResult> {
  const concurrency = opts.concurrency ?? 8;
  const withMessages = opts.withMessages !== false;

  const target = opts.onlyIds;
  const toParse = target
    ? entries.filter((e) => {
        // 文件名（去 .json）即会话 id（导出格式分析 三.1）
        const base = e.name.slice(e.name.lastIndexOf('/') + 1, -'.json'.length);
        return target.has(base);
      })
    : entries;

  let done = 0;
  const parsed = await mapLimit(toParse, concurrency, async (entry) => {
    try {
      return { session: parseSession(await entry.read()) };
    } catch (e) {
      return { error: String((e as Error).message || e) };
    } finally {
      done++;
      opts.onProgress?.(done, toParse.length);
    }
  });

  const sessions: ParsedSession[] = [];
  const broken: { name: string; error: string }[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const r = parsed[i]!;
    if ('error' in r && r.error !== undefined) {
      broken.push({ name: toParse[i]?.name ?? '', error: r.error });
    } else if ('session' in r && r.session) {
      if (!withMessages) {
        // JSON.stringify 会跳过 undefined 字段，等效于 delete，且类型合法
        r.session.messages = undefined as unknown as ParsedSession['messages'];
      }
      sessions.push(r.session);
    }
  }

  return { formatVersion, sessions, broken, sessionCount: entries.length };
}

/** 会话条目判定（两套读取器共用）：chat_sessions/ 下的 .json，附件目录 _files/ 整体跳过 */
function isChatSession(name: string): boolean {
  return (
    name.startsWith('chat_sessions/') &&
    name.endsWith('.json') &&
    !name.includes('_files/')
  );
}

async function readManifest(formatReader: { get: () => Promise<string> | null }): Promise<number | null> {
  try {
    const raw = await formatReader.get();
    if (raw == null) return null;
    const manifest = JSON.parse(raw) as Record<string, unknown>;
    return typeof manifest.export_format_version === 'number' ? manifest.export_format_version : null;
  } catch {
    return null; // 版本号读不出来不影响解析（四.7）
  }
}

/**
 * 读完整个导出包（输入是 ZIP 的字节数据）。
 * 适合小包与电脑 CLI；手机上 280MB 大包请用 loadSessionsFromReader（流式）。
 * 会话 JSON 损坏 → 进 broken 列表，不抛异常（导出格式分析 四.7：兜底报错不崩溃）。
 */
export async function loadSessions(
  zipData: Uint8Array | ArrayBuffer,
  opts: LoadOptions = {}
): Promise<LoadResult> {
  const zip = await JSZip.loadAsync(zipData);

  let formatVersion: number | null = null;
  const manifestEntry = zip.file('manifest.json');
  if (manifestEntry) {
    formatVersion = await readManifest({ get: () => manifestEntry.async('string') });
  }

  const entries: { name: string; read: () => Promise<string> }[] = [];
  zip.forEach((relPath, entry) => {
    if (entry.dir || !isChatSession(relPath)) return;
    entries.push({ name: relPath, read: () => entry.async('string') });
  });

  return collectSessions(entries, formatVersion, opts);
}

/**
 * 流式读取导出包（推荐入口）：不整包进内存，按 ZIP 目录逐条目解压。
 * 内存峰值 ≈ 单个会话 JSON，280MB 大包在手机上也能跑（2026-11-22 实测 400MB 堆上限被
 * 整包方案打爆，本函数因此而生）。reader 的构造见 zip-reader.ts 的 RangeReader。
 */
export async function loadSessionsFromReader(
  reader: RangeReader,
  opts: LoadOptions = {}
): Promise<LoadResult> {
  const dir = await ZipDirectory.open(reader);
  const names = dir.listNames();

  const formatVersion = names.includes('manifest.json')
    ? await readManifest({ get: async () => utf8Decode(await dir.readEntry('manifest.json')) })
    : null;

  const entries = names
    .filter(isChatSession)
    .map((name) => ({
      name,
      read: async () => utf8Decode(await dir.readEntry(name)),
    }));

  return collectSessions(entries, formatVersion, opts);
}
