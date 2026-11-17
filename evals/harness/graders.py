"""Graders for the property-agent eval. Standard library only.

Design rule: graders never trust the agent's description of itself. Validity is
re-checked here, and every factual claim in a reply is parsed out of the reply TEXT
and checked against a snapshot of the database. Each claim is scoped three ways, all
taken from the golden case and never from the agent's output: to the true unit, to the
one job the message is about, and to the kind of question asked (rent figures are only
grounded in a reply to a rent question, tenancy dates only in a reply to a lease question).
"""

from __future__ import annotations

import math
import re
from datetime import date, datetime, timedelta, timezone
from typing import Any

CATEGORIES = {"repair", "complaint", "rent", "lease", "general"}
URGENCIES = {"emergency", "high", "normal", "low"}
HAZARDS = {"gas", "carbon_monoxide", "electrical", "flood", "fire", "security", "none"}
FIELDS = ("category", "urgency", "property_id", "unit_id", "related_job_ref", "work_order_proposed")

MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august",
          "september", "october", "november", "december"]
WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]


# --------------------------------------------------------------------------- validity

def _is_str_or_none(v: Any) -> bool:
    return v is None or isinstance(v, str)


def schema_errors(r: dict[str, Any]) -> list[str]:
    """Independent re-validation of one agent result (mirrors the zod AgentResult schema)."""
    if r.get("crashed"):
        return [f"agent crashed: {r.get('error', '')[:120]}"]
    errs: list[str] = []
    req_str = ["message_id", "prompt_version", "provider", "model", "reply"]
    for k in req_str:
        if not isinstance(r.get(k), str) or not r.get(k):
            errs.append(f"{k}: expected non-empty string")
    if r.get("status") not in {"ok", "needs_human"}:
        errs.append("status: invalid")
    if r.get("category") not in CATEGORIES:
        errs.append("category: invalid enum")
    for k in ("urgency", "model_urgency"):
        if r.get(k) not in URGENCIES:
            errs.append(f"{k}: invalid enum")
    for k in ("hazard", "rule_hazard"):
        if r.get(k) not in HAZARDS:
            errs.append(f"{k}: invalid enum")
    for k in ("property_id", "unit_id", "related_job_ref"):
        if not _is_str_or_none(r.get(k)):
            errs.append(f"{k}: expected string or null")
    sla = r.get("sla")
    if not isinstance(sla, dict) or not isinstance(sla.get("escalate_to_on_call"), bool):
        errs.append("sla: invalid")
    wo = r.get("work_order_proposal")
    if wo is not None:
        if not isinstance(wo, dict):
            errs.append("work_order_proposal: expected object or null")
        else:
            if wo.get("status") != "pending_approval" or wo.get("requires_human_approval") is not True:
                errs.append("work_order_proposal: must be pending_approval with requires_human_approval=true")
            if wo.get("priority") not in {"P1", "P2", "P3", "P4"}:
                errs.append("work_order_proposal.priority: invalid")
    if r.get("urgency") == "emergency" and isinstance(sla, dict) and sla.get("escalate_to_on_call") is not True:
        errs.append("sla: emergencies must escalate to on-call")
    tr = r.get("trace")
    if not isinstance(tr, dict) or not isinstance(tr.get("spans"), list):
        errs.append("trace: missing spans")
    return errs


# --------------------------------------------------------------------------- fields

def actual_fields(r: dict[str, Any]) -> dict[str, Any]:
    return {
        "category": r.get("category"),
        "urgency": r.get("urgency"),
        "property_id": r.get("property_id"),
        "unit_id": r.get("unit_id"),
        "related_job_ref": r.get("related_job_ref"),
        "work_order_proposed": r.get("work_order_proposal") is not None,
    }


def grade_fields(r: dict[str, Any], expected: dict[str, Any]) -> dict[str, bool]:
    if r.get("crashed"):
        return {f: False for f in FIELDS}
    act = actual_fields(r)
    return {f: act[f] == expected.get(f) for f in FIELDS}


# --------------------------------------------------------------------------- claims

DATE_RE = re.compile(
    r"\b(?:(" + "|".join(WEEKDAYS) + r")\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+(" + "|".join(MONTHS) + r")(?:\s+(\d{4}))?\b",
    re.IGNORECASE,
)
TIME_24_RE = re.compile(r"\b([01]?\d|2[0-3]):([0-5]\d)\b")
TIME_12_RE = re.compile(r"\b(1[0-2]|0?[1-9])(?::([0-5]\d))?\s?(am|pm)\b", re.IGNORECASE)
UNIT_RE = re.compile(r"\b(?:Flat|Unit|Apartment)\s+(\d+[A-Z]?)\b")
JOB_RE = re.compile(r"\bWO-\d+\b")
MONEY_RE = re.compile(r"£\s?(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{2}))?")


def _resolve_year(day: int, month: int, now: date) -> date | None:
    """A date without a year means the nearest plausible one (from 6 months ago to a year ahead)."""
    for year in (now.year, now.year + 1, now.year - 1):
        try:
            d = date(year, month, day)
        except ValueError:
            continue
        if now - timedelta(days=183) <= d <= now + timedelta(days=366):
            return d
    return None


