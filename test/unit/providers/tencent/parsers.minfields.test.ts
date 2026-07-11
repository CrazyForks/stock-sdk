/**
 * R7-9 阈值机制化：MIN_FIELDS 常量与解析器实际访问的最大下标机械绑定。
 * 本条修复的根因就是"阈值没有跟解析器的最高访问下标绑定"——注释绑定会
 * 随下一次字段扩展再度漂移（解析器新读 f[80] 而常量仍是 74 → 伪造 0 值
 * 缺陷类原样复活且全部测试绿），Proxy 记录真实访问让漂移直接红。
 */
import { describe, it, expect } from 'vitest';
import {
  parseFullQuote,
  parseSimpleQuote,
  parseHKQuote,
  parseUSQuote,
  parseFundQuote,
  parseFundFlow,
  parsePanelLargeOrder,
  filterTencentRows,
  FULL_QUOTE_MIN_FIELDS,
  SIMPLE_QUOTE_MIN_FIELDS,
  HK_QUOTE_MIN_FIELDS,
  US_QUOTE_MIN_FIELDS,
  FUND_QUOTE_MIN_FIELDS,
  FUND_FLOW_MIN_FIELDS,
  PANEL_LARGE_ORDER_MIN_FIELDS,
} from '../../../../src/providers/tencent/parsers';

const PROBE_LEN = 300;

/** 用 Proxy 数组记录解析器实际访问过的全部整数下标。 */
function accessedIndexes(parse: (f: string[]) => unknown): number[] {
  const indexes: number[] = [];
  const arr = new Proxy(Array(PROBE_LEN).fill('1') as string[], {
    get(target, prop, receiver) {
      if (typeof prop === 'string') {
        const i = Number(prop);
        if (Number.isInteger(i) && i >= 0) {
          indexes.push(i);
        }
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  parse(arr);
  return indexes;
}

/** 固定下标部分的最大访问位（排除 f[length-k] 尾部相对访问）。 */
function maxFixedIndex(parse: (f: string[]) => unknown): number {
  return Math.max(...accessedIndexes(parse).filter((i) => i < PROBE_LEN - 10));
}

describe('MIN_FIELDS 常量 ↔ 解析器最大访问下标', () => {
  it.each([
    ['parseFullQuote', parseFullQuote, FULL_QUOTE_MIN_FIELDS],
    ['parseSimpleQuote', parseSimpleQuote, SIMPLE_QUOTE_MIN_FIELDS],
    ['parseUSQuote', parseUSQuote, US_QUOTE_MIN_FIELDS],
    ['parseFundQuote', parseFundQuote, FUND_QUOTE_MIN_FIELDS],
    ['parseFundFlow', parseFundFlow, FUND_FLOW_MIN_FIELDS],
    ['parsePanelLargeOrder', parsePanelLargeOrder, PANEL_LARGE_ORDER_MIN_FIELDS],
  ] as const)('%s 的常量 = 最大访问下标 + 1', (_name, parse, min) => {
    expect(maxFixedIndex(parse) + 1).toBe(min);
  });

  it('parseHKQuote：固定下标部分 = 常量 - 1（currency 为尾部相对访问，单独校验）', () => {
    expect(maxFixedIndex(parseHKQuote) + 1).toBe(HK_QUOTE_MIN_FIELDS);
    // 尾部相对访问确实存在（f[length-3]）
    const tail = accessedIndexes(parseHKQuote).filter((i) => i >= PROBE_LEN - 10);
    expect(tail).toContain(PROBE_LEN - 3);
  });
});

describe('filterTencentRows 边界与 HK currency 语义校验', () => {
  const row = (key: string, n: number, first = '1') => ({
    key,
    fields: [first, ...Array(n - 1).fill('1')] as string[],
  });

  it('长度门：达到阈值放行，差一拦截；none_match 行被拦截', () => {
    const wanted = new Set(['sh600519']);
    expect(filterTencentRows([row('sh600519', 74)], wanted, 74)).toHaveLength(1);
    expect(filterTencentRows([row('sh600519', 73)], wanted, 74)).toHaveLength(0);
    // v_pv_none_match：fields = ['1']
    expect(filterTencentRows([{ key: 'pv_none_match', fields: ['1'] }], wanted, 74)).toHaveLength(0);
    expect(filterTencentRows([row('sh600519', 74, '')], wanted, 74)).toHaveLength(0);
  });

  it('HK 46-49 字段截断行：通过长度门但 currency 被语义校验置空，不再伪造价格串', () => {
    // 真实行 ~50 字段、f[47]='HKD'；47 字段的截断行 f[length-3]=f[44] 是数值列
    const truncated = Array(47).fill('123.45') as string[];
    const parsed = parseHKQuote(truncated);
    expect(parsed.currency).toBe('');

    const normal = Array(50).fill('1') as string[];
    normal[47] = 'HKD';
    expect(parseHKQuote(normal).currency).toBe('HKD');
  });
});
