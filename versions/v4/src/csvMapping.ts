import {
  blankAsset,
  normalizeTicker,
  validate,
  initialPortfolio,
  type Asset,
  type Portfolio,
} from "./engine";
import { parseCSVRows } from "./csvRows";
import { exactProduct } from "./decimal";

export interface CSVTable {
  header: string[];
  rows: string[][];
}
export interface ColumnMapping {
  ticker: number;
  shares: number;
  price: number;
  name: number;
  currency: number;
}
export const emptyMapping: ColumnMapping = {
  ticker: -1,
  shares: -1,
  price: -1,
  name: -1,
  currency: -1,
};
const aliases: Record<keyof ColumnMapping, string[]> = {
  ticker: ["ticker", "symbol", "代號", "股票代號", "證券代號", "標的代號"],
  shares: [
    "shares",
    "quantity",
    "股數",
    "持有股數",
    "庫存股數",
    "庫存數量",
    "張數",
    "數量",
  ],
  price: ["price", "現價", "市價", "每股價格", "參考價格"],
  name: ["name", "名稱", "證券名稱", "股票名稱", "標的全稱"],
  currency: ["currency", "幣別", "交易幣別"],
};
const clean = (s: string) => s.normalize("NFKC").trim().toLowerCase();
export function guessMapping(table: CSVTable): ColumnMapping {
  return Object.fromEntries(
    Object.entries(aliases).map(([key, names]) => {
      const matches = table.header
        .map((h, i) => (names.includes(clean(h)) ? i : -1))
        .filter((i) => i >= 0);
      return [key, matches.length === 1 ? matches[0] : -1];
    }),
  ) as unknown as ColumnMapping;
}
export function inspectCSV(text: string): { table: CSVTable; native: boolean } {
  if (text.includes("\uFFFD"))
    throw new Error("CSV 含無法解碼的字元，請另存為 UTF-8 後再匯入");
  const rows = parseCSVRows(text);
  const header = rows.shift() ?? [];
  if (!header.length) throw new Error("CSV 沒有欄位標題");
  if (rows.some((r) => r.length !== header.length))
    throw new Error("CSV 各列欄位數須與標題一致");
  const normalized = header.map(clean);
  // A malformed native exchange file must never downgrade to the permissive mapper.
  const native =
    normalized.some((h) =>
      [
        "formatversion",
        "recordtype",
        "quantityunit",
        "priceunit",
        "rateunit",
      ].includes(h),
    ) ||
    [
      "ticker",
      "kind",
      "shares",
      "price",
      "target",
      "limit",
      "lot",
      "feerate",
      "minfee",
      "selltaxrate",
    ].every((h) => normalized.includes(h));
  if (native) return { table: { header, rows }, native };
  if (
    normalized.some((h) =>
      /買賣股數|成交|交易日期|交易方向|買賣別|trade.?date|trade.?type|execution|^side$/.test(
        h,
      ),
    )
  )
    throw new Error("這可能是交易紀錄，不能當作持倉匯入；請提供目前庫存表");
  if (
    header.some((h) => !h.trim()) ||
    new Set(normalized).size !== header.length
  )
    throw new Error("CSV 標題不可空白或重複");
  if (!rows.length) throw new Error("外部 CSV 沒有持倉資料");
  return { table: { header, rows }, native: false };
}
function decimalCell(value: string, field: string, line: number): number {
  const text = value.normalize("NFKC").trim();
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(text))
    throw new Error(
      `第 ${line} 列${field}須為非負十進位數字，千分位請使用完整分組`,
    );
  const result = Number(text.replaceAll(",", ""));
  if (!Number.isFinite(result))
    throw new Error(`第 ${line} 列${field}超出數值範圍`);
  return result;
}
export function mapHoldings(
  table: CSVTable,
  mapping: ColumnMapping,
  unit: "" | "share" | "lot",
): Asset[] {
  if (!unit) throw new Error("請明確選擇數量單位：股或張");
  const selected = Object.entries(mapping).filter(([, i]) => i >= 0);
  if ([mapping.ticker, mapping.shares, mapping.price].some((i) => i < 0))
    throw new Error("請指定標的代號、持有數量與每股價格欄位");
  if (
    selected.some(
      ([, i]) => !Number.isInteger(i) || i >= table.header.length,
    ) ||
    new Set(selected.map(([, i]) => i)).size !== selected.length
  )
    throw new Error("欄位對應不可重複或超出範圍");
  const currencyColumns = table.header
    .map((h, i) => (aliases.currency.includes(clean(h)) ? i : -1))
    .filter((i) => i >= 0);
  const tickers = new Set<string>();
  const assets = table.rows.map((row, i) => {
    const line = i + 2;
    for (const c of new Set([
      ...currencyColumns,
      ...(mapping.currency >= 0 ? [mapping.currency] : []),
    ]))
      if (
        !["TWD", "NTD", "新臺幣", "新台幣", "台幣", "臺幣"].includes(
          row[c].trim().toUpperCase(),
        )
      )
        throw new Error(`第 ${line} 列不是可確認的新臺幣資料；不提供外幣換算`);
    const ticker = normalizeTicker(row[mapping.ticker]);
    if (!/^[0-9A-Z]{4,8}$/.test(ticker) || /^\d+E\d+$/.test(ticker))
      throw new Error(
        `第 ${line} 列代號格式無效；須保留開頭的 0，不接受科學記號`,
      );
    if (tickers.has(ticker))
      throw new Error(
        `第 ${line} 列代號 ${ticker} 重複；請先核對帳戶／重複列，不會自行加總`,
      );
    tickers.add(ticker);
    const quantityText = row[mapping.shares].normalize("NFKC").trim();
    const fraction = (quantityText.split(".")[1] ?? "").replace(/0+$/, "");
    if (fraction.length > (unit === "lot" ? 3 : 0))
      throw new Error(`第 ${line} 列換算後股數須為整數`);
    const quantity = exactProduct(
      decimalCell(row[mapping.shares], "數量", line),
      unit === "lot" ? 1000 : 1,
    );
    if (quantity.n % quantity.d !== 0n)
      throw new Error(`第 ${line} 列換算後股數須為整數`);
    const shares = Number(quantity.n / quantity.d);
    const price = decimalCell(row[mapping.price], "每股價格", line);
    return {
      ...blankAsset(),
      ticker,
      shares,
      price,
      feeMode: "manual" as const,
      ...(mapping.name >= 0 && row[mapping.name].trim()
        ? { name: row[mapping.name].trim() }
        : {}),
    };
  });
  const issues = validate({ ...initialPortfolio(), cash: 1, assets });
  if (issues.length) throw new Error(issues.join("；"));
  return assets;
}

export function mappedPortfolio(
  current: Portfolio,
  imported: Asset[],
): Portfolio {
  const existing = new Map(
    current.assets.map((a) => [normalizeTicker(a.ticker), a]),
  );
  const sameSet =
    current.assets.length === imported.length &&
    imported.every((a) => existing.has(a.ticker));
  return {
    ...current,
    cashTarget: sameSet ? current.cashTarget : null,
    assets: imported.map((a) => {
      const old = existing.get(a.ticker);
      return {
        ...(old ?? a),
        ticker: a.ticker,
        shares: a.shares,
        price: a.price,
        // Import time is not a quote date, and a previous price timestamp no
        // longer describes this newly imported price.
        priceUpdatedAt: undefined,
        target: sameSet ? old!.target : null,
      };
    }),
  };
}
