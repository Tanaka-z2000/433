import { afterEach, describe, expect, it, vi } from "vitest";
import { blankAsset, type Asset } from "./engine";
import {
  autoFeeProblem,
  exactNameMatches,
  feePreset,
  findByTicker,
  isCatalogStale,
  loadCatalog,
  parseCatalog,
  searchSecurities,
  selectSecurity,
  taipeiDate,
  type Catalog,
  type Security,
} from "./security";

const today = new Date("2026-10-07T12:00:00Z");
const stock: Security = {
  ticker: "2330",
  name: "台灣積體電路製造股份有限公司",
  shortName: "台積電",
  type: "stock",
  market: "TWSE",
  currency: "TWD",
  asOf: "2026-10-07",
  sourceIds: ["company"],
};
const etf: Security = {
  ...stock,
  ticker: "00662",
  name: "富邦NASDAQ-100證券投資信託基金",
  shortName: "富邦NASDAQ",
  type: "equityETF",
};
const catalog = (): Catalog => ({
  schemaVersion: 1,
  asOf: "2026-10-07",
  fetchedAt: "2026-10-07T08:00:00.000Z",
  sources: [
    {
      id: "company",
      url: "https://mopsfin.twse.com.tw/opendata/t187ap03_L.csv",
      asOf: "2026-10-07",
      sha256: "a".repeat(64),
      rows: 2,
    },
  ],
  securities: structuredClone([stock, etf]),
});
const parsed = (c: Catalog) => parseCatalog(JSON.stringify(c));
const selected = (s: Security = etf): Asset => ({
  ...blankAsset(),
  ...selectSecurity(blankAsset(), s, false, today),
});

describe("verified product defaults preserve explicit user decisions", () => {
  it("uses standard ordinary-share and equity ETF defaults with zero minimum commission", () => {
    expect(feePreset(stock, today)).toMatchObject({
      feeRate: 0.1425,
      minFee: 0,
      sellTaxRate: 0.3,
    });
    expect(feePreset(etf, today)).toMatchObject({
      feeRate: 0.1425,
      minFee: 0,
      sellTaxRate: 0.1,
    });
    expect(feePreset(stock, today)?.feeRuleId).not.toBe(
      feePreset(etf, today)?.feeRuleId,
    );
    for (const s of [stock, etf]) {
      const a = selected(s);
      expect(a).toMatchObject({
        ticker: s.ticker,
        name: s.name,
        shortName: s.shortName,
        feeMode: "auto",
        securityType: s.type,
        securityAsOf: s.asOf,
      });
      expect(autoFeeProblem(a, catalog(), today)).toBeNull();
    }
  });
  it("keeps custom or migrated fees until the user explicitly requests defaults", () => {
    for (const feeMode of [undefined, "manual"] as const) {
      const original: Asset = {
        ...blankAsset(),
        ticker: "2330",
        feeMode,
        feeRate: 0.0285,
        minFee: 12,
        sellTaxRate: 0.3,
        feeRuleId: "old-rule",
        taxValidUntil: "2026-01-01",
      };
      const a = { ...original, ...selectSecurity(original, etf, false, today) };
      expect(a).toMatchObject({
        ticker: "00662",
        name: etf.name,
        feeMode: "manual",
        feeRate: 0.0285,
        minFee: 12,
        sellTaxRate: 0.3,
      });
      expect(a.feeRuleId).toBeUndefined();
      expect(a.taxValidUntil).toBeUndefined();
      expect(autoFeeProblem(a, null, today)).toBeNull();
      const reset = { ...a, ...selectSecurity(a, etf, true, today) };
      expect(reset).toMatchObject({
        feeMode: "auto",
        feeRate: 0.1425,
        minFee: 0,
        sellTaxRate: 0.1,
      });
      expect(autoFeeProblem(reset, catalog(), today)).toBeNull();
    }
  });
  it("does not erase an explicit manual choice even when the new row has an empty ticker", () => {
    const a = {
      ...blankAsset(),
      feeMode: "manual" as const,
      feeRate: 0.0285,
      minFee: 8,
    };
    expect({ ...a, ...selectSecurity(a, etf, false, today) }).toMatchObject({
      feeMode: "manual",
      feeRate: 0.0285,
      minFee: 8,
    });
  });
  it.each(["bondETF", "unsupported"] as const)(
    "keeps an automatic setting blocked for %s until manual fees are confirmed",
    (type) => {
      const s = { ...etf, type };
      expect(feePreset(s, today)).toBeNull();
      const a = selected();
      const changed = { ...a, ...selectSecurity(a, s, true, today) };
      expect(changed).toMatchObject({
        securityType: type,
        feeMode: "auto",
      });
      expect(autoFeeProblem(changed, catalog(), today)).not.toBeNull();
      expect(selectSecurity(blankAsset(), s, false, today).feeMode).toBe(
        "manual",
      );
    },
  );
  it("applies the ETF sale tax to officially classified leveraged/inverse and other taxable ETFs", () => {
    const other = {
      ...etf,
      ticker: "00675L",
      name: "富邦臺灣加權正2證券投資信託基金",
      shortName: "富邦臺灣加權正2",
      type: "otherETF" as const,
    };
    const c = catalog();
    c.securities.push(other);
    expect(feePreset(other, today)).toMatchObject({
      feeRate: 0.1425,
      minFee: 0,
      sellTaxRate: 0.1,
    });
    const a = selected(other);
    expect(a).toMatchObject({
      feeMode: "auto",
      securityType: "otherETF",
      sellTaxRate: 0.1,
    });
    expect(autoFeeProblem(a, c, today)).toBeNull();
  });
  it.each(["USD", "JPY", "", "twd"])(
    "does not apply TWD defaults to the unrecognized/foreign currency %j",
    (currency) => {
      expect(feePreset({ ...etf, currency }, today)).toBeNull();
      expect(
        selectSecurity(selected(), { ...etf, currency }, true, today).feeMode,
      ).toBe("auto");
      expect(
        selectSecurity(blankAsset(), { ...etf, currency }, true, today).feeMode,
      ).toBe("manual");
    },
  );
  it("does not apply listing defaults outside TWSE", () => {
    expect(
      feePreset({ ...stock, market: "OTC" } as unknown as Security, today),
    ).toBeNull();
  });
});

