/**
 * engine/consolidation.ts —— 巩固提示词 + 滚动摘要（运行时）
 *
 * 2026-11-25 v1.0.2「死路径清理」（拍板回复 三·②）：
 *   删掉 `shouldConsolidate` / `consolidate` / `applyConsolidation` 三条零引用死路径，
 *   以及它们带来的 forget 与"核心替换准入制"。App 的巩固走 `consolidationRunner`
 *   （append-only 红线：只增不删不改），把它俩留在 engine 里只会让下一个人照抄。
 *   现在本文件只剩两件事：`buildConsolidationMessages`（src 唯一在用的导出）+ 摘要四件套。
 *
 * 摘要四件套（buildSummaryMessages / applySummary / consolidateSummary / shouldSummarize）
 * 同样零引用，但处置属 v1.0.3（拍板回复 三·⑤：方向是"一年重写一次"或"用 impression
 * 取代"，不是滚动摘要），本轮不动。
 *
 * 提示词纪律（沿用柔光的教训）：
 *   1. 措辞中性，不写示范句（H1 红线：示范句会被模型照抄进人格）；
 *   2. persona 不在这层动（人格卡来自蒸馏 + 用户手改）；
 *   3. 纯函数，落库与并发保护由调用方负责。
 */

import {
  CORE_MEMORY_CHARS,
  EPISODES_CHARS,
  FACTS_PROMPT_CHARS,
  IMPRESSION_PROMPT_CHARS,
  NEW_EPISODES_PER_RUN,
  SUMMARY_EVERY_ROUNDS,
  SUMMARY_MAX_CHARS,
  SUMMARY_MAX_TOKENS,
  SUMMARY_TEMPERATURE,
} from './config.js';
import { normalizePack, type MemoryPack } from './pack.js';
import type { ChatMessage, LlmClient } from './deepseek.js';

// ── 整合提示词（骨架照源码，措辞重写；无示范句——H1 由单测钉死）──

export interface RecentLine {
  role: 'user' | 'assistant';
  text: string;
  at?: string | null;
}

/**
 * 模型输出形状。`forget` 自 v1.0.2 起不再由提示词产出（死路径清理），
 * 字段留着只是为了兼容旧日志回放与测试输入——合并侧一律忽略它。
 */
export interface ConsolidationOutput {
  coreMemories?: unknown;
  memories?: unknown;
  facts?: unknown;
  impression?: unknown;
  /** @deprecated v1.0.2 起不产出、不消费（append-only 红线） */
  forget?: unknown;
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
 * 巩固调用输入。manualMemories（"手动记住"通道）必须作为输入喂回模型，
 * 否则下一轮巩固就会把它吞掉（清单十·2，单测锁死）。
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
4. impression：一句不超过 ${IMPRESSION_PROMPT_CHARS} 字的整体印象，描述"对方是个什么样的人、你们现在是什么状态"。

输出严格 JSON，不要 Markdown：
{"coreMemories":["每条不超过 ${CORE_MEMORY_CHARS} 字"],"memories":["每件不超过 ${EPISODES_CHARS} 字"],"facts":["每条不超过 ${FACTS_PROMPT_CHARS} 字"],"impression":"一句不超过 ${IMPRESSION_PROMPT_CHARS} 字的整体印象"}

没有可靠信息的字段返回空数组。`;

  const user = `原有整体印象：${pack.persona.impression || '暂无'}
现有核心记忆（重新筛选时默认保留这些）：
${pack.coreMemories.map((m) => `- ${m.text}`).join('\n') || '- 暂无'}
原有长期事实（facts 合并去重时以这些为底）：
${pack.facts.map((f) => `- ${f.text}`).join('\n') || '- 暂无'}
已经记下的事（memories 只用它避免重复，不要重写）：
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

// ── 滚动摘要（C2/C3/C4）──────────────────────────────────────
// ⚠️ 四件套当前零引用（v1.0.3 处置，见文件头）。别在本轮接线——滚动摘要已被证伪。

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
