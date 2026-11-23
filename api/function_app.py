"""Road Safety Explorer API: HTTP endpoints + Durable Functions workflow.

HTTP (inter-service contract with the React app)
    POST /api/jobs               start an analysis, returns {job_id}
    GET  /api/jobs/{job_id}      status: Queued | Running | Complete | Failed
    GET  /api/jobs/{job_id}/result   dashboard-ready summary (when Complete)
    GET  /api/jobs               recent job records (for the comparison table)
    GET  /api/meta               selectable years and scope note

Workflow (analysis_orchestrator)
    prepare_year    ingest -> validate/decode -> split into monthly blobs (cached per year)
    count_partition one activity per year-month partition
                    parallel   : fan-out all partitions, fan-in with task_all
                    sequential : the same activities, awaited one at a time
    merge_results   combine partial counts, write summary + final job record
"""
from __future__ import annotations

import json
import logging
import os
import socket
import time
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path

import azure.durable_functions as df
import azure.functions as func
from azure.core.exceptions import ResourceExistsError, ResourceNotFoundError
from azure.storage.blob import BlobServiceClient, ContentSettings

import pipeline

app = df.DFApp(http_auth_level=func.AuthLevel.ANONYMOUS)

CONTAINER = os.environ.get("DATA_CONTAINER", "roadsafety")
ALLOWED_YEARS = sorted(
    int(y) for y in os.environ.get("ALLOWED_YEARS", "2021,2022,2023,2024,2025").split(",") if y.strip()
)
MODES = ("parallel", "sequential")
INSTANCE_MEMORY_MB = int(os.environ.get("INSTANCE_MEMORY_MB", "2048"))
PIPELINE_VERSION = "1"

_LA_NAMES = json.loads((Path(__file__).parent / "lookups" / "local_authorities.json").read_text(encoding="utf-8"))["names"]

_container_client = None


# --------------------------------------------------------------------------
# Blob helpers
# --------------------------------------------------------------------------
def _container():
    global _container_client
    if _container_client is None:
        conn = os.environ.get("DATA_STORAGE_CONNECTION") or os.environ["AzureWebJobsStorage"]
        client = BlobServiceClient.from_connection_string(conn).get_container_client(CONTAINER)
        try:
            client.create_container()
        except ResourceExistsError:
            pass
        _container_client = client
    return _container_client


def _put(path: str, data: bytes | str, content_type: str = "application/octet-stream") -> None:
    if isinstance(data, str):
        data = data.encode("utf-8")
    _container().upload_blob(path, data, overwrite=True, content_settings=ContentSettings(content_type=content_type))


def _put_json(path: str, obj) -> None:
    _put(path, json.dumps(obj, separators=(",", ":")), "application/json")


def _get(path: str) -> bytes | None:
    try:
        return _container().download_blob(path).readall()
    except ResourceNotFoundError:
        return None


def _get_json(path: str):
    raw = _get(path)
    return None if raw is None else json.loads(raw)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def _worker_id() -> str:
    """Identifies the instance that ran an activity, to tell scale-out from in-instance concurrency."""
    return (
        os.environ.get("WEBSITE_INSTANCE_ID")
        or os.environ.get("CONTAINER_NAME")
        or socket.gethostname()
    )


def _busy_seconds(refs: list[dict]) -> float:
    """Seconds during which each worker instance was running at least one count
    activity (union of activity intervals per worker, summed over workers).
    This mirrors how Flex Consumption meters on-demand compute: per instance
    while it is actively executing, not per function call."""
    total = 0.0
    by_worker: dict[str, list[tuple[float, float]]] = {}
    for r in refs:
        by_worker.setdefault(r["worker"], []).append((r["started"], r["ended"]))
    for spans in by_worker.values():
        spans.sort()
        cur_start, cur_end = spans[0]
        for s, e in spans[1:]:
            if s <= cur_end:
                cur_end = max(cur_end, e)
            else:
                total += cur_end - cur_start
                cur_start, cur_end = s, e
        total += cur_end - cur_start
    return total


def _json_response(body, status: int = 200) -> func.HttpResponse:
    return func.HttpResponse(json.dumps(body), status_code=status, mimetype="application/json")


# --------------------------------------------------------------------------
# HTTP endpoints
# --------------------------------------------------------------------------
@app.route(route="meta", methods=["GET"])
def get_meta(req: func.HttpRequest) -> func.HttpResponse:
    return _json_response({"years": ALLOWED_YEARS, "modes": list(MODES), "scope_note": pipeline.SCOPE_NOTE})


