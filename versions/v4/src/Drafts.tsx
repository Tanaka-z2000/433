import { useEffect, useRef, useState } from "react";
import { plan, validate, type Portfolio, type Mode } from "./engine";
import { projectedPortfolio, portfolioTotal, maxDeviation } from "./analysis";
import { autoFeeProblem, type Catalog } from "./security";
import type { Snapshot } from "./storage";
import { AllocationComparison, TradeReview } from "./Workflow";
const modes: Record<Mode, string> = {
  full: "完整再平衡",
  contribute: "僅用新增資金",
  band: "容許區間調整",
};
const fmt = (n: number | null) =>
  n === null || !Number.isFinite(n)
    ? "—"
    : n.toLocaleString("zh-TW", { maximumFractionDigits: 2 });

export function Drafts({
  portfolio,
  snapshots,
  catalog,
  today,
  disabled,
  onSave,
}: {
  portfolio: Portfolio;
  snapshots: Snapshot[];
  catalog: Catalog | null;
  today: Date;
  disabled: boolean;
  onSave: (snapshot: Snapshot) => boolean;
}) {
  const [draft, setDraft] = useState<Portfolio | null>(null);
  const [source, setSource] = useState("");
  const [mode, setMode] = useState<Mode>("full");
  const [name, setName] = useState("");
  const [notice, setNotice] = useState("");
  const editor = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (draft) {
      editor.current?.focus({ preventScroll: true });
      editor.current?.scrollIntoView({ block: "start" });
    }
  }, [source]);
  const saved = snapshots.filter(
    (s) => s.kind === "plan" && s.sourcePortfolio && s.mode,
  );
  const issues = draft
    ? [
        ...validate(draft),
        ...draft.assets
          .map((a) => autoFeeProblem(a, catalog, today))
          .filter(Boolean),
      ]
    : [];
  const result = draft && !issues.length ? plan(draft, mode) : null;
  function open(p: Portfolio, label: string, selected: Mode, title: string) {
    setDraft(structuredClone(p));
    setSource(label + " · " + new Date().toISOString());
    setMode(selected);
    setName(title);
    setNotice("");
  }
  function close() {
    if (confirm("關閉尚未保存的草稿？目前持倉與已存方案都會保留。"))
      setDraft(null);
  }
  return (
    <div className="drafts">
      <h3>試算草稿工作區</h3>
      <p className="hint">
        在獨立草稿調整投入／提領、目標與模式，不會改動目前持倉。保存後列入原有
        50 份快照額度，並隨 JSON 備份保留。
      </p>
      <button
        disabled={disabled || !!validate(portfolio).length}
        onClick={() => {
          if (!draft || confirm("以目前持倉另開草稿？尚未保存的草稿將被取代。"))
            open(portfolio, "來自目前持倉", "full", "");
        }}
      >
        從目前持倉建立草稿
      </button>
      {notice && <p role="status">{notice}</p>}
      {draft && (
        <section className="draft-editor notice" aria-label="獨立試算草稿">
          <h3 ref={editor} tabIndex={-1}>
            編輯獨立草稿
          </h3>
          <p>{source}</p>
          <p className="hint">
            草稿使用建立時的股數、價格與費率；目前持倉之後變動不會自動同步。尚未保存的草稿只留在本頁，重新整理會消失。不同價格或來源的草稿不能視為相同條件的績效比較。
          </p>
          <div className="field-grid">
            <label>
              草稿名稱
              <input
                maxLength={120}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label>
              草稿模式
              <select
                aria-label="草稿模式"
                value={mode}
                onChange={(e) => setMode(e.target.value as Mode)}
              >
                {Object.entries(modes).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              草稿投入／提領
              <input
                type="number"
                value={Number.isFinite(draft.flow) ? draft.flow : ""}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    flow: e.target.value === "" ? NaN : Number(e.target.value),
                  })
                }
              />
            </label>
            <label>
              草稿現金目標 %
              <input
                type="number"
                value={draft.cashTarget ?? ""}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    cashTarget:
                      e.target.value === "" ? null : Number(e.target.value),
                  })
                }
              />
            </label>
            {draft.assets.map((a) => (
              <label key={a.id}>
                {a.ticker} 草稿目標 %
                <input
                  type="number"
                  value={a.target ?? ""}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      assets: draft.assets.map((x) =>
                        x.id === a.id
                          ? {
                              ...x,
                              target:
                                e.target.value === ""
                                  ? null
                                  : Number(e.target.value),
                            }
                          : x,
                      ),
                    })
                  }
                />
              </label>
            ))}
          </div>
          {!!issues.length && <p role="status">{issues.join("；")}</p>}
          {result && (
            <>
              <AllocationComparison portfolio={draft} result={result} />
              <TradeReview portfolio={draft} result={result} />
              <p>
                試算後最大偏差：{fmt(maxDeviation(draft, result))} 個百分點。
                {result.notes.join(" ")}
              </p>
            </>
          )}
          <div className="toolbar">
            <button
              disabled={!result || disabled || draft.cash + draft.flow < 0}
              onClick={() => {
                if (!result || disabled || draft.cash + draft.flow < 0) return;
                if (
                  onSave({
                    id: crypto.randomUUID(),
                    date: new Date().toISOString(),
                    name: name.trim() || `草稿：${modes[mode]}`,
                    kind: "plan",
                    sourcePortfolio: structuredClone(draft),
                    portfolio: projectedPortfolio(draft, result),
                    mode,
                  })
                ) {
                  setDraft(null);
                  setNotice(
                    "草稿已加入方案清單；目前持倉沒有變更。請查看本機保存狀態。",
                  );
                }
              }}
            >
              保存草稿方案
            </button>
            <button onClick={close}>關閉草稿</button>
          </div>
        </section>
      )}
      {!!saved.length && (
        <div className="table-scroll">
          <table className="draft-comparison">
            <thead>
              <tr>
                <th>已存方案</th>
                <th>來源資產</th>
                <th>投入／提領</th>
                <th>試算後資產</th>
                <th>試算後淨現金</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {saved.map((s) => (
                <tr key={s.id}>
                  <td>
                    {s.name}
                    <small className="table-security-name">
                      {modes[s.mode!]}
                    </small>
                  </td>
                  <td>${fmt(portfolioTotal(s.sourcePortfolio!))}</td>
                  <td>${fmt(s.sourcePortfolio!.flow)}</td>
                  <td>${fmt(portfolioTotal(s.portfolio))}</td>
                  <td>${fmt(s.portfolio.cash + s.portfolio.settlement)}</td>
                  <td>
                    <button
                      disabled={disabled}
                      onClick={() => {
                        if (
                          !draft ||
                          confirm(
                            "開啟這份方案的來源？尚未保存的草稿將被取代。",
                          )
                        )
                          open(
                            s.sourcePortfolio!,
                            `來自方案：${s.name}`,
                            s.mode!,
                            `${s.name} 副本`,
                          );
                      }}
                    >
                      以此方案另開草稿
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
