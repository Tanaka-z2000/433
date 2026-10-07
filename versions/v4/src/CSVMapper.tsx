import { useEffect, useMemo, useRef, useState } from "react";
import {
  guessMapping,
  mapHoldings,
  type CSVTable,
  type ColumnMapping,
} from "./csvMapping";
import type { Asset } from "./engine";
export function CSVMapper({
  table,
  name,
  onCancel,
  onPreview,
}: {
  table: CSVTable;
  name: string;
  onCancel: () => void;
  onPreview: (assets: Asset[]) => void;
}) {
  const [mapping, setMapping] = useState(() => guessMapping(table));
  const [unit, setUnit] = useState<"" | "share" | "lot">("");
  const [confirmed, setConfirmed] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
    heading.current?.scrollIntoView({ block: "start" });
  }, []);
  const result = useMemo(() => {
    try {
      return { assets: mapHoldings(table, mapping, unit), error: "" };
    } catch (e) {
      return { assets: [], error: (e as Error).message };
    }
  }, [table, mapping, unit]);
  const labels: Record<keyof ColumnMapping, string> = {
    ticker: "標的代號欄",
    shares: "持有數量欄",
    price: "每股價格欄",
    name: "標的名稱欄（選填）",
    currency: "幣別欄（選填）",
  };
  return (
    <section className="panel csv-mapper" aria-labelledby="csv-mapper-title">
      <h2 id="csv-mapper-title" tabIndex={-1} ref={heading}>
        外部 CSV 欄位對應
      </h2>
      <p>
        {name} · {table.rows.length}{" "}
        筆。只接收目前持倉，不接收逐筆交易。請確認價格是新臺幣每股市價，而非成本或整張金額。
      </p>
      <div className="field-grid">
        {(Object.keys(labels) as (keyof ColumnMapping)[]).map((key) => (
          <label key={key}>
            {labels[key]}
            <select
              aria-label={labels[key]}
              value={mapping[key]}
              onChange={(e) => {
                setConfirmed(false);
                setMapping({ ...mapping, [key]: Number(e.target.value) });
              }}
            >
              <option value={-1}>請選擇／不使用</option>
              {table.header.map((h, i) => (
                <option key={i} value={i}>
                  {h}
                </option>
              ))}
            </select>
          </label>
        ))}
        <label>
          CSV 數量單位
          <select
            aria-label="CSV 數量單位"
            value={unit}
            onChange={(e) => {
              setConfirmed(false);
              setUnit(e.target.value as typeof unit);
            }}
          >
            <option value="">請明確選擇</option>
            <option value="share">股</option>
            <option value="lot">張（1 張＝1000 股）</option>
          </select>
        </label>
      </div>
      <details>
        <summary>檢查原始表格前 5 筆</summary>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                {table.header.map((h, i) => (
                  <th key={i}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.slice(0, 5).map((row, i) => (
                <tr key={i}>
                  {row.map((v, j) => (
                    <td key={j}>{v}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
      {result.error ? (
        <p role="status" className="notice">
          {result.error}
        </p>
      ) : (
        <p role="status">
          可轉換 {result.assets.length} 筆；請於下一步核對每個代號、股數與價格。
        </p>
      )}
      <label className="confirm-check">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
        />
        我確認這是新臺幣持倉，價格為每股市價，並已核對數量單位。
      </label>
      <p className="hint">
        同代號保留既有分類、交易限制與費率；新增標的先使用其他分類及股票標準費率，請再核對商品費率。外部表格的名稱不視為官方名稱。持倉名單不同時清除本次全部目標，避免沿用不完整比例。
      </p>
      <div className="toolbar">
        <button
          className="primary"
          disabled={!confirmed || !!result.error}
          onClick={() => onPreview(result.assets)}
        >
          預覽持倉差異
        </button>
        <button onClick={onCancel}>取消欄位對應</button>
      </div>
    </section>
  );
}
