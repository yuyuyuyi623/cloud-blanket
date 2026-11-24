/**
 * engine/jaccard.ts —— 字符集合 Jaccard 相似度（E3 准入制反同义覆盖）
 *
 * 从柔光 emotion-state.mjs:2247 逐行移植，实现语义一字不改：
 *   - toLocaleLowerCase('zh-CN') 后只保留 Unicode 字母(\p{L})与数字(\p{N})，
 *     中文按单字进集合；
 *   - 分母 |a|+|b|-|交集|，两边都空返回 1；
 *   - 阈值 0.45 是调用点字面量（index.mjs:5560），App 版进 config。
 */

import { JACCARD_THRESHOLD } from './config.js';

export function characterJaccard(left: string, right: string): number {
  const characters = (value: string): Set<string> =>
    new Set(
      [...String(value ?? '').toLocaleLowerCase('zh-CN')].filter(
        (character) => /[\p{L}\p{N}]/u.test(character)
      )
    );

  const a = characters(left);
  const b = characters(right);
  if (!a.size && !b.size) return 1;

  let overlap = 0;
  for (const character of a) {
    if (b.has(character)) overlap += 1;
  }
  return overlap / (a.size + b.size - overlap || 1);
}

/**
 * 准入判定（E3）：新条目与被换掉的老条目相似度过高 = 粗暴覆盖，拒绝。
 * 返回 true 表示"这次替换应被拒绝"。
 */
export function isRoughOverwrite(newText: string, oldText: string): boolean {
  return characterJaccard(newText, oldText) > JACCARD_THRESHOLD;
}
