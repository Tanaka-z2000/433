/** Self-contained documentation travels with each financial JSON export. */
export const FINANCE_FORMAT = {
  id: "433-finance",
  version: 1,
  currency: "TWD",
  market: "TW",
  quantityUnit: "share",
  priceUnit: "TWD/share",
  rateUnit: "percent",
  dateTimeFormat: "ISO-8601",
  scope: "Taiwan securities portfolio, not a complete personal balance sheet",
  guide: "https://tanaka-z2000.github.io/433/data/finance-format-v1.json",
  rules: {
    current:
      "Only portfolio is the current portfolio. state=estimate is unconfirmed; actual is user-confirmed, not broker-verified. Missing state in legacy data means actual.",
    history:
      "snapshots, beforeEstimate and sourcePortfolio are historical or hypothetical. Never add them to current assets.",
    value:
      "Current net assets TWD = sum(shares * price) + cash + settlement. flow is planned and is NOT included. Prices are user-entered, not live quotes.",
    rates:
      "0.1425 means 0.1425%, not 14.25%. target=null means unset, not zero. All money is TWD; quantities are shares, not lots.",
    settlement:
      "Signed net Taiwan T+2 pending settlement: positive receivable, negative payable. Separate from cash; do not double-count. No actual settlement date is provided.",
    csv: "CSV is holdings only, not a full backup. Text beginning with a spreadsheet formula or apostrophe is prefixed with one apostrophe; remove exactly one only under this format's escape rule. Keep ticker as text to preserve leading zeros.",
  },
  fields: {
    version:
      "備份結構版本 / backup structure version; independent of this format version",
    state: "持倉狀態 / actual=user-confirmed; estimate=unconfirmed estimate",
    portfolio: "目前持倉與設定 / current portfolio and configuration",
    "portfolio.version": "持倉結構版本 / portfolio structure version",
    "portfolio.assets": "目前證券持倉 / current securities positions",
    "portfolio.cash": "現金餘額 / settled cash, TWD",
    "portfolio.settlement": "T+2 淨交割款 / signed pending settlement, TWD",
    "portfolio.flow":
      "本次預計投入／提領 / planned contribution (+) or withdrawal (-), TWD; not current assets",
    "portfolio.cashFloor": "現金比例下限 / minimum cash weight, percent",
    "portfolio.cashTarget":
      "現金目標比例 / target cash weight, percent; null=unset",
    "portfolio.tolerance":
      "再配置容許偏差 / rebalance tolerance, percentage points",
    "assets[].id": "系統列識別碼 / internal row ID, not a security identifier",
    "assets[].ticker":
      "標的代號 / security code, string; preserve leading zeros",
    "assets[].name": "標的全稱 / full security name; optional",
    "assets[].shortName": "交易簡稱 / trading short name; optional",
    "assets[].kind":
      "配置分類 / core=核心; leverage=槓桿; other=其他; not legal product classification",
    "assets[].shares": "持有股數 / quantity in shares, not trading lots",
    "assets[].price": "每股價格 / TWD per share, user-entered",
    "assets[].priceUpdatedAt":
      "價格最後編輯時間 / ISO-8601 edit timestamp, not quote timestamp; optional",
    "assets[].target": "目標比例 / target weight, percent; null=unset",
    "assets[].limit": "交易限制 / free=自由買賣; buyOnly=只買; frozen=凍結",
    "assets[].lot": "試算下單股數單位 / shares per order increment",
    "assets[].feeRate": "手續費率 / commission percent; 0.1425 means 0.1425%",
    "assets[].minFee": "最低手續費 / minimum commission per order, TWD",
    "assets[].sellTaxRate": "賣出證交稅率 / sell transaction tax, percent",
    "assets[].securityType":
      "商品分類 / stock, equityETF, bondETF, otherETF, unsupported; optional",
    "assets[].feeMode":
      "費率模式 / auto or manual; CSV always imports as manual",
    "assets[].securityAsOf":
      "名錄資料日期 / catalog as-of YYYY-MM-DD; optional",
    "assets[].feeRuleId": "費率規則識別碼 / fee rule ID; optional",
    "assets[].taxValidUntil":
      "稅率適用截止日 / tax rule valid-until YYYY-MM-DD; optional",
    snapshots:
      "歷史快照與試算方案 / history and hypothetical plans, never current balances",
    "snapshots[].id": "快照識別碼 / snapshot ID",
    "snapshots[].date":
      "保存時間 / snapshot ISO-8601 timestamp, not trade date",
    "snapshots[].name": "快照名稱 / snapshot label",
    "snapshots[].kind":
      "快照類型 / actual, estimate, plan, legacy; missing=legacy/unknown",
    "snapshots[].portfolio":
      "該次持倉 / historical or hypothetical portfolio with same units",
    "snapshots[].sourcePortfolio":
      "試算來源 / source portfolio, do not add to balances",
    "snapshots[].mode":
      "再配置模式 / full=完整; contribute=新增資金; band=偏差觸發",
    beforeEstimate:
      "套用估計方案前持倉 / rollback portfolio, not current balances",
    evidence: "舊版參考筆記 / legacy reference notes, not financial balances",
    "evidence[].id/title/value/date/source/status":
      "筆記 ID／標題／文字值／日期／來源網址／核對狀態 / legacy note metadata; value is text, not money",
    "exported.at":
      "匯出時間 / ISO-8601 export timestamp, not valuation timestamp",
    "exported.digest":
      "內容變更偵測 SHA-256 / local change detection, not authentication or a digital signature",
  },
} as const;

export const CSV_CONTEXT = {
  formatVersion: "433-holdings-1",
  currency: "TWD",
  quantityUnit: "share",
  priceUnit: "TWD/share",
  rateUnit: "percent",
} as const;
