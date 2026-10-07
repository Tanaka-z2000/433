import React, { useRef, useState } from "react";
import type { Asset } from "./engine";
import {
  exactNameMatches,
  findByTicker,
  isCatalogStale,
  searchSecurities,
  selectSecurity,
  securityTypeLabel,
  type Catalog,
  type Security,
} from "./security";

/** Editing a verified identity clears its paired official name/code and metadata. */
export function SecurityPicker({
  asset,
  catalog,
  allowInitialFees,
  onChange,
}: {
  asset: Asset;
  catalog: Catalog | null;
  allowInitialFees: boolean;
  onChange: (patch: Partial<Asset>) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const fresh = useRef(
    !asset.ticker && !asset.name && asset.feeMode === undefined,
  );
  const [field, setField] = useState<"ticker" | "name" | null>(null);
  const [feedback, setFeedback] = useState("");
  const query =
    field === "ticker"
      ? asset.ticker
      : field === "name"
        ? (asset.name ?? "")
        : "";
  const options =
    catalog && query.trim() ? searchSecurities(catalog, query, 10) : [];

  function select(security: Security) {
    // A new, previously empty row may use its first verified default. All
    // imported or already edited fee settings stay manual unless requested.
    const stale = !!catalog && isCatalogStale(catalog);
    const base =
      fresh.current && allowInitialFees && catalog && !stale
        ? { ...asset, ticker: "", feeMode: undefined }
        : stale
          ? { ...asset, feeMode: "manual" as const }
          : asset;
    const patch = selectSecurity(base, security);
    // Outdated metadata may fill a name but cannot silently disable an
    // existing automatic verification requirement or replace numeric fees.
    if (stale && asset.feeMode === "auto") patch.feeMode = "auto";
    onChange(patch);
    fresh.current = false;
    setField(null);
    setFeedback(`已選取 ${security.ticker} ${security.name}`);
  }

  function commit(which: "ticker" | "name") {
    if (composing.current) return;
    const value = which === "ticker" ? asset.ticker : (asset.name ?? "");
    if (!value.trim()) {
      setField(null);
      return;
    }
    const matches = !catalog
      ? []
      : which === "ticker"
        ? [findByTicker(catalog, value)].filter((s): s is Security => !!s)
        : exactNameMatches(catalog, value);
    if (matches.length === 1) select(matches[0]);
    else {
      fresh.current = false;
      setField(null);
      setFeedback(
        matches.length > 1
          ? "名稱對應多個標的，請重新開啟候選並選定。"
          : "尚未核對官方名錄；請點選候選，或自行核對代號、名稱與費率。",
      );
    }
  }

  function edit(which: "ticker" | "name", value: string) {
    setField(which);
    setFeedback("");
    const wasOfficial = !!(
      asset.securityAsOf ||
      asset.securityType ||
      asset.shortName
    );
    onChange({
      ticker:
        which === "ticker" ? value.trim() : wasOfficial ? "" : asset.ticker,
      name: which === "name" ? value : wasOfficial ? "" : asset.name,
      shortName: undefined,
      securityType: undefined,
      securityAsOf: undefined,
      feeRuleId: undefined,
      taxValidUntil: undefined,
      // Preserve an explicit automatic intent while the edited identity is
      // unresolved. Its missing provenance blocks estimates until matched.
      feeMode: asset.feeMode === "auto" ? "auto" : "manual",
    });
  }

  function keyboard(
    e: React.KeyboardEvent<HTMLInputElement>,
    which: "ticker" | "name",
  ) {
    if (composing.current || e.nativeEvent.isComposing) return;
    if (e.key === "Enter") {
      e.preventDefault();
      commit(which);
    } else if (e.key === "Escape") {
      setField(null);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      root.current
        ?.querySelector<HTMLButtonElement>(".security-options button")
        ?.focus();
    }
  }

  return (
    <div
      className="security-picker"
      ref={root}
      onBlur={(event) => {
        const next = event.relatedTarget as HTMLElement | null;
        if (!next?.closest(".security-options") && field) commit(field);
      }}
    >
      <div className="security-inputs">
        <label>
          標的代號
          <input
            value={asset.ticker}
            autoComplete="off"
            spellCheck={false}
            maxLength={20}
            placeholder="例如 00662"
            aria-expanded={field === "ticker" && options.length > 0}
            aria-controls={`security-options-${asset.id}`}
            onFocus={() => setField("ticker")}
            onClick={() => setField("ticker")}
            onChange={(e) => edit("ticker", e.target.value)}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
            onKeyDown={(e) => keyboard(e, "ticker")}
          />
        </label>
        <label>
          標的全稱
          <input
            value={asset.name ?? ""}
            autoComplete="off"
            maxLength={300}
            placeholder="完整名稱或簡稱搜尋"
            aria-expanded={field === "name" && options.length > 0}
            aria-controls={`security-options-${asset.id}`}
            onFocus={() => setField("name")}
            onClick={() => setField("name")}
            onChange={(e) => edit("name", e.target.value)}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
            onKeyDown={(e) => keyboard(e, "name")}
          />
        </label>
      </div>
      {field && query.trim() && (
        <div
          className="security-options"
          id={`security-options-${asset.id}`}
          aria-label="標的候選"
        >
          {options.map((security) => (
            <button
              type="button"
              key={security.ticker}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => select(security)}
            >
              <span>
                {security.ticker} · {security.shortName}
              </span>
              <small>
                {security.name} · {securityTypeLabel(security.type)}
              </small>
            </button>
          ))}
          {!options.length && (
            <p>
              未找到不代表不存在；可能是上櫃、新掛牌或尚未收錄。仍可手動輸入並核對費率。
            </p>
          )}
          {!!options.length && (
            <p>
              部分名稱需點選候選；完整代號或唯一名稱可按 Enter／離開欄位帶入。
            </p>
          )}
        </div>
      )}
      {feedback && (
        <p className="hint picker-feedback" role="status">
          {feedback}
        </p>
      )}
    </div>
  );
}
