"""Compare two eval reports and flag regressions.

usage: python evals/harness/compare.py --base evals/reports/v1.json --head evals/reports/v2.json \
           [--out evals/reports/comparison.md] [--fail-on-regression]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

# metric -> (direction, absolute tolerance before a worse value counts as a regression)
# Latency is measured partly in wall-clock time, so it gets a relative tolerance instead.
METRICS: dict[str, tuple[str, float]] = {
    "pass_rate": ("higher", 0.0),
    "field_accuracy": ("higher", 0.0),
    "emergency_recall": ("higher", 0.0),
    "emergency_false_positive_rate": ("lower", 0.0),
    "schema_validity": ("higher", 0.0),
    "schema_first_pass_validity": ("higher", 0.04),
    "hallucination_rate": ("lower", 0.0),
    "phrase_pass_rate": ("higher", 0.0),
    "cost_usd_per_message": ("lower", 0.0001),
    "latency_ms_p50": ("lower", -0.15),
    "latency_ms_p95": ("lower", -0.15),
    "unapproved_writes": ("lower", 0.0),
}
PERCENT = {"pass_rate", "field_accuracy", "emergency_recall", "emergency_false_positive_rate", "schema_validity",
           "schema_first_pass_validity", "hallucination_rate", "phrase_pass_rate"}


def fmt(metric: str, v: float) -> str:
    if metric in PERCENT:
        return f"{v * 100:.1f}%"
    if metric.startswith("cost"):
        return f"${v:.4f}"
    if metric.startswith("latency"):
        return f"{v:.0f} ms"
    return f"{v:g}"


def compare(base: dict[str, Any], head: dict[str, Any]) -> dict[str, Any]:
    rows, regressions, improvements = [], [], []
    for metric, (direction, tol) in METRICS.items():
        b, h = base["metrics"][metric], head["metrics"][metric]
        delta = h - b
        worse = delta < 0 if direction == "higher" else delta > 0
        better = delta > 0 if direction == "higher" else delta < 0
        allowed = abs(b) * -tol if tol < 0 else tol  # negative tol = relative
        status = "same"
        if worse and abs(delta) > allowed:
            status = "REGRESSION"
            regressions.append(metric)
        elif better and abs(delta) > 0:
            status = "improved"
            improvements.append(metric)
        elif worse:
            status = "within tolerance"
        rows.append({"metric": metric, "base": b, "head": h, "delta": delta, "status": status})
    base_cases = {c["id"]: c for c in base["cases"]}
    newly_failing = [c["id"] for c in head["cases"] if not c["passed"] and base_cases.get(c["id"], {}).get("passed")]
    newly_passing = [c["id"] for c in head["cases"] if c["passed"] and not base_cases.get(c["id"], {"passed": True})["passed"]]
    return {"rows": rows, "regressions": regressions, "improvements": improvements,
            "newly_failing": newly_failing, "newly_passing": newly_passing}


def render(base: dict[str, Any], head: dict[str, Any], cmp: dict[str, Any]) -> str:
    bl, hl = base["run"]["prompt_version"], head["run"]["prompt_version"]
    out = [f"# Eval comparison: {bl} (base) vs {hl} (head)", "",
           f"_{head['notes']}._", "",
           f"| Metric | {bl} | {hl} | Status |", "|---|---|---|---|"]
    for r in cmp["rows"]:
        out.append(f"| {r['metric']} | {fmt(r['metric'], r['base'])} | {fmt(r['metric'], r['head'])} | {r['status']} |")
    out += ["",
            f"- Regressions: {', '.join(cmp['regressions']) or 'none'}",
            f"- Newly failing cases: {', '.join(cmp['newly_failing']) or 'none'}",
            f"- Newly passing cases: {', '.join(cmp['newly_passing']) or 'none'}"]
    return "\n".join(out) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--head", required=True)
    ap.add_argument("--out")
    ap.add_argument("--fail-on-regression", action="store_true")
    a = ap.parse_args()
    base = json.loads(Path(a.base).read_text(encoding="utf-8"))
    head = json.loads(Path(a.head).read_text(encoding="utf-8"))
    cmp = compare(base, head)
    md = render(base, head, cmp)
    if a.out:
        Path(a.out).write_text(md, encoding="utf-8", newline="\n")
    print(md)
    if cmp["regressions"] or cmp["newly_failing"]:
        print(f"[compare] REGRESSIONS: {cmp['regressions']} newly failing: {cmp['newly_failing']}")
        return 1 if a.fail_on_regression else 0
    print("[compare] no regressions")
    return 0


if __name__ == "__main__":
    sys.exit(main())
