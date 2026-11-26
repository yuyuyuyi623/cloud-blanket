/**
 * 用量与账单页纯函数单测（经济方案 2026-11-26 §3.2/§3.4）
 *
 * 锁四件事：
 * 1. 百分比口径：0 提醒线防御、不足 1%、超 100% 如实显示（提醒线不是拦截线）；
 * 2. 余额转天数：无历史数据返回 null（不编数字）、向下取整；
 * 3. 异常日判定与归因：3 倍/20% 两条线、「聊多了」和「单条贵了」拆开；
 * 4. 旧记录兼容：无 searches/thinking 字段的旧 usageLog 按 0/false 处理，不炸。
 */

import { describe, expect, it } from 'vitest';
import {
  summarizeDay,
  splitUsage,
  dailyAverage,
  monthProgress,
  daysLeft,
  isAnomalyDay,
  attributeDay,
} from '../src/services/usage/ledger.js';
import { getSearchMode, setSearchMode, useSettings, MONTHLY_REMINDER_LINE_DEFAULT } from '../src/services/settings.js';
import type { UsageLogEntry } from '../src/services/chat/db.js';

const entry = (overrides: Partial<UsageLogEntry>): UsageLogEntry => ({
  id: 'e',
  ts: 0,
  mode: 'normal',
  hit: 0,
  miss: 0,
  completion: 0,
  peak: false,
  cost: 0,
  ...overrides,
});

describe('summarizeDay（旧记录兼容）', () => {
  it('无 searches/thinking 字段的旧记录按 0 处理，不炸', () => {
    const stats = summarizeDay([entry({ cost: 0.01 }), entry({ cost: 0.02 })]);
    expect(stats.count).toBe(2);
    expect(stats.cost).toBeCloseTo(0.03);
    expect(stats.searches).toBe(0);
    expect(stats.searchCost).toBe(0);
  });

  it('有联网的条目：次数累加、金额只算联网条目', () => {
    const stats = summarizeDay([
      entry({ cost: 0.09, searches: 8 }),
      entry({ cost: 0.01 }),
      entry({ cost: 0.05, searches: 1 }),
    ]);
    expect(stats.searches).toBe(9);
    expect(stats.searchCost).toBeCloseTo(0.14);
    expect(stats.cost).toBeCloseTo(0.15);
  });
});

describe('splitUsage（自然月/今天/近 7 天切分）', () => {
  // 2026-11-26 12:00 本地
  const now = new Date(2026, 10, 26, 12, 0).getTime();

  it('今天、本月、前 7 天各归各位', () => {
    const { month, today, prev7 } = splitUsage(
      [
        entry({ ts: new Date(2026, 10, 26, 9).getTime() }), // 今天
        entry({ ts: new Date(2026, 10, 26, 0, 1).getTime() }), // 今天零点后
        entry({ ts: new Date(2026, 10, 25).getTime() }), // 昨天 → prev7 + month
        entry({ ts: new Date(2026, 10, 19).getTime() }), // 7 天前 → prev7 + month
        entry({ ts: new Date(2026, 10, 18).getTime() }), // 8 天前 → 只剩 month
        entry({ ts: new Date(2026, 9, 31).getTime() }), // 上月 → 哪段都不进
      ],
      now
    );
    expect(today).toHaveLength(2);
    expect(prev7).toHaveLength(2);
    // 今天 2 + 前 7 天 2 + 8 天前 1（只在本月，不在近 7 天）
    expect(month).toHaveLength(5);
  });
});

describe('dailyAverage', () => {
  it('没有历史数据返回 null（不编数字）', () => {
    expect(dailyAverage([])).toBeNull();
  });

  it('7 天记录 ÷ 7', () => {
    const prev7 = [entry({ cost: 0.2, ts: 1 }), entry({ cost: 0.5, ts: 2 })];
    expect(dailyAverage(prev7)?.cost).toBeCloseTo(0.1);
    expect(dailyAverage(prev7)?.count).toBeCloseTo(2 / 7);
  });
});

describe('monthProgress', () => {
  it('提醒线 0 防御性返回 0', () => {
    expect(monthProgress(5, 0)).toBe(0);
  });

  it('不足 1% 返回 0（展示层显示 <1%）', () => {
    expect(monthProgress(0.09, 20)).toBe(0);
    expect(monthProgress(0.2, 20)).toBe(1);
  });

  it('超 100% 如实显示', () => {
    expect(monthProgress(25, 20)).toBe(125);
  });

  it('没花钱是 0%', () => {
    expect(monthProgress(0, 20)).toBe(0);
  });
});

