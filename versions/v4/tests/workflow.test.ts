import { describe, it, expect } from "vitest";
import {
  blankAsset,
  initialPortfolio,
  plan,
  money,
  type Portfolio,
} from "../src/engine";
import {
  allocationComparison,
  tradeReview,
  actualTimeline,
} from "../src/workflow";
import { projectedPortfolio, portfolioTotal } from "../src/analysis";
import {
  inspectCSV,
  guessMapping,
  mapHoldings,
  mappedPortfolio,
} from "../src/csvMapping";
import {
  assetsCSV,
  parseHoldingsCSV,
  parseBackup,
  serializeFinancialBackup,
  type Snapshot,
} from "../src/storage";

function fixture(): Portfolio {
  return {
    ...initialPortfolio(),
    cash: 25000,
    settlement: -5000,
    flow: 30000,
    cashTarget: 20,
    assets: [
      {
        ...blankAsset(),
        ticker: "00662",
        kind: "core",
        shares: 400,
        price: 100,
        target: 40,
        sellTaxRate: 0.1,
      },
      {
        ...blankAsset(),
        ticker: "00675L",
        kind: "leverage",
        shares: 150,
        price: 200,
        target: 30,
        sellTaxRate: 0.1,
      },
      {
        ...blankAsset(),
        ticker: "2330",
        kind: "other",
        shares: 10,
        price: 1000,
        target: 10,
      },
    ],
  };
}
describe("allocation, cost review and actual history", () => {
  it("compares current to aggregated targets and net post-cost weights without counting flow twice", () => {
    const p = fixture(),
      r = plan(p, "full"),
      rows = allocationComparison(p, r);
    expect(rows.map((g) => g.percent)).toEqual([40, 30, 10, 20]);
    expect(rows.map((g) => g.target)).toEqual([40, 30, 10, 20]);
    expect(rows.reduce((s, g) => s + g.after!, 0)).toBeCloseTo(100, 8);
    expect(portfolioTotal(projectedPortfolio(p, r))).toBeCloseTo(
      130000 - r.cost,
      2,
    );
  });
  it("does not fabricate incomplete targets, invalid estimates or negative-cash graphics", () => {
    const p = fixture();
    p.assets[0].target = null;
    expect(
      allocationComparison(p, null).every(
        (g) => g.target === null && g.after === null,
      ),
    ).toBe(true);
    p.cash = 0;
    p.settlement = -30000;
    expect(allocationComparison(p, null).at(-1)!.percent).toBe(-60);
    p.cash = NaN;
    expect(allocationComparison(p, null).every((g) => g.percent === null)).toBe(
      true,
    );
  });
  it("reports cash target drift even when each of many frozen stocks is within tolerance", () => {
    const p = {
      ...initialPortfolio(),
      cash: 2000,
      cashTarget: 10,
      assets: Array.from({ length: 10 }, (_, i) => ({
        ...blankAsset(),
        ticker: String(1000 + i),
        shares: 8,
        price: 100,
        target: 9,
        limit: "frozen" as const,
      })),
    };
    const r = plan(p, "full");
    expect(r.notes.some((n) => n.includes("現金比例仍超出"))).toBe(true);
  });
  it("keeps fee breakdown reconciled at a half-cent boundary", () => {
    const p = fixture();
    p.assets[0] = {
      ...p.assets[0],
      shares: 1,
      price: 5,
      target: 0,
      feeRate: 0.1,
      sellTaxRate: 0.1,
    };
    p.assets[1].target = 70;
    p.flow = 0;
    const r = plan(p, "full"),
      summary = tradeReview(p, r);
    expect(money(summary.tax + summary.commission)).toBe(r.cost);
    expect(
      money(summary.openingCash + p.flow + summary.sell - summary.buy - r.cost),
    ).toBeCloseTo(r.cash, 2);
  });
  it("excludes estimates, plans and unmarked legacy records; sorts without mutating history", () => {
    const snapshots: Snapshot[] = [
      "plan",
      "actual",
      "estimate",
      undefined,
      "actual",
    ].map((kind, i) => ({
      id: String(i),
      name: String(i),
      date: `2026-10-0${5 - i}T00:00:00Z`,
      kind: kind as Snapshot["kind"],
      portfolio: fixture(),
    }));
    const before = JSON.stringify(snapshots);
    expect(actualTimeline(snapshots).map((r) => r.id)).toEqual(["4", "1"]);
    expect(JSON.stringify(snapshots)).toBe(before);
  });
  it("retains draft sources and the unchanged actual portfolio through JSON round trips", () => {
    const p = fixture(),
      draft = structuredClone(p);
    draft.flow = 70000;
    const r = plan(draft, "contribute");
    const b = {
      version: 3 as const,
      portfolio: p,
      snapshots: [
        {
          id: "draft",
          name: "草稿",
          date: "2026-10-07T00:00:00Z",
          kind: "plan" as const,
          sourcePortfolio: draft,
          portfolio: projectedPortfolio(draft, r),
          mode: "contribute" as const,
        },
      ],
      evidence: [],
    };
    expect(parseBackup(serializeFinancialBackup(b))).toEqual(b);
    expect(p.flow).toBe(30000);
  });
  it("survives 1500 seeded portfolios across all modes, fees, lots and signed cash flows", () => {
    let seed = 433;
    const rand = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    for (let run = 0; run < 1500; run++) {
      const count = 1 + Math.floor(rand() * 100),
        p = fixture();
      p.assets = Array.from({ length: count }, (_, i) => ({
        ...blankAsset(),
        id: String(i),
        ticker: String(1000 + i),
        kind: (["core", "leverage", "other"] as const)[i % 3],
        shares: Math.floor(rand() * 10000),
        price: Math.round(rand() * 100000 + 1) / 100,
        target: 80 / count,
        lot: rand() < 0.5 ? 1 : 1000,
        feeRate: 0.1425,
        minFee: rand() < 0.5 ? 0 : 20,
        limit: (["free", "buyOnly", "frozen"] as const)[Math.floor(rand() * 3)],
      }));
      p.flow = Math.round(rand() * 60000) - 20000;
      const before = JSON.stringify(p);
      const r = plan(p, (["full", "contribute", "band"] as const)[run % 3]);
      expect(r.errors).toEqual([]);
      const rows = allocationComparison(p, r),
        summary = tradeReview(p, r);
      expect(rows.reduce((s, g) => s + g.target!, 0)).toBeCloseTo(100, 6);
      expect(rows.reduce((s, g) => s + g.after!, 0)).toBeCloseTo(100, 6);
      expect(money(summary.tax + summary.commission)).toBe(r.cost);
      expect(summary.commission).toBeGreaterThanOrEqual(0);
      expect(
        money(
          summary.openingCash + p.flow + summary.sell - summary.buy - r.cost,
        ),
      ).toBeCloseTo(r.cash, 2);
      expect(JSON.stringify(p)).toBe(before);
    }
  }, 30000);
});

