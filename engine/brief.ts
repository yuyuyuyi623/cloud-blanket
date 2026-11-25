/**
 * engine/brief.ts —— 注入用短句（"关键句"）的选取
 *
 * 为什么要有这一层：
 *   存储层的 120 字事件、200 字事实是写给人读的（导出文本像日记、检索命中后有细节）；
 *   每轮上下文只需要一句话。两件事用同一份数据，稳定段打满就是 1 万 token，
 *   而预算只有 3500——不是预算太小，是我们把"记忆"写成了小作文。
 *
 * 纪律（2026-11-22 羽翼拍板，"别硬卡字数，导致读起来不像人"）：
 *   1. 短句优先由模型在蒸馏/整合时自己写（brief 字段），代码不生成、不改写；
 *   2. 没有 brief 才回退裁 text，而且**只按句读裁**；
 *   3. 找不到句读就整句原样留着——宁可超长，也不切出半句话。
 *      数字让位于可读性，这条不能为了省几十个 token 破例。
 *
 * 已知边界（诚实声明）：brief 的**语义质量没有硬校验**——仓库没有 tokenizer/NER，
 * "是否丢了关键实体"这类校验做不了硬的，靠蒸馏 prompt 的写法要求 + 确认页人工改。
 * 影响面有明确兜底，不是不可控：
 *   - 下限：模型没写 brief 或写得太空时，回退裁**原文**（上面第 2 条），
 *     所以注入层最差是"原文截句"，不会变成空洞骨架；
 *   - 隔离：FTS 检索的索引建在**原始消息**上（engine/fts.ts），检索注入不走 brief——
 *     brief 质量只影响稳定段里事件层的 40 字/条那一小块；
 *   - 全文：存储层仍是 120 字原文，确认页看得见、可改、可导出。
 */

import { BRIEF_CHARS, BRIEF_OVERFLOW_RATIO } from './config.js';

/** 强句读：到这里一句话就是完了，留着它读起来才顺 */
const STRONG_PUNCT = '。！？；!?;\n';
/** 弱句读：断在这里不会切坏句子，只是少一点细节 */
const WEAK_PUNCT = '，、,：:';

/**
 * 按句读裁到 max 字附近。顺序不能换：
 *   1. 本来就不超长 → 原样返回（一个字符都不动）；
 *   2. max 以内最后一个强句读 → 连标点一起留（这是最理想的结果）；
 *   3. max 以内没有强句读，就在溢出范围里找第一个强句读 → 宁可略长，也要一句话说完；
 *   4. 强弱句读都找不到 → 断在 max 以内最后一个弱句读前面（不清空）；
 *   5. 一个句读都没有 → 整句原样返回。
 */
export function softClip(
  text: string,
  max: number,
  overflowRatio: number = BRIEF_OVERFLOW_RATIO,
): string {
  const s = text.trim();
  if (s.length <= max) return s;

  const scanTo = Math.min(s.length, Math.max(max, Math.round(max * overflowRatio)));
  let lastStrong = -1;
  let lastWeak = -1;
  for (let i = 0; i < Math.min(max, s.length); i += 1) {
    const ch = s[i]!;
    if (STRONG_PUNCT.includes(ch)) lastStrong = i;
    else if (WEAK_PUNCT.includes(ch)) lastWeak = i;
  }
  if (lastStrong >= 0) return s.slice(0, lastStrong + 1).trim();

  for (let i = max; i < scanTo; i += 1) {
    if (STRONG_PUNCT.includes(s[i]!)) return s.slice(0, i + 1).trim();
  }
  if (lastWeak > 0) return s.slice(0, lastWeak).trim();
  return s;
}

/**
 * 取一条记忆的注入短句：模型写了 brief 就用它，没写才回退裁 text。
 * brief 本身也可能超长（模型没听话），同样按句读处理，不硬切。
 */
export function pickBrief(item: { brief?: string | null; text: string }): string {
  const brief = typeof item.brief === 'string' ? item.brief.trim() : '';
  return brief ? softClip(brief, BRIEF_CHARS) : softClip(item.text, BRIEF_CHARS);
}
