/**
 * 腾讯财经数据解析器
 */
import { safeNumber, safeNumberOrNull, buildTimeMeta, MARKET_TZ } from '../../core';
import type {
  FullQuote,
  SimpleQuote,
  FundFlow,
  PanelLargeOrder,
  HKQuote,
  USQuote,
  FundQuote,
} from '../../types';

// ============================================================
// R7-9: 行完整性过滤（与各解析器共置，阈值改动跟着解析器走；
// test/unit/providers/tencent/parsers.minfields.test.ts 用 Proxy 记录
// 实际最大访问下标，机械钉住常量与解析器不漂移）
// ============================================================

/** parseFullQuote 最高访问 f[73]（totalShares） */
export const FULL_QUOTE_MIN_FIELDS = 74;
/** parseSimpleQuote 最高访问 f[10]（marketType） */
export const SIMPLE_QUOTE_MIN_FIELDS = 11;
/** parseHKQuote 最高固定下标 f[45]（currency 为尾部相对下标，另有语义校验兜底） */
export const HK_QUOTE_MIN_FIELDS = 46;
/** parseUSQuote 最高访问 f[49]（low52w） */
export const US_QUOTE_MIN_FIELDS = 50;
/** parseFundQuote 最高访问 f[8] */
export const FUND_QUOTE_MIN_FIELDS = 9;
/** parseFundFlow 最高访问 f[13] */
export const FUND_FLOW_MIN_FIELDS = 14;
/** parsePanelLargeOrder 最高访问 f[3] */
export const PANEL_LARGE_ORDER_MIN_FIELDS = 4;

/**
 * 腾讯行情行完整性过滤：只接受请求过的 key、字段数达到解析器最高访问
 * 下标 +1、非空首字段。
 *
 * 此前 7 个入口各自手写且阈值已分叉（quote/hk/us 用宽松 `>5`，而解析器
 * 最高读到 f[73]）：截断行通过过滤后 safeNumber(undefined)=0，涨跌幅 /
 * 高低 / 成交额被伪造成 0，与真实数据无法区分。行为变化：截断行从
 * "伪造 0 值"改为整行丢弃（v_pv_none_match 的 fields=['1'] 同样被长度门拦截）。
 */
export function filterTencentRows(
  data: Array<{ key: string; fields: string[] }>,
  wanted: ReadonlySet<string>,
  minFields: number
): Array<{ key: string; fields: string[] }> {
  return data.filter(
    (d) =>
      wanted.has(d.key) &&
      d.fields &&
      d.fields.length >= minFields &&
      d.fields[0] !== ''
  );
}

/**
 * 解析 A 股全量行情
 */
export function parseFullQuote(f: string[]): FullQuote {
  const bid: { price: number; volume: number }[] = [];
  for (let i = 0; i < 5; i++) {
    bid.push({
      price: safeNumber(f[9 + i * 2]),
      volume: safeNumber(f[10 + i * 2]),
    });
  }
  const ask: { price: number; volume: number }[] = [];
  for (let i = 0; i < 5; i++) {
    ask.push({
      price: safeNumber(f[19 + i * 2]),
      volume: safeNumber(f[20 + i * 2]),
    });
  }
  const time = f[30] ?? '';
  const timeMeta = buildTimeMeta(time, MARKET_TZ.CN);
  return {
    marketId: f[0] ?? '',
    name: f[1] ?? '',
    code: f[2] ?? '',
    price: safeNumber(f[3]),
    prevClose: safeNumber(f[4]),
    open: safeNumber(f[5]),
    volume: safeNumber(f[6]),
    outerVolume: safeNumber(f[7]),
    innerVolume: safeNumber(f[8]),
    bid,
    ask,
    time,
    timestamp: timeMeta.timestamp,
    tz: timeMeta.tz,
    change: safeNumber(f[31]),
    changePercent: safeNumber(f[32]),
    high: safeNumber(f[33]),
    low: safeNumber(f[34]),
    volume2: safeNumber(f[36]),
    amount: safeNumber(f[37]),
    turnoverRate: safeNumberOrNull(f[38]),
    pe: safeNumberOrNull(f[39]),
    amplitude: safeNumberOrNull(f[43]),
    circulatingMarketCap: safeNumberOrNull(f[44]),
    totalMarketCap: safeNumberOrNull(f[45]),
    pb: safeNumberOrNull(f[46]),
    limitUp: safeNumberOrNull(f[47]),
    limitDown: safeNumberOrNull(f[48]),
    volumeRatio: safeNumberOrNull(f[49]),
    avgPrice: safeNumberOrNull(f[51]),
    peStatic: safeNumberOrNull(f[52]),
    peDynamic: safeNumberOrNull(f[53]),
    high52w: safeNumberOrNull(f[67]),
    low52w: safeNumberOrNull(f[68]),
    circulatingShares: safeNumberOrNull(f[72]),
    totalShares: safeNumberOrNull(f[73]),
    market: 'CN',
    assetType: 'stock',
    source: 'tencent',
  };
}

/**
 * 解析简要行情
 */
