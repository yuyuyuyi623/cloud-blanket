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
import { DISTILL_BLOCK_QUOTA_EARLY, DISTILL_BLOCK_QUOTA_MID, DISTILL_BLOCK_QUOTA_RECENT, DISTILL_BLOCK_WORDS } from './config.js';
import { ZipDirectory, utf8Decode, type RangeReader } from './zip-reader.js';
import {
  capAttachments,
  classifyAttachment,
  countAttachmentWords,
  decodeAttachmentText,
  isAttachmentTooLarge,
  isTextAttachmentName,
  parseAttachmentPath,
  type AttachmentDoc,
} from './attachment-scan.js';

// ── 类型 ─────────────────────────────────────────────────────

export interface ParsedMessage {
  role: 'user' | 'assistant';
  text: string;
  /** ISO 时间字符串，原样保留 */
  at: string;
  /** 非 FINISHED 时的状态标记（如 "GENERATING"），正常为空 */
  unfinished: string;
  /**
   * 这条消息带的附件引用（v1.0.4 附件进蒸馏，2026-11-27）：只留元数据，正文另读。
   * 只有 USER 消息会有；纯附件消息（无正文）也保留，text 为空串。
   */
  files?: ParsedFileRef[];
}

/** 附件引用：正文在 `chat_sessions/<id>_files/` 里，按 path 另读 */
export interface ParsedFileRef {
  /** 原始文件名（展示用） */
  name: string;
  /** 导出包内路径（可能为空，老包只给 export_path 的一部分） */
  path: string;
  /** 字节数（FILE 片段里有就给） */
  size?: number;
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
  files: ParsedFileRef[];
}

