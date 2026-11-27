/**
 * engine/attachment-scan.ts —— 导出包里附件的判类与吃进（附件进蒸馏方案 2026-11-27）
 *
 * 两路通道：
 *   A 路「身世文档」：角色设定 / 世界观 / 一整本书 —— 独立人设蒸，产出 persona + backstory，
 *     不切对话块、不进 episodes 池（拿对话块蒸人设会产出 60 条零碎事件并把池子塞满）；
 *   B 路「普通资料」：聊天中的零散附件 —— 拼进对应消息随对话块蒸。
 *
 * 判类三层次（方案 §3.2）：
 *   ① 本地启发式（本文件，零 token 零上传）；
 *   ② 片段判类调用（贵不起来，但会花钱；**当前未实现**，见方案偏差说明）；
 *   ③ 确认页由人拍板（导入向导里每个附件可切换「她的身世 / 普通资料」）。
 * 自动判定只是默认值，最终以人改的为准——「老丁」教训：模型口误靠人改，不靠猜。
 */

import { ATTACHMENT_MAX_BYTES, ATTACHMENT_MERGE_MAX_CHARS, ATTACHMENT_TOTAL_MAX_CHARS } from './config.js';
import { softClip } from './brief.js';
import { TEXT_OVERFLOW_RATIO } from './config.js';

/** 判类结果：身世文档（A 路）/ 普通资料（B 路） */
export type AttachmentTag = 'persona' | 'material';

/** 一个已读出的文本附件 */
export interface AttachmentDoc {
  /** 稳定 id：`${sessionId}::${path}`，确认页切换标签时用它定位 */
  id: string;
  sessionId: string;
  /** 原始文件名（展示用） */
  name: string;
  /** 导出包内路径 */
  path: string;
  text: string;
  words: number;
  /** 启发式判类结果（确认页可改） */
  tag: AttachmentTag;
  /** 读取时是否被截断（超单件上限或整包上限） */
  clipped: boolean;
}

/** 只认这些扩展名：图片/PDF/Office 原件不读（方案 3.1：不做 OCR） */
const TEXT_EXTENSIONS = ['.txt', '.md', '.markdown', '.text', '.log', '.csv'];

/** 文件名像"设定"的关键词（命中即判 A 路） */
const PERSONA_NAME_HINTS = ['设定', '人设', '世界观', '背景', '角色卡', 'persona', 'character'];

/** 导出包内 `chat_sessions/<uuid>_files/<file>` 的路径形状 */
const FILE_PATH_PATTERN = /^chat_sessions\/([^/]+)_files\/(.+)$/;

export const isTextAttachmentName = (name: string): boolean => {
  const lower = name.toLowerCase();
  return TEXT_EXTENSIONS.some((ext) => lower.endsWith(ext));
};

/** 从 `chat_sessions/<id>_files/<name>` 里取会话 id 与文件名；不是附件路径返回 null */
export const parseAttachmentPath = (path: string): { sessionId: string; name: string } | null => {
  const hit = FILE_PATH_PATTERN.exec(path);
  if (!hit) return null;
  return { sessionId: hit[1]!, name: hit[2]! };
};

/**
 * 第一层判类（纯本地，零成本）：
 *   1. 文件名含「设定 / 人设 / 世界观 / 背景 / 角色卡 / persona」→ A 路；
 *   2. 会话里前几个（order < 3）且超过 5000 字的文本 → A 路高概率（开局甩的书）；
 *   3. 其余 → B 路。
 * order 是该附件在本会话文本附件里的出现顺序（0 起）。
 */
export const classifyAttachment = (name: string, words: number, order: number): AttachmentTag => {
  const lower = name.toLowerCase();
  if (PERSONA_NAME_HINTS.some((hint) => lower.includes(hint))) return 'persona';
  if (words >= 5000 && order < 3) return 'persona';
  return 'material';
};

/**
 * 文本解码：UTF-8 优先，出现替换字符（说明不是 UTF-8）时再试 GBK。
 * Safari 老版本可能没有 gbk 解码器——解不出来就退回 UTF-8 带替换字符，不抛异常。
 */
export const decodeAttachmentText = (bytes: Uint8Array): string => {
  let text: string;
  try {
    text = new TextDecoder('utf-8').decode(bytes);
  } catch {
    text = '';
  }
  if (!text.includes('\uFFFD')) return text;
  try {
    const gbk = new TextDecoder('gbk').decode(bytes);
    // GBK 解出来也可能带替换字符（真是二进制），两边都脏时取替换字符少的
    const utf8Bad = text.split('\uFFFD').length;
    const gbkBad = gbk.split('\uFFFD').length;
    return gbkBad < utf8Bad ? gbk : text;
  } catch {
    return text;
  }
};

/** 一份原文字数（统一口径：字符串长度，与 ParsedSession.words 一致） */
export const countAttachmentWords = (text: string): number => text.trim().length;

/**
 * 按总字数上限分配：逐份吃进正文，超出 ATTACHMENT_TOTAL_MAX_CHARS 的整份跳过（并标记截断）。
 * 为什么整份跳过而不是把最后一份切一半：切一半的原件蒸馏出来的设定更容易碎片化，
 * 宁可少一份并让确认页看见"已跳过"。
 */
export const capAttachments = (
  docs: AttachmentDoc[],
  totalMax: number = ATTACHMENT_TOTAL_MAX_CHARS,
): AttachmentDoc[] => {
  const out: AttachmentDoc[] = [];
  let used = 0;
  for (const doc of docs) {
    if (used + doc.words > totalMax) {
      out.push({ ...doc, text: '', words: 0, clipped: true });
      continue;
    }
    used += doc.words;
    out.push(doc);
  }
  return out;
};

/** B 路附件拼进消息时单件裁剪（2 万字，按句读裁，不切半句） */
export const clipMaterialAttachment = (text: string): string =>
  softClip(text, ATTACHMENT_MERGE_MAX_CHARS, TEXT_OVERFLOW_RATIO);

/** 单件大小闸门：超 4MB 不读（疑似二进制） */
export const isAttachmentTooLarge = (size: number): boolean => size > ATTACHMENT_MAX_BYTES;

/**
 * 附件 → 人设蒸的块（与对话块同一口径 2 万字，但**不混进对话块**）。
 * 用软裁而不是硬切：切点落在句读上，设定文档被劈开也不会切出半句话。
 */
export const personaDocChunks = (docs: AttachmentDoc[], blockWords: number): { text: string; from: string }[] => {
  const chunks: { text: string; from: string }[] = [];
  let buffer = '';
  let from = '';
  const flush = () => {
    const text = buffer.trim();
    if (text) chunks.push({ text, from });
    buffer = '';
  };
  for (const doc of docs) {
    if (!doc.text.trim()) continue;
    let rest = doc.text.trim();
    while (rest) {
      if (!buffer) from = doc.name;
      const room = blockWords - buffer.length;
      if (rest.length <= room) {
        buffer += (buffer ? '\n\n' : '') + rest;
        rest = '';
        break;
      }
      // 这一段放不下：先按句读切一段刚好装进当前块
      const piece = softClip(rest, room, TEXT_OVERFLOW_RATIO);
      const take = piece.length > 0 ? piece.length : room;
      buffer += (buffer ? '\n\n' : '') + rest.slice(0, take);
      rest = rest.slice(take);
      flush();
    }
  }
  flush();
  return chunks;
};
