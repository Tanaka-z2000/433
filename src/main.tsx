import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  blankAsset,
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
} from "./storage";
import "./style.css";
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
function readInitial(): { data: Backup; message: string; blocked: boolean } {
  const empty: Backup = {
    version: 1,
    portfolio: initialPortfolio(),
    snapshots: [],
    evidence: [],
  };
  try {
    const raw = localStorage.getItem(KEY);
    return {
      data: raw ? parseBackup(raw) : empty,
      message: raw ? "已載入上次資料" : "資料只保存在此瀏覽器；可匯出備份。",
      blocked: false,
    };
  } catch {
    return {
      data: empty,
      message: "無法讀取既有資料。已停止自動保存，請先下載原始資料備援。",
      blocked: true,
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
  const [p, setP] = useState(initial.data.portfolio),
    [snapshots, setSnapshots] = useState<Snapshot[]>(initial.data.snapshots),
    [evidence, setEvidence] = useState<Evidence[]>(initial.data.evidence);
  const [blocked, setBlocked] = useState(initial.blocked),
    [message, setMessage] = useState(initial.message),
    [mode, setMode] = useState<Mode>("full");
  const [pending, setPending] = useState<Backup | null>(null),
    [name, setName] = useState(""),
    [shock, setShock] = useState<Record<string, number>>({});
  const [eDraft, setEDraft] = useState<Omit<Evidence, "id">>({
    title: "",
    value: "",
    date: "",
    source: "",
    status: "待核對",
  });
  const [applied, setApplied] = useState(false);
  const errors = validate(p),
    result = plan(p, mode),
    plans = (Object.keys(modes) as Mode[]).map((m) => plan(p, m));
  const total =
    p.assets.reduce((s, a) => s + a.shares * a.price, 0) +
    p.cash +
    p.settlement;
  const backup: Backup = { version: 1, portfolio: p, snapshots, evidence };
  useEffect(() => {
    if (blocked || validate(p).length) return;
    try {
      localStorage.setItem(
        KEY,
        JSON.stringify({ version: 1, portfolio: p, snapshots, evidence }),
      );
      setMessage("已自動保存在此瀏覽器");
    } catch {
      setMessage("瀏覽器保存失敗，請立即匯出 JSON 備份。");
    }
  }, [p, snapshots, evidence, blocked]);
  const update = (patch: Partial<Portfolio>) => {
    setApplied(false);
    setP((prev) => ({ ...prev, ...patch }));
  };
  const assetUpdate = (id: string, patch: Partial<Asset>) =>
    update({
      assets: p.assets.map((a) => (a.id === id ? { ...a, ...patch } : a)),
    });
  const snap = () => {
    if (errors.length) return;
    setSnapshots((s) =>
      [
        {
          id: crypto.randomUUID(),
          date: new Date().toISOString(),
          name: name.trim() || "持倉快照",
          portfolio: structuredClone(p),
        },
        ...s,
      ].slice(0, 50),
    );
    setName("");
  };
  async function importFile(file: File | undefined) {
    if (!file) return;
    try {
      if (file.size > 2_000_000) throw new Error("檔案請小於 2 MB");
      const text = await file.text();
      const data = file.name.toLowerCase().endsWith(".csv")
        ? { ...backup, portfolio: { ...p, assets: parseCSV(text) } }
        : parseBackup(text);
      const issues = validate(data.portfolio);
      if (issues.length) throw new Error(issues.join("；"));
      setPending(data);
    } catch (e) {
      setMessage(`匯入失敗：${(e as Error).message}`);
    }
  }
  const demo = () =>
    setPending({
      version: 1,
      portfolio: {
        ...initialPortfolio(),
        cash: 150000,
        settlement: -10000,
        flow: 30000,
        cashTarget: 20,
        assets: [
          {
            ...blankAsset(),
            ticker: "00662",
            kind: "core",
            shares: 1000,
            price: 100,
            target: 45,
          },
          {
            ...blankAsset(),
            ticker: "00675L",
            kind: "leverage",
            shares: 1000,
            price: 150,
            target: 35,
          },
        ],
      },
      snapshots,
      evidence,
    });
  function applyEstimate() {
    if (
      errors.length ||
      !meetsPrinciples(p, result) ||
      !result.trades.some((t) => t.quantity) ||
      applied
    )
      return;
    setSnapshots((s) =>
      [
        {
          id: crypto.randomUUID(),
          date: new Date().toISOString(),
          name: "套用估計方案前",
          portfolio: structuredClone(p),
        },
        ...s,
      ].slice(0, 50),
    );
    // Preserve signed T+2 balance; model proposed trades as settlement changes.
    setP({
      ...p,
      assets: result.trades.map((t) => ({
        ...t.asset,
        shares: t.asset.shares + t.quantity,
      })),
      cash: p.cash + p.flow,
      flow: 0,
      settlement: result.cash - (p.cash + p.flow),
    });
    setApplied(true);
    setMessage(
      "已套用估計股數與交割款，請依實際成交回報修改價格、費用差額及交割款。",
    );
  }
  return (
    <>
      <header className="top">
        <a className="brand" href="#">
          433 <span>資產再配置</span>
        </a>
        <span className="local-badge">本機資料 · TWD</span>
      </header>
      <main>
        <section className="intro">
          <div>
            <div className="eyebrow">YOUR PORTFOLIO, YOUR RULES</div>
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
        <div className="toolbar">
          <button
            onClick={() =>
              download(
                "433-backup.json",
                JSON.stringify(backup, null, 2),
                "application/json",
              )
            }
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
                setBlocked(false);
                setMessage("已重新啟用保存");
              }}
            >
              重新啟用保存
            </button>
          </div>
        )}
        {pending && (
          <section className="notice">
            <h3>確認載入資料</h3>
            <p>
              {pending.portfolio.assets.length} 個標的，現金{" "}
              {fmt(pending.portfolio.cash)} 元，交割款{" "}
              {fmt(pending.portfolio.settlement)} 元。載入會取代目前輸入。
            </p>
            <button
              className="primary"
              onClick={() => {
                setP(pending.portfolio);
                setSnapshots(pending.snapshots);
                setEvidence(pending.evidence);
                setPending(null);
                setApplied(false);
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
              onClick={() => update({ assets: [...p.assets, blankAsset()] })}
            >
              ＋ 新增標的
            </button>
          </div>
          {!p.assets.length && (
            <div className="empty">
              <h3>從你的實際持倉開始</h3>
              <p>新增標的或匯入持倉。示範資料僅供操作體驗。</p>
              <button onClick={demo}>試用示範資料</button>
            </div>
          )}
          <div className="asset-list">
            {p.assets.map((a) => (
              <article className="asset-card" key={a.id}>
                <div className="asset-head">
                  <span>{a.ticker || "新標的"}</span>
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
                  <label>
                    標的代號
                    <input
                      value={a.ticker}
                      onChange={(e) =>
                        assetUpdate(a.id, { ticker: e.target.value.trim() })
                      }
                    />
                  </label>
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
                <details>
                  <summary>交易單位與費用設定</summary>
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
                      onChange={(n) => assetUpdate(a.id, { feeRate: n! })}
                    />
                    <NumberField
                      label="每筆最低手續費"
                      value={a.minFee}
                      onChange={(n) => assetUpdate(a.id, { minFee: n! })}
                    />
                    <NumberField
                      label="賣出交易稅率 %"
                      value={a.sellTaxRate}
                      onChange={(n) => assetUpdate(a.id, { sellTaxRate: n! })}
                    />
                  </div>
                  <p className="hint">
                    預設費率為可修改的估計值，請按商品與券商確認。1
                    股表示零股，1000 股表示整張；每標的視為一筆交易。
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
          {errors.length ? (
            <div className="notice" role="alert">
              <h3>請先完成以下項目</h3>
              <ul>
                {errors.map((e) => (
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
                    <small>調後現金 {pct(r.cash, r.afterTotal)}</small>
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
                    </tr>
                  </thead>
                  <tbody>
                    {result.trades.map((t) => (
                      <tr key={t.asset.id}>
                        <td>{t.asset.ticker}</td>
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
                            : `${fmt((t.afterValue / result.afterTotal) * 100 - t.asset.target)} pp`}
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
                    applied ||
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
            輸入各 ETF
            自身的假設漲跌幅，套用於目前持倉；不含本次投入、交易與費用。不將指數長期報酬直接乘二。
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
          <div className="scenario">
            {p.assets.some(
              (a) =>
                !Number.isFinite(shock[a.id] ?? 0) || (shock[a.id] ?? 0) < -100,
            ) ? (
              "漲跌幅須為有效數字且不得低於 -100%。"
            ) : (
              <>
                情境總資產{" "}
                <strong>
                  $
                  {fmt(
                    total +
                      p.assets.reduce(
                        (s, a) =>
                          s + (a.shares * a.price * (shock[a.id] ?? 0)) / 100,
                        0,
                      ),
                  )}
                </strong>{" "}
                · 損益 $
                {fmt(
                  p.assets.reduce(
                    (s, a) =>
                      s + (a.shares * a.price * (shock[a.id] ?? 0)) / 100,
                    0,
                  ),
                )}
              </>
            )}
          </div>
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
            <button disabled={!!errors.length} onClick={snap}>
              保存目前快照
            </button>
          </div>
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
                      onClick={() =>
                        setPending({
                          ...backup,
                          portfolio: structuredClone(s.portfolio),
                        })
                      }
                    >
                      還原
                    </button>
                    <button
                      className="text-button"
                      onClick={() =>
                        setSnapshots(snapshots.filter((x) => x.id !== s.id))
                      }
                    >
                      刪除
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </section>
        <section className="panel">
          <div className="section-heading">
            <h2>
              <b>06</b> 市場觀察筆記
            </h2>
            <span>手動紀錄，未連接即時行情</span>
          </div>
          <p className="hint">
            保存晨晚報或自行查核的資料，供調整目標時參考。核對狀態由你標記，不會自動產生買賣指令。
          </p>
          <div className="field-grid">
            {(["title", "value", "date", "source"] as const).map((key, i) => (
              <label key={key}>
                {["觀察項目", "數值／摘要", "資料日期", "來源網址"][i]}
                <input
                  type={
                    key === "date" ? "date" : key === "source" ? "url" : "text"
                  }
                  value={eDraft[key]}
                  onChange={(e) =>
                    setEDraft({ ...eDraft, [key]: e.target.value })
                  }
                />
              </label>
            ))}
            <label>
              核對狀態
              <select
                value={eDraft.status}
                onChange={(e) =>
                  setEDraft({
                    ...eDraft,
                    status: e.target.value as Evidence["status"],
                  })
                }
              >
                <option>待核對</option>
                <option>已核對</option>
                <option>落後</option>
              </select>
            </label>
          </div>
          <button
            onClick={() => {
              if (
                !eDraft.title ||
                !eDraft.value ||
                !eDraft.date ||
                !/^https?:\/\//i.test(eDraft.source)
              ) {
                setMessage("市場筆記需填項目、內容、日期及 http(s) 來源網址");
                return;
              }
              setEvidence(
                [{ ...eDraft, id: crypto.randomUUID() }, ...evidence].slice(
                  0,
                  100,
                ),
              );
              setEDraft({ ...eDraft, title: "", value: "" });
            }}
          >
            新增觀察
          </button>
          <div className="evidence-list">
            {evidence.map((e) => (
              <article key={e.id}>
                <span className="tag">{e.status}</span>
                <strong>{e.title}</strong>
                <p>{e.value}</p>
                <small>
                  資料日 {e.date} ·{" "}
                  <a href={e.source} target="_blank" rel="noreferrer">
                    查看來源
                  </a>
                </small>
                <button
                  className="text-button"
                  onClick={() =>
                    setEvidence(evidence.filter((x) => x.id !== e.id))
                  }
                >
                  刪除
                </button>
              </article>
            ))}
          </div>
        </section>
        <footer>
          433 · 個人資產再配置工具
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
