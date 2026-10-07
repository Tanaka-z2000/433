import { defineConfig } from "vite";
import { resolve } from "node:path";
import { readVersions, versionCards, escapeHTML } from "./scripts/versions.ts";
const root = import.meta.dirname;
const buildId = process.env.GITHUB_SHA?.slice(0, 8) || "local";
const builtAt = new Date().toISOString();
const versions = readVersions(root);
export default defineConfig({
  base: "./",
  build: {
    rolldownOptions: {
      input: [
        resolve(root, "index.html"),
        ...versions.map((v) => resolve(root, `versions/${v.id}/index.html`)),
      ],
    },
  },
  plugins: [
    {
      name: "version-navigation",
      generateBundle() {
        this.emitFile({
          type: "asset",
          fileName: "release.json",
          source: JSON.stringify({
            buildId,
            commit: process.env.GITHUB_SHA || null,
            builtAt,
            versions,
          }),
        });
      },
      transformIndexHtml(html, context) {
        html = html.replace(
          "</head>",
          `<meta name="build-id" content="${escapeHTML(buildId)}"><meta name="built-at" content="${builtAt}"></head>`,
        );
        if (context.filename === resolve(root, "index.html"))
          return html
            .replace("<!-- VERSION_CARDS -->", versionCards(versions))
            .replace(
              "<!-- BUILD_INFO -->",
              `建置時間 ${builtAt.slice(0, 16).replace("T", " ")} UTC · 識別 ${escapeHTML(buildId)}`,
            )
            .replace(
              "<!-- FUTURE_NOTE -->",
              versions.length === 1
                ? "新版本建置完成後，會出現在上方供你試用。目前沒有其他已建置版本。"
                : "目前以 V4 與 V1 作為更新對照。V2、V3 的程式已封存於 Git 歷史，可從清理前的 commit 還原。",
            );
        const version = versions.find(
          (v) =>
            context.filename === resolve(root, `versions/${v.id}/index.html`),
        );
        if (!version) return html;
        const nav = `<nav aria-label="版本導覽" style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;padding:10px 20px;background:#e7f1ed;color:#29584d;font:13px/1.5 system-ui,sans-serif"><a href="../../" style="color:#176b58;padding:4px 0">← 返回版本入口</a><span>${version.id.toUpperCase()} · ${escapeHTML(version.title)}${version.release ? ` · ${escapeHTML(version.release)} · 建置 ${escapeHTML(buildId)}` : ""}</span></nav>`;
        const scope = `<aside aria-label="適用範圍" style="margin:0;padding:10px 20px;background:#f1f5f2;color:#29584d;font:13px/1.6 system-ui,sans-serif">暫時僅適用台股投資人，以新臺幣試算台灣市場股票與 ETF。包含在台掛牌的海外資產 ETF；不適用直接交易海外股票、外幣交易或期貨契約。</aside>`;
        return html.replace(/<body([^>]*)>/, `<body$1>${nav}${scope}`);
      },
    },
  ],
});
