/**
 * engine/estimate.ts —— 蒸馏前先算账。
 *
 * 这一层只做算术，不发任何请求。存在的理由是那条硬约束：
 * **花钱之前先给你看数字。** 数字算错比不显示更糟，所以公式和真实调用参数共用同一批常量
 * （DISTILL_BLOCK_WORDS / PRICE_* / TOKENS_PER_CHAR 全来自 config.ts）。
 *
 * 估算的三处不确定，写在这里，也写在 UI 上：
 *   1. 中文 token 折算按 0.7/字，是保守值，实际可能低一些；
 *   2. 输出长度按"每块 2000 token"估，模型写短了就更便宜；
 *   3. 价格是 2026-11 的 deepseek-chat 非缓存价，官方调价则此处要跟着改。
 *
 * 范围声明（防误读）：本层只覆盖**蒸馏这一次性成本**。
 * 聊天的持续成本（每轮输入/输出/缓存命中）不在这里算——那由 App 内的账本盯：
 * `src/services/usage/ledger.ts`（计价）+ `LedgerPanel`（余额 + 逐笔明细），
 * 口径刻意保守（任一落峰记峰、无 usage 按 1 字 1 token 兜底、展示向上取整）。
 */

import {
  DISTILL_BLOCK_WORDS,
  DISTILL_CONCURRENCY,
  PRICE_INPUT_UNCACHED_PER_M,
  PRICE_OUTPUT_PER_M,
  TOKENS_PER_CHAR,
} from './config.js';

/** 每块调用的固定开销：提示词模板 + 时间头 + JSON 结构说明（估） */
export const BLOCK_PROMPT_OVERHEAD_TOKENS = 1000;
/** 每块典型产出：摘要 600 字 + 侧写 + 两类事实 + 事件，约 2000 token */
export const BLOCK_OUTPUT_TOKENS = 2000;
/** 汇总调用的输入：所有块产物堆在一起，粗估 8000 token */
export const SUMMARIZE_INPUT_TOKENS = 8000;
/** 汇总调用的产出：persona 2000 + 摘要 2000 + 事实 + 核心候选 */
export const SUMMARIZE_OUTPUT_TOKENS = 4000;
/**
 * 单次调用典型耗时（秒）。只用来把"等多久"换算成人话——
 * 实际受网络和模型排队影响，给的是数量级，不是承诺。
 *
 * 2026-11-22 从 45 调到 60：官方实测输出 100~250 tok/s、首字 0.6~5s，
 * 一块 2 万字输入 + 2000 token 输出实测多在 40~90 秒。按 45 报会低报，
 * 而"说 8 分钟、实际 20 分钟"比多说两分钟更伤。
 */
export const SECONDS_PER_CALL = 60;

/** 计划里的一行：一个会话会切成几块 */
export interface PlanRow {
  sessionId: string;
  title: string;
  userTurns: number;
  words: number;
  /** 由 chunkMessages 切出来的块数（调用方算好，这里只管加总） */
  blocks: number;
}

export interface DistillEstimate {
  rows: PlanRow[];
  totalSessions: number;
  totalWords: number;
  totalBlocks: number;
  /** 块调用 + 1 次汇总 */
  totalCalls: number;
  inputTokens: number;
  outputTokens: number;
  /** 人民币元，保留两位由 UI 决定 */
  costCny: number;
  /** 预估分钟数（向上取整，至少 1） */
  minutes: number;
}

/**
 * @param rows 已经切好块的行；空数组返回全零（不报错——"还没选"不是错误）
 */
export function estimateDistill(rows: PlanRow[]): DistillEstimate {
  const totalSessions = rows.length;
  const totalWords = rows.reduce((a, r) => a + r.words, 0);
  const totalBlocks = rows.reduce((a, r) => a + r.blocks, 0);

  if (totalBlocks === 0) {
    return {
      rows,
      totalSessions,
      totalWords,
      totalBlocks: 0,
      totalCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      costCny: 0,
      minutes: 0,
    };
  }

  // 平均每块多少字：用真实字数除，比直接拿 DISTILL_BLOCK_WORDS 更贴近实际
  // （最后一块常常只有几千字，按上限算会高估）
  const avgWordsPerBlock = totalWords / totalBlocks;
  const inputTokens =
    totalBlocks * (avgWordsPerBlock * TOKENS_PER_CHAR + BLOCK_PROMPT_OVERHEAD_TOKENS) +
    SUMMARIZE_INPUT_TOKENS;
  const outputTokens = totalBlocks * BLOCK_OUTPUT_TOKENS + SUMMARIZE_OUTPUT_TOKENS;

  const costCny =
    (inputTokens / 1e6) * PRICE_INPUT_UNCACHED_PER_M +
    (outputTokens / 1e6) * PRICE_OUTPUT_PER_M;

  // 向上取整：宁可多报一分钟，也别让用户觉得被低估（"说 3 分钟、实际 5 分钟"最败好感）
  const minutes = Math.max(
    1,
    Math.ceil(((totalBlocks + 1) / DISTILL_CONCURRENCY) * (SECONDS_PER_CALL / 60)),
  );

  return {
    rows,
    totalSessions,
    totalWords,
    totalBlocks,
    totalCalls: totalBlocks + 1,
    inputTokens,
    outputTokens,
    costCny,
    minutes,
  };
}

/** 给 UI 的一句话（"约 ¥0.79 · 41 块 · 16 分钟"），口径只在这里改 */
export function describeEstimate(e: DistillEstimate): string {
  return `${e.totalBlocks} 块 · 约 ¥${e.costCny.toFixed(2)} · 约 ${e.minutes} 分钟`;
}

/** 一个会话按 DISTILL_BLOCK_WORDS 大约切几块（不读正文时的快速估算，用于列表页提示） */
export function roughBlocks(words: number): number {
  return Math.max(1, Math.ceil(words / DISTILL_BLOCK_WORDS));
}
