/**
 * Review 修复回归（F1）：wallTimeToUTC 的 DST 切换日偏差
 *
 * 旧实现只在 utcGuess 时刻采样一次时区偏移：当 utcGuess 与真实 UTC 落在
 * DST 切换两侧时（美东春令日壁钟 03:00–07:00、冬令日 01:00–06:00），
 * 换算结果整体偏 1 小时。修复后用二次采样定点迭代。
 */
import { describe, it, expect } from 'vitest';
import { parseMarketTime, formatInTz, MARKET_TZ } from '../../../src/core/time';

const US = MARKET_TZ.US; // America/New_York
const CN = MARKET_TZ.CN; // Asia/Shanghai

function iso(ts: number): string {
  return new Date(ts).toISOString();
}

describe('F1 春令日（2024-03-10，02:00 EST → 03:00 EDT）', () => {
  it('切换前 01:59 EST → UTC-5', () => {
    expect(iso(parseMarketTime('2024-03-10 01:59', US))).toBe(
      '2024-03-10T06:59:00.000Z'
    );
  });

  it('切换后 03:00 EDT → UTC-4（旧实现错为 08:00Z）', () => {
    expect(iso(parseMarketTime('2024-03-10 03:00', US))).toBe(
      '2024-03-10T07:00:00.000Z'
    );
  });

  it('盘前 04:00 EDT → 08:00Z（旧实现错为 09:00Z）', () => {
    expect(iso(parseMarketTime('2024-03-10 04:00', US))).toBe(
      '2024-03-10T08:00:00.000Z'
    );
  });

  it('06:59 EDT → 10:59Z（窗口末端）', () => {
    expect(iso(parseMarketTime('2024-03-10 06:59', US))).toBe(
      '2024-03-10T10:59:00.000Z'
    );
  });

  it('窗口外 12:00 EDT 不受影响', () => {
    expect(iso(parseMarketTime('2024-03-10 12:00', US))).toBe(
      '2024-03-10T16:00:00.000Z'
    );
  });

  it('不存在的壁钟 02:30 → 顺延语义（等同 03:30 EDT 时刻）', () => {
    expect(iso(parseMarketTime('2024-03-10 02:30', US))).toBe(
      '2024-03-10T07:30:00.000Z'
    );
  });
});

describe('F1 冬令日（2024-11-03，02:00 EDT → 01:00 EST）', () => {
  it('04:00 EST → 09:00Z（旧实现错为 08:00Z）', () => {
    expect(iso(parseMarketTime('2024-11-03 04:00', US))).toBe(
      '2024-11-03T09:00:00.000Z'
    );
  });

  it('切换前 00:30 EDT → 04:30Z', () => {
    expect(iso(parseMarketTime('2024-11-03 00:30', US))).toBe(
      '2024-11-03T04:30:00.000Z'
    );
  });

  it('歧义壁钟 01:30（出现两次）→ 确定性取较早一次（EDT）', () => {
    expect(iso(parseMarketTime('2024-11-03 01:30', US))).toBe(
      '2024-11-03T05:30:00.000Z'
    );
  });

  it('收盘后 16:00 EST → 21:00Z', () => {
    expect(iso(parseMarketTime('2024-11-03 16:00', US))).toBe(
      '2024-11-03T21:00:00.000Z'
    );
  });
});

describe('F1 非切换日与无 DST 时区不受影响', () => {
  it('美东普通交易日 09:30 EDT → 13:30Z', () => {
    expect(iso(parseMarketTime('2024-05-10 09:30', US))).toBe(
      '2024-05-10T13:30:00.000Z'
    );
  });

  it('上海无 DST：DST 切换日同时刻 → 固定 UTC+8', () => {
    expect(iso(parseMarketTime('2024-03-10 04:00', CN))).toBe(
      '2024-03-09T20:00:00.000Z'
    );
  });
});

describe('F1 formatInTz 与 parseMarketTime 在 DST 日互逆', () => {
  it.each([
    '2024-03-10 04:00',
    '2024-03-10 06:30',
    '2024-11-03 01:00',
    '2024-11-03 04:00',
    '2024-11-03 09:30',
  ])('%s 往返一致', (wall) => {
    expect(formatInTz(parseMarketTime(wall, US), US)).toBe(wall);
  });
});
