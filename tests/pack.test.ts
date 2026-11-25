import { describe, expect, it } from 'vitest';

import { characterJaccard, isRoughOverwrite } from '../engine/jaccard.js';
import {
  CORE_MEMORY_LIMIT,
  EPISODES_LIMIT,
  EPISODES_PINNED_EARLIEST,
  FACTS_LIMIT,
  JACCARD_THRESHOLD,
  PERSONA_MAX_CHARS,
  SUMMARY_MAX_CHARS,
} from '../engine/config.js';
import {
  deserializePack,
  interleaveFacts,
  pickEpisodes,
  normalizeCoreMemories,
  normalizeEpisodes,
  normalizeFacts,
  normalizePack,
} from '../engine/pack.js';

describe('characterJaccard（E3，逐行移植自 emotion-state.mjs:2247）', () => {
  it('两边都空返回 1', () => {
    expect(characterJaccard('', '')).toBe(1);
    expect(characterJaccard('。。。', '！！！')).toBe(1);
  });

  it('完全相同返回 1', () => {
    expect(characterJaccard('用户养了一只猫', '用户养了一只猫')).toBe(1);
  });

  it('完全不同接近 0', () => {
    expect(characterJaccard('养猫', '跑步')).toBe(0);
  });

  it('中文按单字进集合（\p{L} 含 CJK）', () => {
    // "养猫" vs "猫养" —— 同字集，应返回 1
    expect(characterJaccard('养猫', '猫养')).toBe(1);
    // "养猫" vs "养猫狗" —— 交 2 / 并 3
    expect(characterJaccard('养猫', '养猫狗')).toBeCloseTo(2 / 3);
  });

  it('大小写与标点不参与', () => {
    expect(characterJaccard('He likes cats.', 'he likes cats')).toBe(1);
  });

  it('阈值行为：E3 语义', () => {
    const old = '他说连续加班三天我嘴上损他';
    const similar = '他连续加班三天的时候我嘴上损了他';
    expect(characterJaccard(similar, old)).toBeGreaterThan(JACCARD_THRESHOLD);
    expect(isRoughOverwrite(similar, old)).toBe(true);
  });
});

describe('normalizeCoreMemories（E1/E4）', () => {
  it('上限锁死 5 条', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ text: `核心记忆${i}` }));
    const out = normalizeCoreMemories(many);
    expect(out).toHaveLength(CORE_MEMORY_LIMIT);
    expect(out.every((m) => m.text.startsWith('核心记忆'))).toBe(true);
  });

  it('兼容纯字符串格式（E4：pack v1 前的旧格式）', () => {
    const out = normalizeCoreMemories(['她叫我羽翼', { text: '喜欢深夜聊天', at: '2026-01-12' }]);
    expect(out[0]).toEqual({ text: '她叫我羽翼', at: null });
    expect(out[1]).toEqual({ text: '喜欢深夜聊天', at: '2026-01-12' });
  });

  it('at 非合法时间置 null（十·3）', () => {
    const out = normalizeCoreMemories([{ text: 'a', at: '不是时间' }, { text: 'b', at: '' }]);
    expect(out[0]?.at).toBeNull();
    expect(out[1]?.at).toBeNull();
  });

  it('空 text 条目跳过', () => {
    expect(normalizeCoreMemories(['', '   ', { text: '' }, '真的一条'])).toHaveLength(1);
  });
});

