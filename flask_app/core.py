from __future__ import annotations

import csv
import hashlib
import io
import json
import os
import random
import re
import ssl
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any, Iterable
from xml.sax.saxutils import escape as xml_escape


EXPORT_HEADERS = (
    "Entity Name",
    "Entity type",
    "Gene Symbol",
    "Sources(; separated)",
    "Level4",
    "Level3",
    "Level2",
    "Model_Of_Inheritance",
    "Phenotypes",
    "Omim",
    "Orphanet",
    "HPO",
    "Publications",
    "Description",
    "Flagged",
    "GEL_Status",
    "UserRatings_Green_amber_red",
    "version",
    "ready",
    "Mode of pathogenicity",
    "EnsemblId(GRch37)",
    "EnsemblId(GRch38)",
    "HGNC",
    "Position Chromosome",
    "Position GRCh37 Start",
    "Position GRCh37 End",
    "Position GRCh38 Start",
    "Position GRCh38 End",
    "STR Repeated Sequence",
    "STR Normal Repeats",
    "STR Pathogenic Repeats",
    "Region Haploinsufficiency Score",
    "Region Triplosensitivity Score",
    "Region Required Overlap Percentage",
    "Region Variant Type",
    "Region Verbose Name",
)

PANELAPP_SOURCES = {
    "UK": {
        "label": "PanelApp UK",
        "api_base": "https://panelapp.genomicsengland.co.uk/api/v1",
        "web_base": "https://panelapp.genomicsengland.co.uk",
    },
    "AU": {
        "label": "PanelApp Australia",
        "api_base": "https://panelapp-aus.org/api/v1",
        "web_base": "https://panelapp-aus.org",
    },
}

GREEN_LEVELS = {"3", "4"}
ENTITY_TYPES = {"gene", "str", "region"}
BOOLEAN_HEADERS = {"Flagged", "ready"}
NUMERIC_CAPABLE_HEADERS = {
    "Omim",
    "Orphanet",
    "Publications",
    "GEL_Status",
    "version",
    "Position Chromosome",
    "Position GRCh37 Start",
    "Position GRCh37 End",
    "Position GRCh38 Start",
    "Position GRCh38 End",
    "STR Normal Repeats",
    "STR Pathogenic Repeats",
    "Region Haploinsufficiency Score",
    "Region Triplosensitivity Score",
    "Region Required Overlap Percentage",
}
STRICT_NUMBER = re.compile(r"^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$")
EXCEL_ESCAPE_TOKEN = re.compile(r"_x[0-9a-f]{4}_", re.IGNORECASE)
ILLEGAL_XML = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]")
VERSION_PATTERN = re.compile(r"^\d+(?:\.\d+)?$")
PANEL_ID_PATTERN = re.compile(r"^\d{1,8}$")

STATUS_COLUMN = EXPORT_HEADERS.index("GEL_Status")
TYPE_COLUMN = EXPORT_HEADERS.index("Entity type")
VERSION_COLUMN = EXPORT_HEADERS.index("version")


class ReferenceBridgeError(RuntimeError):
    """A safe, user-displayable error."""


class CancelledError(ReferenceBridgeError):
    pass


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso_timestamp(value: datetime | None = None) -> str:
    return (value or utc_now()).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def yymmdd(value: datetime | None = None) -> str:
    return (value or datetime.now()).strftime("%y%m%d")


def safe_filename_component(value: Any) -> str:
    cleaned = re.sub(r'[\\/:*?"<>|\x00-\x1f]', " ", str(value or ""))
    cleaned = cleaned.replace("..", " ")
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned or "unknown"


def panel_download_filename(panel_name: str, source: str, version: str, value: datetime | None = None) -> str:
    if source not in PANELAPP_SOURCES:
        raise ReferenceBridgeError(f"Unknown PanelApp source: {source}")
    prefix = "AUSTRALIA." if source == "AU" else ""
    return (
        f"{prefix}{safe_filename_component(panel_name)} "
        f"(Version {safe_filename_component(version)}) green.downloaded on {yymmdd(value)}.xlsx"
    )


