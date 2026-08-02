import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";
import { EXPORT_HEADERS } from "../lib/panelapp.js";
import { buildPanelWorkbook, panelWorkbookCellType } from "../lib/xlsx.js";

function sampleRow() {
  const row = Array.from({ length: EXPORT_HEADERS.length }, () => "");
  row[0] = "ATXN2_CAG";
  row[1] = "str";
  row[2] = "ATXN2";
  row[8] = '=HYPERLINK("https://example.test", "must stay text")';
  row[13] = "control\u000bcharacter; literal _x000B_ token";
  row[14] = "False";
  row[15] = "3";
  row[17] = "1.10";
  row[18] = "True";
  row[23] = "12";
  row[28] = "CAG";
  row[29] = "32";
  row[30] = "35";
  return row;
}

test("writes a 36-column Sheet1 workbook with manual-compatible native cell types", async () => {
  const bytes = await buildPanelWorkbook([sampleRow()], { generatedAt: new Date("2026-08-02T00:00:00Z") });
  assert.ok(bytes.byteLength > 2_000);
  const zip = await JSZip.loadAsync(bytes);
  const sheet = await zip.file("xl/worksheets/sheet1.xml").async("string");
  const strings = await zip.file("xl/sharedStrings.xml").async("string");
  const workbook = await zip.file("xl/workbook.xml").async("string");
  const styles = await zip.file("xl/styles.xml").async("string");

  assert.match(workbook, /sheet name="Sheet1"/);
  assert.match(sheet, /dimension ref="A1:AJ2"/);
  assert.match(sheet, /mc:Ignorable="x14ac"/);
  assert.doesNotMatch(sheet, /<f(?:\s|>)/);
  assert.match(styles, /color rgb="FF000000"/);
  assert.doesNotMatch(styles, /color theme=/);
  assert.match(strings, /Entity Name/);
  assert.match(strings, /ATXN2_CAG/);
  assert.match(strings, /HYPERLINK/);
  assert.match(strings, /control_x000B_character; literal _x005F_x000B_ token/);
  assert.doesNotMatch(strings, /\u000b/);
  assert.doesNotMatch(strings, /1\.10/);
  assert.match(sheet, /<c r="O2" t="b"><v>0<\/v><\/c>/);
  assert.match(sheet, /<c r="P2"><v>3<\/v><\/c>/);
  assert.match(sheet, /<c r="R2"><v>1\.1<\/v><\/c>/);
  assert.match(sheet, /<c r="S2" t="b"><v>1<\/v><\/c>/);
  assert.match(sheet, /<c r="X2"><v>12<\/v><\/c>/);
  assert.match(sheet, /<c r="AD2"><v>32<\/v><\/c>/);
  assert.match(sheet, /<c r="AE2"><v>35<\/v><\/c>/);
});

test("uses a strict per-column type allowlist", () => {
  assert.equal(panelWorkbookCellType("Flagged", "False"), "boolean");
  assert.equal(panelWorkbookCellType("ready", "TRUE"), "boolean");
  assert.equal(panelWorkbookCellType("version", "4.10"), "number");
  assert.equal(panelWorkbookCellType("Publications", "12345"), "number");
  assert.equal(panelWorkbookCellType("Position Chromosome", "X"), "string");
  assert.equal(panelWorkbookCellType("Publications", "12345; 67890"), "string");
  assert.equal(panelWorkbookCellType("STR Normal Repeats", "<=31"), "string");
  assert.equal(panelWorkbookCellType("Region Haploinsufficiency Score", "2"), "number");
  assert.equal(panelWorkbookCellType("Phenotypes", "=1+1"), "string");
  assert.equal(panelWorkbookCellType("Entity Name", "00123"), "string");
});

test("refuses rows that do not match the canonical 36-column contract", async () => {
  await assert.rejects(() => buildPanelWorkbook([["too", "short"]]), /expected 36/i);
});
