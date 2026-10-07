import type { Asset } from "./engine";

export type SecurityType =
  "stock" | "equityETF" | "bondETF" | "otherETF" | "unsupported";
export interface Security {
  ticker: string;
  name: string;
  shortName: string;
  type: SecurityType;
  market: "TWSE";
  currency: string;
  asOf: string;
  sourceIds: string[];
}
export interface Catalog {
  schemaVersion: 1;
  asOf: string;
  fetchedAt: string;
  sources: {
    id: string;
    url: string;
    asOf: string;
    sha256: string;
    rows: number;
  }[];
  securities: Security[];
}
export interface FeePreset {
  feeRate: number;
  minFee: number;
  sellTaxRate: number;
  feeRuleId: string;
  taxValidUntil?: string;
}
const types = ["stock", "equityETF", "bondETF", "otherETF", "unsupported"];
const normalize = (text: string) =>
  text.normalize("NFKC").trim().toLocaleUpperCase("en-US");
export const taipeiDate = (date = new Date()) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
const validDate = (text: unknown): text is string =>
  typeof text === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(text) &&
  Number.isFinite(Date.parse(text)) &&
  new Date(text).toISOString().slice(0, 10) === text;
const bounded = (text: unknown, length: number): text is string =>
  typeof text === "string" &&
  !!text.trim() &&
  text.length <= length &&
  !/[\u0000-\u001f\u007f]/.test(text);
