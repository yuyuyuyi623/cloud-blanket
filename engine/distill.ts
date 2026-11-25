/**
 * engine/distill.ts —— 导入蒸馏（存量历史的冷启动重构，柔光没有对应物）
 *
 * 流水线（主方案第五节）：
 *   块调用（每块 2 万字 → 块摘要 + persona 片段 + 两类事实 + 事件候选）
 *   → 汇总调用（合成 persona 卡 + 关系摘要 + 核心记忆候选 + 合并事实）
 *   → normalizePack 落进记忆包 v1（与运行时整合同构，清单九·同构清单）
 *
 * 纪律：
 *   - 蒸馏必须产出 memories 事件层——否则导入完的"她"记得"你养猫"，
 *     却不记得"那天你说连续加班三天"（清单九）；
 *   - 同样遵守 G1~G3：显式 maxTokens、截断与"没给 JSON"分开报错、finish_reason 留痕；
 *   - 提示词无示范句（H1，单测钉死）；只提取事实，不写人格指令（人格是"她"的，不是模板的）；
 *   - 并发 DISTILL_CONCURRENCY 路（2026-11-22 从 2 提到 8，见 config 注释）；
 *   - 密码/密钥/账号/支付信息/精确住址不进任何字段。
 */

import {
  DISTILL_BLOCK_RETRIES,
  DISTILL_CONCURRENCY,
  DISTILL_MAX_TOKENS,
  DISTILL_SUMMARIZE_MAX_TOKENS,
  DISTILL_TIMEOUT_MS,
  BRIEF_CHARS,
  EPISODES_CHARS,
  FACTS_LIMIT,
  FACTS_PROMPT_CHARS,
  CORE_MEMORY_CHARS,
  IMPRESSION_CHARS,
  IMPRESSION_PROMPT_CHARS,
  PERSONA_MAX_CHARS,
  SAMPLES_PER_BLOCK,
  SAMPLES_LIMIT,
  SAMPLES_MAX_CHARS,
  SAMPLES_QUOTE_CHARS,
  SAMPLES_USER_QUOTE_CHARS,
  SUMMARY_MAX_CHARS,
  CONSOLIDATION_TEMPERATURE,
} from './config.js';
import {
  type ChatMessage,
  type CallOptions,
  type LlmClient,
  LlmError,
  parseJsonObject,
} from './deepseek.js';
import {
  interleaveFacts,
  normalizeEpisodes,
  normalizeFacts,
  normalizePack,
  type MemoryPack,
  type VoiceSample,
} from './pack.js';
import type { ParsedMessage } from './parse.js';

// ── 块调用 ───────────────────────────────────────────────────

export interface DistillBlockInput {
  /** 块序号（0 起） */
  blockIndex: number;
  /** 该块正文（纯对话文本，思考链已丢） */
  text: string;
  firstAt?: string | null;
  lastAt?: string | null;
}

export interface DistillMemory {
  text: string;
  at: string | null;
  /** 注入用一句话（≤BRIEF_CHARS 字目标，模型自己写），见 engine/brief.ts */
  brief?: string;
}

export interface DistillBlockResult {
  blockIndex: number;
  /** 块起止时间（时间三段标注用，A7-A） */
  firstAt?: string | null;
  lastAt?: string | null;
  /** 块摘要（≤600 字，带时间叙述） */
  summary: string;
  /** "她"的证据片段（口吻/称呼/风格/在乎什么），每条 ≤120 字 */
  personaFragments: string[];
  /** 用户稳定事实 */
  factsUser: string[];
  /** 关系事实 */
  factsRelationship: string[];
  /** 事件候选（带时间） */
  memories: DistillMemory[];
  /** 原声样本候选（A5：已通过原文硬校验，存的是原文那份） */
  voiceSamples?: VoiceSample[];
  /** 样本校验台账：候选 N 条 / 命中 M 条（M=0 要 warn，丢弃要留痕） */
  voiceStats?: { candidates: number; hits: number };
  /** 用量（预估页对账用） */
  usage?: { promptTokens?: number; completionTokens?: number };
}

