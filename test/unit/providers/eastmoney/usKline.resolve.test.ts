/**
 * R7-4 美股裸 ticker → secid 解析回归：
 * 此前 symbol 原样直传 secid，CLI/指标服务/MCP 自动路由的 'AAPL' 拼出
 * 非法 secid → 上游 data:null → 全线静默"无数据"。
 * 解析顺序：secid 直通 → 代码表（'105.AAPL' 形态，一次摊销）→ 105/106/107
 * 探测兜底 → 负缓存（1h，挡重试风暴）；缓存 secid 拉空时失效重解析一次。
 */
import { describe, it, expect, vi } from 'vitest';
import type { RequestClient } from '../../../../src/core';
import { NotFoundError } from '../../../../src/core';
import { getUSHistoryKline } from '../../../../src/providers/eastmoney/usKline';

interface FakeRoute {
  /** us 代码表响应的 list 字段 */
  codeList: string[];
  /** secid → 该 secid 的 kline 行（探测与正式请求同一路由） */
  klines: Record<string, string[]>;
}

/** fake client：按 URL 区分代码表请求与 kline 请求，记录全部调用。 */
function fakeClient(route: FakeRoute) {
  const calls: string[] = [];
  const get = vi.fn(async (url: string) => {
    calls.push(url);
    if (url.includes('/api/qt/stock/kline')) {
      const secid = new URL(url).searchParams.get('secid') ?? '';
      return { data: { klines: route.klines[secid] ?? [], code: secid.split('.')[1], name: '' } };
    }
    // 美股代码表（tencent fetchJsonCodeList 路径）
    return { success: true, list: route.codeList };
  });
  return { client: { get } as unknown as RequestClient, get, calls };
}

const klineUrls = (calls: string[]) => calls.filter((u) => u.includes('/api/qt/stock/kline'));
const secidOf = (url: string) => new URL(url).searchParams.get('secid');

describe('resolveUsSecid（经 getUSHistoryKline 端到端）', () => {
  it("显式 secid 直通：'105.AAPL' 不发代码表/探测请求", async () => {
    const { client, calls } = fakeClient({ codeList: [], klines: {} });
    const result = await getUSHistoryKline(client, '105.AAPL');
    expect(result).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(secidOf(calls[0])).toBe('105.AAPL');
  });

  it('裸 ticker 经代码表解析：BABA → 106.BABA（NYSE 免串行探测）', async () => {
    const { client, calls } = fakeClient({
      codeList: ['105.AAPL', '106.BABA'],
      klines: {},
    });
    await getUSHistoryKline(client, 'BABA');
    const klines = klineUrls(calls);
    expect(klines).toHaveLength(1);
    expect(secidOf(klines[0])).toBe('106.BABA');
    // 探测参数与正式请求同构由 buildEmKlineParams 保证：正式请求带 ut/fields
    expect(klines[0]).toContain('fields2=');
    expect(klines[0]).toContain('ut=');
  });

  it("'usBABA' 前缀形态同样可解析（依赖 R7-1 规范形剥离）", async () => {
    const { client, calls } = fakeClient({ codeList: ['106.BABA'], klines: {} });
    await getUSHistoryKline(client, 'usBABA');
    expect(secidOf(klineUrls(calls)[0])).toBe('106.BABA');
  });

  it('代码表未收录的新股走 105→106→107 探测（lmt=1 最小请求）', async () => {
    const { client, calls } = fakeClient({
      codeList: ['105.AAPL'],
      klines: { '106.NEWIPO': ['2024-01-02,1,1,1,1,1,1,1,1,1,1'] },
    });
    await getUSHistoryKline(client, 'NEWIPO');
    const klines = klineUrls(calls);
    // 2 次探测（105 空 → 106 命中）+ 1 次正式请求
    expect(klines.map(secidOf)).toEqual(['105.NEWIPO', '106.NEWIPO', '106.NEWIPO']);
    expect(new URL(klines[0]).searchParams.get('lmt')).toBe('1');
    // 探测命中后缓存：第二次调用零探测
    const before = calls.length;
    await getUSHistoryKline(client, 'NEWIPO');
    expect(klineUrls(calls.slice(before)).map(secidOf)).toEqual(['106.NEWIPO']);
  });

  it('无效 ticker：全 miss 抛 NotFoundError，负缓存挡住重试风暴', async () => {
    const { client, calls } = fakeClient({ codeList: ['105.AAPL'], klines: {} });
    await expect(getUSHistoryKline(client, 'BOGUS')).rejects.toThrow(NotFoundError);
    const probes = klineUrls(calls);
    expect(probes.map(secidOf)).toEqual(['105.BOGUS', '106.BOGUS', '107.BOGUS']);

    const before = calls.length;
    await expect(getUSHistoryKline(client, 'BOGUS')).rejects.toThrow(NotFoundError);
    expect(calls.length).toBe(before); // 负缓存命中：零新增请求
  });

  it('缓存 secid 拉回空结果：失效重解析一次，同 secid 则原样返回空（不循环）', async () => {
    const { client, calls } = fakeClient({ codeList: ['105.AAPL'], klines: {} });
    await getUSHistoryKline(client, 'AAPL'); // 首次：代码表解析 + 正式请求（空）
    const before = calls.length;
    await getUSHistoryKline(client, 'AAPL'); // 缓存命中 → 空 → 自愈重解析（代码表已缓存，同 secid）
    const newKlines = klineUrls(calls.slice(before));
    expect(newKlines.map(secidOf)).toEqual(['105.AAPL']); // 仅一次正式请求，无死循环
  });
});
