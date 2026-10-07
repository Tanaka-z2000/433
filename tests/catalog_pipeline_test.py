"""Offline source contract and failure-safety tests; all rows are synthetic."""

import datetime as dt
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location("catalog_pipeline", Path(__file__).parents[1] / "scripts/update-catalog.py")
catalog = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(catalog)
TODAY = dt.date(2026, 10, 7)


def company_csv(rows=None, header=None):
    import csv
    text = io.StringIO(newline="")
    writer = csv.writer(text)
    writer.writerow(header or catalog.SOURCES[0]["required"])
    writer.writerows(rows or [("1151007", "2330", "測試公司股份有限公司", "測試公司")])
    return text.getvalue().encode("utf-8-sig")


def parsed(raw=None):
    return catalog.parse_source(company_csv() if raw is None else raw, catalog.SOURCES[0], today=TODAY, enforce_minimum=False)


class CatalogPipelineTest(unittest.TestCase):
    def test_bom_and_leading_zero_ticker_are_preserved(self):
        source = parsed(company_csv([("1151007", "0050", "測試公司", "測試")]))
        self.assertEqual(source["records"][0]["公司代號"], "0050")
        self.assertEqual(source["asOf"], "2026-10-07")
        self.assertEqual(len(source["sha256"]), 64)

    def test_big5_and_quoted_punctuation_survive(self):
        raw = company_csv([("1151007", "2330", "測試,股份\n有限公司", "測試")])
        raw = raw.decode("utf-8-sig").encode("cp950")
        self.assertEqual(parsed(raw)["records"][0]["公司名稱"], "測試,股份\n有限公司")

    def test_truncated_quotes_and_duplicate_headers_are_rejected(self):
        for raw in (company_csv() + b'"unclosed',
                    company_csv(header=("出表日期", "公司代號", "公司名稱", "公司簡稱", "公司簡稱"))):
            with self.subTest(raw=raw[:50]), self.assertRaises(catalog.CatalogError):
                parsed(raw)

    def test_duplicate_ticker_across_sources_is_rejected(self):
        with self.assertRaises(catalog.CatalogError):
            catalog.build_catalog([parsed(), parsed()], "2026-10-07T00:00:00Z")

    def test_combined_catalog_has_the_same_row_limit_as_the_browser(self):
        first = parsed()
        second = parsed(company_csv([("1151007", "2331", "測試公司", "測試")]))
        with patch.object(catalog, "MAX_ROWS", 1), self.assertRaises(catalog.CatalogError):
            catalog.build_catalog([first, second], "2026-10-07T00:00:00Z")

    def test_source_size_and_unexpected_redirects_are_rejected(self):
        with patch.object(catalog, "MAX_BYTES", 10), self.assertRaises(catalog.CatalogError):
            catalog.decode_csv(company_csv())
        for url in ("http://mopsfin.twse.com.tw/a.csv", "https://example.com/a.csv"):
            with self.subTest(url=url), self.assertRaises(catalog.CatalogError):
                catalog.OfficialRedirects().redirect_request(None, None, 302, "", {}, url)

    def test_large_input_has_bounded_row_count(self):
        rows = [("1151007", str(10000 + index), "測試股份有限公司", "測試") for index in range(catalog.MAX_ROWS)]
        source = parsed(company_csv(rows))
        self.assertEqual(source["rows"], catalog.MAX_ROWS)
        rows.append(("1151007", "29999", "測試", "測試"))
        with self.assertRaises(catalog.CatalogError):
            parsed(company_csv(rows))

    def test_supported_date_formats_and_impossible_dates(self):
        for value in ("1151007", "20261007", "115/10/07", "2026-10-07"):
            self.assertEqual(catalog.normalize_date(value, TODAY), "2026-10-07")
        for value in ("1151399", "2026-02-30", "2026-10-08", "2027-10-07", "2020-10-07", "yesterday"):
            with self.subTest(value=value), self.assertRaises(catalog.CatalogError):
                catalog.normalize_date(value, TODAY)

    def test_schema_and_row_limits_fail_closed(self):
        invalid = [b"", b"<html>blocked</html>", company_csv(header=("bad",)),
                   company_csv([("1151007", "2330", "測試", "測試"), ("1151007", "2330", "測試", "測試")]),
                   company_csv([("1151007", "2330", "測試", "測試"), ("1151006", "2331", "測試", "測試")]),
                   company_csv([("1151007", "2330", "測試")]),
                   company_csv([("1151007", "=HYPERLINK()", "測試", "測試")])]
        for raw in invalid:
            with self.subTest(raw=raw[:80]), self.assertRaises(catalog.CatalogError):
                parsed(raw)
        with self.assertRaises(catalog.CatalogError):
            catalog.parse_source(company_csv(), catalog.SOURCES[0], today=TODAY)
        with patch.object(catalog, "MAX_ROWS", 1), self.assertRaises(catalog.CatalogError):
            parsed(company_csv([("1151007", "2330", "測試", "測試"), ("1151007", "2331", "測試", "測試")]))

    def test_unknown_products_have_no_guessed_tax_classification(self):
        result = catalog.build_catalog([parsed(company_csv([("1151007", "9105", "測試外國公司", "測試-DR")]))], "2026-10-07T00:00:00Z")
        self.assertEqual(result["securities"][0]["type"], "unsupported")
        self.assertEqual(result["securities"][0]["currency"], "unknown")
        self.assertEqual(result["schemaVersion"], 1)

    def test_company_membership_and_code_rule_are_both_required(self):
        for ticker, name, expected in (("2330", "測試", "stock"), ("9105", "測試", "unsupported"),
                                       ("911608", "測試", "unsupported"), ("2330A", "測試", "unsupported"),
                                       ("1234", "測試-DR", "unsupported"), ("1234", "測試存託", "unsupported")):
            with self.subTest(ticker=ticker, name=name):
                row = {"公司代號": ticker, "公司名稱": name, "公司簡稱": name}
                self.assertEqual(catalog.classify_company(row)[0], expected)

    def test_fund_classification_requires_a_known_type_and_compatible_code(self):
        cases = [
            ("00662", "國外成分證券指數股票型基金", "測試指數基金", "equityETF", "TWD"),
            ("00710B", "國外成分證券指數股票型基金", "測試美元債券ETF基金", "bondETF", "TWD"),
            ("00865B", "國外成分證券指數股票型基金", "測試美國公債ETF基金", "bondETF", "TWD"),
            ("00985B", "國外成分證券指數股票型基金", "測試公司債ETF基金", "bondETF", "TWD"),
            ("00710B", "國外成分證券指數股票型基金", "測試股票基金", "unsupported", "unknown"),
            ("00710B", "國外成分證券指數股票型基金", "測試單日債券基金", "unsupported", "unknown"),
            ("00675L", "槓桿/反向指數股票型基金", "測試單日股票正二", "otherETF", "TWD"),
            ("00680L", "槓桿/反向指數股票型基金", "測試債券正二", "otherETF", "TWD"),
            ("00635U", "指數股票型期貨信託基金", "測試黃金期貨", "otherETF", "TWD"),
            ("00981A", "國內成分證券主動式交易所交易基金(股票)", "測試主動式ETF", "equityETF", "TWD"),
            ("00982D", "國外成分證券主動式交易所交易基金(債券)", "測試主動式債ETF", "bondETF", "TWD"),
            ("00981T", "國外成分證券平衡型指數股票型基金", "測試平衡ETF", "otherETF", "TWD"),
            ("00625K", "國外成份/加掛外幣證券指數股票型基金", "測試人民幣ETF", "unsupported", "foreign"),
            ("00774C", "國外成份/加掛外幣證券指數股票型基金", "測試債券ETF", "unsupported", "foreign"),
            ("0061", "連結式證券指數股票型基金", "測試ETF", "otherETF", "TWD"),
            ("0080", "境外指數股票型基金", "測試ETF", "otherETF", "TWD"),
            ("00981A", "全新未知ETF種類", "測試主動式ETF", "unsupported", "unknown"),
            ("00982B", "國外成分證券主動式交易所交易基金(股票)", "測試債券ETF", "unsupported", "unknown"),
        ]
        for ticker, kind, name, expected, currency in cases:
            with self.subTest(ticker=ticker, kind=kind, name=name):
                row = {"基金代號": ticker, "基金類型": kind, "基金中文名稱": name}
                self.assertEqual(catalog.classify_fund(row), (expected, currency))

    def test_official_encoded_names_are_decoded_as_plain_text(self):
        self.assertEqual(catalog.clean_name("元大S&amp;P500"), "元大S&P500")
        self.assertEqual(catalog.clean_name("證券投資信託基&#63754;"), "證券投資信託基金")
        self.assertEqual(catalog.clean_name("&lt;script&gt;"), "<script>")
        for name in ("", "   ", "A" * 301, "𠮷" * 151, "名\x00稱", "名\x7f稱"):
            with self.subTest(name=name[:30]), self.assertRaises(catalog.CatalogError):
                catalog.clean_name(name)
        with self.assertRaises(catalog.CatalogError):
            catalog.clean_name("A" * 101, 100)

    def test_review_summary_shows_unknown_types_and_semantic_changes(self):
        source = parsed()
        candidate = catalog.build_catalog([source], "2026-10-07T00:00:00Z")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "previous.json"
            prior = json.loads(json.dumps(candidate))
            prior["securities"][0]["shortName"] = "舊簡稱"
            path.write_text(json.dumps(prior), encoding="utf-8")
            review = catalog.review_summary(candidate, [source], path)
            self.assertEqual(review["comparison"]["changedTickers"], ["2330"])
            self.assertEqual(review["comparison"]["addedTickers"], [])
            unknown = {"id": "twse-funds", "records": [{"基金類型": "未核對的新類別"}]}
            review = catalog.review_summary(candidate, [source, unknown], path)
            self.assertEqual(review["unknownFundTypes"], {"未核對的新類別": 1})

    def test_atomic_write_preserves_previous_catalog_on_serialization_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "catalog.json"
            target.write_text('{"existing": true}', encoding="utf-8")
            with self.assertRaises(TypeError):
                catalog.write_json(target, {"bad": object()})
            self.assertEqual(json.loads(target.read_text()), {"existing": True})
            self.assertEqual(len(list(Path(directory).iterdir())), 1)


if __name__ == "__main__":
    unittest.main()