@app.route(route="jobs", methods=["POST"])
@app.durable_client_input(client_name="client")
async def create_job(req: func.HttpRequest, client) -> func.HttpResponse:
    try:
        body = req.get_json()
    except ValueError:
        return _json_response({"error": "Request body must be JSON"}, 400)

    years = body.get("years") or ([body["year"]] if "year" in body else [])
    try:
        years = sorted({int(y) for y in years})
    except (TypeError, ValueError):
        return _json_response({"error": "years must be a list of integers"}, 400)
    if not years or any(y not in ALLOWED_YEARS for y in years):
        return _json_response({"error": f"years must be chosen from {ALLOWED_YEARS}"}, 400)
    mode = body.get("mode", "parallel")
    if mode not in MODES:
        return _json_response({"error": f"mode must be one of {MODES}"}, 400)

    job_id = uuid.uuid4().hex
    job = {
        "job_id": job_id,
        "years": years,
        "mode": mode,
        "label": str(body.get("label", ""))[:80],
        "status": "Queued",
        "created_at": _now(),
    }
    _put_json(f"jobs/{job_id}.json", job)
    await client.start_new("analysis_orchestrator", instance_id=job_id, client_input=job)
    return _json_response({"job_id": job_id, "status": "Queued", "status_url": f"/api/jobs/{job_id}"}, 202)


_STATUS_MAP = {
    "Pending": "Queued",
    "Running": "Running",
    "ContinuedAsNew": "Running",
    "Completed": "Complete",
    "Failed": "Failed",
    "Terminated": "Failed",
    "Canceled": "Failed",
    "Suspended": "Queued",
}


@app.route(route="jobs/{job_id}", methods=["GET"])
@app.durable_client_input(client_name="client")
async def get_job(req: func.HttpRequest, client) -> func.HttpResponse:
    job_id = req.route_params["job_id"]
    if not job_id.isalnum():
        return _json_response({"error": "Unknown job"}, 404)
    job = _get_json(f"jobs/{job_id}.json")
    if job is None:
        return _json_response({"error": "Unknown job"}, 404)

    if job["status"] != "Complete":
        status = await client.get_status(job_id)
        runtime = getattr(status.runtime_status, "value", status.runtime_status) if status else None
        job["status"] = _STATUS_MAP.get(str(runtime), job["status"])
        if status and status.custom_status:
            job["progress"] = status.custom_status
        if job["status"] == "Failed":
            job["error"] = str(status.output)[:500] if status and status.output else "Workflow failed"
    return _json_response(job)


@app.route(route="jobs/{job_id}/result", methods=["GET"])
def get_job_result(req: func.HttpRequest) -> func.HttpResponse:
    job_id = req.route_params["job_id"]
    if not job_id.isalnum():
        return _json_response({"error": "Unknown job"}, 404)
    raw = _get(f"results/{job_id}/summary.json")
    if raw is None:
        return _json_response({"error": "Result not ready"}, 404)
    return func.HttpResponse(raw, status_code=200, mimetype="application/json")


@app.route(route="jobs", methods=["GET"])
def list_jobs(req: func.HttpRequest) -> func.HttpResponse:
    blobs = sorted(_container().list_blobs(name_starts_with="jobs/"), key=lambda b: b.last_modified, reverse=True)
    jobs = [j for j in (_get_json(b.name) for b in blobs[:50]) if j and j.get("status") == "Complete"]
    jobs.sort(key=lambda j: j["created_at"], reverse=True)
    return _json_response({"jobs": jobs})


# --------------------------------------------------------------------------
# Orchestrator
# --------------------------------------------------------------------------
@app.orchestration_trigger(context_name="context")
def analysis_orchestrator(context: df.DurableOrchestrationContext):
    job = context.get_input()
    job_id, years, mode = job["job_id"], job["years"], job["mode"]

    # Stage 1: ingest + validate + split. Cached per year, so it is outside the benchmark window.
    context.set_custom_status({"stage": "Preparing data", "done": 0, "total": len(years)})
    manifests = yield context.task_all([context.call_activity("prepare_year", y) for y in years])

    partitions = [
        {"job_id": job_id, "year": m["year"], "month": int(month), "path": path}
        for m in manifests
        for month, path in sorted(m["partitions"].items(), key=lambda kv: int(kv[0]))
    ]

    # Stage 2: the benchmarked stage. Same activity, same inputs, two dispatch strategies.
    context.set_custom_status({"stage": f"Counting ({mode})", "done": 0, "total": len(partitions)})
    started = context.current_utc_datetime
    if mode == "parallel":
        partials = yield context.task_all([context.call_activity("count_partition", p) for p in partitions])
    else:
        partials = []
        for i, p in enumerate(partitions):
            partials.append((yield context.call_activity("count_partition", p)))
            context.set_custom_status({"stage": f"Counting ({mode})", "done": i + 1, "total": len(partitions)})
    finished = context.current_utc_datetime

    # Stage 3: fan-in.
    context.set_custom_status({"stage": "Merging results", "done": len(partitions), "total": len(partitions)})
    final = yield context.call_activity(
        "merge_results",
        {
            "job": job,
            "manifests": manifests,
            "partials": partials,
            "counting_seconds": (finished - started).total_seconds(),
        },
    )
    return final