describe('daysLeft', () => {
  it('日均 0（无历史）返回 null', () => {
    expect(daysLeft(18.4, 0)).toBeNull();
    expect(daysLeft(18.4, -1)).toBeNull();
  });

  it('向下取整；刚够一天也是 1', () => {
    // 18.4/0.2 浮点是 91.99…，floor 得 91——展示层少说一天比多说一天安全
    expect(daysLeft(18.4, 0.2)).toBe(91);
    expect(daysLeft(0.2, 0.2)).toBe(1);
    expect(daysLeft(0.1, 0.2)).toBe(0);
  });
});

describe('isAnomalyDay（3 倍 / 20% 提醒线两条线）', () => {
  const today = { count: 14, cost: 1.24, searches: 8, searchCost: 0.96 };

  it('花费 0 的日子永远不异常', () => {
    expect(isAnomalyDay({ count: 0, cost: 0, searches: 0, searchCost: 0 }, { cost: 0.1 }, 20)).toBe(false);
  });

  it('比日均贵 3 倍以上 → 异常', () => {
    expect(isAnomalyDay(today, { cost: 0.18 }, 100)).toBe(true);
    expect(isAnomalyDay(today, { cost: 0.5 }, 100)).toBe(false);
  });

  it('无历史数据的新用户：超提醒线 20% 也算异常', () => {
    // 20% 线 = ¥4：花 5 块 → 异常；花 1.24 → 不算（没有基线可比，绝对值也不大）
    expect(isAnomalyDay({ ...today, cost: 5 }, null, 20)).toBe(true);
    expect(isAnomalyDay(today, null, 20)).toBe(false);
  });
});

describe('attributeDay（聊多了 vs 单条贵了，拆开）', () => {
  it('条数多、单条也贵、搜索占大头，三句都能给出来', () => {
    const today = { count: 14, cost: 1.24, searches: 8, searchCost: 0.96 };
    const base = { count: 9 / 7, cost: 0.18 };
    const attr = attributeDay(today, base, 20);
    expect(attr.anomaly).toBe(true);
    expect(attr.costRatio).toBeCloseTo(1.24 / 0.18, 5);
    expect(attr.countRatio).toBeCloseTo(14 / (9 / 7), 5);
    expect(attr.perMsg).toBeCloseTo(1.24 / 14, 5);
    expect(attr.perMsgBase).toBeCloseTo(0.18 / (9 / 7), 5);
    expect(attr.searches).toBe(8);
    expect(attr.searchShare).toBeCloseTo(0.96 / 1.24, 5);
  });

  it('无基线：比例都是 null，但搜索次数仍给得出', () => {
    const attr = attributeDay({ count: 3, cost: 0.5, searches: 2, searchCost: 0.4 }, null, 20);
    expect(attr.costRatio).toBeNull();
    expect(attr.countRatio).toBeNull();
    expect(attr.perMsgBase).toBeNull();
    expect(attr.searches).toBe(2);
  });

  it('条数为 0：单条均价 0、搜索占比 null', () => {
    const attr = attributeDay({ count: 0, cost: 0, searches: 0, searchCost: 0 }, { count: 1, cost: 0.1 }, 20);
    expect(attr.perMsg).toBe(0);
    expect(attr.searchShare).toBeNull();
    expect(attr.anomaly).toBe(false);
  });
});

describe('searchMode 三态（派生视图，不是第三套真值）', () => {
  it('默认档是自动', () => {
    expect(MONTHLY_REMINDER_LINE_DEFAULT).toBe(20);
  });

  it('thinking/search 组合 → 档位映射', () => {
    expect(getSearchMode(false, true)).toBe('auto');
    expect(getSearchMode(true, true)).toBe('deep');
    expect(getSearchMode(false, false)).toBe('off');
    expect(getSearchMode(true, false)).toBe('off'); // 搜索关了就是 off，thinking 无关
  });

  it('setSearchMode 写回两个既有字段；关搜索不动 thinking', () => {
    useSettings.setState({ thinking: false, search: false });
    setSearchMode('auto');
    expect(useSettings.getState().thinking).toBe(false);
    expect(useSettings.getState().search).toBe(true);
    setSearchMode('deep');
    expect(useSettings.getState().thinking).toBe(true);
    expect(useSettings.getState().search).toBe(true);
    useSettings.setState({ thinking: true });
    setSearchMode('off');
    // 关搜索：thinking 随用户，不动
    expect(useSettings.getState().thinking).toBe(true);
    expect(useSettings.getState().search).toBe(false);
  });
});
