/**
 * engine/pack.ts —— 记忆包 v1：唯一结构入口
 *
 * 开放格式（主方案第六节 [v1.1]）：任何客户端都可以读写；未知字段宽容忽略。
 * normalize 的每个数字都来自 engine/config.ts，出处见该文件注释。
 *
 * 结构对应清单第九节"同构清单"：蒸馏产出与运行时整合产出填同一套结构。
 */

import {
  CORE_MEMORY_CHARS,
  CORE_MEMORY_LIMIT,
  EPISODES_CHARS,
  EPISODES_LIMIT,
  EPISODES_PINNED_EARLIEST,
  EPISODE_BANDS,
  FACTS_CHARS,
  FACTS_LIMIT,
  IMPRESSION_CHARS,
  PERSONA_MAX_CHARS,
  SAMPLES_LIMIT,
  SAMPLES_MAX_CHARS,
  SAMPLES_QUOTE_CHARS,
  SAMPLES_USER_QUOTE_CHARS,
  SUMMARY_MAX_CHARS,
  TEXT_OVERFLOW_RATIO,
} from './config.js';
import { softClip } from './brief.js';

// ── 类型 ─────────────────────────────────────────────────────

/**
 * 原声样本（v1.0.2 层一，A5）：配对语境 + 她的原话。
 *
 * 为什么配对、但不存完整对话对：完整多轮会把 token 翻倍，还会让模型连对方的语气一起模仿；
 * 单句对方原话（≤30 字）只提供真实场合。配对是为了语境，不是为了模仿对方。
 * 孤立句（找不到上文）直接不选，宁缺毋滥。
 *
 * 红线：quote/userQuote 必须是**原始导出包里的原文**（空白归一后命中即可，落库存原文那份）；
 * 被子对话不补样本（自我回声/近亲繁殖）。
 */
export interface VoiceSample {
  /** 对方那句话，≤ SAMPLES_USER_QUOTE_CHARS 字，原话截短（允许脱敏替换） */
  userQuote?: string;
  /** 她的原话，≤ SAMPLES_QUOTE_CHARS 字，一字不改（只允许脱敏替换） */
  quote: string;
  /** 第三人称场合短语（≤30 字），确认页展示用 */
  scene?: string;
  /** 原料里的时间，可空 */
  at?: string | null;
}

/** 核心记忆（E1/E4）：最多 5 条、永不淘汰、带时间感 */
export interface CoreMemory {
  text: string;
  /** 事件时间，可空。渲染"那一次/去年冬天"的来源 */
  at: string | null;
}

/** 事件层（N1）：具体发生过的事；append-only，只增不删不改（forget 已在 v1.0.2 删除） */export interface MemoryEpisode {
  text: string;
  at: string | null;
  /**
   * 注入用短句（≤40 字目标）：模型蒸馏时自己写的一句话。
   * 有它就注入它，没有才回退裁 text——见 engine/brief.ts。
   * 导出/检索仍用 text（细节留着给人读）。
   */
  brief?: string;
}

/** 事实（D1/D2）：合并去重、上限 30、不是 FIFO */
export interface Fact {
  text: string;
  addedAt?: string;
  /** D2：蒸馏时分开抽，落库合并；运行时组装不分 */
  kind?: 'user' | 'relationship';
  /** 注入用短句，同 MemoryEpisode.brief */
  brief?: string;
}

export interface DiaryEntry {
  date: string;
  text: string;
}

export interface Persona {
  name: string;
  card: string;
  /** 整体印象一句（十·2）：渲染"整体感觉：…"，确认页可改可清空 */
  impression?: string;
}

/** 记忆包 v1 */
export interface MemoryPack {
  version: 1;
  persona: Persona;
  coreMemories: CoreMemory[];
  /** 事件层：pack v1 新增（2026-11-22 补漏），蒸馏必须产出 */
  memories: MemoryEpisode[];
  facts: Fact[];
  summary: string;
  diary: DiaryEntry[];
  /**
   * 原声样本（v1.0.2 层一，A5）：**冻结区**——巩固不碰，重蒸才更新。
   * 唯一合法来源是原始导出包里的 assistant 消息；被子对话不补样本（红线，见方案 §③）。
   */
  voiceSamples?: VoiceSample[];
}

