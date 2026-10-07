import type { Portfolio } from "./engine";
import { assetAllocation } from "./assetAllocation";

const number = (n: number | null) =>
  n === null ? "—" : n.toLocaleString("zh-TW", { maximumFractionDigits: 2 });
export function Allocation({
  portfolio: p,
  estimated,
}: {
  portfolio: Portfolio;
  estimated: boolean;
}) {
  const allocation = assetAllocation(p);
  let offset = 0;
  const notice =
    allocation.total === null
      ? "估值資料未完整：請檢查現金、交割款、股數與價格，暫不顯示佔比。"
      : allocation.total <= 0
        ? "目前總資產為零或負數，暫無可呈現的資產佔比。"
        : !allocation.chartable
          ? "交割後淨現金為負，以下保留實際負數佔比；證券佔比可能超過 100%，不繪製圓環。"
          : "";
  return (
    <section className="panel allocation" aria-labelledby="allocation-title">
      <div className="section-heading">
        <h2 id="allocation-title">資產佔比</h2>
        <span>{estimated ? "待成交核對的估計持倉" : "目前持倉"} · TWD</span>
      </div>
      <p className="hint">
        依你設定的持股分類，以股數 ×
        輸入價格計算；台股正二以持有市值計入，不將市值乘二。本次投入／提領不計入目前佔比。點選分類可查看明細。
      </p>
      <div className="allocation-layout">
        <div className="allocation-visual">
          {allocation.chartable ? (
            <svg
              className="allocation-donut"
              viewBox="0 0 160 160"
              role="img"
              aria-label={
                "資產佔比：" +
                allocation.groups
                  .map((g) => `${g.label} ${number(g.percent)}%`)
                  .join("、")
              }
            >
              {allocation.groups.map((g) => {
                const start = offset;
                offset += g.percent!;
                return (
                  g.percent! > 0 && (
                    <circle
                      key={g.key}
                      cx="80"
                      cy="80"
                      r="60"
                      fill="none"
                      stroke={g.color}
                      strokeWidth="20"
                      pathLength="100"
                      strokeDasharray={`${g.percent} ${100 - g.percent!}`}
                      strokeDashoffset={-start}
                      transform="rotate(-90 80 80)"
                    />
                  )
                );
              })}
              <text x="80" y="77" textAnchor="middle" className="donut-label">
                目前總資產
              </text>
              <text
                x="80"
                y="94"
                textAnchor="middle"
                className="donut-currency"
              >
                TWD
              </text>
            </svg>
          ) : (
            <div className="allocation-placeholder" aria-hidden="true">
              資產概覽
            </div>
          )}
          <p className="allocation-total">${number(allocation.total)}</p>
          {notice && (
            <p className="allocation-note" role="status">
              {notice}
            </p>
          )}
        </div>
        <div className="allocation-breakdown">
          {allocation.groups.map((g) => (
            <details
              key={g.key}
              className="allocation-group"
              data-group={g.key}
            >
              <summary>
                <span className="allocation-label">
                  <i style={{ backgroundColor: g.color }} aria-hidden="true" />
                  {g.label}
                </span>
                <span className="allocation-amount">${number(g.value)}</span>
                <span className="allocation-percent">
                  {g.percent === null ? "—" : `${number(g.percent)}%`}
                </span>
              </summary>
              {g.key === "cash" ? (
                <dl className="allocation-items">
                  <div>
                    <dt>現金餘額</dt>
                    <dd>${number(Number.isFinite(p.cash) ? p.cash : null)}</dd>
                  </div>
                  <div>
                    <dt>交割款（T+2，正收負付）</dt>
                    <dd>
                      $
                      {number(
                        Number.isFinite(p.settlement) ? p.settlement : null,
                      )}
                    </dd>
                  </div>
                </dl>
              ) : (
                <ul className="allocation-items">
                  {p.assets
                    .filter((a) => a.kind === g.key)
                    .map((a) => (
                      <li key={a.id}>
                        <span>
                          {a.ticker || "未填代號"}
                          {a.name ? ` · ${a.name}` : ""}
                        </span>
                        <span>
                          $
                          {number(
                            allocation.total === null
                              ? null
                              : a.shares * a.price,
                          )}
                        </span>
                      </li>
                    ))}
                  {!p.assets.some((a) => a.kind === g.key) && (
                    <li>尚無此類持股</li>
                  )}
                </ul>
              )}
            </details>
          ))}
          <p className="hint">
            現金含尚未反映於餘額的 T+2
            應收／應付。百分比四捨五入後合計可能略有差異。
          </p>
        </div>
      </div>
    </section>
  );
}
