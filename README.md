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

## Simple Flask installation

The Flask edition runs alongside the existing app and preserves the same HPO
verification, PanelApp filtering, workbook naming, request pacing, retries, and
all-or-nothing bundle behavior.

Requirements: Python 3.10 or newer and an internet connection.

On macOS or Linux, double-click `start_flask.command` or run:

```bash
./start_flask.command
```

On Windows, double-click `start_flask.bat`.

The first start creates an isolated Python environment and installs Flask
automatically. The webpage opens at <http://127.0.0.1:5000>. Stop it by closing
the command window or pressing `Control+C`.

For access from other computers on the same trusted local network, start with
`./start_flask.command --lan` on macOS/Linux or `start_flask.bat --lan` on
Windows, then allow port 5000 through the computer firewall. Do not expose the
Flask server directly to the public internet; place it behind an HTTPS reverse
proxy if public access is required.

Flask tests after the first start:

```bash
# macOS or Linux
.venv-flask/bin/python -m unittest discover -s flask_app/tests -v

# Windows
.venv-flask\Scripts\python.exe -m unittest discover -s flask_app/tests -v
```
