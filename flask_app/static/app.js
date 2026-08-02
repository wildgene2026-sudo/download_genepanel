const state = { catalog: null, jobId: null, pollTimer: null };

const byId = (id) => document.getElementById(id);
const jobButtons = [...document.querySelectorAll("[data-job]")];

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  return bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.round(bytes / 1_000)} KB`;
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric" }).format(date);
}

async function responseError(response) {
  try {
    const payload = await response.json();
    return payload.error || `Request failed (HTTP ${response.status})`;
  } catch {
    return `Request failed (HTTP ${response.status})`;
  }
}

function setBusy(busy) {
  jobButtons.forEach((button) => {
    const kind = button.dataset.job;
    const sourceReady = kind === "uk"
      ? state.catalog?.sources?.UK?.length && !state.catalog?.errors?.UK
      : kind === "au"
        ? state.catalog?.sources?.AU?.length && !state.catalog?.errors?.AU
        : state.catalog?.hpo && state.catalog?.sources?.UK?.length && state.catalog?.sources?.AU?.length && Object.keys(state.catalog?.errors || {}).length === 0;
    button.disabled = busy || !sourceReady;
  });
  const hpoLink = byId("hpo-download");
  const hpoReady = state.catalog?.hpo && !state.catalog?.errors?.hpo;
  hpoLink.classList.toggle("disabled", busy || !hpoReady);
  hpoLink.setAttribute("aria-disabled", String(busy || !hpoReady));
}

async function loadCatalog() {
  try {
    const response = await fetch("/api/catalog");
    if (!response.ok) throw new Error(await responseError(response));
    state.catalog = await response.json();
    const uk = state.catalog.sources?.UK?.length || 0;
    const au = state.catalog.sources?.AU?.length || 0;
    byId("uk-count").textContent = state.catalog.errors?.UK ? "!" : String(uk);
    byId("au-count").textContent = state.catalog.errors?.AU ? "!" : String(au);
    byId("uk-card-count").textContent = state.catalog.errors?.UK ? "Unavailable" : String(uk);
    byId("au-card-count").textContent = state.catalog.errors?.AU ? "Unavailable" : String(au);
    byId("footer-count").textContent = `${uk + au} panels ready`;
    byId("catalog-status").textContent = Object.keys(state.catalog.errors || {}).length ? "Partial catalogue" : "Live catalogue";
    if (state.catalog.hpo) {
      byId("hpo-release").textContent = state.catalog.hpo.tag;
      byId("hpo-date").textContent = formatDate(state.catalog.hpo.publishedAt);
      byId("hpo-size").textContent = formatBytes(state.catalog.hpo.size);
      byId("hpo-description").textContent = "Official hp.obo, verified against the release SHA-256 before download.";
    } else {
      byId("hpo-description").textContent = state.catalog.errors?.hpo || "HPO is temporarily unavailable.";
    }
    setBusy(false);
  } catch (error) {
    byId("catalog-status").textContent = "Catalogue needs attention";
    showMessage("Catalogue not ready", error.message, true);
  }
}

function showMessage(title, message, isError = false) {
  const dock = byId("status-dock");
  dock.hidden = false;
  dock.classList.toggle("message", true);
  dock.classList.toggle("error", isError);
  byId("job-phase").textContent = title;
  byId("job-current").textContent = message;
  byId("job-counts").textContent = "";
  byId("cancel-job").hidden = true;
  byId("job-position").textContent = "";
  byId("job-percent").textContent = "";
  byId("progress-fill").style.width = isError ? "100%" : "0%";
}

function renderJob(job) {
  const dock = byId("status-dock");
  dock.hidden = false;
  dock.classList.remove("message", "error");
  byId("cancel-job").hidden = !["queued", "running", "cancelling"].includes(job.status);
  byId("job-phase").textContent = job.phase;
  byId("job-current").textContent = job.current;
  byId("job-counts").textContent = `${Number(job.counts.gene).toLocaleString()} genes · ${Number(job.counts.str).toLocaleString()} STRs · ${Number(job.counts.region).toLocaleString()} regions`;
  const percent = job.total ? Math.round((job.completed / job.total) * 100) : 0;
  byId("job-percent").textContent = `${percent}%`;
  byId("job-position").textContent = `${job.completed} / ${job.total}`;
  byId("progress-fill").style.width = `${percent}%`;
  document.querySelector(".progress-track").setAttribute("aria-valuenow", String(percent));
}

async function startJob(kind) {
  setBusy(true);
  try {
    const response = await fetch("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind }),
    });
    if (!response.ok) throw new Error(await responseError(response));
    const job = await response.json();
    state.jobId = job.id;
    renderJob(job);
    await pollJob();
  } catch (error) {
    setBusy(false);
    showMessage("Download not started", error.message, true);
  }
}

async function pollJob() {
  if (!state.jobId) return;
  try {
    const response = await fetch(`/api/jobs/${state.jobId}`, { cache: "no-store" });
    if (!response.ok) throw new Error(await responseError(response));
    const job = await response.json();
    renderJob(job);
    if (job.status === "ready") {
      const jobId = state.jobId;
      state.jobId = null;
      setBusy(false);
      window.location.assign(`/api/jobs/${jobId}/download`);
      showMessage("Download ready", `${job.filename} has been verified and prepared.`, false);
      return;
    }
    if (job.status === "failed") {
      state.jobId = null;
      setBusy(false);
      showMessage("Download not completed", job.error || "The bundle stopped safely.", true);
      return;
    }
    if (job.status === "cancelled") {
      state.jobId = null;
      setBusy(false);
      showMessage("Download cancelled", "No partial bundle was saved.", false);
      return;
    }
    state.pollTimer = window.setTimeout(pollJob, 1000);
  } catch (error) {
    state.jobId = null;
    setBusy(false);
    showMessage("Download status unavailable", error.message, true);
  }
}

async function cancelJob() {
  if (!state.jobId) return;
  byId("cancel-job").disabled = true;
  try {
    await fetch(`/api/jobs/${state.jobId}/cancel`, { method: "POST" });
  } finally {
    byId("cancel-job").disabled = false;
  }
}

jobButtons.forEach((button) => button.addEventListener("click", () => startJob(button.dataset.job)));
byId("cancel-job").addEventListener("click", cancelJob);
byId("hpo-download").addEventListener("click", (event) => {
  if (event.currentTarget.classList.contains("disabled")) event.preventDefault();
});
loadCatalog();
