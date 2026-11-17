"""Unit tests for the graders: each grader is fed hand-made bad output to prove it fires.

run: python -m unittest discover -s evals/tests -v
"""

from __future__ import annotations

import copy
import json
import sys
import unittest
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "evals" / "harness"))

import compare  # noqa: E402
import gate  # noqa: E402
import graders as g  # noqa: E402
import readme_table  # noqa: E402
import report  # noqa: E402

NOW = date(2026, 11, 17)

SNAPSHOT = {
    "units": [{"id": "U-A-1", "property_id": "P-A", "label": "Flat 1"}, {"id": "U-A-2", "property_id": "P-A", "label": "Flat 2"}],
    "work_orders": [
        {"id": "WO-1", "unit_id": "U-A-1", "status": "scheduled", "scheduled_for": "2026-11-19T10:00"},
        {"id": "WO-2", "unit_id": "U-A-2", "status": "open", "scheduled_for": None},
        {"id": "WO-3", "unit_id": "U-A-1", "status": "completed", "scheduled_for": "2026-10-02T09:00"},
    ],
    "leases": [{"id": "L-1", "unit_id": "U-A-1", "start_date": "2026-02-01", "end_date": "2027-01-31", "monthly_rent_pence": 125000}],
    "rent_ledger": [
        {"lease_id": "L-1", "due_date": "2026-11-01", "amount_pence": 125000, "paid_pence": 0},
        {"lease_id": "L-1", "due_date": "2026-12-01", "amount_pence": 125000, "paid_pence": 0},
    ],
}


def good_result(**over):
    r = {
        "message_id": "x1", "prompt_version": "v2", "provider": "fixture", "model": "m", "status": "ok",
        "category": "repair", "urgency": "normal", "model_urgency": "normal", "hazard": "none", "rule_hazard": "none",
        "property_id": "P-A", "unit_id": "U-A-1", "related_job_ref": "WO-1",
        "sla": {"respond_within_hours": 24, "attend_within_hours": 120, "escalate_to_on_call": False},
        "reply": "Hi, your visit is booked for Thursday 19 November at 10:00 (job WO-1).",
        "work_order_proposal": None, "schema_failures": 0, "grounding_rejections": [], "errors": [],
        "trace": {"spans": [{"kind": "model", "ok": True, "latency_ms": 1000}], "total_latency_ms": 1000, "total_input_tokens": 100,
                  "total_output_tokens": 10, "total_cost_usd": 0.001},
    }
    r.update(over)
    return r


class SchemaTests(unittest.TestCase):
    def test_valid_result_passes(self):
        self.assertEqual(g.schema_errors(good_result()), [])

    def test_bad_enum_and_missing_reply(self):
        errs = g.schema_errors(good_result(category="plumbing", reply=""))
        self.assertTrue(any("category" in e for e in errs))
        self.assertTrue(any("reply" in e for e in errs))

    def test_work_order_must_be_pending_human_approval(self):
        wo = {"status": "approved", "requires_human_approval": False, "priority": "P3"}
        self.assertTrue(any("pending_approval" in e for e in g.schema_errors(good_result(work_order_proposal=wo))))

    def test_emergency_must_escalate(self):
        r = good_result(urgency="emergency")
        self.assertTrue(any("on-call" in e for e in g.schema_errors(r)))

    def test_crash_is_invalid(self):
        self.assertTrue(g.schema_errors({"message_id": "x", "crashed": True, "error": "boom"}))


def exp(unit="U-A-1", job=None, category="repair"):
    """The slice of a golden case's `expected` block that scopes grounding."""
    return {"unit_id": unit, "related_job_ref": job, "category": category}


