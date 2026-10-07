import type { Portfolio } from "./engine";

export const allocationGroups = [
  { key: "core", label: "核心持股", color: "#16796f" },
  { key: "leverage", label: "台股正二", color: "#b3651b" },
  { key: "other", label: "其他證券", color: "#6366a0" },
  { key: "cash", label: "現金（含 T+2）", color: "#387dab" },
] as const;

// Allocation depends on valuation inputs, not target weights or trading fees.
export function assetAllocation(p: Portfolio) {
  const valid =
    Number.isFinite(p.cash) &&
    p.cash >= 0 &&
    p.cash <= 1e12 &&
    Number.isFinite(p.settlement) &&
    Math.abs(p.settlement) <= 1e12 &&
    p.assets.every(
      (a) =>
        ["core", "leverage", "other"].includes(a.kind) &&
        Number.isSafeInteger(a.shares) &&
        a.shares >= 0 &&
        Number.isFinite(a.price) &&
        a.price >= 0.01 &&
        a.price <= 1e9 &&
        a.shares * a.price <= 1e12,
    );
  const groups = allocationGroups.map((group) => ({
    ...group,
    value: valid
      ? group.key === "cash"
        ? p.cash + p.settlement
        : p.assets
            .filter((a) => a.kind === group.key)
            .reduce((sum, a) => sum + a.shares * a.price, 0)
      : null,
  }));
  const total = valid ? groups.reduce((sum, g) => sum + g.value!, 0) : null;
  return {
    total,
    chartable:
      total !== null && total > 0 && groups.every((g) => g.value! >= 0),
    groups: groups.map((g) => ({
      ...g,
      percent: total !== null && total > 0 ? (g.value! / total) * 100 : null,
    })),
  };
}
