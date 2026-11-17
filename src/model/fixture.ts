import type { AgentTask, ModelProvider, ModelRequest, ModelResponse, ToolCall, TranscriptEntry } from "./provider.js";
import { TransientModelError } from "./provider.js";
import { formatDayDate, formatTime } from "../format.js";

/**
 * A deterministic, scripted stand-in for an LLM. No network, no key, no cost.
 *
 * It exists so the orchestration code, validation/retry paths, graders and CI gate can
 * be exercised identically on every run. It is NOT a claim about any live model's
 * accuracy: its behaviour is hand-written heuristics, documented here:
 *
 *  - classify: keyword heuristics with a deliberately smaller emergency vocabulary than
 *    the code rules (so the eval can show the code rule catching what "the model" missed).
 *  - gather_context: a scripted tool-calling loop that reads real tool results.
 *  - draft_reply: follows the prompt it is given. If the system prompt tells it to
 *    "always tell the resident when they can expect a visit" and does NOT contain the
 *    grounding rule, it invents an appointment date/time when none is in CONTEXT, and
 *    echoes unverified flat numbers. That reproduces a real, common LLM failure so the
 *    hallucination grader has something true to catch; v2 of the prompt removes it.
 *  - fault injection: specific call numbers return malformed JSON or a transient error,
 *    so the reject-and-retry and timeout/retry paths run in every eval.
 */
export interface FixtureOptions {
  model?: string;
  now?: Date;
  faults?: {
    invalidJsonOnCall?: Partial<Record<AgentTask, number[]>>;
    transientOnCall?: Partial<Record<AgentTask, number[]>>;
  };
}

const DEFAULT_FAULTS: Required<NonNullable<FixtureOptions["faults"]>> = {
  invalidJsonOnCall: { classify: [3, 17] },
  transientOnCall: { draft_reply: [8] },
};

export class FixtureProvider implements ModelProvider {
  readonly name = "fixture";
  readonly model: string;
  private readonly now: Date;
  private readonly faults: Required<NonNullable<FixtureOptions["faults"]>>;
  private readonly calls: Record<AgentTask, number> = { classify: 0, gather_context: 0, draft_reply: 0 };

  constructor(opts: FixtureOptions = {}) {
    this.model = opts.model ?? "claude-opus-5-5";
    this.now = opts.now ?? new Date("2026-11-17T09:00:00Z");
    this.faults = { ...DEFAULT_FAULTS, ...(opts.faults ?? {}) };
  }

  async generate(req: ModelRequest): Promise<ModelResponse> {
    const n = ++this.calls[req.task];
    if (this.faults.transientOnCall[req.task]?.includes(n)) {
      throw new TransientModelError(`fixture: simulated timeout on ${req.task} call #${n}`);
    }
    let text = "";
    let toolCalls: ToolCall[] = [];
    if (req.task === "classify") text = JSON.stringify(classify(firstUserText(req.transcript)));
    else if (req.task === "gather_context") ({ text, toolCalls } = gatherContextStep(req.transcript));
    else text = JSON.stringify({ reply: draftReply(req.system, firstUserText(req.transcript), this.now) });

    if (this.faults.invalidJsonOnCall[req.task]?.includes(n)) {
      // A realistic malformed output: chatty preamble + a truncated object.
      text = `Sure! Here is the JSON you asked for:\n${text.slice(0, Math.floor(text.length / 2))}`;
    }
    const inputTokens = estimateTokens(req.system + JSON.stringify(req.transcript) + JSON.stringify(req.tools ?? []));
    const outputTokens = estimateTokens(text + JSON.stringify(toolCalls));
    return {
      text,
      toolCalls,
      stopReason: toolCalls.length ? "tool_use" : "end_turn",
      usage: { inputTokens, outputTokens },
      latencyMs: Math.round(180 + 4 * outputTokens + 0.02 * inputTokens + (hash(text) % 50)),
      model: this.model,
    };
  }
}

export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function firstUserText(t: TranscriptEntry[]): string {
  const e = t.find((x) => x.role === "user");
  return e && e.role === "user" ? e.text : "";
}

