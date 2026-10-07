import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { readVersions } from "./versions.ts";
export function createVersion(root: string, id: string, from = "v1"): void {
  if (!/^v(?:[2-9]|[1-9]\d+)$/.test(id))
    throw new Error("新版本請使用 v2、v3 等 ID，不能覆蓋 v1");
  const list = readVersions(root);
  const source = list.find((v) => v.id === from);
  if (!source) throw new Error("來源版本不存在");
  const target = resolve(root, "versions", id);
  if (list.some((v) => v.id === id) || existsSync(target))
    throw new Error("版本已存在，禁止覆蓋");
  if (
    Number(id.slice(1)) <= Math.max(...list.map((v) => Number(v.id.slice(1))))
  )
    throw new Error("新版本 ID 必須遞增，不能重用已封存版本的資料保存鍵");
  const storagePath = resolve(root, `versions/${from}/src/storage.ts`);
  const storage = readFileSync(storagePath, "utf8");
  const isolated = storage.replace(
    /export const KEY = ["'][^"']+["']/,
    `export const KEY = "433.portfolio.${id}"`,
  );
  cpSync(resolve(root, "versions", from), target, { recursive: true });
  writeFileSync(resolve(target, "src/storage.ts"), isolated);
  list.push({
    ...source,
    id,
    title: `試用版 ${id.toUpperCase()}`,
    status: "preview",
    description: `由 ${from.toUpperCase()} 複製的獨立試用版本；功能修改後請更新這段說明。`,
  });
  writeFileSync(
    resolve(root, "versions.json"),
    JSON.stringify(list, null, 2) + "\n",
  );
  readVersions(root);
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(import.meta.dirname, "create-version.ts")
) {
  try {
    const [id, from = "v1"] = process.argv.slice(2);
    createVersion(process.cwd(), id ?? "", from);
    console.log(
      `已建立 ${id}；請只修改 versions/${id}/，再更新版本說明及執行測試。`,
    );
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
