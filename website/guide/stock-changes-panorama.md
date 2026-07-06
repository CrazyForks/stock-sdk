# 个股 30 天异动全景

「看一只股票过去 30 天的异动」需要两类数据拼起来:

| 层次 | 数据 | 覆盖范围 | 方法 |
|---|---|---|---|
| **tick 级异动事件** | 封涨停板 / 大笔买入 / 火箭发射等逐笔事件 | 仅**约最近数周**(东财服务端保留,且可能有个别日期空洞) | `marketEvent.individualChangesHistory` |
| **日度代理指标** | 主力资金净流入、涨停判定、龙虎榜上榜 | **长历史**,不受窗口限制 | `fundFlow.individual` + `kline.cn` + `dragonTiger.detail` |

窗口内看事件明细,窗口外用日度数据补全 30 天视角。

## 第一步:窗口内的 tick 级事件

```ts
import { StockSDK } from 'stock-sdk';

const sdk = new StockSDK();
const symbol = '603087';

const his = await sdk.marketEvent.individualChangesHistory(symbol, { days: 30 });

// coverage 告诉你窗口边界:availableFrom 之前的日期拿不到 tick 级事件
console.log(his.coverage);
// { from: '2026-06-07', to: '2026-07-06', availableFrom: '2026-06-12' }

// 类型概览(键为原始类型码,中文标签在值里)
console.log(his.stats);
// { '4': { count: 12, label: '封涨停板' }, '8193': { count: 45, label: '大笔买入' }, ... }

// 超窗的日期:available === false
const missing = his.days.filter(d => !d.available).map(d => d.date);
```

## 第二步:窗口外的日度补全

对 `available: false` 的日期,用三类长历史数据还原当天发生了什么:

```ts
// ① 主力资金:每日主力净流入(对应"主力买入/卖出"视角)
const flows = await sdk.fundFlow.individual(symbol, { period: 'daily' });
const flowByDate = new Map(flows.map(f => [f.date, f]));

// ② 涨停判定:从日 K 线本地计算(±10% 主板 / ±20% 创业板科创板,按需调整)
const klines = await sdk.kline.cn(symbol, { adjust: '', startDate: '20260601' });
const limitUps = klines.filter((k, i) => {
  if (i === 0 || k.close == null || klines[i - 1].close == null) return false;
  const pct = (k.close - klines[i - 1].close!) / klines[i - 1].close! * 100;
  return pct > 9.9; // 主板口径示例
});

// ③ 龙虎榜:窗口外是否上过榜
const lhb = await sdk.dragonTiger.detail({ startDate: '20260607', endDate: '20260612' });
const onList = lhb.filter(row => row.code === symbol.replace(/^\D+/, ''));
```

## 拼装 30 天全景

```ts
for (const day of his.days) {
  if (day.available) {
    console.log(`${day.date} [tick] ${day.changes.length} 条事件`);
  } else {
    const flow = flowByDate.get(day.date);
    const isLimitUp = limitUps.some(k => k.date === day.date);
    console.log(
      `${day.date} [日度] 主力净流入 ${flow?.mainNetInflow ?? '—'}` +
        (isLimitUp ? ' · 涨停' : '')
    );
  }
}
```

## 注意事项

- **保留范围会漂移且不连续**:实测约 1 个月内可查,但存在个别日期空洞(更早日期反而有数据的情况也出现过)—— 永远以返回的逐日 `available` 为判断依据,不要硬编码天数;
- **请求量**:`days: 30` ≈ 22 个交易日 = 22 个请求(内部并发 4,走 SDK 限流);高频调用建议自建缓存或降低 days;
- **想要不受窗口限制的 tick 级历史**:只能自建定时任务每日采集 `individualChanges` 落库(SDK 的日度方法适合做这个采集器)。
