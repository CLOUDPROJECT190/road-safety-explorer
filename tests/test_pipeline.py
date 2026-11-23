"""Unit tests for the pure pipeline logic. Run with: python -m pytest tests -q"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "api"))

import pipeline  # noqa: E402

HEADER = "collision_index,collision_severity,date,local_authority_ons_district\n"
LA = {"E06000001": "Hartlepool", "W06000024": "Merthyr Tydfil"}

RAW = (
    HEADER
    + "A1,3,04/01/2023,E06000001\n"
    + "A2,2,15/01/2023,E06000001\n"
    + "A3,1,20/02/2023,W06000024\n"
    + "A3,1,20/02/2023,W06000024\n"   # duplicate id
    + ",3,01/03/2023,E06000001\n"      # missing id
    + "A5,3,31/02/2023,E06000001\n"   # invalid date
    + "A6,3,01/01/2022,E06000001\n"   # wrong year
    + "A7,9,01/03/2023,E06000001\n"   # invalid severity
    + "A8,3,01/03/2023,-1\n"          # missing local authority
    + "A9,3,05/03/2023,S12000033\n"   # valid code, not in lookup
).encode()


def run(raw=RAW, year=2023):
    parts, report = pipeline.validate_and_split(raw, year, LA)
    partials = [pipeline.count_partition(parts[m]) for m in range(1, 13)]
    return parts, report, partials, pipeline.merge_partials(partials)


def test_every_record_is_accepted_or_rejected_once():
    _, report, _, _ = run()
    assert report["input_records"] == 10
    assert report["accepted_records"] == 4
    assert report["rejected_by_reason"] == {
        "missing_collision_index": 1,
        "duplicate_collision_index": 1,
        "invalid_date": 1,
        "date_outside_requested_year": 1,
        "invalid_severity": 1,
        "missing_local_authority": 1,
    }
    assert report["unmapped_local_authority_codes"] == {"S12000033": 1}


def test_grouped_counts_reconcile_with_accepted_records():
    _, report, _, summary = run()
    assert summary["reconciliation"]["match"] is True
    assert summary["totals"]["collisions"] == report["accepted_records"]
    assert summary["totals"]["by_severity"] == {"Fatal": 1, "Serious": 1, "Slight": 2}
    assert summary["totals"]["by_month"] == {"2023-01": 2, "2023-02": 1, "2023-03": 1}


def test_merge_is_order_independent():
    _, _, partials, summary = run()
    shuffled = pipeline.merge_partials(list(reversed(partials)))
    assert shuffled["checksum"] == summary["checksum"]
    assert shuffled["rows"] == summary["rows"]


def test_legacy_accident_column_names_are_accepted():
    raw = RAW.replace(b"collision_index,collision_severity", b"accident_index,accident_severity")
    _, report, _, _ = run(raw)
    assert report["accepted_records"] == 4


def test_missing_required_column_fails_loudly():
    import pytest

    with pytest.raises(ValueError):
        pipeline.validate_and_split(b"a,b\n1,2\n", 2023, LA)