function blockHeader(block: DistillBlockInput): string {
  const parts: string[] = [];
  if (block.firstAt) parts.push(`开始于 ${block.firstAt.slice(0, 10)}`);
  if (block.lastAt) parts.push(`结束于 ${block.lastAt.slice(0, 10)}`);
  return parts.length ? `（这段记录${parts.join('，')}）\n\n` : '';
}

/**
 * 把一条条消息拼成喂给模型的正文。
 *
 * 口径只有这一份：cli/plan.mjs 导出的原料、App 里蒸馏喂的、将来任何工具导出的，
 * 都必须是这个格式——模型看到什么，决定它提取出什么，两处不一致就是两份事实。
 *
 * 格式：`你（2025-03-01）：内容` / `她（2025-03-01）：内容`，空行分隔。
 * 时间只到日期（事件提取要 YYYY-MM-DD，时分秒只会花更多 token）；
 * 非 FINISHED 的消息带上状态标记——半截话也是事实，但要让模型知道它没说完。
 */
export function renderBlockText(messages: ParsedMessage[]): string {
  return messages
    .map((m) => {
      const who = m.role === 'user' ? '你' : '她';
      const when = m.at ? `（${m.at.slice(0, 10)}）` : '';
      const flag = m.unfinished ? `〔未说完：${m.unfinished}〕` : '';
      return `${who}${when}${flag}：${m.text}`;
    })
    .join('\n\n');
}

/**
 * 块调用提示词。注意措辞边界：提示词只提取"记录里有什么"，
 * 不指令"她该怎么说话"——人格层内容（柔光的 persona/世界设定）零接触（红线）。
 */
export function buildBlockMessages(block: DistillBlockInput): ChatMessage[] {
  const system = `你负责从一段真实聊天记录里提取记忆原料。记录发生在"对方"和一个长期在场的角色之间，你是旁观整理者，只提取记录里有依据的内容，不评价、不发挥。

分类提取：
1. summary：这段记录按时间顺序讲了什么，写成不超过 600 字的中文叙述，保留时间信息（什么时候发生了什么）。
2. persona：记录里能看出那个角色"是谁"的证据——口吻、称呼习惯、说话风格、在乎什么、**怎么对待对方（站谁的队、护着还是损着、怎么接话）**。每条不超过 120 字，一条写一个侧面。
   注意：称呼记录里同一个人的不同写法时，若只是错字、简写、同音或只差一个字（「老D」与「老丁」这类），那是同一个称呼，统一写成正确的那一个，不要两种并存，也不要当成两个别名。
3. factsUser：对方的稳定信息——偏好、习惯、正在做的事、重要关系、计划、边界。每条不超过 ${FACTS_PROMPT_CHARS} 字，一条只说一件事，不把几件事挤进一条。不写「今天」「昨天」「最近」这类相对时间，需要时间就写具体日期；审核或讨论里得出的判断（如「确认某物是真实食物」）不算对方的稳定信息，不写。
4. factsRelationship：关系层面的事实——怎么认识、发展到哪一步、约定、矛盾、现状。每条不超过 ${FACTS_PROMPT_CHARS} 字，同样一条只说一件事、不写相对时间。
5. memories：具体发生过的事（最多 8 条），text 写清什么时候、发生了什么（不超过 ${EPISODES_CHARS} 字），带时间 at（YYYY-MM-DD，记录里有就写，没有写 null）；每条还要给一个 brief，用记录里那个角色的口吻把这件事说成一句话，不超过 ${BRIEF_CHARS} 字，读起来要像人随口提起，不要为省字写成电报。
6. voiceSamples：这段记录里最能看出"她怎么说话"的原话，2~3 条。**quote 必须一字不改照抄她的原句**（只许截短到 ${SAMPLES_QUOTE_CHARS} 字以内，不许润色、不许改标点、不许合并两句）；每条再带上她那句话前面紧接着的对方那一句作 userQuote（原话截短到 ${SAMPLES_USER_QUOTE_CHARS} 字以内，找不到上文的那条就不要选）。优先挑有情绪、有梗、有口头禅、护着/损着对方的句子；不要挑信息型长回答。scene 用一个第三人称短语（不超过 30 字）说明当时的场合。

密码、密钥、账号、支付信息、精确住址不进任何字段。没有依据的字段返回空数组，没有依据的内容不写。

输出严格 JSON，不要 Markdown：
{"summary":"...","persona":["..."],"factsUser":["..."],"factsRelationship":["..."],"memories":[{"text":"...","brief":"...","at":"YYYY-MM-DD 或 null"}],"voiceSamples":[{"scene":"...","userQuote":"...","quote":"..."}]}`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: `${blockHeader(block)}聊天记录：\n${block.text}` },
  ];
}

