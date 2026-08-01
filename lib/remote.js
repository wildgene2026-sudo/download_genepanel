import { EXPORT_HEADERS, PANELAPP_SOURCES, assertPanelExportVersion } from "./panelapp.js";

const USER_AGENT = "HPO-PanelApp-Reference-Downloader/1.0";
const RETRIES = 3;
const TIMEOUT_MS = 25_000;

function cancellationError() {
  return new DOMException("Request cancelled", "AbortError");
}

function pause(milliseconds, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason ?? cancellationError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal.reason ?? cancellationError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function retryDelay(response, attempt) {
  const retryAfter = response.headers.get("retry-after")?.trim();
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const until = Date.parse(retryAfter) - Date.now();
    const milliseconds = Number.isFinite(seconds) ? seconds * 1_000 : until;
    if (Number.isFinite(milliseconds) && milliseconds > 0) {
      return Math.min(milliseconds, 10_000);
    }
  }
  return 500 * 2 ** attempt + Math.floor(Math.random() * 250);
}

async function requestWithRetry(url, init = {}) {
  const parentSignal = init.signal;
  if (parentSignal?.aborted) throw parentSignal.reason ?? cancellationError();
  let lastError;
  let delay = 500;
  for (let attempt = 0; attempt < RETRIES; attempt += 1) {
    const controller = new AbortController();
    const cancelAttempt = () => controller.abort(parentSignal?.reason ?? cancellationError());
    parentSignal?.addEventListener("abort", cancelAttempt, { once: true });
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
        headers: {
          "User-Agent": USER_AGENT,
          ...(init.headers ?? {}),
        },
      });
      if (response.ok) return response;
      if (response.status !== 429 && response.status < 500) {
        const error = new Error(`Upstream request returned HTTP ${response.status}`);
        error.retryable = false;
        throw error;
      }
      lastError = new Error(`Upstream request returned HTTP ${response.status}`);
      delay = retryDelay(response, attempt);
    } catch (error) {
      if (parentSignal?.aborted) throw parentSignal.reason ?? cancellationError();
      if (error?.retryable === false) throw error;
      lastError = error;
    } finally {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", cancelAttempt);
    }
    if (attempt < RETRIES - 1) await pause(delay, parentSignal);
  }
  throw new Error(`Upstream request failed after ${RETRIES} attempts: ${lastError?.message ?? "unknown error"}`);
}

export async function getJson(url, init = {}) {
  const response = await requestWithRetry(url, {
    ...init,
    headers: { Accept: "application/json", ...(init.headers ?? {}) },
  });
  try {
    return await response.json();
  } catch (error) {
    throw new Error(`Upstream returned invalid JSON: ${error.message}`);
  }
}

export async function listPanelAppPanels(source, options = {}) {
  const config = PANELAPP_SOURCES[source];
  if (!config) throw new Error(`Unknown PanelApp source: ${source}`);
  const allowed = new URL(config.apiBase);
  let next = `${config.apiBase}/panels/?format=json&page_size=100`;
  const panels = [];
  const seen = new Set();
  let expectedCount = null;
  let pageCount = 0;

  while (next) {
    pageCount += 1;
    if (pageCount > 25) throw new Error("PanelApp pagination exceeded the safety limit");
    const pageUrl = new URL(next);
    if (
      pageUrl.origin !== allowed.origin ||
      !pageUrl.pathname.startsWith(`${allowed.pathname}/panels/`)
    ) {
      throw new Error("PanelApp pagination left the allowlisted API endpoint");
    }
    const data = await getJson(pageUrl.toString(), { signal: options.signal });
    if (!Array.isArray(data.results)) throw new Error("PanelApp list response has no results array");
    const reportedCount = Number(data.count);
    if (!Number.isSafeInteger(reportedCount) || reportedCount < 1 || reportedCount > 2_000) {
      throw new Error("PanelApp list response reported an invalid panel count");
    }
    if (expectedCount === null) expectedCount = reportedCount;
    else if (reportedCount !== expectedCount) throw new Error("PanelApp panel count changed during pagination");
    for (const panel of data.results) {
      const id = Number(panel.id);
      if (!Number.isSafeInteger(id) || id < 1) throw new Error("PanelApp returned an invalid panel id");
      if (seen.has(id)) throw new Error(`PanelApp returned duplicate panel id ${id}`);
      seen.add(id);
      panels.push({
        id,
        name: String(panel.name ?? ""),
        version: String(panel.version ?? ""),
        status: String(panel.status ?? ""),
        stats: {
          genes: Number(panel.stats?.number_of_genes ?? 0),
          strs: Number(panel.stats?.number_of_strs ?? 0),
          regions: Number(panel.stats?.number_of_regions ?? 0),
        },
      });
    }
    next = typeof data.next === "string" && data.next ? data.next : null;
    if (panels.length > expectedCount) throw new Error("PanelApp list exceeded its reported count");
  }

  if (!expectedCount || panels.length !== expectedCount) {
    throw new Error(`PanelApp list was incomplete: expected ${expectedCount ?? "unknown"}, received ${panels.length}`);
  }

  return panels.sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
}

