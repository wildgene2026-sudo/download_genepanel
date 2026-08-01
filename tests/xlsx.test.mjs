import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";
import { EXPORT_HEADERS } from "../lib/panelapp.js";
import { buildPanelWorkbook } from "../lib/xlsx.js";

function sampleRow() {
  const row = Array.from({ length: EXPORT_HEADERS.length }, () => "");
  row[0] = "ATXN2_CAG";
  row[1] = "str";
  row[2] = "ATXN2";
  row[8] = '=HYPERLINK("https://example.test", "must stay text")';
  row[15] = "3";
  row[17] = "1.10";
  row[23] = "12";
  row[28] = "CAG";
  row[29] = "32";
  row[30] = "35";
  return row;
}

test("writes a 36-column Sheet1 workbook with literal shared strings", async () => {
  const bytes = await buildPanelWorkbook([sampleRow()], { generatedAt: new Date("2026-08-02T00:00:00Z") });
  assert.ok(bytes.byteLength > 2_000);
  const zip = await JSZip.loadAsync(bytes);
  const sheet = await zip.file("xl/worksheets/sheet1.xml").async("string");
  const strings = await zip.file("xl/sharedStrings.xml").async("string");
  const workbook = await zip.file("xl/workbook.xml").async("string");

  assert.match(workbook, /sheet name="Sheet1"/);
  assert.match(sheet, /dimension ref="A1:AJ2"/);
  assert.doesNotMatch(sheet, /<f(?:\s|>)/);
  assert.match(strings, /Entity Name/);
  assert.match(strings, /ATXN2_CAG/);
  assert.match(strings, /1\.10/);
  assert.match(strings, /HYPERLINK/);
});

test("refuses rows that do not match the canonical 36-column contract", async () => {
  await assert.rejects(() => buildPanelWorkbook([["too", "short"]]), /expected 36/i);
});