describe("external CSV mapping safeguards", () => {
  it("rejects undecodable text instead of silently replacing financial labels", () => {
    expect(() =>
      inspectCSV("ticker,shares,price,name\n2330,1,100,\uFFFD"),
    ).toThrow(/UTF-8/);
  });
  const parse = (text: string, unit: "share" | "lot" = "share") => {
    const { table } = inspectCSV(text);
    return mapHoldings(table, guessMapping(table), unit);
  };
  it("handles BOM, CRLF, quoted commas, escaped names and fractional lots exactly", () => {
    const a = parse(
      '\uFEFF證券代號,名稱,數量,現價\r\n00662,"測試,名稱",1.001,100\r\n2330,"含""引號",0.001,"1,000.5"',
      "lot",
    );
    expect(a.map((x) => x.shares)).toEqual([1001, 1]);
    expect(a[1].price).toBe(1000.5);
    expect(a[0].ticker).toBe("00662");
    expect(a[1].name).toBe('含"引號');
  });
  it.each([
    "",
    "1e3",
    "0x10",
    "Infinity",
    "-1",
    "1,00",
    "1.00000000000000001",
    "=1+2",
  ])("rejects ambiguous share quantity %s", (value) => {
    expect(() => parse(`代號,數量,現價\n2330,"${value}",100`)).toThrow();
  });
  it.each(["USD", "JPY", "", "TWD/USD"])(
    "refuses currency %s even if the user does not map the currency column",
    (c) => {
      const { table } = inspectCSV(`代號,數量,現價,幣別\n2330,1,100,${c}`);
      const mapping = guessMapping(table);
      mapping.currency = -1;
      expect(() => mapHoldings(table, mapping, "share")).toThrow(/新臺幣/);
    },
  );
  it("requires explicit units and unique column selections", () => {
    const { table } = inspectCSV("代號,數量,現價\n2330,1,100");
    const m = guessMapping(table);
    expect(() => mapHoldings(table, m, "")).toThrow(/單位/);
    expect(() =>
      mapHoldings(table, { ...m, price: m.shares }, "share"),
    ).toThrow(/重複/);
  });
  it.each(["成交價格", "交易日期", "side", "買賣股數"])(
    "rejects transaction marker %s",
    (column) => {
      expect(() =>
        inspectCSV(`代號,數量,現價,${column}\n2330,1,100,買進`),
      ).toThrow(/交易/);
    },
  );
  it("keeps native exchange metadata strict, including malformed files", () => {
    const original = assetsCSV(fixture().assets);
    expect(inspectCSV(original).native).toBe(true);
    const damaged = original.replaceAll("TWD", "USD");
    expect(inspectCSV(damaged).native).toBe(true);
    expect(() => parseHoldingsCSV(damaged)).toThrow();
    expect(
      inspectCSV(
        "ticker,shares,price,recordType\n2330,1,100,rebalance_plan_not_executed",
      ).native,
    ).toBe(true);
  });
  it("blocks normalized duplicate symbols instead of doubling holdings", () => {
    expect(() =>
      parse("代號,數量,現價\n００６６２,1,100\n00662,1,100"),
    ).toThrow(/重複/);
  });
  it.each([
    "代號,數量,數量\n2330,1,100",
    "代號,,現價\n2330,1,100",
    "代號,數量,現價\n2330,1",
    "代號,數量,現價\n2330,1,100,extra",
    '代號,數量,現價\n2330,"1,100',
    "代號,數量,現價",
  ])("rejects damaged or empty external table", (text) => {
    expect(() => inspectCSV(text)).toThrow();
  });
  it("bounds rows, columns and field size", () => {
    const header = "代號,數量,現價\n";
    expect(
      parse(
        header +
          Array.from({ length: 100 }, (_, i) => `${1000 + i},1,100`).join("\n"),
      ),
    ).toHaveLength(100);
    expect(() =>
      inspectCSV(
        header +
          Array.from({ length: 101 }, (_, i) => `${1000 + i},1,100`).join("\n"),
      ),
    ).toThrow(/100/);
    expect(() =>
      inspectCSV(Array.from({ length: 65 }, (_, i) => String(i)).join(",")),
    ).toThrow(/欄位/);
    expect(() => inspectCSV(header + "x".repeat(1025))).toThrow(/1024/);
  });
  it("preserves same-symbol settings and latest cash but clears all targets when the symbol set changes", () => {
    const p = fixture();
    p.assets[0].feeRate = 0.04;
    p.assets[0].priceUpdatedAt = "2026-10-01T00:00:00Z";
    const imported = parse("代號,數量,現價\n00662,123,99\n2330,456,88");
    const before = JSON.stringify(p);
    const next = mappedPortfolio(p, imported);
    expect(next.cash).toBe(p.cash);
    expect(next.settlement).toBe(-5000);
    expect(next.assets[0].feeRate).toBe(0.04);
    expect(next.assets[0].kind).toBe("core");
    expect(next.assets[0].priceUpdatedAt).toBeUndefined();
    expect(next.cashTarget).toBeNull();
    expect(next.assets.every((a) => a.target === null)).toBe(true);
    expect(JSON.stringify(p)).toBe(before);
    const same = mappedPortfolio(
      p,
      p.assets.map((a) => ({ ...a, shares: 42 })),
    );
    expect(same.cashTarget).toBe(20);
    expect(same.assets.map((a) => a.target)).toEqual([40, 30, 10]);
  });
  it("maps 1000 seeded shuffled CSVs and reimports their native exports", () => {
    for (let i = 0; i < 1000; i++) {
      const text =
        i % 2
          ? `現價,數量,代號\n${i + 1}.25,${i},00662`
          : `代號,現價,數量\n00662,${i + 1}.25,${i}`;
      const assets = parse(text);
      expect(assets[0].shares).toBe(i);
      expect(assets[0].price).toBe(i + 1.25);
      expect(assets[0].ticker).toBe("00662");
      const roundTrip = parseHoldingsCSV(assetsCSV(assets)).assets;
      expect(roundTrip[0].shares).toBe(i);
      expect(roundTrip[0].ticker).toBe("00662");
    }
  });
});
