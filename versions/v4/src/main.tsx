import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  blankAsset,
  standardFees,
  initialPortfolio,
  meetsPrinciples,
  plan,
  validate,
  type Asset,
  type Portfolio,
  type Mode,
} from "./engine";
import {
  KEY,
  parseBackup,
  parseCSV,
  download,
  assetsCSV,
  tradesCSV,
  type Backup,
  type Snapshot,
  type Evidence,
  SNAPSHOT_LIMIT,
  backupContent,
  digestContent,
  storageSize,
  BACKUP_LIMIT_BYTES,
  serializeBackup,
} from "./storage";
import "./style.css";
import { SecurityPicker } from "./SecurityPicker";
import {
  autoFeeProblem,
  feePreset,
  findByTicker,
  isCatalogStale,
  loadCatalog,
  selectSecurity,
  securityTypeLabel,
  type Catalog,
} from "./security";
import { usePersistence } from "./persistence";
import {
  portfolioTotal,
  projectedPortfolio,
  maxDeviation,
  scenarioComparison,
  compareHoldings,
  tradeExplanation,
} from "./analysis";
const temporary =
  new URLSearchParams(location.search).get("mode") === "temporary";
const recordLabels = {
  actual: "實際持倉",
  estimate: "待成交核對",
  plan: "試算方案",
  legacy: "既有快照（未標記）",
};
const dateText = (value?: string) =>
  value
    ? new Date(value).toLocaleString("zh-TW", { timeZone: "Asia/Taipei" }) +
      " 臺北"
    : "未記錄";
const fmt = (n: number) =>
  Number.isFinite(n)
    ? n.toLocaleString("zh-TW", { maximumFractionDigits: 2 })
    : "—";
