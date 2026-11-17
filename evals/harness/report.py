"""Grade one eval run and write a JSON report + a markdown summary.

usage: python evals/harness/report.py --run evals/runs/v2 --out evals/reports/v2
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
import graders as g  # noqa: E402


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def build_report(golden: list[dict[str, Any]], results: list[dict[str, Any]], snapshot: dict[str, Any], meta: dict[str, Any]) -> dict[str, Any]:
    by_id = {r.get("message_id"): r for r in results}
    now = g.eval_now(meta)
    cases: list[dict[str, Any]] = []
    field_hits = {f: 0 for f in g.FIELDS}
    lat, cost, tokens_in, tokens_out = [], [], [], []
    emerg_expected = emerg_tp = emerg_fp = model_tp = 0
    non_emerg = 0
    valid = first_pass = retries_transient = 0
    claims_total = ungrounded_total = 0

    for case in golden:
        cid, exp = case["id"], case["expected"]
        r = by_id.get(cid, {"message_id": cid, "crashed": True, "error": "no result"})
        schema = g.schema_errors(r)
        fields = g.grade_fields(r, exp)
        for f, hit in fields.items():
            field_hits[f] += int(hit)
        reply = r.get("reply", "") if not r.get("crashed") else ""
        ungrounded = g.grade_grounding(reply, snapshot, exp, now) if reply else []
        claims = g.extract_claims(reply, now)
        claims_total += sum(len(v) for v in claims.values())
        ungrounded_total += len(ungrounded)
        phrases = g.grade_phrases(reply, case.get("must_say", []), case.get("must_not_say", []))

        is_emerg = exp["urgency"] == "emergency"
        got_emerg = r.get("urgency") == "emergency"
        if is_emerg:
            emerg_expected += 1
            emerg_tp += int(got_emerg)
            model_tp += int(r.get("model_urgency") == "emergency")
        else:
            non_emerg += 1
            emerg_fp += int(got_emerg)

        if not schema:
            valid += 1
            first_pass += int(r.get("schema_failures", 0) == 0)
            tr = r["trace"]
            if meta["provider"] == "fixture":
                # Simulated model time only, so committed reports are byte-stable across runs.
                # (Measured DB/tool time is a few ms and is kept in each trace.)
                lat.append(sum(sp["latency_ms"] for sp in tr["spans"] if sp["kind"] == "model"))
            else:
                lat.append(tr["total_latency_ms"])
            cost.append(tr["total_cost_usd"])
            tokens_in.append(tr["total_input_tokens"])
            tokens_out.append(tr["total_output_tokens"])
            retries_transient += sum(1 for s in tr["spans"] if s["kind"] == "model" and not s["ok"])

        checks = {
            "schema_valid": not schema,
            "fields_exact": all(fields.values()),
            "grounded": not ungrounded,
            "phrases": not phrases,
            "emergency_correct": got_emerg == is_emerg,
        }
        cases.append({
            "id": cid,
            "passed": all(checks.values()),
            "checks": checks,
            "field_misses": {f: {"expected": exp.get(f), "actual": g.actual_fields(r).get(f)} for f, ok in fields.items() if not ok} if not r.get("crashed") else {"crashed": True},
            "ungrounded_claims": ungrounded,
            "phrase_failures": phrases,
            "schema_errors": schema,
            "schema_retries": r.get("schema_failures", 0),
        })

    n = len(golden)
    metrics = {
        "cases": n,
        "pass_rate": round(sum(c["passed"] for c in cases) / n, 4),
        "field_accuracy": round(sum(field_hits.values()) / (n * len(g.FIELDS)), 4),
        "field_accuracy_by_field": {f: round(v / n, 4) for f, v in field_hits.items()},
        "emergency_recall": round(emerg_tp / emerg_expected, 4) if emerg_expected else 1.0,
        "emergency_recall_model_only": round(model_tp / emerg_expected, 4) if emerg_expected else 1.0,
        "emergency_false_positive_rate": round(emerg_fp / non_emerg, 4) if non_emerg else 0.0,
        "schema_validity": round(valid / n, 4),
        "schema_first_pass_validity": round(first_pass / n, 4),
        "hallucination_rate": round(sum(1 for c in cases if c["ungrounded_claims"]) / n, 4),
        "ungrounded_claims": ungrounded_total,
        "checkable_claims": claims_total,
        "phrase_pass_rate": round(sum(1 for c in cases if not c["phrase_failures"]) / n, 4),
        "latency_ms_p50": round(g.percentile(lat, 50), 1),
        "latency_ms_p95": round(g.percentile(lat, 95), 1),
        "cost_usd_per_message": round(sum(cost) / len(cost), 6) if cost else 0.0,
        "input_tokens_per_message": round(sum(tokens_in) / len(tokens_in), 1) if tokens_in else 0.0,
        "output_tokens_per_message": round(sum(tokens_out) / len(tokens_out), 1) if tokens_out else 0.0,
        "transient_retries": retries_transient,
        "unapproved_writes": meta["work_orders_after"] - meta["work_orders_before"],
    }
    return {
        "run": {k: meta[k] for k in ("prompt_version", "provider", "model", "cases", "eval_now")},
        "notes": "fixture provider: latency is simulated model time and cost is estimated from token counts at list price"
        if meta["provider"] == "fixture" else "live provider",
        "metrics": metrics,
        "cases": cases,
    }


def pct(x: float) -> str:
    return f"{x * 100:.1f}%"


def render_markdown(rep: dict[str, Any]) -> str:
    m, run = rep["metrics"], rep["run"]
    lines = [
        f"# Eval report: prompt {run['prompt_version']} ({run['provider']} / {run['model']})",
        "",
        f"_{rep['notes']}._",
        "",
        "| Metric | Value |",
        "|---|---|",
        f"| Cases | {m['cases']} |",
        f"| Cases passing every check | {pct(m['pass_rate'])} |",
        f"| Field accuracy (6 fields x {m['cases']}) | {pct(m['field_accuracy'])} |",
        f"| Emergency recall (final) | {pct(m['emergency_recall'])} |",
        f"| Emergency recall (model alone, before code rules) | {pct(m['emergency_recall_model_only'])} |",
        f"| Emergency false-positive rate | {pct(m['emergency_false_positive_rate'])} |",
        f"| Structured-output validity (after retry) | {pct(m['schema_validity'])} |",
        f"| Structured-output validity (first attempt) | {pct(m['schema_first_pass_validity'])} |",
        f"| Hallucination rate (replies with an ungrounded claim) | {pct(m['hallucination_rate'])} |",
        f"| Ungrounded / checkable claims | {m['ungrounded_claims']} / {m['checkable_claims']} |",
        f"| Must-say / must-not-say pass rate | {pct(m['phrase_pass_rate'])} |",
        f"| Latency p50 / p95 per message | {m['latency_ms_p50']:.0f} ms / {m['latency_ms_p95']:.0f} ms |",
        f"| Est. cost per message | ${m['cost_usd_per_message']:.4f} |",
        f"| Input / output tokens per message | {m['input_tokens_per_message']:.0f} / {m['output_tokens_per_message']:.0f} |",
        f"| Transient errors retried | {m['transient_retries']} |",
        f"| Work orders written without approval | {m['unapproved_writes']} |",
        "",
        "## Field accuracy by field",
        "",
        "| Field | Accuracy |",
        "|---|---|",
    ]
    lines += [f"| {f} | {pct(v)} |" for f, v in m["field_accuracy_by_field"].items()]
    failing = [c for c in rep["cases"] if not c["passed"]]
    lines += ["", f"## Failing cases ({len(failing)})", ""]
    if not failing:
        lines.append("None.")
    for c in failing:
        why = [k for k, ok in c["checks"].items() if not ok]
        detail = c["ungrounded_claims"] + c["phrase_failures"] + c["schema_errors"]
        detail += [f"{f}: expected {v['expected']!r}, got {v['actual']!r}" for f, v in c["field_misses"].items() if isinstance(v, dict)]
        lines.append(f"- **{c['id']}** ({', '.join(why)}): " + "; ".join(detail))
    return "\n".join(lines) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True, help="directory with results.jsonl, snapshot.json, run.json")
    ap.add_argument("--golden", default="evals/golden/cases.jsonl")
    ap.add_argument("--out", required=True, help="output path prefix, e.g. evals/reports/v2")
    a = ap.parse_args()
    run = Path(a.run)
    rep = build_report(
        load_jsonl(Path(a.golden)),
        load_jsonl(run / "results.jsonl"),
        json.loads((run / "snapshot.json").read_text(encoding="utf-8")),
        json.loads((run / "run.json").read_text(encoding="utf-8")),
    )
    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.with_suffix(".json").write_text(json.dumps(rep, indent=2) + "\n", encoding="utf-8", newline="\n")
    out.with_suffix(".md").write_text(render_markdown(rep), encoding="utf-8", newline="\n")
    m = rep["metrics"]
    print(f"[report] {out.with_suffix('.json')}: pass {pct(m['pass_rate'])}, fields {pct(m['field_accuracy'])}, "
          f"emergency recall {pct(m['emergency_recall'])}, hallucination {pct(m['hallucination_rate'])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