/**
 * 空白归一 + 位置映射：模型抄原话时经常多打/少打空格、把全角标点换成半角，
 * 严格 indexOf 会误杀真原文；两边都 `trim().replace(/\s+/g,'')` 再比，命中后
 * 用映射回到**原文位置**，落库存原文那一份（A5 硬校验，拍板回复 三·③）。
 */
const normalizeWithMap = (text: string): { norm: string; map: number[] } => {
  let norm = '';
  const map: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === undefined || /\s/.test(ch)) continue;
    norm += ch;
    map.push(i);
  }
  return { norm, map };
};

const normalizeQuote = (text: string): string => text.replace(/\s+/g, '').trim();

/**
 * 在一段原文里找回模型抄的那句话，返回**原文里的那一段**（不是归一化后的）；找不到返回 null。
 * 校验失败就丢弃，不许把模型的"润色版"当原声用。
 */
export function findVerbatim(blockText: string, quote: string): string | null {
  const needle = normalizeQuote(quote);
  if (!needle) return null;
  const { norm, map } = normalizeWithMap(blockText);
  const at = norm.indexOf(needle);
  if (at < 0) return null;
  const start = map[at];
  const last = map[at + needle.length - 1];
  if (start === undefined || last === undefined) return null;
  return blockText.slice(start, last + 1);
}

function parseBlockResult(block: DistillBlockInput, raw: unknown): DistillBlockResult {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const strList = (v: unknown, cap: number): string[] =>
    Array.isArray(v)
      ? v
          .map((x) => (typeof x === 'string' ? x : String((x as { text?: unknown })?.text ?? '')))
          .map((s) => s.trim())
          .filter(Boolean)
          .slice(0, cap)
      : [];
  const memories = Array.isArray(o.memories)
    ? (o.memories as unknown[])
        .map((item) => {
          const m = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
          const text = typeof m.text === 'string' ? m.text.trim() : '';
          if (!text) return null;
          const at = typeof m.at === 'string' && m.at.trim() ? m.at.trim() : null;
          const memory: DistillMemory = { text: text.slice(0, EPISODES_CHARS), at };
          const brief = typeof m.brief === 'string' ? m.brief.trim() : '';
          if (brief) memory.brief = brief.slice(0, EPISODES_CHARS);
          return memory;
        })
        .filter((x): x is DistillMemory => x !== null)
        .slice(0, 8)
    : [];
  // 原声样本（A5）：模型挑 + 代码硬校验——quote/userQuote 必须在这块原文里精确命中
  const rawSamples = Array.isArray(o.voiceSamples) ? (o.voiceSamples as unknown[]) : [];
  const voiceSamples: VoiceSample[] = [];
  for (const item of rawSamples) {
    const s = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
    const quoteRaw = typeof s.quote === 'string' ? s.quote.trim() : '';
    const userQuoteRaw = typeof s.userQuote === 'string' ? s.userQuote.trim() : '';
    if (!quoteRaw) continue;
    const quote = findVerbatim(block.text, quoteRaw);
    // 配对是硬要求（孤立句没有场合锚，模型会照着语气乱套）：找不到上文就不选
    const userQuote = userQuoteRaw ? findVerbatim(block.text, userQuoteRaw) : null;
    if (!quote || !userQuote) continue;
    const scene = typeof s.scene === 'string' ? s.scene.trim().slice(0, 30) : '';
    // 时间从原文那一行取（块正文格式固定：`她（YYYY-MM-DD）：…`）
    const lineBegin = block.text.lastIndexOf('\n', block.text.indexOf(quote)) + 1;
    const lineEndRaw = block.text.indexOf('\n', block.text.indexOf(quote));
    const line = block.text.slice(lineBegin, lineEndRaw < 0 ? undefined : lineEndRaw);
    const at = line.match(/（(\d{4}-\d{2}-\d{2})）/)?.[1] ?? null;
    voiceSamples.push({
      quote: quote.slice(0, SAMPLES_QUOTE_CHARS),
      userQuote: userQuote.slice(0, SAMPLES_USER_QUOTE_CHARS),
      ...(scene ? { scene } : {}),
      at,
    });
    if (voiceSamples.length >= SAMPLES_PER_BLOCK) break;
  }

  return {
    blockIndex: block.blockIndex,
    summary: typeof o.summary === 'string' ? o.summary.trim().slice(0, 600) : '',
    personaFragments: strList(o.persona, 20),
    factsUser: strList(o.factsUser, FACTS_LIMIT),
    factsRelationship: strList(o.factsRelationship, FACTS_LIMIT),
    memories,
    voiceSamples,
    // 丢弃必须留痕：M=0 时"模型全程润色"和"原料本来就没样本"长得一样（拍板回复 三·③）
    voiceStats: { candidates: rawSamples.filter((x) => x && typeof x === 'object').length, hits: voiceSamples.length },
  };
}