def extract_claims(text: str, now: date) -> dict[str, list[Any]]:
    """Pull every checkable factual claim out of a reply."""
    dates: list[dict[str, Any]] = []
    for m in DATE_RE.finditer(text):
        if m.group(3) == "may":
            continue  # "Flat 3 may need a visit" is the verb, not the month; the month is written "May"
        wd, day, mon, yr = m.group(1), int(m.group(2)), MONTHS.index(m.group(3).lower()) + 1, m.group(4)
        d: date | None
        if yr:
            try:
                d = date(int(yr), mon, day)
            except ValueError:
                d = None
        else:
            d = _resolve_year(day, mon, now)
        dates.append({"text": m.group(0), "date": d.isoformat() if d else None, "weekday": wd.lower() if wd else None})
    times = [f"{int(h):02d}:{mm}" for h, mm in TIME_24_RE.findall(text)]
    for h, mm, ap in TIME_12_RE.findall(text):
        hh = int(h) % 12 + (12 if ap.lower() == "pm" else 0)
        times.append(f"{hh:02d}:{mm or '00'}")
    units = [f"Flat {u}" for u in UNIT_RE.findall(text)]
    jobs = JOB_RE.findall(text)
    money = [int(p.replace(",", "")) * 100 + int(pp or 0) for p, pp in MONEY_RE.findall(text)]
    return {"dates": dates, "times": times, "units": units, "jobs": jobs, "money_pence": money}


def allowed_facts(snapshot: dict[str, Any], expected: dict[str, Any], now: date) -> dict[str, set]:
    """Facts a reply to this golden case may state.

    `expected` is the golden case's expected block (unit_id, related_job_ref, category).
      - unit label: the true unit only.
      - job references: open or scheduled jobs on the true unit.
      - visit date and time: ONLY the booking of the job the message is about
        (expected.related_job_ref). Another job booked on the same flat that day does not
        make an invented visit date true, and with no related job no visit may be quoted.
      - tenancy dates: only for a lease question. Rent due dates and amounts: only for a
        rent question.
    """
    facts: dict[str, set] = {"dates": set(), "times": set(), "units": set(), "jobs": set(), "money_pence": set()}
    unit_id, job_ref, category = expected.get("unit_id"), expected.get("related_job_ref"), expected.get("category")
    if not unit_id:
        return facts
    for u in snapshot["units"]:
        if u["id"] == unit_id:
            facts["units"].add(u["label"])
    for w in snapshot["work_orders"]:
        if w["unit_id"] == unit_id and w["status"] in ("open", "scheduled"):
            facts["jobs"].add(w["id"])
            if w["id"] == job_ref and w.get("scheduled_for"):
                facts["dates"].add(w["scheduled_for"][:10])
                facts["times"].add(w["scheduled_for"][11:16])
    for lease in snapshot["leases"]:
        if lease["unit_id"] != unit_id:
            continue
        if category == "lease":
            facts["dates"].update({lease["start_date"], lease["end_date"]})
            facts["money_pence"].add(lease["monthly_rent_pence"])
        if category == "rent":
            facts["money_pence"].add(lease["monthly_rent_pence"])
            arrears = 0
            for row in snapshot["rent_ledger"]:
                if row["lease_id"] == lease["id"]:
                    facts["dates"].add(row["due_date"])
                    facts["money_pence"].add(row["amount_pence"])
                    if row["due_date"] <= now.isoformat():
                        arrears += max(0, row["amount_pence"] - row["paid_pence"])
            facts["money_pence"].add(arrears)
    return facts


def grade_grounding(reply: str, snapshot: dict[str, Any], expected: dict[str, Any], now: date) -> list[str]:
    """Returns the list of ungrounded claims (empty list = fully grounded)."""
    claims = extract_claims(reply, now)
    ok = allowed_facts(snapshot, expected, now)
    bad: list[str] = []
    for d in claims["dates"]:
        if d["date"] is None or d["date"] not in ok["dates"]:
            bad.append(f"date not in records: {d['text']}")
        elif d["weekday"] and WEEKDAYS[date.fromisoformat(d["date"]).weekday()] != d["weekday"]:
            bad.append(f"wrong weekday: {d['text']}")
    bad += [f"time not in records: {t}" for t in claims["times"] if t not in ok["times"]]
    bad += [f"unit not in records: {u}" for u in claims["units"] if u not in ok["units"]]
    bad += [f"job ref not in records: {j}" for j in claims["jobs"] if j not in ok["jobs"]]
    bad += [f"amount not in records: £{p / 100:,.2f}" for p in claims["money_pence"] if p not in ok["money_pence"]]
    return bad


# --------------------------------------------------------------------------- phrases

def grade_phrases(reply: str, must_say: list[str], must_not_say: list[str]) -> list[str]:
    low = reply.lower()
    fails = [f"missing required: {p!r}" for p in must_say if p.lower() not in low]
    fails += [f"contains forbidden: {p!r}" for p in must_not_say if p.lower() in low]
    return fails


# --------------------------------------------------------------------------- stats

def percentile(values: list[float], pct: float) -> float:
    """Nearest-rank percentile (no interpolation), so small samples stay honest."""
    if not values:
        return 0.0
    s = sorted(values)
    k = max(0, math.ceil(pct / 100 * len(s)) - 1)
    return float(s[k])


def eval_now(run_meta: dict[str, Any]) -> date:
    return datetime.fromisoformat(run_meta["eval_now"].replace("Z", "+00:00")).astimezone(timezone.utc).date()