// ── 内部工具 ─────────────────────────────────────────────────

/** 合法时间字符串原样保留，非法/空一律 null（十·3：at 非合法时间则置 null） */
function normalizeAt(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  if (!t) return null;
  return Number.isNaN(new Date(t).getTime()) ? null : t;
}

function extractText(item: unknown): string {
  if (typeof item === 'string') return item.trim();
  if (item && typeof item === 'object') {
    const o = item as Record<string, unknown>;
    if (typeof o.text === 'string') return o.text.trim();
  }
  return '';
}

/**
 * 取注入短句 brief。老数据/模型没给 → 返回 undefined（回退逻辑在 brief.ts，不在这里生成）。
 * 存储上限按 EPISODES_CHARS 兜底：brief 正常 40 字，出现 120 字以上属于模型跑偏。
 */
function extractBrief(item: unknown): string | undefined {
  if (!item || typeof item !== 'object') return undefined;
  const b = (item as Record<string, unknown>).brief;
  if (typeof b !== 'string') return undefined;
  const t = b.trim().slice(0, EPISODES_CHARS);
  return t || undefined;
}

// ── normalize：逐层 ──────────────────────────────────────────

/**
 * 核心记忆（E1/E4）：
 * - 兼容纯字符串格式（老版本 pack / 模型直出的字符串数组）；
 * - 每条截断 CORE_MEMORY_CHARS，总上限 CORE_MEMORY_LIMIT；
 * - at 非法置 null。
 */
export function normalizeCoreMemories(raw: unknown): CoreMemory[] {
  if (!Array.isArray(raw)) return [];
  const out: CoreMemory[] = [];
  for (const item of raw) {
    const text = extractText(item).slice(0, CORE_MEMORY_CHARS);
    if (!text) continue;
    const at = item && typeof item === 'object' ? normalizeAt((item as Record<string, unknown>).at) : null;
    out.push({ text, at });
    if (out.length >= CORE_MEMORY_LIMIT) break;
  }
  return out.slice(0, CORE_MEMORY_LIMIT);
}

/**
 * 事件层（N1）：
 * - 同文去重：先出现的保留（老条目保留原时间，同 mergeProfileEpisodes 语义）；
 * - 保留 pickEpisodes 分层挑出的 60 条（不是"只留最新的"）；
 * - 每条截断 EPISODES_CHARS（120，不放宽）；
 * - `coreTexts`：已进核心记忆的事件（A3）——它们永远保留、不参与采样。
 */
export function normalizeEpisodes(
  raw: unknown,
  options: { coreTexts?: readonly string[] } = {},
): MemoryEpisode[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const all: MemoryEpisode[] = [];
  for (const item of raw) {
    const text = extractText(item).slice(0, EPISODES_CHARS);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    const at = item && typeof item === 'object' ? normalizeAt((item as Record<string, unknown>).at) : null;
    const episode: MemoryEpisode = { text, at };
    const brief = extractBrief(item);
    if (brief) episode.brief = brief;
    all.push(episode);
  }
  const coreTexts = new Set(options.coreTexts ?? []);
  return pickEpisodes(
    all,
    EPISODES_LIMIT,
    coreTexts.size ? { isPinned: (episode) => coreTexts.has(episode.text) } : {},
  );
}

/**
 * 在若干条里均匀取 k 条，保持原有先后顺序。
 * 两端都取到：最早那条和最晚那条必须留在结果里——"怎么认识的"和"昨天的事"
 * 都不能因为取样算法顺手丢掉。
 * 不用随机：同样的输入必须得到同样的输出，否则每次重蒸结果不可比。
 */
function sampleEven<T>(items: readonly T[], k: number): T[] {
  if (k <= 0) return [];
  if (items.length <= k) return [...items];
  if (k === 1) return [items[0]!];
  const out: T[] = [];
  for (let i = 0; i < k; i += 1) {
    out.push(items[Math.round((i * (items.length - 1)) / (k - 1))]!);
  }
  return out;
}

export interface PickEpisodesOptions<T> {
  /** 保底保留的最早条数（默认 EPISODES_PINNED_EARLIEST） */
  pinnedEarliest?: number;
  /** 命中即永远保留、不参与采样的条目（已进核心记忆的事件） */
  isPinned?: (item: T) => boolean;
}

