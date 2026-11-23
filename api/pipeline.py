"""Pure pipeline logic for the Road Safety Explorer.

No Azure imports here, so the same code runs inside the Functions app, in the
unit tests and on a laptop.

Stages
------
1. validate_and_split  raw DfT collision CSV  -> clean monthly partitions + report
2. count_partition     one clean monthly CSV  -> partial counts
3. merge_partials      all partial counts     -> dashboard-ready summary

Data model
----------
collision record : one row per collision_index (clean partition files)
summary row      : one row per year x month x local authority x severity
job record       : one row per analysis run (built in function_app.py)
"""
from __future__ import annotations

import csv
import hashlib
import io
import json
import re
from collections import Counter
from datetime import datetime
from typing import Iterable

SEVERITY_LABELS = {"1": "Fatal", "2": "Serious", "3": "Slight"}

SCOPE_NOTE = (
    "Police-reported personal-injury collisions on public roads in Great Britain "
    "(DfT STATS19). Damage-only collisions and collisions not reported to the "
    "police are not included. Counts are not a measure of road risk because they "
    "are not adjusted for traffic volume or population."
)

SOURCE_URL_TEMPLATE = (
    "https://data.dft.gov.uk/road-accidents-safety-data/"
    "dft-road-casualty-statistics-collision-{year}.csv"
)

# DfT renamed accident_* columns to collision_* in recent releases; accept both.
FIELD_ALIASES = {
    "collision_index": ("collision_index", "accident_index"),
    "severity": ("collision_severity", "accident_severity"),
    "date": ("date",),
    "la_code": ("local_authority_ons_district",),
}

CLEAN_COLUMNS = [
    "collision_index",
    "date",
    "year",
    "month",
    "severity_code",
    "severity",
    "la_code",
    "la_name",
]

REJECT_REASONS = (
    "missing_collision_index",
    "duplicate_collision_index",
    "invalid_date",
    "date_outside_requested_year",
    "invalid_severity",
    "missing_local_authority",
)

_LA_CODE = re.compile(r"^[ENSW]\d{8}$")


def source_url(year: int) -> str:
    return SOURCE_URL_TEMPLATE.format(year=year)


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _resolve_columns(header: list[str]) -> dict[str, str]:
    resolved = {}
    for logical, candidates in FIELD_ALIASES.items():
        for name in candidates:
            if name in header:
                resolved[logical] = name
                break
        else:
            raise ValueError(
                f"Input is missing a required column for '{logical}' "
                f"(looked for {', '.join(candidates)})"
            )
    return resolved


