/**
 * 时间元信息工具
 *
 * 给行情/K线/分时等含时间字段的数据补充统一的 `timestamp` (UTC unix ms)
 * 与 `tz` (IANA 时区名)，让消费者无需自己根据各数据源的字符串格式做时区换算。
 *
 * 设计要点:
 * - 不引入第三方时区库 (SDK 零依赖),通过 `Intl.DateTimeFormat` 计算时区偏移。
 * - 兼容多种本地时间字符串格式 (yyyyMMddHHmmss / YYYY-MM-DD HH:mm:ss / YYYY-MM-DD HH:mm /
 *   YYYY-MM-DD / yyyyMMdd / HH:mm 配 baseDate)。
 * - 解析失败/输入为空时 `timestamp` 为 `NaN`,调用方可用 `Number.isNaN` 检测。
 */

/**
 * 已支持的市场时区。沿用 IANA 时区名。
 *
 * - `Asia/Shanghai`: A 股 (沪深北)
 * - `Asia/Hong_Kong`: 港股
 * - `America/New_York`: 美股 (含夏令时切换)
 */
export const MARKET_TZ = {
  CN: 'Asia/Shanghai',
  HK: 'Asia/Hong_Kong',
  US: 'America/New_York',
} as const;

export type MarketTz = (typeof MARKET_TZ)[keyof typeof MARKET_TZ];

/**
 * 时间元信息:与原始 `time`/`date` 字符串配套使用。
 */
export interface TimeMeta {
  /** UTC unix 毫秒时间戳。原始字符串无法解析时为 `null`。 */
  timestamp: number | null;
  /** 原始字符串对应的市场时区 (IANA name)。 */
  tz: MarketTz;
}

interface ParsedWallClock {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/**
 * 把多种格式的本地壁钟时间字符串解析为 (年/月/日/时/分/秒)。
 * 不识别格式时返回 `null`。
 */
function parseWallClock(input: string): ParsedWallClock | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  // YYYY-MM-DD[ T]HH:mm[:ss]
  const longMatch =
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(trimmed);
  if (longMatch) {
    return {
      year: +longMatch[1],
      month: +longMatch[2],
      day: +longMatch[3],
      hour: +longMatch[4],
      minute: +longMatch[5],
      second: longMatch[6] ? +longMatch[6] : 0,
    };
  }

  // YYYY-MM-DD
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (dateMatch) {
    return {
      year: +dateMatch[1],
      month: +dateMatch[2],
      day: +dateMatch[3],
      hour: 0,
      minute: 0,
      second: 0,
    };
  }

  // yyyyMMddHHmmss (14 字符无分隔符)
  if (/^\d{14}$/.test(trimmed)) {
    return {
      year: +trimmed.slice(0, 4),
      month: +trimmed.slice(4, 6),
      day: +trimmed.slice(6, 8),
      hour: +trimmed.slice(8, 10),
      minute: +trimmed.slice(10, 12),
      second: +trimmed.slice(12, 14),
    };
  }

  // yyyyMMdd (8 字符)
  if (/^\d{8}$/.test(trimmed)) {
    return {
      year: +trimmed.slice(0, 4),
      month: +trimmed.slice(4, 6),
      day: +trimmed.slice(6, 8),
      hour: 0,
      minute: 0,
      second: 0,
    };
  }

  return null;
}

/**
 * 给定一个市场时区,把"该时区的壁钟时间"换算成 UTC unix ms。
 * 使用 `Intl.DateTimeFormat` 二次查询确定时区偏移,可正确处理夏令时。
 */
/**
 * 缓存 Intl.DateTimeFormat：其构造是 V8 中最昂贵的操作之一(每次重载 ICU 区域数据),
 * 而每个 (locale, tz) 的 options 固定。按行调用的 kline/quote/timeline parser 循环里
 * 复用同一实例,避免逐行重建(3000 bar K 线原本要建 3000 个 formatter)。
 * key 用 locale|tz —— 本模块每个 locale 对应唯一一组 options(en-US 含秒、sv-SE 不含)。
 */
const FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();
function getCachedFormatter(
  locale: string,
  tz: string,
  options: Intl.DateTimeFormatOptions
): Intl.DateTimeFormat {
  const key = `${locale}|${tz}|${JSON.stringify(options)}`;
  let dtf = FORMATTER_CACHE.get(key);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat(locale, { timeZone: tz, ...options });
    FORMATTER_CACHE.set(key, dtf);
  }
  return dtf;
}

/** 求 UTC 时刻 `tsUtc` 在目标时区显示的壁钟时间（编码为 UTC ms，便于做差求偏移） */
function displayedWallUtc(tsUtc: number, tz: string): number {
  const dtf = getCachedFormatter('en-US', tz, {
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = dtf.formatToParts(new Date(tsUtc));
  const partMap: Record<string, string> = {};
  for (const p of parts) {
    if (p.type !== 'literal') partMap[p.type] = p.value;
  }
  // Intl 在某些区域会输出 "24" 表示 0 点,统一归一化。
  let displayedHour = parseInt(partMap.hour ?? '0', 10);
  if (displayedHour === 24) displayedHour = 0;

  return Date.UTC(
    parseInt(partMap.year ?? '0', 10),
    parseInt(partMap.month ?? '1', 10) - 1,
    parseInt(partMap.day ?? '1', 10),
    displayedHour,
    parseInt(partMap.minute ?? '0', 10),
    parseInt(partMap.second ?? '0', 10)
  );
}

function wallTimeToUTC(wall: ParsedWallClock, tz: string): number {
  // 目标:找到 UTC 时刻 T,使其在 tz 显示的壁钟 == wall。
  // 记 displayed(T) 为 T 在 tz 的壁钟(UTC ms 编码),偏移 off(T) = displayed(T) - T,
  // 则解满足 T = target - off(T),用定点迭代求解。
  const target = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second
  );

  // 第一遍:在 target 时刻采样偏移。target 与真实 T 落在 DST 切换同侧时一次即中。
  const first = 2 * target - displayedWallUtc(target, tz);
  if (displayedWallUtc(first, tz) === target) {
    return first;
  }

  // 第二遍:首遍偏移取错了切换侧(美东春令日 03:00–07:00 / 冬令日 01:00–06:00 的
  // 壁钟窗口,单遍会整体偏 1 小时),在 first 时刻重新采样偏移再算一次。
  const second = target - displayedWallUtc(first, tz) + first;
  if (displayedWallUtc(second, tz) === target) {
    return second;
  }

  // 两遍都不命中:wall 是春令跳变中不存在的壁钟时间(如美东 02:30),
  // 取首遍结果 —— 按「顺延到跳变后」语义返回(02:30 缺失 → 等同 03:30 EDT 时刻)。
  return first;
}

/**
 * 把 `'HH:mm'` 或 `'HH:mm:ss'` 配合一个基础日期组合成完整本地壁钟时间。
 *
 * 用于"当日分时"等场景:接口返回的时间只有 `HH:mm`,日期需要从外层 `date` 字段拿。
 *
 * 支持的 baseDate 格式：
 *  - `YYYY-MM-DD`（带横线）
 *  - `YYYYMMDD`  （腾讯分时接口的原始格式）
 */
function combineDateAndTime(
  baseDate: string,
  hhmm: string
): ParsedWallClock | null {
  const trimmedDate = (baseDate || '').trim();
  const dateMatch =
    /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmedDate) ??
    /^(\d{4})(\d{2})(\d{2})$/.exec(trimmedDate);
  if (!dateMatch) return null;
  const timeMatch = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec((hhmm || '').trim());
  if (!timeMatch) return null;
  return {
    year: +dateMatch[1],
    month: +dateMatch[2],
    day: +dateMatch[3],
    hour: +timeMatch[1],
    minute: +timeMatch[2],
    second: timeMatch[3] ? +timeMatch[3] : 0,
  };
}

