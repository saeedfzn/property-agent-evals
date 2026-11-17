"""Render the README results table from the committed reports (single source of truth).

usage: python evals/harness/readme_table.py [--write]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
START, END = "<!-- results:start -->", "<!-- results:end -->"

ROWS = [
    ("Emergency recall (final, after code rules)", "emergency_recall", "pct"),
    ("Emergency recall (model alone)", "emergency_recall_model_only", "pct"),
    ("Emergency false-positive rate (lookalikes)", "emergency_false_positive_rate", "pct"),
    ("Field accuracy (6 fields x 25 cases)", "field_accuracy", "pct"),
    ("Structured-output validity (first try / after retry)", ("schema_first_pass_validity", "schema_validity"), "pct2"),
    ("**Hallucination rate** (replies with an ungrounded claim)", "hallucination_rate", "pct"),
    ("Ungrounded claims / checkable claims", ("ungrounded_claims", "checkable_claims"), "ratio"),
    ("Must-say / must-not-say pass rate", "phrase_pass_rate", "pct"),
    ("Cases passing every check", "pass_rate", "pct"),
    ("Latency p50 / p95 per message (simulated model time)", ("latency_ms_p50", "latency_ms_p95"), "ms2"),
    ("Est. cost per message (token count x list price)", "cost_usd_per_message", "usd"),
    ("Work orders written without approval", "unapproved_writes", "int"),
]


def cell(m: dict, key, kind: str) -> str:
    if kind == "pct":
        return f"{m[key] * 100:.1f}%"
    if kind == "pct2":
        return f"{m[key[0]] * 100:.0f}% / {m[key[1]] * 100:.0f}%"
    if kind == "ratio":
        return f"{m[key[0]]} / {m[key[1]]}"
    if kind == "ms2":
        return f"{m[key[0]]:.0f} / {m[key[1]]:.0f} ms"
    if kind == "usd":
        return f"${m[key]:.4f}"
    return str(m[key])


def render() -> str:
    v1 = json.loads((ROOT / "evals/reports/v1.json").read_text(encoding="utf-8"))["metrics"]
    v2 = json.loads((ROOT / "evals/reports/v2.json").read_text(encoding="utf-8"))["metrics"]
    lines = ["| Metric (25 golden cases, fixture provider) | v1 prompt | v2 prompt |", "|---|---|---|"]
    lines += [f"| {label} | {cell(v1, key, kind)} | {cell(v2, key, kind)} |" for label, key, kind in ROWS]
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true", help="replace the table in README.md")
    a = ap.parse_args()
    table = render()
    if not a.write:
        print(table)
        return 0
    readme = ROOT / "README.md"
    text = readme.read_text(encoding="utf-8")
    if START not in text or END not in text:
        print("README.md has no results markers", file=sys.stderr)
        return 1
    head, rest = text.split(START, 1)
    _, tail = rest.split(END, 1)
    readme.write_text(f"{head}{START}\n{table}\n{END}{tail}", encoding="utf-8", newline="\n")
    print("[readme] results table updated")
    return 0


if __name__ == "__main__":
    sys.exit(main())
