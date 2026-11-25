/**
 * engine/redact.ts —— 原文脱敏（seedTurns 专用，2026-11-25 拍板：P1，先于 A5）
 *
 * 为什么单独一层：蒸馏 prompt 里对**模型产出**有"密码、密钥、账号、支付信息、精确住址
 * 不进任何字段"的要求，但 `seedTurns` 是**原文照搬、不过模型**——prompt 里的条款管不到它，
 * 这是真缺口（2026-11-25 评审点出的）。
 *
 * 口径（拍板定稿）：
 *   - 命中即替换为 `[已隐去]`，**只替换不丢弃**——整条丢弃会让对话读不懂，
 *     "他问我卡号是多少"和"他说了句话"不是一回事；
 *   - 含密钥/密码/验证码的**整行**替换，但保留行首的说话人与时间（`你（2025-03-01）：`），
 *     否则原文照搬的对话会多出一行不知道谁说的话；
 *   - 纯函数、无顺序依赖、幂等：替换结果里没有可再次命中的模式。
 */

/** 替换占位符。全文只此一处定义，UI 与测试都引用它 */
export const REDACTED = '[已隐去]';

/**
 * 含敏感词的行：整行内容抹掉。
 * 关键词收窄到"一定是秘密"的几个，避免误伤正常聊天（"她给的安全感"不该被抹）。
 */
const SECRET_LINE = /(密码|密钥|秘钥|口令|验证码|支付密码|password|passwd|secret|api[_\s-]?key|access[_\s-]?token)/i;

/** URL：http(s) 或裸域名路径都可能带 token */
const URL = /https?:\/\/[^\s，。；、）)】」』"']+/gi;

/** 邮箱 */
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

/** 卡号样式：4-4-4-4（允许空格或短横分隔），13~19 位 */
const CARD = /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g;

/** 中国大陆手机号 */
const PHONE = /(?<!\d)1[3-9]\d{9}(?!\d)/g;

/** 12 位以上连续数字：订单号 / 学号 / 证件号 / 长账号 */
const LONG_DIGITS = /\d{12,}/g;

/**
 * 抹掉一行里的敏感内容，保留"说话人 + 时间"前缀（第一个全角/半角冒号之前）。
 * 没有前缀的行（用户自己粘的一段）整行替换。
 */
function redactLine(line: string): string {
  if (!SECRET_LINE.test(line)) return redactInline(line);
  const idx = line.search(/[：:]/);
  const prefix = idx > 0 ? line.slice(0, idx) : '';
  // 前缀本身带敏感词（"密码："）就不是说话人前缀——整行抹掉
  const hasSpeaker = idx > 0 && idx <= 20 && !SECRET_LINE.test(prefix);
  return hasSpeaker ? `${prefix}${line.slice(idx, idx + 1)}${REDACTED}` : REDACTED;
}

/** 行内替换：URL → 邮箱 → 卡号 → 手机号 → 长数字（顺序有讲究，先长模式后短模式） */
function redactInline(text: string): string {
  return text
    .replace(URL, REDACTED)
    .replace(EMAIL, REDACTED)
    .replace(CARD, REDACTED)
    .replace(PHONE, REDACTED)
    .replace(LONG_DIGITS, REDACTED);
}

/**
 * 原文脱敏入口。`\n` 分行处理，行内空格与标点原样保留（原文照搬的可读性优先）。
 */
export function redactSensitive(text: string): string {
  if (!text) return text;
  return text
    .split('\n')
    .map(redactLine)
    .join('\n');
}
