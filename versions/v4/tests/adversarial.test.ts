import { describe, it, expect } from "vitest";
import {
  blankAsset,
  initialPortfolio,
  plan,
  validate,
  type Mode,
} from "../src/engine";
import { scenarioComparison } from "../src/analysis";
import {
  parseBackup,
  serializeFinancialBackup,
  type Backup,
} from "../src/storage";

function fixture(): Backup {
  return {
    version: 3,
    state: "actual",
    portfolio: {
      ...initialPortfolio(),
      cash: 100000,
      assets: [
        { ...blankAsset(), id: "a", ticker: "00662", shares: 100, price: 100 },
      ],
    },
    snapshots: [],
    evidence: [],
  };
}
describe("adversarial financial state and input boundaries", () => {
  it.each(["__proto__", "constructor", "toString", "hasOwnProperty"])(
    "treats a valid imported ID %s as data, not an inherited shock",
    (id) => {
      const b = fixture();
      b.portfolio.assets[0].id = id;
      const p = parseBackup(JSON.stringify(b)).portfolio;
      const r = plan(p, "full");
      const neutral = scenarioComparison(p, r, {});
      expect(neutral).not.toBeNull();
      expect(neutral?.beforeChange).toBe(0);
      const shocked = scenarioComparison(p, r, { [id]: -100 });
      expect(shocked?.beforeTotal).toBe(p.cash + p.settlement);
    },
  );
  it("refuses deeply nested extensions before they can crash saved-data rendering", () => {
    const text = JSON.stringify(fixture()).replace(
      '"portfolio":{',
      '"portfolio":{"extension":' +
        "[".repeat(10000) +
        "0" +
        "]".repeat(10000) +
        ",",
    );
    expect(() => parseBackup(text)).toThrow("層級");
  });
  it("accepts exactly 64 structural levels and rejects the 65th", () => {
    const make = (arrays: number) =>
      JSON.stringify(fixture()).replace(
        '"portfolio":{',
        '"portfolio":{"extension":' +
          "[".repeat(arrays) +
          "0" +
          "]".repeat(arrays) +
          ",",
      );
    expect(() => parseBackup(make(62))).not.toThrow();
    expect(() => parseBackup(make(63))).toThrow("層級");
  });
  it("allows delimiter-like text, escaped quotes and Unicode without mistaking them for nesting", () => {
    const b = fixture();
    b.snapshots = [
      {
        id: "x",
        name: '[[[{{{ " \\ 😀'.repeat(200),
        date: "2026-10-07T00:00:00Z",
        portfolio: b.portfolio,
      },
    ];
    expect(parseBackup(serializeFinancialBackup(b))).toEqual(b);
  });
  it("rejects 1200 invalid number and type mutations without changing source data", () => {
    for (let i = 0; i < 1200; i++) {
      const b = fixture();
      b.portfolio.assets[0].shares = 100 + i;
      const keys = [
        "cash",
        "settlement",
        "flow",
        "shares",
        "price",
        "feeRate",
        "sellTaxRate",
        "minFee",
        "lot",
      ];
      const key = keys[i % keys.length];
      const invalidNumber =
        key === "shares"
          ? i + 0.5
          : key === "lot" || key === "cash"
            ? -1 - i
            : key === "feeRate" || key === "sellTaxRate"
              ? 11 + i
              : 1e12 + 1 + i;
      const bad: unknown[] = [
        null,
        {},
        [],
        String(i),
        true,
        false,
        "",
        invalidNumber,
        1e308,
      ];
      const target = i % keys.length < 3 ? b.portfolio : b.portfolio.assets[0];
      (target as unknown as Record<string, unknown>)[key] =
        bad[Math.floor(i / keys.length) % bad.length];
      const text = JSON.stringify(b);
      expect(() => parseBackup(text)).toThrow();
      expect(JSON.stringify(b)).toBe(text);
    }
  });
  it("checks 4500 boundary portfolios for frozen positions, no short sales, lot increments and finite totals", () => {
    for (let i = 0; i < 1500; i++) {
      const b = fixture();
      const p = b.portfolio;
      p.cash = 100000 + (i % 71) * 127;
      p.flow = ((i % 7) - 3) * 1000;
      p.settlement = ((i % 13) - 6) * 123;
      p.cashTarget = 20;
      p.assets = Array.from({ length: 4 }, (_, j) => ({
        ...blankAsset(),
        id: String(j),
        ticker: String(1000 + j),
        shares: 100 + (i % 997),
        price: [0.01, 0.29, 37.51, 999.99][(i + j) % 4],
        target: 20,
        lot: [1, 100, 1000][(i + j) % 3],
        limit: (["free", "buyOnly", "frozen"] as const)[(i + j) % 3],
      }));
      expect(validate(p)).toEqual([]);
      for (const mode of ["full", "contribute", "band"] as Mode[]) {
        const r = plan(p, mode);
        expect(r.errors).toEqual([]);
        expect(
          [r.total, r.afterTotal, r.cash, r.cost].every(Number.isFinite),
        ).toBe(true);
        for (const t of r.trades) {
          expect(t.asset.shares + t.quantity).toBeGreaterThanOrEqual(0);
          expect(t.quantity % t.asset.lot === 0).toBe(true);
          if (t.asset.limit === "frozen") expect(t.quantity).toBe(0);
          if (mode === "contribute" || t.asset.limit === "buyOnly")
            expect(t.quantity).toBeGreaterThanOrEqual(0);
        }
        expect(Math.abs(r.total - r.cost - r.afterTotal)).toBeLessThan(0.011);
        expect(
          Math.abs(
            r.cash +
              r.trades.reduce((s, t) => s + t.afterValue, 0) -
              r.afterTotal,
          ),
        ).toBeLessThan(0.011);
      }
    }
  });
});
