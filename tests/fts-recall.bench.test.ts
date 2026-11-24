/**
 * FTS 召回质量实测（M0 核心风险项）
 *
 * 背景：柔光 33 天报告显示 FTS 在主对话零调用，云朵被子的"检索注入动态段"
 * 是无实战背书的新设计。本测试用蒸馏原料（约 70 万字真实对话语料）验证
 * engine/fts.ts 的检索质量，验收口径："问蒸馏范围外的旧事"能不能兜住。
 *
 * 四套测量：
 *   A 关键词问法（理想）：从语料自动抽"有区分度的词"拼查询，测 recall@5/@8、MRR；
 *   B 自然语言整句：把同样的词嵌进口语模板，测 AND 语义在真实问法下的空结果率；
 *   C 范围外问题：问语料里肯定没有的事，测误召回率（非空结果 = 会注入垃圾）；
 *   D 性能：建索引耗时、检索延迟 avg/p95、索引规模。
 *
 * 隐私纪律：本文件只含通用模板与路径，不含任何语料原文；语料在 local/（gitignore）。
 * 语料缺失时整组跳过（本测试只在有语料的机器上跑）。
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InvertedIndex, budgetSearchResults, searchMemory, tokenize } from '../engine/fts.js';
import { buildTerms } from '../engine/query-rewrite.js';
import type { SearchResult } from '../engine/fts.js';
import { buildDynamicSegment } from '../engine/context.js';

// 语料在仓库根 local/（gitignore，隐私纪律）；根目录与 fork/ 两种位置都探测
const CORPUS_CANDIDATES = [
  join(__dirname, '..', 'local', '蒸馏原料'),
  join(__dirname, '..', '..', '..', 'local', '蒸馏原料'),
];
const CORPUS_DIR = CORPUS_CANDIDATES.find((p) => existsSync(p)) ?? CORPUS_CANDIDATES[0];
const hasCorpus = existsSync(CORPUS_DIR);
const d = hasCorpus ? describe : describe.skip;

// ── 语料解析 ─────────────────────────────────────────────────

interface CorpusMessage {
  sessionId: string;
  messageIndex: number;
  text: string;
  at: string;
}

/** 按"──── 你/她 · 时间戳"切分消息；文件头部（════ 标题块）丢弃 */
function parseCorpus(): CorpusMessage[] {
  const messages: CorpusMessage[] = [];
  const files = readdirSync(CORPUS_DIR).filter((f) => f.endsWith('.txt')).sort();
  for (const file of files) {
    const sessionId = file.replace(/\.txt$/, '');
    const content = readFileSync(join(CORPUS_DIR, file), 'utf8');
    const lines = content.split(/\r?\n/);
    let current: { text: string[]; at: string } | null = null;
    let index = 0;
    const flush = () => {
      if (current && current.text.join('\n').trim()) {
        messages.push({
          sessionId,
          messageIndex: index++,
          text: current.text.join('\n').trim(),
          at: current.at,
        });
      }
    };
    for (const line of lines) {
      const m = /^──── (?:你|她) · (\d{4}-\d{2}-\d{2} \d{2}:\d{2})/.exec(line);
      if (m) {
        flush();
        current = { text: [], at: m[1]! };
      } else if (current) {
        current.text.push(line);
      }
    }
    flush();
  }
  return messages;
}

// ── 确定性采样（可复现，不引入随机测试抖动）──────────────────

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── 指标统计 ─────────────────────────────────────────────────

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

function recallAtK(ranks: number[], k: number): number {
  if (!ranks.length) return 0;
  return ranks.filter((r) => r <= k).length / ranks.length;
}

function mrr(ranks: number[]): number {
  if (!ranks.length) return 0;
  return ranks.reduce((sum, r) => sum + (r > 0 ? 1 / r : 0), 0) / ranks.length;
}

// ── 测试 ─────────────────────────────────────────────────────