def parse_panel_export(text: str) -> tuple[list[list[str]], list[dict[str, Any]]]:
    try:
        parsed = list(csv.reader(io.StringIO(str(text or ""), newline=""), delimiter="\t", strict=True))
    except csv.Error as exc:
        raise ReferenceBridgeError(f"PanelApp export could not be parsed: {exc}") from exc
    if not parsed:
        raise ReferenceBridgeError("PanelApp export was empty")
    header = [value.strip().lstrip("\ufeff") for value in parsed[0]]
    if tuple(header) != EXPORT_HEADERS:
        raise ReferenceBridgeError(
            f"PanelApp export header mismatch: expected {len(EXPORT_HEADERS)} columns, received {len(header)}"
        )

    accepted: list[list[str]] = []
    rejected: list[dict[str, Any]] = []
    for row_number, row in enumerate(parsed[1:], start=2):
        if not any(value.strip() for value in row):
            continue
        if len(row) != len(EXPORT_HEADERS):
            raise ReferenceBridgeError(
                f"PanelApp export row {row_number} has {len(row)} columns; expected {len(EXPORT_HEADERS)}"
            )
        status = row[STATUS_COLUMN].strip()
        entity_type = row[TYPE_COLUMN].strip().lower()
        if status in GREEN_LEVELS and entity_type in ENTITY_TYPES:
            accepted.append(row)
        else:
            rejected.append({"row": row_number, "status": status, "entityType": entity_type})
    return accepted, rejected


def assert_panel_export_version(text: str, expected_version: str) -> None:
    expected = str(expected_version or "").strip()
    if not VERSION_PATTERN.fullmatch(expected):
        raise ReferenceBridgeError("Invalid expected PanelApp version")
    try:
        rows = list(csv.reader(io.StringIO(str(text or ""), newline=""), delimiter="\t", strict=True))
    except csv.Error as exc:
        raise ReferenceBridgeError(f"PanelApp export could not be parsed: {exc}") from exc
    header = [value.strip().lstrip("\ufeff") for value in rows[0]] if rows else []
    if tuple(header) != EXPORT_HEADERS:
        raise ReferenceBridgeError("PanelApp export header mismatch while checking its version")
    observed: set[str] = set()
    for row_number, row in enumerate(rows[1:], start=2):
        if not any(value.strip() for value in row):
            continue
        if len(row) != len(EXPORT_HEADERS):
            raise ReferenceBridgeError(
                f"PanelApp export row {row_number} has {len(row)} columns; expected {len(EXPORT_HEADERS)}"
            )
        version = row[VERSION_COLUMN].strip()
        if version:
            observed.add(version)
    if len(observed) > 1 or (len(observed) == 1 and expected not in observed):
        received = ", ".join(sorted(observed)) or "unknown"
        raise ReferenceBridgeError(f"PanelApp export version mismatch: expected {expected}, received {received}")


def count_entity_types(rows: Iterable[list[str]]) -> dict[str, int]:
    counts = {"gene": 0, "str": 0, "region": 0}
    for row in rows:
        entity_type = row[TYPE_COLUMN].strip().lower()
        if entity_type in counts:
            counts[entity_type] += 1
    return counts


def _excel_xml_escape(value: Any) -> str:
    text = str(value or "")
    text = EXCEL_ESCAPE_TOKEN.sub(lambda match: f"_x005F_{match.group(0)[1:]}", text)
    text = ILLEGAL_XML.sub(lambda match: f"_x{ord(match.group(0)):04X}_", text)
    return xml_escape(text, {'"': "&quot;", "'": "&apos;"})


def _column_name(index: int) -> str:
    number = index + 1
    name = ""
    while number > 0:
        number, remainder = divmod(number - 1, 26)
        name = chr(65 + remainder) + name
    return name


def panel_workbook_cell_type(header: str, raw_value: Any) -> str:
    value = str(raw_value or "")
    if not value:
        return "blank"
    if header in BOOLEAN_HEADERS and value.lower() in {"true", "false"}:
        return "boolean"
    if header in NUMERIC_CAPABLE_HEADERS and STRICT_NUMBER.fullmatch(value):
        return "number"
    return "string"


def _number_text(raw_value: Any) -> str:
    value = float(str(raw_value))
    if value == 0:
        return "0"
    if value.is_integer():
        return str(int(value))
    return format(value, ".15g")