describe("automatic fees remain verifiable across catalog updates and Taipei day boundaries", () => {
  it("accepts older selection dates after an unchanged product is published in a newer catalog", () => {
    const a = { ...selected(), securityAsOf: "2026-09-30" };
    expect(autoFeeProblem(a, catalog(), today)).toBeNull();
  });
  it.each([
    { name: "名稱已更改" },
    { securityType: "stock" },
    { ticker: "999999" },
    { feeRuleId: "different-rule" },
    { feeRate: 0.03 },
    { minFee: 20 },
    { sellTaxRate: 0.3 },
  ])(
    "blocks automatic fees after identity, rule or value divergence: %j",
    (patch) => {
      expect(
        autoFeeProblem({ ...selected(), ...patch } as Asset, catalog(), today),
      ).not.toBeNull();
    },
  );
  it("requires an available, fresh official catalog for automatic fees", () => {
    expect(autoFeeProblem(selected(), null, today)).not.toBeNull();
    const c = catalog();
    c.asOf = "2026-08-22";
    expect(isCatalogStale(c, today)).toBe(true);
    expect(autoFeeProblem(selected(), c, today)).not.toBeNull();
  });
  it("expires at the configured Taipei midnight rather than UTC midnight", () => {
    const a = { ...selected(), taxValidUntil: "2026-10-07" };
    expect(taipeiDate(new Date("2026-10-07T15:59:59.999Z"))).toBe("2026-10-07");
    expect(taipeiDate(new Date("2026-10-07T16:00:00.000Z"))).toBe("2026-10-08");
    expect(
      autoFeeProblem(a, catalog(), new Date("2026-10-07T15:59:59.999Z")),
    ).toBeNull();
    expect(
      autoFeeProblem(a, catalog(), new Date("2026-10-07T16:00:00.000Z")),
    ).toContain("到期");
  });
  it("accepts age 45 days but marks age 46 days stale using Taipei calendar days", () => {
    const c = catalog();
    c.asOf = "2026-08-23";
    c.sources[0].asOf = "2026-08-23";
    expect(isCatalogStale(c, new Date("2026-10-07T15:59:59Z"))).toBe(false);
    expect(isCatalogStale(c, new Date("2026-10-07T16:00:00Z"))).toBe(true);
  });
  it("rejects future dates even when only a newer source in a mixed catalog is from the future", () => {
    const c = catalog();
    c.sources.push({ ...c.sources[0], id: "fund", asOf: "2026-10-08" });
    c.securities[1].sourceIds = ["fund"];
    c.securities[1].asOf = "2026-10-08";
    c.fetchedAt = "2026-10-08T08:00:00.000Z";
    const future = parsed(c);
    expect(isCatalogStale(future, new Date("2026-10-07T15:59:59Z"))).toBe(true);
    expect(
      autoFeeProblem(
        selected(future.securities[1]),
        future,
        new Date("2026-10-07T15:59:59Z"),
      ),
    ).not.toBeNull();
    expect(isCatalogStale(future, new Date("2026-10-07T16:00:00Z"))).toBe(
      false,
    );
    const whollyFuture = catalog();
    whollyFuture.asOf = "2026-10-08";
    expect(isCatalogStale(whollyFuture, today)).toBe(true);
  });
});

