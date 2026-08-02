import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import JSZip from "jszip";
import { parseDelimited, parsePanelExport, safeFilenameComponent } from "../lib/panelapp.js";
import { buildPanelWorkbook } from "../lib/xlsx.js";

const projectDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const archivePath = path.resolve(process.argv[2] || "");
if (!process.argv[2]) throw new Error("Pass the Flask ZIP archive path as the first argument");

const outer = await JSZip.loadAsync(await fs.readFile(archivePath));
const manifestFile = outer.file("manifest.csv");
if (!manifestFile) throw new Error("Flask archive has no manifest.csv");
const manifestRows = parseDelimited(await manifestFile.async("string"), ",");
const header = manifestRows.shift();
const expectedHeader = [
  "Source", "Panel ID", "Panel", "Version", "Filename", "Genes", "STRs", "Regions",
  "Rejected non-green or unknown rows",
];
if (JSON.stringify(header) !== JSON.stringify(expectedHeader)) {
  throw new Error("Flask manifest header mismatch");
}

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const ignoredParts = new Set(["docProps/core.xml"]);
const mismatches = [];
let checked = 0;

for (const row of manifestRows) {
  if (!row.some(Boolean)) continue;
  if (row.length !== expectedHeader.length) throw new Error(`Manifest row has ${row.length} columns`);
  const [source, panelId, , version, filename] = row;
  const cachedExportPath = path.join(
    projectDir,
    "flask_app",
    "data",
    "cache",
    "panels",
    source,
    `${panelId}-${safeFilenameComponent(version)}.tsv`,
  );
  const exportText = await fs.readFile(cachedExportPath, "utf8");
  const parsed = parsePanelExport(exportText);
  const nodeWorkbook = await JSZip.loadAsync(await buildPanelWorkbook(parsed.rows));
  const flaskFile = outer.file(filename);
  if (!flaskFile) {
    mismatches.push({ filename, part: "missing workbook" });
    continue;
  }
  const flaskWorkbook = await JSZip.loadAsync(await flaskFile.async("uint8array"));
  const nodeParts = Object.keys(nodeWorkbook.files).sort();
  const flaskParts = Object.keys(flaskWorkbook.files).sort();
  if (JSON.stringify(nodeParts) !== JSON.stringify(flaskParts)) {
    mismatches.push({ filename, part: "package structure" });
    continue;
  }
  for (const part of nodeParts) {
    if (ignoredParts.has(part)) continue;
    const nodeBytes = await nodeWorkbook.file(part)?.async("uint8array");
    const flaskBytes = await flaskWorkbook.file(part)?.async("uint8array");
    if ((!nodeBytes && flaskBytes) || (nodeBytes && !flaskBytes) || (nodeBytes && flaskBytes && digest(nodeBytes) !== digest(flaskBytes))) {
      mismatches.push({ filename, part });
      break;
    }
  }
  checked += 1;
}

const report = { workbooks: manifestRows.filter((row) => row.some(Boolean)).length, checked, mismatches };
process.stdout.write(`${JSON.stringify(report)}\n`);
if (mismatches.length) process.exitCode = 1;