def build_panel_workbook(rows: list[list[str]], generated_at: datetime | None = None) -> bytes:
    values = [list(EXPORT_HEADERS), *rows]
    for index, row in enumerate(values, start=1):
        if not isinstance(row, list) or len(row) != len(EXPORT_HEADERS):
            length = len(row) if isinstance(row, list) else "no"
            raise ReferenceBridgeError(
                f"Workbook row {index} has {length} columns; expected {len(EXPORT_HEADERS)}"
            )

    strings: list[str] = []
    string_indexes: dict[str, int] = {}
    string_count = 0

    def get_string_index(raw: Any) -> int:
        nonlocal string_count
        value = str(raw or "")
        if value not in string_indexes:
            string_indexes[value] = len(strings)
            strings.append(value)
        string_count += 1
        return string_indexes[value]

    row_parts: list[str] = []
    for row_index, row in enumerate(values, start=1):
        cells: list[str] = []
        for column_index, value in enumerate(row):
            if value is None or value == "":
                continue
            cell_ref = f"{_column_name(column_index)}{row_index}"
            if row_index > 1:
                cell_type = panel_workbook_cell_type(EXPORT_HEADERS[column_index], value)
                if cell_type == "boolean":
                    bool_value = 1 if str(value).lower() == "true" else 0
                    cells.append(f'<c r="{cell_ref}" t="b"><v>{bool_value}</v></c>')
                    continue
                if cell_type == "number":
                    cells.append(f'<c r="{cell_ref}"><v>{_number_text(value)}</v></c>')
                    continue
            cells.append(f'<c r="{cell_ref}" t="s"><v>{get_string_index(value)}</v></c>')
        row_parts.append(
            f'<row r="{row_index}" spans="1:{len(EXPORT_HEADERS)}" x14ac:dyDescent="0.25">'
            f'{"".join(cells)}</row>'
        )

    last_row = max(len(values), 1)
    dimension = f"A1:AJ{last_row}"
    shared_strings = "".join(
        f'<si><t xml:space="preserve">{_excel_xml_escape(value)}</t></si>' for value in strings
    )
    created = iso_timestamp(generated_at)
    files = {
        "[Content_Types].xml": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>',
        "_rels/.rels": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>',
        "docProps/app.xml": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>HPO &amp; PanelApp Reference Downloader</Application><DocSecurity>0</DocSecurity><ScaleCrop>false</ScaleCrop><HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>Worksheets</vt:lpstr></vt:variant><vt:variant><vt:i4>1</vt:i4></vt:variant></vt:vector></HeadingPairs><TitlesOfParts><vt:vector size="1" baseType="lpstr"><vt:lpstr>Sheet1</vt:lpstr></vt:vector></TitlesOfParts><Company></Company><LinksUpToDate>false</LinksUpToDate><SharedDoc>false</SharedDoc><HyperlinksChanged>false</HyperlinksChanged><AppVersion>1.0</AppVersion></Properties>',
        "docProps/core.xml": f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>HPO &amp; PanelApp Reference Downloader</dc:creator><cp:lastModifiedBy>HPO &amp; PanelApp Reference Downloader</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">{created}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">{created}</dcterms:modified></cp:coreProperties>',
        "xl/workbook.xml": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView xWindow="0" yWindow="0" windowWidth="24000" windowHeight="12000"/></bookViews><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets><calcPr calcId="0"/></workbook>',
        "xl/_rels/workbook.xml.rels": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>',
        "xl/styles.xml": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><color rgb="FF000000"/><name val="Arial"/><family val="2"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles><dxfs count="0"/><tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/></styleSheet>',
        "xl/sharedStrings.xml": f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="{string_count}" uniqueCount="{len(strings)}">{shared_strings}</sst>',
        "xl/worksheets/sheet1.xml": f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:x14ac="http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac" mc:Ignorable="x14ac"><dimension ref="{dimension}"/><sheetViews><sheetView tabSelected="1" workbookViewId="0"><selection activeCell="A1" sqref="A1"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15.75" x14ac:dyDescent="0.25"/><sheetData>{"".join(row_parts)}</sheetData><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>',
    }

    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as workbook:
        ordered_names = [
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
        ]
        for name in ordered_names:
            if name.endswith("/"):
                workbook.writestr(name, b"")
                continue
            content = files[name]
            workbook.writestr(name, content.encode("utf-8"))
    return output.getvalue()


