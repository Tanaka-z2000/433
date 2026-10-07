#!/usr/bin/env python3
"""Fetch TWSE open data into reviewable artifacts; never updates the live catalog.

The CSV endpoints are linked by data.gov.tw datasets 18419 and 157399 under
the Taiwan Open Government Data License 1.0. No user holdings are submitted.
"""

import argparse
import collections
import csv
import datetime as dt
import hashlib
import io
import json
import os
from pathlib import Path
import re
import tempfile
import urllib.error
import urllib.parse
import urllib.request


MAX_BYTES = 12 * 1024 * 1024
MAX_ROWS = 10000
MAX_AGE_DAYS = 62
SOURCES = (
    {
        "id": "twse-companies",
        "url": "https://mopsfin.twse.com.tw/opendata/t187ap03_L.csv",
        "file": "t187ap03_L.csv",
        "ticker": "公司代號",
        "required": ("出表日期", "公司代號", "公司名稱", "公司簡稱"),
        "minimum": 500,
    },
    {
        "id": "twse-funds",
        "url": "https://mopsfin.twse.com.tw/opendata/t187ap47_L.csv",
        "file": "t187ap47_L.csv",
        "ticker": "基金代號",
        "required": ("出表日期", "基金代號", "基金中文名稱", "基金簡稱", "基金類型"),
        "minimum": 50,
    },
)


class CatalogError(ValueError):
    """A downloaded source cannot safely become a catalog."""


class OfficialRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        parsed = urllib.parse.urlparse(newurl)
        if parsed.scheme != "https" or parsed.hostname != "mopsfin.twse.com.tw":
            raise CatalogError("Download redirected away from the official HTTPS host")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def download(source):
    request = urllib.request.Request(
        source["url"],
        headers={"User-Agent": "433-official-catalog/1.0", "Accept": "text/csv,*/*;q=0.1"},
    )
    opener = urllib.request.build_opener(OfficialRedirects())
    with opener.open(request, timeout=40) as response:
        size = response.headers.get("Content-Length")
        if size and int(size) > MAX_BYTES:
            raise CatalogError("Official CSV exceeds the download limit")
        raw = response.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES:
        raise CatalogError("Official CSV exceeds the download limit")
    if not raw:
        raise CatalogError("Official CSV is empty")
    return raw


def decode_csv(raw):
    if len(raw) > MAX_BYTES:
        raise CatalogError("CSV exceeds the byte limit")
    for encoding in ("utf-8-sig", "cp950"):
        try:
            text = raw.decode(encoding)
            break
        except UnicodeDecodeError:
            continue
    else:
        raise CatalogError("CSV is not valid UTF-8 or Big5")
    if "\x00" in text or text.lstrip().startswith("<"):
        raise CatalogError("Source is not a CSV document")
    return text


def normalize_date(value, today=None):
    text = value.strip()
    if re.fullmatch(r"\d{7,8}", text):
        year, month, day = int(text[:-4]), int(text[-4:-2]), int(text[-2:])
    elif match := re.fullmatch(r"(\d{3,4})[/-](\d{1,2})[/-](\d{1,2})", text):
        year, month, day = map(int, match.groups())
    else:
        raise CatalogError(f"Unrecognized source date: {text!r}")
    if year < 1911:
        year += 1911
    try:
        parsed = dt.date(year, month, day)
    except ValueError as error:
        raise CatalogError("Invalid source date") from error
    today = today or dt.datetime.now(dt.timezone.utc).date()
    age = (today - parsed).days
    if age < -1 or age > MAX_AGE_DAYS:
        raise CatalogError(f"Source date outside permitted freshness window: {parsed}")
    return parsed.isoformat()


