#!/usr/bin/env python3
"""Benchmark sequential vs parallel execution of the same analysis (milestone 3).

Both modes use identical input partitions, processing code and hosting
settings; only the dispatch strategy in the orchestrator differs. Modes are
alternated run by run so that warm/cold effects are spread across both.

Usage (standard library only):
    python scripts/benchmark.py --api https://<function-app>.azurewebsites.net --years 2023 --runs 5
    python scripts/benchmark.py --api https://<function-app>.azurewebsites.net --years 2021 2022 2023 2024 2025 --runs 5

Outputs a Markdown table (stdout and --out-md) and raw JSON (--out-json).
"""
from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
import urllib.error
import urllib.request

# Azure Functions Flex Consumption, on-demand meters. Check the pricing page for
# your region before quoting: https://azure.microsoft.com/pricing/details/functions/
DEFAULT_PRICE_PER_GB_SECOND = 0.000026
DEFAULT_PRICE_PER_MILLION_EXECUTIONS = 0.40


def call(method: str, url: str, body=None, retries: int = 5):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={"Content-Type": "application/json"})
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                return json.loads(resp.read())
        except urllib.error.HTTPError as e:
            if e.code < 500 or attempt == retries - 1:
                raise SystemExit(f"{method} {url} -> HTTP {e.code}: {e.read().decode()[:300]}")
        except (urllib.error.URLError, TimeoutError) as e:
            if attempt == retries - 1:
                raise SystemExit(f"{method} {url} failed: {e}")
        time.sleep(2 * (attempt + 1))


def run_job(api: str, years: list[int], mode: str, label: str, poll: float, timeout: float) -> dict:
    t0 = time.perf_counter()
    job_id = call("POST", f"{api}/api/jobs", {"years": years, "mode": mode, "label": label})["job_id"]
    while True:
        job = call("GET", f"{api}/api/jobs/{job_id}")
        if job["status"] == "Complete":
            job["client_seconds"] = round(time.perf_counter() - t0, 3)
            return job
        if job["status"] == "Failed":
            raise SystemExit(f"Job {job_id} failed: {job.get('error')}")
        if time.perf_counter() - t0 > timeout:
            raise SystemExit(f"Job {job_id} did not finish within {timeout}s (last status {job['status']})")
        time.sleep(poll)