export async function distillBlock(
  client: LlmClient,
  block: DistillBlockInput,
): Promise<DistillBlockResult> {
  const options: CallOptions = {
    temperature: CONSOLIDATION_TEMPERATURE,
    maxTokens: DISTILL_MAX_TOKENS,
    purpose: 'distill-block',
    // 90 秒是给日常对话的；蒸馏块输入 2 万字、输出最多 4000 token，必须放宽
    timeoutMs: DISTILL_TIMEOUT_MS,
    retries: 1,
  };
  const result = await client.chat(buildBlockMessages(block), options);
  return {
    ...parseBlockResult(block, parseJsonObject(result.content)),
    firstAt: block.firstAt ?? null,
    lastAt: block.lastAt ?? null,
    usage: { promptTokens: result.promptTokens, completionTokens: result.completionTokens },
  };
}

// ── 汇总调用 ─────────────────────────────────────────────────

/** 核心记忆候选上限（确认页人工挑选，落库时 normalize 截到 5） */
export const CORE_CANDIDATES_LIMIT = 10;

export interface DistillSummarizeResult {
  /** persona 卡草稿（≤2000 字），确认页可改 */
  personaCard: string;
  /** 整体印象一句（≤IMPRESSION_PROMPT_CHARS=100 字，存 120），确认页可改可清空 */
  impression: string;
  /** 关系阶段摘要（≤2000 字） */
  summary: string;
  /** 核心记忆候选（5~10 条，确认页挑选） */
  coreCandidates: DistillMemory[];
  /** 合并去重后的全部事实 */
  factsUser: string[];
  factsRelationship: string[];
  /** 原声样本（已按候选池校验：只可能是块调用里命中的原文，模型改写的一律丢弃） */
  voiceSamples?: VoiceSample[];
  /** 汇总侧样本台账：模型返回 N 条、真正对上候选 M 条 */
  voiceStats?: { candidates: number; hits: number };
  usage?: { promptTokens?: number; completionTokens?: number };
}

/**
 * 汇总返回的样本只做"从候选里挑"的校验（A5 红线）：
 * 汇总调用看不到原文，模型很容易把候选"顺手改顺"——改过的就不是原声了。
 * 做法：与候选池按空白归一比对，命中就换回候选里那份原文；命不中直接丢。
 * 顺带按 SAMPLES_LIMIT / SAMPLES_MAX_CHARS 收口（样本层的预算硬约束）。
 */
