import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import JSZip from 'jszip';

import { DISTILL_BLOCK_WORDS } from '../engine/config.js';
import fs from 'node:fs';
import { chunkMessages, loadSessions, mainline, messageText } from '../engine/parse.js';

// ── 合成导出包（内容全编、结构照真样本）─────────────────────

function msg(
  id: number,
  parentId: number | null,
  role: 'USER' | 'ASSISTANT',
  content: string,
  opts: { think?: string; file?: boolean; status?: string; at?: string } = {}
) {
  const fragments: Record<string, unknown>[] = [];
  if (opts.think) fragments.push({ type: 'THINK', content: opts.think });
  fragments.push({ type: role === 'USER' ? 'REQUEST' : 'RESPONSE', content });
  if (opts.file) fragments.push({ type: 'FILE', content: { file_name: '报告.pdf' } });
  fragments.push({ type: 'CONTENT_RISK', content: 'This response is AI-generated…' });
  return {
    id,
    parent_id: parentId,
    role,
    status: opts.status ?? 'FINISHED',
    thinking_enabled: !!opts.think,
    inserted_at: opts.at ?? `2026-01-0${id}T10:00:00.000Z`,
    fragments,
  };
}

function sessionJson(id: string, body: Record<string, unknown>): string {
  return JSON.stringify({ id, pinned: false, ...body });
}

let zipPath = '';

beforeAll(async () => {
  // 会话 A：线性 + 思考链 + 附件 + 一条未完成
  const sessionA = sessionJson('session-a', {
    title: '合成会话A',
    current_message_id: 3,
    inserted_at: '2026-01-01T10:00:00.000Z',
    updated_at: '2026-01-03T10:00:00.000Z',
    messages: [
      msg(1, null, 'USER', '你好呀', { at: '2026-01-01T10:00:00.000Z' }),
      msg(2, 1, 'ASSISTANT', '我在这呢', { think: '这是思考链，不能进蒸馏' }),
      msg(3, 2, 'USER', '今天有点累', {
        status: 'GENERATING',
        file: true,
        at: '2026-01-03T10:00:00.000Z',
      }),
    ],
  });

  // 会话 B：有分支。主线 1→2→3，4 是被遗弃的分支（current_message_id=3）
  const sessionB = sessionJson('session-b', {
    title: '合成会话B（有分支）',
    current_message_id: 3,
    inserted_at: '2026-01-04T10:00:00.000Z',
    updated_at: '2026-01-05T10:00:00.000Z',
    messages: [
      msg(1, null, 'USER', '主线第一条', { at: '2026-01-04T10:00:00.000Z' }),
      msg(2, 1, 'ASSISTANT', '主线回复', { at: '2026-01-04T10:01:00.000Z' }),
      msg(4, 2, 'ASSISTANT', '这是不在主线上的分支回复', { at: '2026-01-04T10:02:00.000Z' }),
      msg(3, 2, 'USER', '主线第二条', { at: '2026-01-05T10:00:00.000Z' }),
    ],
  });

  // 会话 C：current_message_id 断链（指向不存在的 id）→ 退回数组顺序
  const sessionC = sessionJson('session-c', {
    title: '合成会话C（断链兜底）',
    current_message_id: 999,
    messages: [
      msg(1, null, 'USER', '断链会话第一条'),
      msg(2, 1, 'ASSISTANT', '断链会话回复'),
    ],
  });

  const zip = new JSZip();
  zip.file('manifest.json', JSON.stringify({ export_format_version: 3 }));
  // 真包口径：文件名（去 .json）即会话 id（导出格式分析 三.1）
  zip.file('chat_sessions/session-a.json', sessionA);
  zip.file('chat_sessions/session-b.json', sessionB);
  zip.file('chat_sessions/session-c.json', sessionC);
  zip.file('chat_sessions/broken.json', '{ 这不是合法 JSON');
  zip.file('chat_sessions/xxx_files/ignored.bin', 'binary');

  const dir = mkdtempSync(join(tmpdir(), 'cloud-blanket-test-'));
  zipPath = join(dir, 'test-export.zip');
  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  writeFileSync(zipPath, new Uint8Array(buf));
  (globalThis as { __testDir?: string }).__testDir = dir;
});

