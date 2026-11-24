/**
 * 查询改写层测试（engine/query-rewrite.ts）+ InvertedIndex.searchOr 行为测试
 * 改写层平移自柔光 memory.mjs，压单字名额为本侧唯一改动。
 */

import { describe, expect, it } from 'vitest';
import { buildQuery, buildSearchText, buildTerms, QUERY_TERM_LIMIT } from '../engine/query-rewrite.js';
import { InvertedIndex } from '../engine/fts.js';

describe('buildSearchText（柔光原样）', () => {
  it('中文按 1/2/3-gram 全铺', () => {
    const terms = buildSearchText('晚安').split(' ');
    expect(terms).toContain('晚');
    expect(terms).toContain('安');
    expect(terms).toContain('晚安');
    // 两字序列没有 3-gram
    expect(terms.filter((t) => t.length === 3)).toHaveLength(0);
  });

  it('三字序列产出 3-gram', () => {
    const terms = buildSearchText('好梦成真').split(' ');
    expect(terms).toContain('好梦成');
    expect(terms).toContain('梦成真');
  });

  it('英文转小写按词切，不上 n-gram', () => {
    const terms = buildSearchText('Hello World 42').split(' ');
    expect(terms).toContain('hello');
    expect(terms).toContain('world');
    expect(terms).toContain('42');
    expect(terms.filter((t) => t.includes('helloworld'))).toHaveLength(0);
  });

  it('标点断开 Han 序列（n-gram 不跨标点），大小写归一', () => {
    expect(buildSearchText('晚安。好梦！').split(' ')).toEqual(['晚', '安', '晚安', '好', '梦', '好梦']);
    expect(buildSearchText('ABC')).toBe(buildSearchText('abc'));
  });

  it('空输入返回空串', () => {
    expect(buildSearchText('')).toBe('');
    expect(buildSearchText('。。。')).toBe('');
  });
});

describe('buildTerms（压单字名额版）', () => {
  it('剔除停用词', () => {
    const terms = buildTerms('我们今天说什么这个那个');
    expect(terms).not.toContain('我们');
    expect(terms).not.toContain('什么');
    expect(terms).not.toContain('这个');
    expect(terms).not.toContain('那个');
    expect(terms).not.toContain('今天'); // 停用词表里含「今天」
  });

  it('单字名额最多 2 个，2/3-gram 优先占位', () => {
    // 6 个汉字 → 6 单字 + 5 双字 + 4 三字 = 15 个 term，全部超出单字名额也能填满
    const terms = buildTerms('好梦成真夜晚安');
    const singles = terms.filter((t) => [...t].length === 1 && /\p{Script=Han}/u.test(t));
    expect(singles.length).toBeLessThanOrEqual(2);
    // 双字在前
    expect(terms[0]!.length).toBe(2);
  });

  it('term 总数不超过 16', () => {
    const long = '这是一个特别特别长的句子'.repeat(20);
    expect(buildTerms(long).length).toBeLessThanOrEqual(QUERY_TERM_LIMIT);
  });

  it('无中文时英文词正常产出', () => {
    expect(buildTerms('remember my birthday party')).toContain('remember');
    expect(buildTerms('remember my birthday party')).toContain('birthday');
  });

  it('空输入返回空数组', () => {
    expect(buildTerms('')).toEqual([]);
  });

  it('纯口语虚词句子：双字全被停也能靠 n-gram/单字兜底', () => {
    const terms = buildTerms('什么怎么这个');
    expect(terms.length).toBeGreaterThan(0);
    const singles = terms.filter((t) => t.length === 1);
    expect(singles.length).toBeLessThanOrEqual(2);
  });
});

describe('buildQuery（FTS5 OR 语法）', () => {
  it('输出引号包裹的 OR 串，停用词不作为独立 term', () => {
    const q = buildQuery('记得那个火锅店吗');
    expect(q).toMatch(/"[^"]+" OR "/);
    // 含「那个」的 3-gram 可以存在，但独立的「那个」term 必须被停用词滤掉
    expect(q.split(' OR ')).not.toContain('"那个"');
  });

  it('term 内的引号被剥离', () => {
    expect(buildQuery('a"b')).not.toContain('""');
  });
});

describe('InvertedIndex.searchOr（OR+阈值降级）', () => {
  const index = new InvertedIndex();
  index.add('s1', 0, '昨晚我们一起去吃了火锅，辣得不行', '2026-01-01 10:00');
  index.add('s1', 1, '今天早上喝了豆浆，还有油条', '2026-01-02 09:00');
  index.add('s2', 0, '火锅店门口那只猫一直在睡觉', '2026-01-03 15:00');

  it('OR 语义：只命中部分 term 也能召回（AND 会空）', () => {
    // 「火锅」与「豆浆」不同时出现在任何一条消息里，AND 必空
    expect(index.search('火锅 豆浆')).toEqual([]);
    const results = index.searchOr(['火锅', '豆浆'], 8, { minMatch: 1, minScore: 0 });
    expect(results.length).toBeGreaterThan(0);
  });

  it('评分：命中更多 term 的文档排前面', () => {
    index.add('s3', 0, '火锅 豆浆 都爱', '2026-01-04 12:00');
    const results = index.searchOr(['火锅', '豆浆']);
    expect(results[0]!.sessionId).toBe('s3');
  });

  it('零垃圾阈值：命中 term 数不足 minMatch 返回空', () => {
    // 「油条」只与「豆浆」同现，单 term 命中 < minMatch=2 → 空
    const results = index.searchOr(['油条', '火锅'], 8, { minMatch: 2 });
    // s1:0 命中火锅（1 个 term）；s3 命中火锅；只有同时命中两个 term 的才留
    for (const r of results) {
      expect(r.sessionId).toBe('s3');
    }
  });

  it('空 term 列表返回空', () => {
    expect(index.searchOr([])).toEqual([]);
  });

  it('默认 minMatch=2：单 term 命中被过滤（零垃圾）', () => {
    // 「油条」只在 s1:1、「猫」只在 s2:0，没有任何文档同时命中两个 term → 空
    expect(index.searchOr(['油条', '猫'])).toEqual([]);
  });

  it('minScore 阈值：超高频 common term 单命中被过滤', () => {
    // 「一直」在 s2 出现，单 term + minMatch=1，但 idf 极低时 minScore 兜底
    const results = index.searchOr(['睡觉'], 8, { minMatch: 1, minScore: 1e9 });
    expect(results).toEqual([]);
  });
});
