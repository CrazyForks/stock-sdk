# 30-Day Per-Stock Changes Panorama

"Show me a stock's changes over the past 30 days" needs two layers of data stitched together:

| Layer | Data | Coverage | Method |
|---|---|---|---|
| **Tick-level change events** | Sealed limit-up / large buy / rocket launch, event by event | Only **roughly the last few weeks** (Eastmoney server retention, with occasional per-date gaps) | `marketEvent.individualChangesHistory` |
| **Daily proxies** | Main-capital net inflow, limit-up detection, dragon-tiger listings | **Long history**, no window limit | `fundFlow.individual` + `kline.cn` + `dragonTiger.detail` |

Use event details inside the window, and daily proxies to complete the 30-day view beyond it.

## Step 1: tick-level events inside the window

```ts
import { StockSDK } from 'stock-sdk';

const sdk = new StockSDK();
const symbol = '603087';

const his = await sdk.marketEvent.individualChangesHistory(symbol, { days: 30 });

// coverage tells you the boundary: no tick events before availableFrom
console.log(his.coverage);
// { from: '2026-06-07', to: '2026-07-06', availableFrom: '2026-06-12' }

// Per-type overview (keyed by raw type code; Chinese label inline)
console.log(his.stats);
// { '4': { count: 12, label: '封涨停板' }, '8193': { count: 45, label: '大笔买入' }, ... }

// Dates beyond the window: available === false
const missing = his.days.filter(d => !d.available).map(d => d.date);
```

## Step 2: daily proxies beyond the window

For `available: false` dates, reconstruct what happened from three long-history sources:

```ts
// ① Main capital: daily net inflow (the "large buy/sell" perspective)
const flows = await sdk.fundFlow.individual(symbol, { period: 'daily' });
const flowByDate = new Map(flows.map(f => [f.date, f]));

// ② Limit-up detection: computed locally from daily K-lines
//    (±10% main board / ±20% ChiNext & STAR — adjust to the board's rule)
const klines = await sdk.kline.cn(symbol, { adjust: '', startDate: '20260601' });
const limitUps = klines.filter((k, i) => {
  if (i === 0 || k.close == null || klines[i - 1].close == null) return false;
  const pct = (k.close - klines[i - 1].close!) / klines[i - 1].close! * 100;
  return pct > 9.9; // main-board example
});

// ③ Dragon-tiger list: was it listed outside the window?
const lhb = await sdk.dragonTiger.detail({ startDate: '20260607', endDate: '20260612' });
const onList = lhb.filter(row => row.code === symbol.replace(/^\D+/, ''));
```

## Assembling the panorama

```ts
for (const day of his.days) {
  if (day.available) {
    console.log(`${day.date} [tick] ${day.changes.length} events`);
  } else {
    const flow = flowByDate.get(day.date);
    const isLimitUp = limitUps.some(k => k.date === day.date);
    console.log(
      `${day.date} [daily] main net inflow ${flow?.mainNetInflow ?? '—'}` +
        (isLimitUp ? ' · limit-up' : '')
    );
  }
}
```

## Notes

- **Retention drifts and is not contiguous**: roughly the last month is queryable in practice, but per-date gaps exist (we've even seen older dates with data while newer ones were empty) — always branch on the per-day `available`, never hardcode a day count;
- **Request volume**: `days: 30` ≈ 22 trading days = 22 requests (concurrency 4 internally, throttled by the SDK's provider policy); cache on your side for frequent calls;
- **Unlimited tick-level history**: only possible by collecting `individualChanges` daily into your own store — the per-day method is designed to be that collector.
