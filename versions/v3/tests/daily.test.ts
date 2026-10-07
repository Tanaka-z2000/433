import { describe, it, expect } from "vitest";
import {
  blankAsset,
  initialPortfolio,
  plan,
  validate,
  type Portfolio,
} from "../src/engine";
import { parseBackup, backupContent, digestContent } from "../src/storage";
import {
  projectedPortfolio,
  scenarioComparison,
  portfolioTotal,
  compareHoldings,
  tradeExplanation,
} from "../src/analysis";
const fixture = (): Portfolio => ({
  ...initialPortfolio(),
  cash: 60000,
  settlement: -5000,
  flow: 10000,
  cashTarget: 20,
  assets: [
    {
      ...blankAsset(),
      ticker: "00662",
      kind: "core",
      shares: 1000,
      price: 100,
      target: 60,
    },
    {
      ...blankAsset(),
      ticker: "00675L",
      kind: "leverage",
      shares: 500,
      price: 100,
      target: 20,
    },
  ],
});
describe("V2 portability and calculations", () => {
  it("migrates V1 without dropping legacy data and round-trips pending verification", () => {
    const p = fixture(),
      legacy = {
        version: 1,
        portfolio: p,
        snapshots: [
          {
            id: "one",
            name: "原始",
            date: "2026-10-07T00:00:00Z",
            portfolio: p,
          },
        ],
        evidence: [],
      };
    const imported = parseBackup(JSON.stringify(legacy));
    expect(imported.version).toBe(2);
    expect(imported.snapshots).toEqual(legacy.snapshots);
    const pending = { ...imported, state: "estimate", beforeEstimate: p };
    expect(parseBackup(JSON.stringify(pending)).beforeEstimate).toEqual(p);
    expect(() =>
      parseBackup(JSON.stringify({ ...pending, state: "garbage" })),
    ).toThrow();
    expect(() =>
      parseBackup(
        JSON.stringify({
          ...pending,
          snapshots: [legacy.snapshots[0], legacy.snapshots[0]],
        }),
      ),
    ).toThrow();
  });
  it("keeps contributions and signed T+2 consistent, and charges costs once", () => {
    const p = fixture(),
      r = plan(p, "full"),
      next = projectedPortfolio(p, r);
    expect(validate(next)).toEqual([]);
    expect(next.cash + next.settlement).toBeCloseTo(r.cash, 2);
    expect(next.flow).toBe(0);
    expect(portfolioTotal(next)).toBeCloseTo(
      portfolioTotal(p) + p.flow - r.cost,
      2,
    );
    const flat = scenarioComparison(p, r, {})!;
    expect(flat.afterTotal - flat.beforeTotal).toBeCloseTo(-r.cost, 2);
    const crash = scenarioComparison(
      p,
      r,
      Object.fromEntries(p.assets.map((a) => [a.id, -100])),
    )!;
    expect(crash.beforeTotal).toBeCloseTo(p.cash + p.settlement + p.flow, 2);
    expect(crash.afterTotal).toBeCloseTo(r.cash, 2);
    expect(scenarioComparison(p, r, { [p.assets[0].id]: -101 })).toBeNull();
  });
  it("compares imported holdings by ticker rather than regenerated IDs", () => {
    const a = fixture(),
      b = structuredClone(a);
    b.assets[0].id = "different";
    b.assets[0].shares += 10;
    const diff = compareHoldings(a, b);
    expect(diff).toHaveLength(2);
    expect(diff[0].valueChange).toBe(1000);
  });
  it("detects edits since export without treating export metadata as a change", async () => {
    const b = parseBackup(
      JSON.stringify({
        version: 1,
        portfolio: fixture(),
        snapshots: [],
        evidence: [],
      }),
    );
    const digest = await digestContent(backupContent(b));
    b.exported = { at: new Date().toISOString(), digest };
    expect(await digestContent(backupContent(b))).toBe(digest);
    b.portfolio.settlement -= 1;
    expect(await digestContent(backupContent(b))).not.toBe(digest);
  });
  it("explains enforced restrictions and validates price timestamps", () => {
    const p = fixture();
    p.assets[0].limit = "frozen";
    expect(tradeExplanation(p, plan(p, "full"), "00662")).toContain("完全不動");
    p.assets[0].priceUpdatedAt = "invalid";
    expect(validate(p).length).toBeGreaterThan(0);
  });
});
