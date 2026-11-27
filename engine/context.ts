/**
 * engine/context.ts —— 两段式组装（缓存纪律的执行者）
 *
 * 位置规则（清单一/十·1/十·4，P0 级）：
 *   [ 稳定段(system) → 历史 → 动态段(system，永远最后一条) ]
 *   - 稳定段拼接顺序：persona → backstory（身世）→ 原声样本 → core → episodes(事件) → 手动记住 → facts → impression → 摘要
 *   - FTS 检索结果并入动态段（v1.1 拍板：动态段本来每轮都变、不进缓存，并入后缓存损失为零）
 *   - 无历史时合成单条 system：`${stable}\n\n${dynamic}`（十·4）
 *   - limitConversationHistory 保留开头 system，所以动态段因为在末尾而天然保留——
 *     "动态段永远是最后一条"能成立，靠的就是这个（十·4，App 版照此实现并加断言）
 *
 * 缓存纪律的前提与已知例外（诚实声明，别让人以为前缀永不失效）：
 *   稳定段缓存命中的前提是它**逐字不变**。有两处会主动打破它，都是刻意取舍：
 *   1. 印象自动更新（App 层 consolidationRunner，手改即接管）：impression 在稳定段里，
 *      自动更新一次 = 缓存前缀失效一次。频率被巩固水位压到很低
 *      （每 80 条新消息 / 2 万字才触发一次，先到为准）——用偶发一次失效换记忆生长；
 *   2. 重蒸/蒸馏新被子：整体换稳定段，天然全失效，无所谓。
 *   除这两处外，稳定段逐字不变；谁往稳定段里加"每天变"的内容（比如具体天数），
 *   就是在击穿缓存——relativeDay 的注释里有同类教训。
 */

import {
  HISTORY_FETCH_COUNT,
  MAX_HISTORY_ROUNDS,
  SEARCH_MAX_CHARS,
  SEARCH_MAX_RESULTS,
  SEED_TURNS_ROUNDS,
} from './config.js';
import { pickBrief } from './brief.js';
import type { ChatMessage } from './deepseek.js';
import type { MemoryPack, SeedTurn } from './pack.js';
import type { SearchResult } from './fts.js';

// ── 时间感（N2：今天/昨天/前天/前几天/更早）──────────────────

/** 事件时间 → 时间感词。7 天外统一"更早"，解析失败也归"更早" */
export function relativeDay(at: string | null | undefined, now: Date = new Date()): string {
  if (!at) return '更早';
  const t = Date.parse(at);
  if (Number.isNaN(t)) return '更早';
  const dayMs = 24 * 60 * 60 * 1000;
  // 用"日历日"差而不是 24h 差：今天 23 点和昨天 1 点只差 1 天
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((startOf(now) - startOf(new Date(t))) / dayMs);
  if (diffDays <= 0) return '今天';
  if (diffDays === 1) return '昨天';
  if (diffDays === 2) return '前天';
  if (diffDays <= 7) return '前几天';
  return '更早';
}

