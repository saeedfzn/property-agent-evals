import type { PropertyRepository } from "../db.js";
import type { ModelProvider } from "../model/provider.js";
import { CLASSIFY_SYSTEM, draftContextPayload, draftSystemPrompt, type PromptVersion } from "../prompts.js";
import { checkEmergencyRules, needsWorkOrder, resolveUrgency, safetyNoticeFor, senderMayAccessUnit, slaFor } from "../rules.js";
import { AgentResult, ReplyDraft, Triage, type InboundMessage, type WorkOrderProposal } from "../schemas.js";
import { Tracer } from "../trace.js";
import { gatherContext } from "./context.js";
import { callStructured, DEFAULT_CALL } from "./structured.js";

export interface OrchestratorDeps {
  provider: ModelProvider;
  repo: PropertyRepository;
  promptVersion: PromptVersion;
  now: Date;
}

const HOLDING_REPLY =
  "Hello,\n\nThank you for your message. A member of our team will review it and get back to you shortly.\n\nKind regards,\nResident Services";

/**
 * Orchestrator. Delegates to three sub-agents (classify -> gather context -> draft reply)
 * and keeps everything safety- or money-relevant in code:
 *  - emergency rules run on the raw text and cannot be overridden by the model;
 *  - SLAs and safety wording come from code;
 *  - account data (rent, lease, booked jobs) is only returned by a tool, and only loaded for
 *    the reply, when the sender is the unit's resident or the property's landlord, whatever
 *    unit the model resolved;
 *  - a work order is only ever PROPOSED (pending human approval), never written;
 *  - a sub-agent that fails (invalid output twice, outage, refusal) degrades to needs_human
 *    with a holding reply. The emergency verdict and safety wording never depend on a model call.
 */
