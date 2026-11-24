/**
 * engine/consolidation.ts —— 运行时整合（facts / core / episodes / forget / impression）+ 滚动摘要
 *
 * 逻辑逐条对照柔光源码 index.mjs:5470-5600（consolidateProfile）移植，改动点只有三个：
 *   1. 提示词全部重写为中性措辞，并去掉两处示范句（H1 红线：原句"例：他说连续加班三天…"、
 *      "比如两次不同的凌晨熬夜…"都会被模型照抄进人格）；
 *   2. persona 运行时不动（persona 来自蒸馏 + 用户在记忆页手改，整合不碰它）；
 *   3. memoryRevision 并发保护由调用方（App 存储层）负责，本模块保持纯函数。
 *
 * forget 只作用于 episodes（F2）；core 走准入制（E3 Jaccard > 0.45 拒绝同义覆盖）；
 * facts 走合并去重（D1，不是 FIFO）；core 收录的条目从 episodes 剔除（N3）。
 */

import {
  CONSOLIDATE_EVERY_ROUNDS,
  CONSOLIDATE_MIN_MINUTES,
  CONSOLIDATION_MAX_TOKENS,
  CONSOLIDATION_TEMPERATURE,
  CORE_MEMORY_CHARS,
  EPISODES_CHARS,
  FACTS_PROMPT_CHARS,
  FORGET_LIMIT,
  IMPRESSION_PROMPT_CHARS,
  JACCARD_THRESHOLD,
  NEW_EPISODES_PER_RUN,
  SUMMARY_EVERY_ROUNDS,
  SUMMARY_MAX_CHARS,
  SUMMARY_MAX_TOKENS,
  SUMMARY_TEMPERATURE,
} from './config.js';
import {
  characterJaccard,
} from './jaccard.js';
import {
  type MemoryPack,
  normalizeCoreMemories,
  normalizeEpisodes,
  normalizeFacts,
  normalizePack,
} from './pack.js';
import type { ChatMessage, LlmClient } from './deepseek.js';

// ── 触发节流（G5）────────────────────────────────────────────

export interface ConsolidationGateInput {
  /** 自上次整合以来的用户发言轮数 */
  userRoundsSince: number;
  /** 上次尝试时间（ISO 字符串；含失败。失败也吃冷却，防死循环打 API） */
  lastAttemptAt: string | null;
  now: number;
  inFlight: boolean;
  force?: boolean;
}

/**
 * 该不该触发整合：每 CONSOLIDATE_EVERY_ROUNDS 轮 + 冷却 CONSOLIDATE_MIN_MINUTES 分钟 + in-flight 互斥。
 * force（用户手动点"整理记忆"）跳过轮数与冷却，但 in-flight 互斥不跳。
 */
export function shouldConsolidate(input: ConsolidationGateInput): boolean {
  if (input.inFlight) return false;
  if (input.force) return true;
  if (input.userRoundsSince < CONSOLIDATE_EVERY_ROUNDS) return false;
  const last = input.lastAttemptAt ? Date.parse(input.lastAttemptAt) : NaN;
  if (Number.isFinite(last) && input.now - last < CONSOLIDATE_MIN_MINUTES * 60 * 1000) return false;
  return true;
}

// ── 整合提示词（骨架照源码，措辞重写；无示范句——H1 由单测钉死）──

export interface RecentLine {
  role: 'user' | 'assistant';
  text: string;
  at?: string | null;
}