// ---------------------------------------------------------------- classify

const NUMBER_WORDS: Record<string, string> = { one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10" };

function classify(input: string) {
  const { body } = JSON.parse(input) as { from: string; body: string };
  const t = body.toLowerCase();
  let hazard: string = "none";
  let urgency = "normal";
  let category = "general";

  // The scripted "model" knows the common phrasings only; the code rules know more.
  if (/smell gas|smell of gas|gas leak/.test(t)) hazard = "gas";
  else if (/carbon monoxide/.test(t) && /alarm/.test(t) && !/battery/.test(t)) hazard = "carbon_monoxide";
  else if (/sparked|sparking/.test(t)) hazard = "electrical";
  else if (/water (?:is )?coming through/.test(t)) hazard = "flood";
  if (hazard !== "none") {
    urgency = "emergency";
    category = "repair";
  } else if (/\bthanks?\b|thank you/.test(t) && !/not working|broken/.test(t)) {
    category = "general";
    urgency = "low";
  } else if (/\brent\b|\bowe\b|arrears|payment/.test(t)) {
    category = "rent";
  } else if (/tenancy|lease|renew|agreement/.test(t)) {
    category = "lease";
    urgency = "low";
  } else if (/neighbour|noise|loud|unhappy|nobody has replied|complain/.test(t)) {
    category = "complaint";
  } else if (/leak|drip|not working|isn't working|broken|cold|mould|lock|alarm|boiler|hot water|heating|window|tap|fan|socket|smell/.test(t)) {
    category = "repair";
  }
  if (urgency !== "emergency" && category === "repair") {
    if (/no hot water|no heating|won't lock|anyone can walk in|pooling/.test(t)) urgency = "high";
    if (/won't lock|anyone can walk in/.test(t)) hazard = "security";
  }

  const prop = /\b([A-Z][a-z]+ (?:Court|House|Mews|Lofts))\b/.exec(body);
  const unit = /\b(flat|unit|apartment)\s+(\d+[a-z]?|one|two|three|four|five|six|seven|eight|nine|ten)\b/i.exec(body);
  const unitLabel = unit ? `Flat ${NUMBER_WORDS[unit[2]!.toLowerCase()] ?? unit[2]!.toUpperCase()}` : null;
  const firstSentence = body.split(/(?<=[.!?])\s/)[0] ?? body;
  return {
    category,
    urgency,
    hazard,
    summary: firstSentence.slice(0, 160),
    mentioned_property: prop ? prop[1] : null,
    mentioned_unit: unitLabel,
  };
}

// ---------------------------------------------------------------- gather_context

const STOP = new Set(["still", "there", "about", "with", "this", "that", "have", "been", "from", "when", "what", "your", "they", "into", "coming", "anyone", "update", "someone", "working", "isn't", "weeks"]);
const words = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .replace(/[^a-z\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 4 && !STOP.has(w)),
  );

interface SeenResult {
  name: string;
  input: Record<string, unknown>;
  output: unknown;
}

function gatherContextStep(t: TranscriptEntry[]): { text: string; toolCalls: ToolCall[] } {
  const req = JSON.parse(firstUserText(t)) as {
    from: string;
    body: string;
    triage: { category: string; mentioned_property: string | null; mentioned_unit: string | null };
  };
  // Pair each tool call with its result.
  const calls = new Map<string, { name: string; input: Record<string, unknown> }>();
  const seen: SeenResult[] = [];
  for (const e of t) {
    if (e.role === "assistant") for (const c of e.toolCalls) calls.set(c.id, { name: c.name, input: c.input as Record<string, unknown> });
    if (e.role === "tool_results")
      for (const r of e.results) {
        const c = calls.get(r.toolCallId);
        if (c) seen.push({ ...c, output: r.isError ? null : JSON.parse(r.output) });
      }
  }
  const step = seen.length;
  const get = (name: string) => seen.find((s) => s.name === name);
  const call = (name: string, input: Record<string, unknown>): { text: string; toolCalls: ToolCall[] } => ({
    text: "",
    toolCalls: [{ id: `toolu_fx_${step}_${name}`, name, input }],
  });

  const contact = get("find_contact_by_email");
  if (!contact) return call("find_contact_by_email", { email: req.from });
  const c = contact.output as { id: string; unit_id: string | null; property_ids: string[] } | null;

  const { mentioned_property: mp, mentioned_unit: mu } = req.triage;
  if (mp && mu && !get("find_unit")) return call("find_unit", { property_name: mp, unit_label: mu });
  const fu = get("find_unit");
  const fuOut = fu?.output as { unit_id: string; property_id: string } | null | undefined;
  if (mp && fu && !fuOut && !get("find_property")) return call("find_property", { property_name: mp });
  if (mp && !mu && !c && !get("find_property")) return call("find_property", { property_name: mp });

  const unitId = fu ? (fuOut?.unit_id ?? null) : (c?.unit_id ?? null);
  const fp = get("find_property")?.output as { property_id: string } | null | undefined;

  let leaseId: string | null = null;
  let related: string | null = null;
  if (unitId) {
    const cat = req.triage.category;
    if (cat === "rent" || cat === "lease") {
      const lease = get("get_lease");
      if (!lease) return call("get_lease", { unit_id: unitId });
      leaseId = (lease.output as { lease_id: string } | null)?.lease_id ?? null;
      if (cat === "rent" && leaseId && !get("get_rent_ledger")) return call("get_rent_ledger", { lease_id: leaseId });
    } else if (cat === "repair" || cat === "complaint") {
      const jobs = get("get_open_work_orders");
      if (!jobs) return call("get_open_work_orders", { unit_id: unitId });
      const msg = words(req.body);
      for (const j of (jobs.output as { job_ref: string; description: string }[]) ?? []) {
        const overlap = [...words(j.description)].filter((w) => msg.has(w));
        if (overlap.length >= 1) {
          related = j.job_ref;
          break;
        }
      }
    }
  }
  const propertyId = fuOut?.property_id ?? fp?.property_id ?? (c && c.property_ids.length === 1 ? c.property_ids[0]! : null);
  return {
    text: JSON.stringify({ contact_id: c?.id ?? null, property_id: propertyId, unit_id: unitId, lease_id: leaseId, related_job_ref: related }),
    toolCalls: [],
  };
}

// ---------------------------------------------------------------- draft_reply

interface DraftFacts {
  sender_first_name: string | null;
  sender_kind: "resident" | "landlord" | "unknown";
  message: string;
  category: string;
  urgency: string;
  sla: { respond_within_hours: number; attend_within_hours: number | null };
  unit_verified: boolean;
  unit_label: string | null;
  property_name: string | null;
  mentioned_unit: string | null;
  mentioned_property: string | null;
  related_job: { job_ref: string; status: string; scheduled_for: string | null; contractor_name: string | null } | null;
  rent: { last_due_date: string | null; last_paid_in_full: boolean; arrears_pence: number; next_due_date: string | null; next_due_pence: number | null } | null;
  lease: { end_date: string } | null;
}

const pounds = (p: number) => `£${(p / 100).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const hoursText = (h: number) => (h <= 24 ? `${h} hours` : `${Math.round(h / 24)} days`);

function draftReply(system: string, input: string, now: Date): string {
  const f = (JSON.parse(input) as { facts: DraftFacts }).facts;
  const grounded = /Only mention dates, times, unit numbers and job references that appear in CONTEXT/.test(system);
  const promises = /Always tell the resident when they can expect/.test(system);
  const invent = promises && !grounded;
  const plusDays = (d: number) => formatDayDate(new Date(now.getTime() + d * 86_400_000).toISOString());
  const body = f.message.toLowerCase();
  const out: string[] = [f.sender_first_name ? `Hi ${f.sender_first_name},` : "Hello,"];

  if (f.urgency === "emergency") {
    out.push("Thank you for telling us straight away. We are treating this as an emergency and our on-call team has been alerted.");
    out.push(
      invent
        ? `An engineer will be with you by ${formatTime(new Date(now.getTime() + 2 * 3_600_000).toISOString())} today.`
        : `We aim to have someone with you within ${hoursText(f.sla.attend_within_hours ?? 4)} and will phone you as soon as an engineer is on the way.`,
    );
  } else if (f.category === "repair") {
    if (!f.unit_verified) {
      out.push(
        invent && f.mentioned_unit
          ? `We have logged the repair for ${f.mentioned_unit}${f.mentioned_property ? ` at ${f.mentioned_property}` : ""} and an engineer will visit on ${plusDays(2)}.`
          : "We could not match your address to our records. Could you confirm the property name and your flat number so we can raise this?",
      );
    } else if (f.related_job?.scheduled_for) {
      const j = f.related_job;
      out.push(
        `This is already logged as job ${j.job_ref}, and the visit is booked for ${formatDayDate(j.scheduled_for!)} at ${formatTime(j.scheduled_for!)}${j.contractor_name ? ` with ${j.contractor_name}` : ""}.`,
      );
    } else if (f.related_job) {
      out.push(
        invent
          ? `This is logged as job ${f.related_job.job_ref} and an engineer will visit on ${plusDays(3)}.`
          : `This is already logged as job ${f.related_job.job_ref}. A visit has not been booked yet; we will confirm the appointment as soon as it is.`,
      );
    } else {
      out.push(
        invent
          ? `We have booked an engineer to visit ${f.unit_label} on ${plusDays(2)} between 8am and 12pm.`
          : `We have passed this to our repairs team to arrange a contractor for ${f.unit_label}, ${f.property_name}. We aim to attend within ${hoursText(f.sla.attend_within_hours ?? 120)} and will confirm the appointment once it is booked.`,
      );
    }
  } else if (f.category === "rent") {
    const r = f.rent;
    if (r && f.sender_kind === "landlord") {
      out.push(
        r.last_paid_in_full
          ? `Rent for ${f.unit_label}, ${f.property_name} due on ${formatDayDate(r.last_due_date!)} has been received in full.`
          : `Rent for ${f.unit_label}, ${f.property_name} due on ${formatDayDate(r.last_due_date!)} has not been received yet.`,
      );
    } else if (r && r.arrears_pence > 0) {
      out.push(`Thank you for letting us know. Our records show ${pounds(r.arrears_pence)} outstanding for the payment due on ${formatDayDate(r.last_due_date!)}.`);
      out.push(
        invent
          ? `A member of our income team will call you on ${plusDays(1)} to agree a payment plan.`
          : `A member of our income team will contact you within ${hoursText(f.sla.respond_within_hours)} to agree a payment plan.`,
      );
    } else if (r && /owe|due|how much/.test(body)) {
      out.push(`Your current rent is paid. The next payment of ${pounds(r.next_due_pence ?? 0)} is due on ${formatDayDate(r.next_due_date!)}.`);
    } else {
      out.push(`I have passed your question to our lettings team, who will reply within ${hoursText(f.sla.respond_within_hours)}.`);
    }
  } else if (f.category === "lease") {
    if (f.lease && /end|renew/.test(body)) {
      out.push(`Your tenancy runs until ${formatDayDate(f.lease.end_date, true)}. If you would like to renew, reply to this email and we will send you the renewal terms.`);
    } else {
      out.push(`We will email a copy to this address within ${hoursText(f.sla.respond_within_hours)}.`);
    }
  } else if (f.category === "complaint") {
    out.push("I am sorry to hear this. I have logged it as a complaint and a housing officer will review it.");
    out.push(invent ? `They will call you on ${plusDays(1)}.` : `They will respond within ${hoursText(f.sla.respond_within_hours)}.`);
  } else {
    out.push(/thank/.test(body) ? "Thank you for taking the time to let us know, it is good to hear." : "Thank you for your message. A member of the team will reply shortly.");
  }
  out.push("Kind regards,\nResident Services");
  return out.join("\n\n");
}
