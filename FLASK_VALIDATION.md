# Flask validation and correction log

## 2026-08-02 — initial implementation

- Added a Flask/Waitress webpage with a one-command macOS/Linux launcher and a
  one-click Windows launcher.
- Ported the official HPO release digest verification, canonical PanelApp
  catalogue and export validation, green-only selection, exact filename rules,
  request serialization, pacing, bounded retries, caching, cancellation, and
  all-or-nothing ZIP behavior.
- Request pacing is enforced once in the shared per-origin network gate; cached
  exports do not incur an artificial network delay.
- Local Flask contract and route tests: 8/8 passed.
- Live catalogue: HPO, UK, and Australia returned with no source errors.
- Live HPO: 11,222,341-byte `hp.obo` downloaded and passed the ontology
  structure and release SHA-256 checks.
- Full Flask UK bundle: 434/434 workbooks completed; 35,536 gene rows, 220 STR
  rows, and 478 genomic-region rows; outer ZIP integrity passed.

### Correction 1 — Python certificate trust

Problem: the first live Python requests failed certificate verification because
the macOS Python installation did not have a configured OpenSSL CA path.

Correction: the Flask client now uses `SSL_CERT_FILE` when supplied, otherwise
the standard macOS or Linux system CA bundle when present, and finally the
platform default certificate store. No certificate checks are disabled.

Result: the live HPO, UK, and Australia catalogue checks passed with no errors.

### Correction 2 — workbook directory records

Problem: all 434 Flask workbooks had the correct XML parts and data, but their
ZIP packages omitted the empty directory entries emitted by the original
JSZip workbook builder (`_rels/`, `docProps/`, `xl/`, `xl/_rels/`, and
`xl/worksheets/`). Excel accepts both forms, but this did not satisfy the exact
package-structure comparison.

Correction: the Flask XLSX writer now emits those directory records in the same
order as the original builder.

The first comparison against the earlier Node archive then found eight
`sharedStrings.xml` differences. Inspection showed that the official PanelApp
exports had reordered curator-source labels without changing their panel
versions between the two live runs. This is upstream value drift, not a
workbook-writer difference. The final validator therefore builds the Node and
Flask workbooks from the exact same cached TSV bytes before comparing package
parts.

### Correction 3 — embedded CRLF preservation

Problem: after the directory fix, 433/434 same-input workbooks matched. One
quoted Publications field contained an embedded CRLF. Python's normal text-file
reader translated it to LF when loading the cached TSV, while the browser app
preserved the original CRLF.

Correction: cached PanelApp exports are now read and written as raw UTF-8 bytes,
so embedded quoted line endings are preserved exactly.

## Final result

- Final full Flask UK bundle: **PASS**, 434/434 workbooks, 35,536 green gene
  rows, 220 green STR rows, and 478 green genomic-region rows.
- Final ZIP integrity: **PASS**, all compressed entries reopened without error.
- Same-input Node-versus-Flask comparison: **PASS**, 434/434 workbook package
  structures and XML parts matched with zero mismatches. The generated
  `docProps/core.xml` timestamp was intentionally excluded because each builder
  records its own creation time.
- Flask contract and route tests: **PASS**, 8/8.
- Original Node application regression: **PASS**, production build plus 17/17
  tests, lint, and TypeScript type checking.