d('FTS 召回实测（蒸馏原料语料）', () => {
  const messages = parseCorpus();
  const index = new InvertedIndex();
  let buildMs = 0;
  let searchMs: number[] = [];

  it('建索引：全量消息入库，规模合理', () => {
    expect(messages.length).toBeGreaterThan(1000);
    const t0 = performance.now();
    for (const msg of messages) {
      index.add(msg.sessionId, msg.messageIndex, msg.text, msg.at);
    }
    buildMs = performance.now() - t0;
    const stats = index.stats();
    // eslint-disable-next-line no-console
    console.log(
      `[D] 索引规模：${stats.docs} 条消息 / ${stats.terms} 个词条 / 建索引 ${buildMs.toFixed(0)}ms / 语料 ${(messages.reduce((s, m) => s + m.text.length, 0) / 10000).toFixed(1)} 万字`
    );
    expect(stats.docs).toBe(messages.length);
  });

  /** 从语料里抽"有区分度的查询词对"：doc 频率在 2 ~ 5% 之间的词，取消息内 tf×idf 最高者 */
  function pickTerms(msg: CorpusMessage, df: Map<string, number>, rand: () => number): [string, string] | null {
    const seen = new Set<string>();
    const scored: { term: string; score: number }[] = [];
    for (const term of new Set(tokenize(msg.text))) {
      if (seen.has(term) || term.length < 2) continue;
      seen.add(term);
      const freq = df.get(term) ?? 0;
      if (freq < 2 || freq > messages.length * 0.05) continue;
      const idf = Math.log(messages.length / freq);
      const tf = (msg.text.match(new RegExp(term, 'g')) ?? []).length;
      scored.push({ term, score: idf * tf });
    }
    if (scored.length < 2) return null;
    scored.sort((a, b) => b.score - a.score);
    // 前 5 名里随机取 2 个，避免全部命中同一批头部词
    const pool = scored.slice(0, 5);
    const i = Math.floor(rand() * pool.length);
    let j = Math.floor(rand() * pool.length);
    if (j === i) j = (i + 1) % pool.length;
    return [pool[i]!.term, pool[j]!.term];
  }

  function rankOfTarget(results: SearchResult[], target: CorpusMessage): number {
    return results.findIndex(
      (r) => r.sessionId === target.sessionId && r.messageIndex === target.messageIndex
    ) + 1; // 0 = 未命中
  }

  it('A 关键词问法：recall@5/@8 与 MRR', () => {
    // 先扫一遍词的 doc 频率
    const df = new Map<string, number>();
    for (const msg of messages) {
      for (const term of new Set(tokenize(msg.text))) df.set(term, (df.get(term) ?? 0) + 1);
    }
    const rand = mulberry32(20261123);
    const eligible = messages.filter((m) => m.text.length >= 50 && m.text.length <= 400);
    const sampled: { msg: CorpusMessage; terms: [string, string] }[] = [];
    const used = new Set<string>();
    for (let i = 0; i < 400 && sampled.length < 60 && i < eligible.length; i++) {
      const msg = eligible[Math.floor(rand() * eligible.length)]!;
      const key = `${msg.sessionId}:${msg.messageIndex}`;
      if (used.has(key)) continue;
      const terms = pickTerms(msg, df, rand);
      if (!terms) continue;
      used.add(key);
      sampled.push({ msg, terms });
    }
    expect(sampled.length).toBeGreaterThanOrEqual(40);

    const ranks: number[] = [];
    let empty = 0;
    for (const { msg, terms } of sampled) {
      const query = `${terms[0]} ${terms[1]}`;
      const t0 = performance.now();
      const results = index.search(query);
      searchMs.push(performance.now() - t0);
      if (!results.length) empty++;
      ranks.push(rankOfTarget(results, msg));
    }
    const hit = ranks.filter((r) => r > 0);
    // eslint-disable-next-line no-console
    console.log(
      `[A] 关键词问法 n=${sampled.length}：recall@5=${(recallAtK(ranks, 5) * 100).toFixed(1)}% recall@8=${(recallAtK(ranks, 8) * 100).toFixed(1)}% MRR=${mrr(ranks).toFixed(3)} 空结果率=${((empty / sampled.length) * 100).toFixed(1)}%`
    );
    // 理想问法下召回不能太差（低于 50% 说明检索零件本身不合格）
    expect(recallAtK(ranks, 8)).toBeGreaterThan(0.5);
    expect(hit.length).toBeGreaterThan(0);
  });

  it('B 自然语言整句：口语模板下的可用性', () => {
    const df = new Map<string, number>();
    for (const msg of messages) {
      for (const term of new Set(tokenize(msg.text))) df.set(term, (df.get(term) ?? 0) + 1);
    }
    const rand = mulberry32(1123);
    const eligible = messages.filter((m) => m.text.length >= 50 && m.text.length <= 400);
    const templates = [
      (x: string, y: string) => `我们之前说的${x}你还记得吗，就是关于${y}的`,
      (x: string, y: string) => `你还记得${x}吗？好像还提到过${y}`,
      (x: string, y: string) => `我们上次聊${x}聊到一半，还有${y}那部分`,
    ];
    const sampled: { msg: CorpusMessage; query: string }[] = [];
    const used = new Set<string>();
    for (let i = 0; i < 400 && sampled.length < 40 && i < eligible.length; i++) {
      const msg = eligible[Math.floor(rand() * eligible.length)]!;
      const key = `${msg.sessionId}:${msg.messageIndex}`;
      if (used.has(key)) continue;
      const terms = pickTerms(msg, df, rand);
      if (!terms) continue;
      used.add(key);
      sampled.push({ msg, query: templates[Math.floor(rand() * templates.length)]!(terms[0], terms[1]) });
    }
    expect(sampled.length).toBeGreaterThanOrEqual(30);

    let empty = 0;
    let top8Hit = 0;
    const hitRanks: number[] = [];
    const modes: Record<string, number> = {};
    for (const { msg, query } of sampled) {
      const { results, mode } = searchMemory(index, query);
      modes[mode] = (modes[mode] ?? 0) + 1;
      if (!results.length) {
        empty++;
        continue;
      }
      const rank = rankOfTarget(results, msg);
      if (rank > 0) {
        top8Hit++;
        hitRanks.push(rank);
      }
    }
    const avgRank = hitRanks.length
      ? hitRanks.reduce((s, r) => s + r, 0) / hitRanks.length
      : 0;
    // eslint-disable-next-line no-console
    console.log(
      `[B] 自然语言整句 n=${sampled.length}：空结果率=${((empty / sampled.length) * 100).toFixed(1)}% 目标进 top8=${((top8Hit / sampled.length) * 100).toFixed(1)}% 命中时平均排名=${avgRank.toFixed(1)} 路径=${JSON.stringify(modes)}`
    );
    // 复测标准（FTS 实测报告 §五）：口语问法空结果率 < 30%
    expect(empty / sampled.length).toBeLessThan(0.3);
    // 另加：口语问法下目标文档平均排名 ≤ 5（对齐柔光“高召回低精度”教训）
    expect(avgRank).toBeGreaterThan(0);
    expect(avgRank).toBeLessThanOrEqual(5);
  });

  it('C 范围外问题：误召回率（会注入垃圾吗）', () => {
    // 这些事在语料里肯定没有：通用的人类生活话题
    const outOfScope = [
      '我们第一次见面是什么时候',
      '我的生日是哪一天',
      '我们说好要去的那家火锅店',
      '你送我的第一件礼物是什么',
      '我养的那只猫叫什么名字',
      '我们两个人之间的暗号',
      '我们去过哪家电影院',
      '我上次发烧生病的事',
      '我家住的小区叫什么',
      '你给我起的昵称',
      '我们约好哪天视频通话',
      '我的工作单位在哪',
    ];
    let falsePositive = 0;
    const sampleSegments: string[] = [];
    for (const q of outOfScope) {
      const { results, mode } = searchMemory(index, q);
      if (results.length) {
        falsePositive++;
        // 诊断：命中路径 + top-1 得分，供阈值调参（调完 C 达标后可按需注释）
        const terms = buildTerms(q);
        // eslint-disable-next-line no-console
        console.log(
          `    [C-diag] 「${q}」mode=${mode} n=${results.length} top1.score=${results[0]!.score.toFixed(2)} terms=[${terms.join(',')}]`
        );
        if (sampleSegments.length < 3) {
          const seg = budgetSearchResults(results.slice(0, 3));
          sampleSegments.push(`「${q}」→ ${seg.text.slice(0, 120)}`);
        }
      }
    }
    // eslint-disable-next-line no-console
    console.log(
      `[C] 范围外问题 n=${outOfScope.length}：误召回=${falsePositive} 条（${((falsePositive / outOfScope.length) * 100).toFixed(1)}%）`
    );
    for (const s of sampleSegments) console.log(`    误注入样例：${s}`);
    // 误召回不致命（动态段有空结果兜底话术），但要量化。复测标准：≤ 2/12
    expect(falsePositive).toBeLessThanOrEqual(2);
    // 空结果时动态段必须优雅兜底，不能崩
    expect(buildDynamicSegment([])).toContain('没有想起相关的旧事');
  });

  it('D 性能：检索延迟', () => {
    const df = new Map<string, number>();
    for (const msg of messages) {
      for (const term of new Set(tokenize(msg.text))) df.set(term, (df.get(term) ?? 0) + 1);
    }
    const rand = mulberry32(999);
    const terms = [...df.entries()]
      .filter(([t, f]) => t.length >= 2 && f > 3 && f < messages.length * 0.2)
      .map(([t]) => t);
    expect(terms.length).toBeGreaterThan(100);
    const latencies: number[] = [];
    for (let i = 0; i < 100; i++) {
      const a = terms[Math.floor(rand() * terms.length)]!;
      const b = terms[Math.floor(rand() * terms.length)]!;
      const t0 = performance.now();
      index.search(`${a} ${b}`);
      latencies.push(performance.now() - t0);
    }
    const avg = latencies.reduce((s, v) => s + v, 0) / latencies.length;
    // eslint-disable-next-line no-console
    console.log(
      `[D] 检索延迟：avg=${avg.toFixed(2)}ms p95=${percentile(latencies, 95).toFixed(2)}ms max=${Math.max(...latencies).toFixed(2)}ms`
    );
    expect(avg).toBeLessThan(50);
  });
});
