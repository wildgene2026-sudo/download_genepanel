# Reference Bridge

Reference Bridge is the companion downloader for `PDF to HPO offline`. It
collects public reference data only and never accepts PDFs, OCR text, HPO case
terms, or patient identifiers.

## Live website

Use the hosted downloader at [Reference Bridge](https://reference-bridge-hpo-panelapp.algene2026.chatgpt.site/).
GitHub Pages cannot run this application's download API routes, so the full
working downloader is hosted there while this repository contains the source.

## Downloads

- The latest official HPO `hp.obo`, checked against the release SHA-256 and the
  offline app's structural import rules.
- Every current PanelApp UK panel.
- Every current PanelApp Australia panel.
- Green genes, STRs, and genomic regions only (`GEL_Status` 3 or 4).
- The canonical 36-column PanelApp export in one `Sheet1` workbook per panel.

Panel workbooks use the exact filename contract expected by the offline app:

- UK: `<Panel> (Version <version>) green.downloaded on <YYMMDD>.xlsx`
- Australia: `AUSTRALIA.<Panel> (Version <version>) green.downloaded on <YYMMDD>.xlsx`

The complete ZIP also includes a manifest and simple installation instructions.
Panel bundles are fail-closed: if any panel cannot be retrieved and validated,
the browser does not save a partial archive.

## Local development

Requires Node.js 22.13 or newer.

```bash
npm install
npm run dev
```

Validation commands:

```bash
npm run lint
npm run typecheck
npm test
```