class GroundingTests(unittest.TestCase):
    def test_real_booking_is_grounded(self):
        self.assertEqual(g.grade_grounding(good_result()["reply"], SNAPSHOT, exp(job="WO-1"), NOW), [])

    def test_invented_visit_date_and_times_flagged(self):
        bad = g.grade_grounding("An engineer will visit on Friday 20 November between 8am and 12pm.", SNAPSHOT, exp(job="WO-1"), NOW)
        self.assertIn("date not in records: Friday 20 November", bad)
        self.assertIn("time not in records: 08:00", bad)
        self.assertIn("time not in records: 12:00", bad)

    def test_date_from_another_units_job_is_not_grounded(self):
        # 19 November is a real booking, but for U-A-1, not U-A-2.
        self.assertTrue(g.grade_grounding("Your visit is on Thursday 19 November.", SNAPSHOT, exp(unit="U-A-2", job="WO-2"), NOW))

    def test_date_from_a_different_job_on_the_same_flat_is_not_grounded(self):
        # The flat does have a visit on 19 November, but for WO-1. A NEW problem on that flat
        # (no related job) has nothing booked, so quoting the 19th is an invented appointment.
        reply = "We have booked an engineer to visit Flat 1 on Thursday 19 November at 10:00."
        self.assertEqual(g.grade_grounding(reply, SNAPSHOT, exp(job=None), NOW),
                         ["date not in records: Thursday 19 November", "time not in records: 10:00"])
        self.assertEqual(g.grade_grounding(reply, SNAPSHOT, exp(job="WO-1"), NOW), [])

    def test_rent_and_tenancy_dates_do_not_ground_a_visit_promise(self):
        # 1 December is a real rent due date and 31 January 2027 a real tenancy end date for this
        # flat, but neither is a fact a reply to a repair message may lean on.
        self.assertEqual(g.grade_grounding("An engineer will visit on 1 December.", SNAPSHOT, exp(category="repair"), NOW),
                         ["date not in records: 1 December"])
        self.assertEqual(g.grade_grounding("We will call you on 31 January 2027.", SNAPSHOT, exp(category="rent"), NOW),
                         ["date not in records: 31 January 2027"])
        self.assertEqual(g.grade_grounding("Your tenancy runs until 31 January 2027.", SNAPSHOT, exp(category="lease"), NOW), [])

    def test_wrong_weekday_flagged(self):
        self.assertEqual(g.grade_grounding("Booked for Monday 19 November.", SNAPSHOT, exp(job="WO-1"), NOW), ["wrong weekday: Monday 19 November"])

    def test_nonexistent_unit_and_foreign_job_ref_flagged(self):
        bad = g.grade_grounding("We have logged this for Flat 9 under WO-2.", SNAPSHOT, exp(), NOW)
        self.assertIn("unit not in records: Flat 9", bad)
        self.assertIn("job ref not in records: WO-2", bad)

    def test_completed_job_is_not_a_valid_reference(self):
        self.assertTrue(g.grade_grounding("See job WO-3.", SNAPSHOT, exp(), NOW))

    def test_money_must_match_ledger(self):
        rent = exp(category="rent")
        self.assertEqual(g.grade_grounding("£1,250.00 is outstanding; the next payment is due 1 December.", SNAPSHOT, rent, NOW), [])
        # Only November is past due on 17 Nov, so "£2,500.00 outstanding" overstates the arrears.
        self.assertEqual(g.grade_grounding("£2,500.00 is outstanding.", SNAPSHOT, rent, NOW), ["amount not in records: £2,500.00"])
        # A rent figure in a reply to a repair message is not grounded in anything the reply should use.
        self.assertEqual(g.grade_grounding("There is a £1,250.00 call-out charge.", SNAPSHOT, exp(), NOW), ["amount not in records: £1,250.00"])

    def test_unknown_unit_allows_no_specific_claims(self):
        self.assertTrue(g.grade_grounding("Your tenancy ends on 31 January 2027.", SNAPSHOT, exp(unit=None, category="lease"), NOW))
        self.assertEqual(g.grade_grounding("Could you confirm your flat number?", SNAPSHOT, exp(unit=None), NOW), [])

    def test_service_levels_are_not_date_claims(self):
        self.assertEqual(g.grade_grounding("We aim to attend within 24 hours, or 5 days for routine jobs.", SNAPSHOT, exp(), NOW), [])

    def test_phone_numbers_are_not_times(self):
        self.assertEqual(g.extract_claims("Call 0800 111 999 now.", NOW)["times"], [])

    def test_the_verb_may_is_not_the_month(self):
        self.assertEqual(g.extract_claims("Flat 1 may need a second visit.", NOW)["dates"], [])
        self.assertEqual([d["date"] for d in g.extract_claims("Your tenancy started on 4 May 2026.", NOW)["dates"]], ["2026-05-04"])


class PhraseAndStatsTests(unittest.TestCase):
    def test_phrases(self):
        fails = g.grade_phrases("We guarantee a visit.", ["0800 111 999"], ["guarantee"])
        self.assertEqual(len(fails), 2)

    def test_percentile_nearest_rank(self):
        self.assertEqual(g.percentile([1, 2, 3, 4, 100], 50), 3.0)
        self.assertEqual(g.percentile([1, 2, 3, 4, 100], 95), 100.0)
        self.assertEqual(g.percentile([], 95), 0.0)


def golden_case(cid, urgency="normal", unit="U-A-1"):
    return {"id": cid, "input": {}, "must_say": [], "must_not_say": [],
            "expected": {"category": "repair", "urgency": urgency, "property_id": "P-A", "unit_id": unit,
                         "related_job_ref": "WO-1", "work_order_proposed": False}}


META = {"prompt_version": "t", "provider": "fixture", "model": "m", "cases": 3, "eval_now": "2026-11-17T09:00:00Z",
        "work_orders_before": 6, "work_orders_after": 6}


