import { describe, expect, it } from "vitest";
import { assetAllocation } from "../src/assetAllocation";
import { blankAsset, initialPortfolio, type Portfolio } from "../src/engine";

function fixture(): Portfolio {
  return {
    ...initialPortfolio(),
    cash: 25000,
    settlement: -5000,
    flow: 30000,
    assets: [
      {
        ...blankAsset(),
        ticker: "2330",
        kind: "core",
        shares: 40,
        price: 1000,
      },
      {
        ...blankAsset(),
        ticker: "00675L",
        kind: "leverage",
        shares: 150,
        price: 200,
      },
      {
        ...blankAsset(),
        ticker: "00662",
        kind: "other",
        shares: 100,
        price: 100,
      },
    ],
  };
}
describe("current allocation valuation", () => {
  it("uses selected classes, net T+2 cash and market value without doubling leverage or adding flow", () => {
    const r = assetAllocation(fixture());
    expect(r.total).toBe(100000);
    expect(r.groups.map((g) => g.value)).toEqual([40000, 30000, 10000, 20000]);
    expect(r.groups.map((g) => g.percent)).toEqual([40, 30, 10, 20]);
    expect(r.chartable).toBe(true);
  });
  it("retains signed percentages when cash is negative instead of drawing a misleading donut", () => {
    const p = fixture();
    p.cash = 0;
    p.settlement = -30000;
    const r = assetAllocation(p);
    expect(r.total).toBe(50000);
    expect(r.groups.map((g) => g.percent)).toEqual([80, 60, 20, -60]);
    expect(r.chartable).toBe(false);
  });
  it.each([0, -100])(
    "suppresses percentage for zero/negative total %s",
    (settlement) => {
      const r = assetAllocation({ ...initialPortfolio(), settlement });
      expect(r.total).toBe(settlement);
      expect(r.chartable).toBe(false);
      expect(r.groups.every((g) => g.percent === null)).toBe(true);
    },
  );
  it("renders cash-only as 100% and ignores incomplete targets and fees", () => {
    const p = fixture();
    p.cashTarget = 99;
    p.assets[0].feeRate = NaN;
    expect(assetAllocation(p).chartable).toBe(true);
    const r = assetAllocation({ ...initialPortfolio(), cash: 100 });
    expect(r.groups.map((g) => g.percent)).toEqual([0, 0, 0, 100]);
  });
  it.each([NaN, Infinity, -1, 1e13])(
    "does not chart invalid cash %s",
    (cash) => {
      const r = assetAllocation({ ...fixture(), cash });
      expect(r.total).toBeNull();
      expect(r.chartable).toBe(false);
      expect(
        r.groups.every((g) => g.value === null && g.percent === null),
      ).toBe(true);
    },
  );
  it.each([NaN, Infinity, -1, 0, 1e10])(
    "does not chart invalid prices %s",
    (price) => {
      const p = fixture();
      p.assets[0].price = price;
      expect(assetAllocation(p).total).toBeNull();
    },
  );
  it("keeps grouping and conservation across 100 holdings and changing categories", () => {
    const p = fixture();
    p.assets = Array.from({ length: 100 }, (_, i) => ({
      ...p.assets[i % 3],
      id: String(i),
      shares: i,
      price: i + 0.13,
    }));
    for (let j = 0; j < 100; j++) {
      p.assets[j].kind = j % 2 ? "core" : "other";
      const r = assetAllocation(p);
      expect(r.total).toBeCloseTo(
        p.cash +
          p.settlement +
          p.assets.reduce((s, a) => s + a.shares * a.price, 0),
        7,
      );
      expect(r.groups.reduce((s, g) => s + g.percent!, 0)).toBeCloseTo(100, 9);
    }
  });
});

import {
  parseBackup,
  serializeFinancialBackup,
  validateStoredPortfolio,
} from "../src/storage";
import { validate, plan } from "../src/engine";
describe("cleared portfolio persistence", () => {
  it("round-trips an empty form with preserved historical holdings while refusing to trade", () => {
    const backup = {
      version: 3 as const,
      portfolio: initialPortfolio(),
      snapshots: [
        {
          id: "old",
          name: "history",
          date: "2026-10-07T00:00:00Z",
          portfolio: fixture(),
          kind: "actual" as const,
        },
      ],
      evidence: [],
    };
    expect(validateStoredPortfolio(backup.portfolio)).toEqual([]);
    expect(parseBackup(serializeFinancialBackup(backup)).portfolio).toEqual(
      initialPortfolio(),
    );
    expect(parseBackup(serializeFinancialBackup(backup)).snapshots).toEqual(
      backup.snapshots,
    );
    expect(validate(backup.portfolio).length).toBeGreaterThan(0);
    expect(plan(backup.portfolio, "full").errors.length).toBeGreaterThan(0);
  });
  it.each([
    { cash: NaN },
    { cash: -1 },
    { settlement: -1 },
    { flow: -1 },
    { cashTarget: 20 },
    { assets: [blankAsset()] },
  ])("does not whitelist incomplete or invalid documents %j", (patch) => {
    expect(
      validateStoredPortfolio({ ...initialPortfolio(), ...patch }).length,
    ).toBeGreaterThan(0);
  });
});
