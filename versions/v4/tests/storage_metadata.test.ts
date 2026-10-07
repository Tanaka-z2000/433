import { describe, expect, it } from "vitest";
import {
  blankAsset,
  initialPortfolio,
  validate,
  validDate,
  type Asset,
  type Portfolio,
} from "../src/engine";
import {
  assetsCSV,
  parseCSV,
  parseBackup,
  serializeBackup,
  BACKUP_LIMIT_BYTES,
  type Backup,
} from "../src/storage";

const fixture = (): Portfolio => ({
  ...initialPortfolio(),
  cash: 100_000,
  assets: [
    {
      ...blankAsset(),
      ticker: "00662",
      name: "富邦NASDAQ-100證券投資信託基金",
      shortName: "富邦NASDAQ",
      securityType: "equityETF",
      feeMode: "auto",
      securityAsOf: "2026-10-07",
      feeRuleId: "tw-equity-etf-v1",
      taxValidUntil: "2026-12-31",
      feeRate: 0.0285,
      minFee: 8,
      sellTaxRate: 0.1,
      shares: 10,
      price: 100,
    },
  ],
});
const backup = (version: Backup["version"] = 3): Backup => {
  const p = fixture();
  return {
    version,
    portfolio: structuredClone(p),
    state: "estimate",
    beforeEstimate: structuredClone(p),
    evidence: [],
    snapshots: [
      {
        id: "test",
        date: "2026-10-07T12:00:00Z",
        name: "含標的名稱",
        kind: "plan",
        mode: "full",
        portfolio: structuredClone(p),
        sourcePortfolio: structuredClone(p),
      },
    ],
  };
};

describe("V4 product metadata and manual migration", () => {
  it("preserves V4 metadata through all snapshot and pending portfolios", () => {
    const b = backup();
    expect(parseBackup(JSON.stringify(b))).toEqual(b);
    expect(validate(b.portfolio)).toEqual([]);
  });
  it.each([1, 2] as const)(
    "migrates schema %i without replacing any custom fee in current or historical data",
    (version) => {
      const b = backup(version);
      const migrated = parseBackup(JSON.stringify(b));
      expect(migrated.version).toBe(3);
      const portfolios = [
        migrated.portfolio,
        migrated.beforeEstimate!,
        migrated.snapshots[0].portfolio,
        migrated.snapshots[0].sourcePortfolio!,
      ];
      for (const p of portfolios)
        expect(p.assets[0]).toEqual({
          ...b.portfolio.assets[0],
          feeMode: "manual",
        });
      expect(migrated.snapshots[0].name).toBe("含標的名稱");
      expect(migrated.state).toBe("estimate");
      expect(parseBackup(JSON.stringify(migrated))).toEqual(migrated);
    },
  );
  it("accepts metadata-free old holdings and defaults them to manual during migration", () => {
    const b = backup(1);
    b.portfolio.assets = [{ ...blankAsset(), ticker: "2330" }];
    const a = parseBackup(JSON.stringify(b)).portfolio.assets[0];
    expect(a.feeMode).toBe("manual");
    expect(a.name).toBeUndefined();
    expect(a.securityType).toBeUndefined();
    expect(a.sellTaxRate).toBe(0.3);
  });
  it.each([
    ["name", "名".repeat(301)],
    ["name", 2330],
    ["shortName", "名".repeat(101)],
    ["shortName", null],
    ["securityType", "ETF"],
    ["securityType", []],
    ["feeMode", "automatic"],
    ["feeMode", false],
    ["securityAsOf", "2026-02-29"],
    ["securityAsOf", "2026-1-01"],
    ["securityAsOf", "2026-10-07T00:00:00Z"],
    ["taxValidUntil", "2026-04-31"],
    ["taxValidUntil", 20261231],
    ["feeRuleId", "x".repeat(101)],
    ["feeRuleId", {}],
  ])(
    "rejects invalid %s metadata (%j), including historical portfolios",
    (key, value) => {
      for (const location of [
        "portfolio",
        "beforeEstimate",
        "snapshot",
        "source",
      ] as const) {
        const b = backup();
        const p =
          location === "portfolio"
            ? b.portfolio
            : location === "beforeEstimate"
              ? b.beforeEstimate!
              : location === "snapshot"
                ? b.snapshots[0].portfolio
                : b.snapshots[0].sourcePortfolio!;
        (p.assets[0] as unknown as Record<string, unknown>)[key as string] =
          value;
        expect(() => parseBackup(JSON.stringify(b))).toThrow();
      }
    },
  );
  it("validates actual calendar dates and permits leap days only in leap years", () => {
    expect(validDate("2024-02-29")).toBe(true);
    expect(validDate("2026-02-29")).toBe(false);
    expect(validDate("2026-13-01")).toBe(false);
    expect(validDate(" 2026-10-07")).toBe(false);
    expect(validDate("2026-10-07\n")).toBe(false);
  });
});