export async function triageMessage(deps: OrchestratorDeps, msg: InboundMessage): Promise<AgentResult> {
  const { provider, repo, promptVersion, now } = deps;
  const tracer = new Tracer(provider.model);
  const errors: string[] = [];
  let schemaFailures = 0;

  // 1. Deterministic safety rule, independent of any model output.
  const rule = await tracer.time("rule:emergency", "rule", () => checkEmergencyRules(msg.body), (r) => r.matched ?? "no match");

  // 2. Sub-agent: classify + extract (structured output, reject-and-retry once).
  const cls = await callStructured(provider, tracer, { ...DEFAULT_CALL, task: "classify" }, CLASSIFY_SYSTEM, JSON.stringify({ from: msg.from, body: msg.body }), Triage);
  schemaFailures += cls.schemaFailures;
  let triage: Triage;
  if (cls.value) triage = cls.value;
  else {
    errors.push(`classify failed: ${cls.lastError}`);
    triage = { category: "general", urgency: "normal", hazard: "none", summary: msg.body.slice(0, 160), mentioned_property: null, mentioned_unit: null };
  }

  const urgency = resolveUrgency(triage.urgency, rule);
  const hazard = rule.emergency ? rule.hazard : triage.hazard;
  const category = rule.emergency ? "repair" : triage.category;
  const sla = slaFor(category, urgency);

  // 3. Sub-agent: tool-calling context resolution (read-only, grounded ids only).
  //    Code identifies the sender first; the tools use that to refuse other households' data.
  const contact = await tracer.time("load:contact", "tool", () => repo.findContactByEmail(msg.from));
  const ctx = await gatherContext(provider, repo, tracer, msg, triage, contact);
  schemaFailures += ctx.schemaFailures;
  if (ctx.error) errors.push(ctx.error);
  const r = ctx.resolution;

  // 4. Code loads the canonical records for the resolved ids (the model chose WHICH records).
  const unit = r.unit_id ? await tracer.time("load:unit", "tool", () => repo.getUnit(r.unit_id!)) : null;

  // Access rule, in code, a second time: the model chose the unit (possibly from a flat number
  // typed into the message), so it is not trusted to decide whose rent, lease or bookings the
  // sender may see. The tools already refused; this guards what code itself loads for the reply.
  const entitled = unit !== null && senderMayAccessUnit(contact, unit);
  if (unit) tracer.record("rule:sender_access", "rule", entitled, 0, entitled ? undefined : `${contact?.id ?? "unknown sender"} is not linked to ${unit.unit_id}`);
  if (unit && !entitled) errors.push(`sender is not the resident or landlord for ${unit.unit_id}: account data withheld`);
  const lease = unit && entitled ? await tracer.time("load:lease", "tool", () => repo.getLease(unit.unit_id)) : null;
  const ledger = lease ? await tracer.time("load:ledger", "tool", () => repo.getRentLedger(lease.lease_id)) : [];
  const jobs = unit && entitled ? await tracer.time("load:jobs", "tool", () => repo.getOpenWorkOrders(unit.unit_id)) : [];
  const relatedJob = jobs.find((j) => j.job_ref === r.related_job_ref) ?? null;

  const today = now.toISOString().slice(0, 10);
  const past = ledger.filter((l) => l.due_date <= today);
  const last = past.at(-1) ?? null;
  const next = ledger.find((l) => l.due_date > today) ?? null;
  const facts = {
    sender_first_name: contact?.kind === "resident" ? contact.full_name.split(" ")[0]! : null,
    sender_kind: contact?.kind ?? "unknown",
    message: msg.body,
    category,
    urgency,
    sla: { respond_within_hours: sla.respond_within_hours, attend_within_hours: sla.attend_within_hours },
    unit_verified: entitled,
    unit_label: entitled ? unit!.unit_label : null,
    property_name: entitled ? unit!.property_name : null,
    mentioned_unit: triage.mentioned_unit,
    mentioned_property: triage.mentioned_property,
    related_job: relatedJob
      ? { job_ref: relatedJob.job_ref, status: relatedJob.status, scheduled_for: relatedJob.scheduled_for, contractor_name: relatedJob.contractor_name }
      : null,
    rent:
      category === "rent" && lease
        ? {
            last_due_date: last?.due_date ?? null,
            last_paid_in_full: last ? last.paid_pence >= last.amount_pence : true,
            arrears_pence: past.reduce((a, l) => a + Math.max(0, l.amount_pence - l.paid_pence), 0),
            next_due_date: next?.due_date ?? null,
            next_due_pence: next?.amount_pence ?? null,
          }
        : null,
    lease: category === "lease" && lease ? { end_date: lease.end_date } : null,
  };
  const records = { contact, unit: entitled ? unit : null, lease, ledger, open_jobs: jobs, triage };

  // 5. Sub-agent: draft the reply from the (version-dependent) context payload.
  const draftInput = JSON.stringify(draftContextPayload(promptVersion, { facts, records }, { facts }));
  const draft = await callStructured(provider, tracer, { ...DEFAULT_CALL, task: "draft_reply", effort: "medium" }, draftSystemPrompt(promptVersion), draftInput, ReplyDraft);
  schemaFailures += draft.schemaFailures;
  if (!draft.value) errors.push(`draft failed: ${draft.lastError}`);

  // 6. Code-owned safety wording goes first, verbatim.
  const notice = urgency === "emergency" ? safetyNoticeFor(hazard) : null;
  const replyBody = draft.value?.reply ?? HOLDING_REPLY;
  const reply = notice ? `${notice}\n\n${replyBody}` : replyBody;

  // 7. Work order: proposed only, and only for a verified unit with no existing job.
  //    An emergency is still proposed when the sender is not linked to the unit (a neighbour
  //    reporting a gas smell): it is only a proposal, and a human approves or rejects it.
  let proposal: WorkOrderProposal | null = null;
  if (needsWorkOrder(category) && unit && !relatedJob && (entitled || urgency === "emergency")) {
    proposal = {
      status: "pending_approval",
      requires_human_approval: true,
      unit_id: unit.unit_id,
      category: hazard === "none" ? "repair" : hazard,
      description: triage.summary,
      priority: sla.priority,
      attend_within_hours: sla.attend_within_hours ?? 480,
    };
  }

  const needsHuman = errors.length > 0 || (category === "repair" && !unit) || !cls.value || !draft.value;
  const result: AgentResult = {
    message_id: msg.id,
    prompt_version: promptVersion,
    provider: provider.name,
    model: provider.model,
    status: needsHuman ? "needs_human" : "ok",
    category,
    urgency,
    model_urgency: triage.urgency,
    hazard,
    rule_hazard: rule.hazard,
    property_id: unit?.property_id ?? r.property_id,
    unit_id: unit?.unit_id ?? null,
    related_job_ref: relatedJob?.job_ref ?? null,
    sla: { respond_within_hours: sla.respond_within_hours, attend_within_hours: sla.attend_within_hours, escalate_to_on_call: sla.escalate_to_on_call },
    reply,
    work_order_proposal: proposal,
    schema_failures: schemaFailures,
    grounding_rejections: ctx.groundingRejections,
    errors,
    trace: tracer.totals(),
  };
  // The orchestrator's own output is schema-checked too.
  return AgentResult.parse(result);
}
