/**
 * 被子记忆层测试（src/services/memory/blanket.ts）
 *
 * 这层的职责：会话消息 → 可检索文档 → 三路降级检索 → 动态段。
 * 用真实 engine 检索器（不是 mock），因为要锁住"文本进得去、旧事找得回"这条链路。
 */

import { describe, expect, it } from 'vitest';
import {
  BlanketMemory,
  messageText,
  sessionDocs,
  type BlanketRecord,
} from '../src/services/memory/blanket.js';
import type { AssistantMessage, Session, UserMessage } from '../src/services/chat/types.js';

const user = (content: string, createdAt = Date.parse('2026-01-01T10:00:00Z')): UserMessage => ({
  id: `u-${content.slice(0, 4)}`,
  role: 'user',
  content,
  files: [],
  createdAt,
});

const assistant = (text: string, createdAt = Date.parse('2026-01-01T10:01:00Z')): AssistantMessage => ({
  id: `a-${text.slice(0, 4)}`,
  role: 'assistant',
  createdAt,
  model: 'deepseek-flash',
  prefix: false,
  status: 'done',
  blocks: [{ type: 'text', text }],
});

const session = (id: string, messages: Session['messages']): Session => ({
  id,
  title: id,
  createdAt: 0,
  updatedAt: 0,
  messages,
});

describe('messageText / sessionDocs', () => {
  it('用户取正文，助手取文本块', () => {
    expect(messageText(user('我想吃火锅'))).toBe('我想吃火锅');
    expect(messageText(assistant('那就去楼下那家'))).toBe('那就去楼下那家');
  });

  it('思考块与服务端模板文案不进索引', () => {
    const reply: AssistantMessage = {
      ...assistant('正经回答'),
      blocks: [
        { type: 'thinking', thinking: '内部推理不该被检索' },
        { type: 'text', text: '正经回答' },
        { type: 'text', text: '服务端提示', isTemplate: true },
      ],
    };
    expect(messageText(reply)).toBe('正经回答');
  });

  it('空消息（纯附件/纯思考）不进文档，但不打乱 index 对应关系', () => {
    const s = session('s1', [user('火锅'), { ...user(''), id: 'u-empty', files: [] }, assistant('豆浆')]);
    const docs = sessionDocs(s);
    expect(docs.map((d) => d.text)).toEqual(['火锅', '豆浆']);
    // messageIndex 用真实落库位置（跳过的消息留空洞），检索结果能定位回原消息
    expect(docs.map((d) => d.messageIndex)).toEqual([0, 2]);
  });

  it('at 转成 ISO 时间，动态段才能渲染"昨天/更早"', () => {
    const [doc] = sessionDocs(session('s1', [user('火锅', Date.parse('2026-01-01T10:00:00Z'))]));
    expect(doc!.at).toBe('2026-01-01T10:00:00.000Z');
  });
});

describe('BlanketMemory 检索', () => {
  const blanketA = session('sessionA', [
    user('昨晚我们去吃火锅，那家店辣得不行，下次点鸳鸯'),
    assistant('确实辣，不过你吃得比谁都多'),
  ]);
  const blanketB = session('sessionB', [user('今天早上喝了豆浆，还有油条')]);

  it('能找到导入会话里的旧事，动态段带上原文', () => {
    const memory = new BlanketMemory();
    memory.syncSession(blanketA);
    memory.syncSession(blanketB);

    const hit = memory.retrieve('还记得那家火锅吗');
    expect(hit.results.length).toBeGreaterThan(0);
    expect(hit.results[0]!.sessionId).toBe('sessionA');
    expect(hit.dynamic).toContain('火锅');
    expect(hit.dynamic).toContain('这时你想起了过去的事');
  });

  it('重复同步幂等：消息不会翻倍进索引', () => {
    const memory = new BlanketMemory();
    memory.syncSession(blanketA);
    const first = memory.stats().docs;
    memory.syncSession(blanketA);
    expect(memory.stats().docs).toBe(first);
  });

  it('同步能补进新消息（增量）', () => {
    const memory = new BlanketMemory();
    memory.syncSession(blanketA);
    const before = memory.stats().docs;
    memory.syncSession(session('sessionA', [...blanketA.messages, user('后来还去看了电影')]));
    expect(memory.stats().docs).toBe(before + 1);
    expect(memory.retrieve('电影').results.some((r) => r.text.includes('电影'))).toBe(true);
  });

  it('会话移出被子后检索不到', () => {
    const memory = new BlanketMemory();
    memory.syncSession(blanketA);
    memory.removeSession('sessionA');
    expect(memory.stats().docs).toBe(0);
    expect(memory.retrieve('火锅').results).toEqual([]);
  });

  it('两个被子互不串味', () => {
    const a = new BlanketMemory();
    a.syncSession(blanketA);
    const b = new BlanketMemory();
    b.syncSession(blanketB);
    expect(b.retrieve('火锅').results).toEqual([]);
    expect(a.retrieve('豆浆').results).toEqual([]);
  });

  it('空查询/范围外问题都走兜底话术，不抛错', () => {
    const memory = new BlanketMemory();
    memory.syncSession(blanketA);
    expect(memory.retrieve('   ').dynamic).toContain('没有想起相关的旧事');
    expect(memory.retrieve('我养的那只猫叫什么名字').dynamic).toContain('没有想起相关的旧事');
  });
});

describe('BlanketRecord 形状', () => {
  it('一组会话 + 一个对话框 + 一个记忆包', () => {
    const record: BlanketRecord = {
      id: 'b1',
      name: '阿柔',
      sessionIds: ['sessionA', 'sessionB'],
      pack: {
        version: 1,
        persona: { name: '阿柔', card: '话不多，但记得住事。' },
        coreMemories: [],
        memories: [],
        facts: [],
        summary: '',
        diary: [],
      },
      createdAt: 0,
      updatedAt: 0,
    };
    // 普通模式转被子：追加会话 id 重蒸，不新开被子
    record.sessionIds = [...record.sessionIds, 'sessionC'];
    expect(record.sessionIds).toHaveLength(3);
  });
});
