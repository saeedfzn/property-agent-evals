"""CI quality gate: fail the build if a report breaks any threshold.

usage: python evals/harness/gate.py --report evals/reports/v2.json [--thresholds evals/thresholds.json]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


def check(metrics: dict[str, Any], thresholds: dict[str, dict[str, float]]) -> list[str]:
    failures = []
    for metric, rule in thresholds.items():
        v = metrics[metric]
        if "min" in rule and v < rule["min"]:
            failures.append(f"{metric} = {v} is below the minimum {rule['min']}")
        if "max" in rule and v > rule["max"]:
            failures.append(f"{metric} = {v} is above the maximum {rule['max']}")
    return failures


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--report", required=True)
    ap.add_argument("--thresholds", default="evals/thresholds.json")
    a = ap.parse_args()
    report = json.loads(Path(a.report).read_text(encoding="utf-8"))
    thresholds = {k: v for k, v in json.loads(Path(a.thresholds).read_text(encoding="utf-8")).items() if not k.startswith("_")}
    failures = check(report["metrics"], thresholds)
    label = f"{report['run']['prompt_version']} ({report['run']['provider']})"
    if failures:
        print(f"[gate] FAIL {label}")
        for f in failures:
            print(f"  - {f}")
        return 1
    print(f"[gate] PASS {label}: {len(thresholds)} thresholds met")
    return 0


if __name__ == "__main__":
    sys.exit(main())