export function parseSimpleQuote(f: string[]): SimpleQuote {
  return {
    marketId: f[0] ?? '',
    name: f[1] ?? '',
    code: f[2] ?? '',
    price: safeNumber(f[3]),
    change: safeNumber(f[4]),
    changePercent: safeNumber(f[5]),
    volume: safeNumber(f[6]),
    amount: safeNumber(f[7]),
    marketCap: safeNumberOrNull(f[9]),
    marketType: f[10] ?? '',
    market: 'CN',
    assetType: 'stock',
    source: 'tencent',
  };
}

/**
 * 解析资金流向
 */
export function parseFundFlow(f: string[]): FundFlow {
  const date = f[13] ?? '';
  const timeMeta = buildTimeMeta(date, MARKET_TZ.CN);
  return {
    code: f[0] ?? '',
    mainInflow: safeNumber(f[1]),
    mainOutflow: safeNumber(f[2]),
    mainNet: safeNumber(f[3]),
    mainNetRatio: safeNumber(f[4]),
    retailInflow: safeNumber(f[5]),
    retailOutflow: safeNumber(f[6]),
    retailNet: safeNumber(f[7]),
    retailNetRatio: safeNumber(f[8]),
    totalFlow: safeNumber(f[9]),
    name: f[12] ?? '',
    date,
    timestamp: timeMeta.timestamp,
    tz: timeMeta.tz,
  };
}

/**
 * 解析盘口大单
 */
export function parsePanelLargeOrder(f: string[]): PanelLargeOrder {
  return {
    buyLargeRatio: safeNumber(f[0]),
    buySmallRatio: safeNumber(f[1]),
    sellLargeRatio: safeNumber(f[2]),
    sellSmallRatio: safeNumber(f[3]),
  };
}

/**
 * 解析港股行情
 */
export function parseHKQuote(f: string[]): HKQuote {
  const time = f[30] ?? '';
  const timeMeta = buildTimeMeta(time, MARKET_TZ.HK);
  return {
    marketId: f[0] ?? '',
    name: f[1] ?? '',
    code: f[2] ?? '',
    price: safeNumber(f[3]),
    prevClose: safeNumber(f[4]),
    open: safeNumber(f[5]),
    volume: safeNumber(f[6]),
    time,
    timestamp: timeMeta.timestamp,
    tz: timeMeta.tz,
    change: safeNumber(f[31]),
    changePercent: safeNumber(f[32]),
    high: safeNumber(f[33]),
    low: safeNumber(f[34]),
    amount: safeNumber(f[37]),
    lotSize: safeNumberOrNull(f[40]),
    circulatingMarketCap: safeNumberOrNull(f[44]),
    totalMarketCap: safeNumberOrNull(f[45]),
    // R7-9: 尾部相对下标是长度门保护不了的 —— 真实行 ~50 字段（f[47]='HKD'），
    // 46-49 字段的截断/变体行会让 f[length-3] 落在数值列上。币种必须长得像
    // 币种（3 位大写字母），否则置空而不是输出一个价格串
    currency: /^[A-Z]{3}$/.test(f[f.length - 3] ?? '') ? f[f.length - 3] : '',
    market: 'HK',
    assetType: 'stock',
    source: 'tencent',
  };
}

/**
 * 解析美股行情
 */
export function parseUSQuote(f: string[]): USQuote {
  const time = f[30] ?? '';
  const timeMeta = buildTimeMeta(time, MARKET_TZ.US);
  return {
    marketId: f[0] ?? '',
    name: f[1] ?? '',
    code: f[2] ?? '',
    price: safeNumber(f[3]),
    prevClose: safeNumber(f[4]),
    open: safeNumber(f[5]),
    volume: safeNumber(f[6]),
    time,
    timestamp: timeMeta.timestamp,
    tz: timeMeta.tz,
    change: safeNumber(f[31]),
    changePercent: safeNumber(f[32]),
    high: safeNumber(f[33]),
    low: safeNumber(f[34]),
    amount: safeNumber(f[37]),
    turnoverRate: safeNumberOrNull(f[38]),
    pe: safeNumberOrNull(f[39]),
    amplitude: safeNumberOrNull(f[43]),
    totalMarketCap: safeNumberOrNull(f[45]),
    pb: safeNumberOrNull(f[47]),
    high52w: safeNumberOrNull(f[48]),
    low52w: safeNumberOrNull(f[49]),
    market: 'US',
    assetType: 'stock',
    source: 'tencent',
  };
}

/**
 * 解析基金行情
 */
export function parseFundQuote(f: string[]): FundQuote {
  const navDate = f[8] ?? '';
  const timeMeta = buildTimeMeta(navDate, MARKET_TZ.CN);
  return {
    code: f[0] ?? '',
    name: f[1] ?? '',
    nav: safeNumber(f[5]),
    accNav: safeNumber(f[6]),
    change: safeNumber(f[7]),
    navDate,
    timestamp: timeMeta.timestamp,
    tz: timeMeta.tz,
    market: 'CN',
    assetType: 'fund',
    source: 'tencent',
  };
}

