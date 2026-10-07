import { type Asset, type Portfolio, type Plan, validate } from "./engine";
export const KEY = "433.portfolio.v4";
export const BACKUP_LIMIT_BYTES = 32 * 1024 * 1024;
export function serializeBackup(backup: Backup, reserve = 0): string {
  const text = JSON.stringify(backup);
  if (new TextEncoder().encode(text).byteLength > BACKUP_LIMIT_BYTES - reserve)
    throw new Error(
      "JSON 備份超過 32 MiB，請先整理快照或縮短過長文字；未刪除任何資料",
    );
  return text;
}
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
  version: 1 | 2 | 3;
  state?: "actual" | "estimate";
  beforeEstimate?: Portfolio;
  exported?: { at: string; digest: string };
  portfolio: Portfolio;
  snapshots: Snapshot[];
  evidence: Evidence[];
}
export function parseBackup(text: string): Backup {
  if (
    text.length > BACKUP_LIMIT_BYTES ||
    new TextEncoder().encode(text).byteLength > BACKUP_LIMIT_BYTES
  )
    throw new Error("JSON 備份超過 32 MiB");
  const x = JSON.parse(text) as Backup;
  if (!x || ![1, 2, 3].includes(x.version) || !x.portfolio)
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
  if (x.version < 3) {
    // Older formats predate verified product defaults. Keep their exact costs,
    // including every historical/source portfolio, instead of guessing a rule.
    const manual = (p: Portfolio): Portfolio => ({
      ...p,
      assets: p.assets.map((a) => ({ ...a, feeMode: "manual" })),
    });
    return {
      ...x,
      version: 3,
      portfolio: manual(x.portfolio),
      snapshots: x.snapshots.map((s) => ({
        ...s,
        portfolio: manual(s.portfolio),
        ...(s.sourcePortfolio
          ? { sourcePortfolio: manual(s.sourcePortfolio) }
          : {}),
      })),
      ...(x.beforeEstimate ? { beforeEstimate: manual(x.beforeEstimate) } : {}),
    };
  }
  return { ...x, version: 3 };
}
export function download(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const legacyColumns = [
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
const columns = [...legacyColumns, "name", "shortName"] as const;
const cell = (v: unknown) => '"' + String(v ?? "").replace(/"/g, '""') + '"';
// Escape apostrophes too so our new CSV format can undo exactly one prefix,
// even when a name literally begins with an apostrophe. Spreadsheet programs
// may trim whitespace before interpreting formulas, so guard that prefix too.
const needsEscape = (v: string) =>
  /^[\s\uFEFF]*[=+\-@]/.test(v) || /^[\t\r\n']/.test(v);
const safeText = (v: string) => (needsEscape(v) ? "'" + v : v);
const originalText = (v: string) =>
  v.startsWith("'") && needsEscape(v.slice(1)) ? v.slice(1) : v;
export function assetsCSV(assets: Asset[]) {
  return (
    "\uFEFF" +
    [
      columns.join(","),
      ...assets.map((a) =>
        columns
          .map((k) =>
            cell(
              ["ticker", "name", "shortName"].includes(k)
                ? safeText(String(a[k] ?? ""))
                : a[k],
            ),
          )
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
  text = text.replace(/^\uFEFF/, "");
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
    } else if (!quoted && (c === "," || c === "\n" || c === "\r")) {
      endCell();
      if (c !== ",") {
        endRow();
        if (c === "\r" && text[i + 1] === "\n") i++;
      }
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
  const header = rows.shift()?.join(",");
  const activeColumns = header === columns.join(",") ? columns : legacyColumns;
  if (header !== activeColumns.join(","))
    throw new Error("CSV 欄位不符，請先匯出範本");
  return rows
    .filter((r) => r.some(Boolean))
    .map((r, i) => {
      if (r.length !== activeColumns.length)
        throw new Error(`第 ${i + 2} 列欄位數錯誤`);
      const a: Record<string, unknown> = {
        id: crypto.randomUUID(),
        feeMode: "manual",
      };
      activeColumns.forEach((k, j) => {
        if (["name", "shortName"].includes(k) && !r[j]) return;
        a[k] = ["ticker", "kind", "limit", "name", "shortName"].includes(k)
          ? activeColumns === columns &&
            ["ticker", "name", "shortName"].includes(k)
            ? originalText(r[j])
            : r[j]
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