describe('normalizeEpisodes（N1）', () => {
  it('超上限时分层保留：最早的最晚的都在，中间也有（不再 slice(-30)）', () => {
    const many = Array.from({ length: 120 }, (_, i) => ({ text: `事件${String(i).padStart(3, '0')}` }));
    const out = normalizeEpisodes(many);
    expect(out).toHaveLength(EPISODES_LIMIT);
    expect(out[0]?.text).toBe('事件000'); // 最早那条必须留
    expect(out.at(-1)?.text).toBe('事件119'); // 最近那条也留
    expect(out.some((e) => e.text === '事件060')).toBe(true); // 中段有人管
  });

  it('同文去重，老条目保留原时间（mergeProfileEpisodes 语义）', () => {
    const out = normalizeEpisodes([
      { text: '一起看了海', at: '2025-08-01' },
      { text: '一起看了海', at: '2026-11-01' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.at).toBe('2025-08-01');
  });

  it('每条截断 120 字（EPISODES_CHARS，不放宽）', () => {
    const long = '长'.repeat(300);
    const out = normalizeEpisodes([long]);
    expect(out[0]?.text).toHaveLength(120);
  });
});

describe('normalizeFacts（D1）', () => {
  it('去重 + 上限 30', () => {
    const many = Array.from({ length: 40 }, (_, i) => `事实${i}`);
    many.push('事实0');
    const out = normalizeFacts(many);
    expect(out).toHaveLength(FACTS_LIMIT);
    expect(out.filter((f) => f.text === '事实0')).toHaveLength(1);
  });

  it('每条截断 200 字（K3 放宽）', () => {
    const out = normalizeFacts(['长'.repeat(300)]);
    expect(out[0]?.text).toHaveLength(200);
  });

  it('kind 只认 user / relationship（D2）', () => {
    const out = normalizeFacts([
      { text: '用户养猫', kind: 'user' },
      { text: '用户是独生子女', kind: 'relationship' },
      { text: '乱写的 kind', kind: 'whatever' },
      { text: '纯字符串' },
    ]);
    expect(out[0]?.kind).toBe('user');
    expect(out[1]?.kind).toBe('relationship');
    expect(out[2]?.kind).toBeUndefined();
    expect(out[3]?.kind).toBeUndefined();
  });
});

describe('normalizePack / deserializePack（整包）', () => {
  it('缺字段给安全默认值，未知字段忽略（forward-compatible）', () => {
    const pack = normalizePack({
      version: 1,
      persona: { name: '她', card: '卡片', impression: '安静', futureField: '不认识' },
      unknownTopLevel: { whatever: true },
    });
    expect(pack.persona.name).toBe('她');
    expect(pack.persona.impression).toBe('安静');
    expect(pack.coreMemories).toEqual([]);
    expect(pack.memories).toEqual([]);
    expect(pack.facts).toEqual([]);
    expect(pack.summary).toBe('');
    expect(pack.diary).toEqual([]);
    expect((pack as unknown as Record<string, unknown>).unknownTopLevel).toBeUndefined();
  });

  it('impression 截断 80 字（十·2）', () => {
    const pack = normalizePack({ persona: { impression: '好'.repeat(200) } });
    expect(pack.persona.impression).toHaveLength(80);
  });

  it('diary 非法条目丢弃', () => {
    const pack = normalizePack({
      diary: [
        { date: '2026-11-22', text: '今天很好' },
        { date: '不是日期', text: '坏条目' },
        { date: '2026-11-21' },
        '不是对象',
      ],
    });
    expect(pack.diary).toHaveLength(1);
    expect(pack.diary[0]?.text).toBe('今天很好');
  });

  it('serialize → deserialize 往返无损', () => {
    const pack = normalizePack({
      persona: { name: '她', card: '卡' },
      coreMemories: [{ text: '核心', at: '2026-01-12' }],
      memories: [{ text: '事件', at: '2026-02-03' }],
      facts: [{ text: '事实', kind: 'user' }],
      summary: '摘要',
      diary: [{ date: '2026-03-04', text: '日记' }],
    });
    const back = deserializePack(JSON.stringify(pack));
    expect(back).toEqual(pack);
  });

  it('坏 JSON 报中文错，不抛原生异常', () => {
    expect(() => deserializePack('{oops')).toThrow(/记忆包不是合法 JSON/);
  });
});

describe('interleaveFacts（事实两类交替合并，2026-11-22 修正）', () => {
  it('两类各 20 条时，卡 30 条后是 15/15 —— 不再让关系事实饿死', () => {
    const user = Array.from({ length: 20 }, (_, i) => `他${i}`);
    const rel = Array.from({ length: 20 }, (_, i) => `我们${i}`);
    const facts = normalizeFacts(interleaveFacts(user, rel));
    expect(facts).toHaveLength(FACTS_LIMIT);
    expect(facts.filter((f) => f.kind === 'user')).toHaveLength(15);
    expect(facts.filter((f) => f.kind === 'relationship')).toHaveLength(15);
  });

  it('一类为空时，另一类独占 30 条（不浪费配额）', () => {
    const user = Array.from({ length: 40 }, (_, i) => `他${i}`);
    const facts = normalizeFacts(interleaveFacts(user, []));
    expect(facts).toHaveLength(FACTS_LIMIT);
    expect(facts.every((f) => f.kind === 'user')).toBe(true);
  });

  it('交替顺序：对方的在前、关系的紧跟着（导出时读着不乱）', () => {
    const out = interleaveFacts(['他1', '他2'], ['我们1']);
    expect(out.map((f) => f.kind)).toEqual(['user', 'relationship', 'user']);
  });
});

describe('长文不切半句（2026-11-22 真机导出：摘要断在"他担心秒哒没有AI客"）', () => {
  it('摘要超上限时收在句末，不是硬切在字中间', () => {
    const head = '一'.repeat(SUMMARY_MAX_CHARS - 10);
    const raw = head + '他担心秒哒没有AI客服，她给出三条通道。后面还有很长的内容。';
    const p = normalizePack({ summary: raw });
    expect(p.summary.endsWith('。')).toBe(true);
    expect(p.summary).toContain('AI客服');
    expect(p.summary.length).toBeGreaterThanOrEqual(SUMMARY_MAX_CHARS - 10);
  });

  it('人格卡同样收在句末', () => {
    const raw = '她'.repeat(PERSONA_MAX_CHARS - 5) + '说话直接。再往后是另一段。';
    const p = normalizePack({ persona: { card: raw } });
    expect(p.persona.card.endsWith('。')).toBe(true);
  });

  it('没有句读的纯字符长文原样保留（不制造半句）', () => {
    const raw = '字'.repeat(SUMMARY_MAX_CHARS + 500);
    const p = normalizePack({ summary: raw });
    expect(p.summary).toBe(raw.trim());
  });
});

describe('pickEpisodes（分层保留，2026-11-22：不再只留最近两三天）', () => {
  /** 21 块 × 8 条 = 168 条，按时间从 10-27 到 11-04 排好 */
  function timeline(n: number) {
    return Array.from({ length: n }, (_, i) => {
      const day = 27 + Math.floor((i * 8) / n); // 10-27 起，大致均匀推进
      return { text: `第${i}条`, at: `2026-10-${String(Math.min(day, 31)).padStart(2, '0')}` };
    });
  }

  it('168 条里留 30 条，且三段都有（不是只剩尾部）', () => {
    const all = timeline(168);
    const out = pickEpisodes(all);
    expect(out).toHaveLength(EPISODES_LIMIT);
    // 三段各 10：头段来自前 1/3，中段来自中间，尾段来自最后
    expect(out[0]).toEqual(all[0]);
    expect(out[out.length - 1]).toEqual(all[all.length - 1]);
    const mid = out[Math.floor(out.length / 2)]!;
    expect(all.indexOf(mid)).toBeGreaterThan(40);
    expect(all.indexOf(mid)).toBeLessThan(140);
  });

  it('保持原有先后顺序、不重复', () => {
    const all = timeline(168);
    const out = pickEpisodes(all);
    const idx = out.map((e) => all.indexOf(e));
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
    expect(new Set(idx).size).toBe(idx.length);
  });

  it('不足上限时一条不动（原样返回）', () => {
    const all = timeline(12);
    expect(pickEpisodes(all)).toEqual(all);
  });

  it('刚好等于上限也原样返回', () => {
    const all = timeline(EPISODES_LIMIT);
    expect(pickEpisodes(all)).toEqual(all);
  });

  it('换掉 slice(-30)：最后 30 条不再是唯一结果', () => {
    const all = timeline(168);
    const out = pickEpisodes(all);
    const tailOnly = all.slice(-EPISODES_LIMIT);
    expect(out).not.toEqual(tailOnly);
  });

  it('最早 5 条保底：无论采样怎么挑，怎么认识的都在（A3）', () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ text: `事件${i}` }));
    const out = pickEpisodes(many);
    for (let i = 0; i < EPISODES_PINNED_EARLIEST; i += 1) {
      expect(out.some((e) => e.text === `事件${i}`)).toBe(true);
    }
  });

  it('已进核心记忆的事件永远保留，不参与采样（A3）', () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ text: `事件${i}` }));
    const out = pickEpisodes(many, EPISODES_LIMIT, { isPinned: (e) => e.text === '事件150' });
    expect(out.some((e) => e.text === '事件150')).toBe(true);
    expect(out).toHaveLength(EPISODES_LIMIT);
  });

  it('normalizeEpisodes 走的是分层，不是切片', () => {
    const raw = Array.from({ length: 120 }, (_, i) => ({ text: `事件${i}`, at: '2026-11-02' }));
    const out = normalizeEpisodes(raw);
    expect(out).toHaveLength(EPISODES_LIMIT);
    expect(out[0]!.text).toBe('事件0'); // 最早的那条还在
  });
});
