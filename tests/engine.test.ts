import { describe, expect, it } from "vitest";
import {
  blankAsset,
  standardFees,
  fee,
  initialPortfolio,
  plan,
  meetsPrinciples,
  validate,
  type Portfolio,
} from "../src/engine";
import { assetsCSV, parseCSV, parseBackup } from "../src/storage";
function fixture(): Portfolio {
  return {
    ...initialPortfolio(),
    cash: 20000,
    cashTarget: 20,
    assets: [
      {
        ...blankAsset(),
        ticker: "00662",
        kind: "core",
        shares: 600,
        price: 100,
        target: 40,
      },
      {
        ...blankAsset(),
        ticker: "00675L",
        kind: "leverage",
        shares: 200,
        price: 100,
        target: 40,
      },
    ],
  };
}
describe("accounting and constraints", () => {
  it("treats signed T+2 amounts as net receivables/payables", () => {
    const p = fixture();
    p.cashTarget = null;
    p.assets.forEach((a) => (a.target = null));
    p.settlement = -12000;
    expect(plan(p, "full").cash).toBe(8000);
    expect(plan(p, "full").total).toBe(88000);
    p.settlement = 12000;
    expect(plan(p, "full").cash).toBe(32000);
    expect(plan(p, "full").total).toBe(112000);
  });
  it("conserves assets after fees and maintains the cash floor", () => {
    const r = plan(fixture(), "full");
    expect(r.errors).toEqual([]);
    expect(r.trades[0].quantity).toBe(-200);
    expect(r.trades[1].quantity).toBeGreaterThan(0);
    expect(r.cash + r.trades.reduce((s, t) => s + t.afterValue, 0)).toBeCloseTo(
      r.total - r.cost,
      2,
    );
    expect(r.cash / r.afterTotal).toBeGreaterThanOrEqual(0.2);
  });
  it("keeps frozen and buy-only assets from being sold", () => {
    const p = fixture();
    p.assets[0].limit = "buyOnly";
    expect(plan(p, "full").trades[0].quantity).toBe(0);
    p.assets[1].limit = "frozen";
    expect(plan(p, "full").trades.every((t) => t.quantity === 0)).toBe(true);
  });
  it("only spends new contributions, including fees", () => {
    const p = fixture();
    p.flow = 10000;
    const r = plan(p, "contribute");
    expect(r.trades.every((t) => t.quantity >= 0)).toBe(true);
    expect(
      r.trades.reduce((s, t) => s + t.gross + t.cost, 0),
    ).toBeLessThanOrEqual(p.flow);
    p.flow = 0;
    expect(plan(p, "contribute").trades.every((t) => t.quantity === 0)).toBe(
      true,
    );
  });
  it("does not fabricate targets and does not trade inside the tolerance band", () => {
    const p = fixture();
    p.cashTarget = null;
    p.assets.forEach((a) => (a.target = null));
    expect(plan(p, "full").trades.every((t) => t.quantity === 0)).toBe(true);
    const q = fixture();
    q.assets[0].target = 59;
    q.assets[1].target = 21;
    expect(plan(q, "band").trades.every((t) => t.quantity === 0)).toBe(true);
  });
  it("reports cash deficits with negative settlement and restrictive locks", () => {
    const p = fixture();
    p.settlement = -19000;
    p.assets.forEach((a) => (a.limit = "frozen"));
    const r = plan(p, "full");
    expect(r.notes.some((n) => n.includes("現金低於下限"))).toBe(true);
    expect(r.trades.every((t) => t.quantity === 0)).toBe(true);
  });
  it("respects lots, small budgets and minimum commissions", () => {
    const p = fixture();
    p.assets.forEach((a) => (a.lot = 1000));
    expect(plan(p, "full").trades.every((t) => t.quantity === 0)).toBe(true);
    p.assets.forEach((a) => (a.lot = 1));
    p.assets[1].minFee = 50000;
    expect(plan(p, "full").trades[1].quantity).toBe(0);
  });
  it("rejects invalid, incomplete and non-100% targets", () => {
    const p = fixture();
    p.assets[0].target = 39;
    expect(validate(p).join()).toContain("100%");
    p.assets[0].target = null;
    expect(validate(p).join()).toContain("完整");
    p.assets[0].shares = -1;
    expect(validate(p).length).toBeGreaterThan(0);
    p.cashFloor = 9;
    expect(validate(p).join()).toContain("10%");
    p.flow = Infinity;
    expect(plan(p, "full").trades).toEqual([]);
  });
  it("preserves cash conservation over a deterministic range of portfolios", () => {
    for (let i = 1; i <= 200; i++) {
      const p = fixture();
      p.cash = i * 111;
      p.settlement = (i % 2 ? -1 : 1) * i * 12;
      p.flow = i * 31;
      p.assets[0].shares = i * 9;
      p.assets[1].shares = i * 5;
      p.assets[0].price = 17.31;
      p.assets[1].price = 89.15;
      for (const mode of ["full", "band", "contribute"] as const) {
        const r = plan(p, mode);
        expect(r.errors).toEqual([]);
        expect(
          r.cash + r.trades.reduce((s, t) => s + t.afterValue, 0),
        ).toBeCloseTo(r.afterTotal, 1);
        expect(r.trades.every((t) => t.asset.shares + t.quantity >= 0)).toBe(
          true,
        );
        if (r.trades.some((t) => t.quantity > 0))
          expect(r.cash + 0.01).toBeGreaterThanOrEqual(r.afterTotal * 0.1);
      }
    }
  });
});
describe("portable data", () => {
  it("round trips CSV including leading zeros and quoted commas", () => {
    const p = fixture();
    p.assets[1].ticker = 'ETF,"測試"';
    const parsed = parseCSV(assetsCSV(p.assets));
    expect(parsed[0].ticker).toBe("00662");
    expect(parsed[1].ticker).toBe('ETF,"測試"');
    expect(parsed.map(({ id, ...a }) => a)).toEqual(
      p.assets.map(({ id, ...a }) => a),
    );
  });
  it("validates backup and rejects unsafe source links and malformed assets", () => {
    const b = { version: 1, portfolio: fixture(), snapshots: [], evidence: [] };
    expect(parseBackup(JSON.stringify(b)).portfolio.cash).toBe(20000);
    expect(() => parseBackup("{bad")).toThrow();
    expect(() =>
      parseBackup(
        JSON.stringify({
          ...b,
          evidence: [
            {
              id: "1",
              title: "a",
              value: "1",
              date: "2026-01-01",
              status: "已核對",
              source: "javascript:alert(1)",
            },
          ],
        }),
      ),
    ).toThrow();
    expect(() =>
      parseBackup(
        JSON.stringify({ ...b, portfolio: { ...b.portfolio, assets: [null] } }),
      ),
    ).toThrow();
  });
});

