import { describe, expect, it } from "vitest";
import { checkEmergencyRules, resolveUrgency, safetyNoticeFor, slaFor } from "../src/rules.js";

describe("deterministic emergency rules", () => {
  it.each([
    ["I can smell gas in the kitchen", "gas"],
    ["There's a strong eggy smell by the meter", "gas"],
    ["My carbon monoxide alarm keeps going off", "carbon_monoxide"],
    ["The socket sparked and there's a burning smell", "electrical"],
    ["Water is coming through my bathroom ceiling", "flood"],
    ["A pipe has burst under the sink", "flood"],
    ["There is a fire in the bin store", "fire"],
  ])("flags %j as %s", (text, hazard) => {
    const v = checkEmergencyRules(text);
    expect(v.emergency).toBe(true);
    expect(v.hazard).toBe(hazard);
  });

  it.each([
    "Our gas bill seems really high this quarter",
    "Smoke alarm is beeping every minute, I think the battery is low",
    "The CO alarm is chirping, battery needs replacing",
    "The boiler is noisy but there is no smell of gas",
    "The bath is leaking and water is pooling under the floor",
  ])("does not flag lookalike %j", (text) => {
    expect(checkEmergencyRules(text).emergency).toBe(false);
  });

  it.each([
    ["There was no smell of gas this morning but now I can smell gas in the hall", "gas"],
    ["My CO alarm keeps going off and I feel dizzy, I changed the battery last week", "carbon_monoxide"],
  ])("a negation or 'battery' elsewhere does not cancel a real emergency: %j", (text, hazard) => {
    expect(checkEmergencyRules(text)).toMatchObject({ emergency: true, hazard });
  });

  it("negation immediately before the hazard does suppress it", () => {
    expect(checkEmergencyRules("I can't smell gas any more, the engineer fixed it").emergency).toBe(false);
  });

  it("the model can never downgrade a rule emergency", () => {
    const rule = checkEmergencyRules("I can smell gas");
    for (const modelSays of ["low", "normal", "high"] as const) expect(resolveUrgency(modelSays, rule)).toBe("emergency");
  });

  it("the model may escalate when no rule fires", () => {
    expect(resolveUrgency("emergency", checkEmergencyRules("something odd"))).toBe("emergency");
  });

  it("emergency SLA escalates to on-call with P1", () => {
    expect(slaFor("repair", "emergency")).toMatchObject({ escalate_to_on_call: true, priority: "P1", attend_within_hours: 4 });
    expect(slaFor("rent", "normal").attend_within_hours).toBeNull();
  });

  it("safety notices are fixed templates", () => {
    expect(safetyNoticeFor("gas")).toContain("0800 111 999");
    expect(safetyNoticeFor("none")).toBeNull();
  });
});