class RemoteClient:
    USER_AGENT = "HPO-PanelApp-Reference-Downloader-Flask/1.0"
    RETRIES = 5
    TIMEOUT_SECONDS = 25
    PANELAPP_MIN_INTERVAL_SECONDS = 1.0
    MAX_RETRY_AFTER_SECONDS = 5 * 60

    def __init__(self, cache_dir: Path):
        self.cache_dir = cache_dir
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self._origin_locks: dict[str, threading.Lock] = {}
        self._next_allowed: dict[str, float] = {}
        self._state_lock = threading.Lock()
        configured_ca = os.environ.get("SSL_CERT_FILE")
        ca_candidates = [
            configured_ca,
            "/etc/ssl/cert.pem",
            "/etc/ssl/certs/ca-certificates.crt",
        ]
        ca_file = next((candidate for candidate in ca_candidates if candidate and Path(candidate).is_file()), None)
        self._ssl_context = ssl.create_default_context(cafile=ca_file) if ca_file else ssl.create_default_context()

    def _origin_lock(self, origin: str) -> threading.Lock:
        with self._state_lock:
            return self._origin_locks.setdefault(origin, threading.Lock())

    def _retry_delay(self, headers: Any, attempt: int) -> float:
        retry_after = str(headers.get("Retry-After", "")).strip()
        if retry_after:
            try:
                seconds = float(retry_after)
            except ValueError:
                try:
                    seconds = parsedate_to_datetime(retry_after).timestamp() - time.time()
                except (TypeError, ValueError, OverflowError):
                    seconds = 0
            if seconds > 0:
                if seconds > self.MAX_RETRY_AFTER_SECONDS:
                    raise ReferenceBridgeError(
                        "PanelApp requested a cooldown longer than five minutes; download stopped without retrying early"
                    )
                return seconds
        return (2**attempt) + random.random() * 0.5

    def request(
        self,
        url: str,
        *,
        accept: str,
        minimum_interval: float = 0,
        maximum_bytes: int | None = None,
    ) -> tuple[bytes, Any]:
        parsed = urllib.parse.urlsplit(url)
        origin = f"{parsed.scheme}://{parsed.netloc}"
        lock = self._origin_lock(origin)
        last_error: Exception | None = None
        for attempt in range(self.RETRIES):
            delay = float(2**attempt)
            try:
                with lock:
                    wait_for = max(0.0, self._next_allowed.get(origin, 0.0) - time.monotonic())
                    if wait_for > self.MAX_RETRY_AFTER_SECONDS:
                        raise ReferenceBridgeError(
                            f"PanelApp cooldown is active; retry after {int(wait_for + 0.999)} seconds"
                        )
                    if wait_for:
                        time.sleep(wait_for)
                    request = urllib.request.Request(
                        url,
                        headers={"Accept": accept, "User-Agent": self.USER_AGENT},
                    )
                    cooldown = minimum_interval
                    try:
                        with urllib.request.urlopen(
                            request,
                            timeout=self.TIMEOUT_SECONDS,
                            context=self._ssl_context,
                        ) as response:
                            content_length = int(response.headers.get("Content-Length", "0") or 0)
                            if maximum_bytes and content_length > maximum_bytes:
                                raise ReferenceBridgeError("Upstream response exceeded the safety limit")
                            body = response.read((maximum_bytes + 1) if maximum_bytes else None)
                            if maximum_bytes and len(body) > maximum_bytes:
                                raise ReferenceBridgeError("Upstream response exceeded the safety limit")
                            return body, response.headers
                    except urllib.error.HTTPError as exc:
                        if exc.code != 429 and exc.code < 500:
                            raise ReferenceBridgeError(f"Upstream request returned HTTP {exc.code}") from exc
                        delay = self._retry_delay(exc.headers, attempt)
                        cooldown = max(cooldown, delay if exc.code == 429 else 0)
                        last_error = ReferenceBridgeError(f"Upstream request returned HTTP {exc.code}")
                    finally:
                        self._next_allowed[origin] = max(
                            self._next_allowed.get(origin, 0.0), time.monotonic() + cooldown
                        )
            except ReferenceBridgeError:
                raise
            except (TimeoutError, urllib.error.URLError, OSError) as exc:
                last_error = exc
            if attempt < self.RETRIES - 1:
                time.sleep(delay)
        message = str(last_error) if last_error else "unknown error"
        raise ReferenceBridgeError(f"Upstream request failed after {self.RETRIES} attempts: {message}")

    def get_json(self, url: str, *, minimum_interval: float = 0) -> Any:
        body, _ = self.request(
            url,
            accept="application/json",
            minimum_interval=minimum_interval,
            maximum_bytes=5_000_000,
        )
        try:
            return json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ReferenceBridgeError(f"Upstream returned invalid JSON: {exc}") from exc

    def list_panels(self, source: str) -> list[dict[str, Any]]:
        config = PANELAPP_SOURCES.get(source)
        if not config:
            raise ReferenceBridgeError(f"Unknown PanelApp source: {source}")
        allowed = urllib.parse.urlsplit(config["api_base"])
        next_url: str | None = f'{config["api_base"]}/panels/?format=json&page_size=100'
        panels: list[dict[str, Any]] = []
        seen: set[int] = set()
        expected_count: int | None = None
        page_count = 0
        while next_url:
            page_count += 1
            if page_count > 25:
                raise ReferenceBridgeError("PanelApp pagination exceeded the safety limit")
            page_url = urllib.parse.urlsplit(next_url)
            if (
                page_url.scheme != allowed.scheme
                or page_url.netloc != allowed.netloc
                or not page_url.path.startswith(f'{allowed.path}/panels/')
            ):
                raise ReferenceBridgeError("PanelApp pagination left the allowlisted API endpoint")
            data = self.get_json(next_url, minimum_interval=self.PANELAPP_MIN_INTERVAL_SECONDS)
            if not isinstance(data.get("results"), list):
                raise ReferenceBridgeError("PanelApp list response has no results array")
            reported_count = data.get("count")
            if not isinstance(reported_count, int) or not 1 <= reported_count <= 2_000:
                raise ReferenceBridgeError("PanelApp list response reported an invalid panel count")
            if expected_count is None:
                expected_count = reported_count
            elif reported_count != expected_count:
                raise ReferenceBridgeError("PanelApp panel count changed during pagination")
            for item in data["results"]:
                panel_id = item.get("id")
                if not isinstance(panel_id, int) or panel_id < 1:
                    raise ReferenceBridgeError("PanelApp returned an invalid panel id")
                if panel_id in seen:
                    raise ReferenceBridgeError(f"PanelApp returned duplicate panel id {panel_id}")
                seen.add(panel_id)
                stats = item.get("stats") or {}
                panels.append(
                    {
                        "id": panel_id,
                        "name": str(item.get("name") or ""),
                        "version": str(item.get("version") or ""),
                        "status": str(item.get("status") or ""),
                        "stats": {
                            "genes": int(stats.get("number_of_genes") or 0),
                            "strs": int(stats.get("number_of_strs") or 0),
                            "regions": int(stats.get("number_of_regions") or 0),
                        },
                    }
                )
            next_value = data.get("next")
            next_url = next_value if isinstance(next_value, str) and next_value else None
            if expected_count is not None and len(panels) > expected_count:
                raise ReferenceBridgeError("PanelApp list exceeded its reported count")
        if not expected_count or len(panels) != expected_count:
            raise ReferenceBridgeError(
                f"PanelApp list was incomplete: expected {expected_count or 'unknown'}, received {len(panels)}"
            )
        return sorted(panels, key=lambda panel: panel["name"].casefold())

    def fetch_panel_export(self, source: str, panel_id: Any, expected_version: Any) -> str:
        config = PANELAPP_SOURCES.get(source)
        identifier = str(panel_id or "")
        version = str(expected_version or "").strip()
        if not config:
            raise ReferenceBridgeError(f"Unknown PanelApp source: {source}")
        if not PANEL_ID_PATTERN.fullmatch(identifier) or int(identifier) < 1:
            raise ReferenceBridgeError("Invalid PanelApp panel id")
        if not VERSION_PATTERN.fullmatch(version):
            raise ReferenceBridgeError("Invalid PanelApp panel version")
        cache_path = self.cache_dir / "panels" / source / f"{identifier}-{safe_filename_component(version)}.tsv"
        if cache_path.is_file():
            text = cache_path.read_bytes().decode("utf-8")
            try:
                assert_panel_export_version(text, version)
                parse_panel_export(text)
                return text
            except ReferenceBridgeError:
                pass

        url = f'{config["web_base"]}/panels/{identifier}/download/34/'
        body, _ = self.request(
            url,
            accept="text/tab-separated-values,text/plain;q=0.9",
            minimum_interval=self.PANELAPP_MIN_INTERVAL_SECONDS,
            maximum_bytes=12_000_000,
        )
        text = body.decode("utf-8", errors="replace")
        lines = text.splitlines()
        if not lines or lines[0].lstrip("\ufeff") != "\t".join(EXPORT_HEADERS):
            raise ReferenceBridgeError("PanelApp returned a file that is not the canonical 36-column export")
        assert_panel_export_version(text, version)
        parse_panel_export(text)
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = cache_path.with_suffix(f".{uuid.uuid4().hex}.tmp")
        temporary.write_bytes(text.encode("utf-8"))
        os.replace(temporary, cache_path)
        return text

    def latest_hpo_release(self) -> dict[str, Any]:
        release = self.get_json(
            "https://api.github.com/repos/obophenotype/human-phenotype-ontology/releases/latest"
        )
        assets = release.get("assets") if isinstance(release.get("assets"), list) else []
        asset = next((candidate for candidate in assets if candidate.get("name") == "hp.obo"), None)
        if not asset or not asset.get("browser_download_url"):
            raise ReferenceBridgeError("The latest official HPO release has no hp.obo asset")
        digest = str(asset.get("digest") or "")
        if not re.fullmatch(r"sha256:[a-f0-9]{64}", digest, re.IGNORECASE):
            raise ReferenceBridgeError("The official hp.obo asset did not publish a SHA-256 digest")
        return {
            "tag": str(release.get("tag_name") or ""),
            "publishedAt": str(release.get("published_at") or ""),
            "size": int(asset.get("size") or 0),
            "digest": digest.lower(),
            "url": str(asset["browser_download_url"]),
        }

    def fetch_verified_hpo(self) -> tuple[bytes, dict[str, Any]]:
        release = self.latest_hpo_release()
        cache_path = self.cache_dir / "hpo" / safe_filename_component(release["tag"]) / "hp.obo"
        if cache_path.is_file():
            cached = cache_path.read_bytes()
            if self._valid_hpo(cached, release):
                return cached, release
        body, _ = self.request(
            release["url"], accept="application/octet-stream", maximum_bytes=30_000_000
        )
        if not self._valid_hpo(body, release):
            raise ReferenceBridgeError("The downloaded hp.obo failed verification")
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = cache_path.with_suffix(f".{uuid.uuid4().hex}.tmp")
        temporary.write_bytes(body)
        os.replace(temporary, cache_path)
        return body, release

    @staticmethod
    def _valid_hpo(body: bytes, release: dict[str, Any]) -> bool:
        if not 1_000_000 <= len(body) <= 30_000_000:
            return False
        if release.get("size") and len(body) != release["size"]:
            return False
        digest = f"sha256:{hashlib.sha256(body).hexdigest()}"
        if digest != release["digest"]:
            return False
        text = body.decode("utf-8", errors="replace").lower()
        return "format-version:" in text[:4_000] and "[term]" in text and "id: hp:" in text


