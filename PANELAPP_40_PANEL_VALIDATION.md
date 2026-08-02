# PanelApp 40-Panel Validation and Correction Log

Validation target: 20 current PanelApp UK panels and 20 current PanelApp Australia panels.

Each iteration checks three independently observable surfaces:

1. The official website green export (`/panels/{id}/download/34/`).
2. The `.xlsx` workbook produced by the Reference Bridge application from those exact bytes.
3. A matching manually stored workbook in `/Users/walter/Desktop/PanelApp` for the same source and panel name.

The pass criteria are intentionally fail-closed:

- The official export has the canonical 36 headers in exact A:AJ order.
- Every accepted row is `GEL_Status` 3 or 4 and entity type `gene`, `str`, or `region`.
- The app workbook round-trips every official source value without row or column drift.
- The workbook has one usable `Sheet1`, exact headers, expected dimensions, no formulas, and manual-compatible Boolean/numeric/text cell types.
- The generated filename matches the offline app's UK/Australia pattern and the catalogue version.
- All 40 workbooks open through the spreadsheet verification runtime without formula errors.

## Iteration log

### Iteration 1 — baseline before correction

- Date: 2026-08-02 (Hong Kong)
- Sample: 20 current UK panels and 20 current Australia panels
- Official green rows: 23,466
- Entity totals: 22,842 genes, 191 STRs, and 433 genomic regions
- Generated panels with errors: 40/40
- Recorded comparison errors: 752 (diagnostic output was capped at 20 cell examples per panel)
- Value/layout result: the official rows, order, headers, A:AJ dimensions, green filtering, entity counts, versions, and filenames were otherwise correct and all generated files opened successfully.

Problems found:

1. The generator stored every nonblank value as text. Canonical manual PanelApp workbooks instead use Boolean cells for `Flagged` and `ready`, and numeric cells for numeric values in status, version, publication, chromosome/coordinate, STR repeat, and genomic-region score columns.
2. The workbook font referred to a theme colour but the package had no theme part.
3. The worksheet used the `x14ac` extension without marking it as an ignorable compatibility namespace.
4. The first manual-reference selector could choose a newer legacy-corrupted workbook instead of a canonical reference.

Corrections applied:

1. Added a strict per-header native-type allowlist. Free text and identifiers remain shared strings, including text beginning with formula characters; no formula cells can be generated.
2. Replaced the unresolved theme colour with explicit black and added the required compatibility declaration for `x14ac`.
3. Changed manual-reference selection to reject noncanonical headers, prefer an exact current version when present, and otherwise use the newest canonical workbook for that panel.
4. Added regression checks for Boolean, numeric, mixed, chromosome-X, version-token, and formula-injection cases.

### Stored manual-file audit

The comparison directory contains 426 `.xlsx` files. Of these, 420 (98.6%) use the dominant canonical 36-column A:AJ schema and native Boolean/numeric/text typing. Six legacy files are noncanonical and are recorded as reference-data exceptions rather than copied into the app:

- `AUSTRALIA.Alternating Hemiplegia and Hemiplegic Migraine (Version 1.0) green.downloaded 260327.xlsx` — invalid first header (`]`).
- `AUSTRALIA.Familial hypoparathyroidism (Version 1.1) green genes.downloaded on 221124.xlsx` — whitespace-split 68-column export.
- `AUSTRALIA.Pseudohypoparathyroidism and Albright Hereditary Osteodystrophy (Version 0.11) green genes.downloaded on 221124.xlsx` — whitespace-split 68-column export.
- `AUSTRALIA.Renal abnormalities of calcium and phosphate metabolism (Version 0.38) green genes.downloaded on 221124.xlsx` — whitespace-split 68-column export.
- `Congenital myaesthenic syndrome (Version 5.6) green.downloaded on 251222.xlsx` — invalid first header (`aEntity Name`).
- `Neuromuscular disorders (Version 5.269) green.downloaded on 211117.xlsx` — extra leading `Remark` column.

Formatting metadata such as creators, timestamps, unused Excel style catalogues, and ZIP member order varies across manually stored files and is not a stable data-format requirement. The dominant active format is one plain `Sheet1`, Normal style, exact 36 headers, sparse blanks, native cells, and no formulas.

