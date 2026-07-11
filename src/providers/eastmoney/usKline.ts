/**
 * 东方财富 - 美股 K 线
 */
import {
  RequestClient,
  EM_US_KLINE_URL,
  EM_US_TRENDS_URL,
  MARKET_TZ,
  NotFoundError,
  getClientScopedCache,
  type MemoryCache,
} from '../../core';
import type {
  USHistoryKline,
  USMinuteKline,
  USMinuteTimeline,
} from '../../types';
import { normalizeSymbol } from '../../symbols';
import { getUSCodeList } from '../tencent/batch';
import { fetchEmHistoryKline } from './utils';
import {
  buildEmKlineParams,
  createHistoryKlineProvider,
  type HistoryKlineRequestOptions,
} from './historyKlineFactory';
import {
  createMinuteKlineProvider,
  createOverseasMinuteRowMappers,
} from './minuteKlineFactory';

export interface USKlineOptions extends HistoryKlineRequestOptions {}

// ============================================================
// R7-4: 裸 ticker → secid 解析
// 此前 symbol 原样直传 secid，CLI/指标服务/MCP 自动路由过来的
// 'AAPL' 拼出非法 secid → 上游 data:null → 全线静默"无数据"。
// ============================================================

/** 负缓存哨兵：无效 ticker 的解析结论（短 TTL，挡重试风暴不挡纠错） */
const US_SECID_NOT_FOUND = '__NOT_FOUND__';
const US_SECID_TTL = 30 * 24 * 60 * 60 * 1000; // 命中 30 天
const US_SECID_NEG_TTL = 60 * 60 * 1000; // 未命中 1 小时

function usSecidCache(client: RequestClient): MemoryCache<string> {
  // per-client 作用域：mock/代理实例的解析结论不串给其它实例（R7-11a 基建）
  return getClientScopedCache<string>(client, 'eastmoney:us-secid', {
    maxSize: 4096,
  });
}

interface ResolvedUsSecid {
  secid: string;
  /** 裸 ticker 解析路径才有；secid 直通时为 undefined */
  ticker?: string;
  fromCache: boolean;
}

async function resolveUsSecid(
  client: RequestClient,
  symbol: string
): Promise<ResolvedUsSecid> {
  if (/^\d{2,3}\./.test(symbol)) {
    // '105.AAPL' 直通；'100.GDAXI' raw-secid 逃生口不受影响
    return { secid: symbol, fromCache: false };
  }
  const ticker = normalizeSymbol(symbol, { market: 'US' }).code;
  const cache = usSecidCache(client);
  const hit = cache.get(ticker);
  if (hit === US_SECID_NOT_FOUND) {
    throw new NotFoundError(`美股代码不存在或不支持: ${ticker}`, 'eastmoney');
  }
  if (hit !== undefined) {
    return { secid: hit, ticker, fromCache: true };
  }

  // ① 代码表优先：getUSCodeList 返回的本就是 '105.AAPL' 形态（6h 缓存），
  //   一次摊销请求同时解决正/负存在性，NYSE/AMEX 免串行探测。
  //   跨 provider 依赖（东财 K 线 ← 腾讯代码表）是声明的权衡：失败退②，非硬依赖。
  try {
    const list = await getUSCodeList(client);
    const found = list.find((s) => s.slice(s.indexOf('.') + 1) === ticker);
    if (found) {
      cache.set(ticker, found, US_SECID_TTL);
      return { secid: found, ticker, fromCache: false };
    }
  } catch {
    // 代码表不可用（网络/上游异常）→ 退探测
  }

  // ② 探测兜底（代码表滞后的新股）：klt=101 & lmt=1 最小请求，
  //   参数经 buildEmKlineParams 与正式请求同构
  for (const prefix of ['105', '106', '107']) {
    const secid = `${prefix}.${ticker}`;
    const resp = await fetchEmHistoryKline(
      client,
      EM_US_KLINE_URL,
      buildEmKlineParams(secid, { klt: '101', fqt: '0', lmt: '1' })
    );
    if (resp.klines.length > 0) {
      cache.set(ticker, secid, US_SECID_TTL);
      return { secid, ticker, fromCache: false };
    }
  }
  cache.set(ticker, US_SECID_NOT_FOUND, US_SECID_NEG_TTL);
  throw new NotFoundError(`美股代码不存在或不支持: ${ticker}`, 'eastmoney');
}

/**
 * 解析 secid 后执行取数；缓存的 secid 拉回空结果时失效重解析一次
 * （覆盖 30 天缓存窗口内转板 NYSE↔NASDAQ / 退市的自愈，单次防环）。
 * 探测请求是全历史范围（beg=19700101），合法 ticker 的重解析必然命中
 * 同一 secid → 原样返回空结果，不会把"合法的空窗口查询"误判成失效。
 */
async function withUsSecid<T extends unknown[]>(
  client: RequestClient,
  symbol: string,
  run: (secid: string) => Promise<T>
): Promise<T> {
  const first = await resolveUsSecid(client, symbol);
  const result = await run(first.secid);
  if (result.length > 0 || !first.fromCache || first.ticker === undefined) {
    return result;
  }
  usSecidCache(client).delete(first.ticker);
  const second = await resolveUsSecid(client, symbol);
  if (second.secid === first.secid) {
    return result;
  }
  return run(second.secid);
}

