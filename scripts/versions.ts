import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
export interface Version {
  id: string;
  title: string;
  status: "original" | "preview" | "stable";
  description: string;
  features: string[];
}
export function readVersions(root: string): Version[] {
  const list: Version[] = JSON.parse(
    readFileSync(resolve(root, "versions.json"), "utf8"),
  );
  if (!Array.isArray(list) || !list.length) throw new Error("版本清單不可空白");
  const ids = new Set<string>(),
    keys = new Set<string>();
  for (const version of list) {
    if (!version || !/^v[1-9]\d*$/.test(version.id) || ids.has(version.id))
      throw new Error("版本 ID 無效或重複");
    ids.add(version.id);
    if (
      !["original", "preview", "stable"].includes(version.status) ||
      typeof version.title !== "string" ||
      typeof version.description !== "string" ||
      !Array.isArray(version.features) ||
      !version.features.every((x) => typeof x === "string")
    )
      throw new Error("版本描述格式錯誤");
    if (!existsSync(resolve(root, `versions/${version.id}/index.html`)))
      throw new Error(`${version.id} 缺少網頁入口`);
    const storage = readFileSync(
      resolve(root, `versions/${version.id}/src/storage.ts`),
      "utf8",
    );
    const key = storage.match(/export const KEY = ["']([^"']+)["']/)?.[1];
    if (!key || keys.has(key)) throw new Error("版本資料保存鍵不可共用");
    keys.add(key);
  }
  if (!ids.has("v1")) throw new Error("不可移除 V1 原始版");
  return list;
}
export const escapeHTML = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export function versionCards(list: Version[]): string {
  const labels = {
    original: "保留原始版",
    preview: "試用版",
    stable: "正式版",
  };
  return list
    .map(
      (v) =>
        `<article class="version-card"><div class="card-top"><span class="version-number">${v.id.toUpperCase()}</span><span class="badge ${v.status}">${labels[v.status]}</span></div><h2>${escapeHTML(v.title)}</h2><p>${escapeHTML(v.description)}</p><ul class="features">${v.features.map((f) => `<li>${escapeHTML(f)}</li>`).join("")}</ul><a class="enter" href="./versions/${v.id}/">進入 ${v.id.toUpperCase()} ${escapeHTML(v.title)} <span aria-hidden="true">↗</span></a><small>此版本的資料保存在目前瀏覽器</small></article>`,
    )
    .join("\n");
}
