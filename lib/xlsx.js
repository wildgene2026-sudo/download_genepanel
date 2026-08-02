import JSZip from "jszip";
import { EXPORT_HEADERS } from "./panelapp.js";

const ILLEGAL_XML = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g;
const EXCEL_ESCAPE_TOKEN = /_x[0-9a-f]{4}_/gi;
const BOOLEAN_HEADERS = new Set(["Flagged", "ready"]);
const NUMERIC_CAPABLE_HEADERS = new Set([
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
]);
const STRICT_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

function escapeXml(value) {
  return String(value ?? "")
    .replace(EXCEL_ESCAPE_TOKEN, (token) => `_x005F_${token.slice(1)}`)
    .replace(
      ILLEGAL_XML,
      (character) => `_x${character.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}_`,
    )
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function columnName(index) {
  let number = index + 1;
  let name = "";
  while (number > 0) {
    const remainder = (number - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    number = Math.floor((number - 1) / 26);
  }
  return name;
}

function isoTimestamp(date) {
  return (date instanceof Date ? date : new Date(date)).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Match the native cell types used by PanelApp's downloaded workbooks without
 * allowing arbitrary source text to be interpreted as a number or formula.
 */
export function panelWorkbookCellType(header, rawValue) {
  const value = String(rawValue ?? "");
  if (!value) return "blank";
  if (BOOLEAN_HEADERS.has(header) && /^(?:true|false)$/i.test(value)) return "boolean";
  if (NUMERIC_CAPABLE_HEADERS.has(header) && STRICT_NUMBER.test(value)) return "number";
  return "string";
}

/**
 * Build a small, standards-compliant XLSX without formula evaluation. Native
 * booleans and numbers are emitted only for PanelApp columns that use those
 * types in manual downloads. All other curator-provided content stays in shared
 * strings so it cannot become an Excel formula or be auto-converted to a date.
 */
export async function buildPanelWorkbook(rows, options = {}) {
  const generatedAt = options.generatedAt ?? new Date();
  const values = [EXPORT_HEADERS, ...rows];
  for (const [index, row] of values.entries()) {
    if (!Array.isArray(row) || row.length !== EXPORT_HEADERS.length) {
      throw new Error(
        `Workbook row ${index + 1} has ${row?.length ?? "no"} columns; expected ${EXPORT_HEADERS.length}`,
      );
    }
  }

  const strings = [];
  const stringIndex = new Map();
  let stringCount = 0;
  const getStringIndex = (raw) => {
    const value = String(raw ?? "");
    if (!stringIndex.has(value)) {
      stringIndex.set(value, strings.length);
      strings.push(value);
    }
    stringCount += 1;
    return stringIndex.get(value);
  };

  const rowXml = values
    .map((row, rowIndex) => {
      const cells = row
        .map((value, columnIndex) => {
          if (value === null || value === undefined || value === "") return "";
          const ref = `${columnName(columnIndex)}${rowIndex + 1}`;
          if (rowIndex > 0) {
            const type = panelWorkbookCellType(EXPORT_HEADERS[columnIndex], value);
            if (type === "boolean") {
              return `<c r="${ref}" t="b"><v>${/^true$/i.test(String(value)) ? 1 : 0}</v></c>`;
            }
            if (type === "number") {
              return `<c r="${ref}"><v>${Number(value)}</v></c>`;
            }
          }
          return `<c r="${ref}" t="s"><v>${getStringIndex(value)}</v></c>`;
        })
        .join("");
      return `<row r="${rowIndex + 1}" spans="1:${EXPORT_HEADERS.length}" x14ac:dyDescent="0.25">${cells}</row>`;
    })
    .join("");

  const lastRow = Math.max(values.length, 1);
  const dimension = `A1:AJ${lastRow}`;
  const sharedStrings = strings
    .map((value) => `<si><t xml:space="preserve">${escapeXml(value)}</t></si>`)
    .join("");
  const created = isoTimestamp(generatedAt);

  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`,
  );
  zip.file(
    "docProps/app.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>HPO &amp; PanelApp Reference Downloader</Application><DocSecurity>0</DocSecurity><ScaleCrop>false</ScaleCrop><HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>Worksheets</vt:lpstr></vt:variant><vt:variant><vt:i4>1</vt:i4></vt:variant></vt:vector></HeadingPairs><TitlesOfParts><vt:vector size="1" baseType="lpstr"><vt:lpstr>Sheet1</vt:lpstr></vt:vector></TitlesOfParts><Company></Company><LinksUpToDate>false</LinksUpToDate><SharedDoc>false</SharedDoc><HyperlinksChanged>false</HyperlinksChanged><AppVersion>1.0</AppVersion></Properties>`,
  );
  zip.file(
    "docProps/core.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>HPO &amp; PanelApp Reference Downloader</dc:creator><cp:lastModifiedBy>HPO &amp; PanelApp Reference Downloader</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${created}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${created}</dcterms:modified></cp:coreProperties>`,
  );
  zip.file(
    "xl/workbook.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView xWindow="0" yWindow="0" windowWidth="24000" windowHeight="12000"/></bookViews><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets><calcPr calcId="0"/></workbook>`,
  );
  zip.file(
    "xl/_rels/workbook.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
  );
  zip.file(
    "xl/styles.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><color rgb="FF000000"/><name val="Arial"/><family val="2"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles><dxfs count="0"/><tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/></styleSheet>`,
  );
  zip.file(
    "xl/sharedStrings.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${stringCount}" uniqueCount="${strings.length}">${sharedStrings}</sst>`,
  );
  zip.file(
    "xl/worksheets/sheet1.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:x14ac="http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac" mc:Ignorable="x14ac"><dimension ref="${dimension}"/><sheetViews><sheetView tabSelected="1" workbookViewId="0"><selection activeCell="A1" sqref="A1"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15.75" x14ac:dyDescent="0.25"/><sheetData>${rowXml}</sheetData><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>`,
  );

  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 6 } });
}
