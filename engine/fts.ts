/**
 * engine/fts.ts —— 本地全文检索（K11："零成本记得早年"的地基）
 *
 * 接口 SearchIndex 与具体实现分离：
 *   - InvertedIndex：纯 JS 倒排，零平台依赖，Node 与 App 都能跑（本文件）；
 *   - 将来若真机验证 FTS5 可用且更快，写 Fts5Index 实现同一接口，启动时探测切换。
 *
 * 分词：中文按双字组合（bigram），英文/数字按词。单字查询降级为扫描。
 * 评分：IDF × 词频，AND 语义（查询的每个词都必须命中）。
 */

import { SEARCH_MAX_CHARS, SEARCH_MAX_RESULTS } from './config.js';
import { buildTerms } from './query-rewrite.js';

// ── 接口 ─────────────────────────────────────────────────────

export interface SearchResult {
  /** 所属会话 id */
  sessionId: string;
  /** 会话内消息序号 */
  messageIndex: number;
  text: string;
  at: string;
  score: number;
}

export interface SearchIndex {
  /** 加入一条消息。docId = sessionId:messageIndex */
  add(sessionId: string, messageIndex: number, text: string, at: string): void;
  /** 删除整个会话（换导出包 / 用户删库时用） */
  removeSession(sessionId: string): void;
  /** 检索。AND 语义；按相关度排序；limit 默认 SEARCH_MAX_RESULTS */
  search(query: string, limit?: number): SearchResult[];
  /** OR 降级检索（AND 主路径空结果时用，阈值保零垃圾） */
  searchOr(terms: string[], limit?: number, options?: SearchOrOptions): SearchResult[];
  /** 词条文档频率（0 = 词表里没有）。内容词提取（最稀有词子集 AND）用 */
  dfOf(term: string): number;
  /** 索引规模（性能日志 / 设置页展示用） */
  stats(): { docs: number; terms: number };
}

// ── 分词 ─────────────────────────────────────────────────────

const CJK = /\p{Script=Han}/u;
const WORD = /[a-zA-Z0-9]/;

/**
 * 中文按 bigram 切（"晚安好梦" → 晚安/安好/好梦/梦），
 * 英文数字按连续词切并转小写，其余（标点空白）丢弃。
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const ch = text[i]!;
    if (CJK.test(ch)) {
      let j = i + 1;
      while (j < n && CJK.test(text[j]!)) j++;
      for (let k = i; k < j - 1; k++) tokens.push(text.slice(k, k + 2));
      if (j === i + 1) tokens.push(text.slice(i, i + 1)); // 孤立单字
      i = j;
    } else if (WORD.test(ch)) {
      let j = i + 1;
      while (j < n && WORD.test(text[j]!)) j++;
      tokens.push(text.slice(i, j).toLowerCase());
      i = j;
    } else {
      i++;
    }
  }
  return tokens;
}

// ── OR 降级检索 ──────────────────────────────────────────

/** OR 降级检索的阈值参数（bench 实测调参，见 fts-recall.bench） */
export interface SearchOrOptions {
  /** 最少命中的不同 term 数，低于此判为不相关，返回空（零垃圾阈值） */
  minMatch?: number;
  /** 最低累计分（BM25）；不传时按语料规模自适应（见 OR_MIN_SCORE_FACTOR） */
  minScore?: number;
  /** df 上限比例：出现在超过该比例文档里的 term 不参与 OR（模板噪声过滤，
   * 改写层纯函数无词频可用，只能在这层滤） */
  dfCapFrac?: number;
}

const OR_DEFAULTS = { minMatch: 2, dfCapFrac: 0.02 } as const;

/** BM25 参数（Lucene 常用值）：k1 控词频饱和，b 控长度归一化强度 */
const BM25_K1 = 1.2;
const BM25_B = 0.75;

/**
 * minScore 自适应系数：阈值 ≈ 1.8 × ln(1 + 语料条数)。
 * 依据（bench 实测，81.6 万字 / 1590 条）：固定 9 分时 C 组误召回 6/12；
 * 抬到 12~13.5 分后 C 组降到 1~2/12，B 组空结果率仍 23%（标准 <30%）；
 * 再抬到 17 分 B 组空结果率飙到 53%。分数随语料规模变化（idf = ln(1+N/df)），
 * 所以写死绝对值只在这份语料上对，这里改成按规模缩放。
 */
