import { normalizeTicker, type Portfolio, type Plan } from "./engine";
export const portfolioTotal = (p: Portfolio) =>
  p.cash +
  p.settlement +
  p.assets.reduce((sum, a) => sum + a.shares * a.price, 0);
export function projectedPortfolio(p: Portfolio, r: Plan): Portfolio {
  return {
    ...structuredClone(p),
    assets: r.trades.map((t) => ({
      ...t.asset,
      shares: t.asset.shares + t.quantity,
    })),
    cash: p.cash + p.flow,
    settlement: r.cash - p.cash - p.flow,
    flow: 0,
  };
}
export function maxDeviation(p: Portfolio, r: Plan): number | null {
  if (p.cashTarget === null || r.afterTotal <= 0) return null;
  return Math.max(
    Math.abs((r.cash / r.afterTotal) * 100 - p.cashTarget),
    ...r.trades.map((t) =>
      Math.abs((t.afterValue / r.afterTotal) * 100 - (t.asset.target ?? 0)),
    ),
  );
}
export function scenarioComparison(
  p: Portfolio,
  r: Plan,
  shocks: Record<string, number>,
) {
  if (
    r.errors.length ||
    p.assets.some(
      (a) =>
        !Number.isFinite(shockFor(shocks, a.id)) ||
        shockFor(shocks, a.id) < -100,
    )
  )
    return null;
  // Both paths use the same contribution/withdrawal; only the adjusted path pays costs.
  const beforeBase = portfolioTotal(p) + p.flow;
  const beforeChange = p.assets.reduce(
    (sum, a) => sum + (a.shares * a.price * shockFor(shocks, a.id)) / 100,
    0,
  );
  const afterChange = r.trades.reduce(
    (sum, t) => sum + (t.afterValue * shockFor(shocks, t.asset.id)) / 100,
    0,
  );
  const result = {
    beforeBase,
    beforeChange,
    beforeTotal: beforeBase + beforeChange,
    afterBase: r.afterTotal,
    afterChange,
    afterTotal: r.afterTotal + afterChange,
  };
  return Object.values(result).every(Number.isFinite) ? result : null;
}
export const shockFor = (shocks: Record<string, number>, id: string): number =>
  Object.hasOwn(shocks, id) ? shocks[id] : 0;
export function compareHoldings(a: Portfolio, b: Portfolio) {
  // CSV imports regenerate IDs. Compare by ticker, not transient UI ID.
  const tickers = [
    ...new Set(
      [...a.assets, ...b.assets].map((x) => normalizeTicker(x.ticker)),
    ),
  ];
  return tickers.map((ticker) => {
    const old = a.assets.find((x) => normalizeTicker(x.ticker) === ticker),
      next = b.assets.find((x) => normalizeTicker(x.ticker) === ticker);
    return {
      ticker,
      oldShares: old?.shares ?? 0,
      newShares: next?.shares ?? 0,
      oldPrice: old?.price ?? null,
      newPrice: next?.price ?? null,
      valueChange:
        (next ? next.shares * next.price : 0) -
        (old ? old.shares * old.price : 0),
    };
  });
}
export function tradeExplanation(
  p: Portfolio,
  r: Plan,
  ticker: string,
): string {
  const t = r.trades.find((t) => t.asset.ticker === ticker)!;
  const a = t.asset;
  if (a.target === null) return "未設定目標，維持現況";
  if (a.limit === "frozen") return "設定完全不動，未買賣";
  const gap = (r.total * a.target) / 100 - a.shares * a.price;
  if (gap < 0 && a.limit === "buyOnly") return "高於目標，但設定不可賣出";
  if (gap < 0 && r.mode === "contribute")
    return "僅用新增資金模式，不賣出既有部位";
  if (r.mode === "band" && (Math.abs(gap) / r.total) * 100 <= p.tolerance)
    return "位於容許區間內，維持現況";
  const adjustment = Math.max(
    0,
    Math.abs(gap) - (r.mode === "band" ? (r.total * p.tolerance) / 100 : 0),
  );
  if (adjustment < a.price * a.lot && t.quantity === 0)
    return `所需調整不足一個交易單位（${a.lot} 股）`;
  if (gap > 0 && t.quantity === 0)
    return `保留現金目標與費用後，本模式可用買進預算不足一個交易單位（${a.lot} 股）`;
  if (gap < 0 && t.quantity === 0) return "估計賣出金額不足以支付費用";
  return `${t.quantity > 0 ? "按目標缺口、可用預算與費用買進" : "按超額部位賣出"}，以 ${a.lot} 股為單位${r.mode === "band" ? "向區間邊界調整" : "取整"}`;
}
