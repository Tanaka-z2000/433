import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { FINANCE_FORMAT, CSV_CONTEXT } from "../src/interchange";
import { blankAsset, initialPortfolio, plan } from "../src/engine";
import {
  assetsCSV,
  parseHoldingsCSV,
  parseBackup,
  serializeFinancialBackup,
  tradesCSV,
  backupContent,
  BACKUP_LIMIT_BYTES,
  type Backup,
} from "../src/storage";

const fixture = (): Backup => {
  const p = {
    ...initialPortfolio(),
    cash: 123456.78,
    settlement: -4567,
    flow: 10000,
    cashTarget: 75,
    assets: [
      {
        ...blankAsset(),
        ticker: "00662",
        name: '基金,"甲"\n類',
        shares: 123,
        price: 98.76,
        target: 25,
        feeRate: 0.1425,
        sellTaxRate: 0.1,
      },
    ],
  };
  return {
    version: 3,
    portfolio: p,
    state: "estimate",
    beforeEstimate: structuredClone(p),
    snapshots: [
      {
        id: "history",
        date: "2026-10-07T01:02:03Z",
        name: "歷史持倉",
        kind: "actual",
        portfolio: structuredClone(p),
      },
    ],
    evidence: [],
  };
};
describe("documented financial exchange", () => {
  it("does not emit a CSV whose escaped field exceeds its import limit", () => {
    const a = fixture().portfolio.assets[0];
    a.ticker = "0".repeat(1024);
    expect(parseHoldingsCSV(assetsCSV([a])).assets[0].ticker).toBe(a.ticker);
    a.ticker = "=" + "0".repeat(1023);
    expect(() => assetsCSV([a])).toThrow("改用 JSON");
  });
  it("round-trips the whole backup without duplicating balances or persisting its dictionary", () => {
    const b = fixture();
    const file = serializeFinancialBackup(b);
    const raw = JSON.parse(file);
    expect(raw.financeFormat).toEqual(FINANCE_FORMAT);
    expect(raw.portfolio.settlement).toBe(-4567);
    expect(raw.portfolio.assets[0].ticker).toBe("00662");
    const restored = parseBackup("\uFEFF" + file);
    expect(restored).toEqual(b);
    expect(backupContent(restored)).toBe(backupContent(b));
  });
  it.each([1, 2, 3] as const)(
    "retains old backup structure %i compatibility",
    (version) => {
      const b = { ...fixture(), version };
      const old = parseBackup(JSON.stringify(b));
      expect(parseBackup(serializeFinancialBackup(b))).toEqual(old);
    },
  );
  it.each([
    ["id", "another-format"],
    ["version", 2],
    ["currency", "USD"],
    ["quantityUnit", "lot"],
    ["priceUnit", "USD/share"],
    ["rateUnit", "decimal"],
    ["market", "US"],
    ["dateTimeFormat", "unix-seconds"],
  ])("rejects unsupported JSON semantics %s", (key, value) => {
    const raw = JSON.parse(serializeFinancialBackup(fixture()));
    raw.financeFormat[key] = value;
    expect(() => parseBackup(JSON.stringify(raw))).toThrow("財務交換格式");
  });
  it("keeps the downloadable field guide in sync", () => {
    const guide = JSON.parse(
      readFileSync("public/data/finance-format-v1.json", "utf8"),
    );
    expect(guide).toMatchObject(FINANCE_FORMAT);
    expect(guide.csvContext).toEqual(CSV_CONTEXT);
    expect(guide.csvColumns.join(",")).toBe(
      assetsCSV([]).replace(/^\uFEFF/, ""),
    );
  });
  it("preserves numeric percent units and estimate status across reordered CSV columns", () => {
    const p = fixture().portfolio;
    p.assets[0].name = "基金甲";
    const csv = assetsCSV(p.assets, "estimate");
    const reordered = csv
      .replace(/^\uFEFF/, "")
      .split("\r\n")
      .map((row) => row.split(",").reverse().join(","))
      .join("\r\n");
    const parsed = parseHoldingsCSV(reordered);
    expect(parsed.state).toBe("estimate");
    expect(parsed.assets[0]).toMatchObject({
      ticker: "00662",
      shares: 123,
      price: 98.76,
      target: 25,
      feeRate: 0.1425,
      sellTaxRate: 0.1,
      feeMode: "manual",
    });
  });
  it.each([
    ['"TWD"', '"USD"'],
    ['"share"', '"lot"'],
    ['"TWD/share"', '"USD/share"'],
    ['"percent"', '"decimal"'],
    ['"433-holdings-1"', '"433-holdings-2"'],
    ['"actual_holdings"', '"executed_trade"'],
  ])("refuses ambiguous CSV semantics %s", (from, to) => {
    expect(() =>
      parseHoldingsCSV(assetsCSV(fixture().portfolio.assets).replace(from, to)),
    ).toThrow();
  });
  it("rejects mixed actual and estimated positions and duplicate columns", () => {
    const a = fixture().portfolio.assets[0];
    a.name = "基金甲";
    const csv = assetsCSV([a, { ...a, id: "two", ticker: "2330" }]);
    expect(() =>
      parseHoldingsCSV(
        csv.replace('"actual_holdings"', '"estimated_holdings"'),
      ),
    ).toThrow("混合");
    expect(() =>
      parseHoldingsCSV(
        csv.replace("currency,quantityUnit", "currency,currency"),
      ),
    ).toThrow("欄位");
  });
  it("identifies plan exports and refuses to turn proposed trades into holdings", () => {
    const p = fixture().portfolio;
    const csv = tradesCSV(plan(p, "full"));
    expect(() => parseHoldingsCSV(csv)).toThrow("尚未成交");
  });
  it("preserves legacy ten and twelve column formats, empty holdings and literal names", () => {
    expect(parseHoldingsCSV(assetsCSV([])).assets).toEqual([]);
    const p = fixture().portfolio;
    expect(parseHoldingsCSV(assetsCSV(p.assets)).assets[0].name).toBe(
      p.assets[0].name,
    );
    for (const suffix of ["", ",name,shortName"]) {
      const result = parseHoldingsCSV(
        "ticker,kind,shares,price,target,limit,lot,feeRate,minFee,sellTaxRate" +
          suffix +
          "\n00662,core,2,100,,free,1,0.1425,0,0.1" +
          (suffix ? ",全稱,簡稱" : ""),
      );
      expect(result.assets[0]).toMatchObject({
        ticker: "00662",
        feeRate: 0.1425,
        target: null,
      });
      expect(result.state).toBeUndefined();
    }
  });
  it("includes metadata in UTF-8 size budgeting and refuses an extra byte", () => {
    const b = fixture();
    const text = serializeFinancialBackup(b);
    const bytes = new TextEncoder().encode(text).byteLength;
    expect(serializeFinancialBackup(b, BACKUP_LIMIT_BYTES - bytes)).toBe(text);
    expect(() =>
      serializeFinancialBackup(b, BACKUP_LIMIT_BYTES - bytes + 1),
    ).toThrow("32 MiB");
  });
  it("round-trips 100 positions and 50 snapshots repeatedly without growing the dictionary", () => {
    let b = fixture();
    b.portfolio.assets = Array.from({ length: 100 }, (_, i) => ({
      ...b.portfolio.assets[0],
      id: String(i),
      ticker: String(100000 + i),
      target: 0.25,
    }));
    b.snapshots = Array.from({ length: 50 }, (_, i) => ({
      ...b.snapshots[0],
      id: String(i),
      portfolio: structuredClone(b.portfolio),
      sourcePortfolio: structuredClone(b.portfolio),
    }));
    const expected = structuredClone(b);
    const bytes = serializeFinancialBackup(b).length;
    for (let i = 0; i < 10; i++) {
      b = parseBackup(serializeFinancialBackup(b));
      expect(b).toEqual(expected);
      expect(serializeFinancialBackup(b).length).toBe(bytes);
    }
  });
});