const OR_MIN_SCORE_FACTOR = 1.8;

/** 语料小于此条数时分数阈值无统计意义，只靠 minMatch 兜底 */
const OR_MIN_SCORE_MIN_DOCS = 50;

// ── 纯 JS 倒排实现 ───────────────────────────────────────────

interface DocInfo {
  sessionId: string;
  messageIndex: number;
  text: string;
  at: string;
}

interface Posting {
  /** docId → 该词在这条消息里出现的次数 */
  counts: Map<string, number>;
}

export class InvertedIndex implements SearchIndex {
  /** term → postings */
  private index = new Map<string, Posting>();
  /** docId → 文档信息 */
  private docs = new Map<string, DocInfo>();
  /** 全部文档的字数合计（BM25 平均文档长度用，removeSession 时同步扣减） */
  private totalChars = 0;

  add(sessionId: string, messageIndex: number, text: string, at: string): void {
    const docId = `${sessionId}:${messageIndex}`;
    if (this.docs.has(docId)) return; // 重复 add 忽略（幂等）
    if (!text) return;
    this.docs.set(docId, { sessionId, messageIndex, text, at });
    this.totalChars += text.length;

    const counts = new Map<string, number>();
    for (const term of tokenize(text)) {
      counts.set(term, (counts.get(term) ?? 0) + 1);
    }
    for (const [term, tf] of counts) {
      let posting = this.index.get(term);
      if (!posting) {
        posting = { counts: new Map() };
        this.index.set(term, posting);
      }
      posting.counts.set(docId, tf);
    }
  }

  removeSession(sessionId: string): void {
    const prefix = `${sessionId}:`;
    for (const [term, posting] of this.index) {
      for (const docId of posting.counts.keys()) {
        if (docId.startsWith(prefix)) posting.counts.delete(docId);
      }
      if (!posting.counts.size) this.index.delete(term);
    }
    for (const docId of this.docs.keys()) {
      if (docId.startsWith(prefix)) {
        this.totalChars -= this.docs.get(docId)!.text.length;
        this.docs.delete(docId);
      }
    }
  }