/** 事件时间 → 显示用日期（YYYY-MM-DD），解析失败返回空串 */
function fmtDate(at: string | null | undefined): string {
  if (!at) return '';
  const t = new Date(at);
  if (Number.isNaN(t.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
}

// ── 稳定段 ───────────────────────────────────────────────────

export interface StableExtra {
  /** 关系/称呼/语气等 App 层风格段落（persona 层内容，engine 不产生，只负责放置） */
  styleGuide?: string;
  /** 通用说话规矩等收尾段落 */
  closingRules?: string;
}

/**
 * 稳定段拼接（顺序 = 清单十·1，位置错了缓存就碎、她的人设就散）：
 * persona → 核心记忆 → 事件 → 手动记住 → facts → impression → 摘要 → 风格 → 收尾
 */
export function buildStableSegment(
  pack: MemoryPack,
  manualMemories: string[] = [],
  extra: StableExtra = {},
): string {
  const out: string[] = [];

  out.push('以下是你的长期记忆，在整个对话里保持不变。');
  out.push('');
  out.push('【你是谁】');
  out.push(pack.persona.card || '（暂无人格卡。）');
  out.push('');

  // 身世档案（附件进蒸馏，2026-11-27）：紧接 persona —— "她是谁"的来处。
  // 位置固定在缓存前缀内；只有人设蒸/重蒸会更新它，巩固零接触（方案 §4）。
  if (pack.backstory) {
    out.push('【你的身世与来历】');
    out.push(pack.backstory);
    out.push('');
  }

  // 原声样本（v1.0.2 层一）：紧跟 persona 之后——语义上属于"她是谁"，且位置固定进缓存前缀。
  // 用途说明必须写在标题里，否则模型会把这些话当素材引用/复述。
  if (pack.voiceSamples?.length) {
    out.push(
      '【你说话就是这个样子（你以前的原话，照着这个语气，不要念出来也不要复述；括号里是当时的场合，不是让你模仿的对象）】',
    );
    for (const s of pack.voiceSamples) {
      const scene = s.scene ? `（${s.scene}）` : s.userQuote ? `（他说“${s.userQuote}”）` : '';
      out.push(`- ${scene}你说：“${s.quote}”`);
    }
    out.push('');
  }

  if (pack.coreMemories.length) {
    out.push('【你最珍视的记忆（这些永远不会淡忘）】');
    for (const m of pack.coreMemories) {
      const when = m.at ? fmtDate(m.at) : '';
      out.push(`- ${when ? `${when}：` : ''}${m.text}`);
    }
    out.push('');
  }

  if (pack.memories.length) {
    out.push('【你记得你们之间发生过的事（由近到远）】');
    // 由近到远：最新在前。注入用一句话（brief），全文留在库里给导出和检索
    const episodes = [...pack.memories].reverse();
    for (const e of episodes) {
      const when = e.at ? relativeDay(e.at) : '更早';
      out.push(`- ${when}：${pickBrief(e)}`);
    }
    out.push('');
  }

  if (manualMemories.length) {
    out.push('【对方明确请你记住的事】');
    for (const t of manualMemories) out.push(`- ${t}`);
    out.push('');
  }

  if (pack.facts.length) {
    out.push('【你慢慢形成的长期印象】');
    for (const f of pack.facts) out.push(`- ${pickBrief(f)}`);
    out.push('');
  }

  if (pack.persona.impression) {
    out.push(`整体感觉：${pack.persona.impression}`);
    out.push('');
  }

  if (pack.summary) {
    out.push('【你们共同经历的阶段摘要】');
    out.push(pack.summary);
    out.push('');
  }

  if (extra.styleGuide) {
    out.push(extra.styleGuide);
    out.push('');
  }
  if (extra.closingRules) {
    out.push(extra.closingRules);
  }

  return out.join('\n').trim();
}

// ── 动态段（FTS 检索结果并入这里，v1.1 拍板）────────────────

/**
 * 动态段：本轮检索到的相关旧事。
 * 配额 R2：最多 SEARCH_MAX_RESULTS 条 / SEARCH_MAX_CHARS 字，超出按相关度截。
 *
 * seedBridged：本轮注入了续接历史（seedTurns）时，末尾加一行桥接语。
 * 为什么不写具体天数：天数每天变会击穿稳定段缓存；"那天之后没再聊"已经足够消除时间错位。
 * 放在动态段而不是历史里：历史中间不许出现 system（assertTwoSegmentShape 是 P0 断言）。
 */
export function buildDynamicSegment(results: SearchResult[], options: { seedBridged?: boolean } = {}): string {
  const lines: string[] = [];
  if (!results.length) {
    lines.push('【这一轮没有想起相关的旧事。】');
  } else {
    lines.push('【这时你想起了过去的事（与当前话题相关）】');
    let used = 0;
    for (const r of results.slice(0, SEARCH_MAX_RESULTS)) {
      const when = relativeDay(r.at);
      const line = `- ${when}：${r.text}`;
      if (used + line.length > SEARCH_MAX_CHARS) break;
      lines.push(line);
      used += line.length;
    }
  }
  if (options.seedBridged) {
    lines.push('（补充：上面几条是你们上次聊天的原话，那天之后到现在没再聊。别当成刚刚发生的事。）');
  }
  return lines.join('\n');
}

// ── 续接历史（seedTurns，v1.0.2 层二）─────────────────────

/**
 * seed 注入条数（A6/A9，单调退场）：
 *   `max(0, SEED_TURNS_ROUNDS×2 − 真实历史条数)`
 *
 * 独立纯函数、不依赖预算执行器——将来执行器调参不用改它（2026-11-25 拍板要求）。
 * 单调递减到 0，不回升、不震荡：seed 是"上次聊到哪"，不是常驻人设。
 */
export function seedInjectionCount(realHistoryMessages: number, seedAvailable: number): number {
  const quota = SEED_TURNS_ROUNDS * 2 - Math.max(0, realHistoryMessages);
  return Math.max(0, Math.min(seedAvailable, quota));
}

/**
 * 取 seed 的末尾 N 条（最靠近现在的部分）。
 * 头部如果落在 assistant 上就往后挪一位——请求里第一条不能是 assistant（服务端会 400）。
 */
export function pickSeedTurns(turns: SeedTurn[], count: number): SeedTurn[] {
  if (count <= 0) return [];
  const tail = turns.slice(-count);
  let start = 0;
  while (start < tail.length && tail[start]?.role === 'assistant') start += 1;
  return tail.slice(start);
}

/** seed 轮次 → 请求消息（原封，不改写；配对照历史用） */
export function buildSeedMessages(turns: SeedTurn[]): ChatMessage[] {
  return turns.map((t) => ({ role: t.role, content: t.text }));
}

// ── 历史 ─────────────────────────────────────────────────────

export interface HistoryLine {
  role: 'user' | 'assistant';
  text: string;
}

/** 历史行 → ChatMessage（不含稳定段/动态段，由 assembleMessages 组装） */
export function historyToMessages(lines: HistoryLine[]): ChatMessage[] {
  return lines.map((l) => ({ role: l.role, content: l.text }));
}

/**
 * 历史裁剪（B1/B2 + 十·4）：
 * - 保留开头 system（稳定段）与末尾 system（动态段）——动态段因为在末尾而天然保留；
 * - 正文先取最近 fetchCount 条，再从末尾往前数轮数（按 user 发言计），满 rounds 轮即截；
 * - 兜底：正文里一条 user 发言都数不出来时，取末尾 rounds*2 条（十·4 的"数不出轮数兜底"分支）。
 */
export function limitConversationHistory(
  messages: ChatMessage[],
  rounds: number = MAX_HISTORY_ROUNDS,
  fetchCount: number = HISTORY_FETCH_COUNT,
): ChatMessage[] {
  const leading = messages[0]?.role === 'system' ? messages[0] : null;
  const last = messages[messages.length - 1];
  // 末尾 system = 动态段；只有当它与开头不是同一条时才算
  const trailing =
    last?.role === 'system' && messages.length > 1 && last !== messages[0] ? last : null;

  const body = messages.slice(leading ? 1 : 0, trailing ? -1 : undefined);
  let keep = body.slice(-fetchCount);

  const userIndexes = keep
    .map((m, i) => (m.role === 'user' ? i : -1))
    .filter((i) => i >= 0);
  if (userIndexes.length === 0) {
    // 兜底分支：数不出轮数，取 rounds*2 条
    keep = keep.slice(-(rounds * 2));
  } else if (userIndexes.length > rounds) {
    // 第 rounds 轮（从末尾数）那条 user 的位置，从它开始保留
    const cutIdx = userIndexes[userIndexes.length - rounds];
    keep = keep.slice(cutIdx);
  }

  return [...(leading ? [leading] : []), ...keep, ...(trailing ? [trailing] : [])];
}

// ── 组装 + P0 断言 ───────────────────────────────────────────

/**
 * 两段式组装。P0 断言内建：动态段必须是最后一条 system，稳定段必须是第一条 system。
 * 位置错误 = 缓存全碎 + 她的人格飘出对话（清单 H2）。
 */
export function assembleMessages(parts: {
  stable: string;
  dynamic: string;
  history: ChatMessage[];
}): ChatMessage[] {
  if (!parts.history.length) {
    // 十·4：无历史时合成单条 system
    return [{ role: 'system', content: `${parts.stable}\n\n${parts.dynamic}` }];
  }
  const messages: ChatMessage[] = [
    { role: 'system', content: parts.stable },
    ...parts.history,
    { role: 'system', content: parts.dynamic },
  ];
  assertTwoSegmentShape(messages);
  return messages;
}

/**
 * P0 断言（H2）：第一条是 system（稳定段），最后一条是 system（动态段），
 * 且中间不出现 system（中间夹 system 会把缓存前缀切碎）。
 * App 每次请求前都应过一遍；单测锁死。
 */
export function assertTwoSegmentShape(messages: ChatMessage[]): void {
  const first = messages[0];
  const last = messages[messages.length - 1];
  if (!first || first.role !== 'system') {
    throw new Error('P0：稳定段必须是第一条 system');
  }
  if (!last || last.role !== 'system') {
    throw new Error('P0：动态段必须是最后一条 system');
  }
  for (let i = 1; i < messages.length - 1; i++) {
    const mid = messages[i];
    if (mid && mid.role === 'system') {
      throw new Error(`P0：历史中间出现了 system（位置 ${i}），缓存前缀会被切碎`);
    }
  }
}