export async function fetchPanelExport(source, panelId, expectedVersion, options = {}) {
  const config = PANELAPP_SOURCES[source];
  const id = String(panelId ?? "");
  if (!config) throw new Error(`Unknown PanelApp source: ${source}`);
  if (!/^\d{1,8}$/.test(id) || Number(id) < 1) throw new Error("Invalid PanelApp panel id");
  const version = String(expectedVersion ?? "").trim();
  if (!/^\d+(?:\.\d+)?$/.test(version)) throw new Error("Invalid PanelApp panel version");

  const url = `${config.webBase}/panels/${id}/download/34/`;
  const response = await requestWithRetry(url, {
    signal: options.signal,
    headers: { Accept: "text/tab-separated-values,text/plain;q=0.9" },
  });
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > 12_000_000) throw new Error("PanelApp export exceeded the 12 MB safety limit");
  const text = await response.text();
  if (text.length > 12_000_000) throw new Error("PanelApp export exceeded the 12 MB safety limit");

  const firstLine = text.split(/\r?\n/, 1)[0].replace(/^\uFEFF/, "");
  if (firstLine !== EXPORT_HEADERS.join("\t")) {
    throw new Error("PanelApp returned a file that is not the canonical 36-column export");
  }
  assertPanelExportVersion(text, version);
  return text;
}

export async function latestHpoRelease(options = {}) {
  const release = await getJson(
    "https://api.github.com/repos/obophenotype/human-phenotype-ontology/releases/latest",
    {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: options.signal,
    },
  );
  const asset = Array.isArray(release.assets)
    ? release.assets.find((candidate) => candidate?.name === "hp.obo")
    : null;
  if (!asset?.browser_download_url) throw new Error("The latest official HPO release has no hp.obo asset");
  const digest = String(asset.digest ?? "");
  if (!/^sha256:[a-f0-9]{64}$/i.test(digest)) {
    throw new Error("The official hp.obo asset did not publish a SHA-256 digest");
  }
  return {
    tag: String(release.tag_name ?? ""),
    publishedAt: String(release.published_at ?? ""),
    size: Number(asset.size ?? 0),
    digest: digest.toLowerCase(),
    url: String(asset.browser_download_url),
  };
}

export async function fetchVerifiedHpo(options = {}) {
  const release = await latestHpoRelease(options);
  const response = await requestWithRetry(release.url, {
    signal: options.signal,
    headers: { Accept: "application/octet-stream" },
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength < 1_000_000 || bytes.byteLength > 30_000_000) {
    throw new Error("The official hp.obo asset had an unexpected size");
  }
  if (release.size && bytes.byteLength !== release.size) {
    throw new Error("The downloaded hp.obo size did not match the release metadata");
  }
  const digestBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const digest = `sha256:${Array.from(digestBytes, (value) => value.toString(16).padStart(2, "0")).join("")}`;
  if (digest !== release.digest) throw new Error("The downloaded hp.obo failed SHA-256 verification");

  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const head = text.slice(0, 4_000).toLowerCase();
  const lower = text.toLowerCase();
  if (!head.includes("format-version:") || !lower.includes("[term]") || !lower.includes("id: hp:")) {
    throw new Error("The downloaded file failed the offline app's hp.obo structure check");
  }
  return { bytes, release };
}
