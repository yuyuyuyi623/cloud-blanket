/**
 * engine/query-rewrite.ts —— 查询改写层（平移自柔光 memory.mjs，33 天线上实证）
 *
 * 来源与依据：docs/FTS召回实测报告-2026-11-23.md §五。
 * 柔光的 buildQuery/buildSearchText 原样平移（纯函数、零依赖），唯一改动：
 * 16 个 term 名额里压单字名额（最多 2 个），2-gram/3-gram 优先——
 * 柔光侧实测单字霸名额是最大噪声源。
 *
 * 用法（FTS 接线，任务 4）：用户消息 → buildTerms() → index.search（AND 主路径）
 * → 空结果时 index.searchOr（OR+阈值降级，保留零垃圾特性）。
 */

/** 口语高频虚词：精确匹配 term 时剔除（柔光原表） */
const STOP_TERMS = new Set([
  '这个', '那个', '什么', '怎么', '可以', '觉得', '还是', '就是', '没有',
  '因为', '所以', '然后', '但是', '如果', '真的', '知道', '一个', '我们',
  '你们', '他们', '自己', '有点', '不是', '已经', '可能', '应该', '东西',
  '时候', '感觉', '这样', '那样', '一下', '现在', '今天', '刚才', '你还'
]);

/** 查询改写的 term 总名额。
 * 实证（bench B 组，2026-11-23）：口语长句的模板 n-gram 会把 16 名额占满，
 * 内容词（真正的检索目标）被截掉导致 OR 全空；扩到 24 且 bigram 优先后修复。
 * 偏离柔光口径 16 的原因记录于此。 */
export const QUERY_TERM_LIMIT = 24;

/** 单字 term 的名额上限（本侧改动：柔光无此限制，单字曾霸满名额） */
export const QUERY_SINGLE_CHAR_LIMIT = 2;

/**
 * 柔光原样：文本 → FTS 检索串。
 * 中文按 1/2/3-gram 全铺、英文数字按连续词，空格连接（去重后）。
 */
export function buildSearchText(text: string): string {
  const source = String(text ?? '').toLocaleLowerCase('zh-CN');
  const terms = new Set<string>();
  for (const match of source.matchAll(/[\p{Script=Han}]+/gu)) {
    const sequence = match[0];
    for (const character of sequence) {
      terms.add(character);
    }
    for (let index = 0; index < sequence.length - 1; index += 1) {
      terms.add(sequence.slice(index, index + 2));
    }
    for (let index = 0; index < sequence.length - 2; index += 1) {
      terms.add(sequence.slice(index, index + 3));
    }
  }
  for (const match of source.matchAll(/[a-z0-9_]{2,}/g)) {
    terms.add(match[0]);
  }
  return [...terms].join(' ');
}

/**
 * 改写层主入口：文本 → 检索 term 列表（去停用词、名额限量、压单字）。
 * 排序：bigram → 英文词 → trigram → 单字（名额 2）。
 * bigram 优先是检索主力的实证选择；trigram 多为模板噪声排后；
 * 高频模板词的过滤由检索层 searchOr 的 df 上限完成（纯函数层无词频可用）。
 */
export function buildTerms(text: string): string[] {
  const all = buildSearchText(text)
    .split(/\s+/)
    .filter((term) => term && !STOP_TERMS.has(term));
  const bigrams: string[] = [];
  const trigrams: string[] = [];
  const words: string[] = [];
  const singles: string[] = [];
  for (const term of all) {
    if (term.length === 1) singles.push(term);
    else if (term.length === 2) bigrams.push(term);
    else if (/^[a-z0-9_]+$/.test(term)) words.push(term);
    else trigrams.push(term);
  }
  const keptSingles = singles.slice(0, QUERY_SINGLE_CHAR_LIMIT);
  return [...bigrams, ...words, ...trigrams, ...keptSingles].slice(0, QUERY_TERM_LIMIT);
}

/** 柔光原样（名额口径同步本侧改动）：term 列表 → FTS5 OR 语法检索串 */
export function buildQuery(text: string): string {
  return buildTerms(text)
    .map((term) => `"${term.replaceAll('"', '')}"`)
    .join(' OR ');
}