const getUSHistoryKlineByFactory = createHistoryKlineProvider<USHistoryKline>({
  url: EM_US_KLINE_URL,
  tz: MARKET_TZ.US,
  normalizeSymbol: (symbol) => ({
    secid: symbol,
    fallbackCode: symbol.split('.')[1] || symbol,
  }),
  resolveResultMeta: (symbol, normalizedSymbol, response) => ({
    code: response.code || normalizedSymbol.fallbackCode,
    name: response.name || '',
  }),
  enrichItem: (base) => ({
    ...base,
    currency: 'USD',
  }),
});

/**
 * 获取美股历史 K 线（日/周/月）。
 *
 * **复权默认值:`adjust='qfq'`(前复权)。** 详见
 * [复权说明](https://stock-sdk.linkdiary.cn/guide/dividend-adjustment.html)。
 *
 * @param symbol 美股代码：裸 ticker（`'AAPL'`/`'usBABA'`，自动解析交易所前缀）
 *   或显式 secid（`'105.MSFT'`、`'106.BABA'`）。无效 ticker 抛 NotFoundError。
 */
export async function getUSHistoryKline(
  client: RequestClient,
  symbol: string,
  options: USKlineOptions = {}
): Promise<USHistoryKline[]> {
  return withUsSecid(client, symbol, (secid) =>
    getUSHistoryKlineByFactory(client, secid, options)
  );
}

// ============================================================
// 美股分钟 K 线 / 当日分时（v1.10.0+）
// ============================================================

export interface USMinuteKlineOptions {
  /** K 线周期 @default '1' */
  period?: '1' | '5' | '15' | '30' | '60';
  /**
   * 复权类型（仅 5/15/30/60 分钟有效；1 分钟分时不支持复权）
   * @default 'qfq'
   */
  adjust?: '' | 'qfq' | 'hfq';
  /** 开始时间 `YYYY-MM-DD HH:mm`（美东时区 `America/New_York`，自动 DST） */
  startDate?: string;
  /** 结束时间 `YYYY-MM-DD HH:mm`（美东时区） */
  endDate?: string;
  /**
   * 仅 `period='1'` 生效：返回最近 N 个交易日的分时。
   * 默认 `1`（当日分时）。可设为 `5` 拿近 5 日分时。
   */
  ndays?: number;
}

// F45:分钟K线流程收编进 createMinuteKlineProvider 工厂,美股差异点:
// - secid 直传(格式 `{market}.{ticker}`),行的 code 取 ticker 部分
// - 行时间走 createOverseasMinuteRowMappers:上游 time 是北京时间字符串,
//   必须先按 Asia/Shanghai 解 epoch 再 format 到 America/New_York(带夏令时,
//   与北京差 12-13 小时;若直接当 NYC 时间解析,timestamp 与窗口过滤都会错)
// - F34 beg/end 下推:上游按【北京时间】日期裁剪,而本函数的 startDate/endDate
//   是美东时区 —— NY 交易日 D 的下午盘对应北京时间 D+1 凌晨,end 取当天会把
//   这些行裁掉,故 endExtraDays=1 给 end 加 1 天保证服务端窗口是目标数据的
//   超集;beg 无此问题(NY 日期 D 的行其北京日期只会是 D 或 D+1)。
//   多拉的边缘行仍由工厂的 NY 本地时间过滤兜底,语义不变。
const getUSMinuteKlineByFactory = createMinuteKlineProvider<
  USMinuteTimeline,
  USMinuteKline
>({
  trendsUrl: EM_US_TRENDS_URL,
  klineUrl: EM_US_KLINE_URL,
  resolveTarget: (symbol) => ({
    secid: symbol,
    code: symbol.split('.')[1] || symbol,
  }),
  defaultPeriod: '1',
  ndays: 'option',
  fqt: 'option',
  includeUt: true,
  window: { mode: 'filter', endExtraDays: 1 },
  ...createOverseasMinuteRowMappers(MARKET_TZ.US, 'USD'),
});

/**
 * 获取美股分钟 K 线（5/15/30/60 分钟）或当日分时（1 分钟）。
 *
 * 不含盘前 / 盘后数据，仅常规交易时段。
 *
 * `period='1'` 时走 `trends2/get`，返回 {@link USMinuteTimeline}[]；
 * `period='5'|'15'|'30'|'60'` 时走 `kline/get`，返回 {@link USMinuteKline}[]。
 *
 * @param symbol 美股代码：裸 ticker（`'AAPL'`/`'usBABA'`，自动解析交易所前缀）
 *   或显式 secid（`'105.AAPL'`、`'106.BABA'`）。无效 ticker 抛 NotFoundError。
 */
export async function getUSMinuteKline(
  client: RequestClient,
  symbol: string,
  options: USMinuteKlineOptions = {}
): Promise<USMinuteTimeline[] | USMinuteKline[]> {
  return withUsSecid(client, symbol, (secid) =>
    getUSMinuteKlineByFactory(client, secid, options)
  );
}
