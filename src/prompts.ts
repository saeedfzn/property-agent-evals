/**
 * Versioned prompts. The eval harness runs each version over the same golden set
 * and compares the reports, so a prompt change is treated like a code change.
 */

export type PromptVersion = "v1" | "v2";
export const PROMPT_VERSIONS: PromptVersion[] = ["v1", "v2"];

export const CLASSIFY_SYSTEM = `You triage inbound messages for a residential property-management team.
Classify the message and extract fields. Return JSON only, matching the schema.
- category: repair | complaint | rent | lease | general
- urgency: emergency (risk to life or property now), high (essential service lost, security), normal, low
- hazard: gas | carbon_monoxide | electrical | flood | fire | security | none
- summary: one short sentence
- mentioned_property / mentioned_unit: exactly as written in the message, or null
Do not guess a property or unit the message does not mention.`;

export const CONTEXT_SYSTEM = `You resolve which records an inbound property-management message is about.
Use the tools to look up the sender, their unit, lease, rent ledger and open jobs.
Look up the sender by email first. If the message names a different property or unit, check it with find_unit.
Only call the tools you need. When you have enough, answer with JSON only:
{"contact_id", "property_id", "unit_id", "lease_id", "related_job_ref"} using ids exactly as the tools returned them, or null.
related_job_ref is an existing open job that is clearly about the same problem, else null. Never invent an id.`;

const DRAFT_V1 = `You write replies to residents on behalf of a property-management team.
Be warm, brief and helpful. Use the CONTEXT provided.
Always tell the resident when they can expect a visit or a call back, so they are not left waiting.
Return JSON only: {"reply": "..."}`;

const DRAFT_V2 = `You write replies to residents on behalf of a property-management team.
Be warm, brief and helpful.
GROUNDING RULES:
- Only mention dates, times, unit numbers and job references that appear in CONTEXT. Never invent an appointment.
- If no visit is booked, say the team will confirm the appointment once it is booked, and give the service level from SLA instead of a date.
- If the unit could not be matched to our records, ask the resident to confirm their address; do not repeat an unverified flat number.
- Do not include safety advice: approved safety wording is added separately by the system.
Return JSON only: {"reply": "..."}`;

export function draftSystemPrompt(version: PromptVersion): string {
  return version === "v1" ? DRAFT_V1 : DRAFT_V2;
}

/**
 * v1 passes every record it fetched to the drafter; v2 passes only the facts the
 * reply may use. Fewer input tokens, and less to hallucinate from.
 */
export function draftContextPayload(version: PromptVersion, full: Record<string, unknown>, trimmed: Record<string, unknown>): Record<string, unknown> {
  return version === "v1" ? full : trimmed;
}
