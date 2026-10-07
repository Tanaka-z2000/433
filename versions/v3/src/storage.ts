import { type Asset, type Portfolio, type Plan, validate } from "./engine";
export const KEY = "433.portfolio.v3";
export type RecordKind = "actual" | "estimate" | "plan" | "legacy";
export interface Snapshot {
  kind?: RecordKind;
  sourcePortfolio?: Portfolio;
  mode?: import("./engine").Mode;
  id: string;
  date: string;
  name: string;
  portfolio: Portfolio;
}
export interface Evidence {
  id: string;
  title: string;
  value: string;
  date: string;
  source: string;
  status: "已核對" | "待核對" | "落後";
}
export interface Backup {
  version: 1 | 2;
  state?: "actual" | "estimate";
  beforeEstimate?: Portfolio;
  exported?: { at: string; digest: string };
  portfolio: Portfolio;
  snapshots: Snapshot[];
  evidence: Evidence[];
}
export function parseBackup(text: string): Backup {
  const x = JSON.parse(text) as Backup;
  if (!x || ![1, 2].includes(x.version) || !x.portfolio)
    throw new Error("備份格式或版本不支援");
  const errors = validate(x.portfolio);
  if (errors.length) throw new Error(errors.join("；"));
  if (
    !Array.isArray(x.snapshots) ||
    x.snapshots.length > 50 ||
    !Array.isArray(x.evidence) ||
    x.evidence.length > 100
  )
    throw new Error("快照或市場資料格式錯誤");
  const ids = new Set<string>();
  for (const s of x.snapshots) {
    if (
      !s ||
      typeof s.id !== "string" ||
      !s.id ||
      ids.has(s.id) ||
      (s.kind !== undefined &&
        !["actual", "estimate", "plan", "legacy"].includes(s.kind)) ||
      (s.sourcePortfolio !== undefined &&
        validate(s.sourcePortfolio).length > 0) ||
      (s.mode !== undefined &&
        !["full", "contribute", "band"].includes(s.mode)) ||
      typeof s.name !== "string" ||
      typeof s.date !== "string" ||
      !Number.isFinite(Date.parse(s.date)) ||
      validate(s.portfolio).length
    )
      throw new Error("快照內容無效");
    ids.add(s.id);
  }
  if (x.state !== undefined && !["actual", "estimate"].includes(x.state))
    throw new Error("持倉核對狀態無效");
  if (x.beforeEstimate !== undefined && validate(x.beforeEstimate).length)
    throw new Error("核對前持倉無效");
  if (
    x.exported &&
    (!Number.isFinite(Date.parse(x.exported.at)) ||
      typeof x.exported.digest !== "string" ||
      !/^[a-f0-9]{64}$/.test(x.exported.digest))
  )
    throw new Error("匯出資訊無效");
  for (const e of x.evidence)
    if (
      !e ||
      !["id", "title", "value", "date", "source"].every(
        (k) => typeof e[k as keyof Evidence] === "string",
      ) ||
      !["已核對", "待核對", "落後"].includes(e.status) ||
      (e.source && !/^https?:\/\//i.test(e.source))
    )
      throw new Error("市場資料內容或來源網址無效");
  return { ...x, version: 2 };
}
export function download(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const columns = [
  "ticker",
  "kind",
  "shares",
  "price",
  "target",
  "limit",
  "lot",
  "feeRate",
  "minFee",
  "sellTaxRate",
] as const;
const cell = (v: unknown) => '"' + String(v ?? "").replace(/"/g, '""') + '"';
const safeText = (v: string) => (/^[=+\-@\t\r]/.test(v) ? "'" + v : v);
export function assetsCSV(assets: Asset[]) {
  return (
    "\uFEFF" +
    [
      columns.join(","),
      ...assets.map((a) =>
        columns
          .map((k) => cell(k === "ticker" ? safeText(a[k]) : a[k]))
          .join(","),
      ),
    ].join("\r\n")
  );
}
export function tradesCSV(plan: Plan) {
  return (
    "\uFEFF" +
    [
      ["標的", "買賣股數", "交易金額", "預估費用", "調後市值"],
      ...plan.trades.map((t) => [
        safeText(t.asset.ticker),
        t.quantity,
        t.gross,
        t.cost,
        t.afterValue,
      ]),
    ]
      .map((row) => row.map(cell).join(","))
      .join("\r\n")
  );
}
export function parseCSV(text: string): Asset[] {
  if (text.length > 8_000_000) throw new Error("CSV 超過 8 MB 限制");
  const rows: string[][] = [];
  let row: string[] = [],
    value = "",
    quoted = false,
    closed = false;
  const endCell = () => {
    row.push(value);
    if (row.length > columns.length) throw new Error("CSV 欄位數過多");
    value = "";
    closed = false;
  };
  const endRow = () => {
    if (row.some(Boolean)) rows.push(row);
    if (rows.length > 101) throw new Error("最多支援 100 個標的");
    row = [];
  };
  text = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') {
        value += '"';
        i++;
      } else if (quoted) {
        quoted = false;
        closed = true;
      } else if (!value && !closed) quoted = true;
      else throw new Error("CSV 引號位置錯誤");
    } else if (!quoted && (c === "," || c === "\n")) {
      endCell();
      if (c === "\n") endRow();
    } else {
      if (closed) throw new Error("CSV 引號後有多餘內容");
      value += c;
    }
    if (value.length > 1024) throw new Error("CSV 單一欄位超過 1024 字元");
  }
  if (quoted) throw new Error("CSV 引號未閉合");
  if (value || row.length || closed) {
    endCell();
    endRow();
  }
  if (rows.shift()?.join(",") !== columns.join(","))
    throw new Error("CSV 欄位不符，請先匯出範本");
  return rows
    .filter((r) => r.some(Boolean))
    .map((r, i) => {
      if (r.length !== columns.length)
        throw new Error(`第 ${i + 2} 列欄位數錯誤`);
      const a: Record<string, unknown> = { id: crypto.randomUUID() };
      columns.forEach((k, j) => {
        a[k] = ["ticker", "kind", "limit"].includes(k)
          ? r[j]
          : k === "target" && r[j] === ""
            ? null
            : r[j].trim() === ""
              ? NaN
              : Number(r[j]);
      });
      return a as unknown as Asset;
    });
}

export const SNAPSHOT_LIMIT = 50;
export function backupContent(b: Backup): string {
  const { exported: _exported, ...content } = b;
  return JSON.stringify(content);
}
export async function digestContent(text: string): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(hash), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
export function storageSize(text: string): string {
  // Estimate UTF-16 text footprint, not browser quota or physical disk allocation.
  return `${(((text.length + KEY.length) * 2) / 1024).toFixed(1)} KB`;
}
