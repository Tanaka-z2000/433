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

    def test_supported_date_formats_and_impossible_dates(self):
        for value in ("1151007", "20261007", "115/10/07", "2026-10-07"):
            self.assertEqual(catalog.normalize_date(value, TODAY), "2026-10-07")
        for value in ("1151399", "2026-02-30", "2027-10-07", "2020-10-07", "yesterday"):
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
        result = catalog.build_catalog([parsed()], "2026-10-07T00:00:00Z")
        self.assertEqual(result["securities"][0]["type"], "unsupported")
        self.assertEqual(result["securities"][0]["currency"], "unknown")
        self.assertEqual(result["schemaVersion"], 1)

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
