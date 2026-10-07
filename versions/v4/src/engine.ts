import {
  decimal,
  add,
  multiply,
  maximum,
  roundMoney,
  exactProduct,
} from "./decimal";
export type Mode = "full" | "contribute" | "band";
export type Limit = "free" | "buyOnly" | "frozen";
export type SecurityType =
  "stock" | "equityETF" | "bondETF" | "otherETF" | "unsupported";
export interface Asset {
  name?: string;
  shortName?: string;
  securityType?: SecurityType;
  feeMode?: "auto" | "manual";
  securityAsOf?: string;
  feeRuleId?: string;
  taxValidUntil?: string;
  priceUpdatedAt?: string;
  id: string;
  ticker: string;
  kind: "core" | "leverage" | "other";
  shares: number;
  price: number;
  target: number | null;
  limit: Limit;
  lot: number;
  feeRate: number;
  minFee: number;
  sellTaxRate: number;
}
export interface Portfolio {
  version: 1;
  assets: Asset[];
  cash: number;
  settlement: number;
  flow: number;
  cashFloor: number;
  cashTarget: number | null;
  tolerance: number;
}
export interface Trade {
  asset: Asset;
  quantity: number;
  gross: number;
  cost: number;
  afterValue: number;
}
export interface Plan {
  mode: Mode;
  total: number;
  afterTotal: number;
  cash: number;
  cost: number;
  trades: Trade[];
  errors: string[];
  notes: string[];
}
export const money = (n: number) => roundMoney(decimal(n));
const finite = (n: unknown): n is number =>
  typeof n === "number" && Number.isFinite(n);
