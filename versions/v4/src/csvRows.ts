export function parseCSVRows(text: string, maxColumns = 64): string[][] {
  if (text.length > 8_000_000) throw new Error("CSV 超過 8 MB 限制");
  const rows: string[][] = [];
  let row: string[] = [],
    value = "",
    quoted = false,
    closed = false;
  const endCell = () => {
    row.push(value);
    if (row.length > maxColumns) throw new Error("CSV 欄位數過多");
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
  return rows;
}