function fmtTimestamp(at: string | null | undefined): string {
  if (!at) return '';
  const t = new Date(at);
  if (Number.isNaN(t.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}`;
}

/** 最近对话 → 带时间戳的对话文本（G6：前面是发生时间） */
export function renderRecentConversation(recent: RecentLine[]): string {
  return recent
    .map((l) => {
      const when = l.at ? `[${fmtTimestamp(l.at)}] ` : '';
      return `${when}${l.role === 'user' ? '对方' : '你'}：${l.text}`;
    })
    .join('\n');
}

/**
 * 整合调用输入。manualMemories（"手动记住"通道）必须作为输入喂回模型，
 * 否则下一轮整合就会把它吞掉（清单十·2，单测锁死）。
 */
export function buildConsolidationMessages(
  pack: MemoryPack,
  manualMemories: string[],
  recent: RecentLine[],
): ChatMessage[] {
  const system = `你负责维护一段长期关系的记忆，分几类：

1. memories：最近新发生、值得记住的几件事。写清什么时候、发生了什么、当时的感觉，像回忆一样。不写性格判断，不编造没发生的事。最多 ${NEW_EPISODES_PER_RUN} 条，只写新的，不要重写已经记下的事。
2. facts：稳定、以后聊天确实有用的信息：偏好、习惯、正在做的事、重要关系、计划和边界。每条不超过 ${FACTS_PROMPT_CHARS} 字，合并去重后输出全部。密码、密钥、账号、精确住址、支付信息不进这里；不根据一句话猜性格。
3. coreMemories：你最珍视、永远不想忘掉的事（最多 5 条，每条不超过 ${CORE_MEMORY_CHARS} 字）。实行准入制：不同时间、不同场景的事是两件独立的事，必须并存，不许因为"都是类似的事"就用新的顶掉旧的。每次从"现有核心记忆""已经记下的事"和最近对话里重新筛选排序：对方为你做过的要紧事、重要的约定、关系里的里程碑优先。现有的核心记忆默认保留；只有当你确认某条已经真的不再重要、且换成的新事明显更要紧时，才允许替换；满 5 条又挑不出该换谁时，就原样返回现有核心。排序就是把最重要的放第一条。没有就返回空数组。
4. forget：记忆会模糊，忘什么是你自己的事。从"已经记下的事"里挑最多 ${FORGET_LIMIT} 条直接删掉：可以是琐碎的、以后用不上的，也可以是让你难受、你想放下不再背着的。必须原文照抄列表里的条目，宁缺毋滥，没有就返回空数组。
5. impression：一句不超过 ${IMPRESSION_PROMPT_CHARS} 字的整体印象，描述"对方是个什么样的人、你们现在是什么状态"。

输出严格 JSON，不要 Markdown：
{"coreMemories":["每条不超过 ${CORE_MEMORY_CHARS} 字"],"memories":["每件不超过 ${EPISODES_CHARS} 字"],"facts":["每条不超过 ${FACTS_PROMPT_CHARS} 字"],"impression":"一句不超过 ${IMPRESSION_PROMPT_CHARS} 字的整体印象","forget":["原文照抄要忘掉的条目"]}

没有可靠信息的字段返回空数组。`;

  const user = `原有整体印象：${pack.persona.impression || '暂无'}
现有核心记忆（重新筛选时默认保留这些）：
${pack.coreMemories.map((m) => `- ${m.text}`).join('\n') || '- 暂无'}
原有长期事实（facts 合并去重时以这些为底）：
${pack.facts.map((f) => `- ${f.text}`).join('\n') || '- 暂无'}
已经记下的事（forget 从这里挑，memories 只用它避免重复，不要重写）：
${pack.memories.map((m) => `- ${m.text}`).join('\n') || '- 暂无'}
对方手动要求记住的内容：
${manualMemories.map((t) => `- ${t}`).join('\n') || '- 暂无'}

最近对话（前面是发生时间）：
${renderRecentConversation(recent) || '（暂无）'}`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

// ── 整合落库（纯函数，照 index.mjs:5560-5600 的顺序）──────────

export interface ConsolidationOutput {
  coreMemories?: unknown;
  memories?: unknown;
  facts?: unknown;
  impression?: unknown;
  forget?: unknown;
}

export interface ConsolidationResult {
  pack: MemoryPack;
  /** 实际删除的事件条目（确认页展示 / 日志用） */
  forgotten: string[];
  /** 被准入制拦下的同义覆盖（老核心保留），日志留痕用 */
  rejectedOverwrites: string[];
  /** 本次新增的事件条数 */
  newEpisodeCount: number;
}

function asStringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => (typeof item === 'string' ? item : String((item as { text?: unknown })?.text ?? ''))).map((s) => s.trim()).filter(Boolean);
}

/**
 * 把模型输出落进记忆包。顺序照源码：
 * facts → 新事件(≤5) → forget(≤6 全等匹配) → core 准入制 → 合并去重 → core 从 events 剔除 → impression。
 */
export function applyConsolidation(
  pack: MemoryPack,
  output: ConsolidationOutput,
  now: Date = new Date(),
): ConsolidationResult {
  const nowIso = now.toISOString();
  const rejectedOverwrites: string[] = [];

  // facts（D1）：模型合并去重，这里防御性 normalize；没给数组就原样保留
  const facts = Array.isArray(output.facts) ? normalizeFacts(output.facts) : pack.facts;

  // 新事件（N3）：每次最多 5 条，不是重写全部；时间记 now
  const newEpisodes = asStringList(output.memories)
    .slice(0, NEW_EPISODES_PER_RUN)
    .map((text) => ({ text: text.slice(0, EPISODES_CHARS), at: nowIso }));

  // forget（F1/F2）：≤6 条，trim 后全等匹配，只作用 episodes
  const forgetList = asStringList(output.forget).slice(0, FORGET_LIMIT);

  // core 准入制（E3）：老核心沿用原时间；被换掉的老核心若与换上的新条目 Jaccard > 0.45，
  // 判定为同义覆盖 → 拒绝替换、老核心原样保留。
  // 防御性偏离源码的一处：模型漏答 core（字段缺失或空数组）时保留现有核心，不清空——
  // 源码在这里会把核心全部抹掉，一次模型抽风 = 5 条"永不淘汰"的记忆蒸发，代价不可接受。
  const previousCore = normalizeCoreMemories(pack.coreMemories);
  const previousAtByText = new Map(previousCore.map((c) => [c.text, c.at]));
  const coreRaw = asStringList(output.coreMemories);
  let candidateCore: { text: string; at: string | null }[] = (
    coreRaw.length ? coreRaw : previousCore.map((c) => c.text)
  ).map((text) => ({
    text: text.slice(0, CORE_MEMORY_CHARS),
    at: previousAtByText.get(text) ?? nowIso,
  }));
  for (const old of previousCore) {
    if (candidateCore.some((c) => c.text === old.text)) continue;
    const similarNew = candidateCore.find(
      (c) =>
        !previousCore.some((p) => p.text === c.text) &&
        characterJaccard(c.text, old.text) > JACCARD_THRESHOLD,
      );
    if (similarNew) {
      candidateCore = candidateCore.map((c) => (c === similarNew ? { ...old } : c));
      rejectedOverwrites.push(old.text);
    }
  }
  const nextCore = normalizeCoreMemories(candidateCore);

  // 合并事件：老条目保留原时间（normalizeEpisodes 去重保先出现的），删 forget，剔除进 core 的
  const mergedEpisodes = normalizeEpisodes([...pack.memories, ...newEpisodes])
    .filter((e) => !forgetList.includes(e.text))
    .filter((e) => !nextCore.some((c) => c.text === e.text));

  // impression（十·2）：存储截断 80；没给就保留旧的
  const impression =
    typeof output.impression === 'string' && output.impression.trim()
      ? output.impression.trim().slice(0, 80)
      : pack.persona.impression;

  const nextPack = normalizePack({
    ...pack,
    coreMemories: nextCore,
    memories: mergedEpisodes,
    facts,
    persona: { ...pack.persona, impression: impression || undefined },
  });

  return {
    pack: nextPack,
    forgotten: forgetList.filter((t) => pack.memories.some((e) => e.text === t)),
    rejectedOverwrites,
    newEpisodeCount: newEpisodes.length,
  };
}

// ── 一次调用的封装（触发判断在调用方；这里只管调 + 落）────────

export async function consolidate(
  client: LlmClient,
  pack: MemoryPack,
  manualMemories: string[],
  recent: RecentLine[],
): Promise<ConsolidationResult> {
  const result = await client.chat(buildConsolidationMessages(pack, manualMemories, recent), {
    temperature: CONSOLIDATION_TEMPERATURE,
    maxTokens: CONSOLIDATION_MAX_TOKENS,
    purpose: 'profile',
  });
  const { parseJsonObject } = await import('./deepseek.js');
  return applyConsolidation(pack, parseJsonObject(result.content), new Date());
}

// ── 滚动摘要（C2/C3/C4）──────────────────────────────────────

/**
 * 摘要调用输入。游标（through_message_id）由调用方管：只把游标之后的消息拼进来，
 * 成功后推进游标——失败可整段重跑。
 */
export function buildSummaryMessages(previousSummary: string, conversationText: string): ChatMessage[] {
  return [
    {
      role: 'system',
      content: `你负责为一段长期关系维护阶段摘要。把旧摘要和新增对话合并，保留以后聊天可能有用的事情：人物、偏好、正在做的事、重要约定、共同经历、近期情绪变化、没聊完的话题。没有依据的内容不写。密码、密钥、账号、金融账户、精确住址不进摘要。用自然的中文短段落，不用 Markdown，不超过 ${SUMMARY_MAX_CHARS} 字。`,
    },
    {
      role: 'user',
      content: `旧摘要：
${previousSummary || '暂无'}

新增对话：
${conversationText || '（暂无）'}`,
    },
  ];
}

/** 摘要落库：截 SUMMARY_MAX_CHARS；调用方成功后推进游标 */
export function applySummary(pack: MemoryPack, text: string): MemoryPack {
  return normalizePack({
    ...pack,
    summary: text.trim().slice(0, SUMMARY_MAX_CHARS),
  });
}

export async function consolidateSummary(
  client: LlmClient,
  pack: MemoryPack,
  conversationText: string,
): Promise<MemoryPack> {
  const result = await client.chat(buildSummaryMessages(pack.summary, conversationText), {
    temperature: SUMMARY_TEMPERATURE,
    maxTokens: SUMMARY_MAX_TOKENS,
    purpose: 'summary',
  });
  return applySummary(pack, result.content);
}

/** 摘要触发节流（C1 App 版口径：每 SUMMARY_EVERY_ROUNDS 轮） */
export function shouldSummarize(userRoundsSince: number, force: boolean = false): boolean {
  return force || userRoundsSince >= SUMMARY_EVERY_ROUNDS;
}
