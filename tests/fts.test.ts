import { describe, expect, it } from 'vitest';

import { SEARCH_MAX_CHARS, SEARCH_MAX_RESULTS } from '../engine/config.js';
import { InvertedIndex, budgetSearchResults, tokenize } from '../engine/fts.js';

describe('tokenize（中文 bigram + 英文词）', () => {
  it('中文按双字组合', () => {
    expect(tokenize('晚安好梦')).toEqual(['晚安', '安好', '好梦']);
  });

  it('孤立单字也入索引', () => {
    expect(tokenize('猫')).toEqual(['猫']);
  });

  it('英文按词切并小写化', () => {
    expect(tokenize('Hello World')).toEqual(['hello', 'world']);
  });

  it('中英混合、标点丢弃；空格分隔的短中文段各自成 bigram', () => {
    expect(tokenize('我用 DeepSeek 聊天！')).toEqual(['我用', 'deepseek', '聊天']);
  });
});

describe('InvertedIndex（检索行为）', () => {
  function buildIndex() {
    const idx = new InvertedIndex();
    idx.add('s1', 0, '我们第一次去看海，那天风很大', '2025-08-01T10:00:00.000Z');
    idx.add('s1', 1, '后来你养了一只猫，取名汤圆', '2025-09-01T10:00:00.000Z');
    idx.add('s2', 0, '今天加班到很晚，猫在家里等我', '2026-11-01T23:00:00.000Z');
    idx.add('s3', 0, ' Completely unrelated English text about weather ', '2026-01-01T00:00:00.000Z');
    return idx;
  }

  it('AND 语义：两个词都命中才返回', () => {
    const idx = buildIndex();
    const r = idx.search('猫 家里');
    expect(r).toHaveLength(1);
    expect(r[0]?.sessionId).toBe('s2');
  });

  it('单 token 查询命中所有相关消息，按相关度排序', () => {
    const idx = buildIndex();
    const r = idx.search('猫');
    expect(r.length).toBe(2); // s1:1 与 s2:0
  });

  it('任一词全库无命中 → 空结果（不是 OR 噪声）', () => {
    const idx = buildIndex();
    expect(idx.search('猫 不存在的词')).toEqual([]);
  });

  it('单字中文查询降级扫描', () => {
    const idx = buildIndex();
    const r = idx.search('海');
    expect(r).toHaveLength(1);
    expect(r[0]?.text).toContain('看海');
  });

  it('英文查询大小写不敏感', () => {
    const idx = buildIndex();
    const r = idx.search('ENGLISH weather');
    expect(r).toHaveLength(1);
    expect(r[0]?.sessionId).toBe('s3');
  });

  it('limit 生效，默认取 config', () => {
    const idx = buildIndex();
    for (let i = 0; i < 20; i++) idx.add(`s${i}`, 0, `关于猫的第${i}条`, '');
    expect(idx.search('猫').length).toBe(SEARCH_MAX_RESULTS);
    expect(idx.search('猫', 3).length).toBe(3);
  });

  it('removeSession 删干净', () => {
    const idx = buildIndex();
    idx.removeSession('s1');
    expect(idx.search('看海')).toEqual([]);
    expect(idx.search('猫').map((r) => r.sessionId)).toEqual(['s2']);
    expect(idx.stats().docs).toBe(2);
  });

  it('重复 add 幂等', () => {
    const idx = buildIndex();
    idx.add('s1', 0, '我们第一次去看海，那天风很大', '2025-08-01T10:00:00.000Z');
    expect(idx.stats().docs).toBe(4);
  });
});

describe('budgetSearchResults（R2：8 条 / 1200 字）', () => {
  it('总字数超预算时按相关度截断', () => {
    const results = Array.from({ length: 20 }, (_, i) => ({
      sessionId: 's',
      messageIndex: i,
      text: '字'.repeat(150),
      at: '',
      score: 20 - i,
    }));
    const { used, text } = budgetSearchResults(results);
    // 每条 150+2 字符，1200 / 152 ≈ 7 条
    expect(used.length).toBeLessThan(SEARCH_MAX_RESULTS);
    expect(text.length).toBeLessThanOrEqual(SEARCH_MAX_CHARS);
  });

  it('长消息截到 200 字加省略号', () => {
    const { used } = budgetSearchResults([
      { sessionId: 's', messageIndex: 0, text: '长'.repeat(500), at: '', score: 1 },
    ]);
    expect(used).toHaveLength(1);
    expect(used[0]!.text).toHaveLength(500);
  });

  it('空结果给空文本', () => {
    const { text, used } = budgetSearchResults([]);
    expect(text).toBe('');
    expect(used).toEqual([]);
  });
});
