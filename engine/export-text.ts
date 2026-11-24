/**
 * engine/export-text.ts —— 把蒸馏结果渲染成一份"给人读"的纯文本。
 *
 * 为什么不是 JSON：这份东西的第一读者是羽翼自己，他要判断的是"她像不像"，
 * 不是"字段全不全"。JSON 是给程序读的（记忆包导出以后单独做），
 * 两件事混在一个按钮里，两边都做不好。
 *
 * 为什么放 engine 而不是 app：纯函数、零 RN 依赖，可以直接单测——
 * 而且"事实分成【对方】和【关系】两栏"这件事本身就是个诊断工具：
 * 关系栏空了，就是被 FACTS_LIMIT 挤掉了，一眼能看出来。
 */

import type { MemoryPack } from './pack.js';

export interface ExportMemory {
  text: string;
  /** 事实没有时间；事件有。没有就不渲染日期，不硬编一个 */
  at?: string | null;
}

export interface ExportInput {
  /** 定稿的记忆包（确认页改完就是它） */
  pack: MemoryPack;
  /** 核心记忆候选（可能比 pack.coreMemories 多） */
  coreCandidates: ExportMemory[];
  /** 整体印象一句 */
  impression?: string;
  /** 导出时间，测试里传固定值 */
  exportedAt?: Date;
}

const LINER = '─'.repeat(28);

function two(n: number): string {
  return String(n).padStart(2, '0');
}

function stamp(d: Date): string {
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(
    d.getMinutes(),
  )}`;
}

function day(at: string | null | undefined): string {
  return at ? at.slice(0, 10) : '';
}

/**
 * 正文自带日期就去掉（"2026-11-02，老D大赞…" → "老D大赞…"）。
 *
 * 模型经常把日期写进正文，而 bullet 前面已经排了 `2026-11-02 · `，
 * 于是导出里出现 `2026-11-02 · 2026-11-02，老D大赞…`。只在**我们确实渲染了日期**时才剥，
 * 没有 at 的条目原样保留（宁可重复，也不能把正文开头的数字当真删掉）。
 */
function stripLeadingDate(text: string): string {
  return text.replace(/^\s*\d{4}\s*[-/年.]\s*\d{1,2}\s*[-/月.]\s*\d{1,2}\s*日?\s*[，,、:：。.]?\s*/, '');
}

function bullet(items: ExportMemory[]): string {
  return items
    .map((m, i) => {
      const d = day(m.at);
      return `${i + 1}. ${d ? `${d} · ${stripLeadingDate(m.text)}` : m.text}`;
    })
    .join('\n');
}

/**
 * 渲染。空段落直接省略（不写"（无）"——空白比占位符更诚实，
 * 也更好判断"这一层是不是真的空了"）。
 */
export function renderMemoryText(input: ExportInput): string {
  const { pack, coreCandidates, impression } = input;
  const exportedAt = input.exportedAt ?? new Date();
  const parts: string[] = [];

  parts.push('云朵被子 · 蒸馏结果');
  parts.push(`导出时间：${stamp(exportedAt)}`);
  parts.push(`（这份是人格卡草稿，逐条核对/修改的那个页面还没做）`);

  if (impression?.trim()) {
    parts.push('', LINER, '整体印象', LINER, impression.trim());
  }

  if (pack.persona.card.trim()) {
    parts.push(
      '',
      LINER,
      '她是谁（人格卡草稿）',
      LINER,
      pack.persona.card.trim(),
      '',
      `（${pack.persona.card.trim().length} 字）`,
    );
  }

  if (pack.summary.trim()) {
    parts.push('', LINER, '这段关系怎么走到今天', LINER, pack.summary.trim());
  }

  if (coreCandidates.length) {
    parts.push(
      '',
      LINER,
      `核心记忆候选（${coreCandidates.length} 条，正式版只留 5 条）`,
      LINER,
      bullet(coreCandidates),
    );
  }

  // 事实按来源分栏：关系栏空 = 被上限挤掉了，这个信号只在分栏时才看得见
  const users = pack.facts.filter((f) => f.kind !== 'relationship');
  const rels = pack.facts.filter((f) => f.kind === 'relationship');
  if (pack.facts.length) {
    parts.push('', LINER, `事实（共 ${pack.facts.length} 条）`, LINER);
    if (users.length) {
      parts.push(`【关于他】${users.length} 条`, bullet(users), '');
    }
    if (rels.length) {
      parts.push(`【关于你们】${rels.length} 条`, bullet(rels));
    }
  }

  if (pack.memories.length) {
    parts.push('', LINER, `她记得的事（${pack.memories.length} 条）`, LINER, bullet(pack.memories));
  }

  if (pack.diary.length) {
    parts.push('', LINER, `日记（${pack.diary.length} 条）`, LINER);
    parts.push(
      pack.diary
        .map((d) => `${d.date || '（无日期）'}\n${d.text}`)
        .join('\n\n'),
    );
  }

  const text = parts.join('\n');
  const chars = text.length;
  return `${text}\n\n${LINER}\n共 ${chars} 字 · 记忆包 v${pack.version}\n`;
}

/** 导出文件名：云朵被子-记忆-20261122-2220.txt（中文名在 Android 分享面板里显示正常） */
export function exportFileName(at: Date = new Date()): string {
  const d = `${at.getFullYear()}${two(at.getMonth() + 1)}${two(at.getDate())}`;
  const t = `${two(at.getHours())}${two(at.getMinutes())}`;
  return `云朵被子-记忆-${d}-${t}.txt`;
}
