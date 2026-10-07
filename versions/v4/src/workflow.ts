import { money, type Portfolio, type Plan } from "./engine";
import { assetAllocation } from "./assetAllocation";
import { portfolioTotal } from "./analysis";
import type { Snapshot } from "./storage";
import { exactProduct, roundMoney } from "./decimal";

export function allocationComparison(p: Portfolio, result: Plan | null) {
  const allocation = assetAllocation(p);
  const complete =
    p.cashTarget !== null &&
    Number.isFinite(p.cashTarget) &&
    p.cashTarget >= 0 &&
    p.cashTarget <= 100 &&
    p.assets.every(
      (a) =>
        a.target !== null &&
        Number.isFinite(a.target) &&
        a.target >= 0 &&
        a.target <= 100,
    ) &&
    Math.abs(
      p.assets.reduce((sum, a) => sum + (a.target ?? 0), p.cashTarget) - 100,
    ) < 1e-7;
  return allocation.groups.map((g) => {
    const target = complete
      ? g.key === "cash"
        ? p.cashTarget!
        : p.assets
            .filter((a) => a.kind === g.key)
            .reduce((sum, a) => sum + a.target!, 0)
      : null;
    const after =
      result && !result.errors.length && result.afterTotal > 0
        ? (100 *
            (g.key === "cash"
              ? result.cash
              : result.trades
                  .filter((t) => t.asset.kind === g.key)
                  .reduce((sum, t) => sum + t.afterValue, 0))) /
          result.afterTotal
        : null;
    return {
      ...g,
      target,
      after,
      gap: target !== null && g.percent !== null ? g.percent - target : null,
    };
  });
}

export function tradeReview(p: Portfolio, r: Plan) {
  const sell = money(
    r.trades.reduce((sum, t) => sum + Math.max(-t.gross, 0), 0),
  );
  const buy = money(r.trades.reduce((sum, t) => sum + Math.max(t.gross, 0), 0));
  // Allocate each engine-rounded total fee between tax and commission so the
  // displayed breakdown reconciles exactly to the plan, including half cents.
  const tax = money(
    r.trades.reduce(
      (sum, t) =>
        sum +
        (t.quantity < 0
          ? roundMoney(
              exactProduct(
                -t.quantity,
                t.asset.price,
                t.asset.sellTaxRate,
                0.01,
              ),
            )
          : 0),
      0,
    ),
  );
  return {
    buy,
    sell,
    tax,
    commission: money(r.cost - tax),
    openingCash: money(p.cash + p.settlement),
    shortfall: money(Math.max(0, (r.afterTotal * p.cashFloor) / 100 - r.cash)),
    missingDates: p.assets
      .filter((a) => !a.priceUpdatedAt)
      .map((a) => a.ticker),
  };
}

export function actualTimeline(snapshots: Snapshot[]) {
  return snapshots
    .filter((s) => s.kind === "actual")
    .slice()
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date))
    .map((s) => ({
      id: s.id,
      name: s.name,
      date: s.date,
      total: portfolioTotal(s.portfolio),
      groups: assetAllocation(s.portfolio).groups,
    }));
}
