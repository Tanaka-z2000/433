import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
  autoFeeProblem,
  findByTicker,
  parseCatalog,
  selectSecurity,
} from "../versions/v4/src/security";
import { blankAsset } from "../versions/v4/src/engine";

it("the published TWSE catalog satisfies the browser contract and verified examples", () => {
  const catalog = parseCatalog(
    readFileSync("public/data/twse-securities.json", "utf8"),
  );
  expect(catalog.securities.length).toBe(
    catalog.sources.reduce((count, source) => count + source.rows, 0),
  );
  for (const [ticker, type, currency] of [
    ["2330", "stock", "TWD"],
    ["00662", "equityETF", "TWD"],
    ["00675L", "otherETF", "TWD"],
    ["00710B", "bondETF", "TWD"],
    ["9105", "unsupported", "unknown"],
  ]) {
    expect(findByTicker(catalog, ticker)).toMatchObject({ type, currency });
  }
  // Every automatically priced entry must survive the same check used by the UI.
  const today = new Date(catalog.fetchedAt);
  for (const security of catalog.securities) {
    const asset = {
      ...blankAsset(),
      ...selectSecurity(blankAsset(), security, false, today),
    };
    expect(autoFeeProblem(asset, catalog, today)).toBeNull();
  }
});