# --------------------------------------------------------------------------
# Activities
# --------------------------------------------------------------------------
@app.activity_trigger(input_name="year")
def prepare_year(year: int) -> dict:
    """Ingest one year from DfT (once), validate, decode and split into monthly blobs."""
    year = int(year)
    manifest_path = f"clean/{year}/manifest.json"
    manifest = _get_json(manifest_path)
    if manifest and manifest.get("pipeline_version") == PIPELINE_VERSION:
        return manifest

    raw_path = f"raw/{year}/collisions.csv"
    raw = _get(raw_path)
    ingested_at = None
    if raw is None:
        url = pipeline.source_url(year)
        logging.info("Ingesting %s", url)
        with urllib.request.urlopen(url, timeout=300) as resp:
            raw = resp.read()
        _put(raw_path, raw, "text/csv")
        ingested_at = _now()

    digest = pipeline.sha256_hex(raw)
    version = digest[:12]
    parts, report = pipeline.validate_and_split(raw, year, _LA_NAMES)

    paths = {}
    for month, text in parts.items():
        path = f"clean/{year}/{version}/month-{month:02d}.csv"
        _put(path, text, "text/csv")
        paths[str(month)] = path

    manifest = {
        "year": year,
        "dataset_version": version,
        "raw_sha256": digest,
        "raw_bytes": len(raw),
        "source_url": pipeline.source_url(year),
        "raw_blob": raw_path,
        "ingested_at": ingested_at or (manifest or {}).get("ingested_at") or _now(),
        "prepared_at": _now(),
        "pipeline_version": PIPELINE_VERSION,
        "validation": report,
        "partitions": paths,
    }
    _put_json(manifest_path, manifest)
    return manifest


@app.activity_trigger(input_name="partition")
def count_partition(partition: dict) -> dict:
    """Worker: read one monthly blob, count by local authority x severity, write the partial."""
    t0 = time.perf_counter()
    started = time.time()
    text = _get(partition["path"]).decode("utf-8")
    partial = pipeline.count_partition(text)
    partial["year"], partial["month"] = partition["year"], partition["month"]
    out_path = f"partials/{partition['job_id']}/{partition['year']}-{partition['month']:02d}.json"
    _put_json(out_path, partial)
    return {
        "path": out_path,
        "year": partition["year"],
        "month": partition["month"],
        "records": partial["records"],
        "duration_ms": round((time.perf_counter() - t0) * 1000, 1),
        "started": started,
        "ended": time.time(),
        "worker": _worker_id(),
        "pid": os.getpid(),
    }


@app.activity_trigger(input_name="payload")
def merge_results(payload: dict) -> dict:
    """Fan-in: combine partials, write the summary and the final job record."""
    t0 = time.perf_counter()
    job, manifests, partial_refs = payload["job"], payload["manifests"], payload["partials"]
    job_id = job["job_id"]

    partials = [_get_json(ref["path"]) for ref in partial_refs]
    summary = pipeline.merge_partials(partials)

    accepted = sum(m["validation"]["accepted_records"] for m in manifests)
    summary["reconciliation"]["accepted_input_records"] = accepted
    summary["reconciliation"]["match"] = summary["reconciliation"]["match"] and accepted == summary["totals"]["collisions"]

    datasets = [
        {
            "year": m["year"],
            "dataset_version": m["dataset_version"],
            "raw_sha256": m["raw_sha256"],
            "source_url": m["source_url"],
            "ingested_at": m["ingested_at"],
            "input_records": m["validation"]["input_records"],
            "accepted_records": m["validation"]["accepted_records"],
            "rejected_by_reason": m["validation"]["rejected_by_reason"],
        }
        for m in manifests
    ]

    activity_ms = sum(r["duration_ms"] for r in partial_refs)
    busy_seconds = _busy_seconds(partial_refs)
    merge_ms = round((time.perf_counter() - t0) * 1000, 1)
    completed_at = _now()
    total_seconds = (
        datetime.fromisoformat(completed_at) - datetime.fromisoformat(job["created_at"])
    ).total_seconds()

    metrics = {
        "partitions": len(partial_refs),
        "counting_seconds": round(payload["counting_seconds"], 3),
        "total_seconds": round(total_seconds, 3),
        "count_activity_executions": len(partial_refs),
        "count_activity_ms_total": round(activity_ms, 1),
        "merge_ms": merge_ms,
        "distinct_workers": len({r["worker"] for r in partial_refs}),
        "workers": sorted({r["worker"] for r in partial_refs}),
        "instance_memory_mb": INSTANCE_MEMORY_MB,
        "instance_busy_seconds": round(busy_seconds, 3),
        # Instance-busy time x configured instance memory. An estimate of
        # Functions compute for the counting and merge stages only; storage and
        # monitoring are billed separately.
        "estimated_gb_seconds": round((busy_seconds + merge_ms / 1000) * INSTANCE_MEMORY_MB / 1024, 4),
    }

    job_record = {
        **job,
        "status": "Complete",
        "completed_at": completed_at,
        "datasets": datasets,
        "metrics": metrics,
        "result": {
            "path": f"results/{job_id}/summary.json",
            "checksum": summary["checksum"],
            "collisions": summary["totals"]["collisions"],
            "reconciled": summary["reconciliation"]["match"],
        },
    }
    summary_doc = {"job": job_record, "summary": summary}
    _put_json(f"results/{job_id}/summary.json", summary_doc)
    _put_json(f"jobs/{job_id}.json", job_record)
    return {"job_id": job_id, "checksum": summary["checksum"], "metrics": metrics}