  search(query: string, limit: number = SEARCH_MAX_RESULTS): SearchResult[] {
    const tokens = [...new Set(tokenize(query))];
    if (!tokens.length) return [];

    // 单字中文词：bigram 索引里没有它的词条，不能参与 AND 求交，
    // 改为对候选文本做 includes 过滤
    const charTokens = tokens.filter((t) => t.length === 1 && CJK.test(t));
    const termTokens = tokens.filter((t) => !(t.length === 1 && CJK.test(t)));

    // 全是单字 → 降级线性扫描
    if (!termTokens.length) return this.scanSearch(charTokens, limit);

    // AND：取每个词的 posting，从最短的开始求交集
    const postings: Posting[] = [];
    for (const t of termTokens) {
      const p = this.index.get(t);
      if (!p || !p.counts.size) return []; // 任一词全库无命中 → 空结果
      postings.push(p);
    }
    postings.sort((a, b) => a.counts.size - b.counts.size);

    const docCount = this.docs.size;
    let candidates: Map<string, number> | null = null; // docId → min tf
    for (const p of postings) {
      if (!candidates) {
        candidates = new Map(p.counts);
        continue;
      }
      for (const docId of [...candidates.keys()]) {
        const tf = p.counts.get(docId);
        if (tf === undefined) candidates.delete(docId);
        else candidates.set(docId, Math.min(candidates.get(docId)!, tf));
      }
      if (!candidates.size) return [];
    }
    if (!candidates || !candidates.size) return [];

    // 评分：Σ idf × tf；单字词做文本过滤
    const scored: SearchResult[] = [];
    for (const [docId, tf] of candidates) {
      const info = this.docs.get(docId)!;
      if (charTokens.length && !charTokens.every((t) => info.text.includes(t))) continue;
      let score = 0;
      for (const t of termTokens) {
        const p = this.index.get(t);
        const idf = p ? Math.log(1 + docCount / p.counts.size) : 0;
        score += idf * tf;
      }
      scored.push({
        sessionId: info.sessionId,
        messageIndex: info.messageIndex,
        text: info.text,
        at: info.at,
        score,
      });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  /** 单字查询降级：线性扫描（消息量 1 万级，毫秒级可接受） */
  private scanSearch(tokens: string[], limit: number): SearchResult[] {
    const out: SearchResult[] = [];
    for (const [, info] of this.docs) {
      if (tokens.every((t) => info.text.includes(t))) {
        out.push({
          sessionId: info.sessionId,
          messageIndex: info.messageIndex,
          text: info.text,
          at: info.at,
          score: 1,
        });
        if (out.length >= limit * 4) break;
      }
    }
    return out.slice(0, limit);
  }

  /**
   * OR 降级检索（AND 主路径空结果时用）：任一 term 命中即入候选，
   * 按 BM25 评分；命中不同 term 数 < minMatch 或总分 < minScore 的直接返回空，
   * 保留 AND 时代的零垃圾特性。单字 term 与主路径同规则（文本 includes 过滤）。
   */
  searchOr(terms: string[], limit: number = SEARCH_MAX_RESULTS, options?: SearchOrOptions): SearchResult[] {
    const unique = [...new Set(terms)];
    if (!unique.length) return [];
    const docCount = this.docs.size;
    if (!docCount) return [];
    const minMatch = options?.minMatch ?? OR_DEFAULTS.minMatch;
    const dfCapFrac = options?.dfCapFrac ?? OR_DEFAULTS.dfCapFrac;
    // 小语料下 df 比例同样无意义（4 条语料 2% = 0.08，任何词都会被当噪声）；
    // 此时不做高频过滤，只靠 minMatch / minScore 兜底
    const dfCap =
      docCount < OR_MIN_SCORE_MIN_DOCS ? Infinity : Math.max(2, docCount * dfCapFrac);
    const avgLen = this.totalChars / docCount || 1;
    // 分数阈值随语料规模自适应；小语料下统计无意义，只靠 minMatch
    const minScore =
      options?.minScore ??
      (docCount < OR_MIN_SCORE_MIN_DOCS ? 0 : OR_MIN_SCORE_FACTOR * Math.log(1 + docCount));

    /** docId → 累计分与命中 term 数 */
    const acc = new Map<string, { score: number; matched: Set<string> }>();
    for (const term of unique) {
      const isSingleChar = term.length === 1 && CJK.test(term);
      // 单字不参与 OR：buildTerms 留下的单字是句首字（"你/还"），与语义无关，
      // 却会把"正文必须含这些字"当成硬条件（实测吃掉 5/40 条口语查询）；
      // 单字的用处是纯单字短查询，那条路由 search() 的线性扫描兜底。
      if (isSingleChar) continue;
      const p = this.index.get(term);
      if (!p || p.counts.size > dfCap) continue; // 高频 term 不参与 OR（噪声）
      const idf = Math.log(1 + docCount / p.counts.size);
      for (const [docId, tf] of p.counts) {
        // BM25：k1 让词频饱和，b 按文档长度归一化。
        // 变这样改的实证（bench，81.6 万字）：原先 Σidf×ln(tf) 下，C 组 6 条误召回
        // 全是 1000~1500 字的超长文档——靠"词多所以碰巧命中多"堆出 11~23 分；
        // 长度归一化后同样的文档只剩 7.8~14.1 分，与真命中的 13~33 分分开。
        const dl = this.docs.get(docId)!.text.length;
        const norm = tf + BM25_K1 * (1 - BM25_B + (BM25_B * dl) / avgLen);
        const weight = idf * ((tf * (BM25_K1 + 1)) / norm);
        const entry = acc.get(docId);
        if (entry) {
          entry.score += weight;
          entry.matched.add(term);
        } else {
          acc.set(docId, { score: weight, matched: new Set([term]) });
        }
      }
    }

    const scored: SearchResult[] = [];
    for (const [docId, { score, matched }] of acc) {
      if (matched.size < minMatch || score < minScore) continue;
      const info = this.docs.get(docId)!;
      scored.push({
        sessionId: info.sessionId,
        messageIndex: info.messageIndex,
        text: info.text,
        at: info.at,
        score,
      });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  dfOf(term: string): number {
    return this.index.get(term)?.counts.size ?? 0;
  }

  stats(): { docs: number; terms: number } {
    return { docs: this.docs.size, terms: this.index.size };
  }
}

/**
 * 把检索结果截进预算（R2：最多 8 条 / 1200 字，超出按相关度截）。
 * 返回拼好的文本块（注入动态段用），以及实际用到的结果。
 */
export function budgetSearchResults(
  results: SearchResult[],
  maxChars: number = SEARCH_MAX_CHARS
): { text: string; used: SearchResult[] } {
  const used: SearchResult[] = [];
  const lines: string[] = [];
  let chars = 0;
  for (const r of results) {
    const trimmed = r.text.length > 200 ? `${r.text.slice(0, 200)}…` : r.text;
    const line = `- ${trimmed}`;
    if (chars + line.length > maxChars) break;
    chars += line.length;
    lines.push(line);
    used.push(r);
  }
  return { text: lines.join('\n'), used };
}

/**
 * 统一检索管线（FTS 接线入口，任务 4）：
 * 用户消息 → buildTerms 改写（停用词/n-gram/压单字） → 三路降级：
 *   1) 全词 AND（关键词式问法命中）；
 *   2) 最稀有词子集 AND（口语长句：模板噪声词 df 高被排除，只要求 2~3 个
 *      最稀有的 bigram/英文词共现 —— 零垃圾的主要防线）；
 *   3) OR+阈值（兜底召回，df 上限 + minMatch/minScore 三重阈值）。
 * 返回结果与命中模式（mode 供动态段话术/日志区分）。
 */
export function searchMemory(
  index: SearchIndex,
  userText: string,
  limit: number = SEARCH_MAX_RESULTS,
): { results: SearchResult[]; mode: 'and' | 'rare' | 'or' | 'empty' } {
  const terms = buildTerms(userText);
  if (!terms.length) return { results: [], mode: 'empty' };
  // 索引只收 bigram/英文词；改写层产出的 trigram 与单字查不到词条，
  // 混进 AND 会让主路径永远空转（实测：含 3 字以上中文的句子 100% 落到降级路径，
  // AND 只剩 2-gram 以内的短查询能命中）。这里只拿索引里真实存在的 term 做 AND。
  const known = terms.filter((t) => index.dfOf(t) > 0);
  // 单字是句首字，语义无关，不进 AND；整个查询就是单字时由 search() 的扫描兜底
  const nonSingle = known.filter((t) => !(t.length === 1 && CJK.test(t)));
  const and = nonSingle.length
    ? index.search(nonSingle.join(' '), limit)
    : index.search(terms.join(' '), limit);
  if (and.length) return { results: and, mode: 'and' };

  // 稀有词子集 AND：取最稀有的 3 个（只认 bigram/英文词，trigram 多为模板噪声）
  const docCount = index.stats().docs;
  // 小语料下 docCount*0.05 会退化成 0.x（3 条语料 = 0.15），任何词都算不上"稀有"；
  // 给下限 2，让刚导入几十条消息的用户也能走这条路
  const rareDfCap = Math.max(2, docCount * 0.05);
  const rare = terms
    .filter((t) => (t.length === 2 && CJK.test(t)) || /^[a-z0-9_]+$/.test(t))
    .map((t) => ({ t, df: index.dfOf(t) }))
    .filter((x) => x.df > 0 && x.df <= rareDfCap)
    .sort((a, b) => a.df - b.df)
    .slice(0, 3)
    .map((x) => x.t);
  if (rare.length >= 2) {
    const subset = index.search(rare.join(' '), limit);
    if (subset.length) return { results: subset, mode: 'rare' };
  }

  const or = index.searchOr(terms, limit);
  return or.length ? { results: or, mode: 'or' } : { results: [], mode: 'empty' };
}
