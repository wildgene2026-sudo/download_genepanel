import assert from "node:assert/strict";
import test from "node:test";
import {
  EXPORT_HEADERS,
  assertPanelExportVersion,
  countEntityTypes,
  panelDownloadFilename,
  parsePanelExport,
  safeFilenameComponent,
} from "../lib/panelapp.js";

function row(overrides = {}) {
  const values = Array.from({ length: EXPORT_HEADERS.length }, () => "");
  for (const [header, value] of Object.entries(overrides)) {
    values[EXPORT_HEADERS.indexOf(header)] = String(value);
  }
  return values;
}

function quoteTsv(value) {
  return /["\t\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function exportText(rows) {
  return [EXPORT_HEADERS, ...rows].map((values) => values.map(quoteTsv).join("\t")).join("\r\n");
}

test("uses the offline app's canonical UK and Australia filenames", () => {
  const date = new Date(2026, 7, 2);
  assert.equal(
    panelDownloadFilename("Acute rhabdomyolysis", "UK", "1.21", date),
    "Acute rhabdomyolysis (Version 1.21) green.downloaded on 260802.xlsx",
  );
  assert.equal(
    panelDownloadFilename("Genetic Epilepsy", "AU", "1.426", date),
    "AUSTRALIA.Genetic Epilepsy (Version 1.426) green.downloaded on 260802.xlsx",
  );
});

test("neutralizes remote path characters in panel names and versions", () => {
  const component = safeFilenameComponent("../a/b\\c:*?\u0000");
  assert.doesNotMatch(component, /\.\.|[\\/:*?\u0000]/);
  const filename = panelDownloadFilename("../Panel", "UK", "../../1.2", new Date(2026, 7, 2));
  assert.doesNotMatch(filename, /\.\.|[\\/:*?]/);
  assert.match(filename, /\.xlsx$/);
});

test("preserves quoted tabs and keeps only green genes, STRs, and regions", () => {
  const text = exportText([
    row({ "Entity Name": "GENE1", "Entity type": "gene", GEL_Status: 3, Phenotypes: 'A "quoted"\tphenotype' }),
    row({ "Entity Name": "STR1", "Entity type": "str", GEL_Status: 4 }),
    row({ "Entity Name": "REGION1", "Entity type": "region", GEL_Status: 3 }),
    row({ "Entity Name": "AMBER1", "Entity type": "gene", GEL_Status: 2 }),
    row({ "Entity Name": "OTHER", "Entity type": "transcript", GEL_Status: 3 }),
  ]);
  const parsed = parsePanelExport(text);
  assert.equal(parsed.rows.length, 3);
  assert.equal(parsed.rows[0][EXPORT_HEADERS.indexOf("Phenotypes")], 'A "quoted"\tphenotype');
  assert.equal(parsed.rejected.length, 2);
  assert.deepEqual(countEntityTypes(parsed.rows), { gene: 1, str: 1, region: 1 });
});

test("rejects a look-alike export with a shifted or renamed header", () => {
  const badHeaders = [...EXPORT_HEADERS];
  badHeaders[0] = "Entity";
  assert.throws(() => parsePanelExport(`${badHeaders.join("\t")}\r\n`), /header mismatch/i);
});

test("rejects an over-wide data row instead of shifting clinical fields", () => {
  const tooWide = [...row({ "Entity Name": "GENE1", "Entity type": "gene", GEL_Status: 3 }), "unexpected"];
  assert.throws(() => parsePanelExport(exportText([tooWide])), /37 columns/i);
});

test("rejects a short data row instead of accepting truncated clinical fields", () => {
  const tooShort = row({ "Entity Name": "GENE1", "Entity type": "gene", GEL_Status: 3 }).slice(0, -1);
  assert.throws(() => parsePanelExport(exportText([tooShort])), /35 columns/i);
});

test("binds a canonical export to the catalogue version", () => {
  const current = exportText([row({ "Entity Name": "GENE1", "Entity type": "gene", GEL_Status: 3, version: "7.16" })]);
  assert.deepEqual(assertPanelExportVersion(current, "7.16"), { expected: "7.16", observed: ["7.16"] });
  assert.throws(() => assertPanelExportVersion(current, "7.15"), /version mismatch/i);
});
