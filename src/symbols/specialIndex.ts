/**
 * 特殊指数注册表:东财 secid 前缀不走交易所推断的指数族。
 * 单一事实来源(normalize 分类 / adapters 拼接 / secid 回读共用),新增只改本文件。
 * 准入约束:按码形/字面无上下文匹配且分类语法确定,仅可收录与其它命名空间
 * 零碰撞的拼写(HSI、000985 类碰撞码需先给 lookup 加 hint 消歧参数);
 * 码形合法但不存在的码(如 H30553)由上游返回空数据,不做本地枚举校验。
 */
import type { Exchange, Market } from './types';

export interface SpecialIndexInfo {
  market: Market;
  exchange: Exchange;
  /** 东财 secid 数字市场前缀 */
  secidPrefix: string;
  /** 规范化(大写)后的指数代码,调用方应以此为准而非原始输入 */
  code: string;
}

/** 中证指数家族(开放集):93xxxx 与 H+5 位,均未被 A 股/美股/期货命名空间占用 */
const CSI_INFO: Omit<SpecialIndexInfo, 'code'> = {
  market: 'CN',
  exchange: 'CSI',
  secidPrefix: '2',
};
const CSI_PATTERNS = [/^93\d{4}$/, /^H\d{5}$/];

const NAMED_INDICES: Record<string, Omit<SpecialIndexInfo, 'code'>> = {
  /** 恒生医疗保健指数(Hang Seng Healthcare Index) */
  HSHCI: { market: 'HK', exchange: 'HSI', secidPrefix: '124' },
  /** 德国 DAX 指数 */
  GDAXI: { market: 'GLOBAL', exchange: 'DAX', secidPrefix: '100' },
};

/** 特殊指数 exchange → market 对(normalize 的 EXCHANGE_MARKET 由此 spread,单源) */
export const SPECIAL_INDEX_EXCHANGE_MARKET: ReadonlyArray<readonly [Exchange, Market]> = [
  [CSI_INFO.exchange, CSI_INFO.market],
  ...Object.values(NAMED_INDICES).map((i) => [i.exchange, i.market] as const),
];

/**
 * 按代码(大小写不敏感)查特殊指数;未命中返回 undefined。
 * 内部统一大写后匹配,返回值携带规范化 code。
 */
export function lookupSpecialIndex(code: string): SpecialIndexInfo | undefined {
  const upper = code.toUpperCase();
  if (CSI_PATTERNS.some((re) => re.test(upper))) {
    return { ...CSI_INFO, code: upper };
  }
  // 键全大写,不会命中 Object.prototype 继承属性(constructor 等均非全大写)
  const named = NAMED_INDICES[upper];
  return named ? { ...named, code: upper } : undefined;
}