def parse_source(raw, source, *, today=None, enforce_minimum=True):
    reader = csv.reader(io.StringIO(decode_csv(raw), newline=""), strict=True)
    try:
        headers = [value.strip() for value in next(reader)]
        if len(headers) != len(set(headers)):
            raise CatalogError("Source has duplicate column headers")
        missing = set(source["required"]) - set(headers)
        if missing:
            raise CatalogError(f"{source['id']} missing columns: {sorted(missing)}")
        rows, seen, dates = [], set(), set()
        for values in reader:
            if not values or not any(value.strip() for value in values):
                continue
            if len(values) != len(headers):
                raise CatalogError("Source row has the wrong number of columns")
            if len(rows) >= MAX_ROWS:
                raise CatalogError("Source exceeds the row limit")
            row = dict(zip(headers, (value.strip() for value in values)))
            ticker = row[source["ticker"]].upper()
            if not re.fullmatch(r"[0-9A-Z]{4,12}", ticker):
                raise CatalogError(f"Unexpected ticker: {ticker!r}")
            if ticker in seen:
                raise CatalogError(f"Duplicate ticker in {source['id']}: {ticker}")
            seen.add(ticker)
            row[source["ticker"]] = ticker
            dates.add(normalize_date(row["出表日期"], today))
            rows.append(row)
    except (csv.Error, StopIteration) as error:
        raise CatalogError("Malformed or empty CSV source") from error
    if not rows or (enforce_minimum and len(rows) < source["minimum"]):
        raise CatalogError(f"Unexpectedly few rows in {source['id']}: {len(rows)}")
    # A single file must describe one snapshot, not accidentally combine exports.
    if len(dates) != 1:
        raise CatalogError("Source contains conflicting publication dates")
    return {
        "id": source["id"],
        "url": source["url"],
        "asOf": min(dates),
        "sha256": hashlib.sha256(raw).hexdigest(),
        "rows": len(rows),
        "headers": headers,
        "records": rows,
    }


def inspection(source):
    result = {key: value for key, value in source.items() if key != "records"}
    result["distinctValues"] = {
        field: dict(sorted(collections.Counter(row.get(field, "") for row in source["records"]).items()))
        for field in ("基金類型", "外國企業註冊地國", "普通股每股面額", "產業別")
        if field in source["headers"]
    }
    interesting = {"2330", "00662", "00675L", "00664R", "00679B", "00694B", "00981A", "00980D", "9105", "911608"}
    result["examples"] = [
        row for row in source["records"]
        if row.get("公司代號", row.get("基金代號")) in interesting
    ]
    return result


def write_json(path, value):
    """Atomically publish a completed candidate, leaving older files on failure."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2, allow_nan=False)
            stream.write("\n")
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def build_catalog(sources, fetched_at):
    # Classification is deliberately closed until raw official type values have
    # been inspected. Unknown products remain searchable without a tax default.
    securities = []
    for source in sources:
        fund = source["id"] == "twse-funds"
        for row in source["records"]:
            securities.append({
                "ticker": row["基金代號" if fund else "公司代號"],
                "name": row["基金中文名稱" if fund else "公司名稱"],
                "shortName": row["基金簡稱" if fund else "公司簡稱"],
                "type": "unsupported",
                "market": "TWSE",
                "currency": "unknown",
                "asOf": source["asOf"],
                "sourceIds": [source["id"]],
            })
    securities.sort(key=lambda item: item["ticker"])
    if len({item["ticker"] for item in securities}) != len(securities):
        raise CatalogError("Ticker conflict between official sources")
    if any(not item["name"] or not item["shortName"] for item in securities):
        raise CatalogError("An official name is empty")
    return {
        "schemaVersion": 1,
        "fetchedAt": fetched_at,
        "asOf": min(source["asOf"] for source in sources),
        "sources": [{key: source[key] for key in ("id", "url", "asOf", "sha256", "rows")} for source in sources],
        "securities": securities,
        "stats": {"total": len(securities), "byType": dict(collections.Counter(item["type"] for item in securities))},
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inspect", action="store_true", help="Download raw sources and report columns/types; do not produce a candidate")
    parser.add_argument("--output-dir", type=Path, default=Path("test-results/catalog"))
    parser.add_argument("--input-dir", type=Path, help="Rebuild from previously downloaded CSV artifacts without network access")
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    fetched_at = dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")
    sources = []
    for config in SOURCES:
        raw = (args.input_dir / config["file"]).read_bytes() if args.input_dir else download(config)
        (args.output_dir / config["file"]).write_bytes(raw)
        sources.append(parse_source(raw, config))
    report = {"fetchedAt": fetched_at, "sources": [inspection(source) for source in sources]}
    write_json(args.output_dir / "inspection.json", report)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if not args.inspect:
        catalog = build_catalog(sources, fetched_at)
        write_json(args.output_dir / "twse-securities.json", catalog)
        print(json.dumps(catalog["stats"], ensure_ascii=False))


if __name__ == "__main__":
    main()