### Iteration 2 — post-correction

- Sample: 20 current UK panels and 20 current Australia panels, selected only where a canonical stored workbook was available as a format reference
- Official green rows: 23,815
- Entity totals: 23,180 genes, 201 STRs, and 434 genomic regions
- Generated panels with errors: 4/40
- Exact comparison errors: 4
- Result: all native cell-type mismatches were resolved. Thirty-six panels passed every check.

The four remaining differences were one phenotype cell in each of these UK panels:

- `Childhood onset leukodystrophy` — row 183, column 9
- `Hypotonic infant` — row 178, column 9
- `Intellectual disability` — row 89, column 9
- `Paediatric disorders` — row 397, column 9

Each official value ended with U+000B (vertical tab). The generator replaced this XML-illegal control character with a space, whereas Excel preserves it using the OOXML `_x000B_` escape.

Correction applied:

- Encode XML-illegal control characters with Excel-compatible `_xHHHH_` escapes.
- Protect source text that literally contains an `_xHHHH_` token by escaping its leading underscore as `_x005F_`, preventing accidental decoding.
- Added regression coverage for both a real U+000B and a literal `_x000B_` string.

One stored Paediatric disorders reference uses text instead of native Boolean cells in `Flagged` and `ready`; this is recorded as a legacy reference warning, not an app-output error.

### Iteration 3 — final candidate

- Sample and totals: the same 40 panels and 23,815 rows as Iteration 2
- Generated workbook result: all four affected cells now contain the correct `_x000B_` OOXML representation.
- Verification result: 4/40 were still reported as failures because the spreadsheet inspection library returns `_x000B_` literally rather than decoding it to U+000B as Excel does.

This was a validation-reader mismatch, not a remaining workbook defect. The validator was corrected to decode Excel `_xHHHH_` escapes once when comparing imported text. A single-pass decode is important: `_x005F_x000B_` becomes the literal text `_x000B_` and is not decoded a second time.

### Iteration 4 — final verification

- Date: 2026-08-02 (Hong Kong)
- Sample: 20 current UK panels and 20 current Australia panels
- Official green rows: 23,815
- Entity totals: 23,180 genes, 201 STRs, and 434 genomic regions
- Generated panels with errors: **0/40**
- Exact comparison errors: **0**
- Result: **PASS**

All 40 current official exports were downloaded under the paced request policy and regenerated by the app. Every workbook passed exact row/value comparison after documented native Excel normalization, exact 36-column A:AJ header order, expected dimensions, green-status/entity filtering, native Boolean/numeric/text typing, current-version filename construction, one visible `Sheet1`, zero formulas/formula errors, and no macros, external links, embedded objects, or hidden data sheets. All files opened in the spreadsheet verification runtime. No unrecovered PanelApp throttle, server, or access-block error occurred.

The stored Paediatric disorders v45.3 workbook remains the single sampled reference warning because its Boolean fields were saved as text. The app correctly follows the dominant 420-file manual format instead of imitating that legacy exception.