class CatalogService:
    def __init__(self, remote: RemoteClient, ttl_seconds: int = 900):
        self.remote = remote
        self.ttl_seconds = ttl_seconds
        self._lock = threading.Lock()
        self._cached: dict[str, Any] | None = None
        self._expires_at = 0.0

    def get(self, force: bool = False) -> dict[str, Any]:
        with self._lock:
            if not force and self._cached and time.monotonic() < self._expires_at:
                return self._cached
        errors: dict[str, str] = {}
        with ThreadPoolExecutor(max_workers=3) as executor:
            futures = {
                "hpo": executor.submit(self.remote.latest_hpo_release),
                "UK": executor.submit(self.remote.list_panels, "UK"),
                "AU": executor.submit(self.remote.list_panels, "AU"),
            }
            values: dict[str, Any] = {}
            for key, future in futures.items():
                try:
                    values[key] = future.result()
                except Exception as exc:  # Returned as source-specific status.
                    values[key] = None if key == "hpo" else []
                    errors[key] = str(exc)
        result = {
            "generatedAt": iso_timestamp(),
            "hpo": values["hpo"],
            "sources": {"UK": values["UK"], "AU": values["AU"]},
            "errors": errors,
            "contract": {
                "headers": list(EXPORT_HEADERS),
                "greenLevels": ["3", "4"],
                "entityTypes": ["gene", "str", "region"],
            },
        }
        with self._lock:
            self._cached = result
            self._expires_at = time.monotonic() + self.ttl_seconds
        return result


