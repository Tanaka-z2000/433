import { useId } from "react";
import type { Portfolio, Plan } from "./engine";
import { allocationComparison, tradeReview, actualTimeline } from "./workflow";
import type { Snapshot } from "./storage";
const fmt = (n: number | null) =>
  n === null || !Number.isFinite(n)
    ? "—"
    : n.toLocaleString("zh-TW", { maximumFractionDigits: 2 });
export function AllocationComparison({
  portfolio,
  result,
}: {
  portfolio: Portfolio;
  result: Plan | null;
}) {
  const titleId = useId();
  const rows = allocationComparison(portfolio, result);
  return (
    <section className="panel allocation-comparison" aria-labelledby={titleId}>
      <div className="section-heading">
        <h2 id={titleId}>目前 → 目標 → 試算後</h2>
        <span>分類目標由持股目標加總</span>
      </div>
      <p className="hint">
        目前比例不含本次投入／提領；試算後包含本次資金異動與交易成本。差距為「目前減目標」，單位為百分點。目標未完整時不推測比例。
      </p>
      <div className="comparison-grid">
        {rows.map((g) => (
          <article key={g.key} data-comparison={g.key}>
            <h3>{g.label}</h3>
            {(
              [
                ["目前", g.percent],
                ["目標", g.target],
                ["試算後", g.after],
              ] as const
            ).map(([label, value]) => (
              <div className="weight-row" key={label}>
                <span>{label}</span>
                <div className="weight-track" aria-hidden="true">
                  <i
                    style={{
                      width: `${Math.min(100, Math.max(0, value ?? 0))}%`,
                      background: g.color,
                    }}
                  />
                </div>
                <span>{value === null ? "—" : `${fmt(value)}%`}</span>
              </div>
            ))}
            <p>
              目前差距：
              {g.gap === null
                ? "未設定"
                : `${g.gap > 0 ? "+" : ""}${fmt(g.gap)} 個百分點`}
            </p>
          </article>
        ))}
      </div>
      {rows.some((g) =>
        [g.percent, g.after].some((v) => v !== null && (v < 0 || v > 100)),
      ) && (
        <p className="notice">
          存在負數或超過 100% 的比例；數字保留實際值，比例條僅呈現 0–100%。
        </p>
      )}
      {!result && (
        <p className="hint">試算後比例須等持倉、目標與費率通過核對才顯示。</p>
      )}
    </section>
  );
}

export function TradeReview({
  portfolio: p,
  result: r,
}: {
  portfolio: Portfolio;
  result: Plan;
}) {
  const review = tradeReview(p, r);
  return (
    <details open className="trade-review notice">
      <summary>交易前核對摘要</summary>
      <div className="review-grid">
        <span>
          原淨現金<strong>${fmt(review.openingCash)}</strong>
        </span>
        <span>
          本次投入／提領<strong>${fmt(p.flow)}</strong>
        </span>
        <span>
          賣出收入<strong>${fmt(review.sell)}</strong>
        </span>
        <span>
          買進支出<strong>${fmt(review.buy)}</strong>
        </span>
        <span>
          預估手續費<strong>${fmt(review.commission)}</strong>
        </span>
        <span>
          預估證交稅<strong>${fmt(review.tax)}</strong>
        </span>
        <span>
          預計剩餘淨現金<strong>${fmt(r.cash)}</strong>
        </span>
        <span>
          距現金下限尚缺<strong>${fmt(review.shortfall)}</strong>
        </span>
      </div>
      <p className="hint">
        剩餘淨現金＝原淨現金＋本次資金＋賣出－買進－成本，含 T+2
        應收應付，並非此刻已可提領金額。費用拆分依試算總額分攤，實際以券商成交回報為準。
      </p>
      <p>
        下單前請核對：標的與股數、輸入價格、交易單位、費率、交割資金。套用估計方案不會送出委託，也不代表已成交。
      </p>
      {review.missingDates.length > 0 && (
        <p className="hint">
          尚無價格編輯時間：{review.missingDates.join("、")}
          。價格皆由你輸入，編輯時間也不代表行情時間。
        </p>
      )}
      {p.flow < 0 && p.cash + p.flow < 0 && (
        <p className="notice">
          提領超過目前現金餘額，需先核對交割；暫不可套用此估計方案。
        </p>
      )}
    </details>
  );
}

export function SnapshotTimeline({ snapshots }: { snapshots: Snapshot[] }) {
  const rows = actualTimeline(snapshots);
  const low = Math.min(...rows.map((r) => r.total)),
    high = Math.max(...rows.map((r) => r.total));
  const point = (r: (typeof rows)[number], i: number) =>
    `${rows.length > 1 ? 30 + (i * 540) / (rows.length - 1) : 300},${high === low ? 85 : 140 - ((r.total - low) * 110) / (high - low)}`;
  return (
    <details className="snapshot-trend" open={rows.length > 1}>
      <summary>實際快照趨勢（{rows.length} 份）</summary>
      <p className="hint">
        僅納入標記為實際持倉的快照，依保存時間排序；試算、待核對及未標記的舊紀錄不納入。以下是資產金額變化，不是投資報酬；圖上相鄰點間隔不代表相同天數。
      </p>
      {rows.length === 0 ? (
        <p>保存實際持倉快照後即可查看。</p>
      ) : (
        <>
          <svg
            className="trend-chart"
            viewBox="0 0 600 175"
            role="img"
            aria-label={`實際快照總資產趨勢，共 ${rows.length} 份；由 ${fmt(rows[0].total)} 至 ${fmt(rows.at(-1)!.total)} 元`}
          >
            <path d="M30 145H570" stroke="#bdceca" />
            <polyline
              fill="none"
              stroke="#16796f"
              strokeWidth="3"
              points={rows.map(point).join(" ")}
            />
            {rows.map((r, i) => {
              const [cx, cy] = point(r, i).split(",");
              return (
                <circle key={r.id} cx={cx} cy={cy} r="4" fill="#16796f">
                  <title>
                    {r.name}：{fmt(r.total)} 元
                  </title>
                </circle>
              );
            })}
            <text x="30" y="170">
              較早快照
            </text>
            <text x="570" y="170" textAnchor="end">
              最新快照
            </text>
          </svg>
          <p>
            首末資產差額：${fmt(rows.at(-1)!.total - rows[0].total)}
            ；可能包含投入、提領、價格與持股異動。
          </p>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>保存時間（臺北）／名稱</th>
                  <th>總資產</th>
                  <th>核心</th>
                  <th>正二</th>
                  <th>其他</th>
                  <th>淨現金</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>
                      {new Date(r.date).toLocaleString("zh-TW", {
                        timeZone: "Asia/Taipei",
                      })}
                      <small className="table-security-name">{r.name}</small>
                    </td>
                    <td>${fmt(r.total)}</td>
                    {r.groups.map((g) => (
                      <td key={g.key}>
                        ${fmt(g.value)}
                        <small className="table-security-name">
                          {g.percent === null ? "—" : `${fmt(g.percent)}%`}
                        </small>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </details>
  );
}
