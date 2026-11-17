import type { Category, Hazard, Urgency } from "./schemas.js";

/**
 * Deterministic safety rules. These run in code on the raw message, BEFORE and
 * independently of the model. The model can escalate urgency, but it can never
 * downgrade a message these rules mark as an emergency.
 */
interface EmergencyRule {
  hazard: Exclude<Hazard, "none" | "security">;
  pattern: RegExp;
}

/**
 * A match is ignored only when the words IMMEDIATELY before it negate it ("no smell of gas",
 * "can't smell gas"). Negation elsewhere in the message never cancels a later positive match:
 * "no smell of gas this morning but now I can smell gas" is still an emergency (fail-safe).
 */
const NEGATED_BEFORE = /\b(?:no|not|never|without|can't|cannot|can not|don't|do not)\s+(?:any\s+)?(?:(?:longer|more)\s+)?$/i;

// All patterns are global (/g) so every occurrence is checked, not just the first.
export const EMERGENCY_RULES: readonly EmergencyRule[] = [
  {
    hazard: "gas",
    pattern: /\b(smell(?:s|ing)?\s+(?:of\s+)?gas|gas\s+(?:smell|leak|leaking|escape)|eggy\s+smell|rotten\s+eggs?)\b/gi,
  },
  {
    hazard: "carbon_monoxide",
    // The alarm must be going off; a chirping / low-battery alarm does not match.
    pattern: /\b(carbon\s+monoxide|co)\s+(alarm|detector)\b[^.]*?\b(going\s+off|sounding|alarming)\b|\bcarbon\s+monoxide\s+(leak|poisoning)\b/gi,
  },
  {
    hazard: "electrical",
    pattern: /\b(spark(?:ed|ing|s)?|burning\s+smell|smell\s+of\s+burning|electric(?:al)?\s+shock|exposed\s+(?:live\s+)?wires?)\b/gi,
  },
  {
    hazard: "flood",
    pattern: /\b(water\s+(?:is\s+)?(?:coming|pouring|leaking|dripping)\s+(?:in\s+)?through\s+(?:the\s+|my\s+)?(?:bathroom\s+|kitchen\s+)?ceiling|flood(?:ed|ing)|burst\s+pipe|pipe\s+(?:has\s+)?burst)\b/gi,
  },
  {
    hazard: "fire",
    pattern: /\b(on\s+fire|there(?:'s| is) a fire|flames|smoke\s+(?:is\s+)?coming)\b/gi,
  },
];

export interface RuleVerdict {
  hazard: Hazard;
  emergency: boolean;
  matched: string | null;
}

export function checkEmergencyRules(text: string): RuleVerdict {
  for (const rule of EMERGENCY_RULES) {
    for (const m of text.matchAll(rule.pattern)) {
      const before = text.slice(Math.max(0, m.index - 30), m.index);
      if (!NEGATED_BEFORE.test(before)) return { hazard: rule.hazard, emergency: true, matched: m[0] };
    }
  }
  return { hazard: "none", emergency: false, matched: null };
}

/** Final urgency: a rule emergency always wins; otherwise the model's view stands (it may escalate). */
export function resolveUrgency(modelUrgency: Urgency, rule: RuleVerdict): Urgency {
  if (rule.emergency) return "emergency";
  return modelUrgency;
}

export interface Sla {
  respond_within_hours: number;
  attend_within_hours: number | null;
  escalate_to_on_call: boolean;
  priority: "P1" | "P2" | "P3" | "P4";
}

/** Service levels live in code (and would live in config/DB in production), never in a prompt. */
export function slaFor(category: Category, urgency: Urgency): Sla {
  if (urgency === "emergency") return { respond_within_hours: 1, attend_within_hours: 4, escalate_to_on_call: true, priority: "P1" };
  if (category !== "repair") {
    return { respond_within_hours: urgency === "high" ? 24 : 48, attend_within_hours: null, escalate_to_on_call: false, priority: "P4" };
  }
  if (urgency === "high") return { respond_within_hours: 4, attend_within_hours: 24, escalate_to_on_call: false, priority: "P2" };
  if (urgency === "normal") return { respond_within_hours: 24, attend_within_hours: 120, escalate_to_on_call: false, priority: "P3" };
  return { respond_within_hours: 48, attend_within_hours: 480, escalate_to_on_call: false, priority: "P4" };
}

/**
 * Safety advice is a fixed, reviewed template chosen by code. The model never writes it,
 * so it cannot be paraphrased into something unsafe.
 */
export const SAFETY_NOTICES: Record<Exclude<Hazard, "none" | "security">, string> = {
  gas:
    "SAFETY FIRST: if you can smell gas, do not use light switches, flames or electrical items. Open doors and windows, turn off the gas at the meter if you can do so safely, leave the property and call the gas emergency line on 0800 111 999.",
  carbon_monoxide:
    "SAFETY FIRST: open windows, stop using any gas appliances, leave the property and get fresh air. Call the gas emergency line on 0800 111 999 and seek medical advice if anyone feels unwell.",
  electrical:
    "SAFETY FIRST: do not touch the socket or appliance. If it is safe to do so, switch off the power at the consumer unit (fuse box). If there is smoke or fire, leave and call 999.",
  flood:
    "SAFETY FIRST: turn off the water at the stopcock if you can, keep away from electrics and light fittings near the water, and switch off the power at the consumer unit if it is safe to reach.",
  fire: "SAFETY FIRST: leave the building now and call 999. Do not go back inside.",
};

export function safetyNoticeFor(hazard: Hazard): string | null {
  if (hazard === "none" || hazard === "security") return null;
  return SAFETY_NOTICES[hazard];
}

/**
 * Who may be told about a unit's rent, lease and booked jobs: its resident, or the landlord
 * of its property. The check uses records loaded by code, never anything the model returned.
 */
export function senderMayAccessUnit(
  contact: { kind: "resident" | "landlord"; unit_id: string | null; property_ids: string[] } | null,
  unit: { unit_id: string; property_id: string },
): boolean {
  if (!contact) return false;
  if (contact.kind === "resident") return contact.unit_id === unit.unit_id;
  return contact.property_ids.includes(unit.property_id);
}

/** Repairs need a work order; other categories never do. */
export function needsWorkOrder(category: Category): boolean {
  return category === "repair";
}
