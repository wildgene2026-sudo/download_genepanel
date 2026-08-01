export const EXPORT_HEADERS = Object.freeze([
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
]);

export const PANELAPP_SOURCES = Object.freeze({
  UK: Object.freeze({
    label: "PanelApp UK",
    apiBase: "https://panelapp.genomicsengland.co.uk/api/v1",
    webBase: "https://panelapp.genomicsengland.co.uk",
  }),
  AU: Object.freeze({
    label: "PanelApp Australia",
    apiBase: "https://panelapp-aus.org/api/v1",
    webBase: "https://panelapp-aus.org",
  }),
});

export const GREEN_LEVELS = Object.freeze(new Set(["3", "4"]));
export const ENTITY_TYPES = Object.freeze(new Set(["gene", "str", "region"]));

const STATUS_COLUMN = EXPORT_HEADERS.indexOf("GEL_Status");
const TYPE_COLUMN = EXPORT_HEADERS.indexOf("Entity type");

export function safeFilenameComponent(value) {
  const cleaned = String(value ?? "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\.\./g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || "unknown";
}

export function yymmdd(date = new Date()) {
  const year = String(date.getFullYear()).slice(-2);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

export function panelDownloadFilename(panelName, source, version, date = new Date()) {
  if (!PANELAPP_SOURCES[source]) {
    throw new Error(`Unknown PanelApp source: ${source}`);
  }
  const prefix = source === "AU" ? "AUSTRALIA." : "";
  return `${prefix}${safeFilenameComponent(panelName)} (Version ${safeFilenameComponent(version)}) green.downloaded on ${yymmdd(date)}.xlsx`;
}

/**
 * Parse the site's TSV with RFC-4180-style quoting and a tab delimiter.
 * PanelApp contains quoted phenotype cells with embedded tabs, so split("\\t")
 * is not safe here.
 */
export function parseDelimited(text, delimiter = "\t") {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (!quoted && char === delimiter) {
      row.push(field);
      field = "";
      continue;
    }
    if (!quoted && (char === "\n" || char === "\r")) {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }
    field += char;
  }

  if (quoted) throw new Error("PanelApp export ended inside a quoted field");
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export function parsePanelExport(text) {
  const rawRows = parseDelimited(String(text ?? ""));
  if (!rawRows.length) throw new Error("PanelApp export was empty");

  const header = rawRows[0].map((value) => value.trim().replace(/^\uFEFF/, ""));
  if (
    header.length !== EXPORT_HEADERS.length ||
    header.some((value, index) => value !== EXPORT_HEADERS[index])
  ) {
    throw new Error(
      `PanelApp export header mismatch: expected ${EXPORT_HEADERS.length} columns, received ${header.length}`,
    );
  }

  const accepted = [];
  const rejected = [];
  for (let index = 1; index < rawRows.length; index += 1) {
    const sourceRow = rawRows[index];
    if (!sourceRow.some((value) => value.trim())) continue;
    if (sourceRow.length !== EXPORT_HEADERS.length) {
      throw new Error(
        `PanelApp export row ${index + 1} has ${sourceRow.length} columns; expected ${EXPORT_HEADERS.length}`,
      );
    }
    const row = sourceRow;
    const status = String(row[STATUS_COLUMN] ?? "").trim();
    const entityType = String(row[TYPE_COLUMN] ?? "").trim().toLowerCase();
    if (GREEN_LEVELS.has(status) && ENTITY_TYPES.has(entityType)) accepted.push(row);
    else rejected.push({ row: index + 1, status, entityType });
  }

  return { rows: accepted, rejected };
}

export function assertPanelExportVersion(text, expectedVersion) {
  const expected = String(expectedVersion ?? "").trim();
  if (!/^\d+(?:\.\d+)?$/.test(expected)) throw new Error("Invalid expected PanelApp version");

  const rawRows = parseDelimited(String(text ?? ""));
  const header = rawRows[0]?.map((value) => value.trim().replace(/^\uFEFF/, "")) ?? [];
  if (
    header.length !== EXPORT_HEADERS.length ||
    header.some((value, index) => value !== EXPORT_HEADERS[index])
  ) {
    throw new Error("PanelApp export header mismatch while checking its version");
  }

  const versionColumn = EXPORT_HEADERS.indexOf("version");
  const observed = new Set();
  for (let index = 1; index < rawRows.length; index += 1) {
    const row = rawRows[index];
    if (!row.some((value) => value.trim())) continue;
    if (row.length !== EXPORT_HEADERS.length) {
      throw new Error(
        `PanelApp export row ${index + 1} has ${row.length} columns; expected ${EXPORT_HEADERS.length}`,
      );
    }
    const version = String(row[versionColumn] ?? "").trim();
    if (version) observed.add(version);
  }

  if (observed.size > 1 || (observed.size === 1 && !observed.has(expected))) {
    throw new Error(
      `PanelApp export version mismatch: expected ${expected}, received ${Array.from(observed).join(", ") || "unknown"}`,
    );
  }
  return { expected, observed: Array.from(observed) };
}

export function countEntityTypes(rows) {
  const counts = { gene: 0, str: 0, region: 0 };
  for (const row of rows) {
    const kind = String(row[TYPE_COLUMN] ?? "").trim().toLowerCase();
    if (Object.hasOwn(counts, kind)) counts[kind] += 1;
  }
  return counts;
}

export function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