afterAll(() => {
  const dir = (globalThis as { __testDir?: string }).__testDir;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

// ── mainline ─────────────────────────────────────────────────

describe('mainline（主干回溯，导出格式分析 四.1）', () => {
  it('沿 current_message_id → parent_id 回溯，反转成时间顺序', () => {
    const line = mainline({
      current_message_id: 3,
      messages: [
        { id: 3, parent_id: 2, role: 'USER' },
        { id: 1, parent_id: null, role: 'USER' },
        { id: 2, parent_id: 1, role: 'ASSISTANT' },
      ],
    });
    expect(line.map((m) => m.id)).toEqual([1, 2, 3]);
  });

  it('分支消息被剔除（真样本实证 52 条不在主干上）', () => {
    const line = mainline({
      current_message_id: 3,
      messages: [
        { id: 1, parent_id: null },
        { id: 2, parent_id: 1 },
        { id: 4, parent_id: 2 },
        { id: 3, parent_id: 2 },
      ],
    });
    expect(line.map((m) => m.id)).toEqual([1, 2, 3]);
  });

  it('current_message_id 断链 → 退回数组顺序（宁可退，不能崩）', () => {
    const messages = [{ id: 1 }, { id: 2 }];
    expect(mainline({ current_message_id: 999, messages })).toBe(messages);
  });

  it('环状链不死循环', () => {
    const line = mainline({
      current_message_id: 1,
      messages: [
        { id: 1, parent_id: 2 },
        { id: 2, parent_id: 1 },
      ],
    });
    expect(line.length).toBe(2);
  });

  it('空消息数组返回空', () => {
    expect(mainline({ messages: [] })).toEqual([]);
  });
});

describe('messageText（只收正文，四.3）', () => {
  it('THINK 计数但不进正文', () => {
    const r = messageText(
      msg(1, null, 'ASSISTANT', '正文内容', { think: '思考过程' })
    );
    expect(r.text).toBe('正文内容');
    expect(r.thinkCount).toBe(1);
    expect(r.thinkWords).toBe(4);
  });

  it('CONTENT_RISK 与 FILE 不进正文', () => {
    const r = messageText(msg(1, null, 'USER', '看这个文件', { file: true }));
    expect(r.text).toBe('看这个文件');
    expect(r.fileCount).toBe(1);
  });

  it('content 为 null 的正文片段跳过', () => {
    const r = messageText({
      role: 'USER',
      fragments: [{ type: 'REQUEST', content: null }, { type: 'REQUEST', content: '有内容' }],
    });
    expect(r.text).toBe('有内容');
  });
});

// ── loadSessions（整包） ─────────────────────────────────────

describe('loadSessions（合成导出包）', () => {
  it('解析 3 个会话、报告 1 个损坏、读出版本号', async () => {
    const r = await loadSessions(new Uint8Array(fs.readFileSync(zipPath)));
    expect(r.formatVersion).toBe(3);
    expect(r.sessionCount).toBe(4); // 含 broken 的那个
    expect(r.sessions).toHaveLength(3);
    expect(r.broken).toHaveLength(1);
    expect(r.sessions.map((s) => s.title).sort()).toEqual([
      '合成会话A',
      '合成会话B（有分支）',
      '合成会话C（断链兜底）',
    ]);
  });

  it('THINK 字数不进 words；FILE 计入 stats；非 FINISHED 标记', async () => {
    const r = await loadSessions(new Uint8Array(fs.readFileSync(zipPath)));
    const a = r.sessions.find((s) => s.title === '合成会话A')!;
    expect(a.words).toBe('你好呀'.length + '我在这呢'.length + '今天有点累'.length);
    expect(a.stats.thinkWords).toBe('这是思考链，不能进蒸馏'.length);
    expect(a.stats.fileCount).toBe(1);
    expect(a.stats.unfinished).toBe(1);
    expect(a.messages[2]?.unfinished).toBe('GENERATING');
    expect(a.days).toBe(2); // 1 日和 3 日
  });

  it('分支会话的轮数按主干计（245→243 的实证口径）', async () => {
    const r = await loadSessions(new Uint8Array(fs.readFileSync(zipPath)));
    const b = r.sessions.find((s) => s.title === '合成会话B（有分支）')!;
    expect(b.totalMessages).toBe(3);
    expect(b.messages.map((m) => m.text)).toEqual(['主线第一条', '主线回复', '主线第二条']);
  });

  it('withMessages=false 丢掉 messages 但统计口径不变', async () => {
    const r = await loadSessions(new Uint8Array(fs.readFileSync(zipPath)), { withMessages: false });
    const a = r.sessions.find((s) => s.title === '合成会话A')!;
    expect(a.messages).toBeUndefined();
    expect(a.words).toBeGreaterThan(0);
  });
});

// ── chunkMessages（切块） ────────────────────────────────────

describe('chunkMessages（2 万字/块，按消息边界切）', () => {
  const m = (text: string, at = '2026-01-01T00:00:00.000Z') =>
    ({ role: 'user' as const, text, at, unfinished: '' });

  it('按消息边界切，一条消息绝不劈成两半；块尽量不超上限', () => {
    const chunks = chunkMessages([m('a'.repeat(6000)), m('b'.repeat(6000)), m('c'.repeat(6000)), m('d'.repeat(6000))]);
    expect(chunks.map((c) => c.words)).toEqual([18000, 6000]);
    expect(chunks[0]?.messages.map((x) => x.text[0])).toEqual(['a', 'b', 'c']);
  });

  it('超长单条消息独立成块（块可超出上限，不劈开）', () => {
    const chunks = chunkMessages([m('x'.repeat(DISTILL_BLOCK_WORDS + 5000)), m('小')]);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.words).toBe(DISTILL_BLOCK_WORDS + 5000);
    expect(chunks[1]?.words).toBe(1);
  });

  it('块的时间范围来自首尾消息', () => {
    const chunks = chunkMessages([m('一', '2026-01-01T08:00:00.000Z'), m('二', '2026-01-02T09:00:00.000Z')]);
    expect(chunks[0]?.firstAt).toBe('2026-01-01T08:00:00.000Z');
    expect(chunks[0]?.lastAt).toBe('2026-01-02T09:00:00.000Z');
  });

  it('空输入返回空', () => {
    expect(chunkMessages([])).toEqual([]);
  });
});

// ── onlyIds（App 两段式导入） ────────────────────────────────

describe('loadSessions onlyIds', () => {
  it('只解析指定 id 的会话，sessionCount 仍是总数', async () => {
    const first = await loadSessions(new Uint8Array(fs.readFileSync(zipPath)), { withMessages: false });
    const pick = new Set([first.sessions[0]!.id]);
    const r = await loadSessions(new Uint8Array(fs.readFileSync(zipPath)), { withMessages: true, onlyIds: pick });
    expect(r.sessionCount).toBe(first.sessionCount);
    expect(r.sessions).toHaveLength(1);
    expect(pick.has(r.sessions[0]!.id)).toBe(true);
    expect(r.sessions[0]!.messages?.length).toBeGreaterThan(0);
  });
});
