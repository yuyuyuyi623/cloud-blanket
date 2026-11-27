/**
 * engine/persona-distill.ts —— 身世文档通道（附件进蒸馏方案 2026-11-27 §3.1 A 路）
 *
 * 为什么单独一条通道、不混进对话块：
 *   对话块是"从聊天抽记忆"的工具，拿它去蒸一份角色设定会产出 60 条零碎事件、
 *   把 episodes 池子塞满，而设定本身（她是谁、从哪来）反而被拆散。
 *   所以身世文档走自己的分块 → 汇总，只产出两件东西：persona 卡 + backstory 身世档案。
 *
 * 纪律：
 *   - 不进 episodes / facts 池（append-only 红线，方案 §六·1）；
 *   - 不设 2 万字上限（30 万字约 15 块 ≈ ¥0.39 谷价），整包 100 万字封顶在读取层；
 *   - 提示词只归纳"文档里写了什么"，不替作者加戏、不写示范句；
 *   - 汇总冲突处理：明确写出的设定为准，判断不了就并列写清，不静默取一半。
 */

import {
  BACKSTORY_MAX_CHARS,
  DISTILL_BLOCK_RETRIES,
  DISTILL_BLOCK_WORDS,
  DISTILL_CONCURRENCY,
  DISTILL_MAX_TOKENS,
  DISTILL_SUMMARIZE_MAX_TOKENS,
  DISTILL_TIMEOUT_MS,
  CONSOLIDATION_TEMPERATURE,
  PERSONA_MAX_CHARS,
  TEXT_OVERFLOW_RATIO,
} from './config.js';
import { softClip } from './brief.js';
import { personaDocChunks, type AttachmentDoc } from './attachment-scan.js';
import { type ChatMessage, type LlmClient, LlmError, parseJsonObject } from './deepseek.js';

/** personaDocChunks 的产物：一块身世正文 + 它来自哪个文件 */
type PersonaChunk = { text: string; from: string };

export interface PersonaDistillProgress {
  done: number;
  total: number;
}

export interface PersonaDistillResult {
  /** persona 卡（≤PERSONA_MAX_CHARS，确认页可改） */
  personaCard: string;
  /** 身世档案（≤BACKSTORY_MAX_CHARS，确认页可改） */
  backstory: string;
  /** 实际调用的 token 总量（账本实记用） */
  usage: { promptTokens: number; completionTokens: number };
}

/** 分块提示词：只归纳设定文档，不评价、不发挥 */
export function buildPersonaBlockMessages(chunk: PersonaChunk): ChatMessage[] {
  const system = `你负责从一份角色设定文档里整理人物档案。文档是作者写的设定，你只做归纳整理，不补充、不发挥、不替作者加戏。

整理两样：
1. persona：这部分设定能看出"她"是谁——身份、性格、口吻和称呼习惯、在乎什么、怎么对待对方、和他人的关系。每条一句话，不超过 120 字，一条写一个侧面。
2. backstory：这部分设定交代的身世、经历、时代与世界背景，按时间顺序写成连贯的中文叙述，保留具体的人名、地名、事件。

密码、密钥、账号、支付信息、精确住址不进任何字段。设定里没写的内容不写。

输出严格 JSON，不要 Markdown：
{"persona":["..."],"backstory":"..."}`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: `设定文档（${chunk.from}）：\n${chunk.text}` },
  ];
}

interface PersonaBlockResult {
  persona: string[];
  backstory: string;
  usage?: { promptTokens?: number; completionTokens?: number };
}

async function distillPersonaBlock(client: LlmClient, chunk: PersonaChunk): Promise<PersonaBlockResult> {
  const result = await client.chat(buildPersonaBlockMessages(chunk), {
    temperature: CONSOLIDATION_TEMPERATURE,
    maxTokens: DISTILL_MAX_TOKENS,
    purpose: 'persona-block',
    timeoutMs: DISTILL_TIMEOUT_MS,
    retries: 1,
  });
  const o = parseJsonObject(result.content);
  const persona = Array.isArray(o.persona)
    ? (o.persona as unknown[])
        .map((x) => (typeof x === 'string' ? x.trim() : String((x as { text?: unknown })?.text ?? '').trim()))
        .filter(Boolean)
        .slice(0, 40)
    : [];
  return {
    persona,
    backstory: typeof o.backstory === 'string' ? o.backstory.trim() : '',
    usage: { promptTokens: result.promptTokens, completionTokens: result.completionTokens },
  };
}