@dataclass
class DownloadJob:
    id: str
    kind: str
    status: str = "queued"
    phase: str = "Preparing secure download"
    current: str = "Waiting for the download worker"
    completed: int = 0
    total: int = 1
    counts: dict[str, int] = field(default_factory=lambda: {"gene": 0, "str": 0, "region": 0})
    error: str = ""
    filename: str = ""
    output_path: str = ""
    created_at: str = field(default_factory=iso_timestamp)
    cancel_event: threading.Event = field(default_factory=threading.Event, repr=False)
    lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def public(self) -> dict[str, Any]:
        with self.lock:
            return {
                "id": self.id,
                "kind": self.kind,
                "status": self.status,
                "phase": self.phase,
                "current": self.current,
                "completed": self.completed,
                "total": self.total,
                "counts": dict(self.counts),
                "error": self.error,
                "filename": self.filename,
                "createdAt": self.created_at,
                "downloadReady": self.status == "ready" and bool(self.output_path),
            }

    def update(self, **changes: Any) -> None:
        with self.lock:
            for key, value in changes.items():
                setattr(self, key, value)


class JobManager:
    ALLOWED_KINDS = {"uk", "au", "complete"}

    def __init__(self, remote: RemoteClient, catalog: CatalogService, output_dir: Path):
        self.remote = remote
        self.catalog = catalog
        self.output_dir = output_dir
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self._jobs: dict[str, DownloadJob] = {}
        self._lock = threading.Lock()
        self._active_job_id: str | None = None
        self._cleanup_downloads()

    def _cleanup_downloads(self) -> None:
        cutoff = time.time() - 24 * 60 * 60
        for path in self.output_dir.glob("*.zip"):
            if re.fullmatch(r"[0-9a-f]{32}-.+\.zip", path.name) and path.stat().st_mtime < cutoff:
                path.unlink(missing_ok=True)

    def start(self, kind: str) -> DownloadJob:
        if kind not in self.ALLOWED_KINDS:
            raise ReferenceBridgeError("Download kind must be uk, au, or complete")
        self._cleanup_downloads()
        with self._lock:
            if self._active_job_id:
                active = self._jobs.get(self._active_job_id)
                if active and active.status in {"queued", "running", "cancelling"}:
                    raise ReferenceBridgeError(
                        "A reference bundle is already being prepared. Wait for it to finish or cancel it first."
                    )
            job = DownloadJob(id=uuid.uuid4().hex, kind=kind)
            self._jobs[job.id] = job
            self._active_job_id = job.id
        threading.Thread(target=self._run, args=(job,), daemon=True, name=f"reference-job-{job.id[:8]}").start()
        return job

    def get(self, job_id: str) -> DownloadJob | None:
        with self._lock:
            return self._jobs.get(job_id)

    def cancel(self, job_id: str) -> DownloadJob:
        job = self.get(job_id)
        if not job:
            raise ReferenceBridgeError("Download job was not found")
        if job.status in {"queued", "running"}:
            job.cancel_event.set()
            job.update(status="cancelling", phase="Cancelling safely", current="Stopping without saving a partial bundle")
        return job

    def _check_cancelled(self, job: DownloadJob) -> None:
        if job.cancel_event.is_set():
            raise CancelledError("Download cancelled. No partial bundle was saved.")

    def _run(self, job: DownloadJob) -> None:
        temporary: Path | None = None
        try:
            catalog = self.catalog.get()
            sources = ["UK"] if job.kind == "uk" else ["AU"] if job.kind == "au" else ["UK", "AU"]
            if any(catalog["errors"].get(source) for source in sources) or (
                job.kind == "complete" and catalog["errors"].get("hpo")
            ):
                catalog = self.catalog.get(force=True)
            for source in sources:
                if catalog["errors"].get(source) or not catalog["sources"].get(source):
                    raise ReferenceBridgeError(f"{source} catalogue is temporarily unavailable")
            if job.kind == "complete" and (catalog["errors"].get("hpo") or not catalog.get("hpo")):
                raise ReferenceBridgeError("HPO is temporarily unavailable")
            panels = [
                (source, panel)
                for source in sources
                for panel in catalog["sources"][source]
            ]
            total = len(panels) + (2 if job.kind == "complete" else 1)
            job.update(status="running", total=total, phase="Collecting canonical green exports")
            stamp = yymmdd()
            filename = (
                f"HPO-PanelApp-offline-reference-pack-{stamp}.zip"
                if job.kind == "complete"
                else f"PanelApp-UK-green-{stamp}.zip"
                if job.kind == "uk"
                else f"PanelApp-Australia-green-{stamp}.zip"
            )
            temporary = self.output_dir / f".{job.id}.part"
            final_path = self.output_dir / f"{job.id}-{filename}"
            manifest_rows = [[
                "Source", "Panel ID", "Panel", "Version", "Filename", "Genes", "STRs", "Regions",
                "Rejected non-green or unknown rows",
            ]]
            hpo_metadata: dict[str, str] | None = None
            with zipfile.ZipFile(temporary, "w", zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=True) as bundle:
                if job.kind == "complete":
                    self._check_cancelled(job)
                    job.update(phase="Verifying HPO", current="Official hp.obo")
                    hpo, release = self.remote.fetch_verified_hpo()
                    bundle.writestr("HPO/hp.obo", hpo)
                    hpo_metadata = {
                        "release": release["tag"],
                        "sha256": release["digest"].removeprefix("sha256:"),
                    }
                    job.update(completed=1, phase="Collecting canonical green exports", current="HPO verified")
                for source, panel in panels:
                    self._check_cancelled(job)
                    job.update(current=f'{"Australia" if source == "AU" else "UK"} · {panel["name"]}')
                    export_text = self.remote.fetch_panel_export(source, panel["id"], panel["version"])
                    assert_panel_export_version(export_text, panel["version"])
                    rows, rejected = parse_panel_export(export_text)
                    counts = count_entity_types(rows)
                    workbook = build_panel_workbook(rows)
                    workbook_name = panel_download_filename(panel["name"], source, panel["version"])
                    archive_name = f"PanelApp/{workbook_name}" if job.kind == "complete" else workbook_name
                    bundle.writestr(archive_name, workbook, compress_type=zipfile.ZIP_STORED)
                    with job.lock:
                        for entity_type in job.counts:
                            job.counts[entity_type] += counts[entity_type]
                        job.completed += 1
                    manifest_rows.append([
                        source,
                        str(panel["id"]),
                        panel["name"],
                        panel["version"],
                        workbook_name,
                        str(counts["gene"]),
                        str(counts["str"]),
                        str(counts["region"]),
                        str(len(rejected)),
                    ])
                    self._check_cancelled(job)

                source_summary = "; ".join(f'{source}: {len(catalog["sources"][source])} panels' for source in sources)
                readme_lines = [
                    "HPO & PanelApp Offline Reference Pack",
                    "========================================",
                    "",
                    f"Created: {iso_timestamp()}",
                    f"Panel sources: {source_summary}",
                    f'Panel rows: {job.counts["gene"]} genes; {job.counts["str"]} STRs; {job.counts["region"]} genomic regions',
                    "Selection rule: GEL_Status 3 or 4 only; entity type gene, str, or region.",
                    "Workbook layout: the canonical 36-column PanelApp website export, saved as Sheet1 in .xlsx.",
                    "",
                ]
                if hpo_metadata:
                    readme_lines.extend([
                        f'HPO release: {hpo_metadata["release"]}',
                        f'hp.obo SHA-256: {hpo_metadata["sha256"]}',
                        "",
                    ])
                readme_lines.extend([
                    "Use with PDF to HPO offline",
                    "1. Extract this ZIP.",
                    "2. Load HPO/hp.obo in the app." if job.kind == "complete" else "2. Keep your existing hp.obo, or download it separately.",
                    "3. Choose the extracted PanelApp folder as the local PanelApp folder.",
                    "",
                    "This pack contains public reference data only. No PDF, OCR text, HPO case list, or patient data was sent to build it.",
                ])
                manifest_buffer = io.StringIO(newline="")
                writer = csv.writer(manifest_buffer, lineterminator="\r\n")
                writer.writerows(manifest_rows)
                bundle.writestr("README.txt", "\r\n".join(readme_lines))
                manifest_name = "PanelApp/manifest.csv" if job.kind == "complete" else "manifest.csv"
                bundle.writestr(manifest_name, manifest_buffer.getvalue())
            self._check_cancelled(job)
            os.replace(temporary, final_path)
            temporary = None
            job.update(
                status="ready",
                phase="Download ready",
                current="Archive verified",
                completed=total,
                filename=filename,
                output_path=str(final_path),
            )
        except CancelledError as exc:
            job.update(status="cancelled", phase="Download cancelled", current=str(exc), error="")
        except Exception as exc:
            job.update(status="failed", phase="Download not completed", current="Stopped safely", error=str(exc))
        finally:
            if temporary and temporary.exists():
                temporary.unlink(missing_ok=True)
            with self._lock:
                if self._active_job_id == job.id:
                    self._active_job_id = None