export function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}
export function validate(p: Portfolio): string[] {
  const errors: string[] = [];
  if (!p || p.version !== 1 || !Array.isArray(p.assets))
    return ["不支援的資料格式"];
  for (const key of [
    "cash",
    "settlement",
    "flow",
    "cashFloor",
    "tolerance",
  ] as const)
    if (!finite(p[key])) errors.push(`${key} 必須是有效數字`);
  if (p.cash < 0) errors.push("現金不可為負數；應付款請填入交割款");
  for (const key of ["cash", "settlement", "flow"] as const)
    if (Math.abs(p[key]) > 1e12) errors.push(`${key} 金額絕對值不得超過一兆元`);
  if (p.cashFloor < 10 || p.cashFloor > 100)
    errors.push("現金下限須介於 10% 與 100%");
  if (p.tolerance < 0 || p.tolerance > 100)
    errors.push("容許偏差須介於 0 與 100 個百分點");
  if (p.assets.length > 100) errors.push("最多支援 100 個標的");
  const ids = new Set<string>(),
    tickers = new Set<string>();
  for (const a of p.assets) {
    if (!a || typeof a !== "object") {
      errors.push("標的格式錯誤");
      continue;
    }
    if (typeof a.id !== "string" || !a.id || ids.has(a.id))
      errors.push("標的識別碼不可重複或空白");
    ids.add(a.id);
    if (
      typeof a.ticker !== "string" ||
      !a.ticker.trim() ||
      tickers.has(a.ticker.trim())
    )
      errors.push("標的代號不可重複或空白");
    if (typeof a.ticker === "string") tickers.add(a.ticker.trim());
    for (const [key, maxLength] of [
      ["name", 300],
      ["shortName", 100],
      ["feeRuleId", 100],
    ] as const)
      if (
        a[key] !== undefined &&
        (typeof a[key] !== "string" || a[key].length > maxLength)
      )
        errors.push(`${a.ticker}：${key} 須為不超過 ${maxLength} 字元的文字`);
    if (
      a.securityType !== undefined &&
      !["stock", "equityETF", "bondETF", "otherETF", "unsupported"].includes(
        a.securityType,
      )
    )
      errors.push(`${a.ticker}：證券商品類型無效`);
    if (a.feeMode !== undefined && !["auto", "manual"].includes(a.feeMode))
      errors.push(`${a.ticker}：費率設定方式無效`);
    for (const key of ["securityAsOf", "taxValidUntil"] as const)
      if (a[key] !== undefined && !validDate(a[key]))
        errors.push(`${a.ticker}：${key} 須為有效 YYYY-MM-DD 日期`);
    if (
      !["core", "leverage", "other"].includes(a.kind) ||
      !["free", "buyOnly", "frozen"].includes(a.limit)
    )
      errors.push("標的分類或交易限制無效");
    for (const key of [
      "shares",
      "price",
      "lot",
      "feeRate",
      "minFee",
      "sellTaxRate",
    ] as const)
      if (!finite(a[key]) || a[key] < 0)
        errors.push(`${a.ticker}：${key} 不可為負數或無效數字`);
    if (
      !Number.isSafeInteger(a.shares) ||
      !Number.isSafeInteger(a.lot) ||
      a.lot < 1 ||
      a.price < 0.01 ||
      a.price > 1e9 ||
      a.shares * a.price > 1e12
    )
      errors.push(
        `${a.ticker}：股數須為整數、交易單位須大於零，價格須介於 0.01 與十億元，部位市值不超過一兆元`,
      );
    if (
      a.priceUpdatedAt !== undefined &&
      (typeof a.priceUpdatedAt !== "string" ||
        !Number.isFinite(Date.parse(a.priceUpdatedAt)))
    )
      errors.push(`${a.ticker}：價格更新時間無效`);
    if (a.feeRate > 10 || a.sellTaxRate > 10)
      errors.push(`${a.ticker}：費率不得超過 10%`);
    if (a.minFee > 1e12) errors.push(`${a.ticker}：最低手續費不得超過一兆元`);
    if (
      a.target !== null &&
      (!finite(a.target) || a.target < 0 || a.target > 100)
    )
      errors.push(`${a.ticker}：目標比例無效`);
  }
  if (
    p.cashTarget !== null &&
    (!finite(p.cashTarget) || p.cashTarget < p.cashFloor || p.cashTarget > 100)
  )
    errors.push("現金目標不得低於下限或高於 100%");
  if (errors.length) return [...new Set(errors)];
  const targets = p.assets.filter((a) => a.target !== null).length;
  if (targets > 0 || p.cashTarget !== null) {
    if (targets !== p.assets.length || p.cashTarget === null)
      errors.push("請完整填寫所有目標比例，或全部留白以檢查現況");
    else if (
      Math.abs(
        p.assets.reduce((s, a) => s + (a.target ?? 0), 0) + p.cashTarget - 100,
      ) > 1e-7
    )
      errors.push("目標比例總和必須為 100%");
  }
  if (!errors.length) {
    const total =
      p.assets.reduce((s, a) => s + a.shares * a.price, 0) +
      p.cash +
      p.settlement +
      p.flow;
    if (!finite(total) || total <= 0 || total > 1e12)
      errors.push("投入／提領後總資產須大於零且不超過一兆元");
  }
  return [...new Set(errors)];
}
export const fee = (a: Asset, qty: number) => {
  if (qty === 0) return 0;
  const gross = exactProduct(Math.abs(qty), a.price);
  const commission = maximum(
    decimal(a.minFee),
    multiply(gross, exactProduct(a.feeRate, 0.01)),
  );
  const tax =
    qty < 0 ? multiply(gross, exactProduct(a.sellTaxRate, 0.01)) : decimal(0);
  return roundMoney(add(commission, tax));
};
export function meetsPrinciples(p: Portfolio, r: Plan): boolean {
  return (
    r.errors.length === 0 &&
    r.afterTotal > 0 &&
    r.cash + 0.01 >= (r.afterTotal * p.cashFloor) / 100 &&
    r.trades.some((t) => t.asset.ticker === "00662" && t.afterValue > 0) &&
    r.trades.some((t) => t.asset.kind === "leverage" && t.afterValue > 0)
  );
}
export function plan(p: Portfolio, mode: Mode): Plan {
  const errors = validate(p);
  const result: Plan = {
    mode,
    total: 0,
    afterTotal: 0,
    cash: 0,
    cost: 0,
    trades: [],
    errors,
    notes: [],
  };
  if (errors.length) return result;
  const values = p.assets.map((a) => money(a.shares * a.price));
  const total = money(
    values.reduce((s, v) => s + v, 0) + p.cash + p.settlement + p.flow,
  );
  let cash = money(p.cash + p.settlement + p.flow),
    cost = 0;
  const quantities = p.assets.map(() => 0);
  const hasTarget = p.cashTarget !== null;
  const desired = p.assets.map((a, i) =>
    hasTarget ? (total * (a.target ?? 0)) / 100 : values[i],
  );
  if (hasTarget && mode !== "contribute") {
    p.assets.forEach((a, i) => {
      const excess = values[i] - desired[i];
      if (
        a.limit !== "free" ||
        excess <= 0 ||
        (mode === "band" && (excess / total) * 100 <= p.tolerance)
      )
        return;
      const saleValue =
        mode === "band" ? excess - (total * p.tolerance) / 100 : excess;
      const qty = -Math.min(
        a.shares,
        Math.floor(saleValue / a.price / a.lot) * a.lot,
      );
      const charge = fee(a, qty);
      if (-qty * a.price <= charge) return;
      quantities[i] = qty;
      cash = money(cash - qty * a.price - charge);
      cost = money(cost + charge);
    });
  }
  // Reserve uses pre-fee total: conservative buffer after transaction costs.
  const reserve =
    (total * (hasTarget ? Math.max(p.cashFloor, p.cashTarget!) : p.cashFloor)) /
    100;
  let budget = Math.max(0, cash - reserve);
  if (mode === "contribute") budget = Math.min(budget, Math.max(0, p.flow));
  if (hasTarget) {
    const order = p.assets
      .map((_, i) => i)
      .sort((i, j) => desired[j] - values[j] - (desired[i] - values[i]));
    for (const i of order) {
      const a = p.assets[i],
        deficit = desired[i] - values[i];
      if (
        a.limit === "frozen" ||
        quantities[i] < 0 ||
        deficit <= 0 ||
        (mode === "band" && (deficit / total) * 100 <= p.tolerance)
      )
        continue;
      const buyValue =
        mode === "band" ? deficit - (total * p.tolerance) / 100 : deficit;
      let lo = 0,
        hi = Math.floor(buyValue / a.price / a.lot);
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2),
          qty = mid * a.lot;
        if (money(qty * a.price + fee(a, qty)) <= budget + 1e-8) lo = mid;
        else hi = mid - 1;
      }
      const qty = lo * a.lot,
        charge = fee(a, qty),
        spend = money(qty * a.price + charge);
      quantities[i] = qty;
      cash = money(cash - spend);
      cost = money(cost + charge);
      budget = money(budget - spend);
    }
  }
  result.total = total;
  result.afterTotal = money(total - cost);
  result.cash = cash;
  result.cost = cost;
  result.trades = p.assets.map((a, i) => ({
    asset: a,
    quantity: quantities[i],
    gross: money(quantities[i] * a.price),
    cost: fee(a, quantities[i]),
    afterValue: money((a.shares + quantities[i]) * a.price),
  }));
  if (cash + 0.01 < (result.afterTotal * p.cashFloor) / 100)
    result.notes.push(
      `現金低於下限，仍差 ${money((result.afterTotal * p.cashFloor) / 100 - cash).toLocaleString()} 元。請增加投入或放寬賣出／目標限制。`,
    );
  if (
    !result.trades.some((t) => t.asset.ticker === "00662" && t.afterValue > 0)
  )
    result.notes.push("尚未符合持有 00662 的配置原則。");
  if (
    !result.trades.some((t) => t.asset.kind === "leverage" && t.afterValue > 0)
  )
    result.notes.push("尚未符合持有台股正二的配置原則；分類由你確認。");
  if (!hasTarget)
    result.notes.push("未設定本次目標：僅檢查現況，不自動分配其餘資金。");
  else {
    const deviations = result.trades.filter(
      (t) =>
        Math.abs(
          (t.afterValue / result.afterTotal) * 100 - (t.asset.target ?? 0),
        ) > Math.max(p.tolerance, 0.01),
    );
    if (deviations.length)
      result.notes.push(
        `仍超出容許偏差：${deviations.map((t) => t.asset.ticker).join("、")}。限制、資金、交易單位與費用可能使目標無法達成。`,
      );
  }
  return result;
}
export const standardFees = (product: "stock" | "equityETF") => ({
  feeRate: 0.1425,
  minFee: 0,
  sellTaxRate: product === "stock" ? 0.3 : 0.1,
});
export const blankAsset = (): Asset => ({
  id: crypto.randomUUID(),
  ticker: "",
  kind: "other",
  shares: 0,
  price: 1,
  target: null,
  limit: "free",
  lot: 1,
  ...standardFees("stock"),
});
export const initialPortfolio = (): Portfolio => ({
  version: 1,
  assets: [],
  cash: 0,
  settlement: 0,
  flow: 0,
  cashFloor: 10,
  cashTarget: null,
  tolerance: 2,
});