describe("local search ranks exact matches and keeps ambiguous names explicit", () => {
  it("normalizes full-width text, case and surrounding spaces without changing leading zeros", () => {
    const c = parsed(catalog());
    expect(findByTicker(c, " ００６６２ ")?.ticker).toBe("00662");
    expect(findByTicker(c, "662")).toBeUndefined();
    expect(exactNameMatches(c, " 富邦ｎａｓｄａｑ ")).toHaveLength(1);
    expect(searchSecurities(c, " ｎａｓｄａｑ ")[0].ticker).toBe("00662");
    expect(searchSecurities(c, "不存在")).toEqual([]);
    expect(searchSecurities(c, "   ")).toEqual([]);
    expect(searchSecurities(c, "字".repeat(301))).toEqual([]);
  });
  it("returns every exact name collision without quietly picking the first product", () => {
    const c = catalog();
    c.securities.push({
      ...stock,
      ticker: "2331",
      name: "同名公司的另一個商品",
      shortName: stock.shortName,
    });
    expect(exactNameMatches(c, stock.shortName).map((s) => s.ticker)).toEqual([
      "2330",
      "2331",
    ]);
    expect(exactNameMatches(c, stock.name).map((s) => s.ticker)).toEqual([
      "2330",
    ]);
    expect(searchSecurities(c, stock.shortName).map((s) => s.ticker)).toEqual([
      "2330",
      "2331",
    ]);
  });
  it("deduplicates products whose full and short names are identical and ranks exact tickers before name matches", () => {
    const c = catalog();
    c.securities.push({
      ...stock,
      ticker: "2331",
      name: "00662",
      shortName: "00662",
    });
    expect(exactNameMatches(c, "00662")).toHaveLength(1);
    expect(searchSecurities(c, "00662").map((s) => s.ticker)).toEqual([
      "00662",
      "2331",
    ]);
    expect(searchSecurities(c, "00662", 1).map((s) => s.ticker)).toEqual([
      "00662",
    ]);
    expect(searchSecurities(c, "00662", 0)).toEqual([]);
    expect(searchSecurities(c, "00662", -1)).toEqual([]);
  });
});