/**
 * 解析"市场本地时间字符串"为 UTC unix ms。失败返回 `NaN`。
 *
 * 支持的格式:
 * - `'YYYY-MM-DD HH:mm:ss'` / `'YYYY-MM-DDTHH:mm:ss'`
 * - `'YYYY-MM-DD HH:mm'`
 * - `'YYYY-MM-DD'` (按当日 00:00 计)
 * - `'yyyyMMddHHmmss'` (腾讯接口 14 位无分隔)
 * - `'yyyyMMdd'` (8 位日期)
 *
 * @param local 市场本地时间字符串
 * @param tz    市场时区 (使用 `MARKET_TZ`)
 */
export function parseMarketTime(local: string, tz: MarketTz): number {
  const wall = parseWallClock(local);
  if (!wall) return NaN;
  return wallTimeToUTC(wall, tz);
}

/**
 * 构造 `TimeMeta`。原始字符串无法解析时 `timestamp` 为 `NaN`。
 *
 * @param local 市场本地时间字符串
 * @param tz    市场时区
 */
/** 把 parseMarketTime 的 `NaN` 结果归一化为 `null`（v2：禁止手写 NaN） */
function toNullableEpoch(ts: number): number | null {
  return Number.isNaN(ts) ? null : ts;
}

export function buildTimeMeta(local: string, tz: MarketTz): TimeMeta {
  return { timestamp: toNullableEpoch(parseMarketTime(local, tz)), tz };
}

/**
 * 将"基础日期 (YYYY-MM-DD) + HH:mm 时间片"组合后构造 `TimeMeta`。
 *
 * 用于"当日分时"等只返回 `HH:mm` 的接口。
 *
 * @param baseDate 形如 `'2024-05-12'` 的日期字符串
 * @param hhmm     形如 `'09:30'` 或 `'09:30:00'` 的时间片
 * @param tz       市场时区
 */
export function buildTimeMetaFromDateAndTime(
  baseDate: string,
  hhmm: string,
  tz: MarketTz
): TimeMeta {
  const wall = combineDateAndTime(baseDate, hhmm);
  if (!wall) return { timestamp: null, tz };
  return { timestamp: toNullableEpoch(wallTimeToUTC(wall, tz)), tz };
}

/**
 * 把 UTC 毫秒时间戳格式化为指定时区的 `YYYY-MM-DD HH:mm` 本地壁钟字符串。
 *
 * 与 {@link parseMarketTime} 互逆：`formatInTz(parseMarketTime(s, tz), tz) === s`
 * （只要 `s` 是 `YYYY-MM-DD HH:mm` 格式）。
 *
 * 用途：当上游接口返回的时间字符串使用 A 处时区表示，但业务需要在 B 处时区显示时
 * （典型：东方财富的美股分时返回北京时间字符串，但用户需要美东时间），先用
 * `parseMarketTime(s, MARKET_TZ.CN)` 拿到正确 epoch，再用本函数转成目标时区字符串。
 *
 * 使用 `Intl.DateTimeFormat` 处理夏令时；epoch 为 `NaN` 时返回空串。
 */
export function formatInTz(epoch: number | null, tz: MarketTz): string {
  if (epoch == null || !Number.isFinite(epoch)) return '';
  // 用 sv-SE locale 直接 format —— sv-SE 天然以 `YYYY-MM-DD HH:mm:ss` 形式输出，
  // 比 formatToParts + 手动拼接更稳健（避免某些 Node ICU 实现里 minute 字段
  // 携带额外冒号后缀的怪异行为）。
  const formatted = getCachedFormatter('sv-SE', tz, {
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(epoch));
  // sv-SE 输出可能是 "2024-05-12 09:30" 或 "2024-05-12 09:30:00"，截到分钟即可。
  // 同时把可能出现的 "24:" 归一化为 "00:"
  const match = formatted.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/);
  if (!match) return formatted;
  const hour = match[2] === '24' ? '00' : match[2];
  return `${match[1]} ${hour}:${match[3]}`;
}