function verifySummarizedSamples(
  raw: unknown,
  candidates: VoiceSample[],
): { samples: VoiceSample[]; dropped: number } {
  const list = Array.isArray(raw) ? raw : [];
  const byNorm = new Map(candidates.map((c) => [normalizeQuote(c.quote), c]));
  const picked: VoiceSample[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  let chars = 0;
  for (const item of list) {
    const s = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
    const key = typeof s.quote === 'string' ? normalizeQuote(s.quote) : '';
    const hit = key ? byNorm.get(key) : undefined;
    if (!hit || seen.has(key)) {
      dropped += 1;
      continue;
    }
    const scene = typeof s.scene === 'string' && s.scene.trim() ? s.scene.trim().slice(0, 30) : hit.scene;
    const next: VoiceSample = { ...hit, ...(scene ? { scene } : {}) };
    const cost = next.quote.length + (next.userQuote?.length ?? 0) + (next.scene?.length ?? 0);
    if (picked.length >= SAMPLES_LIMIT || chars + cost > SAMPLES_MAX_CHARS) {
      dropped += 1;
      continue;
    }
    seen.add(key);
    picked.push(next);
    chars += cost;
  }
  return { samples: picked, dropped };
}

/**
 * 时间三段（A7-A，2026-11-25）：按块起止时间把所有块分成 早期/中期/近期。
 *
 * 为什么要标：同一个人两年内说话方式会变，等量材料 + 一句"近期为主"的指令压不过比例
 * （柔光实测结论）。标签 + 明确的权重纪律，才能让模型可执行地取舍。
 */
function periodLabel(block: DistillBlockResult, minAt: number, maxAt: number): string {
  const t = block.firstAt ? Date.parse(block.firstAt) : NaN;
  if (Number.isNaN(t) || !Number.isFinite(minAt) || !Number.isFinite(maxAt) || maxAt <= minAt) {
    return '中期';
  }
  const ratio = (t - minAt) / (maxAt - minAt);
  if (ratio < 1 / 3) return '早期';
  if (ratio < 2 / 3) return '中期';
  return '近期';
}

export function buildSummarizeMessages(blocks: DistillBlockResult[]): ChatMessage[] {
  const ats = blocks
    .map((b) => (b.firstAt ? Date.parse(b.firstAt) : NaN))
    .filter((t) => Number.isFinite(t));
  const minAt = ats.length ? Math.min(...ats) : NaN;
  const maxAt = ats.length ? Math.max(...ats) : NaN;

  const material = blocks
    .map((b) => {
      const mem = b.memories.map((m) => `- ${m.at ? `${m.at.slice(0, 10)}：` : ''}${m.text}`).join('\n');
      const facts = [...b.factsUser.map((f) => `[对方] ${f}`), ...b.factsRelationship.map((f) => `[关系] ${f}`)].join('\n');
      const samples = (b.voiceSamples ?? [])
        .map((s) => `- ${s.scene ? `（${s.scene}）` : ''}${s.userQuote ? `他说"${s.userQuote}"，` : ''}她说"${s.quote}"`)
        .join('\n');
      return `── 第 ${b.blockIndex + 1} 段（${periodLabel(b, minAt, maxAt)}）摘要 ──
${b.summary || '（无）'}

这一段看出的角色侧写：
${b.personaFragments.map((p) => `- ${p}`).join('\n') || '- （无）'}

这一段的事实：
${facts || '- （无）'}

这一段的具体事件：
${mem || '- （无）'}

这一段她说话的原话（候选样本）：
${samples || '- （无）'}`;
    })
    .join('\n\n');

  const system = `你负责把多段记忆原料合成一份"那个角色"的底稿。原料来自同一对关系的不同时期，按时间顺序给全，每段标注了它属于早期/中期/近期。

**时间权重纪律**（A7，别当建议）：近期的权重是早期的两倍；前后期说话方式、态度冲突时，一律以近期为准。早期材料只取身份事实、称呼来历和"怎么认识的"，不要用早期的口吻覆盖近期；早期和近期都出现的特征，才是她一贯的样子，写进卡里。近期的细节密度最高，卡上的姿态与说话方式主要来自近期。

产出：
1. persona：写一张完整的人格卡（不超过 ${PERSONA_MAX_CHARS} 字）：她是谁、口吻和称呼习惯、说话风格、在乎什么、和对方的关系怎么走到今天。只用原料里有依据的内容；各时期的差异按时间写清楚，后期特征为主、早期特征为底。
   **姿态是这张卡的灵魂，身份只是骨架**：必须写清她怎么对对方——她站在对方哪一边、惯常怎么护着/损着/拆台着对方、什么说法是她的招牌（最好举一两个原料里她的原话片段当例子）。只写身份和风格、不写姿态的卡不合格。
2. impression：一句不超过 ${IMPRESSION_PROMPT_CHARS} 字的整体印象，概括"她是什么样的人、对对方的姿态是什么、这段关系现在是什么状态"。
3. summary：整段关系的阶段摘要（不超过 ${SUMMARY_MAX_CHARS} 字），自然的中文短段落，不用 Markdown。
4. coreMemories：从所有原料里挑出 5 到 10 条最不能忘的事（每条不超过 ${CORE_MEMORY_CHARS} 字，带时间 at）。这是给人工确认页的候选，宁缺毋滥，没有足够分量的事就少挑。
5. factsUser 与 factsRelationship：合并所有原料的事实，同一条只出现一次，各最多 ${FACTS_LIMIT} 条，每条不超过 ${FACTS_PROMPT_CHARS} 字。事实里不写「今天」「昨天」「最近」这类相对时间，需要时间就写具体日期；一次性的事和审核结论不算事实，写进 coreMemories。
6. 称呼归一：同一个人的两种写法，若只是错字、简写、同音或只差一个字（「老D」和「老丁」、「团子」和「团仔」），那就是同一称呼，统一写成正确的那一个。判断不了正字时取出现次数多的。绝不写成「自称 A／B」的别名——那会把一时的口误固化成设定。一个人有几个真正不同的身份（名字、职务、昵称）时才算不同称呼。
7. voiceSamples：从各段列出的"候选样本"里挑 ${SAMPLES_LIMIT} 条以内的原话，**quote 与 userQuote 必须从候选里原样照抄，一个字都不许改**（不许润色、不许改标点、不许拼接）。你的活只有三件：合并重复（同一句话只留一条）、按"最能看出她怎么说话"排序、保证三种场合都有（日常闲聊 / 拌嘴互损 / 正经讨论）。近期候选优先；信息型长回答不要。scene 用一个第三人称短语（不超过 30 字）说明场合。

密码、密钥、账号、支付信息、精确住址不进任何字段。原料里没有的内容不写。

输出严格 JSON，不要 Markdown：
{"persona":"...","impression":"...","summary":"...","coreMemories":[{"text":"...","at":"YYYY-MM-DD 或 null"}],"factsUser":["..."],"factsRelationship":["..."],"voiceSamples":[{"scene":"...","quote":"...","userQuote":"..."}]}`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: `记忆原料：\n\n${material}` },
  ];
}