describe("catalog validation rejects malformed boundaries before search", () => {
  it.each([
    [
      "schema version",
      (c: Catalog) => {
        (c as unknown as Record<string, unknown>).schemaVersion = "1";
      },
    ],
    [
      "invalid leap date",
      (c: Catalog) => {
        c.asOf = "2026-02-29";
      },
    ],
    [
      "fetched date",
      (c: Catalog) => {
        c.fetchedAt = "invalid";
      },
    ],
    [
      "missing sources",
      (c: Catalog) => {
        c.sources = [];
      },
    ],
    [
      "excess sources",
      (c: Catalog) => {
        c.sources = Array.from({ length: 11 }, (_, i) => ({
          ...c.sources[0],
          id: String(i),
        }));
      },
    ],
    [
      "duplicate source",
      (c: Catalog) => {
        c.sources.push(c.sources[0]);
      },
    ],
    [
      "source control characters",
      (c: Catalog) => {
        c.sources[0].id = "source\n";
      },
    ],
    [
      "source id length",
      (c: Catalog) => {
        c.sources[0].id = "x".repeat(81);
      },
    ],
    [
      "source date",
      (c: Catalog) => {
        c.sources[0].asOf = "2026-04-31";
      },
    ],
    [
      "source zero rows",
      (c: Catalog) => {
        c.sources[0].rows = 0;
      },
    ],
    [
      "source fractional rows",
      (c: Catalog) => {
        c.sources[0].rows = 1.5;
      },
    ],
    [
      "source unsafe rows",
      (c: Catalog) => {
        c.sources[0].rows = Number.MAX_SAFE_INTEGER + 1;
      },
    ],
    [
      "source hash",
      (c: Catalog) => {
        c.sources[0].sha256 = "z".repeat(64);
      },
    ],
    [
      "unapproved host",
      (c: Catalog) => {
        c.sources[0].url =
          "https://mopsfin.twse.com.tw.evil.example/opendata/t187ap03_L.csv";
      },
    ],
    [
      "insecure source",
      (c: Catalog) => {
        c.sources[0].url = "http://mopsfin.twse.com.tw/opendata/t187ap03_L.csv";
      },
    ],
    [
      "relative source",
      (c: Catalog) => {
        c.sources[0].url = "/opendata/t187ap03_L.csv";
      },
    ],
    [
      "inconsistent aggregate date",
      (c: Catalog) => {
        c.asOf = "2026-10-06";
      },
    ],
    [
      "empty products",
      (c: Catalog) => {
        c.securities = [];
      },
    ],
    [
      "duplicate ticker",
      (c: Catalog) => {
        c.securities.push(c.securities[0]);
      },
    ],
    [
      "lowercase ticker",
      (c: Catalog) => {
        c.securities[0].ticker = "00631l";
      },
    ],
    [
      "short ticker",
      (c: Catalog) => {
        c.securities[0].ticker = "233";
      },
    ],
    [
      "long ticker",
      (c: Catalog) => {
        c.securities[0].ticker = "0".repeat(9);
      },
    ],
    [
      "blank name",
      (c: Catalog) => {
        c.securities[0].name = " ";
      },
    ],
    [
      "long name",
      (c: Catalog) => {
        c.securities[0].name = "名".repeat(301);
      },
    ],
    [
      "long short name",
      (c: Catalog) => {
        c.securities[0].shortName = "名".repeat(101);
      },
    ],
    [
      "product control characters",
      (c: Catalog) => {
        c.securities[0].name = "名稱\u0000";
      },
    ],
    [
      "unknown type",
      (c: Catalog) => {
        (c.securities[0] as unknown as Record<string, unknown>).type = "ETF";
      },
    ],
    [
      "unknown market",
      (c: Catalog) => {
        (c.securities[0] as unknown as Record<string, unknown>).market = "OTC";
      },
    ],
    [
      "blank currency",
      (c: Catalog) => {
        c.securities[0].currency = " ";
      },
    ],
    [
      "long currency",
      (c: Catalog) => {
        c.securities[0].currency = "X".repeat(21);
      },
    ],
    [
      "unknown source reference",
      (c: Catalog) => {
        c.securities[0].sourceIds = ["missing"];
      },
    ],
    [
      "empty source references",
      (c: Catalog) => {
        c.securities[0].sourceIds = [];
      },
    ],
    [
      "source dates disagree with product",
      (c: Catalog) => {
        c.securities[0].asOf = "2026-10-08";
      },
    ],
    [
      "fetched before a source was published",
      (c: Catalog) => {
        c.fetchedAt = "2026-10-06T15:59:59Z";
      },
    ],
  ])("rejects %s", (_name, mutate) => {
    const c = catalog();
    (mutate as (c: Catalog) => void)(c);
    expect(() => parsed(c)).toThrow();
  });
  it("accepts maximum field lengths and an as-of date formed from the oldest referenced source", () => {
    const c = catalog();
    c.securities[0].name = "名".repeat(300);
    c.securities[0].shortName = "名".repeat(100);
    c.sources.push({ ...c.sources[0], id: "fund", asOf: "2026-10-06" });
    c.asOf = "2026-10-06";
    c.securities[0].sourceIds = [...c.securities[0].sourceIds, "fund"];
    c.securities[0].asOf = "2026-10-06";
    expect(parsed(c)).toEqual(c);
  });
  it("rejects malformed JSON, null and oversized input without attempting an index", () => {
    for (const text of ["null", "[]", "{}", "{", " ".repeat(5_000_001)])
      expect(() => parseCatalog(text)).toThrow();
  });
  it("validates 10,000 products and repeatedly returns bounded deterministic local search results", () => {
    const c = catalog();
    c.sources[0].rows = 10_000;
    c.securities = Array.from({ length: 10_000 }, (_, i) => ({
      ...stock,
      ticker: String(100_000 + i),
      name: `壓力測試普通股名稱 ${i}`,
      shortName: `壓力標的 ${i}`,
    }));
    const start = performance.now();
    const valid = parsed(c);
    for (let i = 0; i < 100; i++) {
      const ticker = String(100_000 + i * 99);
      expect(findByTicker(valid, ticker)?.ticker).toBe(ticker);
      expect(searchSecurities(valid, ticker, 30)[0].ticker).toBe(ticker);
      expect(
        exactNameMatches(valid, `壓力測試普通股名稱 ${i * 99}`)[0].ticker,
      ).toBe(ticker);
      const broad = searchSecurities(valid, "壓力", 100_000);
      expect(broad).toHaveLength(30);
      expect(broad[0].ticker).toBe("100000");
      expect(broad[29].ticker).toBe("100029");
    }
    console.log(
      `V4 catalog stress: 10,000 records; 400 searches; ${Math.round(performance.now() - start)} ms`,
    );
    c.securities.push({ ...stock, ticker: "999999" });
    expect(() => parsed(c)).toThrow();
  }, 15000);
});

