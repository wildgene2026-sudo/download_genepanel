from __future__ import annotations

import io
import unittest
import zipfile
from datetime import datetime, timezone

from flask_app.core import (
    DownloadJob,
    EXPORT_HEADERS,
    ReferenceBridgeError,
    build_panel_workbook,
    count_entity_types,
    panel_download_filename,
    panel_workbook_cell_type,
    parse_panel_export,
    safe_filename_component,
)


def export_row(entity_name="GENE1", entity_type="gene", status="3", version="1.2"):
    row = [""] * len(EXPORT_HEADERS)
    row[EXPORT_HEADERS.index("Entity Name")] = entity_name
    row[EXPORT_HEADERS.index("Entity type")] = entity_type
    row[EXPORT_HEADERS.index("Gene Symbol")] = entity_name
    row[EXPORT_HEADERS.index("Phenotypes")] = "Quoted\tphenotype"
    row[EXPORT_HEADERS.index("Flagged")] = "false"
    row[EXPORT_HEADERS.index("GEL_Status")] = status
    row[EXPORT_HEADERS.index("version")] = version
    row[EXPORT_HEADERS.index("ready")] = "true"
    return row


def tsv(rows):
    output = io.StringIO(newline="")
    import csv
    writer = csv.writer(output, delimiter="\t", lineterminator="\r\n", quoting=csv.QUOTE_MINIMAL)
    writer.writerow(EXPORT_HEADERS)
    writer.writerows(rows)
    return output.getvalue()


class PanelContractTests(unittest.TestCase):
    def test_filters_to_green_supported_entity_types(self):
        rows, rejected = parse_panel_export(
            tsv([
                export_row("GENE1", "gene", "3"),
                export_row("STR1", "str", "4"),
                export_row("REGION1", "region", "3"),
                export_row("AMBER", "gene", "2"),
                export_row("OTHER", "something", "4"),
            ])
        )
        self.assertEqual(count_entity_types(rows), {"gene": 1, "str": 1, "region": 1})
        self.assertEqual(len(rejected), 2)
        self.assertEqual(rows[0][EXPORT_HEADERS.index("Phenotypes")], "Quoted\tphenotype")

    def test_rejects_shifted_contract(self):
        broken = list(EXPORT_HEADERS)
        broken[-1] = "Changed"
        with self.assertRaisesRegex(ReferenceBridgeError, "header mismatch"):
            parse_panel_export("\t".join(broken) + "\n")

    def test_filename_contract(self):
        date = datetime(2026, 8, 2, tzinfo=timezone.utc)
        self.assertEqual(
            panel_download_filename("Example panel", "UK", "4.1", date),
            "Example panel (Version 4.1) green.downloaded on 260802.xlsx",
        )
        self.assertEqual(
            panel_download_filename("Example panel", "AU", "4.1", date),
            "AUSTRALIA.Example panel (Version 4.1) green.downloaded on 260802.xlsx",
        )
        self.assertEqual(safe_filename_component("../bad/name"), "bad name")

    def test_workbook_has_manual_compatible_package_and_types(self):
        row = export_row()
        row[EXPORT_HEADERS.index("Omim")] = "12345"
        row[EXPORT_HEADERS.index("Description")] = "=NOT_A_FORMULA _x000B_"
        workbook = build_panel_workbook([row], datetime(2026, 8, 2, tzinfo=timezone.utc))
        with zipfile.ZipFile(io.BytesIO(workbook)) as archive:
            self.assertEqual(
                set(archive.namelist()),
                {
                    "[Content_Types].xml",
                    "_rels/",
                    "_rels/.rels",
                    "docProps/",
                    "docProps/app.xml",
                    "docProps/core.xml",
                    "xl/",
                    "xl/workbook.xml",
                    "xl/_rels/",
                    "xl/_rels/workbook.xml.rels",
                    "xl/styles.xml",
                    "xl/sharedStrings.xml",
                    "xl/worksheets/",
                    "xl/worksheets/sheet1.xml",
                },
            )
            sheet = archive.read("xl/worksheets/sheet1.xml").decode()
            strings = archive.read("xl/sharedStrings.xml").decode()
            self.assertIn('<dimension ref="A1:AJ2"/>', sheet)
            self.assertIn('<c r="J2"><v>12345</v></c>', sheet)
            self.assertIn('<c r="O2" t="b"><v>0</v></c>', sheet)
            self.assertIn('<c r="S2" t="b"><v>1</v></c>', sheet)
            self.assertIn("=NOT_A_FORMULA _x005F_x000B_", strings)

    def test_cell_types_are_strictly_allowlisted(self):
        self.assertEqual(panel_workbook_cell_type("Omim", "123"), "number")
        self.assertEqual(panel_workbook_cell_type("Description", "123"), "string")
        self.assertEqual(panel_workbook_cell_type("Flagged", "false"), "boolean")
        self.assertEqual(panel_workbook_cell_type("Flagged", "0"), "string")

    def test_job_status_is_serializable_without_internal_locks(self):
        job = DownloadJob(id="test", kind="uk")
        payload = job.public()
        self.assertEqual(payload["id"], "test")
        self.assertEqual(payload["counts"], {"gene": 0, "str": 0, "region": 0})
        self.assertNotIn("output_path", payload)


if __name__ == "__main__":
    unittest.main()