describe("V4 CSV compatibility, formula protection and bounded parsing", () => {
  const textColumns = ["ticker", "name", "shortName"] as const;
  it("reads the original ten columns without inferring an automatic product classification", () => {
    const rows = parseCSV(
      "ticker,kind,shares,price,target,limit,lot,feeRate,minFee,sellTaxRate\r\n00662,core,3,100,,free,1,0.0285,8,0.1\r\n",
    );
    expect(rows[0]).toMatchObject({
      ticker: "00662",
      feeMode: "manual",
      feeRate: 0.0285,
      minFee: 8,
      sellTaxRate: 0.1,
    });
    expect(rows[0].name).toBeUndefined();
    expect(rows[0].securityType).toBeUndefined();
  });
  it("rejects unrecognized metadata columns instead of trusting supplied official flags", () => {
    const csv = assetsCSV(fixture().assets).replace(
      "name,shortName",
      "name,shortName,feeMode",
    );
    expect(() => parseCSV(csv)).toThrow();
  });
  it.each([
    "=1+1",
    "+SUM(A1:A2)",
    "-1+2",
    "@SUM(A1:A2)",
    "\t=1+1",
    "\r=1+1",
    "\n=1+1",
    "  =1+1",
    "\uFEFF=1+1",
    "'=1+1",
    "''=1+1",
    "'一般名稱",
    '名稱,"雙引號"',
    "保留\r\n換行",
    "保留\n換行",
    "台灣積體電路製造股份有限公司",
    "00662",
  ])(
    "round-trips names and codes exactly while escaping potentially executable text: %j",
    (value) => {
      const a = { ...fixture().assets[0] };
      for (const field of textColumns) a[field] = value;
      const csv = assetsCSV([a]);
      const imported = parseCSV(csv)[0];
      for (const field of textColumns) expect(imported[field]).toBe(value);
      expect(imported.feeMode).toBe("manual");
      expect(imported.securityType).toBeUndefined();
      expect(imported.feeRuleId).toBeUndefined();
      expect(imported.taxValidUntil).toBeUndefined();
      expect(imported.feeRate).toBe(a.feeRate);
      expect(imported.minFee).toBe(a.minFee);
      expect(imported.sellTaxRate).toBe(a.sellTaxRate);
      if (/^[\s\uFEFF]*[=+\-@]/.test(value) || /^[\t\r\n']/.test(value))
        expect(csv.split("\r\n")[1].startsWith("\"'")).toBe(true);
    },
  );
  it("repeatedly exports and imports 100 named holdings without accumulating escape prefixes", () => {
    let assets: Asset[] = Array.from({ length: 100 }, (_, i) => ({
      ...fixture().assets[0],
      id: String(i),
      ticker: `00${i}`,
      name: i % 2 ? `'=名稱 ${i}` : ` =名稱 ${i}`,
      shortName: `名稱 ${i}`,
    }));
    const expected = assets.map(
      ({ ticker, name, shortName, feeRate, minFee, sellTaxRate }) => ({
        ticker,
        name,
        shortName,
        feeRate,
        minFee,
        sellTaxRate,
      }),
    );
    for (let i = 0; i < 100; i++) {
      assets = parseCSV(assetsCSV(assets));
      expect(
        assets.map(
          ({ ticker, name, shortName, feeRate, minFee, sellTaxRate }) => ({
            ticker,
            name,
            shortName,
            feeRate,
            minFee,
            sellTaxRate,
          }),
        ),
      ).toEqual(expected);
    }
  });
});

describe("backup export and import share the same UTF-8 capacity", () => {
  it("measures multilingual UTF-8 bytes rather than JavaScript string length when reserving metadata space", () => {
    const b = backup();
    b.snapshots[0].name = "資產配置備份😀";
    const text = JSON.stringify(b);
    const bytes = new TextEncoder().encode(text).byteLength;
    expect(bytes).toBeGreaterThan(text.length);
    expect(serializeBackup(b, BACKUP_LIMIT_BYTES - bytes)).toBe(text);
    expect(() => serializeBackup(b, BACKUP_LIMIT_BYTES - bytes + 1)).toThrow(
      "32 MiB",
    );
    // A character-count implementation would incorrectly permit this budget.
    expect(() => serializeBackup(b, BACKUP_LIMIT_BYTES - text.length)).toThrow(
      "32 MiB",
    );
  });
  it("round-trips 100 maximum-length named holdings and 50 source snapshots beyond the former 8 MB limit", () => {
    const p = fixture();
    p.assets = Array.from({ length: 100 }, (_, i) => ({
      ...p.assets[0],
      id: String(i),
      ticker: String(100_000 + i),
      name: String(i) + "名".repeat(300 - String(i).length),
      shortName: String(i) + "簡".repeat(100 - String(i).length),
    }));
    const b: Backup = {
      version: 3,
      state: "estimate",
      portfolio: p,
      beforeEstimate: p,
      evidence: [],
      snapshots: Array.from({ length: 50 }, (_, i) => ({
        id: String(i),
        name: `來源完整的歷史快照 ${i}`,
        date: "2026-10-07T12:00:00Z",
        kind: "plan",
        mode: "full",
        portfolio: p,
        sourcePortfolio: p,
      })),
    };
    const text = serializeBackup(b, 1024);
    const bytes = new TextEncoder().encode(text).byteLength;
    expect(bytes).toBeGreaterThan(8_000_000);
    expect(bytes).toBeLessThanOrEqual(BACKUP_LIMIT_BYTES - 1024);
    expect(text).not.toContain("\n");
    const imported = parseBackup(text);
    expect(imported).toEqual(b);
    expect(imported.snapshots).toHaveLength(50);
    expect(imported.snapshots[49].sourcePortfolio?.assets[99].name).toBe(
      p.assets[99].name,
    );
    console.log(
      `V4 named snapshot stress: 100 assets, 50 snapshots with source portfolios, ${bytes} UTF-8 bytes`,
    );
  });
  it("accepts exactly 32 MiB, reserves 1024 bytes before export stamping, and refuses one extra byte on both paths", () => {
    const b = backup();
    b.evidence = [
      {
        id: "capacity",
        title: "容量界線",
        value: "",
        date: "2026-10-07",
        source: "",
        status: "已核對",
      },
    ];
    const baseBytes = new TextEncoder().encode(JSON.stringify(b)).byteLength;
    const payloadBytes = BACKUP_LIMIT_BYTES - baseBytes - 1024;
    // A single shared multilingual payload keeps its JS character count well
    // below the byte limit while still reaching the actual UTF-8 boundary.
    b.evidence[0].value =
      "字".repeat(Math.floor(payloadBytes / 3)) + "x".repeat(payloadBytes % 3);
    expect(() => serializeBackup(b, 1024)).not.toThrow();
    expect(() => serializeBackup(b, 1025)).toThrow("32 MiB");
    b.evidence[0].value += "x".repeat(1024);
    const exact = serializeBackup(b);
    expect(exact.length).toBeLessThan(BACKUP_LIMIT_BYTES);
    expect(new TextEncoder().encode(exact).byteLength).toBe(BACKUP_LIMIT_BYTES);
    const imported = parseBackup(exact);
    expect(imported.evidence[0].value.length).toBe(b.evidence[0].value.length);
    expect(imported.evidence[0].value).toBe(b.evidence[0].value);
    expect(() => parseBackup(exact + " ")).toThrow("32 MiB");
    b.evidence[0].value += "x";
    expect(() => serializeBackup(b)).toThrow("32 MiB");
  }, 15000);
});
