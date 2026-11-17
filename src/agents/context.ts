import type { Contact, PropertyRepository } from "../db.js";
import type { ModelProvider, ModelResponse, TranscriptEntry } from "../model/provider.js";
import { CONTEXT_SYSTEM } from "../prompts.js";
import { ContextResolution, type InboundMessage, type Triage } from "../schemas.js";
import { executeTool, TOOL_SPECS } from "../tools.js";
import type { Tracer } from "../trace.js";
import { callModel, DEFAULT_CALL, errorText, validate } from "./structured.js";

export interface ContextOutcome {
  resolution: ContextResolution;
  /** Ids the model asserted that no tool ever returned. They are dropped, not trusted. */
  groundingRejections: string[];
  schemaFailures: number;
  toolCalls: number;
  error: string | null;
}

const EMPTY: ContextResolution = { contact_id: null, property_id: null, unit_id: null, lease_id: null, related_job_ref: null };

/** Collects every id-like value that appeared in any tool output. */
function collectIds(value: unknown, into: Set<string>, jobRefsByUnit: Map<string, Set<string>>): void {
  if (Array.isArray(value)) value.forEach((v) => collectIds(v, into, jobRefsByUnit));
  else if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    if (typeof o.job_ref === "string" && typeof o.unit_id === "string") {
      if (!jobRefsByUnit.has(o.unit_id)) jobRefsByUnit.set(o.unit_id, new Set());
      jobRefsByUnit.get(o.unit_id)!.add(o.job_ref);
    }
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === "string" && (k === "id" || k.endsWith("_id") || k === "job_ref")) into.add(v);
      else if (Array.isArray(v) && k.endsWith("_ids")) v.forEach((x) => typeof x === "string" && into.add(x));
      else collectIds(v, into, jobRefsByUnit);
    }
  }
}

/**
 * Sub-agent 2: a bounded tool-calling loop. The model decides which read-only tools to
 * call; arguments are zod-validated; the final answer is schema-validated and every id
 * in it must have come back from a tool (no invented records). `sender` is the contact that
 * code looked up from the message's From address: account tools are refused for any unit
 * that sender is not linked to, whatever arguments the model passes.
 */
export async function gatherContext(
  provider: ModelProvider,
  repo: PropertyRepository,
  tracer: Tracer,
  msg: InboundMessage,
  triage: Triage,
  sender: Contact | null,
  maxSteps = 6,
): Promise<ContextOutcome> {
  const transcript: TranscriptEntry[] = [
    {
      role: "user",
      text: JSON.stringify({
        from: msg.from,
        body: msg.body,
        triage: { category: triage.category, mentioned_property: triage.mentioned_property, mentioned_unit: triage.mentioned_unit },
      }),
    },
  ];
  const seenIds = new Set<string>();
  const jobRefsByUnit = new Map<string, Set<string>>();
  let schemaFailures = 0;
  let toolCalls = 0;
  const opts = { ...DEFAULT_CALL, task: "gather_context" as const };

  for (let step = 1; step <= maxSteps; step++) {
    let res: ModelResponse;
    try {
      res = await callModel(provider, tracer, opts, { system: CONTEXT_SYSTEM, transcript, tools: TOOL_SPECS }, `gather_context:step${step}`);
    } catch (err) {
      // Outage after retries: resolve nothing and let the orchestrator hand the message to a human.
      return { resolution: EMPTY, groundingRejections: [], schemaFailures, toolCalls, error: `context: model call failed: ${errorText(err)}` };
    }
    if (res.stopReason === "refusal") {
      return { resolution: EMPTY, groundingRejections: [], schemaFailures, toolCalls, error: "context: model refused" };
    }
    if (res.toolCalls.length > 0) {
      transcript.push({ role: "assistant", text: res.text, toolCalls: res.toolCalls, providerRaw: res.providerRaw });
      const results: { toolCallId: string; output: string; isError: boolean }[] = [];
      for (const call of res.toolCalls) {
        toolCalls++;
        const t0 = performance.now();
        const outcome = await executeTool(repo, call.name, call.input, { sender });
        // A refused or invalid call is a failed span, with the reason, not a silent success.
        tracer.record(`tool:${call.name}`, "tool", outcome.ok, Math.round((performance.now() - t0) * 100) / 100, outcome.ok ? undefined : outcome.error);
        if (outcome.ok) collectIds(outcome.output, seenIds, jobRefsByUnit);
        results.push({ toolCallId: call.id, output: outcome.ok ? JSON.stringify(outcome.output) : (outcome.error ?? "error"), isError: !outcome.ok });
      }
      transcript.push({ role: "tool_results", results });
      continue;
    }
    const v = validate(ContextResolution, res.text);
    tracer.record("gather_context:validate", "validation", v.ok, 0, v.ok ? undefined : v.error.slice(0, 200));
    if (!v.ok) {
      schemaFailures++;
      if (schemaFailures > 1) return { resolution: EMPTY, groundingRejections: [], schemaFailures, toolCalls, error: `context: ${v.error}` };
      transcript.push({ role: "assistant", text: res.text, toolCalls: [], providerRaw: res.providerRaw });
      transcript.push({ role: "user", text: `Your previous output was rejected: ${v.error}\nReturn ONLY the JSON object.` });
      continue;
    }
    // Grounding check: drop any id that no tool returned.
    const resolution = { ...v.value };
    const rejections: string[] = [];
    for (const key of ["contact_id", "property_id", "unit_id", "lease_id"] as const) {
      const id = resolution[key];
      if (id !== null && !seenIds.has(id)) {
        rejections.push(`${key}=${id}`);
        resolution[key] = null;
      }
    }
    const job = resolution.related_job_ref;
    if (job !== null && !(resolution.unit_id && jobRefsByUnit.get(resolution.unit_id)?.has(job))) {
      rejections.push(`related_job_ref=${job}`);
      resolution.related_job_ref = null;
    }
    if (rejections.length) tracer.record("gather_context:grounding", "validation", false, 0, rejections.join(", "));
    return { resolution, groundingRejections: rejections, schemaFailures, toolCalls, error: null };
  }
  return { resolution: EMPTY, groundingRejections: [], schemaFailures, toolCalls, error: `context: exceeded ${maxSteps} steps` };
}
