import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import {
  buildPlan,
  parsedToSession,
  readSelectedSessions,
  scanArchive,
} from '../src/services/memory/importBlanket.js';
import { BlanketMemory } from '../src/services/memory/blanket.js';

/** 一条消息（导出格式：主干靠 parent_id 串，正文在 fragments） */
const msg = (
  id: string,
  role: 'USER' | 'ASSISTANT',
  text: string,
  at: string,
  parentId: string | null
) => ({
  id,
  role,
  status: 'FINISHED',
  inserted_at: at,
  parent_id: parentId,
  fragments: [{ type: role === 'USER' ? 'REQUEST' : 'RESPONSE', content: text }],
});

const sessionFile = (id: string, title: string, messages: ReturnType<typeof msg>[]) =>
  JSON.stringify({
    id,
    title,
    pinned: false,
    inserted_at: messages[0]?.inserted_at ?? '2025-03-01T10:00:00.000Z',
    updated_at: messages[messages.length - 1]?.inserted_at ?? '2025-03-01T10:00:00.000Z',
    current_message_id: messages[messages.length - 1]?.id ?? null,
    messages,
  });

/** 造一个符合导出格式的最小 ZIP，走真实解析链路（不 mock 解析器） */
const makeArchive = async (): Promise<File> => {
  const zip = new JSZip();
  zip.file('manifest.json', JSON.stringify({ export_format_version: 1 }));
  zip.file(
    'chat_sessions/s1.json',
    sessionFile('s1', '吃火锅', [
      msg('s1m1', 'USER', '昨晚我们一起去吃了火锅，辣得不行', '2025-03-01T10:00:00.000Z', null),
      msg('s1m2', 'ASSISTANT', '那家店的牛油锅底确实辣，下次点鸳鸯', '2025-03-01T10:01:00.000Z', 's1m1'),
    ])
  );
  zip.file(
    'chat_sessions/s2.json',
    sessionFile('s2', '去看海', [
      msg('s2m1', 'USER', '我们说好下个月去看海，住海边的民宿', '2025-03-05T09:00:00.000Z', null),
      msg('s2m2', 'ASSISTANT', '那我提前看看民宿，挑一个开窗就是海的', '2025-03-05T09:02:00.000Z', 's2m1'),
    ])
  );
  // ArrayBuffer 而不是 Uint8Array：TS 7 下 Uint8Array<ArrayBufferLike> 不算合法 BlobPart
  const bytes = await zip.generateAsync({ type: 'arraybuffer' });
  return new File([bytes], 'deepseek_data-test.zip', { type: 'application/zip' });
};

describe('导出包 → 扫描 → 勾选 → 估算（真实 ZIP 链路）', () => {
  it('粗扫出会话清单与统计，不带正文', async () => {
    const result = await scanArchive(await makeArchive());
    expect(result.sessions.map((session) => session.title)).toEqual(['吃火锅', '去看海']);
    expect(result.broken).toEqual([]);
    expect(result.sessions[0]!.userTurns).toBe(1);
    expect(result.sessions[0]!.words).toBeGreaterThan(10);
    // 粗扫为省内存丢掉 messages，只留统计
    expect(result.sessions[0]!.messages).toBeUndefined();
  });

  it('细读只取勾选的会话，且带全文', async () => {
    const file = await makeArchive();
    const result = await readSelectedSessions(file, new Set(['s2']));
    expect(result.sessions.map((session) => session.id)).toEqual(['s2']);
    expect(result.sessions[0]!.messages?.map((message) => message.text)).toEqual([
      '我们说好下个月去看海，住海边的民宿',
      '那我提前看看民宿，挑一个开窗就是海的',
    ]);
  });

  it('勾选结果直接能出估价与块数', async () => {
    const file = await makeArchive();
    const scanned = await scanArchive(file);
    const { rows, estimate } = buildPlan(scanned.sessions);
    expect(rows.map((row) => row.title)).toEqual(['吃火锅', '去看海']);
    expect(estimate.totalSessions).toBe(2);
    expect(estimate.totalBlocks).toBe(2);
    expect(estimate.costCny).toBeGreaterThan(0);
  });

  it('导入后的原文能按原话召回（被子检索的料齐）', async () => {
    const file = await makeArchive();
    const loaded = await readSelectedSessions(file, new Set(['s1', 's2']));
    const memory = new BlanketMemory();
    for (const session of loaded.sessions) {
      memory.syncSession(parsedToSession(session));
    }
    expect(memory.stats().docs).toBe(4);
    // 口语问法也要能找回那次火锅
    const hit = memory.retrieve('上次吃火锅那家店怎么样').results[0];
    expect(hit?.sessionId).toBe('s1');
  });
});
