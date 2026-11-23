#!/usr/bin/env python3
"""Local reference analysis (milestone 1).

An independent pandas implementation of the same analysis the cloud pipeline
runs. Its output is the yardstick for checking cloud results: the checksum
printed here must equal the checksum in the cloud job summary.

Usage
-----
    pip install pandas
    python analysis/reference_analysis.py 2023
    python analysis/reference_analysis.py 2023 2024 --out reference.json
    python analysis/reference_analysis.py 2023 --compare cloud-summary.json
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import urllib.request
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "analysis" / "data"
URL = "https://data.dft.gov.uk/road-accidents-safety-data/dft-road-casualty-statistics-collision-{year}.csv"
SEVERITY = {1: "Fatal", 2: "Serious", 3: "Slight"}


def load_year(year: int) -> pd.DataFrame:
    CACHE.mkdir(parents=True, exist_ok=True)
    path = CACHE / f"collision-{year}.csv"
    if not path.exists():
        print(f"Downloading {year} from DfT ...", file=sys.stderr)
        urllib.request.urlretrieve(URL.format(year=year), path)
    df = pd.read_csv(path, dtype=str, encoding="utf-8-sig", keep_default_na=False)
    return df.rename(columns={"accident_index": "collision_index", "accident_severity": "collision_severity"})


def analyse_year(year: int) -> tuple[pd.DataFrame, dict]:
    df = load_year(year)
    n_input = len(df)
    excluded = {}

    def drop(mask, reason):
        nonlocal df
        excluded[reason] = int(mask.sum())
        df = df[~mask]

    drop(df["collision_index"].str.strip() == "", "missing_collision_index")
    drop(df["collision_index"].duplicated(keep="first"), "duplicate_collision_index")
    parsed = pd.to_datetime(df["date"], format="%d/%m/%Y", errors="coerce")
    drop(parsed.isna(), "invalid_date")
    parsed = pd.to_datetime(df["date"], format="%d/%m/%Y")
    drop(parsed.dt.year != year, "date_outside_requested_year")
    drop(~df["collision_severity"].isin(["1", "2", "3"]), "invalid_severity")
    drop(~df["local_authority_ons_district"].str.match(r"^[ENSW]\d{8}$"), "missing_local_authority")

    df = df.assign(
        year=year,
        month=pd.to_datetime(df["date"], format="%d/%m/%Y").dt.month,
        severity_code=df["collision_severity"].astype(int),
    )
    grouped = (
        df.groupby(["year", "month", "local_authority_ons_district", "severity_code"])
        .size()
        .reset_index(name="collisions")
    )
    report = {
        "year": year,
        "input_records": n_input,
        "accepted_records": len(df),
        "excluded_by_reason": excluded,
    }
    # The check the brief asks for: grouped counts must add back up to accepted input.
    assert int(grouped["collisions"].sum()) == len(df), "grouped counts do not reconcile"
    assert n_input == len(df) + sum(excluded.values()), "exclusions do not reconcile"
    return grouped, report


def checksum(rows: list[list]) -> str:
    return hashlib.sha256(json.dumps(sorted(rows), separators=(",", ":")).encode()).hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("years", nargs="+", type=int)
    ap.add_argument("--out", help="write the reference summary to this JSON file")
    ap.add_argument("--compare", help="cloud summary JSON (GET /api/jobs/{id}/result) to check against")
    args = ap.parse_args()

    frames, reports = [], []
    for y in sorted(set(args.years)):
        g, r = analyse_year(y)
        frames.append(g)
        reports.append(r)
    allg = pd.concat(frames, ignore_index=True)
    rows = [[int(a), int(b), str(c), int(d), int(e)] for a, b, c, d, e in allg.itertuples(index=False)]
    result = {
        "reports": reports,
        "totals": {
            "collisions": int(allg["collisions"].sum()),
            "by_severity": {SEVERITY[k]: int(v) for k, v in allg.groupby("severity_code")["collisions"].sum().items()},
        },
        "rows": sorted(rows),
        "checksum": checksum(rows),
    }

    for r in reports:
        print(f"{r['year']}: input {r['input_records']:,}  accepted {r['accepted_records']:,}  excluded {r['excluded_by_reason']}")
    print(f"total collisions: {result['totals']['collisions']:,}  by severity: {result['totals']['by_severity']}")
    print(f"summary rows: {len(rows):,}")
    print(f"checksum: {result['checksum']}")

    if args.out:
        Path(args.out).write_text(json.dumps(result))
        print(f"wrote {args.out}")

    if args.compare:
        cloud = json.loads(Path(args.compare).read_text())
        cloud = cloud.get("summary", cloud)
        ok = cloud["checksum"] == result["checksum"]
        print(f"cloud checksum: {cloud['checksum']}")
        print("MATCH: cloud result equals local reference" if ok else "MISMATCH: cloud result differs from local reference")
        return 0 if ok else 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