class ReportTests(unittest.TestCase):
    def test_missed_emergency_and_false_positive_are_counted(self):
        golden = [golden_case("e1", "emergency"), golden_case("n1"), golden_case("n2")]
        sla_e = {"respond_within_hours": 1, "attend_within_hours": 4, "escalate_to_on_call": True}
        results = [
            good_result(message_id="e1", urgency="normal", model_urgency="normal"),           # missed emergency
            good_result(message_id="n1", urgency="emergency", model_urgency="emergency", sla=sla_e),  # false positive
            good_result(message_id="n2"),
        ]
        m = report.build_report(golden, results, SNAPSHOT, META)["metrics"]
        self.assertEqual(m["emergency_recall"], 0.0)
        self.assertEqual(m["emergency_false_positive_rate"], 0.5)

    def test_missing_result_counts_as_invalid_and_writes_are_counted(self):
        meta = dict(META, work_orders_after=7)
        m = report.build_report([golden_case("a"), golden_case("b")], [good_result(message_id="a")], SNAPSHOT, meta)["metrics"]
        self.assertEqual(m["schema_validity"], 0.5)
        self.assertEqual(m["unapproved_writes"], 1)

    def test_hallucinated_reply_counts(self):
        r = good_result(message_id="a", reply="An engineer will visit on Friday 20 November.")
        m = report.build_report([golden_case("a")], [r], SNAPSHOT, META)["metrics"]
        self.assertEqual(m["hallucination_rate"], 1.0)

    def test_report_scopes_visit_dates_to_the_golden_related_job(self):
        # Same reply, same flat: grounded when the golden case is about WO-1, a hallucination when it is a new problem.
        r = good_result(message_id="a", related_job_ref=None)
        about_wo1 = golden_case("a")
        new_problem = golden_case("a")
        new_problem["expected"]["related_job_ref"] = None
        self.assertEqual(report.build_report([about_wo1], [dict(r, related_job_ref="WO-1")], SNAPSHOT, META)["metrics"]["hallucination_rate"], 0.0)
        rep = report.build_report([new_problem], [r], SNAPSHOT, META)
        self.assertEqual(rep["metrics"]["hallucination_rate"], 1.0)
        self.assertIn("date not in records: Thursday 19 November", rep["cases"][0]["ungrounded_claims"])


class GateAndCompareTests(unittest.TestCase):
    THRESH = {"emergency_recall": {"min": 1.0}, "hallucination_rate": {"max": 0.0}}

    def test_gate_fails_on_missed_emergency(self):
        self.assertTrue(gate.check({"emergency_recall": 0.8, "hallucination_rate": 0.0}, self.THRESH))
        self.assertFalse(gate.check({"emergency_recall": 1.0, "hallucination_rate": 0.0}, self.THRESH))

    def test_compare_flags_regression_and_newly_failing_case(self):
        base_metrics = {k: 0.5 for k in compare.METRICS}
        base = {"run": {"prompt_version": "a"}, "notes": "", "metrics": base_metrics, "cases": [{"id": "c1", "passed": True}]}
        head = copy.deepcopy(base)
        head["run"]["prompt_version"] = "b"
        head["metrics"]["hallucination_rate"] = 0.6
        head["cases"][0]["passed"] = False
        out = compare.compare(base, head)
        self.assertIn("hallucination_rate", out["regressions"])
        self.assertEqual(out["newly_failing"], ["c1"])

    def test_latency_within_relative_tolerance_is_not_a_regression(self):
        base = {"run": {"prompt_version": "a"}, "notes": "", "metrics": {k: 1000.0 for k in compare.METRICS}, "cases": []}
        head = copy.deepcopy(base)
        head["metrics"]["latency_ms_p95"] = 1100.0
        self.assertNotIn("latency_ms_p95", compare.compare(base, head)["regressions"])
        head["metrics"]["latency_ms_p95"] = 1300.0
        self.assertIn("latency_ms_p95", compare.compare(base, head)["regressions"])


class RepoConsistencyTests(unittest.TestCase):
    def test_golden_set_is_well_formed(self):
        cases = report.load_jsonl(ROOT / "evals/golden/cases.jsonl")
        self.assertEqual(len(cases), 25)
        self.assertEqual(len({c["id"] for c in cases}), 25)
        for c in cases:
            self.assertIn(c["expected"]["category"], g.CATEGORIES)
            self.assertIn(c["expected"]["urgency"], g.URGENCIES)
        self.assertGreaterEqual(sum(c["expected"]["urgency"] == "emergency" for c in cases), 5)

    def test_readme_table_matches_committed_reports(self):
        readme = (ROOT / "README.md").read_text(encoding="utf-8")
        self.assertIn(readme_table.render(), readme, "README results table is stale: run `npm run demo`")

    def test_committed_v2_report_passes_gate_and_v1_does_not(self):
        thresholds = {k: v for k, v in json.loads((ROOT / "evals/thresholds.json").read_text()).items() if not k.startswith("_")}
        v1 = json.loads((ROOT / "evals/reports/v1.json").read_text())["metrics"]
        v2 = json.loads((ROOT / "evals/reports/v2.json").read_text())["metrics"]
        self.assertEqual(gate.check(v2, thresholds), [])
        self.assertTrue(gate.check(v1, thresholds))


if __name__ == "__main__":
    unittest.main()
