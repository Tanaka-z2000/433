import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { readVersions, versionCards } from "../scripts/versions";
import { createVersion } from "../scripts/create-version";
function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), "433-versions-"));
  mkdirSync(resolve(root, "versions/v1/src"), { recursive: true });
  writeFileSync(
    resolve(root, "versions/v1/index.html"),
    "<body>Original</body>",
  );
  writeFileSync(
    resolve(root, "versions/v1/src/storage.ts"),
    'export const KEY = "433.portfolio.v1";',
  );
  writeFileSync(
    resolve(root, "versions.json"),
    JSON.stringify([
      {
        id: "v1",
        title: "原始版",
        status: "original",
        description: "保留原始頁面",
        features: ["歷史快照"],
      },
    ]),
  );
  return root;
}
describe("version lifecycle", () => {
  it("creates a new independent page without touching the original or its storage", () => {
    const root = fixture();
    try {
      createVersion(root, "v2");
      const versions = readVersions(root);
      expect(versions.map((v) => v.id)).toEqual(["v1", "v2"]);
      expect(
        readFileSync(resolve(root, "versions/v1/src/storage.ts"), "utf8"),
      ).toContain("433.portfolio.v1");
      expect(
        readFileSync(resolve(root, "versions/v2/src/storage.ts"), "utf8"),
      ).toContain("433.portfolio.v2");
      expect(
        readFileSync(resolve(root, "versions/v1/index.html"), "utf8"),
      ).toBe("<body>Original</body>");
      expect(versionCards(versions)).toContain("./versions/v2/");
      expect(() => createVersion(root, "v2")).toThrow("禁止覆蓋");
      expect(() => createVersion(root, "v1")).toThrow("不能覆蓋");
      expect(() => createVersion(root, "../v3")).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("rejects conflicting browser storage and escapes version descriptions", () => {
    const root = fixture();
    try {
      const versions = readVersions(root);
      versions[0].title = '<script>"bad"</script>';
      expect(versionCards(versions)).toContain("&lt;script&gt;");
      createVersion(root, "v2");
      writeFileSync(
        resolve(root, "versions/v2/src/storage.ts"),
        'export const KEY = "433.portfolio.v1";',
      );
      expect(() => readVersions(root)).toThrow("不可共用");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