/**
 * 事件保留策略：按时间分三段，早期/中期/近期各留一批。
 *
 * 为什么不再 `slice(-30)`：实测那两份真实包里，30 条事件有 27~30 条落在最近
 * 两三天，10-27 到 11-01 整整六天一条都没有。她记得你是谁、记得碎事实，
 * 却不记得你们中间那几周——这是结构缺失，加预算补不上。
 *
 * 三段各留一份（2026-11-25 A3 起总数 60）：注入走 brief，增长比全文渲染小得多，
 * 但**不是零成本**（60×40 字 ≈ 2400 字，见 config.ts EPISODES_LIMIT 注释）。
 * 只是把"只记最近"换成"首尾都留"。段内均匀取样，不集中在某个块。
 * 输入为空或不足上限时原样返回，一条不动。
 *
 * pinned（A3，2026-11-25 拍板）：
 *   - 最早 EPISODES_PINNED_EARLIEST 条**永远保留**，不参与采样（"怎么认识的"不能丢）；
 *   - `isPinned` 命中的条目（已进核心记忆的事件）同样永远保留——
 *     它们在她最珍视的记忆里，不能因为采样名额被挤掉；
 *   - 输出仍按原时间顺序，不重排。
 */
export function pickEpisodes<T>(
  all: readonly T[],
  limit: number = EPISODES_LIMIT,
  options: PickEpisodesOptions<T> = {},
): T[] {
  if (all.length <= limit) return [...all];
  const isPinned = options.isPinned ?? (() => false);
  const earliest = options.pinnedEarliest ?? EPISODES_PINNED_EARLIEST;

  const chosen = new Set<number>();
  all.forEach((item, index) => {
    if (index < earliest || isPinned(item)) chosen.add(index);
  });
  // 保底本身就超限（理论上不会：5 + 核心 5）——按时间顺序取前 limit 条，不制造更多
  if (chosen.size >= limit) {
    return all.filter((_, index) => chosen.has(index)).slice(0, limit);
  }

  // 剩下的名额在"未被 pin 的部分"里按三段分层取样
  const pool = all.map((item, index) => ({ item, index })).filter(({ item, index }) => !chosen.has(index) && !isPinned(item));
  const remain = limit - chosen.size;
  const per = Math.floor(remain / EPISODE_BANDS);
  for (let b = 0; b < EPISODE_BANDS; b += 1) {
    const start = Math.floor((pool.length * b) / EPISODE_BANDS);
    const end = Math.floor((pool.length * (b + 1)) / EPISODE_BANDS);
    // 余数给最近的一段：近期多留一两条，符合"最近的事更容易被提起"
    const quota = b === EPISODE_BANDS - 1 ? remain - per * (EPISODE_BANDS - 1) : per;
    for (const { index } of sampleEven(pool.slice(start, end), quota)) {
      chosen.add(index);
    }
  }
  return all.filter((_, index) => chosen.has(index));
}

/**
 * 两类事实交替合并（2026-11-22 修正）。
 *
 * 为什么不是"先排完对方、再排关系"：normalizeFacts 卡 30 条，排在后面的会被整段吃掉。
 * 实测那份真实导出就是【关于他】30 条、【关于你们】0 条——不是模型没提取，
 * 是顺序吃掉了。交替入队后，30 条自然变成 15/15；某一类少就由另一类补，
 * **总数不变、一条不多花 token**，只是不再让一类饿死。
 */
export function interleaveFacts(
  user: readonly string[],
  relationship: readonly string[],
): Array<{ text: string; kind: 'user' | 'relationship' }> {
  const out: Array<{ text: string; kind: 'user' | 'relationship' }> = [];
  const max = Math.max(user.length, relationship.length);
  for (let i = 0; i < max; i += 1) {
    const u = user[i];
    const r = relationship[i];
    if (u) out.push({ text: u, kind: 'user' });
    if (r) out.push({ text: r, kind: 'relationship' });
  }
  return out;
}

/**
 * 事实（D1）：去重 → 上限 30 → 每条截断 FACTS_CHARS。
 * 不是 FIFO：模型先合并去重，这里只做防御性裁切。
 */