export async function distillSummarize(
  client: LlmClient,
  blocks: DistillBlockResult[],
): Promise<DistillSummarizeResult> {
  const result = await client.chat(buildSummarizeMessages(blocks), {
    temperature: CONSOLIDATION_TEMPERATURE,
    maxTokens: DISTILL_SUMMARIZE_MAX_TOKENS,
    purpose: 'distill-summarize',
    timeoutMs: DISTILL_TIMEOUT_MS,
  });
  const o = parseJsonObject(result.content);
  const strList = (v: unknown, cap: number): string[] =>
    Array.isArray(v)
      ? v
          .map((x) => (typeof x === 'string' ? x : String((x as { text?: unknown })?.text ?? '')))
          .map((s) => s.trim())
          .filter(Boolean)
          .slice(0, cap)
      : [];
  const coreCandidates = Array.isArray(o.coreMemories)
    ? (o.coreMemories as unknown[])
        .map((item) => {
          const m = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
          const text = typeof m.text === 'string' ? m.text.trim() : typeof item === 'string' ? item.trim() : '';
          if (!text) return null;
          const at = typeof m.at === 'string' && m.at.trim() ? m.at.trim() : null;
          return { text: text.slice(0, CORE_MEMORY_CHARS), at };
        })
        .filter((x): x is DistillMemory => x !== null)
        .slice(0, CORE_CANDIDATES_LIMIT)
    : [];
  const candidates = blocks.flatMap((b) => b.voiceSamples ?? []);
  const voice = verifySummarizedSamples(o.voiceSamples, candidates);
  const rawSampleCount = Array.isArray(o.voiceSamples) ? o.voiceSamples.length : 0;
  if (rawSampleCount > 0 && voice.samples.length === 0) {
    console.warn(`[distill] 汇总返回的 ${rawSampleCount} 条原声样本一条都没对上候选池（模型改写了原话）`);
  }
  return {
    personaCard: typeof o.persona === 'string' ? o.persona.trim().slice(0, PERSONA_MAX_CHARS) : '',
    impression: typeof o.impression === 'string' ? o.impression.trim().slice(0, IMPRESSION_CHARS) : '',
    summary: typeof o.summary === 'string' ? o.summary.trim().slice(0, SUMMARY_MAX_CHARS) : '',
    coreCandidates,
    factsUser: strList(o.factsUser, FACTS_LIMIT),
    factsRelationship: strList(o.factsRelationship, FACTS_LIMIT),
    voiceSamples: voice.samples,
    voiceStats: { candidates: rawSampleCount, hits: voice.samples.length },
    usage: { promptTokens: result.promptTokens, completionTokens: result.completionTokens },
  };
}

