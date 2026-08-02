import fs from "node:fs/promises";
import path from "node:path";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";
import JSZip from "jszip";
import {
  EXPORT_HEADERS,
  countEntityTypes,
  panelDownloadFilename,
  parsePanelExport,
} from "../lib/panelapp.js";
import { fetchPanelExport, listPanelAppPanels } from "../lib/remote.js";
import { buildPanelWorkbook } from "../lib/xlsx.js";

const PROJECT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const MANUAL_DIR = "/Users/walter/Desktop/PanelApp";
const ITERATION = process.argv[2] || `iteration-${Date.now()}`;
const OUTPUT_DIR = path.join(PROJECT_DIR, ".validation-panelapp40", ITERATION);
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

function normalizeName(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function decodeXml(value) {
  return String(value ?? "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function columnName(index) {
  let number = index + 1;
  let name = "";
  while (number > 0) {
    name = String.fromCharCode(65 + ((number - 1) % 26)) + name;
    number = Math.floor((number - 1) / 26);
  }
  return name;
}

async function hasCanonicalManualHeader(file) {
  try {
    const zip = await JSZip.loadAsync(await fs.readFile(file));
    const sheetFile = zip.file("xl/worksheets/sheet1.xml");
    const stringsFile = zip.file("xl/sharedStrings.xml");
    if (!sheetFile || !stringsFile) return false;
    const [sheetXml, stringsXml] = await Promise.all([
      sheetFile.async("string"),
      stringsFile.async("string"),
    ]);
    const sharedStrings = [...stringsXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((match) =>
      [...match[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)]
        .map((textMatch) => decodeXml(textMatch[1]))
        .join(""),
    );
    const firstRow = sheetXml.match(/<row\b[^>]*\br="1"[^>]*>([\s\S]*?)<\/row>/)?.[1];
    if (!firstRow) return false;
    const cells = new Map();
    for (const match of firstRow.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const ref = match[1].match(/\br="([A-Z]+1)"/)?.[1];
      const sharedIndex = match[2].match(/<v>(\d+)<\/v>/)?.[1];
      if (ref && sharedIndex !== undefined) cells.set(ref, sharedStrings[Number(sharedIndex)]);
    }
    return EXPORT_HEADERS.every((header, index) => cells.get(`${columnName(index)}1`) === header);
  } catch {
    return false;
  }
}

function parseManualFilename(filename) {
  if (!filename.toLowerCase().endsWith(".xlsx")) return null;
  if (!/\bgreen\b/i.test(filename) || /green\s*(?:and|&|\+)\s*amber/i.test(filename)) return null;
  const source = filename.startsWith("AUSTRALIA.") ? "AU" : "UK";
  const withoutPrefix = source === "AU" ? filename.slice("AUSTRALIA.".length) : filename;
  const match = withoutPrefix.match(/^(.+?)\s+\(Version\s+([^)]+)\)/i);
  if (!match) return null;
  return { source, name: match[1].trim(), version: match[2].trim() };
}

function rowVolume(panel) {
  return Number(panel.stats?.genes ?? 0) + Number(panel.stats?.strs ?? 0) + Number(panel.stats?.regions ?? 0);
}

function selectTwenty(candidates) {
  const chosen = new Map();
  const add = (panel) => {
    if (panel && chosen.size < 20) chosen.set(panel.id, panel);
  };
  const descending = (selector) => [...candidates].sort((a, b) => selector(b) - selector(a) || a.name.localeCompare(b.name));
  descending(rowVolume).slice(0, 4).forEach(add);
  descending((panel) => panel.stats?.strs ?? 0).slice(0, 4).forEach(add);
  descending((panel) => panel.stats?.regions ?? 0).slice(0, 4).forEach(add);
  [...candidates].sort((a, b) => rowVolume(a) - rowVolume(b) || a.name.localeCompare(b.name)).slice(0, 3).forEach(add);
  const alphabetical = [...candidates].sort((a, b) => a.name.localeCompare(b.name));
  for (let index = 0; chosen.size < 20 && index < 20; index += 1) {
    add(alphabetical[Math.round((index * (alphabetical.length - 1)) / 19)]);
  }
  for (const panel of alphabetical) add(panel);
  if (chosen.size !== 20) throw new Error(`Only ${chosen.size} matching panels were available; expected 20`);
  return [...chosen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function expectedCellType(header, rawValue) {
  const value = String(rawValue ?? "");
  if (!value) return "blank";
  if (BOOLEAN_HEADERS.has(header) && /^(?:true|false)$/i.test(value)) return "boolean";
  if (NUMERIC_CAPABLE_HEADERS.has(header) && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) return "number";
  return "string";
}

function decodeExcelEscapes(value) {
  return String(value).replace(/_x([0-9a-f]{4})_/gi, (_token, code) =>
    String.fromCharCode(Number.parseInt(code, 16)),
  );
}

function compareCell(expected, actual, header) {
  const expectedType = expectedCellType(header, expected);
  if (expectedType === "blank") return actual === null || actual === undefined || actual === "";
  if (expectedType === "boolean") {
    return typeof actual === "boolean" && actual === /^true$/i.test(String(expected));
  }
  if (expectedType === "number") {
    return typeof actual === "number" && Number.isFinite(actual) && actual === Number(expected);
  }
  return typeof actual === "string" && decodeExcelEscapes(actual) === String(expected);
}

function typeProfile(values) {
  const profile = Object.fromEntries(EXPORT_HEADERS.map((header) => [header, { string: 0, number: 0, boolean: 0, blank: 0 }]));
  for (const row of values.slice(1)) {
    for (let column = 0; column < EXPORT_HEADERS.length; column += 1) {
      const value = row[column];
      const type = value === null || value === undefined || value === "" ? "blank" : typeof value;
      if (Object.hasOwn(profile[EXPORT_HEADERS[column]], type)) profile[EXPORT_HEADERS[column]][type] += 1;
    }
  }
  return profile;
}

async function workbookSnapshot(file, render = false, previewOutputPath = null) {
  const input = await FileBlob.load(file);
  const workbook = await SpreadsheetFile.importXlsx(input);
  const archive = await JSZip.loadAsync(await fs.readFile(file));
  const archiveEntries = Object.keys(archive.files);
  const workbookXml = await archive.file("xl/workbook.xml")?.async("string");
  const relationshipFiles = archiveEntries.filter((entry) => entry.endsWith(".rels"));
  const relationshipXml = await Promise.all(
    relationshipFiles.map((entry) => archive.file(entry).async("string")),
  );
  const packageErrors = [];
  const worksheetParts = archiveEntries.filter((entry) => /^xl\/worksheets\/sheet\d+\.xml$/.test(entry));
  if (worksheetParts.length !== 1 || worksheetParts[0] !== "xl/worksheets/sheet1.xml") {
    packageErrors.push(`expected only xl/worksheets/sheet1.xml, received ${worksheetParts.join(", ") || "none"}`);
  }
  if ((workbookXml?.match(/<sheet\b/g) ?? []).length !== 1 || /state="(?:hidden|veryHidden)"/.test(workbookXml ?? "")) {
    packageErrors.push("workbook does not contain exactly one visible sheet");
  }
  if (archiveEntries.some((entry) => /(?:vbaProject|externalLinks|embeddings)/i.test(entry))) {
    packageErrors.push("workbook contains a macro, external-link, or embedded-object part");
  }
  if (relationshipXml.some((xml) => /TargetMode="External"/i.test(xml))) {
    packageErrors.push("workbook contains an external relationship");
  }
  const sheet = workbook.worksheets.getItemAt(0);
  const used = sheet.getUsedRange(true);
  const values = used?.values ?? [];
  const formulas = used?.formulas ?? [];
  const formulaCells = formulas.flat().filter((value) => typeof value === "string" && value.startsWith("="));
  const formulaErrors = await workbook.inspect({
    kind: "match",
    searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
    options: { useRegex: true, maxResults: 50 },
    summary: "formula error scan",
  });
  let renderBytes = 0;
  let renderPath = null;
  if (render) {
    const lastPreviewRow = Math.min(Math.max(values.length, 2), 8);
    const preview = await workbook.render({
      sheetName: sheet.name,
      range: `A1:AJ${lastPreviewRow}`,
      scale: 0.65,
      format: "png",
    });
    const previewBuffer = Buffer.from(await preview.arrayBuffer());
    renderBytes = previewBuffer.byteLength;
    renderPath = previewOutputPath ?? `${file}.preview.png`;
    await fs.writeFile(renderPath, previewBuffer);
  }
  return {
    sheetName: sheet.name,
    usedAddress: used?.address ?? null,
    values,
    formulas: formulaCells.length,
    formulaErrors: formulaErrors.ndjson,
    packageErrors,
    renderBytes,
    renderPath,
    typeProfile: typeProfile(values),
  };
}

function compareRows(expectedRows, actualRows) {
  const problems = [];
  if (actualRows.length !== expectedRows.length + 1) {
    problems.push(`row count expected ${expectedRows.length + 1}, received ${actualRows.length}`);
    return problems;
  }
  for (let column = 0; column < EXPORT_HEADERS.length; column += 1) {
    if (actualRows[0]?.[column] !== EXPORT_HEADERS[column]) {
      problems.push(`header ${column + 1} expected ${EXPORT_HEADERS[column]}, received ${actualRows[0]?.[column] ?? "blank"}`);
    }
  }
  for (let row = 0; row < expectedRows.length; row += 1) {
    for (let column = 0; column < EXPORT_HEADERS.length; column += 1) {
      if (!compareCell(expectedRows[row][column], actualRows[row + 1]?.[column], EXPORT_HEADERS[column])) {
        problems.push(
          `cell ${row + 2},${column + 1} (${EXPORT_HEADERS[column]}) expected ${JSON.stringify(expectedRows[row][column])} as ${expectedCellType(EXPORT_HEADERS[column], expectedRows[row][column])}, received ${JSON.stringify(actualRows[row + 1]?.[column])} as ${typeof actualRows[row + 1]?.[column]}`,
        );
        if (problems.length >= 20) return problems;
      }
    }
  }
  return problems;
}

async function manualReferences() {
  const names = await fs.readdir(MANUAL_DIR);
  const references = new Map();
  for (const filename of names) {
    const parsed = parseManualFilename(filename);
    if (!parsed) continue;
    const file = path.join(MANUAL_DIR, filename);
    if (!(await hasCanonicalManualHeader(file))) continue;
    const stat = await fs.stat(file);
    const key = `${parsed.source}:${normalizeName(parsed.name)}`;
    const candidates = references.get(key) ?? [];
    candidates.push({ ...parsed, filename, file, mtimeMs: stat.mtimeMs });
    references.set(key, candidates);
  }
  for (const candidates of references.values()) candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return references;
}

function chooseManualReference(references, source, panel) {
  const candidates = references.get(`${source}:${normalizeName(panel.name)}`) ?? [];
  return candidates.find((candidate) => candidate.version === String(panel.version)) ?? candidates[0] ?? null;
}

async function validatePanel(entry, index) {
  const { source, panel, manual } = entry;
  const result = {
    source,
    id: panel.id,
    panel: panel.name,
    version: panel.version,
    manualFile: manual.filename,
    appErrors: [],
    manualReferenceWarnings: [],
  };
  try {
    const officialText = await fetchPanelExport(source, panel.id, panel.version);
    const parsed = parsePanelExport(officialText);
    const counts = countEntityTypes(parsed.rows);
    const filename = panelDownloadFilename(panel.name, source, panel.version);
    const sourceDir = path.join(OUTPUT_DIR, source);
    await fs.mkdir(sourceDir, { recursive: true });
    const stem = `${String(index + 1).padStart(2, "0")}-${String(panel.id)}-${normalizeName(panel.name).replace(/ /g, "-").slice(0, 80)}`;
    const tsvPath = path.join(sourceDir, `${stem}.official.tsv`);
    const xlsxPath = path.join(sourceDir, filename);
    await fs.writeFile(tsvPath, officialText, "utf8");
    const workbookBytes = await buildPanelWorkbook(parsed.rows, { generatedAt: new Date("2026-08-02T00:00:00Z") });
    await fs.writeFile(xlsxPath, workbookBytes);

    const render = index % 20 === 0 || index % 20 === 19;
    const app = await workbookSnapshot(xlsxPath, render);
    const manualSnapshot = await workbookSnapshot(
      manual.file,
      render,
      render ? `${xlsxPath}.manual-reference.preview.png` : null,
    );
    result.filename = filename;
    result.officialRows = parsed.rows.length;
    result.rejectedRows = parsed.rejected.length;
    result.counts = counts;
    result.appWorkbook = {
      sheetName: app.sheetName,
      usedAddress: app.usedAddress,
      formulas: app.formulas,
      formulaErrors: app.formulaErrors,
      packageErrors: app.packageErrors,
      renderBytes: app.renderBytes,
      renderPath: app.renderPath,
      typeProfile: app.typeProfile,
    };
    result.manualWorkbook = {
      sheetName: manualSnapshot.sheetName,
      usedAddress: manualSnapshot.usedAddress,
      formulas: manualSnapshot.formulas,
      formulaErrors: manualSnapshot.formulaErrors,
      packageErrors: manualSnapshot.packageErrors,
      renderBytes: manualSnapshot.renderBytes,
      renderPath: manualSnapshot.renderPath,
      typeProfile: manualSnapshot.typeProfile,
    };

    result.appErrors.push(...compareRows(parsed.rows, app.values));
    const expectedAddress = `A1:AJ${parsed.rows.length + 1}`;
    if (app.sheetName !== "Sheet1") result.appErrors.push(`sheet name expected Sheet1, received ${app.sheetName}`);
    if (app.usedAddress !== expectedAddress) result.appErrors.push(`used range expected ${expectedAddress}, received ${app.usedAddress}`);
    if (app.formulas !== 0) result.appErrors.push(`generated workbook contains ${app.formulas} formula cells`);
    if (!/matched 0 entries/.test(app.formulaErrors)) result.appErrors.push("generated workbook formula-error scan was not clean");
    result.appErrors.push(...app.packageErrors);
    if (parsed.rejected.length !== 0) result.appErrors.push(`official green export contained ${parsed.rejected.length} rejected rows`);

    const manualHeader = manualSnapshot.values[0] ?? [];
    if (manualHeader.length !== EXPORT_HEADERS.length || manualHeader.some((value, column) => value !== EXPORT_HEADERS[column])) {
      result.manualReferenceWarnings.push("manual workbook does not have the canonical 36-column header");
    }
    if (!manualSnapshot.usedAddress?.startsWith("A1:AJ")) {
      result.manualReferenceWarnings.push(`manual workbook used range is ${manualSnapshot.usedAddress}, not A:AJ`);
    }
    const manualTypes = manualSnapshot.typeProfile;
    for (const header of ["Flagged", "GEL_Status", "version", "ready"]) {
      const expectedType = BOOLEAN_HEADERS.has(header) ? "boolean" : "number";
      if ((manualTypes[header]?.[expectedType] ?? 0) === 0 && manualSnapshot.values.length > 1) {
        result.manualReferenceWarnings.push(`manual workbook has no native ${expectedType} values in ${header}`);
      }
    }
  } catch (error) {
    result.appErrors.push(error instanceof Error ? error.message : String(error));
  }
  return result;
}

await fs.mkdir(OUTPUT_DIR, { recursive: true });
const references = await manualReferences();
const [ukPanels, auPanels] = await Promise.all([listPanelAppPanels("UK"), listPanelAppPanels("AU")]);
const selected = [];
for (const [source, panels] of [["UK", ukPanels], ["AU", auPanels]]) {
  const candidates = panels
    .map((panel) => ({ panel, manual: chooseManualReference(references, source, panel) }))
    .filter((entry) => entry.manual);
  const selectedPanels = selectTwenty(candidates.map((entry) => entry.panel));
  for (const panel of selectedPanels) {
    selected.push({ source, panel, manual: chooseManualReference(references, source, panel) });
  }
}

const results = [];
let nextIndex = 0;
const worker = async () => {
  while (true) {
    const index = nextIndex;
    nextIndex += 1;
    if (index >= selected.length) return;
    results[index] = await validatePanel(selected[index], index);
    process.stdout.write(`${index + 1}/${selected.length} ${selected[index].source} ${selected[index].panel.name}: ${results[index].appErrors.length ? "FAIL" : "PASS"}\n`);
  }
};
await Promise.all([worker(), worker()]);

const summary = {
  iteration: ITERATION,
  generatedAt: new Date().toISOString(),
  manualDirectory: MANUAL_DIR,
  selected: {
    UK: results.filter((result) => result.source === "UK").length,
    AU: results.filter((result) => result.source === "AU").length,
  },
  appPanelsWithErrors: results.filter((result) => result.appErrors.length).length,
  appErrorCount: results.reduce((total, result) => total + result.appErrors.length, 0),
  manualReferencesWithWarnings: results.filter((result) => result.manualReferenceWarnings.length).length,
  manualReferenceWarningCount: results.reduce((total, result) => total + result.manualReferenceWarnings.length, 0),
  totals: results.reduce(
    (totals, result) => ({
      panels: totals.panels + 1,
      rows: totals.rows + (result.officialRows ?? 0),
      genes: totals.genes + (result.counts?.gene ?? 0),
      strs: totals.strs + (result.counts?.str ?? 0),
      regions: totals.regions + (result.counts?.region ?? 0),
    }),
    { panels: 0, rows: 0, genes: 0, strs: 0, regions: 0 },
  ),
  results,
};
await fs.writeFile(path.join(OUTPUT_DIR, "report.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
await fs.writeFile(
  path.join(OUTPUT_DIR, "selection.json"),
  `${JSON.stringify(selected.map(({ source, panel, manual }) => ({ source, panel, manualFile: manual.filename })), null, 2)}\n`,
  "utf8",
);
process.stdout.write(`${JSON.stringify({ output: OUTPUT_DIR, appPanelsWithErrors: summary.appPanelsWithErrors, appErrorCount: summary.appErrorCount, manualReferencesWithWarnings: summary.manualReferencesWithWarnings, totals: summary.totals })}\n`);
process.exitCode = summary.appErrorCount === 0 ? 0 : 1;