/** 一块失败单独重试（同对话块口径：只重试超时/网络/无 JSON，别叠加 429 重试） */
const PERSONA_RETRYABLE: ReadonlySet<string> = new Set(['timeout', 'network', 'no-json', 'empty']);

async function distillPersonaBlockWithRetry(client: LlmClient, chunk: PersonaChunk): Promise<PersonaBlockResult> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await distillPersonaBlock(client, chunk);
    } catch (e) {
      const retryable = e instanceof LlmError && PERSONA_RETRYABLE.has(e.kind) && attempt < DISTILL_BLOCK_RETRIES;
      if (!retryable) throw e;
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
    }
  }
}

/** 汇总提示词：把各块整理结果合成 persona 卡 + 身世档案 */
export function buildPersonaSummarizeMessages(blocks: PersonaBlockResult[]): ChatMessage[] {
  const material = blocks
    .map((b, i) => {
      return `── 第 ${i + 1} 部分 ──
人物侧写：
${b.persona.map((p) => `- ${p}`).join('\n') || '- （无）'}

身世叙述：
${b.backstory || '（无）'}`;
    })
    .join('\n\n');

  const system = `你负责把多段整理结果合成一份人物底稿。原料来自同一份设定文档的不同部分或不同文件，按给出的顺序给全。

产出：
1. persona：一张完整的人格卡（不超过 ${PERSONA_MAX_CHARS} 字），写清她是谁、口吻和称呼习惯、说话风格、在乎什么、和对方的关系怎么走到今天。只用原料里有依据的内容；不同文件互相冲突时，以明确写出的设定为准，判断不了就并列写清，不静默取一半。
2. backstory：身世档案（不超过 ${BACKSTORY_MAX_CHARS} 字），按时间顺序写她的来历、经历、时代与世界设定，保留具体的人名、地名、事件。这是背景资料，不是人物介绍——只写发生过什么、世界是什么样，不重复 persona 里的性格评价。

密码、密钥、账号、支付信息、精确住址不进任何字段。原料里没有的内容不写。

输出严格 JSON，不要 Markdown：
{"persona":"...","backstory":"..."}`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: `整理结果：\n\n${material}` },
  ];
}

/**
 * 跑完整条身世通道：分块（2 万字）→ 并发 DISTILL_CONCURRENCY 路 → 汇总。
 * 某块彻底失败直接抛（同对话块纪律：少一块就是少一段身世，不许静默跳过）。
 */
export async function runPersonaDistill(
  client: LlmClient,
  docs: AttachmentDoc[],
  opts: { onProgress?: (p: PersonaDistillProgress) => void } = {},
): Promise<PersonaDistillResult> {
  const chunks = personaDocChunks(docs, DISTILL_BLOCK_WORDS);
  if (!chunks.length) {
    return { personaCard: '', backstory: '', usage: { promptTokens: 0, completionTokens: 0 } };
  }

  const results: PersonaBlockResult[] = new Array(chunks.length);
  let cursor = 0;
  let done = 0;
  opts.onProgress?.({ done, total: chunks.length });

  const worker = async () => {
    for (;;) {
      const i = cursor++;
      const chunk = chunks[i];
      if (!chunk) return;
      results[i] = await distillPersonaBlockWithRetry(client, chunk);
      done += 1;
      opts.onProgress?.({ done, total: chunks.length });
    }
  };
  await Promise.all(Array.from({ length: Math.min(DISTILL_CONCURRENCY, chunks.length) }, () => worker()));

  const summarize = await client.chat(buildPersonaSummarizeMessages(results), {
    temperature: CONSOLIDATION_TEMPERATURE,
    maxTokens: DISTILL_SUMMARIZE_MAX_TOKENS,
    purpose: 'persona-summarize',
    timeoutMs: DISTILL_TIMEOUT_MS,
  });
  const o = parseJsonObject(summarize.content);

  const usage = [...results, { usage: { promptTokens: summarize.promptTokens, completionTokens: summarize.completionTokens } }].reduce(
    (acc, r) => ({
      promptTokens: acc.promptTokens + (r.usage?.promptTokens ?? 0),
      completionTokens: acc.completionTokens + (r.usage?.completionTokens ?? 0),
    }),
    { promptTokens: 0, completionTokens: 0 },
  );

  return {
    personaCard:
      typeof o.persona === 'string' ? softClip(o.persona.trim(), PERSONA_MAX_CHARS, TEXT_OVERFLOW_RATIO) : '',
    backstory:
      typeof o.backstory === 'string' ? softClip(o.backstory.trim(), BACKSTORY_MAX_CHARS, TEXT_OVERFLOW_RATIO) : '',
    usage,
  };
}
