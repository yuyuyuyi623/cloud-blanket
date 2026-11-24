/**
 * estimate.ts 行为测试。
 *
 * 重点不是"数字精确"，是三条口径不能悄悄坏掉：
 *   1. 空计划返回全零、不抛错（"还没选"不是错误）；
 *   2. 块数 = 各行之和，调用数 = 块数 + 1；
 *   3. 钱和时间的量级对得上——真样本 81.6 万字/41 块应落在 ¥0.5~1.2、3~10 分钟（并发 8）。
 */
import { describe, expect, it } from 'vitest';
import { describeEstimate, estimateDistill, roughBlocks, type PlanRow } from '../engine/estimate.js';
import { DISTILL_CONCURRENCY } from '../engine/config.js';

function row(over: Partial<PlanRow> = {}): PlanRow {
  return { sessionId: 's1', title: '一段对话', userTurns: 100, words: 20000, blocks: 1, ...over };
}

describe('estimateDistill', () => {
  it('空计划：全零，不抛错', () => {
    const e = estimateDistill([]);
    expect(e.totalSessions).toBe(0);
    expect(e.totalBlocks).toBe(0);
    expect(e.totalCalls).toBe(0);
    expect(e.costCny).toBe(0);
    expect(e.minutes).toBe(0);
  });

  it('块数相加，调用数 = 块数 + 1（那次汇总）', () => {
    const e = estimateDistill([
      row({ sessionId: 'a', blocks: 3, words: 60000 }),
      row({ sessionId: 'b', blocks: 2, words: 38000 }),
    ]);
    expect(e.totalSessions).toBe(2);
    expect(e.totalWords).toBe(98000);
    expect(e.totalBlocks).toBe(5);
    expect(e.totalCalls).toBe(6);
  });

  it('真样本量级：81.6 万字 / 41 块 → ¥0.5~1.2、3~10 分钟（并发 8）', () => {
    const e = estimateDistill([row({ words: 816000, blocks: 41 })]);
    expect(e.costCny).toBeGreaterThan(0.5);
    expect(e.costCny).toBeLessThan(1.2);
    // 并发 8 之后，41 块约 6 分钟——不再是十几分钟
    expect(e.minutes).toBeGreaterThanOrEqual(3);
    expect(e.minutes).toBeLessThanOrEqual(10);
  });

  it('块越多越贵，严格单调', () => {
    const small = estimateDistill([row({ blocks: 2, words: 40000 })]);
    const big = estimateDistill([row({ blocks: 20, words: 400000 })]);
    expect(big.costCny).toBeGreaterThan(small.costCny);
    expect(big.inputTokens).toBeGreaterThan(small.inputTokens);
  });

  it('最后一块字数偏少时不会把均价算高（按真实字数除）', () => {
    // 同一总字数，块数多的那份每块更短，单块输入 token 应更低
    const fewBig = estimateDistill([row({ blocks: 2, words: 40000 })]);
    const manySmall = estimateDistill([row({ blocks: 4, words: 40000 })]);
    const perBlockFew = fewBig.inputTokens / fewBig.totalBlocks;
    const perBlockMany = manySmall.inputTokens / manySmall.totalBlocks;
    expect(perBlockMany).toBeLessThan(perBlockFew);
  });

  it('耗时按并发折算', () => {
    const blocks = DISTILL_CONCURRENCY * 2;
    const e = estimateDistill([row({ blocks, words: blocks * 20000 })]);
    // (17 次 / 8 路) × 60s = 127.5s → 向上取整 3 分钟
    expect(e.minutes).toBe(3);
  });
});

describe('describeEstimate', () => {
  it('一句话里三个数字都在，钱两位小数', () => {
    const s = describeEstimate(estimateDistill([row({ blocks: 41, words: 816000 })]));
    expect(s).toMatch(/41 块/);
    expect(s).toMatch(/¥\d+\.\d{2}/);
    expect(s).toMatch(/\d+ 分钟/);
  });
});

describe('roughBlocks', () => {
  it('不足一块算一块，正好整除不多算', () => {
    expect(roughBlocks(0)).toBe(1);
    expect(roughBlocks(1)).toBe(1);
    expect(roughBlocks(20000)).toBe(1);
    expect(roughBlocks(20001)).toBe(2);
    expect(roughBlocks(816000)).toBe(41);
  });
});