export function parseCatalog(text: string): Catalog {
  if (text.length > 5_000_000) throw new Error("官方名錄檔案過大");
  const data = JSON.parse(text) as Catalog;
  if (
    !data ||
    data.schemaVersion !== 1 ||
    !validDate(data.asOf) ||
    typeof data.fetchedAt !== "string" ||
    !Number.isFinite(Date.parse(data.fetchedAt)) ||
    !Array.isArray(data.sources) ||
    !data.sources.length ||
    data.sources.length > 10 ||
    !Array.isArray(data.securities) ||
    !data.securities.length ||
    data.securities.length > 10000
  )
    throw new Error("官方名錄格式無效");
  const sources = new Map<string, string>();
  const fetchedDate = taipeiDate(new Date(data.fetchedAt));
  for (const source of data.sources) {
    if (
      !source ||
      !bounded(source.id, 80) ||
      sources.has(source.id) ||
      !validDate(source.asOf) ||
      source.asOf > fetchedDate ||
      !Number.isSafeInteger(source.rows) ||
      source.rows < 1 ||
      typeof source.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(source.sha256) ||
      typeof source.url !== "string" ||
      !/^https:\/\/mopsfin\.twse\.com\.tw\/opendata\/[a-zA-Z0-9_]+\.csv$/.test(
        source.url,
      )
    )
      throw new Error("官方名錄來源無效");
    sources.set(source.id, source.asOf);
  }
  if (data.asOf !== [...data.sources].map((s) => s.asOf).sort()[0])
    throw new Error("官方名錄日期不一致");
  const seen = new Set<string>();
  for (const security of data.securities) {
    if (
      !security ||
      typeof security.ticker !== "string" ||
      !/^[0-9A-Z]{4,8}$/.test(security.ticker) ||
      seen.has(security.ticker) ||
      !bounded(security.name, 300) ||
      !bounded(security.shortName, 100) ||
      !types.includes(security.type) ||
      security.market !== "TWSE" ||
      !bounded(security.currency, 20) ||
      !validDate(security.asOf) ||
      !Array.isArray(security.sourceIds) ||
      !security.sourceIds.length ||
      !security.sourceIds.every((id) => sources.has(id)) ||
      security.asOf !==
        security.sourceIds.map((id) => sources.get(id)!).sort()[0]
    )
      throw new Error("官方名錄商品內容無效");
    seen.add(security.ticker);
  }
  return data;
}
export async function loadCatalog(signal?: AbortSignal): Promise<Catalog> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (signal?.aborted) cancel();
  signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(cancel, 10_000);
  try {
    const response = await fetch(
      new URL("../../data/twse-securities.json", document.baseURI),
      { signal: controller.signal, credentials: "omit", redirect: "error" },
    );
    if (!response.ok) throw new Error("官方名錄暫時無法載入，可繼續手動輸入");
    if (Number(response.headers.get("content-length")) > 5_000_000)
      throw new Error("官方名錄檔案過大");
    return parseCatalog(await response.text());
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}
interface SearchIndex {
  byTicker: Map<string, Security>;
  byName: Map<string, Security[]>;
  rows: { security: Security; ticker: string; names: string[] }[];
}
const indexes = new WeakMap<Catalog, SearchIndex>();
function index(catalog: Catalog): SearchIndex {
  let result = indexes.get(catalog);
  if (!result) {
    result = { byTicker: new Map(), byName: new Map(), rows: [] };
    for (const security of catalog.securities) {
      const ticker = normalize(security.ticker),
        names = [
          ...new Set([normalize(security.name), normalize(security.shortName)]),
        ];
      result.byTicker.set(ticker, security);
      for (const name of names)
        result.byName.set(name, [...(result.byName.get(name) ?? []), security]);
      result.rows.push({ security, ticker, names });
    }
    indexes.set(catalog, result);
  }
  return result;
}
export function findByTicker(
  catalog: Catalog,
  query: string,
): Security | undefined {
  return index(catalog).byTicker.get(normalize(query));
}
export function exactNameMatches(catalog: Catalog, query: string): Security[] {
  return index(catalog).byName.get(normalize(query)) ?? [];
}
export function searchSecurities(
  catalog: Catalog,
  query: string,
  limit = 10,
): Security[] {
  const q = normalize(query);
  if (!q || q.length > 300) return [];
  const result = index(catalog).rows.flatMap((row) => {
    const rank =
      row.ticker === q
        ? 0
        : row.names.includes(q)
          ? 1
          : row.ticker.startsWith(q)
            ? 2
            : row.names.some((n) => n.startsWith(q))
              ? 3
              : row.names.some((n) => n.includes(q))
                ? 4
                : -1;
    return rank < 0 ? [] : [{ security: row.security, rank }];
  });
  return result
    .sort(
      (a, b) =>
        a.rank - b.rank || a.security.ticker.localeCompare(b.security.ticker),
    )
    .slice(0, Math.max(0, Math.min(30, limit)))
    .map((r) => r.security);
}
export function isCatalogStale(catalog: Catalog, today = new Date()): boolean {
  const age =
    (Date.parse(taipeiDate(today)) - Date.parse(catalog.asOf)) / 86400000;
  return (
    !Number.isFinite(age) ||
    age < 0 ||
    age > 45 ||
    catalog.sources.some((source) => source.asOf > taipeiDate(today))
  );
}
export function feePreset(
  security: Security,
  _today = new Date(),
): FeePreset | null {
  // Only verified TWD securities receive defaults. Bond funds remain manual;
  // the exemption does not cover leveraged/inverse ETFs, included in otherETF.
  if (security.currency !== "TWD" || security.market !== "TWSE") return null;
  if (!["stock", "equityETF", "otherETF"].includes(security.type)) return null;
  return {
    feeRate: 0.1425,
    minFee: 0,
    sellTaxRate: security.type === "stock" ? 0.3 : 0.1,
    feeRuleId: `tw-${security.type}-2026-10-07`,
  };
}
export function selectSecurity(
  asset: Asset,
  security: Security,
  forceFees = false,
  today = new Date(),
): Partial<Asset> {
  const preset = feePreset(security, today);
  const auto =
    !!preset &&
    (forceFees ||
      asset.feeMode === "auto" ||
      (asset.feeMode === undefined && !asset.ticker));
  return {
    ticker: security.ticker,
    name: security.name,
    shortName: security.shortName,
    securityType: security.type,
    securityAsOf: security.asOf,
    // An existing automatic setting must not silently become an unchecked
    // manual tax rate when the next product has no verified preset.
    feeMode: auto || asset.feeMode === "auto" ? "auto" : "manual",
    feeRuleId: undefined,
    taxValidUntil: undefined,
    ...(auto ? preset : {}),
  };
}
export function autoFeeProblem(
  asset: Asset,
  catalog: Catalog | null,
  today = new Date(),
): string | null {
  if (asset.feeMode !== "auto") return null;
  const prefix = `${asset.ticker}：`;
  if (asset.taxValidUntil && taipeiDate(today) > asset.taxValidUntil)
    return prefix + "原自動稅率已到期，請重新核對或改為手動設定";
  if (!catalog)
    return prefix + "需載入官方名錄以核對自動費率；也可核對後改用手動設定";
  if (isCatalogStale(catalog, today))
    return prefix + "官方名錄已過期或日期不符，請核對後改用手動費率";
  const security = findByTicker(catalog, asset.ticker);
  const preset = security && feePreset(security, today);
  if (
    !security ||
    !preset ||
    security.name !== asset.name ||
    security.type !== asset.securityType
  )
    return prefix + "商品與原自動設定不一致，請重新選取並核對";
  if (
    asset.feeRuleId !== preset.feeRuleId ||
    asset.feeRate !== preset.feeRate ||
    asset.minFee !== preset.minFee ||
    asset.sellTaxRate !== preset.sellTaxRate
  )
    return prefix + "費率與官方商品預設不一致，請重新套用或改為手動設定";
  return null;
}
export const securityTypeLabel = (type: SecurityType) =>
  ({
    stock: "一般股票",
    equityETF: "股票型 ETF",
    bondETF: "債券 ETF（費率另核對）",
    otherETF: "其他已核對 ETF",
    unsupported: "特殊商品（費率另核對）",
  })[type];
