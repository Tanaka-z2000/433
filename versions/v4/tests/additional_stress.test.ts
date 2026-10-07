import { expect, it } from "vitest";
import {
  blankAsset,
  initialPortfolio,
  validate,
  plan,
  type Portfolio,
} from "../src/engine";
import { compareHoldings, scenarioComparison } from "../src/analysis";
import { parseBackup } from "../src/storage";

const fixture = (): Portfolio => ({
  ...initialPortfolio(),
  cash: 100000,
  assets: [{ ...blankAsset(), ticker: "00675L", shares: 100, price: 100 }],
});

it.each(["00675l", "００６７５Ｌ", " 00675L "])(
  "rejects aliases of the same security: %s",
  (ticker) => {
    const p = fixture();
    p.assets.push({ ...p.assets[0], id: "second", ticker });
    expect(validate(p).join()).toContain("代號不可重複");
    expect(() =>
      parseBackup(
        JSON.stringify({
          version: 3,
          portfolio: p,
          snapshots: [],
          evidence: [],
        }),
      ),
    ).toThrow();
  },
);

it("compares differently written tickers as one position without rewriting snapshots", () => {
  const old = fixture(),
    next = structuredClone(old);
  old.assets[0].ticker = "００６７５ｌ";
  next.assets[0].shares = 150;
  expect(compareHoldings(old, next)).toEqual([
    {
      ticker: "00675L",
      oldShares: 100,
      newShares: 150,
      oldPrice: 100,
      newPrice: 100,
      valueChange: 5000,
    },
  ]);
  expect(old.assets[0].ticker).toBe("００６７５ｌ");
});

it("rejects finite scenario inputs whose calculated value overflows", () => {
  const p = fixture(),
    r = plan(p, "full");
  expect(
    scenarioComparison(p, r, { [p.assets[0].id]: Number.MAX_VALUE }),
  ).toBeNull();
});

it("checks 100 positions across 200 extreme scenario sets for finite output and zero-shock conservation", () => {
  const p = fixture();
  p.assets = Array.from({ length: 100 }, (_, i) => ({
    ...blankAsset(),
    ticker: String(1000 + i),
    shares: 100 + i,
    price: 1 + i,
  }));
  const r = plan(p, "full");
  for (let i = 0; i < 200; i++) {
    const shock = [-100, -99.999, 0, 100, 1e8, 1e300, Number.MAX_VALUE][i % 7];
    const result = scenarioComparison(
      p,
      r,
      Object.fromEntries(p.assets.map((a) => [a.id, shock])),
    );
    if (result) expect(Object.values(result).every(Number.isFinite)).toBe(true);
    if (shock === 0)
      expect(result).toMatchObject({
        beforeChange: 0,
        afterChange: 0,
        beforeTotal: r.total,
        afterTotal: r.afterTotal,
      });
  }
});
