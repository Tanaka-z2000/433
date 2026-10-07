import { describe, it, expect } from "vitest";
import {
  blankAsset,
  initialPortfolio,
  fee,
  plan,
  validate,
  type Portfolio,
  type Mode,
} from "../src/engine";
import { parseBackup, assetsCSV, parseCSV } from "../src/storage";
let state = 0x4332026;
const rand = () => {
  state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  return state / 2 ** 32;
};
const int = (max: number) => Math.floor(rand() * max);
function fixture(count = 10): Portfolio {
  return {
    ...initialPortfolio(),
    cash: 1_000_000 + int(1_000_000),
    settlement: int(200000) - 100000,
    flow: int(100000) - 50000,
    cashTarget: 20,
    assets: Array.from({ length: count }, (_, i) => ({
      ...blankAsset(),
      ticker: i === 0 ? "00662" : i === 1 ? "00675L" : String(i),
      kind:
        i === 0
          ? ("core" as const)
          : i === 1
            ? ("leverage" as const)
            : ("other" as const),
      shares: int(10000),
      price: (int(50000) + 1) / 100,
      target: 80 / count,
      limit: (["free", "buyOnly", "frozen"] as const)[int(3)],
      lot: [1, 100, 1000][int(3)],
      feeRate: [0, 0.1425, 0.0855][int(3)],
      minFee: [0, 1, 20][int(3)],
      sellTaxRate: [0.1, 0.3][int(2)],
    })),
  };
}
describe("V3 stress and boundary regressions", () => {
  it("rejects offsetting huge amounts before floating point loses holdings", () => {
    const p = fixture(2);
    p.cash = 1e307;
    p.settlement = -1e307;
    p.flow = 10000;
    expect(validate(p).join(" ")).toContain("金額絕對值");
    expect(plan(p, "full").trades).toEqual([]);
    p.cash = 100000;
    p.settlement = 0;
    p.assets[0].minFee = 1e307;
    expect(validate(p).join(" ")).toContain("最低手續費");
  });
  it("rejects oversized and malformed CSV early while accepting quoted content", () => {
    const p = fixture(100);
    const csv = assetsCSV(p.assets);
    expect(() => parseCSV(csv + "\n" + csv.split("\r\n")[1])).toThrow(
      "100 個標的",
    );
    expect(() => parseCSV(",".repeat(1_000_000))).toThrow("欄位數過多");
    expect(() => parseCSV("a".repeat(1_000_000))).toThrow("1024");
    expect(() => parseCSV('ticker,kind\nabc"def",other')).toThrow("引號位置");
    expect(() => parseCSV('ticker,kind\n"abc"def,other')).toThrow("多餘內容");
    p.assets[0].ticker = '測試,"引號"\n換行';
    expect(parseCSV(assetsCSV(p.assets))[0].ticker).toBe(p.assets[0].ticker);
  });
  it("rounds half cents exactly for purchases, sales, minimum fees and scientific notation", () => {
    const a = {
      ...blankAsset(),
      price: 100,
      feeRate: 0.1425,
      sellTaxRate: 0.1,
    };
    expect(fee(a, -250)).toBe(60.63);
    expect(fee(a, 250)).toBe(35.63);
    expect(fee({ ...a, feeRate: 0, minFee: 0.005 }, 1)).toBe(0.01);
    expect(fee({ ...a, price: 1e9, feeRate: 1e-7, sellTaxRate: 0 }, 1)).toBe(1);
  });
  it("matches an independent integer-cent oracle for 10000 buy/sell fees", () => {
    for (let i = 0; i < 5000; i++) {
      const priceCents = 1 + int(100000),
        shares = 1 + int(1000);
      const a = { ...blankAsset(), price: priceCents / 100, sellTaxRate: 0.1 };
      for (const side of [-1, 1]) {
        const rate = side < 0 ? 2425 : 1425;
        const cents = Math.floor(
          (priceCents * shares * rate + 500000) / 1000000,
        );
        expect(fee(a, side * shares)).toBe(cents / 100);
      }
    }
  });
  it("checks 6000 plans for money conservation, trade limits, lots and finite results", () => {
    let cases = 0;
    for (let seed = 0; seed < 2000; seed++) {
      const p = fixture([2, 4, 10, 20, 100][seed % 5]);
      expect(validate(p)).toEqual([]);
      for (const mode of ["full", "contribute", "band"] as Mode[]) {
        const r = plan(p, mode);
        cases++;
        expect(r.errors).toEqual([]);
        const gross = r.trades.reduce((s, t) => s + t.gross, 0),
          cost = r.trades.reduce((s, t) => s + t.cost, 0);
        expect(r.cost).toBeCloseTo(cost, 2);
        expect(r.cash).toBeCloseTo(
          p.cash + p.settlement + p.flow - gross - cost,
          2,
        );
        expect(r.afterTotal).toBeCloseTo(
          r.trades.reduce((s, t) => s + t.afterValue, 0) + r.cash,
          2,
        );
        expect(r.afterTotal).toBeCloseTo(r.total - r.cost, 2);
        expect([r.cash, r.afterTotal, r.cost].every(Number.isFinite)).toBe(
          true,
        );
        for (const t of r.trades) {
          expect(t.asset.shares + t.quantity).toBeGreaterThanOrEqual(0);
          expect(Math.abs(t.quantity) % t.asset.lot).toBe(0);
          if (t.asset.limit === "frozen") expect(t.quantity).toBe(0);
          if (t.asset.limit === "buyOnly" || mode === "contribute")
            expect(t.quantity).toBeGreaterThanOrEqual(0);
        }
        if (mode === "contribute")
          expect(
            r.trades.reduce((s, t) => s + Math.max(0, t.gross) + t.cost, 0),
          ).toBeLessThanOrEqual(Math.max(0, p.flow) + 0.001);
      }
    }
    console.log(`Stress: ${cases} deterministic plans verified`);
  }, 30000);
  it("round-trips 100 holdings and 50 snapshots including pre-trade sources", () => {
    const p = fixture(100);
    const snapshots = Array.from({ length: 50 }, (_, i) => ({
      id: String(i),
      name: `壓力快照 ${i}`,
      kind: "plan",
      mode: "full",
      date: new Date().toISOString(),
      portfolio: p,
      sourcePortfolio: p,
    }));
    const data = {
      version: 3,
      portfolio: p,
      snapshots,
      evidence: [],
      state: "estimate",
      beforeEstimate: p,
    };
    expect(parseBackup(JSON.stringify(data))).toEqual(data);
    expect(parseCSV(assetsCSV(p.assets)).map(({ id, ...a }) => a)).toEqual(
      p.assets.map(({ id, ...a }) => ({ ...a, feeMode: "manual" })),
    );
    expect(() =>
      parseBackup(
        JSON.stringify({ ...data, snapshots: [...snapshots, snapshots[0]] }),
      ),
    ).toThrow();
  });
});
