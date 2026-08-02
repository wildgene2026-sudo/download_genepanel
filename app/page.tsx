"use client";

import JSZip from "jszip";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  countEntityTypes,
  csvCell,
  assertPanelExportVersion,
  panelDownloadFilename,
  parsePanelExport,
  yymmdd,
} from "@/lib/panelapp";
import { buildPanelWorkbook } from "@/lib/xlsx";

type Source = "UK" | "AU";
type Panel = {
  id: number;
  name: string;
  version: string;
  status: string;
  stats: { genes: number; strs: number; regions: number };
};
type Catalog = {
  generatedAt: string;
  hpo: { tag: string; publishedAt: string; size: number; digest: string } | null;
  sources: { UK: Panel[]; AU: Panel[] };
  errors: { hpo?: string; UK?: string; AU?: string };
};
type EntityCounts = { gene: number; str: number; region: number };
type Job = {
  kind: "hpo" | "uk" | "au" | "complete";
  phase: string;
  completed: number;
  total: number;
  current: string;
  counts: EntityCounts;
};

const EMPTY_COUNTS: EntityCounts = { gene: 0, str: 0, region: 0 };
const PANEL_REQUEST_INTERVAL_MS = 1_000;

function pause(milliseconds: number, signal: AbortSignal) {
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException("Cancelled", "AbortError"));
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      window.clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason ?? new DOMException("Cancelled", "AbortError"));
    };
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${Math.round(bytes / 1_000)} KB`;
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date);
}

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 5_000);
}

async function responseError(response: Response) {
  try {
    const payload = (await response.json()) as { error?: string };
    return payload?.error || `Request failed (HTTP ${response.status})`;
  } catch {
    return `Request failed (HTTP ${response.status})`;
  }
}

function addCounts(left: EntityCounts, right: EntityCounts): EntityCounts {
  return {
    gene: left.gene + right.gene,
    str: left.str + right.str,
    region: left.region + right.region,
  };
}

export default function Home() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [catalogError, setCatalogError] = useState("");
  const [job, setJob] = useState<Job | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/catalog", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(await responseError(response));
        return (await response.json()) as Catalog;
      })
      .then((payload) => setCatalog({ ...payload, errors: payload.errors ?? {} }))
      .catch((reason) => {
        if (reason?.name !== "AbortError") setCatalogError(reason?.message || "Reference catalogue unavailable");
      });
    return () => controller.abort();
  }, []);

  const totalPanels = (catalog?.sources.UK.length ?? 0) + (catalog?.sources.AU.length ?? 0);
  const catalogueComplete = Boolean(
    catalog?.hpo &&
    catalog.sources.UK.length &&
    catalog.sources.AU.length &&
    !catalog.errors.hpo &&
    !catalog.errors.UK &&
    !catalog.errors.AU,
  );
  const progress = job?.total ? Math.round((job.completed / job.total) * 100) : 0;
  const isBusy = Boolean(job);

  const headlineStats = useMemo(
    () => [
      { value: catalog?.errors.UK ? "!" : catalog ? String(catalog.sources.UK.length) : "—", label: "UK panels" },
      { value: catalog?.errors.AU ? "!" : catalog ? String(catalog.sources.AU.length) : "—", label: "Australia panels" },
      { value: "36", label: "exact columns" },
    ],
    [catalog],
  );

  function beginJob(kind: Job["kind"], phase: string, total: number) {
    const controller = new AbortController();
    abortRef.current = controller;
    setError("");
    setNotice("");
    setJob({ kind, phase, completed: 0, total, current: "Preparing secure download…", counts: { ...EMPTY_COUNTS } });
    return controller;
  }

  function finishJob(message: string) {
    abortRef.current = null;
    setJob(null);
    setNotice(message);
  }

  function failJob(reason: unknown) {
    abortRef.current = null;
    setJob(null);
    if (reason instanceof DOMException && reason.name === "AbortError") {
      setNotice("Download cancelled. No partial bundle was saved.");
      return;
    }
    setError(reason instanceof Error ? reason.message : "The download could not be completed");
  }

  async function getVerifiedHpo(signal: AbortSignal) {
    const response = await fetch("/api/hpo", { signal });
    if (!response.ok) throw new Error(await responseError(response));
    const blob = await response.blob();
    if (blob.size < 1_000_000) throw new Error("The received hp.obo file was unexpectedly small");
    return {
      blob,
      release: response.headers.get("X-HPO-Release") || catalog?.hpo?.tag || "unknown",
      sha256: response.headers.get("X-HPO-SHA256") || catalog?.hpo?.digest.replace(/^sha256:/, "") || "unknown",
    };
  }

  async function downloadHpoOnly() {
    const controller = beginJob("hpo", "Verifying the official HPO release", 1);
    try {
      const hpo = await getVerifiedHpo(controller.signal);
      setJob((current) => (current ? { ...current, completed: 1, current: hpo.release } : current));
      saveBlob(hpo.blob, "hp.obo");
      finishJob(`Downloaded hp.obo ${hpo.release}; SHA-256 verified before delivery.`);
    } catch (reason) {
      failJob(reason);
    }
  }

  async function buildBundle(kind: "uk" | "au" | "complete") {
    if (!catalog) {
      setError("The live reference catalogue is not ready yet. Please try again in a moment.");
      return;
    }
    const sources: Source[] = kind === "uk" ? ["UK"] : kind === "au" ? ["AU"] : ["UK", "AU"];
    const unavailable = sources.find((source) => catalog.errors[source] || catalog.sources[source].length === 0);
    if (unavailable || (kind === "complete" && (!catalog.hpo || catalog.errors.hpo))) {
      setError("One or more official reference sources are temporarily unavailable. The available individual downloads remain enabled.");
      return;
    }
    const panels = sources.flatMap((source) => catalog.sources[source].map((panel) => ({ source, panel })));
    const total = panels.length + (kind === "complete" ? 2 : 1);
    const controller = beginJob(kind, "Collecting canonical green exports", total);
    const bundle = new JSZip();
    const manifestRows: string[][] = [[
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
    const failures: string[] = [];
    let nextIndex = 0;
    let completed = 0;
    let aggregate = { ...EMPTY_COUNTS };
    let hpoMetadata: { release: string; sha256: string } | null = null;

    try {
      if (kind === "complete") {
        setJob((current) => (current ? { ...current, phase: "Verifying HPO", current: "Official hp.obo" } : current));
        const hpo = await getVerifiedHpo(controller.signal);
        bundle.file("HPO/hp.obo", hpo.blob);
        hpoMetadata = { release: hpo.release, sha256: hpo.sha256 };
        completed += 1;
        setJob((current) =>
          current ? { ...current, phase: "Collecting canonical green exports", completed, current: "HPO verified" } : current,
        );
      }

      const worker = async () => {
        while (true) {
          const index = nextIndex;
          nextIndex += 1;
          if (index >= panels.length) return;
          const { source, panel } = panels[index];
          if (controller.signal.aborted) throw new DOMException("Cancelled", "AbortError");
          try {
            setJob((current) => (current ? { ...current, current: `${source === "AU" ? "Australia" : "UK"} · ${panel.name}` } : current));
            const response = await fetch(
              `/api/panel-export?source=${encodeURIComponent(source)}&id=${encodeURIComponent(panel.id)}&version=${encodeURIComponent(panel.version)}`,
              { signal: controller.signal, cache: "force-cache" },
            );
            if (!response.ok) throw new Error(await responseError(response));
            const exportText = await response.text();
            assertPanelExportVersion(exportText, panel.version);
            const parsed = parsePanelExport(exportText);
            const counts = countEntityTypes(parsed.rows);
            const workbook = await buildPanelWorkbook(parsed.rows);
            const filename = panelDownloadFilename(panel.name, source, panel.version);
            const path = kind === "complete" ? `PanelApp/${filename}` : filename;
            bundle.file(path, workbook, { binary: true, compression: "STORE" });
            aggregate = addCounts(aggregate, counts);
            manifestRows.push([
              source,
              String(panel.id),
              panel.name,
              panel.version,
              filename,
              String(counts.gene),
              String(counts.str),
              String(counts.region),
              String(parsed.rejected.length),
            ]);
          } catch (reason) {
            if (reason instanceof DOMException && reason.name === "AbortError") throw reason;
            failures.push(`${source} panel ${panel.id} (${panel.name}): ${reason instanceof Error ? reason.message : "unknown error"}`);
          } finally {
            completed += 1;
            setJob((current) => (current ? { ...current, completed, counts: { ...aggregate } } : current));
            if (index < panels.length - 1 && !controller.signal.aborted) {
              setJob((current) =>
                current ? { ...current, current: "Pacing requests to protect PanelApp access…" } : current,
              );
              await pause(PANEL_REQUEST_INTERVAL_MS, controller.signal);
            }
          }
        }
      };

      await worker();
      if (controller.signal.aborted) throw new DOMException("Cancelled", "AbortError");
      if (failures.length) {
        throw new Error(
          `${failures.length} panel${failures.length === 1 ? "" : "s"} could not be verified, so no partial bundle was saved. First problem: ${failures[0]}`,
        );
      }

      const stamp = yymmdd();
      const sourceSummary = sources.map((source) => `${source}: ${catalog.sources[source].length} panels`).join("; ");
      const readme = [
        "HPO & PanelApp Offline Reference Pack",
        "========================================",
        "",
        `Created: ${new Date().toISOString()}`,
        `Panel sources: ${sourceSummary}`,
        `Panel rows: ${aggregate.gene} genes; ${aggregate.str} STRs; ${aggregate.region} genomic regions`,
        "Selection rule: GEL_Status 3 or 4 only; entity type gene, str, or region.",
        "Workbook layout: the canonical 36-column PanelApp website export, saved as Sheet1 in .xlsx.",
        "",
        ...(hpoMetadata
          ? [`HPO release: ${hpoMetadata.release}`, `hp.obo SHA-256: ${hpoMetadata.sha256}`, ""]
          : []),
        "Use with PDF to HPO offline",
        "1. Extract this ZIP.",
        kind === "complete"
          ? "2. In the app header, choose Load HPO ontology… and select HPO/hp.obo."
          : "2. Keep your existing hp.obo, or download it separately from this site.",
        kind === "complete"
          ? "3. In Settings, choose the extracted PanelApp folder as the local PanelApp folder."
          : "3. In Settings, choose this extracted folder as the local PanelApp folder.",
        "",
        "This pack contains public reference data only. No PDF, OCR text, HPO case list, or patient data was sent to build it.",
      ].join("\r\n");
      const manifest = manifestRows.map((row) => row.map(csvCell).join(",")).join("\r\n");
      bundle.file(kind === "complete" ? "README.txt" : "README.txt", readme);
      bundle.file(kind === "complete" ? "PanelApp/manifest.csv" : "manifest.csv", manifest);

      setJob((current) => (current ? { ...current, phase: "Packing verified files", current: "Creating ZIP archive" } : current));
      const zipBlob = await bundle.generateAsync(
        { type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 }, streamFiles: true },
        ({ currentFile, percent }) => {
          setJob((current) =>
            current ? { ...current, current: `${currentFile || "Creating ZIP archive"} · ${Math.round(percent)}%` } : current,
          );
        },
      );
      if (controller.signal.aborted) throw new DOMException("Cancelled", "AbortError");
      const filename =
        kind === "complete"
          ? `HPO-PanelApp-offline-reference-pack-${stamp}.zip`
          : kind === "uk"
            ? `PanelApp-UK-green-${stamp}.zip`
            : `PanelApp-Australia-green-${stamp}.zip`;
      setJob((current) => (current ? { ...current, completed: total, current: "Archive verified" } : current));
      saveBlob(zipBlob, filename);
      finishJob(
        `Downloaded ${filename}: ${panels.length} panels, ${aggregate.gene.toLocaleString()} genes, ${aggregate.str.toLocaleString()} STRs, and ${aggregate.region.toLocaleString()} regions.`,
      );
    } catch (reason) {
      failJob(reason);
    }
  }

  function cancelJob() {
    abortRef.current?.abort();
    setJob((current) =>
      current ? { ...current, phase: "Cancelling safely", current: "Stopping without saving a partial bundle…" } : current,
    );
  }

  return (
    <main>
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Reference Bridge home">
          <span className="brandMark" aria-hidden="true">RB</span>
          <span>Reference Bridge</span>
        </a>
        <div className="topbarMeta">
          <span className="liveDot" aria-hidden="true" />
          {catalog
            ? Object.keys(catalog.errors).length
              ? `Partial catalogue · ${formatDate(catalog.generatedAt)}`
              : `Live catalogue · ${formatDate(catalog.generatedAt)}`
            : catalogError
              ? "Catalogue needs attention"
              : "Checking official sources…"}
        </div>
      </header>

      <section className="hero" id="top">
        <div className="heroCopy">
          <div className="eyebrow">COMPANION FOR PDF TO HPO OFFLINE</div>
          <h1>Fresh reference data.<br /><em>Zero patient data.</em></h1>
          <p className="lede">
            Download the exact HPO ontology and every current green PanelApp panel from the UK and Australia—ready for your offline clinical workflow.
          </p>
          <div className="heroActions">
            <button className="primaryButton" type="button" disabled={!catalogueComplete || isBusy} onClick={() => buildBundle("complete")}>
              Build complete offline pack <span aria-hidden="true">→</span>
            </button>
            <a className="textLink" href="#individual-downloads">Choose individual downloads</a>
          </div>
          <div className="privacyNote">
            <span className="shield" aria-hidden="true">✓</span>
            <span><strong>No PDF upload.</strong> This site handles public reference files only—never scans, OCR text, HPO case terms, or identifiers.</span>
          </div>
        </div>
        <div className="heroPanel" aria-label="Download contract summary">
          <div className="heroPanelHeader">
            <span>Verified reference contract</span>
            <span className="verifiedPill">source-faithful</span>
          </div>
          <div className="statGrid">
            {headlineStats.map((item) => (
              <div className="stat" key={item.label}>
                <strong>{item.value}</strong>
                <span>{item.label}</span>
              </div>
            ))}
          </div>
          <div className="contractList">
            <div><span>01</span><p><strong>Green means GEL 3 or 4</strong><br />No amber, red, or grey rows enter a bundle.</p></div>
            <div><span>02</span><p><strong>All genomic entity types</strong><br />Genes, short tandem repeats, and genomic regions.</p></div>
            <div><span>03</span><p><strong>Exact local naming</strong><br />AUSTRALIA. prefix, version, green label, and YYMMDD date.</p></div>
          </div>
        </div>
      </section>

      {(job || notice || error || catalogError) && (
        <section className={`statusDock ${error || catalogError ? "statusError" : notice ? "statusSuccess" : ""}`} aria-live="polite">
          {job ? (
            <>
              <div className="statusText">
                <span>{job.phase}</span>
                <strong>{job.current}</strong>
                {job.kind !== "hpo" && (
                  <small>{job.counts.gene.toLocaleString()} genes · {job.counts.str.toLocaleString()} STRs · {job.counts.region.toLocaleString()} regions</small>
                )}
              </div>
              <div className="progressBlock">
                <div className="progressLabel"><span>{progress}%</span><span>{job.completed} / {job.total}</span></div>
                <div className="progressTrack" role="progressbar" aria-label="Download progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><span style={{ width: `${progress}%` }} /></div>
              </div>
              <button className="cancelButton" type="button" onClick={cancelJob}>Cancel</button>
            </>
          ) : (
            <div className="messageText">
              <strong>{error || catalogError ? "Download not completed" : "Download ready"}</strong>
              <span>{error || catalogError || notice}</span>
            </div>
          )}
        </section>
      )}

      <section className="downloads" id="individual-downloads">
        <div className="sectionHeading">
          <div>
            <span className="eyebrow">INDIVIDUAL DOWNLOADS</span>
            <h2>Take only what you need</h2>
          </div>
          <p>Each PanelApp bundle is all-or-nothing. Requests run one at a time with automatic cooldown and retry handling, so large downloads do not create a burst against PanelApp.</p>
        </div>
        <div className="downloadGrid">
          <article className="downloadCard hpoCard">
            <div className="cardTop"><span className="cardIndex">01</span><span className="fileBadge">.OBO</span></div>
            <h3>HPO ontology</h3>
            <p>{catalog?.errors.hpo ? `HPO is temporarily unavailable: ${catalog.errors.hpo}` : <>The real official <code>hp.obo</code> asset used by the app’s local extractor—not JSON and not an annotation file.</>}</p>
            <dl>
              <div><dt>Latest release</dt><dd>{catalog?.hpo?.tag ?? "Checking…"}</dd></div>
              <div><dt>Published</dt><dd>{catalog?.hpo ? formatDate(catalog.hpo.publishedAt) : "—"}</dd></div>
              <div><dt>Size</dt><dd>{catalog?.hpo ? formatBytes(catalog.hpo.size) : "—"}</dd></div>
            </dl>
            <button className="cardButton" type="button" disabled={!catalog?.hpo || Boolean(catalog.errors.hpo) || isBusy} onClick={downloadHpoOnly}>Download hp.obo <span>→</span></button>
          </article>

          <article className="downloadCard ukCard">
            <div className="cardTop"><span className="cardIndex">02</span><span className="fileBadge">.ZIP</span></div>
            <h3>PanelApp UK</h3>
            <p>{catalog?.errors.UK ? `UK is temporarily unavailable: ${catalog.errors.UK}` : "Every panel from Genomics England, each saved as a green-only 36-column Excel workbook."}</p>
            <dl>
              <div><dt>Current panels</dt><dd>{catalog?.sources.UK.length ?? "—"}</dd></div>
              <div><dt>Filename prefix</dt><dd>Panel name</dd></div>
              <div><dt>Entity types</dt><dd>3 included</dd></div>
            </dl>
            <button className="cardButton" type="button" disabled={!catalog?.sources.UK.length || Boolean(catalog.errors.UK) || isBusy} onClick={() => buildBundle("uk")}>Download UK bundle <span>→</span></button>
          </article>

          <article className="downloadCard auCard">
            <div className="cardTop"><span className="cardIndex">03</span><span className="fileBadge">.ZIP</span></div>
            <h3>PanelApp Australia</h3>
            <p>{catalog?.errors.AU ? `Australia is temporarily unavailable: ${catalog.errors.AU}` : <>Every Australian panel with the required <code>AUSTRALIA.</code> prefix and current source version.</>}</p>
            <dl>
              <div><dt>Current panels</dt><dd>{catalog?.sources.AU.length ?? "—"}</dd></div>
              <div><dt>Filename prefix</dt><dd>AUSTRALIA.</dd></div>
              <div><dt>Entity types</dt><dd>3 included</dd></div>
            </dl>
            <button className="cardButton" type="button" disabled={!catalog?.sources.AU.length || Boolean(catalog.errors.AU) || isBusy} onClick={() => buildBundle("au")}>Download Australia bundle <span>→</span></button>
          </article>
        </div>
      </section>

      <section className="proofSection">
        <div className="proofCopy">
          <span className="eyebrow">WHAT THE REVIEW FOUND</span>
          <h2>Built to the app’s real import points</h2>
          <p>
            The offline application never connects to HPO or PanelApp. It imports a local ontology and indexes a local workbook folder, which keeps reference downloads separate from the patient-data path.
          </p>
        </div>
        <div className="proofTable">
          <div className="proofRow proofHeader"><span>Reference</span><span>What the offline app actually reads</span><span>This site delivers</span></div>
          <div className="proofRow"><span>HPO</span><span><code>data/hp.obo</code> or “Load HPO ontology…”</span><span>Checksum-verified official <code>hp.obo</code></span></div>
          <div className="proofRow"><span>PanelApp</span><span>Top-level <code>*.xlsx</code> filenames in the chosen folder</span><span>Canonical names plus full source workbooks</span></div>
          <div className="proofRow"><span>Green list</span><span>Local filename marks the list as green</span><span>Every row rechecked as GEL 3/4 before packaging</span></div>
        </div>
      </section>

      <section className="installSection">
        <div className="sectionHeading compactHeading">
          <div><span className="eyebrow">THREE-MINUTE HANDOFF</span><h2>Use the complete pack</h2></div>
          <p>The ZIP keeps the two reference surfaces separate, matching the offline app’s design.</p>
        </div>
        <ol className="steps">
          <li><span>1</span><div><strong>Extract the ZIP</strong><p>Keep the included <code>HPO</code> and <code>PanelApp</code> folders together.</p></div></li>
          <li><span>2</span><div><strong>Load the ontology</strong><p>In the app header, choose “Load HPO ontology…” and select <code>HPO/hp.obo</code>.</p></div></li>
          <li><span>3</span><div><strong>Point to the panel folder</strong><p>In Settings, choose the extracted <code>PanelApp</code> folder, then save.</p></div></li>
        </ol>
      </section>

      <footer>
        <div><span className="brandMark smallMark" aria-hidden="true">RB</span><strong>Reference Bridge</strong></div>
        <p>Public reference data only · HPO + PanelApp UK + PanelApp Australia</p>
        <span>{catalog ? `${totalPanels} panels ready` : "Catalogue checking"}</span>
      </footer>
    </main>
  );
}
