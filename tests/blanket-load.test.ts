/**
 * 被子装配层测试（src/services/memory/load.ts）
 *
 * 数据源注入假实现，不碰 IndexedDB：这里要锁的是"蒸了哪些会话 → 索引覆盖哪些会话"、
 * "缺会话不炸"、"索引按被子缓存不重复重建"三件事。
 */

import { describe, expect, it } from 'vitest';
import { buildBlanketMemory, getBlanketMemory, invalidateBlanket } from '../src/services/memory/load.js';
import type { BlanketSource } from '../src/services/memory/load.js';
import type { BlanketRecord } from '../src/services/memory/blanket.js';
import type { Session, UserMessage } from '../src/services/chat/types.js';

const user = (id: string, content: string): UserMessage => ({
  id,
  role: 'user',
  content,
  files: [],
  createdAt: Date.parse('2026-01-01T10:00:00Z'),
});

const session = (id: string, contents: string[]): Session => ({
  id,
  title: id,
  createdAt: 0,
  updatedAt: 0,
  messages: contents.map((content, i) => user(`${id}-${i}`, content)),
});

const pack: BlanketRecord['pack'] = {
  version: 1,
  persona: { name: '阿柔', card: '话不多' },
  coreMemories: [],
  memories: [],
  facts: [],
  summary: '',
  diary: [],
};

const blanket = (over: Partial<BlanketRecord> = {}): BlanketRecord => ({
  id: 'b1',
  name: '阿柔',
  sessionIds: ['imported-1', 'imported-2'],
  pack,
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

const makeSource = (
  blankets: BlanketRecord[],
  sessions: Session[],
  blanketSessions: Session[] = []
): BlanketSource & { blanketCalls: number } => {
  let blanketCalls = 0;
  return {
    get blanketCalls() {
      return blanketCalls;
    },
    loadBlanket: async (id) => {
      blanketCalls += 1;
      return blankets.find((b) => b.id === id);
    },
    loadSession: async (id) => sessions.find((s) => s.id === id),
    loadBlanketSession: async (_blanketId, id) => blanketSessions.find((s) => s.id === id),
  };
};

describe('buildBlanketMemory', () => {
  it('索引覆盖蒸进来的全部会话', async () => {
    const source = makeSource(
      [blanket()],
      [session('imported-1', ['我们去看过一场电影']), session('imported-2', ['那天吃了火锅'])]
    );
    const loaded = await buildBlanketMemory('b1', source);
    expect(loaded?.memory.stats().docs).toBe(2);
    expect(loaded?.memory.retrieve('火锅').results[0]!.sessionId).toBe('imported-2');
  });

  it('被子自己的对话框也进索引（刚聊的内容也要能想起来）', async () => {
    const source = makeSource(
      [blanket({ chatSessionId: 'chat-1' })],
      [
        session('imported-1', ['很久以前的事']),
        session('chat-1', ['刚才说好周末去买蓝莓']),
      ]
    );
    const loaded = await buildBlanketMemory('b1', source);
    expect(loaded?.memory.stats().docs).toBe(2);
    expect(loaded?.memory.retrieve('蓝莓').results.length).toBeGreaterThan(0);
  });

  it('会话缺失只跳过，不抛错', async () => {
    const source = makeSource([blanket()], [session('imported-1', ['只剩这一段'])]);
    const loaded = await buildBlanketMemory('b1', source);
    expect(loaded?.memory.stats().docs).toBe(1);
  });

  it('被子不存在返回 undefined', async () => {
    const source = makeSource([], []);
    expect(await buildBlanketMemory('nope', source)).toBeUndefined();
  });

  it('chatSessionId 与 sessionIds 重复时不重复索引', async () => {
    const source = makeSource(
      [blanket({ chatSessionId: 'imported-1' })],
      [session('imported-1', ['同一段话'])]
    );
    const loaded = await buildBlanketMemory('b1', source);
    expect(loaded?.memory.stats().docs).toBe(1);
  });

  it('导入的原料会话只在被子存储里也能进索引', async () => {
    // 导入的会话不进 sessions（不淹没侧栏），正文单独存在 blanketSessions
    const source = makeSource(
      [blanket()],
      [session('imported-2', ['那天吃了火锅'])],
      [session('imported-1', ['很久以前约好去看海'])]
    );
    const loaded = await buildBlanketMemory('b1', source);
    expect(loaded?.memory.stats().docs).toBe(2);
    expect(loaded?.memory.retrieve('看海').results[0]!.sessionId).toBe('imported-1');
  });
});

describe('getBlanketMemory 缓存', () => {
  it('同一床被子只装配一次，重蒸/删被子后失效重建', async () => {
    const source = makeSource([blanket({ id: 'cache-case' })], [session('imported-1', ['火锅'])]);

    await getBlanketMemory('cache-case', source);
    await getBlanketMemory('cache-case', source);
    expect(source.blanketCalls).toBe(1);

    invalidateBlanket('cache-case');
    await getBlanketMemory('cache-case', source);
    expect(source.blanketCalls).toBe(2);
  });
});