// ── 流水线编排 ───────────────────────────────────────────────

export interface DistillProgress {
  phase: 'blocks' | 'summarize';
  done: number;
  total: number;
  /** 整条流水线开始的时间（epoch ms）——UI 用它算"已用 6:12" */
  startedAt: number;
  /** 正在跑的块号（0 起），并发时会有多个；UI 靠它说"正在写第 9、10 块" */
  running: number[];
  /** 最近一个块开始跑的时间；UI 用它算心跳"这块已经 47 秒" */
  runningSince: number | null;
  /** 最近跑完那块用了多久（ms），UI 拿它估剩余；还没有块跑完时为 null */
  lastBlockMs: number | null;
}

export interface DistillRunResult {
  /** 落库前由确认页逐项核对；此处 pack 直接可用（已 normalize） */
  pack: MemoryPack;
  /** 核心记忆候选（确认页挑选后回填 pack.coreMemories） */
  coreCandidates: DistillMemory[];
  blockResults: DistillBlockResult[];
  summarize: DistillSummarizeResult;
  /**
   * 全部成功调用的实际 token 总量（块 + 汇总求和）——账本按这个实记，
   * 不再用 estimate 的谷价预估（2026-11-25 对账：峰时蒸馏低估近一半）。
   * 失败/重试中被丢弃的调用拿不到 usage，官方若计费则此处略低估（保守方向相反，可接受）。
   */
  usage: { promptTokens: number; completionTokens: number };
}

/**
 * 块级可重试的错误。
 * 429/5xx 不在这里——那是 deepseek client 的活（它自己退避重试），
 * 两层都重试会变成"一块失败打 6 次请求"，白白放大限流。
 */
const BLOCK_RETRYABLE_KINDS: ReadonlySet<string> = new Set(['timeout', 'network', 'no-json', 'empty']);

/**
 * 一块失败不立刻拖垮全局：单独重试这一块 DISTILL_BLOCK_RETRIES 次。
 * 8 路并发下，21 块里有 1 块偶发超时，整条重跑的代价太大。
 */
async function distillBlockWithRetry(
  client: LlmClient,
  block: DistillBlockInput,
): Promise<DistillBlockResult> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await distillBlock(client, block);
    } catch (e) {
      const retryable =
        e instanceof LlmError && BLOCK_RETRYABLE_KINDS.has(e.kind) && attempt < DISTILL_BLOCK_RETRIES;
      if (!retryable) throw e;
      // 1s、2s —— 偶发超时重试基本一次就够；等太久不如让用户看到失败
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
    }
  }
}

/**
 * 蒸馏流水线：块并发 DISTILL_CONCURRENCY 路 → 汇总 → 组包。
 * 单块彻底失败（重试后仍失败）直接抛——少一块就是少一段记忆，不许静默跳过。
 */
