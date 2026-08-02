from __future__ import annotations

import io
import os
from pathlib import Path

from flask import Flask, jsonify, render_template, request, send_file

from .core import CatalogService, JobManager, ReferenceBridgeError, RemoteClient


PACKAGE_DIR = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("REFERENCE_BRIDGE_DATA_DIR", PACKAGE_DIR / "data")).resolve()
CACHE_DIR = DATA_DIR / "cache"
DOWNLOAD_DIR = DATA_DIR / "downloads"

app = Flask(__name__, template_folder="templates", static_folder="static")
app.config.update(
    JSON_SORT_KEYS=False,
    MAX_CONTENT_LENGTH=32 * 1024,
    SEND_FILE_MAX_AGE_DEFAULT=3600,
)

remote = RemoteClient(CACHE_DIR)
catalog_service = CatalogService(remote)
jobs = JobManager(remote, catalog_service, DOWNLOAD_DIR)


@app.after_request
def security_headers(response):
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "no-referrer")
    response.headers.setdefault(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; "
        "connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    )
    return response


@app.get("/")
def index():
    return render_template("index.html")


@app.get("/health")
def health():
    return jsonify({"status": "ok", "service": "Reference Bridge Flask"})


@app.get("/api/catalog")
def catalog():
    payload = catalog_service.get(force=request.args.get("refresh") == "1")
    response = jsonify(payload)
    response.headers["Cache-Control"] = "private, max-age=300"
    return response


@app.get("/api/hpo")
def hpo():
    try:
        body, release = remote.fetch_verified_hpo()
        response = send_file(
            io.BytesIO(body),
            mimetype="text/obo; charset=utf-8",
            as_attachment=True,
            download_name="hp.obo",
            max_age=3600,
        )
        response.headers["X-HPO-Release"] = release["tag"]
        response.headers["X-HPO-SHA256"] = release["digest"].removeprefix("sha256:")
        return response
    except ReferenceBridgeError as exc:
        return jsonify({"error": str(exc)}), 502


@app.post("/api/jobs")
def create_job():
    payload = request.get_json(silent=True) or {}
    try:
        job = jobs.start(str(payload.get("kind") or "").lower())
        return jsonify(job.public()), 202
    except ReferenceBridgeError as exc:
        return jsonify({"error": str(exc)}), 409


@app.get("/api/jobs/<job_id>")
def get_job(job_id: str):
    job = jobs.get(job_id)
    if not job:
        return jsonify({"error": "Download job was not found"}), 404
    return jsonify(job.public())


@app.post("/api/jobs/<job_id>/cancel")
def cancel_job(job_id: str):
    try:
        return jsonify(jobs.cancel(job_id).public())
    except ReferenceBridgeError as exc:
        return jsonify({"error": str(exc)}), 404


@app.get("/api/jobs/<job_id>/download")
def download_job(job_id: str):
    job = jobs.get(job_id)
    if not job:
        return jsonify({"error": "Download job was not found"}), 404
    if job.status != "ready" or not job.output_path:
        return jsonify({"error": "Download archive is not ready"}), 409
    path = Path(job.output_path)
    if not path.is_file() or path.parent.resolve() != DOWNLOAD_DIR.resolve():
        return jsonify({"error": "Download archive is unavailable"}), 410
    return send_file(
        path,
        mimetype="application/zip",
        as_attachment=True,
        download_name=job.filename,
        conditional=True,
        max_age=0,
    )


@app.errorhandler(413)
def request_too_large(_error):
    return jsonify({"error": "Request was too large"}), 413