describe("same-origin catalog loading fails safely and remains cancellable", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  const documentStub = () =>
    vi.stubGlobal("document", {
      baseURI: "https://tanaka-z2000.github.io/433/versions/v4/",
    });
  const hangingFetch = () =>
    vi.fn(
      (_input: unknown, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init.signal!;
          const cancelled = () =>
            reject(new DOMException("Cancelled", "AbortError"));
          if (signal.aborted) cancelled();
          else signal.addEventListener("abort", cancelled, { once: true });
        }),
    );
  it("requests only the hosted static file, without cookies, redirects or holding queries", async () => {
    documentStub();
    vi.useFakeTimers();
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify(catalog()), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetcher);
    expect(await loadCatalog()).toEqual(catalog());
    expect(fetcher).toHaveBeenCalledTimes(1);
    const call = (fetcher.mock.calls as unknown as [URL, RequestInit][])[0];
    expect(call[0].href).toBe(
      "https://tanaka-z2000.github.io/433/data/twse-securities.json",
    );
    expect(call[0].search).toBe("");
    expect(call[1]).toMatchObject({ credentials: "omit", redirect: "error" });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("rejects an unsuccessful response and reports that manual input remains available", async () => {
    documentStub();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response("temporarily unavailable", { status: 503 }),
      ),
    );
    await expect(loadCatalog()).rejects.toThrow("可繼續手動輸入");
  });
  it("rejects an oversized declared file before reading its contents", async () => {
    documentStub();
    const read = vi.fn(async () => JSON.stringify(catalog()));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        headers: new Headers({ "content-length": "5000001" }),
        text: read,
      })),
    );
    await expect(loadCatalog()).rejects.toThrow("過大");
    expect(read).not.toHaveBeenCalled();
  });
  it("rejects oversized contents even when the server omits its length", async () => {
    documentStub();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(" ".repeat(5_000_001))),
    );
    await expect(loadCatalog()).rejects.toThrow("過大");
  });
  it("times out a hung catalog request after ten seconds and releases its timer", async () => {
    documentStub();
    vi.useFakeTimers();
    vi.stubGlobal("fetch", hangingFetch());
    const result = expect(loadCatalog()).rejects.toMatchObject({
      name: "AbortError",
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await result;
    expect(vi.getTimerCount()).toBe(0);
  });
  it("stops loading when the caller cancels and handles a signal cancelled before loading", async () => {
    documentStub();
    vi.useFakeTimers();
    vi.stubGlobal("fetch", hangingFetch());
    const controller = new AbortController();
    const result = expect(loadCatalog(controller.signal)).rejects.toMatchObject(
      { name: "AbortError" },
    );
    controller.abort();
    await result;
    expect(vi.getTimerCount()).toBe(0);
    await expect(loadCatalog(controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});
