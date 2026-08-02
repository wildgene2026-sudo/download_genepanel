import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import {
  countEntityTypes,
  csvCell,
  panelDownloadFilename,
  parsePanelExport,
  yymmdd,
} from "../lib/panelapp.js";
import { fetchPanelExport, listPanelAppPanels } from "../lib/remote.js";
import { buildPanelWorkbook } from "../lib/xlsx.js";

const PROJECT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const OUTPUT_DIR = path.join(PROJECT_DIR, ".validation-panelapp-full");

function pause(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function addCounts(left, right) {
  return {
    gene: left.gene + right.gene,
    str: left.str + right.str,
    region: left.region + right.region,
  };
}

await fs.mkdir(OUTPUT_DIR, { recursive: true });
const panels = await listPanelAppPanels("UK");
const bundle = new JSZip();
const manifestRows = [[
  "Source",
  "Panel ID",
  "Panel",
  "Version",
  "Filename",
  "Genes",
  "STRs",
  "Regions",
  "Rejected non-green or unknown rows",
]];
let aggregate = { gene: 0, str: 0, region: 0 };

for (let index = 0; index < panels.length; index += 1) {
  const panel = panels[index];
  const text = await fetchPanelExport("UK", panel.id, panel.version);
  const parsed = parsePanelExport(text);
  const counts = countEntityTypes(parsed.rows);
  const workbook = await buildPanelWorkbook(parsed.rows);
  const filename = panelDownloadFilename(panel.name, "UK", panel.version);
  bundle.file(filename, workbook, { binary: true, compression: "STORE" });
  manifestRows.push([
    "UK",
    String(panel.id),
    panel.name,
    panel.version,
    filename,
    String(counts.gene),
    String(counts.str),
    String(counts.region),
    String(parsed.rejected.length),
  ]);
  aggregate = addCounts(aggregate, counts);
  const memoryMb = Math.round(process.memoryUsage().rss / 1_000_000);
  process.stdout.write(
    `${index + 1}/${panels.length} ${panel.name}: PASS (${counts.gene} genes, ${counts.str} STRs, ${counts.region} regions; ${memoryMb} MB)\n`,
  );
  if (index < panels.length - 1) await pause(1_000);
}

const manifest = manifestRows.map((row) => row.map(csvCell).join(",")).join("\r\n");
bundle.file("manifest.csv", manifest);
bundle.file(
  "README.txt",
  [
    "PanelApp UK full-bundle validation",
    `Created: ${new Date().toISOString()}`,
    `Panels: ${panels.length}`,
    `Rows: ${aggregate.gene} genes; ${aggregate.str} STRs; ${aggregate.region} genomic regions`,
    "Selection rule: GEL_Status 3 or 4 only; entity type gene, str, or region.",
  ].join("\r\n"),
);

const bytes = await bundle.generateAsync({
  type: "uint8array",
  compression: "DEFLATE",
  compressionOptions: { level: 6 },
  streamFiles: true,
});
const output = path.join(OUTPUT_DIR, `PanelApp-UK-green-${yymmdd()}.zip`);
await fs.writeFile(output, bytes);
const reopened = await JSZip.loadAsync(bytes);
const workbookCount = Object.keys(reopened.files).filter((name) => name.endsWith(".xlsx")).length;
if (workbookCount !== panels.length || !reopened.file("manifest.csv") || !reopened.file("README.txt")) {
  throw new Error(`Final archive verification failed: expected ${panels.length} workbooks, received ${workbookCount}`);
}
const report = {
  generatedAt: new Date().toISOString(),
  source: "UK",
  panels: panels.length,
  ...aggregate,
  workbookCount,
  archiveBytes: bytes.byteLength,
  output,
};
await fs.writeFile(path.join(OUTPUT_DIR, "UK-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(report)}\n`);