def estimated_executions(job: dict) -> int:
    """Activity executions are exact. Orchestrator episodes are a lower bound:
    one per awaited batch (prepare, each sequential activity or the single
    fan-in, merge). The HTTP start call is included; status polls are not."""
    m = job["metrics"]
    activities = len(job["years"]) + m["count_activity_executions"] + 1
    episodes = 3 + (m["partitions"] if job["mode"] == "sequential" else 1)
    return activities + episodes + 1


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--api", required=True, help="Function app base URL, without /api")
    ap.add_argument("--years", nargs="+", type=int, default=[2023])
    ap.add_argument("--runs", type=int, default=5, help="runs per mode")
    ap.add_argument("--poll", type=float, default=1.0)
    ap.add_argument("--timeout", type=float, default=900)
    ap.add_argument("--price-gb-second", type=float, default=DEFAULT_PRICE_PER_GB_SECOND)
    ap.add_argument("--price-million-executions", type=float, default=DEFAULT_PRICE_PER_MILLION_EXECUTIONS)
    ap.add_argument("--out-md", default="benchmark-results.md")
    ap.add_argument("--out-json", default="benchmark-results.json")
    args = ap.parse_args()
    api = args.api.rstrip("/")
    years = sorted(set(args.years))

    print(f"Warm-up run (ingests and prepares {years} if needed; not counted) ...", file=sys.stderr)
    warm = run_job(api, years, "parallel", "benchmark warm-up", args.poll, args.timeout)
    reference_checksum = warm["result"]["checksum"]

    runs: dict[str, list[dict]] = {"sequential": [], "parallel": []}
    for i in range(args.runs):
        for mode in ("sequential", "parallel") if i % 2 == 0 else ("parallel", "sequential"):
            job = run_job(api, years, mode, f"benchmark run {i + 1}", args.poll, args.timeout)
            runs[mode].append(job)
            m = job["metrics"]
            print(
                f"run {i + 1} {mode:<10} counting {m['counting_seconds']:>7.2f}s  end-to-end {m['total_seconds']:>7.2f}s  "
                f"workers {m['distinct_workers']}  checksum {job['result']['checksum'][:10]}",
                file=sys.stderr,
            )

    all_jobs = runs["sequential"] + runs["parallel"]
    outputs_match = all(j["result"]["checksum"] == reference_checksum for j in all_jobs)
    reconciled = all(j["result"]["reconciled"] for j in all_jobs)

    def stats(mode: str) -> dict:
        js = runs[mode]
        med = lambda key: statistics.median(j["metrics"][key] for j in js)  # noqa: E731
        gbs = med("estimated_gb_seconds")
        execs = statistics.median(estimated_executions(j) for j in js)
        return {
            "mode": mode,
            "runs": len(js),
            "median_counting_seconds": round(med("counting_seconds"), 3),
            "min_counting_seconds": round(min(j["metrics"]["counting_seconds"] for j in js), 3),
            "max_counting_seconds": round(max(j["metrics"]["counting_seconds"] for j in js), 3),
            "median_total_seconds": round(med("total_seconds"), 3),
            "median_activity_ms_total": round(med("count_activity_ms_total"), 1),
            "median_instance_busy_seconds": round(med("instance_busy_seconds"), 3),
            "max_distinct_workers": max(j["metrics"]["distinct_workers"] for j in js),
            "count_activity_executions": js[0]["metrics"]["count_activity_executions"],
            "estimated_function_executions": int(execs),
            "estimated_gb_seconds": round(gbs, 4),
            "estimated_compute_cost_usd": round(
                gbs * args.price_gb_second + execs / 1_000_000 * args.price_million_executions, 8
            ),
        }

    seq, par = stats("sequential"), stats("parallel")
    speedup = seq["median_counting_seconds"] / par["median_counting_seconds"] if par["median_counting_seconds"] else float("nan")
    partitions = all_jobs[0]["metrics"]["partitions"]

    lines = [
        f"## Benchmark: years {', '.join(map(str, years))} ({partitions} monthly partitions, "
        f"{all_jobs[0]['result']['collisions']:,} collisions, {args.runs} runs per mode)",
        "",
        "| Metric | Sequential | Parallel (fan-out/fan-in) |",
        "|---|---:|---:|",
        f"| Median counting-stage runtime (s) | {seq['median_counting_seconds']:.2f} | {par['median_counting_seconds']:.2f} |",
        f"| Min to max counting-stage runtime (s) | {seq['min_counting_seconds']:.2f} to {seq['max_counting_seconds']:.2f} | {par['min_counting_seconds']:.2f} to {par['max_counting_seconds']:.2f} |",
        f"| Median end-to-end runtime, submit to complete (s) | {seq['median_total_seconds']:.2f} | {par['median_total_seconds']:.2f} |",
        f"| Count activity executions | {seq['count_activity_executions']} | {par['count_activity_executions']} |",
        f"| Estimated function executions | {seq['estimated_function_executions']} | {par['estimated_function_executions']} |",
        f"| Median summed activity time (ms) | {seq['median_activity_ms_total']:.0f} | {par['median_activity_ms_total']:.0f} |",
        f"| Median instance-busy time, summed over workers (s) | {seq['median_instance_busy_seconds']:.2f} | {par['median_instance_busy_seconds']:.2f} |",
        f"| Most distinct worker instances in a run | {seq['max_distinct_workers']} | {par['max_distinct_workers']} |",
        f"| Estimated compute (GB-s) | {seq['estimated_gb_seconds']:.4f} | {par['estimated_gb_seconds']:.4f} |",
        f"| Estimated compute cost per run (USD) | {seq['estimated_compute_cost_usd']:.8f} | {par['estimated_compute_cost_usd']:.8f} |",
        "",
        f"- Speedup of the counting stage (sequential / parallel median): **{speedup:.2f}x**",
        f"- Outputs identical across all runs and both modes: **{'yes' if outputs_match else 'NO'}** (checksum `{reference_checksum[:16]}`)",
        f"- Summary counts reconcile with accepted input records: **{'yes' if reconciled else 'NO'}**",
        f"- Cost uses {args.price_gb_second} USD per GB-s and {args.price_million_executions} USD per million executions, "
        "before any monthly free grant. It covers Functions compute only; Blob Storage, the Durable Functions "
        "task hub storage transactions and Application Insights ingestion are billed separately.",
        "- Estimated compute is instance-busy time (the union of activity intervals on each worker, summed over workers) "
        "multiplied by the configured instance memory, which follows how Flex Consumption meters on-demand compute.",
        "- Estimated executions count activities exactly and orchestrator episodes as a lower bound; "
        "use the Application Insights query in the README for the exact figure.",
    ]
    md = "\n".join(lines)
    print(md)
    with open(args.out_md, "w") as f:
        f.write(md + "\n")
    with open(args.out_json, "w") as f:
        json.dump({"years": years, "sequential": seq, "parallel": par, "speedup": speedup,
                   "outputs_match": outputs_match, "reconciled": reconciled, "jobs": all_jobs}, f, indent=1)
    return 0 if outputs_match and reconciled else 1


if __name__ == "__main__":
    sys.exit(main())