/** 只取 REQUEST(USER) / RESPONSE(ASSISTANT) 的字符串正文；FILE 片段只记引用不读内容 */
export function messageText(m: Record<string, unknown>): FragmentExtraction {
  const isUser = m.role === 'USER';
  const frags = Array.isArray(m.fragments) ? (m.fragments as Record<string, unknown>[]) : [];
  const parts: string[] = [];
  const files: ParsedFileRef[] = [];
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
      // 附件进蒸馏（2026-11-27）：FILE 片段带 file_name / export_path / file_size
      const name = typeof f.file_name === 'string' ? f.file_name : '';
      const path = typeof f.export_path === 'string' ? f.export_path : '';
      const size = typeof f.file_size === 'number' ? f.file_size : undefined;
      if (name || path) {
        files.push({ name: name || path.split('/').pop() || '附件', path, ...(size !== undefined ? { size } : {}) });
      }
      continue;
    }
    const isBody = (isUser && f.type === 'REQUEST') || (!isUser && f.type === 'RESPONSE');
    if (!isBody) continue;
    if (typeof f.content !== 'string' || !f.content.length) continue;
    parts.push(f.content);
  }

  return { text: parts.join('\n').trim(), thinkCount, thinkWords, fileCount, files };
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
    const { text, thinkCount: tc, thinkWords: tw, fileCount: fc, files } = messageText(m);
    thinkCount += tc;
    thinkWords += tw;
    fileCount += fc;

    const status = typeof m.status === 'string' ? m.status : '';
    const isUnfinished = status !== '' && status !== 'FINISHED';
    if (isUnfinished) unfinished++;

    // 纯附件消息（只有 FILE 没有正文）也保留：附件进蒸馏要它当锚点，不能当空消息丢（2026-11-27）
    if (!text && !files.length) {
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
      ...(files.length ? { files } : {}),
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

/**
 * 把一段消息按"恰好 parts 块"切开，切点只能在消息边界上（一条消息绝不劈成两半）。
 *
 * 做法：按字数等分算出理想切点，再在允许的索引区间里挑离理想切点最近的消息边界
 * （边界索引必须严格递增、且给后面的块留够消息）。确定性算法：同样输入必得同样输出。
 */
function splitByParts(messages: ParsedMessage[], parts: number): DistillChunk[] {
  const n = messages.length;
  const make = (from: number, to: number): DistillChunk => {
    const slice = messages.slice(from, to);
    return {
      messages: slice,
      words: slice.reduce((a, m) => a + m.text.length, 0),
      firstAt: slice[0]?.at ?? '',
      lastAt: slice[slice.length - 1]?.at ?? '',
    };
  };
  if (parts <= 1 || n <= parts) {
    return n === 0 ? [] : [make(0, n)];
  }
  const prefix: number[] = [0];
  for (const m of messages) prefix.push((prefix[prefix.length - 1] ?? 0) + m.text.length);
  const total = prefix[n] ?? 0;

  const bounds: number[] = [0];
  let prev = 0;
  for (let j = 1; j < parts; j += 1) {
    const ideal = (total * j) / parts;
    const min = prev + 1;
    const max = n - (parts - j);
    let best = min;
    for (let i = min; i <= max; i += 1) {
      if (Math.abs((prefix[i] ?? 0) - ideal) < Math.abs((prefix[best] ?? 0) - ideal)) best = i;
    }
    bounds.push(best);
    prev = best;
  }
  bounds.push(n);
  return bounds.slice(1).map((to, i) => make(bounds[i] ?? 0, to));
}

/**
 * 块配额按时间三段递增（A7-B，2026-11-25）：
 *   - 仍按 2 万字切出 total 块（总数与旧口径一致，成本不变）；
 *   - 但这 total 块按 10:13:18 分配给 早期/中期/近期 —— 早期块更大（粗），近期块更小（细）；
 *   - 首尾必留：第一块从最早一条消息开始，最后一块收在最新一条。
 *
 * 消息太少（<3 条）、块数太少（<3 块）时退回普通切块——配额在三段上分不出东西。
 */
export function chunkMessagesWithQuota(
  messages: ParsedMessage[],
  blockWords: number = DISTILL_BLOCK_WORDS,
  quota: readonly [number, number, number] = [
    DISTILL_BLOCK_QUOTA_EARLY,
    DISTILL_BLOCK_QUOTA_MID,
    DISTILL_BLOCK_QUOTA_RECENT,
  ]
): DistillChunk[] {
  const total = chunkMessages(messages, blockWords).length;
  if (messages.length < 3 || total < 3) return chunkMessages(messages, blockWords);

  // 时间三段：按累计字数在 1/3、2/3 处的消息边界切
  const thirds = splitByParts(messages, 3);
  if (thirds.length < 3) return chunkMessages(messages, blockWords);

  const weightSum = quota.reduce((a, b) => a + b, 0);
  const maxMessages = thirds.map((c) => c.messages.length);
  const counts = thirds.map((chunk, i) => {
    // 每段至少 1 块、至多"这段有几条消息"
    const want = Math.floor((total * (quota[i] ?? 1)) / weightSum);
    return Math.min(chunk.messages.length, Math.max(1, want));
  });
  // 余数给最近的一段（近期多留一块，符合"近期更重要"），其次中期、早期
  let remainder = total - counts.reduce((a, b) => a + b, 0);
  let guard = 0;
  while (remainder > 0 && guard < 1000) {
    for (const target of [2, 1, 0]) {
      if (remainder > 0 && (counts[target] ?? 0) < (maxMessages[target] ?? 0)) {
        counts[target] = (counts[target] ?? 0) + 1;
        remainder -= 1;
      }
    }
    guard += 1;
  }
  if (remainder > 0) return chunkMessages(messages, blockWords);

  return thirds.flatMap((chunk, i) => splitByParts(chunk.messages, counts[i] ?? 1));
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

// ── 附件读取（附件进蒸馏方案 2026-11-27） ─────────────────────

export interface AttachmentLoadResult {
  /** 读出来的文本附件（已按整包上限裁剪） */
  docs: AttachmentDoc[];
  /** 跳过的条目：太大 / 读不出来（确认页按需提示，不阻塞导入） */
  skipped: { path: string; reason: 'large' | 'error' }[];
}

/**
 * 读导出包里所有文本附件（`chat_sessions/<id>_files/*`）。
 *
 * 只认文本扩展名：导出包里 96% 的体积是图片/文档原件（281MB 里的 270MB），
 * 全读会把手机内存打爆；这里跳过一切二进制。
 * `sessionIds` 给了就只读这些会话的附件（细读阶段用），不给读全包（粗扫阶段用）。
 *
 * 顺序：目录清单顺序即 ZIP 里出现顺序，按会话各自计数当判类的 order 参考。
 */
export async function loadAttachmentsFromReader(
  reader: RangeReader,
  sessionIds?: Set<string>,
): Promise<AttachmentLoadResult> {
  const dir = await ZipDirectory.open(reader);
  const names = dir.listNames().filter((name) => {
    const parsed = parseAttachmentPath(name);
    if (!parsed || !isTextAttachmentName(parsed.name)) return false;
    return !sessionIds || sessionIds.has(parsed.sessionId);
  });

  const skipped: AttachmentLoadResult['skipped'] = [];
  const orderBySession = new Map<string, number>();
  const docs = await mapLimit(names, 4, async (path) => {
    const parsed = parseAttachmentPath(path);
    if (!parsed) return null;
    const info = dir.info(path);
    if (info && isAttachmentTooLarge(info.uncompressedSize)) {
      skipped.push({ path, reason: 'large' });
      return null;
    }
    let text = '';
    try {
      text = decodeAttachmentText(await dir.readEntry(path)).trim();
    } catch {
      skipped.push({ path, reason: 'error' });
      return null;
    }
    if (!text) return null;
    const order = orderBySession.get(parsed.sessionId) ?? 0;
    orderBySession.set(parsed.sessionId, order + 1);
    const words = countAttachmentWords(text);
    const doc: AttachmentDoc = {
      id: `${parsed.sessionId}::${parsed.name}`,
      sessionId: parsed.sessionId,
      name: parsed.name,
      path,
      text,
      words,
      tag: classifyAttachment(parsed.name, words, order),
      clipped: false,
    };
    return doc;
  });

  return { docs: capAttachments(docs.filter((doc): doc is AttachmentDoc => doc !== null)), skipped };
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