export function normalizeFacts(raw: unknown): Fact[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: Fact[] = [];
  for (const item of raw) {
    const text = extractText(item).slice(0, FACTS_CHARS);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    const meta = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
    const fact: Fact = {
      text,
      addedAt: normalizeAt(meta.addedAt) ?? undefined,
      kind: meta.kind === 'relationship' ? 'relationship' : meta.kind === 'user' ? 'user' : undefined,
    };
    const brief = extractBrief(item);
    if (brief) fact.brief = brief;
    out.push(fact);
    if (out.length >= FACTS_LIMIT) break;
  }
  return out;
}

/**
 * 原声样本（A5）：
 * - quote 必需、一字不改（只截到 SAMPLES_QUOTE_CHARS）、同文去重；
 * - userQuote/scene 可选，各自截断；
 * - 条数 ≤ SAMPLES_LIMIT、总字数 ≤ SAMPLES_MAX_CHARS（先到为准，预算硬约束）。
 */
export function normalizeVoiceSamples(raw: unknown): VoiceSample[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: VoiceSample[] = [];
  let chars = 0;
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const quote = typeof o.quote === 'string' ? o.quote.trim().slice(0, SAMPLES_QUOTE_CHARS) : '';
    if (!quote || seen.has(quote)) continue;
    const userQuote = typeof o.userQuote === 'string' ? o.userQuote.trim().slice(0, SAMPLES_USER_QUOTE_CHARS) : '';
    const scene = typeof o.scene === 'string' ? o.scene.trim().slice(0, 30) : '';
    const cost = quote.length + userQuote.length + scene.length;
    if (out.length >= SAMPLES_LIMIT || chars + cost > SAMPLES_MAX_CHARS) break;
    seen.add(quote);
    chars += cost;
    out.push({
      quote,
      ...(userQuote ? { userQuote } : {}),
      ...(scene ? { scene } : {}),
      at: normalizeAt(o.at),
    });
  }
  return out;
}

function normalizeDiary(raw: unknown): DiaryEntry[] {  if (!Array.isArray(raw)) return [];
  const out: DiaryEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const date = typeof o.date === 'string' ? normalizeAt(o.date) : null;
    const text = typeof o.text === 'string' ? o.text.trim() : '';
    if (!date || !text) continue;
    out.push({ date, text });
  }
  return out;
}

// ── normalize：整包 ──────────────────────────────────────────

/**
 * 整包 normalize：来自文件 / 模型输出 / 落库读回的任意 JSON 都走这里。
 * 未知字段忽略（forward-compatible）；缺字段给安全默认值。
 */
export function normalizePack(raw: unknown): MemoryPack {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const personaRaw =
    o.persona && typeof o.persona === 'object' ? (o.persona as Record<string, unknown>) : {};
  const impression =
    typeof personaRaw.impression === 'string'
      ? personaRaw.impression.trim().slice(0, IMPRESSION_CHARS)
      : undefined;

  return {
    version: 1,
    persona: {
      name: typeof personaRaw.name === 'string' ? personaRaw.name.trim() : '',
      card: typeof personaRaw.card === 'string'
        ? softClip(personaRaw.card.trim(), PERSONA_MAX_CHARS, TEXT_OVERFLOW_RATIO)
        : '',
      impression: impression || undefined,
    },
    coreMemories: normalizeCoreMemories(o.coreMemories),
    memories: normalizeEpisodes(o.memories),
    facts: normalizeFacts(o.facts),
    summary:
      typeof o.summary === 'string'
        ? softClip(o.summary.trim(), SUMMARY_MAX_CHARS, TEXT_OVERFLOW_RATIO)
        : '',
    diary: normalizeDiary(o.diary),
    voiceSamples: normalizeVoiceSamples(o.voiceSamples),
  };
}

/** 序列化（导出记忆包 / 存库前的统一出口） */
export function serializePack(pack: MemoryPack): string {
  return JSON.stringify(pack, null, 2);
}

/** 反序列化 + normalize 的统一入口 */
export function deserializePack(json: string): MemoryPack {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    throw new Error(`记忆包不是合法 JSON：${(e as Error).message}`);
  }
  return normalizePack(raw);
}