| Source | Current panel | Version | Rows | Genes | STRs | Regions |
|---|---|---:|---:|---:|---:|---:|
| UK | Adult onset dystonia, chorea or related movement disorder | 6.6 | 77 | 67 | 10 | 0 |
| UK | Anophthalmia or microphthalmia | 1.57 | 37 | 37 | 0 | 0 |
| UK | Brain channelopathy | 1.83 | 26 | 21 | 4 | 1 |
| UK | Childhood onset leukodystrophy | 31.137 | 2,886 | 2,813 | 5 | 68 |
| UK | Congenital hypothyroidism | 3.10 | 30 | 30 | 0 | 0 |
| UK | Differences in sex development | 4.22 | 46 | 44 | 0 | 2 |
| UK | Extreme early-onset hypertension | 1.23 | 15 | 15 | 0 | 0 |
| UK | Familial tumours of the nervous system | 3.2 | 7 | 7 | 0 | 0 |
| UK | Generalised arterial calcification in infancy | 1.5 | 2 | 2 | 0 | 0 |
| UK | Glycogen storage disease | 2.8 | 29 | 29 | 0 | 0 |
| UK | Hereditary ataxia with onset in adulthood | 9.3 | 179 | 164 | 13 | 2 |
| UK | Hereditary diffuse gastric cancer | 2.6 | 2 | 2 | 0 | 0 |
| UK | Hereditary neuropathy | 1.513 | 168 | 159 | 7 | 2 |
| UK | Hypotonic infant | 46.244 | 2,718 | 2,634 | 10 | 74 |
| UK | Inherited white matter disorders | 1.186 | 129 | 129 | 0 | 0 |
| UK | Intellectual disability | 10.85 | 1,581 | 1,513 | 2 | 66 |
| UK | Limb girdle muscular dystrophies, myofibrillar myopathies and distal myopathies | 6.15 | 71 | 71 | 0 | 0 |
| UK | Multiple exostoses | 1.5 | 2 | 2 | 0 | 0 |
| UK | Optic neuropathy | 6.44 | 44 | 44 | 0 | 0 |
| UK | Paediatric disorders | 75.286 | 6,794 | 6,683 | 7 | 104 |
| AU | Aminoacidopathy | 2.1 | 115 | 113 | 1 | 1 |
| AU | Ataxia | 2.7 | 274 | 251 | 20 | 3 |
| AU | Atypical Haemolytic Uraemic Syndrome_MPGN | 2.0 | 12 | 12 | 0 | 0 |
| AU | Callosome | 1.6 | 358 | 353 | 2 | 3 |
| AU | Cerebral vascular malformations | 2.0 | 25 | 24 | 0 | 1 |
| AU | Congenital Heart Defect | 1.13 | 196 | 185 | 1 | 10 |
| AU | Congenital Myasthenia | 2.0 | 26 | 26 | 0 | 0 |
| AU | Dystonia and Chorea | 1.9 | 177 | 168 | 9 | 0 |
| AU | Early-onset Parkinson disease | 3.31 | 114 | 99 | 15 | 0 |
| AU | Facial papules | 2.0 | 23 | 21 | 0 | 2 |
| AU | Fetal anomalies | 2.22 | 1,520 | 1,510 | 3 | 7 |
| AU | Foveal Hypoplasia | 1.0 | 2 | 2 | 0 | 0 |
| AU | Genetic Epilepsy | 2.30 | 924 | 903 | 8 | 13 |
| AU | Intellectual disability syndromic and non-syndromic | 2.61 | 1,897 | 1,831 | 9 | 57 |
| AU | Metabolic Disorders Superpanel | 9.172 | 1,218 | 1,210 | 4 | 4 |
| AU | Movement Disorders Superpanel | 3.259 | 628 | 581 | 44 | 3 |
| AU | Neuromuscular Superpanel | 4.525 | 961 | 936 | 23 | 2 |
| AU | Parathyroid Tumour | 2.0 | 6 | 6 | 0 | 0 |
| AU | Skeletal dysplasia | 1.26 | 490 | 477 | 4 | 9 |
| AU | Thyroid Cancer | 2.0 | 6 | 6 | 0 | 0 |

### High-volume PanelApp access protection

Before the final rerun, the downloader was hardened to avoid creating high-frequency traffic against either PanelApp service:

- The browser now requests only one panel at a time, with a one-second gap between completed panel requests. The previous four-request parallel burst was removed.
- The server also serializes requests per PanelApp origin and enforces a minimum interval, protecting against concurrent tabs handled by the same runtime.
- HTTP 429 and temporary 5xx responses are retried up to five attempts with exponential backoff and jitter.
- A valid `Retry-After` response extends the shared origin cooldown. If PanelApp requests more than five minutes, the job stops instead of retrying before the requested time.
- Version-specific panel responses are browser-cacheable for one hour, edge-cacheable for one day, and available stale-while-revalidate for seven days. Restarting or repeating a bundle therefore reuses validated responses when caches permit.
- Download cancellation interrupts both pacing and backoff waits. A failed or cancelled run still saves no partial bundle.

These controls substantially reduce blocking risk and ensure polite recovery from throttling. No client can guarantee that a third-party service will never impose a block, so the fail-safe behavior is to wait or stop rather than increase request frequency.