describe("execution eligibility", () => {
  it("blocks application when cash or mandatory holdings are missing", () => {
    const p = fixture();
    expect(meetsPrinciples(p, plan(p, "full"))).toBe(true);
    p.settlement = -19000;
    p.assets.forEach((a) => (a.limit = "frozen"));
    expect(meetsPrinciples(p, plan(p, "full"))).toBe(false);
    const q = fixture();
    q.assets[0].target = 0;
    q.assets[1].target = 80;
    expect(meetsPrinciples(q, plan(q, "full"))).toBe(false);
  });
  it("rejects malformed holdings and tiny prices without entering allocation", () => {
    const p = fixture();
    p.assets[0].price = 1e-300;
    expect(plan(p, "full").errors.length).toBeGreaterThan(0);
    expect(
      validate({ ...fixture(), assets: [null] } as unknown as Portfolio),
    ).toContain("標的格式錯誤");
  });
});

describe("Taiwan fee presets", () => {
  it("uses undiscounted commission, zero minimum and product-specific sell tax", () => {
    const stock = { ...blankAsset(), price: 100 };
    expect(stock.minFee).toBe(0);
    expect(stock.sellTaxRate).toBe(0.3);
    expect(fee(stock, 1000)).toBe(142.5);
    expect(fee(stock, -1000)).toBe(442.5);
    const etf = { ...stock, ...standardFees("equityETF") };
    expect(fee(etf, 1000)).toBe(142.5);
    expect(fee(etf, -1000)).toBe(242.5);
    expect(fee(etf, 1)).toBe(0.14);
  });
});