def validate_and_split(raw_csv: bytes, year: int, la_names: dict[str, str]) -> tuple[dict[int, str], dict]:
    """Validate raw records, decode category codes and split by month.

    Returns ({month: clean_csv_text}, report). Every input record is either
    accepted into exactly one monthly partition or counted under one rejection
    reason, so input_records == accepted_records + sum(rejected).
    """
    text = raw_csv.decode("utf-8-sig")
    reader = csv.DictReader(io.StringIO(text))
    cols = _resolve_columns(reader.fieldnames or [])

    buffers = {m: io.StringIO() for m in range(1, 13)}
    writers = {}
    for m, buf in buffers.items():
        w = csv.writer(buf, lineterminator="\n")
        w.writerow(CLEAN_COLUMNS)
        writers[m] = w

    seen: set[str] = set()
    rejected: Counter = Counter()
    accepted_by_month: Counter = Counter()
    unmapped_la: Counter = Counter()
    input_records = 0

    for row in reader:
        input_records += 1
        cid = (row.get(cols["collision_index"]) or "").strip()
        if not cid:
            rejected["missing_collision_index"] += 1
            continue
        if cid in seen:
            rejected["duplicate_collision_index"] += 1
            continue
        try:
            d = datetime.strptime((row.get(cols["date"]) or "").strip(), "%d/%m/%Y")
        except ValueError:
            rejected["invalid_date"] += 1
            continue
        if d.year != year:
            rejected["date_outside_requested_year"] += 1
            continue
        sev = (row.get(cols["severity"]) or "").strip()
        if sev not in SEVERITY_LABELS:
            rejected["invalid_severity"] += 1
            continue
        la = (row.get(cols["la_code"]) or "").strip()
        if not _LA_CODE.match(la):
            rejected["missing_local_authority"] += 1
            continue

        seen.add(cid)
        name = la_names.get(la)
        if name is None:
            unmapped_la[la] += 1
            name = f"Unmapped code {la}"
        writers[d.month].writerow(
            [cid, d.strftime("%Y-%m-%d"), d.year, d.month, sev, SEVERITY_LABELS[sev], la, name]
        )
        accepted_by_month[d.month] += 1

    accepted = sum(accepted_by_month.values())
    report = {
        "year": year,
        "input_records": input_records,
        "accepted_records": accepted,
        "rejected_records": sum(rejected.values()),
        "rejected_by_reason": {r: rejected.get(r, 0) for r in REJECT_REASONS},
        "accepted_by_month": {str(m): accepted_by_month.get(m, 0) for m in range(1, 13)},
        "unmapped_local_authority_codes": dict(unmapped_la),
    }
    assert input_records == accepted + sum(rejected.values()), "validation accounting error"
    return {m: buf.getvalue() for m, buf in buffers.items()}, report


def count_partition(clean_csv: str) -> dict:
    """Count one clean monthly partition by local authority x severity."""
    counts: Counter = Counter()
    names: dict[str, str] = {}
    records = 0
    year = month = None
    for row in csv.DictReader(io.StringIO(clean_csv)):
        records += 1
        year, month = int(row["year"]), int(row["month"])
        counts[(row["la_code"], row["severity_code"])] += 1
        names[row["la_code"]] = row["la_name"]
    return {
        "year": year,
        "month": month,
        "records": records,
        "la_names": names,
        "counts": [[la, int(sev), n] for (la, sev), n in sorted(counts.items())],
    }


def rows_checksum(rows: Iterable[list]) -> str:
    """Order-independent fingerprint of the summary rows."""
    canonical = json.dumps(sorted(rows), separators=(",", ":"))
    return sha256_hex(canonical.encode("utf-8"))


def merge_partials(partials: list[dict]) -> dict:
    """Combine partial counts into the dashboard-ready summary."""
    rows: list[list] = []
    names: dict[str, str] = {}
    partition_records = 0
    for p in partials:
        if p["records"] == 0:
            continue
        partition_records += p["records"]
        names.update(p["la_names"])
        for la, sev, n in p["counts"]:
            rows.append([p["year"], p["month"], la, sev, n])
    rows.sort()

    summed = sum(r[4] for r in rows)
    by_sev: Counter = Counter()
    by_month: Counter = Counter()
    for y, m, _la, sev, n in rows:
        by_sev[SEVERITY_LABELS[str(sev)]] += n
        by_month[f"{y}-{m:02d}"] += n

    return {
        "scope_note": SCOPE_NOTE,
        "row_schema": ["year", "month", "la_code", "severity_code", "collisions"],
        "severity_labels": {int(k): v for k, v in SEVERITY_LABELS.items()},
        "local_authorities": [
            {"code": c, "name": n} for c, n in sorted(names.items(), key=lambda kv: kv[1])
        ],
        "totals": {
            "collisions": summed,
            "by_severity": {lab: by_sev.get(lab, 0) for lab in SEVERITY_LABELS.values()},
            "by_month": dict(sorted(by_month.items())),
        },
        "reconciliation": {
            "records_read_from_partitions": partition_records,
            "sum_of_summary_counts": summed,
            "match": partition_records == summed,
        },
        "rows": rows,
        "checksum": rows_checksum(rows),
    }