const pct = (n: number, d: number) => (d > 0 ? `${fmt((n / d) * 100)}%` : "—");
const modes: Record<Mode, string> = {
  full: "完整再平衡",
  contribute: "僅用新增資金",
  band: "容許區間調整",
};
function readInitial(): {
  data: Backup;
  message: string;
  blocked: boolean;
  raw: string | null;
} {
  const empty: Backup = {
    version: 3,
    portfolio: initialPortfolio(),
    snapshots: [],
    evidence: [],
  };
  if (temporary)
    return {
      data: empty,
      message: "暫用模式不載入既有持倉。離開前請自行匯出需要保留的資料。",
      blocked: false,
      raw: null,
    };
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
    return {
      data: raw ? parseBackup(raw) : empty,
      message: raw ? "已載入上次資料" : "資料只保存在此瀏覽器；可匯出備份。",
      blocked: false,
      raw,
    };
  } catch {
    return {
      data: empty,
      message: "無法讀取既有資料。已停止自動保存，請先下載原始資料備援。",
      blocked: true,
      raw,
    };
  }
}
function NumberField({
  label,
  value,
  onChange,
  optional = false,
  step = "any",
}: {
  label: string;
  value: number | null;
  onChange: (n: number | null) => void;
  optional?: boolean;
  step?: string;
}) {
  return (
    <label>
      {label}
      <input
        type="number"
        step={step}
        value={value === null || !Number.isFinite(value) ? "" : value}
        placeholder={optional ? "未設定" : "0"}
        onChange={(e) =>
          onChange(
            e.target.value === ""
              ? optional
                ? null
                : NaN
              : Number(e.target.value),
          )
        }
      />
    </label>
  );
}
function App() {
  const [initial] = useState(readInitial);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [catalogError, setCatalogError] = useState("");
  const [catalogAttempt, setCatalogAttempt] = useState(0);
  // Recheck date-limited rules while the page is kept open across midnight.
  const [today, setToday] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setToday(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setCatalogError("");
    void loadCatalog(controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setCatalog(data);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setCatalogError(
            "官方名錄載入失敗，仍可手動輸入；依商品預設的費率需等名錄重新核對。",
          );
      });
    return () => controller.abort();
  }, [catalogAttempt]);
  const [p, setP] = useState(initial.data.portfolio),
    [snapshots, setSnapshots] = useState<Snapshot[]>(initial.data.snapshots),
    // Retain legacy notes in backups without exposing the removed feature.
    [evidence, setEvidence] = useState<Evidence[]>(initial.data.evidence);
  const [message, setMessage] = useState(initial.message),
    [mode, setMode] = useState<Mode>("full");
  const [pending, setPending] = useState<Backup | null>(null),
    [name, setName] = useState(""),
    [shock, setShock] = useState<Record<string, number>>({});
  const [recordState, setRecordState] = useState<"actual" | "estimate">(
    initial.data.state ?? "actual",
  );
  const [beforeEstimate, setBeforeEstimate] = useState(
    initial.data.beforeEstimate,
  );
  const [exported, setExported] = useState(initial.data.exported);
  const [digest, setDigest] = useState("");
  const [importSource, setImportSource] = useState("");
  const importSequence = useRef(0);
  const manualFeeSelections = useRef(new Set<string>());
  const [compareA, setCompareA] = useState("");
  const [compareB, setCompareB] = useState("current");
  const errors = useMemo(() => validate(p), [p]);
  const feeIssues = useMemo(
    () =>
      p.assets
        .map((a) => autoFeeProblem(a, catalog, today))
        .filter((issue): issue is string => !!issue),
    [p.assets, catalog, today],
  );
  const planIssues = [...errors, ...feeIssues];
  const plans = useMemo(
    () => (Object.keys(modes) as Mode[]).map((m) => plan(p, m)),
    [p],
  );
  const result = plans.find((r) => r.mode === mode)!;
  const total = portfolioTotal(p);
  const backup = useMemo<Backup>(
    () => ({
      version: 3,
      portfolio: p,
      snapshots,
      evidence,
      state: recordState,
      beforeEstimate,
      exported,
    }),
    [p, snapshots, evidence, recordState, beforeEstimate, exported],
  );
  const serialized = useMemo(() => JSON.stringify(backup), [backup]);
  const coreContent = useMemo(() => backupContent(backup), [backup]);
  const persistence = usePersistence(
    serialized,
    errors.length === 0,
    temporary,
    initial.raw,
    initial.blocked,
  );
  const { blocked } = persistence;
  useEffect(() => {
    let active = true;
    setDigest("");
    if (!exported) return;
    const timer = setTimeout(() => {
      void digestContent(coreContent)
        .then((value) => {
          if (active) setDigest(value);
        })
        .catch(() => {
          if (active) setDigest("unavailable");
        });
    }, 650);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [coreContent, exported]);
  const update = (patch: Partial<Portfolio>) =>
    setP((prev) => ({ ...prev, ...patch }));
  const assetUpdate = (id: string, patch: Partial<Asset>) => {
    if (
      patch.feeMode === "manual" &&
      ["feeRate", "minFee", "sellTaxRate"].some((key) => key in patch)
    )
      manualFeeSelections.current.add(id);
    update({
      assets: p.assets.map((a) =>
        a.id === id
          ? {
              ...a,
              ...patch,
              ...("price" in patch
                ? { priceUpdatedAt: new Date().toISOString() }
                : {}),
            }
          : a,
      ),
    });
  };
  const addSnapshot = (snapshot: Snapshot, changes: Partial<Backup> = {}) => {
    if (snapshots.length >= SNAPSHOT_LIMIT) {
      setMessage(
        "快照已達 50 份，請先匯出備份並自行刪除不需要的紀錄；未刪除任何舊快照。",
      );
      return false;
    }
    try {
      // Leave space for the export timestamp and digest before duplicating data.
      serializeBackup(
        { ...backup, ...changes, snapshots: [snapshot, ...snapshots] },
        1024,
      );
    } catch (error) {
      setMessage((error as Error).message);
      return false;
    }
    setSnapshots((s) => [snapshot, ...s]);
    return true;
  };
  const snap = () => {
    if (errors.length) return;
    if (
      addSnapshot({
        id: crypto.randomUUID(),
        date: new Date().toISOString(),
        name: name.trim() || "持倉快照",
        portfolio: structuredClone(p),
        kind: recordState,
        sourcePortfolio: beforeEstimate,
      })
    ) {
      setName("");
      setMessage("已新增快照；請查看上方保存狀態。");
    }
  };
  async function exportBackup() {
    try {
      const stamp = {
        at: new Date().toISOString(),
        digest: await digestContent(coreContent),
      };
      download(
        `433-v4-${stamp.at.slice(0, 10)}.json`,
        serializeBackup({ ...backup, exported: stamp }),
        "application/json",
      );
      setExported(stamp);
      setMessage("已發起 JSON 匯出，請確認瀏覽器下載完成並妥善保管檔案。");
    } catch (error) {
      setMessage(`匯出失敗：${(error as Error).message}`);
    }
  }
  const savePlan = () => {
    if (planIssues.length || recordState === "estimate" || p.cash + p.flow < 0)
      return;
    if (
      addSnapshot({
        id: crypto.randomUUID(),
        date: new Date().toISOString(),
        name: name.trim() || modes[mode],
        kind: "plan",
        portfolio: projectedPortfolio(p, result),
        sourcePortfolio: structuredClone(p),
        mode,
      })
    ) {
      setName("");
      setMessage("已保存試算方案與原始價格、費率；目前持倉未改動。");
    }
  };
  const scenario = planIssues.length
    ? null
    : scenarioComparison(p, result, shock);
  const from = snapshots.find((s) => s.id === compareA);
  const to =
    compareB === "current"
      ? p
      : snapshots.find((s) => s.id === compareB)?.portfolio;
  const targetSum =
    (p.cashTarget ?? 0) + p.assets.reduce((sum, a) => sum + (a.target ?? 0), 0);
  async function importFile(file: File | undefined) {
    if (!file) return;
    const sequence = ++importSequence.current;
    setPending(null);
    try {
      const csv = file.name.toLowerCase().endsWith(".csv");
      if (file.size > (csv ? 8_000_000 : BACKUP_LIMIT_BYTES))
        throw new Error(csv ? "CSV 檔案請小於 8 MB" : "JSON 檔案請小於 32 MiB");
      const text = await file.text();
      if (sequence !== importSequence.current) return;
      const data = file.name.toLowerCase().endsWith(".csv")
        ? { ...backup, portfolio: { ...p, assets: parseCSV(text) } }
        : parseBackup(text);
      const issues = validate(data.portfolio);
      if (issues.length) throw new Error(issues.join("；"));
      setImportSource(
        `${file.name} · ${file.name.toLowerCase().endsWith(".csv") ? "CSV 持倉（保留現金與快照）" : `備份格式 V${JSON.parse(text).version}`}`,
      );
      setPending(data);
    } catch (e) {
      if (sequence === importSequence.current)
        setMessage(`匯入失敗：${(e as Error).message}`);
    }
  }
  const demo = () => {
    importSequence.current++;
    setImportSource("示範資料，非你的實際持倉");
    const demoIdentity = (asset: Asset): Asset => {
      const security = catalog && findByTicker(catalog, asset.ticker);
      return security
        ? {
            ...asset,
            ...selectSecurity(
              { ...asset, feeMode: "manual" },
              security,
              false,
              today,
            ),
          }
        : { ...asset, feeMode: "manual" };
    };
    setPending({
      version: 3,
      portfolio: {
        ...initialPortfolio(),
        cash: 150000,
        settlement: -10000,
        flow: 30000,
        cashTarget: 20,
        assets: [
          demoIdentity({
            ...blankAsset(),
            ticker: "00662",
            ...standardFees("equityETF"),
            kind: "core",
            shares: 1000,
            price: 100,
            target: 45,
          }),
          demoIdentity({
            ...blankAsset(),
            ticker: "00675L",
            ...standardFees("equityETF"),
            kind: "leverage",
            shares: 1000,
            price: 150,
            target: 35,
          }),
        ],
      },
      snapshots,
      evidence,
    });
  };
  function applyEstimate() {
    if (
      planIssues.length ||
      recordState === "estimate" ||
      !meetsPrinciples(p, result) ||
      p.cash + p.flow < 0 ||
      !result.trades.some((t) => t.quantity)
    )
      return;
    if (
      !addSnapshot(
        {
          id: crypto.randomUUID(),
          date: new Date().toISOString(),
          name: "套用估計方案前",
          kind: "actual",
          portfolio: structuredClone(p),
        },
        {
          portfolio: projectedPortfolio(p, result),
          beforeEstimate: p,
          state: "estimate",
        },
      )
    )
      return;
    setBeforeEstimate(structuredClone(p));
    setP(projectedPortfolio(p, result));
    setRecordState("estimate");
    setMessage(
      "已套用估計值，請依成交回報核對股數、現金、交割款與費用後，再標記為已核對。",
    );
  }
  return (
    <>
      <header className="top">
        <a className="brand" href="#">
          433 <span>資產再配置</span>
        </a>
        <span className="local-badge">
          V4 台股標的版 · {temporary ? "暫用" : "本機"} · TWD
        </span>
      </header>
      <main>
        <section className="intro">
          <div>
            <div className="eyebrow">V4 TAIWAN SECURITIES</div>
            <h1>
              讓每一次調整，
              <br />
              都有清楚的依據。
            </h1>
            <p>
              持有 00662、台股正二，現金至少一成。
              <br />
              比例由你決定，交易限制與資金交給工具核對。
            </p>
          </div>
          <div className="intro-note">
            <span>配置原則</span>
            <strong>
              彈性權重
              <br />
              <em>10%+</em> 現金下限
            </strong>
            <small>未設定目標時，只檢查現況。</small>
          </div>
        </section>
        <p className="market-scope">
          暫時僅適用台股投資人，以新臺幣試算台灣市場股票與
          ETF；在臺掛牌、追蹤海外資產的 ETF 亦適用。
        </p>
        <div className="toolbar">
          <button
            onClick={() => void exportBackup()}
            disabled={!!errors.length}
          >
            匯出 JSON 備份
          </button>
          <label className="button">
            匯入 JSON／CSV
            <input
              type="file"
              accept=".json,.csv"
              hidden
              onChange={(e) => {
                void importFile(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </label>
          <button
            onClick={() =>
              download(
                "433-holdings.csv",
                assetsCSV(p.assets),
                "text/csv;charset=utf-8",
              )
            }
          >
            匯出持倉 CSV
          </button>
          <button onClick={demo}>載入示範</button>
        </div>
        <aside className="storage-panel" aria-label="資料保存狀態">
          <p role="status">{persistence.status}</p>
          <div className="storage-facts">
            <span>目前內容約 {storageSize(serialized)}</span>
            <span>
              瀏覽器已存約{" "}
              {persistence.saved ? storageSize(persistence.saved) : "0 KB"}
            </span>
            <span>快照 {snapshots.length} / 50</span>
          </div>
          <small>
            容量為文字大小估算，非磁碟用量或剩餘額度。資料只在此瀏覽器，不會自動同步。
          </small>
          <p>
            最近匯出：{dateText(exported?.at)} ·{" "}
            {exported
              ? !digest
                ? "核對中"
                : digest === exported.digest
                  ? "內容與最近匯出相同"
                  : "目前內容尚未匯出"
              : "尚未匯出備份"}
          </p>
          <div className="toolbar">
            {!temporary && !blocked && (
              <button onClick={persistence.retry}>立即重試保存</button>
            )}
            <a href={temporary ? "./" : "?mode=temporary"}>
              {temporary ? "返回一般模式" : "進入暫用模式"}
            </a>
          </div>
          {temporary && (
            <p>
              暫用模式不讀寫既有資料，重新整理會清空這次內容；無法防止公用電腦側錄。
            </p>
          )}
        </aside>
        {recordState === "estimate" && (
          <div className="notice" role="alert">
            <h3>待成交核對</h3>
            <p>
              目前畫面是估計持倉；重新開啟仍保留此標記。請依實際成交結果修正股數、現金與交割款。
            </p>
            <div className="toolbar">
              <button
                disabled={!!errors.length}
                onClick={() => {
                  if (
                    confirm("已依成交回報核對股數、現金、交割款與費用差額？")
                  ) {
                    setRecordState("actual");
                    setBeforeEstimate(undefined);
                    setMessage("已由你標記為實際持倉；工具沒有連線券商驗證。");
                  }
                }}
              >
                已核對成交，標記為實際持倉
              </button>
              {beforeEstimate && (
                <button
                  onClick={() => {
                    if (confirm("回到套用前持倉？目前核對中的修改將被取代。")) {
                      setP(beforeEstimate);
                      setBeforeEstimate(undefined);
                      setRecordState("actual");
                    }
                  }}
                >
                  回到套用前
                </button>
              )}
            </div>
          </div>
        )}
        <p role="status" className="status">
          {message}
          {errors.length > 0 && !blocked
            ? " · 輸入未完整，尚未保存這次變更。"
            : ""}
        </p>
        {blocked && (
          <div className="notice">
            <button
              onClick={() => {
                try {
                  download(
                    "433-recovery.txt",
                    localStorage.getItem(KEY) || "無可讀資料",
                    "text/plain",
                  );
                } catch {
                  setMessage("瀏覽器拒絕存取資料，無法讀取原始備援。");
                }
              }}
            >
              下載原始資料
            </button>
            <button
              onClick={() => {
                if (
                  confirm(
                    "這會允許目前畫面覆寫 V4 的既有資料。請先匯出備援，確定繼續？",
                  )
                )
                  persistence.replaceDamaged();
              }}
            >
              以目前內容重新啟用保存
            </button>
          </div>
        )}
        {pending && (
          <section className="notice">
            <h3>匯入預覽／確認載入資料</h3>
            <p>{importSource}</p>
            <p>
              快照 {pending.snapshots.length} 份 · 最近匯出{" "}
              {dateText(pending.exported?.at)} · 載入後狀態：
              {pending.state === "estimate" ? "待成交核對" : "使用者持倉"}
            </p>
            <p>
              {pending.portfolio.assets.length} 個標的，現金{" "}
              {fmt(pending.portfolio.cash)} 元，交割款{" "}
              {fmt(pending.portfolio.settlement)} 元。載入會取代 V4
              目前輸入與清單，V1、V2、V3 資料不受影響。建議先匯出目前內容。
            </p>
            <button
              className="primary"
              onClick={() => {
                setP(pending.portfolio);
                setSnapshots(pending.snapshots);
                setEvidence(pending.evidence);
                setPending(null);
                setRecordState(pending.state ?? "actual");
                setBeforeEstimate(pending.beforeEstimate);
                setExported(pending.exported);
                setShock({});
                setMessage("已載入資料，請查看保存狀態。");
              }}
            >
              確認載入
            </button>{" "}
            <button onClick={() => setPending(null)}>取消</button>
          </section>
        )}
        <section className="summary">
          <div>
            <span>目前總資產</span>
            <strong>${fmt(total)}</strong>
            <small>持倉＋現金＋交割款</small>
          </div>
          <div>
            <span>淨現金（含 T+2）</span>
            <strong>${fmt(p.cash + p.settlement)}</strong>
            <small>目前占比 {pct(p.cash + p.settlement, total)}</small>
          </div>
          <div>
            <span>本次投入／提領後</span>
            <strong>${fmt(total + p.flow)}</strong>
            <small>正數投入 · 負數提領</small>
          </div>
        </section>
        <section className="panel">
          <div className="section-heading">
            <h2>
              <b>01</b> 現金與本次目標
            </h2>
            <span>所有金額均為新臺幣</span>
          </div>
          <div className="field-grid">
            <NumberField
              label="現金餘額"
              value={p.cash}
              onChange={(n) => update({ cash: n! })}
            />
            <NumberField
              label="交割款（T+2，正收負付）"
              value={p.settlement}
              onChange={(n) => update({ settlement: n! })}
            />
            <NumberField
              label="本次投入／提領（正投負提）"
              value={p.flow}
              onChange={(n) => update({ flow: n! })}
            />
            <NumberField
              label="現金下限 %"
              value={p.cashFloor}
              onChange={(n) => update({ cashFloor: n! })}
            />
            <NumberField
              label="本次現金目標 %"
              optional
              value={p.cashTarget}
              onChange={(n) => update({ cashTarget: n })}
            />
            <NumberField
              label="容許偏差（百分點）"
              value={p.tolerance}
              onChange={(n) => update({ tolerance: n! })}
            />
          </div>
          <p className="hint">
            交割款尚未反映於現金餘額：應收填正數、應付填負數；完成交割後更新餘額並清除對應交割款。方案採交割後淨額試算，不代表盤中可用額度。
          </p>
          <p className="target-status">
            目標合計 {fmt(targetSum)}% ·{" "}
            {p.cashTarget === null && p.assets.every((a) => a.target === null)
              ? "未設定，僅檢查現況"
              : targetSum <= 100
                ? `尚差 ${fmt(100 - targetSum)} 個百分點`
                : `超出 ${fmt(targetSum - 100)} 個百分點`}
          </p>
          <button
            className="text-button"
            onClick={() =>
              update({
                cashTarget: null,
                assets: p.assets.map((a) => ({ ...a, target: null })),
              })
            }
          >
            清除所有目標，僅檢查現況
          </button>
        </section>
        <section className="panel">
          <div className="section-heading">
            <h2>
              <b>02</b> 持倉與交易限制
            </h2>
            <button
              disabled={p.assets.length >= 100}
              onClick={() => update({ assets: [...p.assets, blankAsset()] })}
            >
              ＋ 新增標的
            </button>
          </div>
          <aside className="catalog-panel" aria-label="官方標的名錄">
            {catalog ? (
              <>
                <p>
                  臺灣證券交易所名錄 · 出表日 {catalog.asOf} · 收錄{" "}
                  {catalog.securities.length.toLocaleString("zh-TW")} 個標的
                </p>
                <small>
                  網站擷取時間：{dateText(catalog.fetchedAt)}
                  。名稱與商品類型取自證交所公開資料；不代表即時行情或券商費率。
                </small>
                {isCatalogStale(catalog, today) && (
                  <p className="notice">
                    名錄已超過 45
                    天，暫停新的自動費率帶入。名稱仍供參考，請自行核對費率或等候名錄更新。
                  </p>
                )}
              </>
            ) : (
              <p role="status">{catalogError || "正在載入官方標的名錄…"}</p>
            )}
            {catalogError && (
              <button onClick={() => setCatalogAttempt((n) => n + 1)}>
                重試載入名錄
              </button>
            )}
            <p>
              僅收錄已核對的證交所上市資料。搜尋在此瀏覽器完成，不傳送查詢或持倉；查無結果可能是上櫃、新掛牌或尚未收錄。
            </p>
            <a
              href="https://www.twse.com.tw/zh/"
              target="_blank"
              rel="noreferrer"
            >
              臺灣證券交易所
            </a>
            {catalog && (
              <details>
                <summary>查看官方來源與各資料日期</summary>
                <ul>
                  {catalog.sources.map((source) => (
                    <li key={source.id}>
                      <a href={source.url} target="_blank" rel="noreferrer">
                        {source.id}
                      </a>{" "}
                      · 出表日 {source.asOf} · 原始資料{" "}
                      {source.rows.toLocaleString("zh-TW")} 筆
                    </li>
                  ))}
                </ul>
                <p>
                  名錄日期採來源中較早的出表日；收錄筆數可能因市場篩選與去重而不同。
                </p>
              </details>
            )}
          </aside>
          {!p.assets.length && (
            <div className="empty">
              <h3>從你的實際持倉開始</h3>
              <p>新增標的或匯入持倉。示範資料僅供操作體驗。</p>
              <button onClick={demo}>試用示範資料</button>
            </div>
          )}
          {!!p.assets.length && (
            <details className="quick-prices">
              <summary>快速更新價格</summary>
              <p className="hint">
                價格由你輸入，時間代表輸入時間，並非行情來源時間。
              </p>
              <div className="field-grid">
                {p.assets.map((a) => (
                  <NumberField
                    key={a.id}
                    label={`${a.ticker || "新標的"} 快速價格`}
                    value={a.price}
                    onChange={(n) => assetUpdate(a.id, { price: n! })}
                  />
                ))}
              </div>
            </details>
          )}
          <div className="asset-list">
            {p.assets.map((a) => (
              <article className="asset-card" key={a.id}>
                <div className="asset-head">
                  <span>
                    {a.ticker || "新標的"}
                    {a.name && (
                      <small className="security-name">{a.name}</small>
                    )}
                  </span>
                  <button
                    className="text-button danger"
                    aria-label={`移除 ${a.ticker || "新標的"}`}
                    onClick={() =>
                      update({ assets: p.assets.filter((x) => x.id !== a.id) })
                    }
                  >
                    移除
                  </button>
                </div>
                <div className="asset-fields">
                  <SecurityPicker
                    asset={a}
                    catalog={catalog}
                    allowInitialFees={!manualFeeSelections.current.has(a.id)}
                    onChange={(patch) => assetUpdate(a.id, patch)}
                  />
                  <label>
                    分類
                    <select
                      value={a.kind}
                      onChange={(e) =>
                        assetUpdate(a.id, {
                          kind: e.target.value as Asset["kind"],
                        })
                      }
                    >
                      <option value="core">核心</option>
                      <option value="leverage">台股正二</option>
                      <option value="other">其他</option>
                    </select>
                  </label>
                  <NumberField
                    label="持有股數"
                    step="1"
                    value={a.shares}
                    onChange={(n) => assetUpdate(a.id, { shares: n! })}
                  />
                  <NumberField
                    label="試算價格"
                    value={a.price}
                    onChange={(n) => assetUpdate(a.id, { price: n! })}
                  />
                  <NumberField
                    label="本次目標 %"
                    optional
                    value={a.target}
                    onChange={(n) => assetUpdate(a.id, { target: n })}
                  />
                  <label>
                    交易限制
                    <select
                      value={a.limit}
                      onChange={(e) =>
                        assetUpdate(a.id, {
                          limit: e.target.value as Asset["limit"],
                        })
                      }
                    >
                      <option value="free">允許買賣</option>
                      <option value="buyOnly">不能賣，可買進</option>
                      <option value="frozen">完全不動</option>
                    </select>
                  </label>
                </div>
                <div className="asset-footer">
                  <span>
                    目前市值 <strong>${fmt(a.shares * a.price)}</strong>
                  </span>
                  <span>占總資產 {pct(a.shares * a.price, total)}</span>
                </div>
                <p className="hint">
                  價格輸入時間：{dateText(a.priceUpdatedAt)}
                  <br />
                  手續費 {a.feeRate}% · 最低 {fmt(a.minFee)} 元 · 賣出稅{" "}
                  {fmt(a.sellTaxRate)}% · 每次 {a.lot} 股
                  <br />
                  費率來源：{a.feeMode === "auto" ? "依商品預設" : "手動設定"}
                  {a.securityType && ` · ${securityTypeLabel(a.securityType)}`}
                  {a.securityAsOf && ` · 官方資料日 ${a.securityAsOf}`}
                  {a.taxValidUntil && ` · 稅率適用至 ${a.taxValidUntil}`}
                </p>
                {autoFeeProblem(a, catalog, today) && (
                  <p className="notice" role="alert">
                    {autoFeeProblem(a, catalog, today)}{" "}
                    請重新套用有效商品預設，或核對費率後明確改為手動。
                  </p>
                )}
                {(a.securityType === "bondETF" ||
                  a.securityType === "unsupported") && (
                  <p className="hint">
                    此商品未提供自動費率，請自行核對證交稅、減免條件與券商手續費；目前數值保留原設定。
                  </p>
                )}
                <div className="toolbar security-actions">
                  <button
                    disabled={
                      !catalog ||
                      isCatalogStale(catalog, today) ||
                      !findByTicker(catalog, a.ticker) ||
                      !feePreset(findByTicker(catalog, a.ticker)!, today)
                    }
                    onClick={() => {
                      const security =
                        catalog && findByTicker(catalog, a.ticker);
                      if (
                        security &&
                        !isCatalogStale(catalog!, today) &&
                        feePreset(security, today)
                      )
                        assetUpdate(
                          a.id,
                          selectSecurity(a, security, true, today),
                        );
                    }}
                  >
                    套用此商品預設
                  </button>
                  {a.feeMode === "auto" && (
                    <button
                      onClick={() =>
                        assetUpdate(a.id, {
                          feeMode: "manual",
                          feeRuleId: undefined,
                          taxValidUntil: undefined,
                        })
                      }
                    >
                      已核對費率，改為手動
                    </button>
                  )}
                </div>
                <details>
                  <summary>交易單位與費用設定</summary>
                  <div className="toolbar">
                    <button
                      onClick={() =>
                        assetUpdate(a.id, {
                          ...standardFees("stock"),
                          feeMode: "manual",
                          feeRuleId: undefined,
                          taxValidUntil: undefined,
                        })
                      }
                    >
                      套用台股股票標準費率
                    </button>
                    <button
                      onClick={() =>
                        assetUpdate(a.id, {
                          ...standardFees("equityETF"),
                          feeMode: "manual",
                          feeRuleId: undefined,
                          taxValidUntil: undefined,
                        })
                      }
                    >
                      套用股票型 ETF 費率
                    </button>
                  </div>
                  <div className="field-grid">
                    <NumberField
                      label="交易單位（股）"
                      step="1"
                      value={a.lot}
                      onChange={(n) => assetUpdate(a.id, { lot: n! })}
                    />
                    <NumberField
                      label="手續費率 %"
                      value={a.feeRate}
                      onChange={(n) =>
                        assetUpdate(a.id, {
                          feeRate: n!,
                          feeMode: "manual",
                          feeRuleId: undefined,
                          taxValidUntil: undefined,
                        })
                      }
                    />
                    <NumberField
                      label="每筆最低手續費"
                      value={a.minFee}
                      onChange={(n) =>
                        assetUpdate(a.id, {
                          minFee: n!,
                          feeMode: "manual",
                          feeRuleId: undefined,
                          taxValidUntil: undefined,
                        })
                      }
                    />
                    <NumberField
                      label="賣出交易稅率 %"
                      value={a.sellTaxRate}
                      onChange={(n) =>
                        assetUpdate(a.id, {
                          sellTaxRate: n!,
                          feeMode: "manual",
                          feeRuleId: undefined,
                          taxValidUntil: undefined,
                        })
                      }
                    />
                  </div>
                  <p className="hint">
                    未折扣手續費為成交金額的 0.1425%（買賣皆收），最低手續費預設
                    0 元。 證交稅僅賣出收取：一般股票 0.3%，股票型 ETF（含
                    00662、台股正二）0.1%。新標的首次從有效官方名錄選定時可帶入對應預設；已使用商品預設者更換標的時會依新商品更新費率，尚未核對前暫停試算。舊版匯入及手動費率保留原值，按「套用此商品預設」才重設。
                    已核對的槓桿、反向及其他 ETF 賣出稅率亦為 0.1%。債券 ETF
                    與特殊商品暫不自動設定費率，請自行核對減免條件；不含當沖優惠及券商折扣。
                    1 股表示零股，1000 股表示整張；每標的視為一筆交易。
                  </p>
                </details>
              </article>
            ))}
          </div>
        </section>
        <section className="panel results">
          <div className="section-heading">
            <h2>
              <b>03</b> 調整方案
            </h2>
            <span>目標比例不會自動正規化</span>
          </div>
          {planIssues.length ? (
            <div className="notice" role="alert">
              <h3>請先完成以下項目</h3>
              <ul>
                {planIssues.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </div>
          ) : (
            <>
              <div className="plan-grid">
                {plans.map((r) => (
                  <button
                    className={`plan-card ${r.mode === mode ? "selected" : ""}`}
                    key={r.mode}
                    onClick={() => setMode(r.mode)}
                  >
                    <strong>{modes[r.mode]}</strong>
                    <span>
                      {r.trades.filter((t) => t.quantity).length} 筆調整 · 費用
                      ${fmt(r.cost)}
                    </span>
                    <small>
                      買進 $
                      {fmt(
                        r.trades.reduce(
                          (sum, t) => sum + Math.max(t.gross, 0),
                          0,
                        ),
                      )}{" "}
                      · 賣出 $
                      {fmt(
                        r.trades.reduce(
                          (sum, t) => sum + Math.max(-t.gross, 0),
                          0,
                        ),
                      )}
                    </small>
                    <small>
                      調後現金 ${fmt(r.cash)}（{pct(r.cash, r.afterTotal)}）
                    </small>
                    <small>
                      最大目標偏差{" "}
                      {maxDeviation(p, r) === null
                        ? "未設定"
                        : `${fmt(maxDeviation(p, r)!)} 個百分點`}
                    </small>
                    <small>
                      {meetsPrinciples(p, r)
                        ? "符合持有原則與現金下限"
                        : "有原則或現金缺口，請核對"}
                    </small>
                  </button>
                ))}
              </div>
              <p className="hint">
                {mode === "band"
                  ? "只調整超出容許區間的部位，向區間邊界靠攏；不保證全域最少交易。"
                  : mode === "contribute"
                    ? "不賣出；含費用買進額不超過本次正投入，並保留現金下限。"
                    : "先賣超額，再按目標缺口由大到小買進，依資金與交易單位取整。"}{" "}
                所有價格與成本均為估計。
              </p>
              <div className="result-metrics">
                <div>
                  調後總資產<strong>${fmt(result.afterTotal)}</strong>
                </div>
                <div>
                  調後淨現金<strong>${fmt(result.cash)}</strong>
                </div>
                <div>
                  預估交易成本<strong>${fmt(result.cost)}</strong>
                </div>
              </div>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>標的</th>
                      <th>建議股數</th>
                      <th>估計金額</th>
                      <th>費用</th>
                      <th>調後占比</th>
                      <th>目標差距</th>
                      <th>計算依據</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.trades.map((t) => (
                      <tr key={t.asset.id}>
                        <td>
                          {t.asset.ticker}
                          {t.asset.name && (
                            <small className="security-name table-security-name">
                              {t.asset.name}
                            </small>
                          )}
                        </td>
                        <td
                          className={
                            t.quantity > 0
                              ? "buy"
                              : t.quantity < 0
                                ? "sell"
                                : ""
                          }
                        >
                          {t.quantity > 0
                            ? "買進 "
                            : t.quantity < 0
                              ? "賣出 "
                              : "維持 "}
                          {fmt(Math.abs(t.quantity))}
                        </td>
                        <td>${fmt(Math.abs(t.gross))}</td>
                        <td>${fmt(t.cost)}</td>
                        <td>{pct(t.afterValue, result.afterTotal)}</td>
                        <td>
                          {t.asset.target === null
                            ? "未設定"
                            : `${fmt((t.afterValue / result.afterTotal) * 100 - t.asset.target)} 個百分點`}
                        </td>
                        <td className="explanation">
                          {tradeExplanation(p, result, t.asset.ticker)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className={result.notes.length ? "notice" : "success"}>
                {result.notes.length ? (
                  <ul>
                    {result.notes.map((n) => (
                      <li key={n}>{n}</li>
                    ))}
                  </ul>
                ) : (
                  "此估計方案符合持有原則與現金下限，標的偏差在容許範圍內。"
                )}
              </div>
              <div className="toolbar">
                <button
                  onClick={savePlan}
                  disabled={
                    recordState === "estimate" ||
                    p.cash + p.flow < 0 ||
                    snapshots.length >= SNAPSHOT_LIMIT
                  }
                >
                  保存選定試算方案
                </button>
                <button
                  onClick={() =>
                    download(
                      "433-trades.csv",
                      tradesCSV(result),
                      "text/csv;charset=utf-8",
                    )
                  }
                >
                  匯出方案 CSV
                </button>
                <button
                  disabled={
                    recordState === "estimate" ||
                    snapshots.length >= SNAPSHOT_LIMIT ||
                    p.cash + p.flow < 0 ||
                    !result.trades.some((t) => t.quantity) ||
                    !meetsPrinciples(p, result)
                  }
                  onClick={applyEstimate}
                >
                  套用估計方案供核對
                </button>
              </div>
              <p className="hint">
                符合持有原則與現金下限的方案才可套用；提領大於現金餘額時請先自行核對交割。套用不會下單。會先保存原始快照，更新估計股數與
                T+2 交割款，投入／提領歸零；實際成交後請核對股數、現金及交割款。
              </p>
            </>
          )}
        </section>
        <section className="panel">
          <div className="section-heading">
            <h2>
              <b>04</b> 情境試算
            </h2>
            <span>手動假設 · 非報酬預測</span>
          </div>
          <p className="hint">
            兩組配置都包含本次投入／提領；調整後另外扣除交易費用。下列漲跌幅是各標的自身的假設，不將指數多日報酬直接乘二。現金與交割款在情境中不變。
          </p>
          <div className="field-grid">
            {p.assets.map((a) => (
              <NumberField
                key={a.id}
                label={`${a.ticker || "標的"} 漲跌 %`}
                value={shock[a.id] ?? 0}
                onChange={(n) => setShock({ ...shock, [a.id]: n! })}
              />
            ))}
          </div>
          {!scenario ? (
            <p className="notice">
              請先完成有效持倉、目標與費率核對；漲跌幅須為有效數字且不得低於
              -100%。
            </p>
          ) : (
            <div className="table-scroll scenario-table">
              <table>
                <thead>
                  <tr>
                    <th>比較項目</th>
                    <th>維持目前配置</th>
                    <th>採用{modes[mode]}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>情境前資產</td>
                    <td>${fmt(scenario.beforeBase)}</td>
                    <td>${fmt(scenario.afterBase)}</td>
                  </tr>
                  <tr>
                    <td>假設漲跌造成的損益</td>
                    <td>${fmt(scenario.beforeChange)}</td>
                    <td>${fmt(scenario.afterChange)}</td>
                  </tr>
                  <tr>
                    <td>情境後總資產</td>
                    <td>${fmt(scenario.beforeTotal)}</td>
                    <td>${fmt(scenario.afterTotal)}</td>
                  </tr>
                  <tr>
                    <td>現金比率</td>
                    <td>
                      {pct(
                        p.cash + p.settlement + p.flow,
                        scenario.beforeTotal,
                      )}
                    </td>
                    <td>{pct(result.cash, scenario.afterTotal)}</td>
                  </tr>
                </tbody>
              </table>
              <p className="hint">
                調整後與維持配置的情境總資產差額：$
                {fmt(scenario.afterTotal - scenario.beforeTotal)}
                （已反映交易費用）。此為情境試算，非預期投資報酬或下單建議。
              </p>
            </div>
          )}
        </section>
        <section className="panel">
          <div className="section-heading">
            <h2>
              <b>05</b> 歷史快照
            </h2>
            <span>最多保留 50 份</span>
          </div>
          <div className="toolbar">
            <input
              aria-label="快照名稱"
              placeholder="例如：十月配置調整前"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <button
              disabled={!!errors.length || snapshots.length >= SNAPSHOT_LIMIT}
              onClick={snap}
            >
              保存目前快照
            </button>
          </div>
          {snapshots.length >= 45 && (
            <p className="notice">
              已使用 {snapshots.length} / 50
              份快照。達到上限將停止新增，不自動刪除；請先匯出並整理紀錄。
            </p>
          )}
          {!!snapshots.length && (
            <details open className="snapshot-comparison">
              <summary>比較快照差異</summary>
              <div className="field-grid">
                <label>
                  比較起點
                  <select
                    aria-label="比較起點"
                    value={compareA}
                    onChange={(e) => setCompareA(e.target.value)}
                  >
                    <option value="">選擇一份快照</option>
                    {snapshots.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name} · {recordLabels[s.kind ?? "legacy"]}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  比較終點
                  <select
                    aria-label="比較終點"
                    value={compareB}
                    onChange={(e) => setCompareB(e.target.value)}
                  >
                    <option value="current">
                      目前畫面 · {recordLabels[recordState]}
                    </option>
                    {snapshots.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name} · {recordLabels[s.kind ?? "legacy"]}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {from && to && (
                <>
                  <p>
                    總資產差額 $
                    {fmt(portfolioTotal(to) - portfolioTotal(from.portfolio))} ·
                    現金差額 ${fmt(to.cash - from.portfolio.cash)} · 交割款差額
                    ${fmt(to.settlement - from.portfolio.settlement)} ·
                    本次投入／提領欄位差額 ${fmt(to.flow - from.portfolio.flow)}
                  </p>
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>標的</th>
                          <th>股數：起點 → 終點</th>
                          <th>價格：起點 → 終點</th>
                          <th>市值差額</th>
                        </tr>
                      </thead>
                      <tbody>
                        {compareHoldings(from.portfolio, to).map((row) => (
                          <tr key={row.ticker}>
                            <td>
                              {row.ticker}
                              <small className="security-name table-security-name">
                                {to.assets.find((a) => a.ticker === row.ticker)
                                  ?.name ??
                                  from.portfolio.assets.find(
                                    (a) => a.ticker === row.ticker,
                                  )?.name}
                              </small>
                            </td>
                            <td>
                              {fmt(row.oldShares)} → {fmt(row.newShares)}
                            </td>
                            <td>
                              {row.oldPrice === null
                                ? "無持倉"
                                : fmt(row.oldPrice)}{" "}
                              →{" "}
                              {row.newPrice === null
                                ? "無持倉"
                                : fmt(row.newPrice)}
                            </td>
                            <td>${fmt(row.valueChange)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
              <p className="hint">
                差額包含價格、股數與現金異動，不是投資報酬；投入／提領欄位也不代表期間完整現金流。
              </p>
            </details>
          )}
          {!snapshots.length ? (
            <p className="hint">
              保存後可還原輸入；資產差額包含投入、提領與價格變化，不是投資報酬。
            </p>
          ) : (
            <div className="snapshot-list">
              {snapshots.map((s) => {
                const v =
                  s.portfolio.assets.reduce(
                    (n, a) => n + a.shares * a.price,
                    0,
                  ) +
                  s.portfolio.cash +
                  s.portfolio.settlement;
                return (
                  <div key={s.id}>
                    <span>
                      <strong>{s.name}</strong>
                      <small>
                        {recordLabels[s.kind ?? "legacy"]}
                        {s.mode ? ` · ${modes[s.mode]}` : ""}
                      </small>
                      <small>
                        {new Date(s.date).toLocaleString("zh-TW", {
                          timeZone: "Asia/Taipei",
                        })}{" "}
                        臺北
                      </small>
                    </span>
                    <span>
                      ${fmt(v)}
                      <small>目前差額 ${fmt(total - v)}</small>
                    </span>
                    <button
                      onClick={() => {
                        importSequence.current++;
                        setImportSource(
                          `還原快照：${s.name} · ${recordLabels[s.kind ?? "legacy"]}`,
                        );
                        setPending({
                          ...backup,
                          portfolio: structuredClone(s.portfolio),
                          state:
                            s.kind === "plan" || s.kind === "estimate"
                              ? "estimate"
                              : "actual",
                          beforeEstimate: s.sourcePortfolio,
                        });
                      }}
                    >
                      還原
                    </button>
                    <button
                      className="text-button"
                      onClick={() => {
                        if (confirm(`刪除「${s.name}」？建議先匯出備份。`))
                          setSnapshots(snapshots.filter((x) => x.id !== s.id));
                      }}
                    >
                      刪除
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </section>
        <footer>
          433 · V4 台股標的版 · 4.0.0
          <br />
          <span>
            資料保存在目前瀏覽器，不上傳持倉。定期匯出備份，以便更換裝置。
          </span>
        </footer>
      </main>
    </>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