export async function runDistill(
  client: LlmClient,
  blocks: DistillBlockInput[],
  opts: { onProgress?: (p: DistillProgress) => void } = {},
): Promise<DistillRunResult> {
  const results: DistillBlockResult[] = new Array(blocks.length);
  const startedAt = Date.now();
  const running = new Set<number>();
  /** 重试后仍失败的块：攒完所有块再抛——一块坏了不该让其他块已经花的钱作废 */
  const failures: { index: number; error: unknown }[] = [];
  let cursor = 0;
  let done = 0;
  let runningSince: number | null = null;
  let lastBlockMs: number | null = null;

  const emit = (phase: DistillProgress['phase']) =>
    opts.onProgress?.({
      phase,
      done,
      total: blocks.length,
      startedAt,
      running: [...running],
      runningSince,
      lastBlockMs,
    });

  async function worker(): Promise<void> {
    for (;;) {
      const i = cursor++;
      const block = blocks[i];
      if (!block) return;
      running.add(i);
      runningSince = Date.now();
      emit('blocks');
      const t0 = Date.now();
      try {
        results[i] = await distillBlockWithRetry(client, block);
      } catch (e) {
        failures.push({ index: i, error: e });
      } finally {
        running.delete(i);
        done++;
        lastBlockMs = Date.now() - t0;
        emit('blocks');
      }
    }
  }

  // 先发一次空进度：UI 不会在"还没跑完一块"时拿到 null 而显示错文案
  emit('blocks');
  await Promise.all(
    Array.from({ length: Math.min(DISTILL_CONCURRENCY, blocks.length) }, () => worker()),
  );

  // 少一块就是少一段记忆：绝不静默跳过，但要等所有块都跑完再抛，别浪费已发出的调用
  if (failures.length) {
    const first = failures[0]!;
    const where = `第 ${failures.map((f) => f.index + 1).join('、')} 块失败`;
    const e = first.error;
    if (e instanceof LlmError) {
      throw new LlmError(e.kind, `${e.message}（${where}）`, e.status, e.purpose);
    }
    throw e instanceof Error ? e : new Error(where);
  }

  running.clear();
  runningSince = Date.now();
  // 原声样本台账（A5）：逐块打 候选 N / 命中 M；M=0 单独 warn——
  // 否则"模型全程润色"和"原料本来就没样本"在产物上长得一样（都是 0 条）
  for (const r of results) {
    if (!r.voiceStats) continue;
    const { candidates, hits } = r.voiceStats;
    if (hits === 0) {
      console.warn(`[distill] 第 ${r.blockIndex + 1} 块原声样本 0/${candidates} 命中（候选全被丢弃）`);
    }
  }
  emit('summarize');
  const summarize = await distillSummarize(client, results);
  done = blocks.length;
  emit('summarize');

  // 事件层：全部块的事件候选合并（蒸馏必须产出 memories；超 60 条按三段分层保留，确认页明写）
  // 已进核心候选的事件永远保留（A3）：她在"最珍视"里记着的事不能因为采样名额被挤掉。
  const memories = normalizeEpisodes(results.flatMap((r) => r.memories), {
    coreTexts: summarize.coreCandidates.map((c) => c.text),
  });
  // 事实：两类分开抽（D2），交替合并再卡 30 条——先排一类会把另一类整段挤掉（实测 0 条关系事实）
  const facts = normalizeFacts(interleaveFacts(summarize.factsUser, summarize.factsRelationship));

  const pack = normalizePack({
    version: 1,
    persona: { name: '', card: summarize.personaCard, impression: summarize.impression || undefined },
    coreMemories: summarize.coreCandidates.slice(0, 5),
    memories,
    facts,
    summary: summarize.summary,
    diary: [],
    voiceSamples: summarize.voiceSamples ?? [],
  });

  const usage = [...results, summarize].reduce(
    (acc, r) => ({
      promptTokens: acc.promptTokens + (r.usage?.promptTokens ?? 0),
      completionTokens: acc.completionTokens + (r.usage?.completionTokens ?? 0),
    }),
    { promptTokens: 0, completionTokens: 0 },
  );
  return { pack, coreCandidates: summarize.coreCandidates, blockResults: results, summarize, usage };
}
